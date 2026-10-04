import { defineSettings } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type Config } from "./server/config.ts";
import { openDaemonClient } from "./server/daemon.ts";
import { afterTransientFailure, buildFailedTransientRecord, buildRecord, buildTransientRecord, failureSignature, lastUserMessage, continuationPrompt, isSameAgentAndSession, isTransientAssistantText, isUsageLimitAssistantText, messageId, shouldResume, transientRejectionState, turnText, verificationDecision, verifyTransientTimeline, type AgentSnapshot, type ResumeRecord, type ResumeState } from "./server/model.ts";
import { ResumeStore } from "./server/store.ts";

const log = (line: string) => console.log(`[usage-limit-auto-resume] ${line}`);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const SEND_ENABLED = true;

function snapshot(agent: AgentSnapshot): AgentSnapshot {
  return agent;
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }));
  const store = new ResumeStore();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let client: Awaited<ReturnType<typeof openDaemonClient>> | null = null;

  async function config(): Promise<Config | null> {
    const state = await settings.read();
    if (state.status !== "ready") {
      log(`config-invalid reason=${JSON.stringify(state.error)}`);
      return null;
    }
    return state.values;
  }

  async function acquire(): Promise<NonNullable<typeof client>> {
    if (client) return client;
    client = await openDaemonClient();
    return client;
  }

  async function release() {
    if (!client) return;
    const current = client;
    client = null;
    await current.close().catch(() => undefined);
  }

  async function fetchAgent(api: PaseoApi, agentId: string): Promise<AgentSnapshot | null> {
    const result = await api.agents.ref(agentId).refresh();
    return result?.agent ? snapshot(result.agent as AgentSnapshot) : null;
  }

  const isUsageLimitError = (message: string, code?: string) => failureSignature(message, code) !== null;

  async function processRecord(record: ResumeRecord, currentConfig: Config) {
    if (!currentConfig.armed || !SEND_ENABLED) {
      log(`would-resume agentId=${record.agentId} reason=${record.failureSignature} recordId=${record.recordId}`);
      return;
    }
    const api = await acquire();
    const agent = await fetchAgent(api, record.agentId);
    if (!agent) {
      await store.update(record.recordId, (value) => ({ ...value, state: record.kind === "transient" ? "uncertain" : "superseded", terminalReason: "agent-missing", updatedAt: new Date().toISOString() }));
      log(`send-skipped agentId=${record.agentId} recordId=${record.recordId} reason=agent-missing`);
      return;
    }
    const gate = shouldResume(record, agent, currentConfig);
    if (!gate.ok) {
      log(`send-skipped agentId=${record.agentId} recordId=${record.recordId} reason=${gate.reason}`);
      // An immediate retry can race the agent settling after its turn ends; keep the record and retry on the next sweep.
      const settling = gate.reason === "active-turn" || gate.reason === "agent-status=running";
      if (record.kind === "transient" && gate.reason !== "not-due" && !settling) {
        await store.update(record.recordId, (value) => ({ ...value, state: transientRejectionState(gate.reason), terminalReason: gate.reason, updatedAt: new Date().toISOString() }));
      } else if (["newer-user-message", "identity-changed", "opted-out", "archived", "requires-attention"].includes(gate.reason)) {
        await store.update(record.recordId, (value) => ({ ...value, state: gate.reason === "newer-user-message" ? "superseded" : "exhausted", terminalReason: gate.reason, updatedAt: new Date().toISOString() }));
      }
      return;
    }
    if (record.kind === "transient") {
      try {
        const page = await api.agents.ref(record.agentId).timeline.refetch({ direction: "before", limit: 200 });
        if (page.error || page.gap || page.staleCursor || page.hasNewer) throw new Error("timeline-incomplete");
        const timelineGate = verifyTransientTimeline(record, page.entries.map((entry) => entry.item));
        if (!timelineGate.ok) throw new Error(timelineGate.reason);
        const freshAgent = await fetchAgent(api, record.agentId);
        const freshGate = freshAgent ? shouldResume(record, freshAgent, currentConfig) : { ok: false as const, reason: "agent-missing" };
        if (!freshGate.ok) throw new Error(freshGate.reason);
      } catch (error) {
        const reason = errorMessage(error);
        await store.update(record.recordId, (value) => ({ ...value, state: transientRejectionState(reason), terminalReason: reason, updatedAt: new Date().toISOString() }));
        log(`retry-uncertain agentId=${record.agentId} recordId=${record.recordId} reason=${JSON.stringify(reason)}`);
        return;
      }
    }
    const stableMessageId = messageId(record);
    const prompt = record.kind === "transient" ? record.retryPrompt! : continuationPrompt(record);
    const sentAt = new Date().toISOString();
    const claimed = await store.update(record.recordId, (value) => ({
      ...value,
      state: "resuming",
      sentAt,
      verificationDeadlineAt: new Date(Date.now() + currentConfig.verificationTimeoutSeconds * 1000).toISOString(),
      attempts: [...value.attempts, { at: sentAt, messageId: stableMessageId, result: "unknown" }],
      updatedAt: sentAt,
    }));
    if (!claimed) return;
    try {
      await api.agents.ref(record.agentId).send(prompt, { messageId: stableMessageId });
      await store.update(record.recordId, (value) => ({
        ...value,
        state: "verifying",
        attempts: value.attempts.map((attempt) => attempt.messageId === stableMessageId ? { ...attempt, result: "sent" } : attempt),
        updatedAt: new Date().toISOString(),
      }));
      log(`${record.kind === "transient" ? "retry" : "resume"}-sent agentId=${record.agentId} messageId=${stableMessageId}`);
    } catch (error) {
      await store.update(record.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: `send:${errorMessage(error)}`, updatedAt: new Date().toISOString() }));
      log(`resume-uncertain agentId=${record.agentId} reason=${JSON.stringify(errorMessage(error))}`);
    }
  }

  async function reconcile(record: ResumeRecord, currentConfig: Config) {
    if (!currentConfig.armed || !SEND_ENABLED) return;
    if (!record.sentAt) {
      await store.update(record.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "send-receipt-missing", updatedAt: new Date().toISOString() }));
      return;
    }
    const api = await acquire();
    const agent = await fetchAgent(api, record.agentId);
    if (!agent) {
      await store.update(record.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "agent-missing-after-send", updatedAt: new Date().toISOString() }));
      return;
    }
    const decision = verificationDecision(record, agent);
    if (decision.state === "pending") return;
    if (decision.state === "done" && !record.resumeTurnId) {
      await store.update(record.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "resume-turn-not-observed", updatedAt: new Date().toISOString() }));
      return;
    }
    const terminalState: ResumeState = decision.state;
    await store.update(record.recordId, (value) => ({
      ...value,
      state: terminalState,
      terminalReason: decision.reason,
      updatedAt: new Date().toISOString(),
    }));
    log(`resume-${decision.state} agentId=${record.agentId} reason=${decision.reason}`);
  }

  async function sweep() {
    if (running) return;
    running = true;
    try {
      const currentConfig = await config();
      if (!currentConfig) return;
      for (const record of await store.read()) {
        if (record.state === "detected") {
          await store.update(record.recordId, (value) => ({ ...value, state: "parked", updatedAt: new Date().toISOString() }));
        }
        const latest = (await store.read()).find((value) => value.recordId === record.recordId);
        if (!latest) continue;
        if (latest.state === "resuming") {
          await store.update(latest.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "send-state-unreconciled", updatedAt: new Date().toISOString() }));
          continue;
        }
        if (latest.state === "verifying") {
          await reconcile(latest, currentConfig);
          continue;
        }
        if (latest.state === "parked") await processRecord(latest, currentConfig);
      }
    } catch (error) {
      log(`sweep-failed reason=${JSON.stringify(errorMessage(error))}`);
    } finally {
      running = false;
    }
  }

  const removeTurnStarted = server.on("agent.turn_started", (event) => {
    void (async () => {
      if (!event.turnId) return;
      const active = await store.activeForAgent(event.agent.id);
      if (!active || !["resuming", "verifying"].includes(active.state) || active.resumeTurnId) return;
      await store.update(active.recordId, (value) => ({ ...value, resumeTurnId: event.turnId, resumeStartedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      log(`resume-turn-started agentId=${event.agent.id} turnId=${event.turnId}`);
    })().catch((error) => log(`turn-started-handler-failed reason=${JSON.stringify(errorMessage(error))}`));
  });

  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    void (async () => {
      const currentConfig = await config();
      if (!currentConfig) return;
      const active = await store.activeForAgent(event.agent.id);
      if (active?.state === "verifying" && active.resumeTurnId === event.turnId) {
        if (active.kind === "transient") {
          const failedTransient = event.outcome.kind === "failed" && !isUsageLimitError(event.outcome.error.message, event.outcome.error.code);
          const { assistant, user } = event.outcome.kind === "failed"
            ? { assistant: `failed: ${event.outcome.error.message}`, user: lastUserMessage(event.timeline) }
            : turnText(event.timeline);
          const sentMessageId = active.attempts.at(-1)?.messageId;
          if (!user || (user.messageId ?? user.clientMessageId) !== sentMessageId || user.text !== active.retryPrompt || !assistant) {
            await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "retry-turn-ambiguous", updatedAt: new Date().toISOString() }));
            log(`retry-uncertain agentId=${event.agent.id} reason=retry-turn-ambiguous`);
            return;
          }
          if (failedTransient || (event.outcome.kind === "completed" && isTransientAssistantText(assistant))) {
            const agent = await fetchAgent(context.paseo, event.agent.id);
            if (!agent || !agent.lastUserMessageAt || !isSameAgentAndSession(active, agent)) {
              await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "retry-identity-ambiguous", updatedAt: new Date().toISOString() }));
              log(`retry-uncertain agentId=${event.agent.id} reason=retry-identity-ambiguous`);
              return;
            }
            const attempts = active.attempts.length;
            const exhausted = !active.failedOutcome && attempts >= (currentConfig.transientMaxAttempts ?? 3);
            await store.update(active.recordId, (value) => afterTransientFailure(value, assistant, user.text, sentMessageId!, agent.lastUserMessageAt!, currentConfig));
            log(`retry-${exhausted ? "exhausted" : "scheduled"} agentId=${event.agent.id} attempts=${attempts}`);
            return;
          }
          if ((event.outcome.kind === "completed" && isUsageLimitAssistantText(assistant)) || (event.outcome.kind === "failed" && !failedTransient)) {
            const agent = await fetchAgent(context.paseo, event.agent.id);
            const usage = agent && buildRecord(agent, assistant, undefined, currentConfig, Date.now(), event.turnId, event.outcome.kind === "failed");
            if (!usage || !isSameAgentAndSession(active, agent!)) {
              await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "usage-handoff-ambiguous", updatedAt: new Date().toISOString() }));
              log(`retry-uncertain agentId=${event.agent.id} reason=usage-handoff-ambiguous`);
              return;
            }
            await store.upsert(usage);
            await store.remove(active.recordId);
            log(`retry-to-usage agentId=${event.agent.id} recordId=${usage.recordId} notBefore=${usage.notBefore}`);
            await sweep();
            return;
          }
          if (event.outcome.kind === "completed") {
            await store.remove(active.recordId);
            log(`retry-succeeded agentId=${event.agent.id} turnId=${event.turnId}`);
          } else {
            await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: `retry-turn-${event.outcome.kind}`, updatedAt: new Date().toISOString() }));
            log(`retry-uncertain agentId=${event.agent.id} reason=retry-turn-${event.outcome.kind}`);
          }
          return;
        }
        if (event.outcome.kind === "completed") {
          await store.update(active.recordId, (value) => ({ ...value, state: "done", resumeFinishedAt: new Date().toISOString(), terminalReason: "resumed-turn-completed", updatedAt: new Date().toISOString() }));
          log(`resume-completed agentId=${event.agent.id} turnId=${event.turnId}`);
        } else {
          await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: `resumed-turn-${event.outcome.kind}`, updatedAt: new Date().toISOString() }));
        }
        return;
      }
      if (active?.state === "verifying" || active?.state === "resuming") {
        await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "provider-failed-after-send", updatedAt: new Date().toISOString() }));
        log(`resume-uncertain agentId=${event.agent.id} reason=provider-failed-after-send`);
        return;
      }
      if (event.outcome.kind !== "failed" && event.outcome.kind !== "completed") {
        log(`not-resumable agentId=${event.agent.id} outcome=${event.outcome.kind}`);
        return;
      }
      const agent = await fetchAgent(context.paseo, event.agent.id);
      if (!agent) return;
      const finalText = event.outcome.kind === "completed" ? turnText(event.timeline).assistant : null;
      const record = event.outcome.kind === "failed"
        ? buildRecord(agent, event.outcome.error.message, event.outcome.error.code, currentConfig, Date.now(), event.turnId, true)
          ?? buildFailedTransientRecord(agent, event.timeline, event.outcome.error, currentConfig, Date.now(), event.turnId)
        : finalText && isUsageLimitAssistantText(finalText)
          ? buildRecord(agent, finalText, undefined, currentConfig, Date.now(), event.turnId)
          : buildTransientRecord(agent, event.timeline, currentConfig, Date.now(), event.turnId);
      if (!record) {
        log(`not-resumable agentId=${event.agent.id} outcome=${event.outcome.kind} reason=${event.outcome.kind === "failed" ? JSON.stringify(event.outcome.error) : "unrecognized-final"}`);
        return;
      }
      if ((await store.read()).some((value) => value.agentId === record.agentId && value.sourceTurnId === record.sourceTurnId && value.persistenceSessionId === record.persistenceSessionId)) {
        log(`duplicate-turn agentId=${record.agentId} sourceTurnId=${record.sourceTurnId}`);
        return;
      }
      const existing = await store.activeForAgent(record.agentId);
      if (existing) {
        log(`duplicate-detected agentId=${record.agentId} recordId=${existing.recordId}`);
        return;
      }
      await store.upsert(record);
      log(`detected kind=${record.kind ?? "usage"} agentId=${record.agentId} recordId=${record.recordId} sourceTurnId=${record.sourceTurnId} notBefore=${record.notBefore}`);
      await sweep();
    })().catch((error) => log(`turn-handler-failed reason=${JSON.stringify(errorMessage(error))}`));
  });

  const removeArchived = server.on("agent.archived", (event) => {
    void (async () => {
      const records = await store.read();
      for (const record of records.filter((value) => value.agentId === event.agent.id && !["done", "superseded", "exhausted", "uncertain"].includes(value.state))) {
        await store.update(record.recordId, (value) => ({ ...value, state: "superseded", terminalReason: "agent-archived", updatedAt: new Date().toISOString() }));
        log(`record-superseded agentId=${event.agent.id} recordId=${record.recordId} reason=agent-archived`);
      }
    })().catch((error) => log(`archive-handler-failed reason=${JSON.stringify(errorMessage(error))}`));
  });

  const removePermission = server.on("agent.permission_requested", (event) => {
    void (async () => {
      const active = await store.activeForAgent(event.agent.id);
      if (active) {
        await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "permission-requested", updatedAt: new Date().toISOString() }));
        log(`record-uncertain agentId=${event.agent.id} recordId=${active.recordId} reason=permission-requested`);
      }
    })().catch((error) => log(`permission-handler-failed reason=${JSON.stringify(errorMessage(error))}`));
  });

  void config().then((currentConfig) => {
    if (!currentConfig) return;
    timer = setInterval(() => void sweep(), currentConfig.pollIntervalSeconds * 1000);
    timer.unref?.();
    void sweep();
  });

  return () => {
    removeTurnStarted();
    removeTurnEnded();
    removeArchived();
    removePermission();
    if (timer) clearInterval(timer);
    void release();
  };
}

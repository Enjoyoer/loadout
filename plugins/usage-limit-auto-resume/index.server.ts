import { defineSettings } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type Config } from "./server/config.ts";
import { openDaemonClient } from "./server/daemon.ts";
import { afterTransientFailure, applyClaimTurn, attemptCount, buildFailedTransientRecord, buildRecord, buildTransientRecord, cancelClaim, failureSignature, holdsClaim, isActive, isOwnLatestMessage, lastUserMessage, isSameAgentAndSession, isTransientAssistantText, isUsageLimitAssistantText, messageId, presendCancel, releaseClaim, resumePrompt, shouldResume, transientRejectionState, turnMark, turnText, verificationDecision, verifyTransientTimeline, type AgentSnapshot, type ClaimCancel, type ResumeRecord, type ResumeState, type InFlightClaim } from "./server/model.ts";
import { ResumeStore, StateUnreadableError } from "./server/store.ts";

const log = (line: string) => console.log(`[usage-limit-auto-resume] ${line}`);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
// Thrown before anything reaches the socket, so the message was never delivered.
const isTransportNotConnected = (error: unknown) => /^Transport not connected\b/.test(errorMessage(error));

export default function contribute(server: PluginServerContext, openClient = openDaemonClient) {
  const settings = server.registerSettings(defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }));
  const store = new ResumeStore();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  // Set by cleanup. From then on nothing schedules or starts a sweep: not the startup chain, an interval tick, or a
  // hook handler that is still finishing.
  let stopped = false;
  let client: Awaited<ReturnType<typeof openDaemonClient>> | null = null;
  let stateErrorLogged = false;
  // One entry per agent with a send in flight; see processRecord.
  const inFlight = new Map<string, InFlightClaim>();
  // The startup chain, sweeps and hook handlers still running, so idle() can wait for them after cleanup. None of
  // them rejects.
  const tasks = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>) => {
    tasks.add(task);
    const settle = () => { tasks.delete(task); };
    void task.then(settle, settle);
  };

  // An unreadable state file fails closed until the owner fixes or moves it; say so once, not on every poll or event.
  function failed(action: string, error: unknown) {
    if (!(error instanceof StateUnreadableError)) {
      log(`${action} reason=${JSON.stringify(errorMessage(error))}`);
      return;
    }
    if (stateErrorLogged) return;
    stateErrorLogged = true;
    console.error(`[usage-limit-auto-resume] state-unreadable reason=${JSON.stringify(errorMessage(error))} effect="no record is detected, resumed, or retried until the state file is fixed or moved aside"`);
  }

  async function config(): Promise<Config | null> {
    const state = await settings.read();
    if (state.status !== "ready") {
      log(`config-invalid reason=${JSON.stringify(state.error)}`);
      return null;
    }
    return state.values;
  }

  async function acquire(): Promise<NonNullable<typeof client>> {
    // The client never reconnects, so one lost transport (sleep, a stalled daemon) would fail every later sweep; open a fresh one instead.
    if (client?.getConnectionState().status === "connected") return client;
    await release();
    client = await openClient();
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
    return result?.agent ? result.agent as AgentSnapshot : null;
  }

  // The newest user row of a complete timeline page is the record's own latest message. An incomplete page proves
  // nothing.
  async function ownMessageIsLatest(api: PaseoApi, record: ResumeRecord): Promise<boolean> {
    const page = await api.agents.ref(record.agentId).timeline.refetch({ direction: "before", limit: 200 });
    if (page.error || page.gap || page.staleCursor || page.hasNewer) return false;
    return isOwnLatestMessage(record, lastUserMessage(page.entries.map((entry) => entry.item)));
  }

  const isUsageLimitError = (message: string, code?: string) => failureSignature(message, code) !== null;

  async function processRecord(record: ResumeRecord, currentConfig: Config) {
    if (!currentConfig.armed) {
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
    // The agent snapshot the last send check passed on; the claim is taken on its latest user message and turn.
    let gated = agent;
    if (record.kind === "transient") {
      try {
        const page = await api.agents.ref(record.agentId).timeline.refetch({ direction: "before", limit: 200 });
        if (page.error || page.gap || page.staleCursor || page.hasNewer) throw new Error("timeline-incomplete");
        const timelineGate = verifyTransientTimeline(record, page.entries.map((entry) => entry.item));
        if (!timelineGate.ok) throw new Error(timelineGate.reason);
        const freshAgent = await fetchAgent(api, record.agentId);
        const freshGate = freshAgent ? shouldResume(record, freshAgent, currentConfig) : { ok: false as const, reason: "agent-missing" };
        if (!freshGate.ok) throw new Error(freshGate.reason);
        gated = freshAgent!;
      } catch (error) {
        const reason = errorMessage(error);
        await store.update(record.recordId, (value) => ({ ...value, state: transientRejectionState(reason), terminalReason: reason, updatedAt: new Date().toISOString() }));
        log(`retry-uncertain agentId=${record.agentId} recordId=${record.recordId} reason=${JSON.stringify(reason)}`);
        return;
      }
    }
    const stableMessageId = messageId(record);
    const prompt = resumePrompt(record);
    const taken = turnMark(gated);
    const sentAt = new Date().toISOString();
    // Until send() is invoked the claim is unsent: the permission, archive and turn handlers set cancelled before any
    // await of their own, and no turn is attached to it. From then on the turn_started handler fills in the turn before
    // any await, so the outcome below sees a turn that started during the send even when the handler's store write
    // lands after it.
    let markSettled!: () => void;
    const claim: InFlightClaim = {
      recordId: record.recordId,
      attempt: { at: sentAt, messageId: stableMessageId, result: "unknown" },
      sentAt,
      verificationDeadlineAt: new Date(Date.now() + currentConfig.verificationTimeoutSeconds * 1000).toISOString(),
      released: false,
      cancelled: null,
      sendStarted: false,
      settled: new Promise<void>((resolve) => { markSettled = resolve; }),
      turnId: null,
      startedAt: null,
    };
    inFlight.set(record.agentId, claim);
    try {
      // Claim only the record the gates checked: still in that state, unwritten since, at the same attempt generation.
      // A decision another handler stored stands; one seen but not stored yet is stored here instead of the claim.
      const claimed = await store.update(record.recordId, (value) => {
        if (value.state !== record.state || value.updatedAt !== record.updatedAt || attemptCount(value) !== attemptCount(record)) return value;
        if (claim.cancelled) return { ...value, state: claim.cancelled.state, terminalReason: claim.cancelled.reason, updatedAt: new Date().toISOString() };
        return {
          ...value,
          state: "resuming",
          sentAt,
          verificationDeadlineAt: claim.verificationDeadlineAt,
          attempts: [...value.attempts, claim.attempt],
          updatedAt: sentAt,
        };
      });
      if (!claimed || !holdsClaim(claimed, claim)) {
        log(`send-skipped agentId=${record.agentId} recordId=${record.recordId} reason=${claim.cancelled?.reason ?? "record-changed"}`);
        return;
      }
      // Re-read the agent right before the send: an event seen while the claim was written, or one the daemon has
      // processed but not delivered yet, stops it. Nothing was sent, so the claim is undone either way.
      let fresh: AgentSnapshot | null = null;
      if (!claim.cancelled) {
        try {
          fresh = await fetchAgent(api, record.agentId);
        } catch (error) {
          await store.update(record.recordId, (value) => holdsClaim(value, claim) ? releaseClaim(value, record, claimed) : value);
          throw error;
        }
      }
      const cancelled = claim.cancelled ?? presendCancel(record, taken, fresh, currentConfig);
      if (cancelled) {
        await store.update(record.recordId, (value) => cancelClaim(value, record, claim, cancelled));
        log(`send-skipped agentId=${record.agentId} recordId=${record.recordId} reason=${cancelled.reason}`);
        return;
      }
      claim.sendStarted = true;
      try {
        await api.agents.ref(record.agentId).send(prompt, { messageId: stableMessageId });
        // Only the live claim moves on to verification. A permission request, an archive or a turn end stored while the
        // send was in flight keeps its state.
        await store.update(record.recordId, (value) => holdsClaim(value, claim) ? {
          ...value,
          state: "verifying",
          resumeTurnId: value.resumeTurnId ?? claim.turnId,
          resumeStartedAt: value.resumeStartedAt ?? claim.startedAt,
          attempts: value.attempts.map((attempt) => attempt.messageId === stableMessageId ? { ...attempt, result: "sent" } : attempt),
          updatedAt: new Date().toISOString(),
        } : value);
        log(`${record.kind === "transient" ? "retry" : "resume"}-sent agentId=${record.agentId} messageId=${stableMessageId}`);
      } catch (error) {
        if (isTransportNotConnected(error)) {
          // Undo the claim and stay parked; the next sweep opens a fresh client. A turn that started meanwhile turns it uncertain instead.
          let settled = await store.update(record.recordId, (value) => {
            const next = releaseClaim(value, record, claimed, claim);
            if (value.state === "resuming" && next.state === record.state) claim.released = true;
            return next;
          });
          // A turn that started while the rollback was being written was not visible to it; settle it before the claim ends.
          if (settled?.state === record.state && claim.turnId) settled = await store.update(record.recordId, (value) => applyClaimTurn(value, claim));
          if (settled?.state === "uncertain") log(`resume-uncertain agentId=${record.agentId} recordId=${record.recordId} reason=${settled.terminalReason}`);
          else log(`send-deferred agentId=${record.agentId} recordId=${record.recordId} reason=${JSON.stringify(errorMessage(error))}`);
          return;
        }
        await store.update(record.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: `send:${errorMessage(error)}`, updatedAt: new Date().toISOString() }));
        log(`resume-uncertain agentId=${record.agentId} reason=${JSON.stringify(errorMessage(error))}`);
      }
    } finally {
      if (inFlight.get(record.agentId) === claim) inFlight.delete(record.agentId);
      markSettled();
    }
  }

  async function reconcile(record: ResumeRecord, currentConfig: Config) {
    if (!currentConfig.armed) return;
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
    let current = record;
    // The send is itself a user message, so the agent's latest user time moves past the record's. Take that time only
    // when the newest user row is this attempt's own message; any other newer message still supersedes the record.
    const lastUserMessageAt = agent.lastUserMessageAt ?? null;
    if (lastUserMessageAt && lastUserMessageAt !== record.lastUserMessageAt && await ownMessageIsLatest(api, record)) {
      const correlated = await store.update(record.recordId, (value) => value.state === record.state && value.updatedAt === record.updatedAt
        ? { ...value, lastUserMessageAt, updatedAt: new Date().toISOString() }
        : value);
      // Changed meanwhile; the next sweep decides on the stored record.
      if (correlated?.lastUserMessageAt !== lastUserMessageAt) return;
      current = correlated;
    }
    const decision = verificationDecision(current, agent);
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
    if (running || stopped) return;
    running = true;
    try {
      const currentConfig = await config();
      if (!currentConfig) return;
      // One snapshot per sweep. A terminal record never acts again, so only an actionable one is read afresh: work on
      // an earlier record may have changed it.
      for (const record of await store.read()) {
        if (!isActive(record)) continue;
        if (record.state === "detected") {
          await store.update(record.recordId, (value) => value.state === "detected" ? { ...value, state: "parked", updatedAt: new Date().toISOString() } : value);
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
      failed("sweep-failed", error);
    } finally {
      running = false;
    }
  }

  const removeTurnStarted = server.on("agent.turn_started", (event) => {
    // Synchronous, before any await. A turn before the send is invoked is another turn: the send must not go out, and
    // the turn is never its attempt's.
    const pending = inFlight.get(event.agent.id);
    if (pending && !pending.sendStarted) {
      pending.cancelled ??= { state: "superseded", reason: "turn-started-before-send" };
      return;
    }
    const turnId = event.turnId;
    if (!turnId) return;
    // A send in flight for this agent keeps the turn even if its rollback commits ahead of the store write below.
    if (pending && !pending.turnId) {
      pending.turnId = turnId;
      pending.startedAt = new Date().toISOString();
    }
    const claim = pending?.turnId === turnId ? pending : null;
    track((async () => {
      if (claim) {
        // Claim-aware: attach the turn while the claim stands, or bring the claim back if its rollback already landed.
        const next = await store.update(claim.recordId, (value) => applyClaimTurn(value, claim));
        if (next?.resumeTurnId === turnId) log(`resume-turn-started agentId=${event.agent.id} turnId=${turnId}`);
        return;
      }
      // Without a claim of its own the turn joins only a delivered send; a resuming record is a claim in flight here.
      const active = await store.activeForAgent(event.agent.id);
      if (!active || active.state !== "verifying" || active.resumeTurnId) return;
      // Check again inside the update: a rolled-back claim must not pick up a turn identity.
      const next = await store.update(active.recordId, (value) => value.state === "verifying" && !value.resumeTurnId
        ? { ...value, resumeTurnId: turnId, resumeStartedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        : value);
      if (next?.resumeTurnId !== turnId) return;
      log(`resume-turn-started agentId=${event.agent.id} turnId=${turnId}`);
    })().catch((error) => failed("turn-started-handler-failed", error)));
  });

  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    // Synchronous, before any await: another turn ending before a send is invoked stops that send.
    const pending = inFlight.get(event.agent.id);
    const unsent = pending && !pending.sendStarted ? pending : null;
    if (unsent) unsent.cancelled ??= { state: "superseded", reason: "turn-ended-before-send" };
    track((async () => {
      // The cancelled claim stores its decision first, so this turn is handled as the agent's newest.
      if (unsent) await unsent.settled;
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
            // Re-park only the attempt this turn ended; a decision another handler stored meanwhile stands.
            const next = await store.update(active.recordId, (value) => value.state === "verifying" && value.resumeTurnId === event.turnId
              ? afterTransientFailure(value, assistant, user.text, sentMessageId!, agent.lastUserMessageAt!, currentConfig)
              : value);
            if (next?.state === "parked" || next?.state === "exhausted") log(`retry-${next.state === "exhausted" ? "exhausted" : "scheduled"} agentId=${event.agent.id} attempts=${attemptCount(next)}`);
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
      // A record for this turn, or the guard a pruned one left, means the event was handled already.
      if (await store.hasTurn(record)) {
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
    })().catch((error) => failed("turn-handler-failed", error)));
  });

  // Synchronous, before any await: a send claimed for this agent but not started yet must not go out. The handler's own
  // store write follows.
  const cancelInFlight = (agentId: string, cancel: ClaimCancel) => {
    const pending = inFlight.get(agentId);
    if (pending && !pending.cancelled) pending.cancelled = cancel;
  };

  const removeArchived = server.on("agent.archived", (event) => {
    cancelInFlight(event.agent.id, { state: "superseded", reason: "agent-archived" });
    track((async () => {
      const records = await store.read();
      for (const record of records.filter((value) => value.agentId === event.agent.id && !["done", "superseded", "exhausted", "uncertain"].includes(value.state))) {
        await store.update(record.recordId, (value) => ({ ...value, state: "superseded", terminalReason: "agent-archived", updatedAt: new Date().toISOString() }));
        log(`record-superseded agentId=${event.agent.id} recordId=${record.recordId} reason=agent-archived`);
      }
    })().catch((error) => failed("archive-handler-failed", error)));
  });

  const removePermission = server.on("agent.permission_requested", (event) => {
    cancelInFlight(event.agent.id, { state: "uncertain", reason: "permission-requested" });
    track((async () => {
      const active = await store.activeForAgent(event.agent.id);
      if (active) {
        await store.update(active.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "permission-requested", updatedAt: new Date().toISOString() }));
        log(`record-uncertain agentId=${event.agent.id} recordId=${active.recordId} reason=permission-requested`);
      }
    })().catch((error) => failed("permission-handler-failed", error)));
  });

  // Poll even when settings are invalid or unreadable at startup; every sweep reads them again. A cleanup that runs
  // before the first settings read resolves leaves no interval behind.
  track(config().catch(() => null).then((currentConfig) => {
    if (stopped) return;
    timer = setInterval(() => { if (!stopped) track(sweep()); }, (currentConfig ?? ConfigSchema.parse({})).pollIntervalSeconds * 1000);
    timer.unref?.();
    track(sweep());
  }));

  const cleanup = () => {
    stopped = true;
    removeTurnStarted();
    removeTurnEnded();
    removeArchived();
    removePermission();
    if (timer) clearInterval(timer);
    void release();
  };
  // Cleanup stops new sweeps and hooks but returns at once, as before. idle() resolves once the startup chain, sweep
  // and hook handlers already running have finished, and with them their state writes; tests call it before removing
  // PASEO_HOME.
  return Object.assign(cleanup, {
    async idle() {
      while (tasks.size > 0) await Promise.all(tasks);
    },
  });
}

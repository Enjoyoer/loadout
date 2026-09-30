import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AutoCompactConfig } from "./config.ts";
import { checkpointKey, guardDecision, providerDelayMinutes, strictnessTier } from "./model.ts";
import { StateStore, type StateEntry } from "./store.ts";
import { AgentTimers, realTimers, type TimerApi } from "./timer.ts";
import { MetricsLog } from "./metrics.ts";
import { MAX_RETRIES, nextRetryCount, RETRY_DELAY_MS } from "./retry.ts";

import { openDaemonClient } from "./daemon.ts";
import { recoverTurn, recoveryDelay, rearmSkipReason, recoveryHistory, recoveryCwdMissing } from "./recovery.ts";

const COMMAND = "/compact";

export type Checkpoint = {
  agentId: string;
  turnId: string | null;
  key: string;
  timeline: readonly AgentTimelineItem[];
  lastUserMessageAt: string | null;
  retryCount: number;
  endedAt: string;
};

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startScheduler(server: PluginServerContext, dependencies: {
  readConfig: () => Promise<AutoCompactConfig | null>;
  store?: StateStore;
  metrics?: Pick<MetricsLog, "append">;
  timerApi?: TimerApi;
  openApi?: () => Promise<PaseoClient>;
  now?: () => number;
  random?: () => number;
  log?: (action: string, data: Record<string, unknown>) => void;
}) {
  const store = dependencies.store ?? new StateStore();
  const metrics = dependencies.metrics ?? new MetricsLog();
  const timers = new AgentTimers(dependencies.timerApi ?? realTimers);
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const lifetime = new AbortController();
  let startupClient: PaseoClient | null = null;
  const readConfig = dependencies.readConfig;
  const inFlight = new Set<string>();
  const expectedUserMessage = new Map<string, string | null>();
  const recoveryFailures = new Map<string, Set<string>>();
  let lastRecoverySummary: string | null = null;
  let stopped = false;
  const agentSubscriptions = new Map<PaseoApi, () => void>();

  const log = dependencies.log ?? ((action: string, data: Record<string, unknown>) => {
    console.log(`[cache-aware-autocompact] ${JSON.stringify({ action, ...data })}`);
  });

  const stateKey = (checkpoint: Checkpoint, terminal = false): string => {
    if (terminal) return checkpoint.key;
    return `${checkpoint.key}:retry-${checkpoint.retryCount}`;
  };

  const record = async (
    checkpoint: Checkpoint,
    outcome: StateEntry["outcome"],
    reason: string,
    config: AutoCompactConfig,
    terminal = true,
  ) => {
    await store.append({
      key: stateKey(checkpoint, terminal),
      agentId: checkpoint.agentId,
      turnId: checkpoint.turnId,
      lastUserMessageAt: checkpoint.lastUserMessageAt,
      createdAt: new Date(now()).toISOString(),
      outcome,
      reason,
    }, config.maxStateEntries);
  };

  const scheduleRetry = (checkpoint: Checkpoint, api: PaseoApi, config: AutoCompactConfig, reason: string): boolean => {
    if (stopped) return false;
    const nextCount = nextRetryCount(reason, checkpoint.retryCount);
    if (nextCount === null) {
      log("retry-cap-reached", {
        agentId: checkpoint.agentId,
        key: checkpoint.key,
        retryCount: checkpoint.retryCount,
        reason,
      });
      return false;
    }
    const retry: Checkpoint = { ...checkpoint, retryCount: nextCount };
    timers.schedule(retry.key, retry.agentId, RETRY_DELAY_MS, () => {
      void evaluate(retry, api).catch((error) => log("evaluation-failed", { agentId: retry.agentId, reason: safeError(error) }));
    });
    log("retry-scheduled", {
      agentId: checkpoint.agentId,
      key: checkpoint.key,
      reason,
      retryCount: retry.retryCount,
      maxRetries: MAX_RETRIES,
      delayMinutes: RETRY_DELAY_MS / 60_000,
      configSoftThreshold: config.softThreshold,
    });
    return true;
  };

  const evaluate = async (checkpoint: Checkpoint, api: PaseoApi): Promise<void> => {
    if (stopped || inFlight.has(checkpoint.key)) return;
    inFlight.add(checkpoint.key);
    const generation = generations.get(checkpoint.agentId) ?? 0;
    try {
      const config = await readConfig();
      if (!config || stopped) return;
      if (await store.has(checkpoint.key) || await store.has(stateKey(checkpoint, false))) {
        log("skip", { agentId: checkpoint.agentId, reason: "deduplicated", key: checkpoint.key });
        return;
      }
      const handle = api.agents.ref(checkpoint.agentId);
      const refreshed = await handle.refresh();
      if (stopped || generation !== (generations.get(checkpoint.agentId) ?? 0)) return;
      const agent = refreshed?.agent;
      if (!agent) {
        await record(checkpoint, "skip", "agent-unavailable", config);
        log("skip", { agentId: checkpoint.agentId, reason: "agent-unavailable", strictnessTier: "safe" });
        return;
      }
      const tier = strictnessTier(agent.lastUsage?.contextWindowUsedTokens, config);
      const decision = guardDecision(agent, checkpoint.timeline, config, checkpoint.lastUserMessageAt);
      if (!decision.ok) {
        const retryable = nextRetryCount(decision.reason, checkpoint.retryCount) !== null;
        await record(checkpoint, "skip", decision.reason, config, !retryable);
        if (retryable || decision.reason === "running-tool" || decision.reason === "not-idle") scheduleRetry(checkpoint, api, config, decision.reason);
        log("skip", { agentId: checkpoint.agentId, reason: decision.reason, strictnessTier: tier, retryCount: checkpoint.retryCount });
        return;
      }
      if (!config.armed) {
        await record(checkpoint, "would-compact", decision.reason, config);
        log("would-compact", { agentId: checkpoint.agentId, reason: `${decision.reason}; disarmed`, command: COMMAND, strictnessTier: tier });
        return;
      }
      // The snapshot is refreshed immediately before the send. A busy agent is never messaged.
      if (agent.status !== "idle" || agent.activeTurn) {
        await record(checkpoint, "skip", "became-busy-before-send", config);
        log("skip", { agentId: checkpoint.agentId, reason: "became-busy-before-send", strictnessTier: tier });
        return;
      }
      try {
        // Reserve durably before sending, including a crash between send and acknowledgement.
        await record(checkpoint, "compact-requested", "send-reserved", config);
        if (stopped || generation !== (generations.get(checkpoint.agentId) ?? 0)) return;
        const beforeSend = (await handle.refresh())?.agent;
        if (stopped || generation !== (generations.get(checkpoint.agentId) ?? 0)) return;
        const sendDecision = beforeSend && guardDecision(beforeSend, checkpoint.timeline, config, checkpoint.lastUserMessageAt);
        if (!sendDecision || !sendDecision.ok) {
          const reason = sendDecision ? sendDecision.reason : "agent-unavailable";
          await record(checkpoint, "skip", reason, config);
          log("skip", { agentId: checkpoint.agentId, reason, strictnessTier: tier });
          return;
        }
        await handle.send(COMMAND);
        await record(checkpoint, "compacted", decision.reason, config);
        void metrics.append({ event: "compacted", agentId: checkpoint.agentId, provider: agent.provider, model: agent.model ?? null, usage: agent.lastUsage ?? null });
        log("compacted", { agentId: checkpoint.agentId, reason: decision.reason, command: COMMAND, strictnessTier: tier });
      } catch (error) {
        await record(checkpoint, "send-failed", safeError(error), config);
        log("send-failed", { agentId: checkpoint.agentId, reason: safeError(error), strictnessTier: tier });
      }
    } finally {
      inFlight.delete(checkpoint.key);
    }
  };

  const primeAndArm = async (event: { agent: { id: string; provider: string }; turnId: string | null; timeline: readonly AgentTimelineItem[] }, api: PaseoApi) => {
    const endedAt = new Date(now()).toISOString();
    const generation = generations.get(event.agent.id) ?? 0;
    if (event.agent.provider === "claude" || event.agent.provider === "codex") {
      const snapshot = await api.agents.ref(event.agent.id).refresh().catch(() => null);
      void metrics.append({
        event: "turn-ended",
        agentId: event.agent.id,
        provider: event.agent.provider,
        model: snapshot?.agent?.model ?? null,
        turnId: event.turnId,
        lastUserMessageAt: snapshot?.agent?.lastUserMessageAt ?? null,
        usage: snapshot?.agent?.lastUsage ?? null,
      });
    }
    const config = await readConfig();
    if (!config || stopped) return;
    const minutes = providerDelayMinutes(event.agent.provider, config);
    if (minutes === null) {
      log("skip", { agentId: event.agent.id, reason: `provider-${event.agent.provider}` });
      return;
    }
    const refreshed = await api.agents.ref(event.agent.id).refresh();
    if (!refreshed?.agent) {
      log("skip", { agentId: event.agent.id, reason: "agent-unavailable" });
      return;
    }
    const checkpoint: Checkpoint = {
      agentId: event.agent.id,
      turnId: event.turnId,
      key: checkpointKey(event.agent.id, event.turnId, event.timeline),
      timeline: event.timeline,
      lastUserMessageAt: refreshed.agent.lastUserMessageAt ?? null,
      retryCount: 0,
      endedAt,
    };
    if (stopped || generation !== (generations.get(event.agent.id) ?? 0)) return;
    await store.rememberTurn(checkpoint, config.maxStateEntries);
    if (stopped || generation !== (generations.get(event.agent.id) ?? 0)) return;
    expectedUserMessage.set(checkpoint.agentId, checkpoint.lastUserMessageAt);
    if (await store.has(checkpoint.key)) {
      log("skip", { agentId: event.agent.id, reason: "deduplicated", key: checkpoint.key });
      return;
    }
    if (stopped || generation !== (generations.get(event.agent.id) ?? 0)) return;
    // Delay is derived from the event provider so a later provider mutation cannot retarget it.
    timers.schedule(checkpoint.key, checkpoint.agentId, minutes * 60_000, () => {
      void evaluate(checkpoint, api).catch((error) => log("evaluation-failed", { agentId: checkpoint.agentId, reason: safeError(error) }));
    });
    log("timer-started", {
      agentId: event.agent.id,
      key: checkpoint.key,
      delayMinutes: minutes,
      strictnessTier: strictnessTier(refreshed.agent.lastUsage?.contextWindowUsedTokens, config),
    });
  };

  const generations = new Map<string, number>();
  const invalidate = (agentId: string) => generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
  let recoveryQueue = Promise.resolve();
  const recover = (api: PaseoApi, trigger: string) => {
    recoveryQueue = recoveryQueue.then(async () => {
      if (stopped) return;
      const config = await readConfig();
      if (!config || stopped) return;
      const skipped: Record<string, number> = {};
      let rearmed = 0;
      const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
      let cursor: string | undefined;
      do {
        const page = await api.agents.list({ page: { limit: 200, cursor }, signal: lifetime.signal });
        for (const { agent } of page.entries) {
          if (stopped) return;
          const reason = rearmSkipReason(agent);
          if (reason) { skip(reason); continue; }
          if (timers.has(agent.id) || inFlightHasAgent(agent.id)) { skip("already-pending"); continue; }
          expectedUserMessage.set(agent.id, agent.lastUserMessageAt ?? null);
          const generation = generations.get(agent.id) ?? 0;
          try {
            if (await recoveryCwdMissing(agent)) { skip("cwd-missing"); continue; }
            if (stopped) return;
            const handle = api.agents.ref(agent.id);
            const history = await recoveryHistory(handle.timeline);
            if (stopped) return;
            if (!history) { skip("timeline-unavailable"); continue; }
            const fresh = (await handle.refresh())?.agent;
            if (stopped) return;
            if (!fresh) { skip("agent-unavailable"); continue; }
            const freshReason = rearmSkipReason(fresh);
            if (freshReason) { skip(freshReason); continue; }
            const remembered = await store.latestTurn(agent.id);
            const recovered = recoverTurn(fresh, history, remembered);
            if (!recovered) { skip("no-ended-turn"); continue; }
            const entries = await store.read();
            if (entries.some((entry) => entry.agentId === agent.id && (entry.key === recovered.key ||
              (!entry.key.match(/:retry-\d+$/) && (Date.parse(entry.createdAt) >= Date.parse(recovered.endedAt) ||
                (!recovered.turnId && entry.lastUserMessageAt === recovered.lastUserMessageAt)))))) {
              skip("checkpointed"); continue;
            }
            const retries = entries.filter((entry) => entry.key.startsWith(`${recovered.key}:retry-`));
            const retryCount = retries.reduce((count, entry) => Math.max(count, Number(entry.key.split(":retry-").at(-1)) + 1), 0);
            if (retryCount > MAX_RETRIES) { skip("retry-cap-reached"); continue; }
            const checkpoint = { ...recovered, retryCount };
            if (stopped) return;
            if (generation !== (generations.get(agent.id) ?? 0)) { skip("changed-during-recovery"); continue; }
            await store.rememberTurn(checkpoint, config.maxStateEntries);
            if (stopped) return;
            if (generation !== (generations.get(agent.id) ?? 0) || timers.has(agent.id)) { skip("changed-during-recovery"); continue; }
            const delay = recoveryDelay(fresh.provider, checkpoint.endedAt, config, now(), random);
            expectedUserMessage.set(agent.id, checkpoint.lastUserMessageAt);
            timers.schedule(checkpoint.key, agent.id, delay.delayMs, () => {
              void evaluate(checkpoint, api).catch((error) => log("evaluation-failed", { agentId: agent.id, reason: safeError(error) }));
            });
            recoveryFailures.delete(agent.id);
            rearmed++;
            log("re-armed", { agentId: agent.id, provider: fresh.provider, idleSince: checkpoint.endedAt, ...delay });
          } catch (error) {
            skip("recovery-failed");
            const message = safeError(error);
            const failures = recoveryFailures.get(agent.id) ?? new Set<string>();
            if (!failures.has(message)) log("rearm-failed", { agentId: agent.id, reason: message });
            // A new turn can arrive while recovery is awaiting the failed call.
            if (generation === (generations.get(agent.id) ?? 0)) {
              failures.add(message);
              recoveryFailures.set(agent.id, failures);
            }
          }
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor && !stopped);
      const summary = JSON.stringify(Object.entries(skipped).filter(([reason]) => reason !== "already-pending")
        .sort(([a], [b]) => a.localeCompare(b)));
      if (rearmed > 0 || summary !== lastRecoverySummary) {
        log("rearm-summary", { trigger, rearmed, skipped, skippedCount: Object.values(skipped).reduce((a, b) => a + b, 0) });
        lastRecoverySummary = summary;
      }
    }).catch((error) => { if (!stopped) log("rearm-failed", { trigger, reason: safeError(error) }); });
  };
  const inFlightHasAgent = (agentId: string) => [...inFlight].some((key) => key.startsWith(`${agentId}:`));

  const ensureSubscription = (api: PaseoApi, trigger = "first-subscription") => {
    if (stopped || agentSubscriptions.has(api)) return;
    agentSubscriptions.set(api, api.agents.subscribe((update) => {
      if (update.kind !== "upsert") return;
      if (update.agent.status === "running" || update.agent.activeTurn ||
        (expectedUserMessage.has(update.agent.id) &&
          (update.agent.lastUserMessageAt ?? null) !== expectedUserMessage.get(update.agent.id))) recoveryFailures.delete(update.agent.id);
      if (update.agent.status !== "idle" || update.agent.activeTurn || update.agent.archivedAt ||
        (expectedUserMessage.has(update.agent.id) &&
          (update.agent.lastUserMessageAt ?? null) !== expectedUserMessage.get(update.agent.id))) invalidate(update.agent.id);
      const pendingKey = timers.key(update.agent.id);
      if (!pendingKey) return;
      if ((update.agent.lastUserMessageAt ?? null) !== (expectedUserMessage.get(update.agent.id) ?? null)) {
        timers.cancel(update.agent.id);
        log("timer-canceled", { agentId: update.agent.id, reason: "new-user-message" });
        return;
      }
      if (update.agent.status !== "idle" || update.agent.activeTurn || update.agent.archivedAt) {
        timers.cancel(update.agent.id);
        log("timer-canceled", { agentId: update.agent.id, reason: "new-turn-or-busy" });
      }
    }));
    recover(api, trigger);
    // agents.subscribe only attaches a local listener in 0.9.2. The owned list
    // subscription enables daemon updates and restores snapshots on reconnect.
    void api.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
      subscription.subscribe({
        snapshot: () => recover(api, "connection-snapshot"),
        update: () => {},
        error: (error) => { if (!stopped) log("subscription-failed", { reason: safeError(error) }); },
      });
    }).catch((error) => { if (!stopped) log("subscription-failed", { reason: safeError(error) }); });
  };

  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    ensureSubscription(context.paseo);
    invalidate(event.agent.id);
    recoveryFailures.delete(event.agent.id);
    timers.cancel(event.agent.id);
    log("turn-ended", { agentId: event.agent.id, turnId: event.turnId, outcome: event.outcome.kind });
    void primeAndArm(event, context.paseo).catch((error) => log("arm-failed", { agentId: event.agent.id, reason: safeError(error) }));
  });
  const removeTurnStarted = server.on("agent.turn_started", (event, context) => {
    ensureSubscription(context.paseo);
    invalidate(event.agent.id);
    recoveryFailures.delete(event.agent.id);
    expectedUserMessage.delete(event.agent.id);
    if (timers.cancel(event.agent.id)) log("timer-canceled", { agentId: event.agent.id, reason: "turn-started" });
  });
  const removePermissionRequested = server.on("agent.permission_requested", (event, context) => {
    ensureSubscription(context.paseo);
  });
  const removePermissionResolved = server.on("agent.permission_resolved", (_event, context) => {
    ensureSubscription(context.paseo);
  });
  const removeArchived = server.on("agent.archived", (event) => {
    timers.cancel(event.agent.id);
    invalidate(event.agent.id);
    expectedUserMessage.delete(event.agent.id);
  });

  // 0.9.2 has no SDK handle on PluginServerContext before the first hook.
  void (dependencies.openApi ?? openDaemonClient)().then(async (client) => {
    if (stopped) { await client.close(); return; }
    startupClient = client;
    ensureSubscription(client, "startup");
  }).catch((error) => { if (!stopped) log("startup-rearm-failed", { reason: safeError(error) }); });

  void readConfig().then((config) => {
    log("started", {
      mode: config?.armed === true ? "armed" : "dry-run",
      armed: config?.armed === true,
      note: "Set config.armed=true explicitly to permit sends",
    });
  });
  return () => {
    stopped = true;
    lifetime.abort();
    void startupClient?.close().catch(() => undefined);
    removeTurnEnded();
    removeTurnStarted();
    removePermissionRequested();
    removePermissionResolved();
    removeArchived();
    for (const remove of agentSubscriptions.values()) remove();
    agentSubscriptions.clear();
    timers.cancelAll();
    expectedUserMessage.clear();
    recoveryFailures.clear();
  };
}

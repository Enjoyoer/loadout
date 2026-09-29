import { defineSettings } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type AutoCompactConfig } from "./server/config.ts";
import { checkpointKey, guardDecision, providerDelayMinutes, strictnessTier } from "./server/model.ts";
import { StateStore, type StateEntry } from "./server/store.ts";
import { AgentTimers, realTimers } from "./server/timer.ts";
import { MetricsLog } from "./server/metrics.ts";
import { MAX_RETRIES, nextRetryCount, RETRY_DELAY_MS } from "./server/retry.ts";

const COMMAND = "/compact";

type Checkpoint = {
  agentId: string;
  turnId: string | null;
  key: string;
  timeline: readonly AgentTimelineItem[];
  lastUserMessageAt: string | null;
  retryCount: number;
};

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(
    defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }),
  );
  const store = new StateStore();
  const metrics = new MetricsLog();
  const timers = new AgentTimers(realTimers);
  const inFlight = new Set<string>();
  const expectedUserMessage = new Map<string, string | null>();
  let stopped = false;
  let removeAgentSubscription: (() => void) | null = null;

  const log = (action: string, data: Record<string, unknown>) => {
    console.log(`[cache-aware-autocompact] ${JSON.stringify({ action, ...data })}`);
  };

  const readConfig = async (): Promise<AutoCompactConfig | null> => {
    try {
      const state = await settings.read();
      if (state.status === "ready") return state.values;
      log("config-invalid", { reason: state.error });
    } catch (error) {
      log("config-unreadable", { reason: safeError(error) });
    }
    return null;
  };

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
      createdAt: new Date().toISOString(),
      outcome,
      reason,
    }, config.maxStateEntries);
  };

  const scheduleRetry = (checkpoint: Checkpoint, api: PaseoApi, config: AutoCompactConfig, reason: string): boolean => {
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
    try {
      const config = await readConfig();
      if (!config) return;
      if (await store.has(checkpoint.key) || await store.has(stateKey(checkpoint, false))) {
        log("skip", { agentId: checkpoint.agentId, reason: "deduplicated", key: checkpoint.key });
        return;
      }
      const handle = api.agents.ref(checkpoint.agentId);
      const refreshed = await handle.refresh();
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
    };
    expectedUserMessage.set(checkpoint.agentId, checkpoint.lastUserMessageAt);
    if (await store.has(checkpoint.key)) {
      log("skip", { agentId: event.agent.id, reason: "deduplicated", key: checkpoint.key });
      return;
    }
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

  const ensureSubscription = (api: PaseoApi) => {
    if (removeAgentSubscription) return;
    removeAgentSubscription = api.agents.subscribe((update) => {
      if (update.kind !== "upsert") return;
      const pendingKey = timers.key(update.agent.id);
      if (!pendingKey) return;
      if ((update.agent.lastUserMessageAt ?? null) !== (expectedUserMessage.get(update.agent.id) ?? null)) {
        timers.cancel(update.agent.id);
        log("timer-canceled", { agentId: update.agent.id, reason: "new-user-message" });
        return;
      }
      if (update.agent.status !== "idle" || update.agent.activeTurn) {
        timers.cancel(update.agent.id);
        log("timer-canceled", { agentId: update.agent.id, reason: "new-turn-or-busy" });
      }
    });
  };

  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    ensureSubscription(context.paseo);
    timers.cancel(event.agent.id);
    log("turn-ended", { agentId: event.agent.id, turnId: event.turnId, outcome: event.outcome.kind });
    void primeAndArm(event, context.paseo).catch((error) => log("arm-failed", { agentId: event.agent.id, reason: safeError(error) }));
  });
  const removeTurnStarted = server.on("agent.turn_started", (event, context) => {
    ensureSubscription(context.paseo);
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
    expectedUserMessage.delete(event.agent.id);
  });

  void readConfig().then((config) => {
    log("started", {
      mode: config?.armed === true ? "armed" : "dry-run",
      armed: config?.armed === true,
      note: "Set config.armed=true explicitly to permit sends",
    });
  });
  return () => {
    stopped = true;
    removeTurnEnded();
    removeTurnStarted();
    removePermissionRequested();
    removePermissionResolved();
    removeArchived();
    removeAgentSubscription?.();
    removeAgentSubscription = null;
    timers.cancelAll();
    expectedUserMessage.clear();
  };
}

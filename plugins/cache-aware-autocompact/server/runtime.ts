import type { PaseoAgentHandle, PaseoApi, PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AutoCompactConfig } from "./config.ts";
import { cacheExpired, cacheExpiredSkip, checkpointKey, checkpointTimeline, disabledReason, guardDecision, providerDelayMinutes, strictnessTier, withFreshToolState } from "./model.ts";
import { StateStore, type StateEntry, type WriteJson } from "./store.ts";
import { AgentTimers, realTimers, type TimerApi } from "./timer.ts";
import { MetricsLog } from "./metrics.ts";
import { MAX_RETRIES, nextRetryCount, RETRY_DELAY_MS } from "./retry.ts";

import { openDaemonClient } from "./daemon.ts";
import { recoverTurn, recoveryDelay, rearmSkipReason, recoveryHistory, recoveryCwdMissing } from "./recovery.ts";

import { compactionResult } from "./compaction.ts";
import { endedReads, killAgent } from "./vendor/ended-read.ts";
import { lastInput, turnInput } from "./vendor/turn-input.ts";

const COMMAND = "/compact";

export type Checkpoint = {
  agentId: string;
  turnId: string | null;
  key: string;
  /** Only the items checkpointTimeline keeps, never the whole timeline. */
  timeline: readonly AgentTimelineItem[];
  lastUserMessageAt: string | null;
  /**
   * The message ID of the turn's input when it is a Paseo 0.13 agent message, which does not move lastUserMessageAt.
   * Restart recovery tells such turns apart by it (recover). Absent for a human prompt and on Paseo 0.11.
   */
  inputId?: string;
  retryCount: number;
  endedAt: string;
};

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Open and loaded. A fetch never loads an agent: a loaded agent's snapshot carries activeTurn (null when idle), the stored
// snapshot of an unloaded one has none.
function loadedAndOpen(agent: { status: string; archivedAt?: string | null; activeTurn?: unknown } | null | undefined) {
  return !!agent && agent.status !== "closed" && !agent.archivedAt && agent.activeTurn !== undefined;
}

/** A watched read's fetch and archive, on the handle the read uses. */
const agentPort = (handle: PaseoAgentHandle) => ({
  fetch: async () => (await handle.refresh())?.agent ?? null,
  archive: () => handle.archive(),
});

/** Thrown by a watched compaction read whose agent ended; the read already put the agent back and logged it. */
class ReadEnded extends Error {}

export function startScheduler(server: PluginServerContext, dependencies: {
  readConfig: () => Promise<AutoCompactConfig | null>;
  store?: StateStore;
  /** Writes state for the store this scheduler creates when none is passed in. */
  writeJson?: WriteJson;
  metrics?: Pick<MetricsLog, "append">;
  timerApi?: TimerApi;
  openApi?: () => Promise<PaseoClient>;
  /** Closes an agent the way a user's kill does; the daemon's kill_agent unless a test passes one. */
  killAgent?: (agentId: string) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (action: string, data: Record<string, unknown>) => void;
}) {
  const store = dependencies.store ?? new StateStore(undefined, dependencies.writeJson);
  const metrics = dependencies.metrics ?? new MetricsLog();
  const timers = new AgentTimers(dependencies.timerApi ?? realTimers);
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const lifetime = new AbortController();
  let startupClient: PaseoClient | null = null;
  // The synchronous agent-update listener uses the last loaded flag; null keeps the previous behavior.
  let extended: boolean | null = null;
  const readConfig = async () => {
    const config = await dependencies.readConfig();
    if (config) extended = config.extendIdleCompaction;
    return config;
  };
  // A failed turn leaves the agent in `error`, which is settled, not busy, when the extension is on.
  const busyStatus = (status: string) => status !== "idle" && !(extended === true && status === "error");
  const inFlight = new Set<string>();
  const expectedUserMessage = new Map<string, string | null>();
  const recoveryFailures = new Map<string, Set<string>>();
  let lastRecoverySummary: string | null = null;
  let stopped = false;
  let subscribedApi: PaseoApi | null = null;
  let removeAgentSubscription: (() => void) | null = null;

  const log = dependencies.log ?? ((action: string, data: Record<string, unknown>) => {
    console.log(`[cache-aware-autocompact] ${JSON.stringify({ action, ...data })}`);
  });
  // Every timeline read loads an unloaded agent, so each one is watched: a close or archive seen while it is in flight,
  // or a fetch after it showing the agent closed, archived or gone, ends the read. The agent it loaded again is put back
  // as the user left it, and the read's work is dropped: nothing is checkpointed, armed or sent for it. This plugin never
  // means to load a closed agent, so a read issued on a closed snapshot raced a close too.
  const ends = endedReads({
    kill: dependencies.killAgent ?? ((agentId: string) => killAgent(agentId)),
    log: (agentId, read, ended) => log("read-raced-end", { agentId, read, end: ended.end, restored: ended.restored, ...(ended.reason ? { reason: ended.reason } : {}) }),
    readsClosed: false,
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
    attemptedAt?: string,
  ) => {
    // After a reload the old instance must not race the new instance's writes to the same state file.
    if (stopped) return;
    await store.append({
      key: stateKey(checkpoint, terminal),
      agentId: checkpoint.agentId,
      turnId: checkpoint.turnId,
      lastUserMessageAt: checkpoint.lastUserMessageAt,
      ...(checkpoint.inputId ? { inputId: checkpoint.inputId } : {}),
      createdAt: new Date(now()).toISOString(),
      ...(attemptedAt ? { attemptedAt } : {}),
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
      if (cacheExpiredSkip(agent.provider, agent.model, checkpoint.endedAt, now(), config)) {
        await record(checkpoint, "skip", "cache-expired", config);
        log("skip", { agentId: checkpoint.agentId, reason: "cache-expired", retryCount: checkpoint.retryCount });
        return;
      }
      const read = await ends.read(agent.id, "evaluate", agentPort(handle), agent,
        () => handle.timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" })).catch(async error => {
        await record(checkpoint, "compaction-failed", safeError(error), config);
        log("compaction-failed", { agentId: agent.id, reason: safeError(error) });
        return null;
      });
      // The agent ended while its tail was read (put back and logged by ends), or a turn started or ended meanwhile.
      if (!read || read.ended || stopped || generation !== (generations.get(checkpoint.agentId) ?? 0)) return;
      const baseline = read.value;
      if (baseline.error || baseline.gap || baseline.staleCursor) {
        await record(checkpoint, "skip", "timeline-unavailable", config);
        log("skip", { agentId: agent.id, reason: "timeline-unavailable" });
        return;
      }
      const attempts = (await store.read()).filter(entry => entry.agentId === agent.id &&
        ["compact-requested", "compaction-failed", "compaction-unconfirmed", "send-failed"].includes(entry.outcome));
      const lastAttempt = attempts.at(-1);
      // The latest turn input: a user message, or a Paseo 0.13 agent message (turnInput). Either is new work.
      const latestUser = baseline.entries.findLast(entry => turnInput(entry.item) !== null);
      const latestInput = latestUser ? turnInput(latestUser.item) : null;
      const realUserAfterAttempt = lastAttempt && latestInput &&
        latestInput.text.trim() !== COMMAND && Date.parse(latestUser!.timestamp) > Date.parse(lastAttempt.attemptedAt ?? lastAttempt.createdAt);
      // Snapshot timestamps alone cannot distinguish a real turn from /compact.
      // Missing user history stays backed off rather than guessing that a turn is real.
      if (lastAttempt && !realUserAfterAttempt) {
        log("skip", { agentId: agent.id, reason: "compaction-backoff" });
        return;
      }
      const tier = strictnessTier(agent.lastUsage?.contextWindowUsedTokens, config);
      // A retry re-reads the turn's tools: one recorded as running may have settled since.
      const timeline = withFreshToolState(checkpoint.timeline, baseline.entries.map((entry) => entry.item));
      const decision = guardDecision(agent, timeline, config, checkpoint.lastUserMessageAt);
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
      const attemptedAt = new Date(now()).toISOString();
      let unwatch = () => {};
      try {
        // Reserve durably before sending, including a crash between send and acknowledgement.
        await record(checkpoint, "compact-requested", "send-reserved", config, true, attemptedAt);
        if (stopped || generation !== (generations.get(checkpoint.agentId) ?? 0)) return;
        const beforeSend = (await handle.refresh())?.agent;
        if (stopped || generation !== (generations.get(checkpoint.agentId) ?? 0)) return;
        const sendDecision = beforeSend && (cacheExpiredSkip(beforeSend.provider, beforeSend.model, checkpoint.endedAt, now(), config)
          ? { ok: false, reason: "cache-expired" }
          : guardDecision(beforeSend, timeline, config, checkpoint.lastUserMessageAt));
        if (!sendDecision || !sendDecision.ok) {
          const reason = sendDecision ? sendDecision.reason : "agent-unavailable";
          await record(checkpoint, "skip", reason, config);
          log("skip", { agentId: checkpoint.agentId, reason, strictnessTier: tier });
          return;
        }
        const afterSeq = baseline.entries.at(-1)?.seqEnd ?? -1;
        if (stopped || generation !== (generations.get(checkpoint.agentId) ?? 0)) return;
        // One window covers the settled-turn wait and the compaction row, both measured from the send.
        const windowMs = config.compactionWindowMinutes * 60_000;
        const sentAt = Date.now();
        // From the send on, a stop or archive is watched, and each look at the timeline is decided like the read above.
        const watching = ends.watch(checkpoint.agentId, "compaction", agentPort(handle));
        unwatch = watching.done;
        await handle.send(COMMAND);
        const finished = await handle.waitForFinish(windowMs);
        if (finished.status !== "idle") {
          log("wait-for-finish", { agentId: checkpoint.agentId, status: finished.status, error: finished.error, strictnessTier: tier });
        }
        // Each look is decided on the snapshot taken once the /compact turn settled, so a newer user message since then
        // shows the owner opened the agent again, as on every other read.
        const settled = finished.final;
        const watched = { refetch: async (options: Parameters<typeof handle.timeline.refetch>[0]) => {
          const read = await watching.run(settled, () => handle.timeline.refetch(options));
          if (read.ended) throw new ReadEnded();
          return read.value;
        } };
        const observed = await compactionResult(watched, afterSeq, lifetime.signal, Math.max(0, windowMs - (Date.now() - sentAt)));
        if (observed === "unconfirmed") {
          // No completed row and no error by the end of the window. Backed off like a failure, but not reported as one.
          const reason = `no completed compaction row within ${config.compactionWindowMinutes}m and no error`;
          await record(checkpoint, "compaction-unconfirmed", reason, config, true, attemptedAt);
          log("compaction-unconfirmed", { agentId: checkpoint.agentId, reason, strictnessTier: tier });
          return;
        }
        await record(checkpoint, "compacted", decision.reason, config, true, attemptedAt);
        void metrics.append({ event: "compacted", agentId: checkpoint.agentId, provider: agent.provider, model: agent.model ?? null, usage: agent.lastUsage ?? null });
        log("compacted", { agentId: checkpoint.agentId, reason: decision.reason, command: COMMAND, strictnessTier: tier });
      } catch (error) {
        // The agent ended while the compaction was observed: it is put back, and nothing more is written for it.
        if (error instanceof ReadEnded) return;
        if (stopped) {
          log("compaction-abandoned", { agentId: checkpoint.agentId, reason: `plugin stopped: ${safeError(error)}`, strictnessTier: tier });
          return;
        }
        await record(checkpoint, "compaction-failed", safeError(error), config, true, attemptedAt);
        log("compaction-failed", { agentId: checkpoint.agentId, reason: safeError(error), strictnessTier: tier });
      } finally {
        unwatch();
      }
    } finally {
      inFlight.delete(checkpoint.key);
      const deferred = deferredTurns.get(checkpoint.agentId);
      deferredTurns.delete(checkpoint.agentId);
      if (deferred && !stopped) void primeAndArm(deferred.event, deferred.api).catch(error =>
        log("arm-failed", { agentId: checkpoint.agentId, reason: safeError(error) }));
    }
  };

  const primeAndArm = async (event: { agent: { id: string; provider: string; model?: string | null }; turnId: string | null; timeline: readonly AgentTimelineItem[] }, api: PaseoApi) => {
    // Automatic compact turns must not create a fresh timer, including failed turns. The turn's own input decides: a later
    // Paseo 0.13 agent message is a turn input too (turnInput), so the /compact row before it is an earlier turn's.
    const latestUser = lastInput(event.timeline);
    if (latestUser && latestUser.text.trim() === COMMAND) return;
    if (inFlightHasAgent(event.agent.id)) {
      deferredTurns.set(event.agent.id, { event, api });
      return;
    }
    const endedAt = new Date(now()).toISOString();
    const generation = generations.get(event.agent.id) ?? 0;
    if (["claude", "codex", "pi"].includes(event.agent.provider)) {
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
    const refreshed = await api.agents.ref(event.agent.id).refresh();
    if (!refreshed?.agent) {
      log("skip", { agentId: event.agent.id, reason: "agent-unavailable" });
      return;
    }
    const minutes = providerDelayMinutes(refreshed.agent.provider, config, refreshed.agent.model);
    if (minutes === null) {
      log("skip", { agentId: event.agent.id, reason: disabledReason(refreshed.agent.provider, config, refreshed.agent.model) ?? (refreshed.agent.provider === "pi" ? "unsupported-pi-model" : `provider-${refreshed.agent.provider}`) });
      return;
    }
    const checkpoint: Checkpoint = {
      agentId: event.agent.id,
      turnId: event.turnId,
      key: checkpointKey(event.agent.id, event.turnId, event.timeline),
      timeline: event.timeline,
      lastUserMessageAt: refreshed.agent.lastUserMessageAt ?? null,
      ...(latestUser?.source && latestUser.messageId ? { inputId: latestUser.messageId } : {}),
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
    // Use the current snapshot model, not a remembered picker label or service tier.
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

  // The checkpoint items of the agent's last 200 timeline rows, read once and never kept whole. The read loads an
  // unloaded agent again, so it is issued only right after a fetch (which never loads one) shows the agent loaded and
  // open, and only while `current` holds: the turn's generation is unchanged, so no close, archive or new turn was seen
  // during that fetch. A fetch answered before a close it was in flight with still shows the agent open; the close
  // changed the generation, so the read is skipped. The read itself still loads an agent closed or archived while it
  // is in flight, so such an agent is put back (ends), and the turn is dropped: null, so nothing is checkpointed, armed
  // or sent for it.
  const endedTimeline = async (api: PaseoApi, agentId: string, current: () => boolean): Promise<AgentTimelineItem[] | null> => {
    const handle = api.agents.ref(agentId);
    const snapshot = current() ? await handle.refresh().catch(() => null) : null;
    if (!current() || !loadedAndOpen(snapshot?.agent)) return [];
    const read = await ends.read(agentId, "turn-end", agentPort(handle), snapshot!.agent!,
      () => handle.timeline.refetch({ direction: "before", limit: 200 }).catch(() => null));
    if (read.ended) return null;
    const page = read.value;
    return !page || page.error ? [] : checkpointTimeline(page.entries.map((entry) => entry.item));
  };

  const deferredTurns = new Map<string, { event: Parameters<typeof primeAndArm>[0]; api: PaseoApi }>();
  const generations = new Map<string, number>();
  // One counter for every agent: an agent's generation never takes a value it had before, even after forgetAgent drops it.
  let lastGeneration = 0;
  const invalidate = (agentId: string) => generations.set(agentId, ++lastGeneration);
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
        // Watched from the list request on: a close or archive noted while the page is fetched, or while earlier entries
        // are recovered, ends that agent's history read below. Every entry's watch opens as the page arrives, starting
        // with what the listing noted, and is done when its entry is skipped or decided; a stop clears them (ends.clear).
        const listing = ends.listing();
        const { page, listed } = await api.agents.list({ page: { limit: 200, cursor }, signal: lifetime.signal }).then((page) => ({
          page,
          listed: page.entries.map(({ agent }) => {
            const handle = api.agents.ref(agent.id);
            return { agent, handle, watching: listing.watch(agent.id, "recovery", agentPort(handle)) };
          }),
        })).finally(listing.done);
        for (const { agent, handle, watching } of listed) {
          if (stopped) return;
          const reason = rearmSkipReason(agent, config.extendIdleCompaction) ?? disabledReason(agent.provider, config, agent.model);
          if (reason) { skip(reason); watching.done(); continue; }
          if (timers.has(agent.id) || inFlightHasAgent(agent.id)) { skip("already-pending"); watching.done(); continue; }
          expectedUserMessage.set(agent.id, agent.lastUserMessageAt ?? null);
          const generation = generations.get(agent.id) ?? 0;
          try {
            if (await recoveryCwdMissing(agent)) { skip("cwd-missing"); continue; }
            if (stopped) return;
            const read = await watching.run(agent, () => recoveryHistory(handle.timeline));
            if (stopped) return;
            if (read.ended) { skip(read.end === "gone" ? "agent-unavailable" : "ended-during-read"); continue; }
            const history = read.value;
            if (!history) { skip("timeline-unavailable"); continue; }
            // The fetch made after the read is the fresh snapshot; it is made again only if it failed.
            const fresh = read.after ?? (await handle.refresh())?.agent;
            if (stopped) return;
            if (!fresh) { skip("agent-unavailable"); continue; }
            const freshReason = rearmSkipReason(fresh, config.extendIdleCompaction);
            if (freshReason) { skip(freshReason); continue; }
            const remembered = await store.latestTurn(agent.id);
            const recovered = recoverTurn(fresh, history, remembered);
            if (!recovered) { skip("no-ended-turn"); continue; }
            const entries = await store.read();
            // Without a turn ID (provider history after a restart), the same input marks the same turn: the same
            // lastUserMessageAt, and on Paseo 0.13 the same agent message, which does not move it.
            if (entries.some((entry) => entry.agentId === agent.id && (entry.key === recovered.key ||
              (!entry.key.match(/:retry-\d+$/) && (Date.parse(entry.createdAt) >= Date.parse(recovered.endedAt) ||
                (!recovered.turnId && entry.lastUserMessageAt === recovered.lastUserMessageAt && (entry.inputId ?? null) === (recovered.inputId ?? null))))))) {
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
            const cold = cacheExpired(fresh.provider, fresh.model, checkpoint.endedAt, now());
            // A cold agent is compacted only when its context reaches the threshold; otherwise it stays a cache-expired skip.
            if (cold && (cacheExpiredSkip(fresh.provider, fresh.model, checkpoint.endedAt, now(), config) ||
              (fresh.lastUsage?.contextWindowUsedTokens ?? 0) < config.thresholdTokens)) { skip("cache-expired"); continue; }
            const delay = recoveryDelay(fresh.provider, checkpoint.endedAt, config, now(), random, fresh.model);
            expectedUserMessage.set(agent.id, checkpoint.lastUserMessageAt);
            timers.schedule(checkpoint.key, agent.id, delay.delayMs, () => {
              void evaluate(checkpoint, api).catch((error) => log("evaluation-failed", { agentId: agent.id, reason: safeError(error) }));
            });
            recoveryFailures.delete(agent.id);
            rearmed++;
            log("re-armed", { agentId: agent.id, provider: fresh.provider, idleSince: checkpoint.endedAt, ...delay, ...(cold ? { cacheExpired: true } : {}) });
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
          } finally {
            watching.done();
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

  const forgetAgent = (agentId: string) => {
    timers.cancel(agentId);
    invalidate(agentId);
    expectedUserMessage.delete(agentId);
    recoveryFailures.delete(agentId);
    deferredTurns.delete(agentId);
    // A closed or archived agent has no future work until a new lifecycle event.
    // Drop its generation too, otherwise one entry remains for every historical agent.
    generations.delete(agentId);
  };

  const ensureSubscription = (api: PaseoApi, trigger = "first-subscription") => {
    if (stopped || subscribedApi === api) return;
    removeAgentSubscription?.();
    subscribedApi = api;
    let active = true;
    let removeListSubscription: () => void = () => {};
    let removeLocalSubscription: () => void = () => {};
    const remove = () => {
      if (!active) return;
      active = false;
      removeListSubscription();
      removeLocalSubscription();
      removeAgentSubscription = null;
      subscribedApi = null;
    };
    removeAgentSubscription = remove;
    removeLocalSubscription = api.agents.subscribe((update) => {
      if (!active || update.kind !== "upsert") return;
      if (update.agent.archivedAt || update.agent.status === "closed") {
        ends.note(update.agent.id, update.agent.archivedAt ? "archived" : "closed");
        forgetAgent(update.agent.id);
        return;
      }
      if (update.agent.status === "running" || update.agent.activeTurn ||
        (expectedUserMessage.has(update.agent.id) &&
          (update.agent.lastUserMessageAt ?? null) !== expectedUserMessage.get(update.agent.id))) recoveryFailures.delete(update.agent.id);
      if (busyStatus(update.agent.status) || update.agent.activeTurn ||
        (expectedUserMessage.has(update.agent.id) &&
          (update.agent.lastUserMessageAt ?? null) !== expectedUserMessage.get(update.agent.id))) invalidate(update.agent.id);
      const pendingKey = timers.key(update.agent.id);
      if (!pendingKey) return;
      if ((update.agent.lastUserMessageAt ?? null) !== (expectedUserMessage.get(update.agent.id) ?? null)) {
        timers.cancel(update.agent.id);
        log("timer-canceled", { agentId: update.agent.id, reason: "new-user-message" });
        return;
      }
      if (busyStatus(update.agent.status) || update.agent.activeTurn) {
        timers.cancel(update.agent.id);
        log("timer-canceled", { agentId: update.agent.id, reason: "new-turn-or-busy" });
      }
    });
    recover(api, trigger);
    // agents.subscribe only attaches a local listener in 0.9.2. The owned list
    // subscription enables daemon updates and restores snapshots on reconnect.
    void api.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
      const removeList = subscription.subscribe({
        snapshot: () => recover(api, "connection-snapshot"),
        update: () => {},
        error: (error) => { if (!stopped && active) log("subscription-failed", { reason: safeError(error) }); },
      });
      // Release it on the daemon too: a replaced subscription otherwise keeps streaming every
      // agent update, with a snapshot of the whole agent list, to an API nothing listens on.
      removeListSubscription = () => {
        removeList();
        void subscription.release?.().catch(() => undefined);
      };
      if (!active) removeListSubscription();
    }).catch((error) => { if (!stopped && active) log("subscription-failed", { reason: safeError(error) }); });
  };

  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    ensureSubscription(context.paseo);
    invalidate(event.agent.id);
    recoveryFailures.delete(event.agent.id);
    timers.cancel(event.agent.id);
    log("turn-ended", { agentId: event.agent.id, turnId: event.turnId, outcome: event.outcome.kind });
    const armFailed = (error: unknown) => log("arm-failed", { agentId: event.agent.id, reason: safeError(error) });
    if (event.timeline?.length) {
      // Paseo 0.11: the event's timeline is the agent's whole in-memory timeline. Nothing past this handler holds it.
      const ended = { agent: event.agent, turnId: event.turnId, timeline: checkpointTimeline(event.timeline) };
      void primeAndArm(ended, context.paseo).catch(armFailed);
      return;
    }
    // Paseo 0.13 sends an empty timeline, so the tail is read instead. A turn start, close or archive seen before the
    // read supersedes this turn and skips the read (endedTimeline), and one seen while it is read drops its result, as
    // it cancels a timer; an agent the read loaded again after that close or archive is put back. A canceled turn is not
    // read: a kill, delete, archive or daemon shutdown cancels the turn just before it unloads the agent, and a read
    // landing after that loads it again.
    const generation = generations.get(event.agent.id) ?? 0;
    const current = () => !stopped && generation === (generations.get(event.agent.id) ?? 0);
    const read: Promise<AgentTimelineItem[] | null> = event.outcome.kind === "canceled" ? Promise.resolve([])
      : endedTimeline(context.paseo, event.agent.id, current);
    void read.then((timeline) => {
      if (!timeline || !current()) return;
      return primeAndArm({ agent: event.agent, turnId: event.turnId, timeline }, context.paseo);
    }).catch(armFailed);
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
    ends.note(event.agent.id, "archived");
    forgetAgent(event.agent.id);
  });
  // Paseo emits this hook with the agent's closed state update, which forgets the agent too. Whichever arrives first
  // ends the turn, so a turn-end read still waiting on its fetch is skipped even before the list update lands.
  const removeClosed = server.on("agent.closed", (event) => {
    ends.note(event.agent.id, "closed");
    forgetAgent(event.agent.id);
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
  return async () => {
    stopped = true;
    lifetime.abort();
    void startupClient?.close().catch(() => undefined);
    removeTurnEnded();
    removeTurnStarted();
    removePermissionRequested();
    removePermissionResolved();
    removeArchived();
    removeClosed();
    removeAgentSubscription?.();
    timers.cancelAll();
    deferredTurns.clear();
    expectedUserMessage.clear();
    recoveryFailures.clear();
    generations.clear();
    ends.clear();
    // A store passed in belongs to the caller. Ours drops every later write, and teardown
    // waits for the one in flight, so a reloaded instance never races this one's writes.
    if (!dependencies.store) await store.close();
  };
}

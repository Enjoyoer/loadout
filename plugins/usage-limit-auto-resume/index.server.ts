import { defineSettings } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import type { FetchAgentTimelineResponseMessage } from "@getpaseo/protocol/messages";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type Config } from "./server/config.ts";
import { openDaemonClient, type AgentSettingsPort } from "./server/daemon.ts";
import { ReturnStore, type Profile } from "./server/fallback.ts";
import { readStoredProfiles } from "./server/stored-agent.ts";
import { createFallbackRunner } from "./server/fallback-runner.ts";
import { agentPool, QuotaReader, type PoolQuota, type QuotaPool } from "./server/quota.ts";
import { afterTransientFailure, applyClaimTurn, attemptCount, buildFailedTransientRecord, buildRecord, buildTransientRecord, boundUser, cancelClaim, closeDecision, failureSignature, holdsClaim, isActive, isExpectedUser, isOwnLatestMessage, isRpcTimeoutWaiting, lastUserMessage, isSameAgentAndSession, isTransientAssistantText, isUsageLimitAssistantText, messageId, presendCancel, quotaDecision, releaseClaim, resumePrompt, rpcTimeoutDecision, scheduleUsage, shouldResume, supersedeForNewUserTurn, transientRejectionState, turnMark, turnText, USAGE_ENDING_GATES, verificationDecision, verifyTransientTimeline, staleFailure, type AgentClose, type AgentSnapshot, type ClaimCancel, type ResumeRecord, type ResumeState, type InFlightClaim, type TimelineEntry } from "./server/model.ts";
import { ResumeStore, StateUnreadableError } from "./server/store.ts";

const log = (line: string) => console.log(`[usage-limit-auto-resume] ${line}`);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
// Thrown before anything reaches the socket, so the message was never delivered.
const isTransportNotConnected = (error: unknown) => /^Transport not connected\b/.test(errorMessage(error));

type OpenedClient = PaseoClient & { agentSettings?: AgentSettingsPort };

// Paseo forks every plugin from the daemon worker, so the parent process is the daemon run: a daemon restart replaces
// it, a plugin reload does not.
const currentDaemon = () => `pid:${process.ppid}`;

export default function contribute(server: PluginServerContext, openClient: () => Promise<OpenedClient> = openDaemonClient, quota = new QuotaReader(), returns = new ReturnStore(), stored: (agentId: string) => Promise<Profile[]> = readStoredProfiles, daemon: () => string = currentDaemon) {
  const settings = server.registerSettings(defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }));
  const store = new ResumeStore();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  // Set by cleanup. From then on nothing schedules or starts a sweep: not the startup chain, an interval tick, or a
  // hook handler that is still finishing.
  let stopped = false;
  let client: OpenedClient | null = null;
  let stateErrorLogged = false;
  // One entry per agent with a send in flight; see processRecord.
  const inFlight = new Map<string, InFlightClaim>();
  // The newest agent.closed this process saw per agent, set before any await so a send about to be claimed sees it
  // before its store write lands (see closeGate).
  const closes = new Map<string, AgentClose>();
  // Synchronous, so it is checked again right before each timeline read and claim: a close seen while the caller awaited
  // holds the record (closeGate decides it on the next sweep).
  const heldByClose = (record: ResumeRecord) => {
    const seen = closes.get(record.agentId);
    const decision = seen ? closeDecision(seen, record, daemon()) : "go";
    return decision === "hold" || decision === "end";
  };
  // The wait reason last logged per record and attempt, so a record waiting out its delay (or an unarmed host, or a PM
  // profile change) is logged once per retry, not on every poll.
  const skipLogged = new Map<string, string>();
  const logOnce = (record: ResumeRecord, reason: string, line: string) => {
    const key = `${attemptCount(record)}:${reason}`;
    if (skipLogged.get(record.recordId) === key) return;
    skipLogged.set(record.recordId, key);
    log(line);
  };
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

  const quotaOptions = (currentConfig: Config) => ({
    ttlMs: currentConfig.quotaCacheSeconds * 1000,
    timeoutMs: currentConfig.pqTimeoutSeconds * 1000,
    bufferMs: currentConfig.quotaResetBufferSeconds * 1000,
  });

  // PM quota fallback. It shares this plugin's client, quota reading, triggers and send claims; it has no loop of its own.
  const fallback = createFallbackRunner({
    returns,
    records: store,
    acquire,
    quota: (pool: QuotaPool, currentConfig: Config, options?: { fresh?: boolean }): Promise<PoolQuota> => currentConfig.quotaAware
      ? quota.pool(pool, { ...quotaOptions(currentConfig), ...(options?.fresh ? { ttlMs: 0 } : {}) })
      : Promise.resolve({ status: "unknown", pool, reason: "quotaAware off" }),
    stored,
    sending: (agentId) => inFlight.has(agentId),
    log,
    failed,
  });

  // The pool's quota for a record's provider and model, from one cached pq reading. Unknown when quota awareness is
  // off, pq is missing, slow, failing, or speaks another schema: the callers then behave exactly as without it.
  async function poolQuotaFor(record: Pick<ResumeRecord, "provider" | "model">, currentConfig: Config): Promise<PoolQuota> {
    if (!currentConfig.quotaAware) return { status: "unknown", pool: null, reason: "quotaAware off" };
    return quota.pool(agentPool(record.provider, record.model), quotaOptions(currentConfig));
  }

  const quotaSettings = (currentConfig: Config) => ({ resetBufferSeconds: currentConfig.quotaResetBufferSeconds, maxDelaySeconds: currentConfig.maxDelaySeconds });

  // A new usage record resumes about a minute after the pool's earliest real reset rather than after the flat delay.
  async function scheduled(record: ResumeRecord, currentConfig: Config): Promise<ResumeRecord> {
    if (record.kind === "transient") return record;
    const pool = await poolQuotaFor(record, currentConfig);
    const next = scheduleUsage(record, pool, { ...quotaSettings(currentConfig), messageBufferSeconds: currentConfig.resetBufferSeconds });
    if (next.notBefore !== record.notBefore) log(`quota-scheduled agentId=${record.agentId} recordId=${record.recordId} pool=${pool.pool} notBefore=${next.notBefore}`);
    if (next.quotaHold) log(`quota-hold agentId=${record.agentId} recordId=${record.recordId} reason=${JSON.stringify(next.quotaHold.reason)}`);
    return next;
  }

  // A long retry can fill the entire tail page. Walk back to the newest user, rather than treating a missing row
  // in 200 entries as an ambiguous send. Older pages naturally have hasNewer; anchor them to the fresh tail's epoch.
  async function transientTimeline(api: PaseoApi, record: ResumeRecord) {
    return walkTimeline(api, record.agentId, (entries) => !!lastUserMessage(entries.map((entry) => entry.item)), () => !heldByClose(record));
  }

  // The tail of the agent's timeline, walked back until `enough` holds or it starts. `readable` is checked before each
  // read, since a read loads a closed agent again.
  async function walkTimeline(api: PaseoApi, agentId: string, enough: (entries: TimelineEntry[]) => boolean, readable: () => boolean) {
    const timeline = api.agents.ref(agentId).timeline;
    if (!readable()) throw new Error("agent-closed");
    let page = await timeline.refetch({ direction: "before", limit: 200 });
    if (page.error || page.gap || page.staleCursor || page.hasNewer) throw new Error("timeline-incomplete");
    const epoch = page.epoch;
    let entries = page.entries;
    while (!enough(entries) && page.hasOlder) {
      const cursor = page.startCursor;
      if (!cursor || cursor.epoch !== epoch) throw new Error("timeline-incomplete");
      if (!readable()) throw new Error("agent-closed");
      page = await timeline.refetch({ direction: "before", cursor, limit: 200 });
      if (page.error || page.gap || page.staleCursor || page.epoch !== epoch || !page.entries.length ||
          (page.startCursor && page.startCursor.seq >= cursor.seq)) throw new Error("timeline-incomplete");
      entries = [...page.entries, ...entries];
    }
    return entries;
  }

  // Decided before anything reads the agent's timeline, since that read loads a closed agent again (closeDecision).
  // The close is the agent's, so this holds every record of the agent, whenever and by whichever handler it was
  // created. True when the record may go on.
  async function closeGate(record: ResumeRecord): Promise<boolean> {
    const run = daemon();
    let close = await store.closeOf(record.agentId);
    if (close && close.daemon !== run) {
      await store.clearClose(close);
      log(`agent-close-cleared agentId=${record.agentId} reason=daemon-restarted closedAt=${close.at}`);
      close = null;
    }
    // A close this process saw whose store write has not landed yet.
    const seen = closes.get(record.agentId);
    if (seen && (!close || Date.parse(seen.at) > Date.parse(close.at))) close = seen;
    const decision = closeDecision(close, record, run);
    if (decision === "go" || decision === "stale") return true;
    if (decision === "hold") {
      logOnce(record, "agent-closed", `send-held agentId=${record.agentId} recordId=${record.recordId} reason=agent-closed closedAt=${close!.at}`);
      return false;
    }
    const closedAt = close!.at;
    const ended = await store.update(record.recordId, (value) => isActive(value) && closeDecision(close, value, run) === "end"
      ? { ...value, state: "superseded", terminalReason: "agent-closed", updatedAt: new Date().toISOString() } : value);
    if (ended?.terminalReason === "agent-closed" && ended.state === "superseded") log(`record-superseded agentId=${record.agentId} recordId=${record.recordId} reason=agent-closed closedAt=${closedAt}`);
    return false;
  }

  // All ambiguous transient sends take this path, including persisted records from older plugin versions. Never
  // infer delivery from prompt text alone: the latest user must be the original checked row or our stable send ID.
  async function reverifyTransient(input: ResumeRecord, currentConfig: Config): Promise<ResumeRecord | null> {
    // A prompt-timeout record never re-arms: it sends its original message once, or nothing.
    if (input.rpcTimeout || !currentConfig.armed || inFlight.has(input.agentId)) return null;
    if (!(await closeGate(input))) return null;
    const record = input;
    const api = await acquire();
    const agent = await fetchAgent(api, record.agentId);
    const settle = async (state: ResumeState, reason: string) => store.update(record.recordId, (value) =>
      value.state === record.state && value.updatedAt === record.updatedAt
        ? { ...value, state, terminalReason: reason, updatedAt: new Date().toISOString() } : value);
    // A deleted agent is gone for good: the daemon knows no live or stored agent by this ID. The record ends rather than
    // being re-verified forever. (A send-time miss parks it here as uncertain first, so this is the second miss.)
    if (!agent) {
      const ended = await settle("superseded", "agent-missing");
      if (ended?.terminalReason === "agent-missing" && ended.state === "superseded") log(`record-superseded agentId=${record.agentId} recordId=${record.recordId} reason=agent-missing`);
      return null;
    }
    if (record.terminalReason === "retry-turn-canceled") { await settle("superseded", "retry-turn-canceled"); return null; }
    if (agent.archivedAt) { await settle("superseded", "agent-archived"); return null; }
    if (!isSameAgentAndSession(record, agent)) { await settle("superseded", "identity-changed"); return null; }
    if (agent.status === "running" || agent.activeTurn) return null;
    // "closed" is an agent whose runtime is not loaded, as every agent is after a daemon restart: the timeline read below
    // loads it, and the next sweep sees it live.
    if (agent.status !== "idle" && agent.status !== "error" && agent.status !== "closed") return null;
    if (agent.pendingPermissions?.length || (agent.requiresAttention && !["error", "finished"].includes(agent.attentionReason ?? ""))) return null;
    let entries: FetchAgentTimelineResponseMessage["payload"]["entries"];
    try {
      entries = await transientTimeline(api, record);
    } catch (error) {
      log(`retry-verification-deferred agentId=${record.agentId} reason=${JSON.stringify(errorMessage(error))}`);
      return null;
    }
    const fresh = await fetchAgent(api, record.agentId);
    if (!fresh || JSON.stringify(turnMark(fresh)) !== JSON.stringify(turnMark(agent)) || fresh.activeTurn || fresh.status === "running") return null;
    const user = lastUserMessage(entries.map((entry) => entry.item));
    if (!user) return null;
    const expected = (fresh.lastUserMessageAt ?? null) === record.lastUserMessageAt && isExpectedUser(record, user, fresh.lastUserMessageAt);
    const ownLatest = isOwnLatestMessage(record, user);
    if (!expected && !ownLatest) { await settle("superseded", "newer-user-message"); return null; }
    // A send receipt can precede its timeline row. Keep the existing verification window before retrying an
    // uncertain delivery whose newest user row is still the pre-send prompt.
    if (record.sentAt && !ownLatest && record.verificationDeadlineAt && Date.parse(record.verificationDeadlineAt) > Date.now()) return null;
    // Pi's failed outcome is rendered as a System Error assistant row. Ignore plugin decorations, not model output.
    const final = entries.findLast((entry) => entry.item.type !== "plugin");
    const item = final?.item;
    const failure = fresh.status === "error" && fresh.lastError ? fresh.lastError
      : item?.type === "error" ? item.message
      : item?.type === "assistant_message" && /^\[System Error\]/.test(item.text) ? item.text.replace(/^\[System Error\]\s*/, "") : null;
    if (!failure) {
      if (fresh.status === "idle" && item?.type === "assistant_message" && !isTransientAssistantText(item.text)) await settle("done", "retry-succeeded-on-reverify");
      return null;
    }
    if (isUsageLimitError(failure)) {
      const usage = buildRecord(fresh, failure, undefined, currentConfig, Date.now(), final?.turnId ?? record.resumeTurnId ?? record.sourceTurnId, true);
      // One write settles this record and adds the usage record, only while this record is as it was read.
      if (usage) await store.handoff(record.recordId, (value) => value.state === record.state && value.updatedAt === record.updatedAt,
        (value) => ({ ...value, state: "superseded", terminalReason: "retry-to-usage", updatedAt: new Date().toISOString() }),
        await scheduled({ ...usage, originUserMessageAt: record.originUserMessageAt ?? null }, currentConfig));
      return null;
    }
    if (!fresh.lastUserMessageAt) return null;
    // A parked failure already has its backoff. A lost end event anchors the next delay to the live error row, not
    // to each poll, so re-verification can never keep pushing the retry into the future.
    const endedAt = final?.timestamp && Number.isFinite(Date.parse(final.timestamp)) ? Date.parse(final.timestamp) : Date.now();
    // The live state keeps only the error text and no turn, so this recognizes no new quota evidence; the record's own
    // evidence for the same failure is carried over as it is.
    const next = afterTransientFailure({ ...record, failedOutcome: true, retryPrompt: "continue" }, `failed: ${failure}`,
      user.text, user.messageId ?? user.clientMessageId ?? "", fresh.lastUserMessageAt, currentConfig, endedAt, { message: failure, textOnly: true });
    if (!record.sentAt) next.notBefore = record.notBefore;
    const unchanged = (value: ResumeRecord) => value.state === record.state && value.updatedAt === record.updatedAt;
    const gate = shouldResume({ ...next, notBefore: new Date(0).toISOString() }, fresh, currentConfig);
    if (!gate.ok) {
      if (["opted-out", "identity-changed", "archived", "newer-user-message"].includes(gate.reason)) await settle(gate.reason === "opted-out" ? "exhausted" : "superseded", gate.reason);
      return null;
    }
    const stored = await store.update(record.recordId, (value) => unchanged(value) ? next : value);
    return stored?.state === "parked" && stored.updatedAt === next.updatedAt ? stored : null;
  }

  async function processRecord(record: ResumeRecord, currentConfig: Config) {
    if (!currentConfig.armed) {
      logOnce(record, "unarmed", `would-resume agentId=${record.agentId} reason=${record.failureSignature} recordId=${record.recordId}`);
      return;
    }
    // A PM whose fallback swap or due restore is not verified yet gets no send: never another turn on the profile
    // it is leaving. The record waits and follows the agent once the profile is in place.
    if (fallback.isBusy(record.agentId) || await fallback.blocksSend(record.agentId)) {
      logOnce(record, "pm-profile-change-pending", `send-deferred agentId=${record.agentId} recordId=${record.recordId} reason=pm-profile-change-pending`);
      return;
    }
    const api = await acquire();
    const agent = await fetchAgent(api, record.agentId);
    if (!agent) {
      await store.update(record.recordId, (value) => ({ ...value, state: record.kind === "transient" ? "uncertain" : "superseded", terminalReason: "agent-missing", updatedAt: new Date().toISOString() }));
      log(`send-skipped agentId=${record.agentId} recordId=${record.recordId} reason=agent-missing`);
      return;
    }
    if (record.rpcTimeout && record.state === "parked") {
      let entries: Awaited<ReturnType<typeof transientTimeline>> | null = null;
      if (heldByClose(record)) return;
      try { entries = await transientTimeline(api, record); } catch { entries = null; }
      const decision = rpcTimeoutDecision(record, agent, entries);
      const unchanged = (value: ResumeRecord) => value.state === record.state && value.updatedAt === record.updatedAt;
      if (decision.act === "stop") {
        await store.update(record.recordId, (value) => unchanged(value)
          ? { ...value, state: decision.state, terminalReason: decision.reason, updatedAt: new Date().toISOString() } : value);
        log(`rpc-timeout-${decision.state === "exhausted" ? "gave-up" : "no-resend"} agentId=${record.agentId} recordId=${record.recordId} reason=${decision.reason}`);
        return;
      }
      if (decision.act === "wait") {
        // Stored and logged once per reason, not on every poll.
        if (record.rpcTimeout.waiting !== decision.reason) {
          await store.update(record.recordId, (value) => unchanged(value) && value.rpcTimeout
            ? { ...value, rpcTimeout: { ...value.rpcTimeout, waiting: decision.reason }, updatedAt: new Date().toISOString() } : value);
          log(`rpc-timeout-waiting agentId=${record.agentId} recordId=${record.recordId} reason=${decision.reason} giveUpAt=${record.rpcTimeout.giveUpAt}`);
        }
        return;
      }
    }
    const gate = shouldResume(record, agent, currentConfig);
    if (!gate.ok) {
      logOnce(record, gate.reason, `send-skipped agentId=${record.agentId} recordId=${record.recordId} reason=${gate.reason}${gate.reason === "not-due" ? ` notBefore=${record.notBefore}` : ""}`);
      // An immediate retry can race the agent settling after its turn ends; keep the record and retry on the next sweep.
      const settling = gate.reason === "active-turn" || gate.reason === "agent-status=running";
      if (record.kind === "transient" && gate.reason !== "not-due" && !settling) {
        await store.update(record.recordId, (value) => ({ ...value, state: transientRejectionState(gate.reason), terminalReason: gate.reason, updatedAt: new Date().toISOString() }));
      } else if (USAGE_ENDING_GATES.includes(gate.reason)) {
        // These end a usage record. Anything else, such as an attention request or a pending permission, only holds it
        // until a later sweep.
        await store.update(record.recordId, (value) => ({ ...value, state: gate.reason === "newer-user-message" ? "superseded" : "exhausted", terminalReason: gate.reason, updatedAt: new Date().toISOString() }));
      }
      return;
    }
    skipLogged.delete(record.recordId);
    // Before any send, the pool's quota: while every account is out, hold until the earliest reset instead of burning
    // an attempt. The hold is stored and logged once per change; an available or unknown quota sends as before.
    const decision = quotaDecision(record, await poolQuotaFor(record, currentConfig), quotaSettings(currentConfig));
    if (decision.hold) {
      if (decision.changed) {
        const hold = decision.hold;
        await store.update(record.recordId, (value) => value.state === record.state && value.updatedAt === record.updatedAt
          ? { ...value, quotaHold: hold, updatedAt: new Date().toISOString() } : value);
        log(`quota-hold agentId=${record.agentId} recordId=${record.recordId} reason=${JSON.stringify(hold.reason)}`);
      }
      return;
    }
    if (record.quotaHold) log(`quota-released agentId=${record.agentId} recordId=${record.recordId} reason=${JSON.stringify(record.quotaHold.reason)}`);
    // The agent snapshot the last send check passed on; the claim is taken on its latest user message and turn.
    let gated = agent;
    if (record.kind === "transient") {
      if (heldByClose(record)) return;
      try {
        const entries = await transientTimeline(api, record);
        const timelineGate = verifyTransientTimeline(record, entries.map((entry) => entry.item), agent.lastUserMessageAt);
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
    // The checks above awaited: an agent.closed seen meanwhile holds the send. From here on the close handler cancels
    // the claim itself.
    if (heldByClose(record)) {
      logOnce(record, "agent-closed", `send-held agentId=${record.agentId} recordId=${record.recordId} reason=agent-closed`);
      return;
    }
    inFlight.set(record.agentId, claim);
    try {
      // Claim only the record the gates checked: still in that state, unwritten since, at the same attempt generation.
      // A decision another handler stored stands; one seen but not stored yet is stored here instead of the claim.
      const claimed = await store.update(record.recordId, (value) => {
        if (value.state !== record.state || value.updatedAt !== record.updatedAt || attemptCount(value) !== attemptCount(record)) return value;
        if (claim.cancelled) return claim.cancelled.hold ? value : { ...value, state: claim.cancelled.state, terminalReason: claim.cancelled.reason, updatedAt: new Date().toISOString() };
        return {
          ...value,
          state: "resuming",
          quotaHold: null,
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
      // A prompt-timeout record decides again on the final timeline read: compaction and execution rows do not move the
      // agent's updatedAt, so the agent re-read above cannot see them.
      let timeoutCancel: ClaimCancel | null = null;
      if (record.rpcTimeout && fresh && !claim.cancelled && !presendCancel(record, taken, fresh, currentConfig)) {
        let entries: Awaited<ReturnType<typeof transientTimeline>> | null = null;
        try { entries = await transientTimeline(api, record); } catch { entries = null; }
        const decision = rpcTimeoutDecision(record, fresh, entries);
        if (decision.act === "stop") timeoutCancel = { state: decision.state, reason: decision.reason };
        else if (decision.act === "wait") timeoutCancel = { state: record.state, reason: decision.reason };
      }
      const cancelled = claim.cancelled ?? presendCancel(record, taken, fresh, currentConfig) ?? timeoutCancel;
      if (cancelled) {
        await store.update(record.recordId, (value) => {
          const next = cancelClaim(value, record, claim, cancelled);
          // A wait goes back to the record's state as it was, noting what it waits for.
          return cancelled === timeoutCancel && next !== value && next.state === record.state && next.rpcTimeout
            ? { ...next, terminalReason: record.terminalReason, rpcTimeout: { ...next.rpcTimeout, waiting: cancelled.reason } } : next;
        });
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
    if (heldByClose(record)) return;
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
      // PM fallback first, so a record acts on the profile its agent has after this pass.
      await fallback.sweep(currentConfig).catch((error) => failed("pm-fallback-sweep-failed", error));
      // One snapshot per sweep. A terminal record never acts again, so only an actionable one is read afresh: work on
      // an earlier record may have changed it.
      for (const record of await store.read()) {
        if (!isActive(record) || fallback.isBusy(record.agentId)) continue;
        if (record.state === "detected") {
          await store.update(record.recordId, (value) => value.state === "detected" ? { ...value, state: "parked", updatedAt: new Date().toISOString() } : value);
        }
        const latest = (await store.read()).find((value) => value.recordId === record.recordId);
        if (!latest || !(await closeGate(latest))) continue;
        if (latest.state === "resuming") {
          await store.update(latest.recordId, (value) => ({ ...value, state: "uncertain", terminalReason: "send-state-unreconciled", updatedAt: new Date().toISOString() }));
          continue;
        }
        // A prompt-timeout record never sends after any doubt: an uncertain one ends, a sent one is only verified.
        if (latest.rpcTimeout && latest.state === "uncertain") {
          await store.update(latest.recordId, (value) => value.state === "uncertain" && value.updatedAt === latest.updatedAt
            ? { ...value, state: "exhausted", terminalReason: `rpc-timeout-${value.terminalReason ?? "uncertain"}`, updatedAt: new Date().toISOString() } : value);
          log(`rpc-timeout-gave-up agentId=${latest.agentId} recordId=${latest.recordId} reason=${latest.terminalReason ?? "uncertain"}`);
          continue;
        }
        if (latest.rpcTimeout && latest.state === "verifying") {
          if (currentConfig.armed) await reconcile(latest, currentConfig);
          continue;
        }
        if (latest.kind === "transient" && (latest.state === "uncertain" || latest.state === "verifying")) {
          const rearmed = await reverifyTransient(latest, currentConfig);
          if (rearmed) await processRecord(rearmed, currentConfig);
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
        if (next?.resumeTurnId === turnId) await store.markHandled({ agentId: event.agent.id, sourceTurnId: turnId, persistenceSessionId: next.persistenceSessionId });
        if (next?.resumeTurnId === turnId) log(`resume-turn-started agentId=${event.agent.id} turnId=${turnId}`);
        return;
      }
      // Without a claim of its own the turn joins only a delivered send; a resuming record is a claim in flight here.
      const active = await store.activeForAgent(event.agent.id);
      // Any other turn on an agent waiting out a prompt timeout means it resumed by itself (Pi ran the pending prompt).
      if (active?.rpcTimeout && isRpcTimeoutWaiting(active) && turnId !== active.sourceTurnId) {
        await settleResumedItself(active, event.agent.id);
        return;
      }
      if (!active || active.state !== "verifying" || active.resumeTurnId) return;
      // Check again inside the update: a rolled-back claim must not pick up a turn identity.
      const next = await store.update(active.recordId, (value) => value.state === "verifying" && !value.resumeTurnId
        ? { ...value, resumeTurnId: turnId, resumeStartedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        : value);
      if (next?.resumeTurnId !== turnId) return;
      await store.markHandled({ agentId: event.agent.id, sourceTurnId: turnId, persistenceSessionId: next.persistenceSessionId });
      log(`resume-turn-started agentId=${event.agent.id} turnId=${turnId}`);
    })().catch((error) => failed("turn-started-handler-failed", error)));
  });

  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    // The user message the failed turn ran on, taken from the event before any await. A record built after the awaits
    // binds to it, never to a later snapshot's user message (bindFailure).
    const eventUser = lastUserMessage(event.timeline);
    // The agent, and the close this process had seen before the read began. A close that lands while the read is in
    // flight may postdate a snapshot that still shows the agent open, so it differs from closeSeen and stops
    // bindFailure's timeline read: that snapshot counts as closed.
    const readAgent = async () => {
      const closeSeen = closes.get(event.agent.id);
      const agent = await fetchAgent(context.paseo, event.agent.id);
      return { agent, closeSeen };
    };
    // After the awaits: is a different, later user message now the agent's latest (staleFailure)? The timeline is read
    // back to the bound row.
    const bindFailure = async (agent: AgentSnapshot, closeSeen: AgentClose | undefined, predecessor: ResumeRecord | null) => {
      const bound = boundUser(eventUser, predecessor);
      const open = () => agent.status !== "closed" && closes.get(event.agent.id) === closeSeen;
      // Closed by the snapshot, or a close landed since the agent read began: the timeline is not read, since that would
      // load the agent again, and the snapshot may postdate the close. The failure is not stale and has no origin, so
      // the close holds and ends its record.
      const closed = { stale: false, at: null };
      if (!open()) return closed;
      const entries = bound
        ? await walkTimeline(context.paseo, event.agent.id, (rows) => rows.some((entry) => entry.item.type === "user_message" && (entry.item.messageId ?? entry.item.clientMessageId) === bound.id), open).catch(() => null)
        : null;
      // A walk a close cut short counts as closed too.
      if (!entries && !open()) return closed;
      return staleFailure(bound, entries, agent.lastUserMessageAt, predecessor);
    };
    // Synchronous, before any await: another turn ending before a send is invoked stops that send.
    const pending = inFlight.get(event.agent.id);
    const unsent = pending && !pending.sendStarted ? pending : null;
    if (unsent) unsent.cancelled ??= { state: "superseded", reason: "turn-ended-before-send" };
    const handled = (async () => {
      // The cancelled claim stores its decision first, so this turn is handled as the agent's newest.
      if (unsent) await unsent.settled;
      const currentConfig = await config();
      if (!currentConfig) return;
      let active = await store.activeForAgent(event.agent.id);
      if (active && event.turnId && event.turnId !== active.sourceTurnId && event.turnId !== active.resumeTurnId) {
        const agent = await fetchAgent(context.paseo, event.agent.id);
        if (agent) {
          // Settle the old message before dispatching this turn. Re-verifying an old transient can supersede it,
          // but then returning used to swallow this new failure; a not-yet-due usage record blocked it too.
          // Decide inside the queued update so a sweep that settled the record meanwhile keeps its decision.
          await store.update(active.recordId, (value) => supersedeForNewUserTurn(value, agent, event.turnId, event.timeline));
          active = await store.activeForAgent(event.agent.id);
        }
      }
      if (active?.rpcTimeout && isRpcTimeoutWaiting(active)) {
        // The source turn's own repeated end changes nothing; any other turn means the agent resumed by itself.
        if (event.turnId !== active.sourceTurnId) await settleResumedItself(active, event.agent.id);
        return;
      }
      if (active?.kind === "transient" && event.outcome.kind === "canceled") {
        await store.update(active.recordId, (value) => ({ ...value, state: "superseded", terminalReason: "retry-turn-canceled", updatedAt: new Date().toISOString() }));
        return;
      }
      if (active?.state === "verifying" && active.resumeTurnId === event.turnId) {
        // Every write below settles only the record still waiting on this turn: of two end events for the same turn,
        // the later one finds it settled and changes nothing.
        const owns = (value: ResumeRecord) => value.state === "verifying" && value.resumeTurnId === event.turnId;
        // A user message reached the agent after this turn ended, so this failure is stale: newer work took over, and
        // no successor may take that work's time. The record ends.
        const predecessor = active;
        const settleStale = async (agent: AgentSnapshot) => {
          let settled = false;
          await store.update(predecessor.recordId, (value) => !owns(value) ? value : (settled = true, { ...value, state: "superseded", terminalReason: "stale-failure", updatedAt: new Date().toISOString() }));
          // A duplicate end event for this turn finds it settled already and logs nothing.
          if (settled) log(`stale-failure agentId=${event.agent.id} turnId=${event.turnId} recordId=${predecessor.recordId} reason=newer-user-message lastUserMessageAt=${agent.lastUserMessageAt}`);
        };
        // A successor continues the same work: it keeps the user message that work began with, not the snapshot's.
        const inherit = (successor: ResumeRecord): ResumeRecord => ({ ...successor, originUserMessageAt: predecessor.originUserMessageAt ?? null });
        if (active.resumeTurnId) await store.markHandled({ agentId: event.agent.id, sourceTurnId: active.resumeTurnId, persistenceSessionId: active.persistenceSessionId });
        if (active.kind === "transient") {
          const failedTransient = event.outcome.kind === "failed" && !isUsageLimitError(event.outcome.error.message, event.outcome.error.code);
          const { assistant, user } = event.outcome.kind === "failed"
            ? { assistant: `failed: ${event.outcome.error.message}`, user: lastUserMessage(event.timeline) }
            : turnText(event.timeline);
          const sentMessageId = active.attempts.at(-1)?.messageId;
          if (!user || (user.messageId ?? user.clientMessageId) !== sentMessageId || user.text !== active.retryPrompt || !assistant) {
            await store.update(active.recordId, (value) => !owns(value) ? value : ({ ...value, state: "uncertain", terminalReason: "retry-turn-ambiguous", updatedAt: new Date().toISOString() }));
            log(`retry-uncertain agentId=${event.agent.id} reason=retry-turn-ambiguous`);
            return;
          }
          // The one resend of a prompt-timeout record: anything but a clean completion ends it without another send.
          if (active.rpcTimeout && !(event.outcome.kind === "completed" && !isTransientAssistantText(assistant) && !isUsageLimitAssistantText(assistant))) {
            await store.update(active.recordId, (value) => owns(value)
              ? { ...value, state: "exhausted", terminalReason: "rpc-timeout-resend-failed", updatedAt: new Date().toISOString() } : value);
            log(`rpc-timeout-gave-up agentId=${event.agent.id} recordId=${active.recordId} reason=rpc-timeout-resend-failed`);
            return;
          }
          if (failedTransient || (event.outcome.kind === "completed" && isTransientAssistantText(assistant))) {
            const { agent, closeSeen } = await readAgent();
            if (!agent || !agent.lastUserMessageAt || !isSameAgentAndSession(active, agent)) {
              await store.update(active.recordId, (value) => !owns(value) ? value : ({ ...value, state: "uncertain", terminalReason: "retry-identity-ambiguous", updatedAt: new Date().toISOString() }));
              log(`retry-uncertain agentId=${event.agent.id} reason=retry-identity-ambiguous`);
              return;
            }
            if ((await bindFailure(agent, closeSeen, active)).stale) { await settleStale(agent); return; }
            // Re-park only the attempt this turn ended; a decision another handler stored meanwhile stands. The failed
            // outcome's error, with its code, decides whether this was a quota refusal.
            let reparked = false;
            const next = await store.update(active.recordId, (value) => owns(value)
              ? (reparked = true, afterTransientFailure({ ...value, ...(failedTransient ? { failedOutcome: true, retryPrompt: "continue" } : {}) }, assistant, user.text, sentMessageId!, agent.lastUserMessageAt!, currentConfig, Date.now(), event.outcome.kind === "failed" ? event.outcome.error : null))
              : value);
            // A concurrent end event for the same turn gets the already re-parked record back; only this update logs it.
            if (reparked && next?.state === "parked") log(`retry-scheduled agentId=${event.agent.id} recordId=${next.recordId} attempts=${attemptCount(next)} notBefore=${next.notBefore}`);
            return;
          }
          if ((event.outcome.kind === "completed" && isUsageLimitAssistantText(assistant)) || (event.outcome.kind === "failed" && !failedTransient)) {
            const { agent, closeSeen } = await readAgent();
            if (agent && (await bindFailure(agent, closeSeen, active)).stale) { await settleStale(agent); return; }
            const usage = agent && buildRecord(agent, assistant, undefined, currentConfig, Date.now(), event.turnId, event.outcome.kind === "failed");
            if (!usage || !isSameAgentAndSession(active, agent!)) {
              await store.update(active.recordId, (value) => !owns(value) ? value : ({ ...value, state: "uncertain", terminalReason: "usage-handoff-ambiguous", updatedAt: new Date().toISOString() }));
              log(`retry-uncertain agentId=${event.agent.id} reason=usage-handoff-ambiguous`);
              return;
            }
            // One write replaces this retry with the usage record, only while the retry still waits on this turn: a
            // duplicate end event for the turn finds it gone and writes nothing.
            const next = await scheduled(inherit(usage), currentConfig);
            if (await store.handoff(active.recordId, owns, null, next)) {
              log(`retry-to-usage agentId=${event.agent.id} recordId=${next.recordId} notBefore=${next.notBefore}`);
              await sweep();
            }
            return;
          }
          if (event.outcome.kind === "completed") {
            await store.remove(active.recordId);
            log(`retry-succeeded agentId=${event.agent.id} turnId=${event.turnId}`);
          } else {
            await store.update(active.recordId, (value) => !owns(value) ? value : ({ ...value, state: "uncertain", terminalReason: `retry-turn-${event.outcome.kind}`, updatedAt: new Date().toISOString() }));
            log(`retry-uncertain agentId=${event.agent.id} reason=retry-turn-${event.outcome.kind}`);
          }
          return;
        }
        if (event.outcome.kind === "completed") {
          await store.update(active.recordId, (value) => !owns(value) ? value : ({ ...value, state: "done", resumeFinishedAt: new Date().toISOString(), terminalReason: "resumed-turn-completed", updatedAt: new Date().toISOString() }));
          log(`resume-completed agentId=${event.agent.id} turnId=${event.turnId}`);
        } else if (event.outcome.kind === "failed") {
          // A failed resume turn is a failed turn like any other: it hands the work to a new record for that turn (a
          // usage limit again waits for its reset, anything else retries on the backoff) instead of ending it.
          const error = event.outcome.error;
          const { agent, closeSeen } = await readAgent();
          if (agent && (await bindFailure(agent, closeSeen, active)).stale) { await settleStale(agent); return; }
          const built = agent && isSameAgentAndSession(active, agent)
            ? buildRecord(agent, error.message, error.code, currentConfig, Date.now(), event.turnId, true) ?? buildFailedTransientRecord(agent, event.timeline, error, currentConfig, Date.now(), event.turnId)
            : null;
          if (!built) {
            await store.update(active.recordId, (value) => !owns(value) ? value : ({ ...value, state: "uncertain", terminalReason: "resumed-turn-failed", updatedAt: new Date().toISOString() }));
            log(`resume-uncertain agentId=${event.agent.id} reason=resumed-turn-failed`);
            return;
          }
          // One write settles this record and adds its successor, only while this record still waits on this turn. A
          // duplicate end event for the same turn finds it settled and writes nothing, so it can never reset or reopen
          // a successor that has already sent or finished.
          const next = await scheduled(inherit(built), currentConfig);
          const handed = await store.handoff(active.recordId, owns,
            (value) => ({ ...value, state: "superseded", terminalReason: "resumed-turn-failed", updatedAt: new Date().toISOString() }), next);
          if (!handed) return;
          log(`resume-failed-rescheduled agentId=${event.agent.id} recordId=${next.recordId} kind=${next.kind ?? "usage"} notBefore=${next.notBefore}`);
          await sweep();
        } else {
          await store.update(active.recordId, (value) => !owns(value) ? value : ({ ...value, state: "uncertain", terminalReason: `resumed-turn-${event.outcome.kind}`, updatedAt: new Date().toISOString() }));
        }
        return;
      }
      if (active?.kind === "transient" && (active.state === "uncertain" || active.state === "parked")) {
        // A missing/late start or end observation must not let the old record block a new failed turn indefinitely.
        // The live timeline, not this possibly truncated event snapshot, decides whether another send is safe.
        const rearmed = await reverifyTransient(active, currentConfig);
        if (rearmed) await sweep();
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
      const { agent, closeSeen } = await readAgent();
      if (!agent) return;
      const finalText = event.outcome.kind === "completed" ? turnText(event.timeline).assistant : null;
      const built = event.outcome.kind === "failed"
        ? buildRecord(agent, event.outcome.error.message, event.outcome.error.code, currentConfig, Date.now(), event.turnId, true)
          ?? buildFailedTransientRecord(agent, event.timeline, event.outcome.error, currentConfig, Date.now(), event.turnId)
        : finalText && isUsageLimitAssistantText(finalText)
          ? buildRecord(agent, finalText, undefined, currentConfig, Date.now(), event.turnId)
          : buildTransientRecord(agent, event.timeline, currentConfig, Date.now(), event.turnId);
      const scheduledRecord = built && await scheduled(built, currentConfig);
      if (!scheduledRecord) {
        log(`not-resumable agentId=${event.agent.id} outcome=${event.outcome.kind} reason=${event.outcome.kind === "failed" ? JSON.stringify(event.outcome.error) : "unrecognized-final"}`);
        return;
      }
      // A different, later user message is the agent's latest: newer work took over, and the record would take that
      // work's time for this old turn. The work's origin is the failed turn's own user row (staleFailure).
      const binding = await bindFailure(agent, closeSeen, null);
      if (binding.stale) {
        log(`stale-failure agentId=${event.agent.id} turnId=${event.turnId} reason=newer-user-message lastUserMessageAt=${agent.lastUserMessageAt}`);
        return;
      }
      const record: ResumeRecord = { ...scheduledRecord, originUserMessageAt: binding.at };
      // A record for this turn, or the guard a pruned one left, means the event was handled already.
      // A turn the plugin started is its record's to settle, never a new failure, however often its end is delivered.
      const sentBy = lastUserMessage(event.timeline);
      if (await store.hasTurn(record) || await store.isOwnSend(record.agentId, sentBy?.messageId ?? sentBy?.clientMessageId)) {
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
    })().catch((error) => failed("turn-handler-failed", error));
    // After the resume decision for this turn is stored: a PM fallback swap or a due restore, then a sweep so a
    // waiting record resumes on the profile now in place.
    track(handled.then(async () => {
      if (stopped) return;
      const currentConfig = await config();
      if (!currentConfig) return;
      // The runner decides from the outcome itself (turnSwapEvidence): only a failed turn refused for quota can swap.
      if (await fallback.afterTurnEnded(event.agent.id, event.outcome, currentConfig)) await sweep();
    }).catch((error) => failed("pm-fallback-turn-failed", error)));
  });

  async function settleResumedItself(active: ResumeRecord, agentId: string) {
    const next = await store.update(active.recordId, (value) => isRpcTimeoutWaiting(value)
      ? { ...value, state: "superseded", terminalReason: "agent-resumed-itself", updatedAt: new Date().toISOString() } : value);
    if (next?.terminalReason === "agent-resumed-itself") log(`rpc-timeout-no-resend agentId=${agentId} recordId=${active.recordId} reason=agent-resumed-itself`);
  }

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
      for (const record of records.filter((value) => value.agentId === event.agent.id &&
        (!["done", "superseded", "exhausted", "uncertain"].includes(value.state) || (value.kind === "transient" && value.state === "uncertain")))) {
        await store.update(record.recordId, (value) => ({ ...value, state: "superseded", terminalReason: "agent-archived", updatedAt: new Date().toISOString() }));
        log(`record-superseded agentId=${event.agent.id} recordId=${record.recordId} reason=agent-archived`);
      }
    })().catch((error) => failed("archive-handler-failed", error)));
  });

  const removePermission = server.on("agent.permission_requested", (event) => {
    // A send not started yet is held, not cancelled for good: its record goes back to waiting.
    const pending = inFlight.get(event.agent.id);
    cancelInFlight(event.agent.id, { state: "parked", reason: "permission-requested", hold: true });
    track((async () => {
      if (pending) await pending.settled;
      const active = await store.activeForAgent(event.agent.id);
      // Unsent work waits: the send gate holds it while the permission is pending, and it sends on its schedule once
      // the permission is answered. Only a send already made, whose delivery is now ambiguous, turns uncertain.
      if (!active || active.state === "detected" || active.state === "parked" || (active.kind === "transient" && active.state === "uncertain")) {
        if (active) log(`record-held agentId=${event.agent.id} recordId=${active.recordId} reason=permission-requested`);
        return;
      }
      await store.update(active.recordId, (value) => value.state === active.state && value.updatedAt === active.updatedAt
        ? { ...value, state: "uncertain", terminalReason: "permission-requested", updatedAt: new Date().toISOString() } : value);
      log(`record-uncertain agentId=${event.agent.id} recordId=${active.recordId} reason=permission-requested`);
    })().catch((error) => failed("permission-handler-failed", error)));
  });

  // Paseo sends agent.closed for an explicit close or kill and for every agent when the daemon shuts down; nothing in
  // the event tells them apart. The close is stored for the agent, with this daemon run, whether or not it has a record
  // yet, and closeGate decides on every later sweep: work of this agent is held, and ended once this run outlives the
  // close, while a new daemon run clears it.
  const removeClosed = server.on("agent.closed", (event) => {
    // The plugin's own profile swap reloads the agent, and a failed reload closes it. That is no one's close.
    if (fallback.isBusy(event.agent.id)) return;
    const close: AgentClose = { agentId: event.agent.id, at: new Date().toISOString(), daemon: daemon() };
    closes.set(close.agentId, close);
    cancelInFlight(event.agent.id, { state: "parked", reason: "agent-closed", hold: true });
    track((async () => {
      await store.markClosed(close);
      log(`agent-closed agentId=${close.agentId} closedAt=${close.at}`);
    })().catch((error) => failed("close-handler-failed", error)));
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
    removeClosed();
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

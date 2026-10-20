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
import { afterTransientFailure, applyClaimTurn, attemptCount, buildFailedTransientRecord, buildRecord, buildTransientRecord, cancelClaim, failureSignature, holdsClaim, isActive, isOwnLatestMessage, isRpcTimeoutWaiting, lastUserMessage, isSameAgentAndSession, isTransientAssistantText, isUsageLimitAssistantText, messageId, presendCancel, quotaDecision, releaseClaim, resumePrompt, rpcTimeoutDecision, scheduleUsage, shouldResume, supersedeForNewUserTurn, transientRejectionState, turnMark, turnText, verificationDecision, verifyTransientTimeline, type AgentSnapshot, type ClaimCancel, type ResumeRecord, type ResumeState, type InFlightClaim } from "./server/model.ts";
import { ResumeStore, StateUnreadableError } from "./server/store.ts";

const log = (line: string) => console.log(`[usage-limit-auto-resume] ${line}`);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
// Thrown before anything reaches the socket, so the message was never delivered.
const isTransportNotConnected = (error: unknown) => /^Transport not connected\b/.test(errorMessage(error));

type OpenedClient = PaseoClient & { agentSettings?: AgentSettingsPort };

export default function contribute(server: PluginServerContext, openClient: () => Promise<OpenedClient> = openDaemonClient, quota = new QuotaReader(), returns = new ReturnStore(), stored: (agentId: string) => Promise<Profile[]> = readStoredProfiles) {
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
  async function transientTimeline(api: PaseoApi, agentId: string) {
    const timeline = api.agents.ref(agentId).timeline;
    let page = await timeline.refetch({ direction: "before", limit: 200 });
    if (page.error || page.gap || page.staleCursor || page.hasNewer) throw new Error("timeline-incomplete");
    const epoch = page.epoch;
    let entries = page.entries;
    while (!lastUserMessage(entries.map((entry) => entry.item)) && page.hasOlder) {
      const cursor = page.startCursor;
      if (!cursor || cursor.epoch !== epoch) throw new Error("timeline-incomplete");
      page = await timeline.refetch({ direction: "before", cursor, limit: 200 });
      if (page.error || page.gap || page.staleCursor || page.epoch !== epoch || !page.entries.length ||
          (page.startCursor && page.startCursor.seq >= cursor.seq)) throw new Error("timeline-incomplete");
      entries = [...page.entries, ...entries];
    }
    return entries;
  }

  // All ambiguous transient sends take this path, including persisted records from older plugin versions. Never
  // infer delivery from prompt text alone: the latest user must be the original checked row or our stable send ID.
  async function reverifyTransient(record: ResumeRecord, currentConfig: Config): Promise<ResumeRecord | null> {
    // A prompt-timeout record never re-arms: it sends its original message once, or nothing.
    if (record.rpcTimeout || !currentConfig.armed || inFlight.has(record.agentId)) return null;
    const api = await acquire();
    const agent = await fetchAgent(api, record.agentId);
    if (!agent) return null;
    const settle = async (state: ResumeState, reason: string) => store.update(record.recordId, (value) =>
      value.state === record.state && value.updatedAt === record.updatedAt
        ? { ...value, state, terminalReason: reason, updatedAt: new Date().toISOString() } : value);
    if (record.terminalReason === "retry-turn-canceled") { await settle("superseded", "retry-turn-canceled"); return null; }
    if (agent.archivedAt || agent.status === "closed") { await settle("superseded", "agent-closed-or-archived"); return null; }
    if (!isSameAgentAndSession(record, agent)) { await settle("superseded", "identity-changed"); return null; }
    if (agent.status === "running" || agent.activeTurn) return null;
    if (agent.status !== "idle" && agent.status !== "error") return null;
    if (agent.pendingPermissions?.length || (agent.requiresAttention && !["error", "finished"].includes(agent.attentionReason ?? ""))) return null;
    let entries: FetchAgentTimelineResponseMessage["payload"]["entries"];
    try {
      entries = await transientTimeline(api, record.agentId);
    } catch (error) {
      log(`retry-verification-deferred agentId=${record.agentId} reason=${JSON.stringify(errorMessage(error))}`);
      return null;
    }
    const fresh = await fetchAgent(api, record.agentId);
    if (!fresh || JSON.stringify(turnMark(fresh)) !== JSON.stringify(turnMark(agent)) || fresh.activeTurn || fresh.status === "running") return null;
    const user = lastUserMessage(entries.map((entry) => entry.item));
    if (!user) return null;
    const expected = (fresh.lastUserMessageAt ?? null) === record.lastUserMessageAt && user.text === record.expectedUserText &&
      (!record.expectedUserMessageId || (user.messageId ?? user.clientMessageId) === record.expectedUserMessageId);
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
      if (usage) { await store.upsert(await scheduled(usage, currentConfig)); await settle("superseded", "retry-to-usage"); }
      return null;
    }
    if (!fresh.lastUserMessageAt) return null;
    // A parked failure already has its backoff. A lost end event anchors the next delay to the live error row, not
    // to each poll, so re-verification can never keep pushing the retry into the future.
    const endedAt = final?.timestamp && Number.isFinite(Date.parse(final.timestamp)) ? Date.parse(final.timestamp) : Date.now();
    const next = afterTransientFailure({ ...record, failedOutcome: true, retryPrompt: "continue" }, `failed: ${failure}`,
      user.text, user.messageId ?? user.clientMessageId ?? "", fresh.lastUserMessageAt, currentConfig, endedAt);
    if (!record.sentAt) next.notBefore = record.notBefore;
    const gate = shouldResume({ ...next, notBefore: new Date(0).toISOString() }, fresh, currentConfig);
    if (!gate.ok) {
      if (["opted-out", "identity-changed", "archived", "newer-user-message"].includes(gate.reason)) await settle(gate.reason === "opted-out" ? "exhausted" : "superseded", gate.reason);
      return null;
    }
    const stored = await store.update(record.recordId, (value) => value.state === record.state && value.updatedAt === record.updatedAt ? next : value);
    return stored?.state === "parked" && stored.updatedAt === next.updatedAt ? stored : null;
  }

  async function processRecord(record: ResumeRecord, currentConfig: Config) {
    if (!currentConfig.armed) {
      log(`would-resume agentId=${record.agentId} reason=${record.failureSignature} recordId=${record.recordId}`);
      return;
    }
    // A PM whose fallback swap or due restore is not verified yet gets no send: never another turn on the profile
    // it is leaving. The record waits and follows the agent once the profile is in place.
    if (fallback.isBusy(record.agentId) || await fallback.blocksSend(record.agentId)) {
      log(`send-deferred agentId=${record.agentId} recordId=${record.recordId} reason=pm-profile-change-pending`);
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
      try { entries = await transientTimeline(api, record.agentId); } catch { entries = null; }
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
      try {
        const entries = await transientTimeline(api, record.agentId);
        const timelineGate = verifyTransientTimeline(record, entries.map((entry) => entry.item));
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
        if (!latest) continue;
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
      log(`resume-turn-started agentId=${event.agent.id} turnId=${turnId}`);
    })().catch((error) => failed("turn-started-handler-failed", error)));
  });

  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
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
          // The one resend of a prompt-timeout record: anything but a clean completion ends it without another send.
          if (active.rpcTimeout && !(event.outcome.kind === "completed" && !isTransientAssistantText(assistant) && !isUsageLimitAssistantText(assistant))) {
            await store.update(active.recordId, (value) => value.state === "verifying" && value.resumeTurnId === event.turnId
              ? { ...value, state: "exhausted", terminalReason: "rpc-timeout-resend-failed", updatedAt: new Date().toISOString() } : value);
            log(`rpc-timeout-gave-up agentId=${event.agent.id} recordId=${active.recordId} reason=rpc-timeout-resend-failed`);
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
              ? afterTransientFailure({ ...value, ...(failedTransient ? { failedOutcome: true, retryPrompt: "continue" } : {}) }, assistant, user.text, sentMessageId!, agent.lastUserMessageAt!, currentConfig)
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
            await store.upsert(await scheduled(usage, currentConfig));
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
      const agent = await fetchAgent(context.paseo, event.agent.id);
      if (!agent) return;
      const finalText = event.outcome.kind === "completed" ? turnText(event.timeline).assistant : null;
      const built = event.outcome.kind === "failed"
        ? buildRecord(agent, event.outcome.error.message, event.outcome.error.code, currentConfig, Date.now(), event.turnId, true)
          ?? buildFailedTransientRecord(agent, event.timeline, event.outcome.error, currentConfig, Date.now(), event.turnId)
        : finalText && isUsageLimitAssistantText(finalText)
          ? buildRecord(agent, finalText, undefined, currentConfig, Date.now(), event.turnId)
          : buildTransientRecord(agent, event.timeline, currentConfig, Date.now(), event.turnId);
      const record = built && await scheduled(built, currentConfig);
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
    })().catch((error) => failed("turn-handler-failed", error));
    // After the resume decision for this turn is stored: a PM fallback swap or a due restore, then a sweep so a
    // waiting record resumes on the profile now in place.
    track(handled.then(async () => {
      if (stopped) return;
      const currentConfig = await config();
      if (!currentConfig) return;
      // The runner decides from the outcome itself (turnSwapEvidence): only a failed usage-limit turn can swap.
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

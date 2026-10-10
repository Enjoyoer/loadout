import { createHash } from "node:crypto";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export type ResumeState = "detected" | "parked" | "resuming" | "verifying" | "done" | "exhausted" | "opted-out" | "superseded" | "uncertain";

/** A record in one of these states can still send or is verifying a send; every other state is terminal. */
export function isActive(record: { state: ResumeState }): boolean {
  return record.state === "detected" || record.state === "parked" || record.state === "resuming" || record.state === "verifying";
}

export type ResumeAttempt = {
  at: string;
  messageId: string;
  result: "sent" | "send-failed" | "unknown" | "recovered";
};

export type ResumeRecord = {
  version: 2;
  kind?: "usage" | "transient";
  failedOutcome?: boolean;
  // Usage failures also leave Pi in error, but retain the usage delay/attempt cap.
  usageFailedOutcome?: boolean;
  retryPrompt?: string;
  expectedUserText?: string;
  expectedUserMessageId?: string | null;
  failedAssistantText?: string;
  recordId: string;
  sourceTurnId: string;
  agentId: string;
  workspaceId: string | null;
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
  cwd: string;
  persistenceSessionId: string;
  nativeHandle: string | null;
  configFingerprint: string;
  detectedAt: string;
  lastUserMessageAt: string | null;
  failureSignature: string;
  notBefore: string;
  resetAt: string | null;
  attempts: ResumeAttempt[];
  // Older attempts trimmed from `attempts`; they still count toward the next attempt's message ID.
  attemptsDropped?: number;
  state: ResumeState;
  sentAt: string | null;
  resumeTurnId: string | null;
  resumeStartedAt: string | null;
  resumeFinishedAt: string | null;
  verificationDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  terminalReason: string | null;
};

export type ResumeConfig = {
  maxAttempts: number;
  transientMaxAttempts?: number;
  transientBackoffSeconds?: readonly number[];
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  resetBufferSeconds: number;
  verificationTimeoutSeconds: number;
  excludedProviders: readonly string[];
  excludedLabels: readonly string[];
};

export type AgentSnapshot = {
  id: string;
  workspaceId?: string | null;
  provider: string;
  model?: string | null;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  cwd: string;
  title?: string | null;
  status: string;
  activeTurn?: { turnId: string; startedAt?: string | null } | null;
  pendingPermissions?: readonly unknown[];
  requiresAttention?: boolean;
  attentionReason?: string | null;
  archivedAt?: string | null;
  lastUserMessageAt?: string | null;
  persistence?: { provider: string; sessionId: string; nativeHandle?: string; metadata?: Record<string, unknown> } | null;
  labels?: Record<string, string>;
};

const FAILURE_PATTERNS: readonly RegExp[] = [
  /\busage[_ -]?limit[_ -]?(?:exceeded|reached)\b/i,
  /\b(?:you(?:'|’)?ve|you have) hit your usage limit\b/i,
  /\binsufficient[_ -]?quota\b/i,
  /\bout of credits\b/i,
  /\bweekly limit reached\b/i,
  /\bfive[- ]hour limit reached\b/i,
  /\b5[- ]hour limit reached\b/i,
  /\bquota (?:exhausted|reached)\b/i,
];

const BLOCKED_PATTERNS: readonly RegExp[] = [
  /\bcontext (?:window|length) (?:exceeded|limit)\b/i,
  /\bcontext[_ -]?length\b/i,
  /\btoo many tokens\b/i,
  /\bmodel[_ -]?cooldown\b/i,
  /\boverloaded\b/i,
  /\btemporarily limiting requests\b/i,
];

// Observed Claude synthetic assistant messages: ~/.claude/projects/.../722bde14-4917-40e2-81a1-a5f1f025566f.jsonl:1070
// and .../2a993f62-699f-4560-b860-642b13e4b6fe.jsonl:196. Codex capacity wording:
// ~/.codex/sessions/2026/09/25/rollout-2026-09-25T17-23-02-01a0da73-438e-7550-8684-0424daa11bb1.jsonl:12.
const TRANSIENT_API_PATTERN = /^API Error:\s*[\s\S]*\b(?:rate[_ -]?limit|temporarily limiting requests|overloaded|529|429)\b/i;
// Codex capacity arrives as "[System Error] Selected model is at capacity. Please try a different model."
const CAPACITY_PATTERN = /^(?:\[System Error\]\s*)?(?:API Error:\s*)?Selected model is at capacity\s*[.!]?(?:\s*Please try a different model\s*[.!]?)?$/i;
// Failed-outcome error messages come from the provider, never from model prose, so a broader match is safe.
// Observed 2026-09-28 in ~/.paseo/daemon.log: "Selected model is at capacity. Please try a different model."
// and "We’re currently experiencing high demand, which may cause temporary errors."
const TRANSIENT_ERROR_PATTERN = /\b(?:selected model is at capacity|experiencing high demand|temporary errors?|temporarily (?:unavailable|limiting requests)|overloaded(?:_error)?|rate[_ -]?limit(?:ed|_error)?|429|529|503)\b/i;

export function isTransientAssistantText(message: string): boolean {
  const text = message.trim();
  if (!text || failureSignature(text)) return false;
  return TRANSIENT_API_PATTERN.test(text) || CAPACITY_PATTERN.test(text);
}

export function isTransientErrorMessage(message: string, code?: string): boolean {
  const text = `${code ?? ""} ${message}`.trim();
  if (!text || failureSignature(message, code)) return false;
  return TRANSIENT_ERROR_PATTERN.test(text);
}

export function lastUserMessage(timeline: readonly AgentTimelineItem[]): Extract<AgentTimelineItem, { type: "user_message" }> | null {
  const user = timeline.findLast((item) => item.type === "user_message");
  return user?.type === "user_message" ? user : null;
}

export function isUsageLimitAssistantText(message: string): boolean {
  const text = message.trim();
  return (/^API Error:/i.test(text) || /^(?:Your weekly limit reached|You are out of credits|(?:5|five)[- ]hour limit reached)/i.test(text)) && failureSignature(text) !== null;
}

export function turnText(timeline: readonly AgentTimelineItem[]): { assistant: string | null; user: Extract<AgentTimelineItem, { type: "user_message" }> | null } {
  const last = timeline.at(-1);
  if (!last || last.type !== "assistant_message") return { assistant: null, user: null };
  let firstAssistant = timeline.length - 1;
  while (firstAssistant > 0 && timeline[firstAssistant - 1]?.type === "assistant_message") firstAssistant--;
  const assistant = timeline.slice(firstAssistant).map((item) => item.type === "assistant_message" ? item.text : "").join("");
  const user = timeline.slice(0, firstAssistant).findLast((item) => item.type === "user_message");
  return { assistant, user: user?.type === "user_message" ? user : null };
}

export function transientDelaySeconds(config: ResumeConfig, attempts: number): number {
  const delays = config.transientBackoffSeconds ?? [0, 120, 300, 900];
  return delays[Math.min(attempts, delays.length - 1)]!;
}

export function failureSignature(message: string, code?: string): string | null {
  const text = `${code ?? ""} ${message}`;
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(text))) return null;
  if (!FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 24);
}

function parseResetAt(message: string, now: number, maxDelayMs: number): string | null {
  const epoch = message.match(/\b(?:reset(?:_?at)?|resets(?:_?at)?)[^0-9]*(\d{10})\b/i);
  if (epoch) {
    const ms = Number(epoch[1]) * 1000;
    if (Number.isFinite(ms) && ms > now) return new Date(Math.min(ms, now + maxDelayMs)).toISOString();
  }
  const relative = message.match(/\b(?:try again|reset|resets|available) in (\d+)\s*(seconds?|minutes?|hours?|days?)\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const multiplier = unit.startsWith("second") ? 1000 : unit.startsWith("minute") ? 60000 : unit.startsWith("hour") ? 3600000 : 86400000;
    const ms = amount * multiplier;
    if (Number.isFinite(ms) && ms > 0) return new Date(Math.min(now + ms, now + maxDelayMs)).toISOString();
  }
  return null;
}

export function configFingerprint(agent: AgentSnapshot): string {
  return createHash("sha256").update([
    agent.provider,
    agent.model ?? "",
    agent.currentModeId ?? "",
    agent.thinkingOptionId ?? "",
    agent.cwd,
    agent.persistence?.provider ?? "",
    agent.persistence?.sessionId ?? "",
    agent.persistence?.nativeHandle ?? "",
  ].join("\u0000")).digest("hex").slice(0, 32);
}

export function isOptedOut(agent: AgentSnapshot, config: ResumeConfig): boolean {
  const labels = agent.labels ?? {};
  return config.excludedLabels.some((label) => labels[label] === "true") || config.excludedProviders.includes(agent.provider);
}

export function isSameAgentAndSession(record: ResumeRecord, agent: AgentSnapshot): boolean {
  return agent.id === record.agentId &&
    agent.provider === record.provider &&
    (agent.model ?? null) === record.model &&
    (agent.currentModeId ?? null) === record.modeId &&
    (agent.thinkingOptionId ?? null) === record.thinkingOptionId &&
    agent.cwd === record.cwd &&
    agent.persistence?.provider === record.provider &&
    agent.persistence?.sessionId === record.persistenceSessionId &&
    (agent.persistence?.nativeHandle ?? null) === record.nativeHandle &&
    configFingerprint(agent) === record.configFingerprint &&
    agent.archivedAt == null;
}

export function buildRecord(eventAgent: AgentSnapshot, failureMessage: string, code: string | undefined, config: ResumeConfig, now = Date.now(), sourceTurnId?: string | null, usageFailedOutcome = false): ResumeRecord | null {
  if (!sourceTurnId) return null;
  const signature = failureSignature(failureMessage, code);
  if (!signature || isOptedOut(eventAgent, config) || eventAgent.archivedAt) return null;
  if (!eventAgent.persistence?.sessionId) return null;
  const model = eventAgent.model ?? eventAgent.persistence?.metadata?.model;
  if (typeof model !== "string" || !model) return null;
  const detectedAt = new Date(now).toISOString();
  const resetAt = parseResetAt(failureMessage, now, config.maxDelaySeconds * 1000);
  const delayMs = Math.min(config.baseDelaySeconds * 1000, config.maxDelaySeconds * 1000);
  const identity = configFingerprint(eventAgent);
  const recordId = `resume:${createHash("sha256").update([eventAgent.id, sourceTurnId, identity].join("\u0000")).digest("hex").slice(0, 32)}`;
  return {
    version: 2,
    recordId,
    sourceTurnId,
    usageFailedOutcome,
    agentId: eventAgent.id,
    workspaceId: eventAgent.workspaceId ?? null,
    provider: eventAgent.provider,
    model,
    modeId: eventAgent.currentModeId ?? null,
    thinkingOptionId: eventAgent.thinkingOptionId ?? null,
    cwd: eventAgent.cwd,
    persistenceSessionId: eventAgent.persistence.sessionId,
    nativeHandle: eventAgent.persistence.nativeHandle ?? null,
    configFingerprint: identity,
    detectedAt,
    lastUserMessageAt: eventAgent.lastUserMessageAt ?? null,
    failureSignature: signature,
    notBefore: new Date(Math.max(now + delayMs, resetAt ? Date.parse(resetAt) + config.resetBufferSeconds * 1000 : 0)).toISOString(),
    resetAt,
    attempts: [],
    state: "detected",
    sentAt: null,
    resumeTurnId: null,
    resumeStartedAt: null,
    resumeFinishedAt: null,
    verificationDeadlineAt: null,
    createdAt: detectedAt,
    updatedAt: detectedAt,
    terminalReason: null,
  };
}

export function buildTransientRecord(agent: AgentSnapshot, timeline: readonly AgentTimelineItem[], config: ResumeConfig, now = Date.now(), sourceTurnId?: string | null): ResumeRecord | null {
  if (!sourceTurnId || isOptedOut(agent, config) || agent.archivedAt || !agent.persistence?.sessionId || !agent.lastUserMessageAt) return null;
  const { assistant, user } = turnText(timeline);
  if (!assistant || !isTransientAssistantText(assistant) || !user) return null;
  const model = agent.model ?? agent.persistence.metadata?.model;
  if (typeof model !== "string" || !model) return null;
  const detectedAt = new Date(now).toISOString();
  const identity = configFingerprint(agent);
  const recordId = `transient:${createHash("sha256").update([agent.id, sourceTurnId, identity].join("\u0000")).digest("hex").slice(0, 32)}`;
  return {
    version: 2, kind: "transient", recordId, sourceTurnId, agentId: agent.id,
    workspaceId: agent.workspaceId ?? null, provider: agent.provider, model,
    modeId: agent.currentModeId ?? null, thinkingOptionId: agent.thinkingOptionId ?? null,
    cwd: agent.cwd, persistenceSessionId: agent.persistence.sessionId,
    nativeHandle: agent.persistence.nativeHandle ?? null, configFingerprint: identity,
    detectedAt, lastUserMessageAt: agent.lastUserMessageAt,
    failureSignature: createHash("sha256").update(assistant).digest("hex").slice(0, 24),
    failedAssistantText: assistant, expectedUserText: user.text,
    expectedUserMessageId: user.messageId ?? user.clientMessageId ?? null,
    retryPrompt: user.text || `Continue the last user request from this conversation. Inspect current state first and avoid repeating completed side effects. [auto-retry:${recordId}]`,
    notBefore: new Date(now + transientDelaySeconds(config, 0) * 1000).toISOString(),
    resetAt: null, attempts: [], state: "detected", sentAt: null,
    resumeTurnId: null, resumeStartedAt: null, resumeFinishedAt: null,
    verificationDeadlineAt: null, createdAt: detectedAt, updatedAt: detectedAt, terminalReason: null,
  };
}

export function buildFailedTransientRecord(agent: AgentSnapshot, timeline: readonly AgentTimelineItem[], error: { message: string; code?: string }, config: ResumeConfig, now = Date.now(), sourceTurnId?: string | null): ResumeRecord | null {
  if (!sourceTurnId || isOptedOut(agent, config) || agent.archivedAt || !agent.persistence?.sessionId || !agent.lastUserMessageAt) return null;
  if (failureSignature(error.message, error.code)) return null;
  const user = lastUserMessage(timeline);
  if (!user) return null;
  const model = agent.model ?? agent.persistence.metadata?.model;
  if (typeof model !== "string" || !model) return null;
  const detectedAt = new Date(now).toISOString();
  const identity = configFingerprint(agent);
  const recordId = `transient:${createHash("sha256").update([agent.id, sourceTurnId, identity].join("\u0000")).digest("hex").slice(0, 32)}`;
  const failure = `failed: ${error.message}`;
  return {
    version: 2, kind: "transient", failedOutcome: true, recordId, sourceTurnId, agentId: agent.id,
    workspaceId: agent.workspaceId ?? null, provider: agent.provider, model,
    modeId: agent.currentModeId ?? null, thinkingOptionId: agent.thinkingOptionId ?? null,
    cwd: agent.cwd, persistenceSessionId: agent.persistence.sessionId,
    nativeHandle: agent.persistence.nativeHandle ?? null, configFingerprint: identity,
    detectedAt, lastUserMessageAt: agent.lastUserMessageAt,
    failureSignature: createHash("sha256").update(failure).digest("hex").slice(0, 24),
    failedAssistantText: failure, expectedUserText: user.text,
    expectedUserMessageId: user.messageId ?? user.clientMessageId ?? null,
    // Pure resume: the failed turn may have done partial work, so never replay the original prompt.
    retryPrompt: "continue",
    notBefore: new Date(now + transientDelaySeconds(config, 0) * 1000).toISOString(),
    resetAt: null, attempts: [], state: "detected", sentAt: null,
    resumeTurnId: null, resumeStartedAt: null, resumeFinishedAt: null,
    verificationDeadlineAt: null, createdAt: detectedAt, updatedAt: detectedAt, terminalReason: null,
  };
}

export function verifyTransientTimeline(record: ResumeRecord, timeline: readonly AgentTimelineItem[]): { ok: true } | { ok: false; reason: string } {
  const { assistant, user } = record.failedOutcome ? { assistant: record.failedAssistantText ?? null, user: lastUserMessage(timeline) } : turnText(timeline);
  if (!assistant || assistant !== record.failedAssistantText) return { ok: false, reason: "failure-text-changed" };
  if (!user) return { ok: false, reason: "user-prompt-missing" };
  if (user.text !== record.expectedUserText) return { ok: false, reason: "newer-user-message" };
  const id = user.messageId ?? user.clientMessageId ?? null;
  if (record.expectedUserMessageId && id !== record.expectedUserMessageId) return { ok: false, reason: "newer-user-message" };
  return { ok: true };
}

export function transientRejectionState(reason: string): ResumeState {
  return reason === "newer-user-message" ? "superseded" : reason === "max-attempts" ? "exhausted" : "uncertain";
}

// Failed-turn records retry without a cap, so only their newest attempts are kept in full.
export const MAX_KEPT_ATTEMPTS = 20;

export function attemptCount(record: ResumeRecord): number {
  return (record.attemptsDropped ?? 0) + record.attempts.length;
}

export function afterTransientFailure(record: ResumeRecord, assistant: string, userText: string, userMessageId: string, lastUserMessageAt: string, config: ResumeConfig, now = Date.now()): ResumeRecord {
  const exhausted = !record.failedOutcome && record.attempts.length >= (config.transientMaxAttempts ?? 3);
  const updatedAt = new Date(now).toISOString();
  const attempts = record.attempts.slice(-MAX_KEPT_ATTEMPTS);
  const dropped = record.attempts.length - attempts.length;
  return {
    ...record,
    ...(dropped > 0 ? { attempts, attemptsDropped: (record.attemptsDropped ?? 0) + dropped } : {}),
    state: exhausted ? "exhausted" : "parked",
    terminalReason: exhausted ? "max-attempts" : null,
    failedAssistantText: assistant,
    failureSignature: createHash("sha256").update(assistant).digest("hex").slice(0, 24),
    expectedUserText: userText,
    expectedUserMessageId: userMessageId,
    lastUserMessageAt,
    notBefore: new Date(now + transientDelaySeconds(config, attemptCount(record)) * 1000).toISOString(),
    resumeTurnId: null, resumeStartedAt: null, resumeFinishedAt: null,
    sentAt: null, verificationDeadlineAt: null, updatedAt,
  };
}

/** A turn start seen while a send was in flight, noted before the store records it. */
export type TurnObservation = { turnId: string | null; startedAt: string | null };

/** The decision of a safety event (a permission request, an archive) that reached an agent with a send in flight. */
export type ClaimCancel = { state: ResumeState; reason: string };

/**
 * One send in flight: what its claim writes, whether its rollback has replaced the claim, any turn seen meanwhile, and
 * a safety event seen before the send started.
 */
export type InFlightClaim = TurnObservation & {
  recordId: string;
  attempt: ResumeAttempt;
  sentAt: string;
  verificationDeadlineAt: string;
  released: boolean;
  cancelled: ClaimCancel | null;
};

const isClaimAttempt = (attempt: ResumeAttempt, claim: InFlightClaim) => attempt.messageId === claim.attempt.messageId && attempt.at === claim.attempt.at;

/** The record still carries this claim: resuming, with the claim's own attempt. */
export function holdsClaim(current: ResumeRecord, claim: InFlightClaim): boolean {
  return current.state === "resuming" && current.attempts.some((attempt) => isClaimAttempt(attempt, claim));
}

// Undoes a claim whose send never started because a safety event arrived first: the claim's attempt, send time and
// deadline go. A record still resuming takes that event's decision; a state the event's handler or another writer
// already stored is kept.
export function cancelClaim(current: ResumeRecord, before: ResumeRecord, claim: InFlightClaim, cancel: ClaimCancel, now = Date.now()): ResumeRecord {
  if (!current.attempts.some((attempt) => isClaimAttempt(attempt, claim))) return current;
  return {
    ...current,
    ...(current.state === "resuming" ? { state: cancel.state, terminalReason: cancel.reason } : {}),
    sentAt: current.sentAt === claim.sentAt ? before.sentAt : current.sentAt,
    verificationDeadlineAt: current.verificationDeadlineAt === claim.verificationDeadlineAt ? before.verificationDeadlineAt : current.verificationDeadlineAt,
    attempts: current.attempts.filter((attempt) => !isClaimAttempt(attempt, claim)),
    updatedAt: new Date(now).toISOString(),
  };
}

// Applies a turn start seen for an in-flight claim to the claim's record. While the record still carries the claim,
// the turn is attached. Once the claim's rollback is stored (released, record parked again), the message may have
// reached the daemon after all: the claim's attempt, send time and deadline come back with the turn, and the record
// turns uncertain. Every other state, including a terminal one another handler wrote, is kept.
export function applyClaimTurn(current: ResumeRecord, claim: InFlightClaim, now = Date.now()): ResumeRecord {
  if (!claim.turnId) return current;
  const updatedAt = new Date(now).toISOString();
  if ((current.state === "resuming" || current.state === "verifying") && !current.resumeTurnId) {
    return { ...current, resumeTurnId: claim.turnId, resumeStartedAt: claim.startedAt, updatedAt };
  }
  if (current.state !== "parked" || !claim.released) return current;
  const kept = current.attempts.some((attempt) => attempt.messageId === claim.attempt.messageId && attempt.at === claim.attempt.at);
  return {
    ...current,
    state: "uncertain",
    sentAt: claim.sentAt,
    verificationDeadlineAt: claim.verificationDeadlineAt,
    attempts: kept ? current.attempts : [...current.attempts, claim.attempt],
    resumeTurnId: claim.turnId,
    resumeStartedAt: claim.startedAt,
    terminalReason: "turn-started-during-failed-send",
    updatedAt,
  };
}

// Undoes a send claim after the transport refused the message. It starts from the current stored value and resets only
// the fields the claim set, so a concurrent writer's changes survive. A turn that started after the claim, whether the
// store already holds it or only the in-flight observation does, means the message may have reached the daemon after
// all, so the record turns uncertain with that turn kept instead of being re-armed for a second send.
export function releaseClaim(current: ResumeRecord, before: ResumeRecord, claimed: ResumeRecord, observed: TurnObservation | null = null, now = Date.now()): ResumeRecord {
  if (current.state !== "resuming") return current;
  const updatedAt = new Date(now).toISOString();
  const storedTurn = current.resumeTurnId && current.resumeTurnId !== before.resumeTurnId ? current.resumeTurnId : null;
  const turnId = storedTurn ?? observed?.turnId ?? null;
  if (turnId) {
    const resumeStartedAt = storedTurn ? current.resumeStartedAt : observed?.startedAt ?? null;
    return { ...current, state: "uncertain", resumeTurnId: turnId, resumeStartedAt, terminalReason: "turn-started-during-failed-send", updatedAt };
  }
  const claimAttempt = claimed.attempts.at(-1);
  return {
    ...current,
    state: before.state,
    sentAt: current.sentAt === claimed.sentAt ? before.sentAt : current.sentAt,
    verificationDeadlineAt: current.verificationDeadlineAt === claimed.verificationDeadlineAt ? before.verificationDeadlineAt : current.verificationDeadlineAt,
    attempts: current.attempts.filter((attempt) => !(attempt.messageId === claimAttempt?.messageId && attempt.at === claimAttempt.at)),
    updatedAt,
  };
}

export function shouldResume(record: ResumeRecord, agent: AgentSnapshot, config: ResumeConfig, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (record.state !== "parked" && record.state !== "detected") return { ok: false, reason: `state=${record.state}` };
  // Failed-turn records always resume; only the backoff (capped at its last step) limits them.
  if (!record.failedOutcome && record.attempts.length >= (record.kind === "transient" ? (config.transientMaxAttempts ?? 3) : config.maxAttempts)) return { ok: false, reason: "max-attempts" };
  if (Date.parse(record.notBefore) > now) return { ok: false, reason: "not-due" };
  // A failed turn leaves the agent in "error"; a send starts a fresh turn in the same session.
  if (agent.status !== "idle" && !((record.failedOutcome || record.usageFailedOutcome) && agent.status === "error")) return { ok: false, reason: `agent-status=${agent.status}` };
  if (agent.activeTurn) return { ok: false, reason: "active-turn" };
  if ((agent.pendingPermissions?.length ?? 0) > 0) return { ok: false, reason: "pending-permission" };
  // "finished" and "error" are Paseo's unread markers after a turn ends (an errored agent always carries "error"); only input requests block a resume.
  if (agent.requiresAttention && agent.attentionReason !== "finished" && !((record.failedOutcome || record.usageFailedOutcome) && agent.attentionReason === "error")) return { ok: false, reason: "requires-attention" };
  if (agent.archivedAt) return { ok: false, reason: "archived" };
  if (isOptedOut(agent, config)) return { ok: false, reason: "opted-out" };
  if (!isSameAgentAndSession(record, agent)) return { ok: false, reason: "identity-changed" };
  if ((agent.lastUserMessageAt ?? null) !== record.lastUserMessageAt) return { ok: false, reason: "newer-user-message" };
  return { ok: true };
}

export function verificationDecision(record: ResumeRecord, agent: AgentSnapshot, now = Date.now()): { state: "pending" | "done" | "uncertain" | "superseded"; reason: string } {
  if (!isSameAgentAndSession(record, agent)) return { state: "superseded", reason: "identity-changed" };
  if ((agent.lastUserMessageAt ?? null) !== record.lastUserMessageAt) return { state: "superseded", reason: "newer-user-message" };
  if (agent.pendingPermissions?.length) return { state: "uncertain", reason: "pending-permission" };
  if (record.state === "resuming") return { state: "uncertain", reason: "send-state-unreconciled" };
  if (record.resumeTurnId && agent.activeTurn?.turnId === record.resumeTurnId) return { state: "pending", reason: "resumed-turn-active" };
  if (agent.activeTurn) return { state: "uncertain", reason: "different-active-turn" };
  if (!record.resumeTurnId) return { state: "uncertain", reason: "resume-turn-not-observed" };
  if (!record.resumeFinishedAt) return { state: "uncertain", reason: "resume-turn-end-not-observed" };
  if (record.verificationDeadlineAt && Date.parse(record.verificationDeadlineAt) < now) return { state: "uncertain", reason: "verification-timeout" };
  if (agent.status !== "idle") return { state: "uncertain", reason: `agent-status=${agent.status}` };
  return { state: "done", reason: "resumed-turn-completed" };
}

export function continuationPrompt(record: ResumeRecord): string {
  return `The previous turn ended because the provider reported a usage limit. Continue the existing task from the current workspace and conversation state. Do not repeat completed side effects. Inspect current state first, then continue with the next unfinished step. If the limit is still active, stop and report it. [auto-resume:${record.recordId}]`;
}

export function messageId(record: ResumeRecord): string {
  return `${record.recordId}:attempt:${attemptCount(record) + 1}`;
}

/** The exact text a send for this record carries. */
export function resumePrompt(record: ResumeRecord): string {
  return record.kind === "transient" ? record.retryPrompt! : continuationPrompt(record);
}

// True when the newest user row is the record's latest automatic message: its stable ID and the exact text it sent.
export function isOwnLatestMessage(record: ResumeRecord, user: Extract<AgentTimelineItem, { type: "user_message" }> | null): boolean {
  const sent = record.attempts.at(-1);
  return !!sent && !!user && (user.messageId ?? user.clientMessageId) === sent.messageId && user.text === resumePrompt(record);
}

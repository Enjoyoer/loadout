import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SETTINGS_VERSION } from "../server/config.ts";
import { MAX_KEPT_ATTEMPTS, afterTransientFailure, attemptCount, buildFailedTransientRecord, buildRecord, buildTransientRecord, endedTurnRows, isTransientErrorMessage, configFingerprint, continuationPrompt, failureSignature, isSameAgentAndSession, isTransientAssistantText, isUsageLimitAssistantText, messageId, shouldResume, transientDelaySeconds, transientRejectionState, turnText, verificationDecision, verifyTransientTimeline, type AgentSnapshot, type ResumeConfig } from "../server/model.ts";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { quotaDecision, scheduleUsage } from "../server/model.ts";
import { readLocalHostPace } from "../server/pace-read.ts";
import { agentPool, formatRemotePace, paceOf, parseRemotePace, poolQuota, QuotaReader, RemotePaceReader, remotePaceSshArgv, runPq, runRemotePaceSsh, type PqResult, type RemotePaceRunResult } from "../server/quota.ts";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const config: ResumeConfig = {
  transientBackoffSeconds: [0, 120, 300, 900, 1800],
  baseDelaySeconds: 18000,
  maxDelaySeconds: 604800,
  resetBufferSeconds: 30,
  verificationTimeoutSeconds: 180,
  excludedProviders: ["chatgpt-web"],
  excludedLabels: ["noresume"],
};

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    provider: "claude",
    model: "claude-opus-5-5[1m]",
    currentModeId: "bypassPermissions",
    thinkingOptionId: "low",
    cwd: "/repo",
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    requiresAttention: false,
    archivedAt: null,
    lastUserMessageAt: "2026-09-25T11:59:00.000Z",
    persistence: {
      provider: "claude",
      sessionId: "session-1",
      nativeHandle: "native-1",
    },
    labels: {},
    ...overrides,
  };
}

function record(overrides = {}) {
  const result = buildRecord(agent(), "API Error: usage_limit_exceeded. Try again later.", "usage_limit_exceeded", config, NOW, "turn-1");
  assert.ok(result);
  return { ...result, ...overrides };
}

const RATE_LIMIT = "API Error: Server is temporarily limiting requests (not your usage limit) · This request would exceed your account's rate limit. Please try again later.";
const timeline = (assistant: string, user = "Fix the bug exactly."): AgentTimelineItem[] => [
  { type: "user_message", text: user, messageId: "user-1" },
  { type: "assistant_message", text: assistant },
];

function transient(overrides = {}) {
  const value = buildTransientRecord(agent(), timeline(RATE_LIMIT), config, NOW, "turn-1");
  assert.ok(value);
  return { ...value, ...overrides };
}

describe("Pi native failed usage outcomes", () => {
  it("parks formatted Pi errors for five hours then resumes error status with no attempt cap", () => {
    const pi = agent({ provider: "pi", model: "fleet/gpt-6.1-sol", status: "error", requiresAttention: true, attentionReason: "error", persistence: { provider: "pi", sessionId: "pi-session" } });
    for (const text of ["usage_limit_exceeded", "You've hit your usage limit. Try again in 1 hour.", "You’ve hit your usage limit.", "You are out of credits"]) {
      const error = `${text} (stopReason=error, model=fleet/gpt-6.1-sol)`;
      const usage = buildRecord(pi, error, undefined, config, NOW, "pi-failure", true);
      assert.ok(usage);
      assert.notEqual(usage.kind, "transient");
      assert.equal(usage.failedOutcome, undefined);
      assert.equal(usage.notBefore, new Date(NOW + 18000 * 1000).toISOString());
      assert.deepEqual(shouldResume(usage, pi, config, NOW), { ok: false, reason: "not-due" });
      assert.deepEqual(shouldResume(usage, pi, config, NOW + 18000 * 1000), { ok: true });
      assert.deepEqual(shouldResume({ ...usage, attempts: Array(3).fill({ at: "", messageId: "", result: "sent" }) }, pi, config, NOW + 18000 * 1000), { ok: true });
      assert.equal(buildFailedTransientRecord(pi, timeline(""), { message: error }, config, NOW, "pi-failure"), null);
    }
    const completed = buildRecord(pi, "usage_limit_exceeded", undefined, config, NOW, "completed")!;
    assert.deepEqual(shouldResume(completed, pi, config, NOW + 18000 * 1000), { ok: false, reason: "agent-status=error" });
  });
  it("does not treat ordinary assistant prose as a quota stop", () => {
    assert.equal(isUsageLimitAssistantText("You've hit your usage limit. This is an example."), false);
    assert.equal(failureSignature("429 rate_limit_error (stopReason=error, model=fleet/claude-opus-5-5)"), null);
  });
});

describe("failure classification", () => {
  it("recognizes explicit usage-limit failures", () => {
    assert.equal(typeof failureSignature("usage_limit_exceeded"), "string");
    assert.equal(typeof failureSignature("You are out of credits"), "string");
    assert.equal(typeof failureSignature("Your weekly limit reached"), "string");
  });

  it("rejects generic rate limits and non-usage failures", () => {
    assert.equal(failureSignature("429 Too Many Requests"), null);
    assert.equal(failureSignature("temporarily limiting requests"), null);
    assert.equal(failureSignature("model_cooldown"), null);
    assert.equal(failureSignature("context length exceeded"), null);
    assert.equal(failureSignature("connection reset"), null);
  });
});

describe("completed-turn transient classification", () => {
  it("matches observed Claude and Codex transient messages", () => {
    for (const message of [
      RATE_LIMIT,
      "API Error: Request rejected (429) · All credentials are cooling down (last error: rate_limit_error)",
      "API Error: overloaded_error: Overloaded",
      "API Error: 529 overloaded",
      "API Error: rate limit exceeded. Try again later.",
      "Selected model is at capacity",
      "[System Error] Selected model is at capacity. Please try a different model.",
    ]) assert.equal(isTransientAssistantText(message), true, message);
  });

  it("does not treat normal discussion, other API errors, or real usage limits as transient", () => {
    for (const message of [
      "We should account for the rate limit in the retry design.",
      "The error said API Error: rate limit exceeded in the log, but I fixed it.",
      "API Error: invalid API key",
      "API Error: usage_limit_exceeded",
      "API Error: Your weekly limit reached. Try again later.",
      "Selected model is at capacity in the screenshot, but I changed it.",
    ]) assert.equal(isTransientAssistantText(message), false, message);
    assert.equal(typeof failureSignature("API Error: usage_limit_exceeded"), "string");
    assert.equal(isUsageLimitAssistantText("API Error: usage_limit_exceeded"), true);
    assert.equal(isUsageLimitAssistantText("We diagnosed usage_limit_exceeded in the logs."), false);
  });

  it("requires a final assistant error and a recoverable user message", () => {
    assert.equal(buildTransientRecord(agent(), timeline("I fixed the rate limit handling."), config, NOW, "turn-1"), null);
    assert.equal(buildTransientRecord(agent(), [{ type: "assistant_message", text: RATE_LIMIT }], config, NOW, "turn-1"), null);
    assert.equal(buildTransientRecord(agent(), timeline(RATE_LIMIT), config, NOW, null), null);
    assert.equal(turnText([...timeline(RATE_LIMIT), { type: "user_message", text: "New task" }]).assistant, null);
    // Another agent's message is a turn input, and moves no lastUserMessageAt. No other tool row's text is.
    const toolRow = (status = "completed", name = "agent_message", callId = "paseo-agent-message:pm-1") => ({ type: "tool_call", callId, name, status, error: null,
      detail: { type: "plain_text", text: "Delegated task", icon: "bot" }, agentMessage: { event: "message", text: "Delegated task" } }) as unknown as AgentTimelineItem;
    const worker = agent({ lastUserMessageAt: null });
    const delegated = buildTransientRecord(worker, [toolRow(), { type: "assistant_message", text: RATE_LIMIT }], config, NOW, "turn-1");
    assert.deepEqual([delegated?.retryPrompt, delegated?.expectedUserMessageId, delegated?.lastUserMessageAt], ["Delegated task", "pm-1", null]);
    assert.equal(buildTransientRecord(agent(), [...timeline("Done."), toolRow(), { type: "assistant_message", text: RATE_LIMIT }], config, NOW, "turn-1")?.retryPrompt, "Delegated task");
    for (const other of [toolRow("running"), toolRow("completed", "shell"), toolRow("completed", "agent_message", "tool-1")]) {
      assert.equal(buildTransientRecord(worker, [other, { type: "assistant_message", text: RATE_LIMIT }], config, NOW, "turn-1"), null);
      assert.equal(buildTransientRecord(agent(), [timeline("")[0]!, other, { type: "assistant_message", text: RATE_LIMIT }], config, NOW, "turn-1")?.retryPrompt, "Fix the bug exactly.");
    }
  });

  it("retries immediately, then after 2, 5, and 15 minutes, then every 30 minutes, with no attempt cap", () => {
    const value = transient();
    assert.equal(Date.parse(value.notBefore) - NOW, 0);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map((attempts) => transientDelaySeconds(config, attempts)), [0, 120, 300, 900, 1800, 1800, 1800]);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((attempts) => transientDelaySeconds({ ...config, transientBackoffSeconds: undefined }, attempts)), [0, 120, 300, 900, 1800, 1800]);
    assert.equal(value.retryPrompt, "Fix the bug exactly.");
    assert.equal(buildRecord(agent(), "usage_limit_exceeded", undefined, config, NOW, "turn-1")?.notBefore, new Date(NOW + 18_000_000).toISOString());
    const third = { ...value, state: "parked" as const, attempts: [1, 2, 3].map((n) => ({ at: value.createdAt, messageId: `retry-${n}`, result: "sent" as const })) };
    assert.deepEqual(shouldResume(third, agent(), config, Date.parse(value.notBefore)), { ok: true });
  });

  it("uses continuation wording when the last user text is empty", () => {
    const value = buildTransientRecord(agent(), timeline(RATE_LIMIT, ""), config, NOW, "turn-1");
    assert.match(value?.retryPrompt ?? "", /Continue the last user request/);
  });

  it("reschedules failed retry turns at 2, 5, 15, then every 30 minutes, never exhausting", () => {
    let value = transient();
    const sentAt = new Date(NOW + 120_000).toISOString();
    for (const [attempt, delay] of [[1, 120], [2, 300], [3, 900], [4, 1800], [5, 1800], [6, 1800]] as const) {
      value = afterTransientFailure({ ...value, attempts: [...value.attempts, { at: sentAt, messageId: `retry-${attempt}`, result: "sent" }] }, RATE_LIMIT, "Fix the bug exactly.", `retry-${attempt}`, sentAt, config, NOW + attempt * 120_000);
      assert.equal(Date.parse(value.notBefore) - (NOW + attempt * 120_000), delay * 1000);
      assert.equal(value.state, "parked");
      assert.equal(value.terminalReason, null);
    }
  });

  it("rejects changed timeline, newer user messages, permissions, and changed session", () => {
    const value = transient({ state: "parked" });
    assert.deepEqual(verifyTransientTimeline(value, timeline(RATE_LIMIT), value.lastUserMessageAt), { ok: true });
    assert.deepEqual(verifyTransientTimeline(value, timeline(RATE_LIMIT, "Different request"), value.lastUserMessageAt), { ok: false, reason: "newer-user-message" });
    assert.deepEqual(verifyTransientTimeline(value, timeline("API Error: 529 overloaded"), value.lastUserMessageAt), { ok: false, reason: "failure-text-changed" });
    assert.deepEqual(shouldResume(value, agent({ lastUserMessageAt: "2026-09-25T12:00:01.000Z" }), config, Date.parse(value.notBefore)), { ok: false, reason: "newer-user-message" });
    assert.deepEqual(shouldResume(value, agent({ pendingPermissions: [{}] }), config, Date.parse(value.notBefore)), { ok: false, reason: "pending-permission" });
    assert.deepEqual(shouldResume(value, agent({ model: "other" }), config, Date.parse(value.notBefore)), { ok: false, reason: "identity-changed" });
    assert.equal(transientRejectionState("newer-user-message"), "superseded");
    assert.equal(transientRejectionState("pending-permission"), "uncertain");
    assert.equal(transientRejectionState("identity-changed"), "uncertain");
  });
});

describe("failed-turn transient classification", () => {
  const CAPACITY = "Selected model is at capacity. Please try a different model.";
  const DEMAND = "We’re currently experiencing high demand, which may cause temporary errors.";
  const failedTimeline: AgentTimelineItem[] = [
    { type: "user_message", text: "Process calls until 08:40.", messageId: "user-1" },
    { type: "assistant_message", text: "Starting batch." },
  ];

  it("matches the observed Codex failed-outcome errors and rejects usage limits and fatal errors", () => {
    for (const message of [CAPACITY, DEMAND, "overloaded_error", "429 Too Many Requests"]) assert.equal(isTransientErrorMessage(message), true, message);
    for (const message of ["usage_limit_exceeded", "Your weekly limit reached", "invalid API key", "context length exceeded", ""]) assert.equal(isTransientErrorMessage(message), false, message);
  });

  it("builds a continuation retry from the last user message, even when the turn ended mid-work", () => {
    const value = buildFailedTransientRecord(agent({ status: "error" }), failedTimeline, { message: DEMAND }, config, NOW, "turn-1");
    assert.ok(value);
    assert.equal(value.failedOutcome, true);
    assert.equal(value.expectedUserText, "Process calls until 08:40.");
    assert.equal(value.retryPrompt, "continue");
    assert.equal(Date.parse(value.notBefore) - NOW, 0);
    assert.deepEqual(verifyTransientTimeline(value, failedTimeline, value.lastUserMessageAt), { ok: true });
    assert.deepEqual(verifyTransientTimeline(value, [...failedTimeline, { type: "user_message", text: "New task", messageId: "user-2" }], value.lastUserMessageAt), { ok: false, reason: "newer-user-message" });
    assert.ok(buildFailedTransientRecord(agent(), failedTimeline, { message: "invalid API key" }, config, NOW, "turn-1"), "any failed turn resumes");
    assert.equal(buildFailedTransientRecord(agent(), failedTimeline, { message: "usage_limit_exceeded" }, config, NOW, "turn-1"), null);
    assert.equal(buildFailedTransientRecord(agent(), [], { message: CAPACITY }, config, NOW, "turn-1"), null);
  });

  it("keeps only the ended turn's own rows of a tail read after it ended, and all rows for a turn with none of its own", () => {
    const row = (item: AgentTimelineItem, turnId?: string) => ({ item, ...(turnId ? { turnId } : {}) });
    const own = [row(failedTimeline[0]!, "t1"), row({ type: "assistant_message", text: `[System Error] ${CAPACITY}` }, "t1")];
    const newer = [row({ type: "user_message", text: "New task", messageId: "user-2" }, "t2"), row({ type: "assistant_message", text: "Done." }, "t2")];
    assert.deepEqual(endedTurnRows([...own, ...newer], "t1"), { rows: own, done: true });
    // A heartbeat turn: its prompt is not in the timeline and its error row has no turn ID, so the newest
    // input is the previous turn's. That alone is no newer turn: the rows are taken as they are.
    const heartbeat = [...own, row({ type: "assistant_message", text: "[System Error] usage_limit_exceeded" })];
    assert.deepEqual(endedTurnRows(heartbeat, "t3"), { rows: heartbeat, done: true });
    // No turn ID on the event, or none on the rows (provider history after a restart): the rows as they are.
    for (const [rows, turnId] of [[[...own, ...newer], null], [[row(failedTimeline[0]!), row({ type: "assistant_message", text: "x" })], "t1"]] as const) {
      assert.deepEqual(endedTurnRows(rows, turnId), { rows, done: true });
    }
  });

  it("never exhausts failed-turn records, backing off at the last step", () => {
    let value = buildFailedTransientRecord(agent(), failedTimeline, { message: CAPACITY }, config, NOW, "turn-1")!;
    for (let attempt = 1; attempt <= 6; attempt++) {
      value = afterTransientFailure({ ...value, attempts: [...value.attempts, { at: value.createdAt, messageId: `retry-${attempt}`, result: "sent" }] }, `failed: ${CAPACITY}`, "continue", `retry-${attempt}`, agent().lastUserMessageAt!, config, NOW);
      assert.equal(value.state, "parked");
    }
    assert.equal(Date.parse(value.notBefore) - NOW, 1_800_000);
    assert.deepEqual(shouldResume(value, agent({ status: "error" }), config, Date.parse(value.notBefore)), { ok: true });
  });

  it("keeps only the newest failed-turn attempts while counting every attempt for message IDs and backoff", () => {
    let value = buildFailedTransientRecord(agent(), failedTimeline, { message: CAPACITY }, config, NOW, "turn-1")!;
    const total = MAX_KEPT_ATTEMPTS + 10;
    for (let attempt = 1; attempt <= total; attempt++) {
      assert.equal(messageId(value), `${value.recordId}:attempt:${attempt}`);
      value = afterTransientFailure({ ...value, attempts: [...value.attempts, { at: value.createdAt, messageId: messageId(value), result: "sent" }] }, `failed: ${CAPACITY}`, "continue", messageId(value), agent().lastUserMessageAt!, config, NOW);
    }
    assert.equal(value.attempts.length, MAX_KEPT_ATTEMPTS);
    assert.equal(attemptCount(value), total);
    assert.equal(value.attempts.at(-1)?.messageId, `${value.recordId}:attempt:${total}`);
    assert.equal(messageId(value), `${value.recordId}:attempt:${total + 1}`);
    assert.equal(Date.parse(value.notBefore) - NOW, 1_800_000);
  });

  it("allows sending to an errored agent only for failed-outcome records", () => {
    const failed = buildFailedTransientRecord(agent(), failedTimeline, { message: CAPACITY }, config, NOW, "turn-1")!;
    const due = Date.parse(failed.notBefore);
    assert.deepEqual(shouldResume(failed, agent({ status: "error" }), config, due), { ok: true });
    assert.deepEqual(shouldResume(failed, agent({ status: "error", requiresAttention: true, attentionReason: "error" }), config, due), { ok: true });
    assert.deepEqual(shouldResume(failed, agent({ status: "error", requiresAttention: true, attentionReason: "needs_input" }), config, due), { ok: false, reason: "requires-attention" });
    assert.deepEqual(shouldResume(failed, agent({ requiresAttention: true, attentionReason: "finished" }), config, due), { ok: true });
    assert.deepEqual(shouldResume(failed, agent({ status: "running" }), config, due), { ok: false, reason: "agent-status=running" });
    assert.deepEqual(shouldResume(transient(), agent({ status: "error" }), config, due), { ok: false, reason: "agent-status=error" });
  });
});

describe("record identity", () => {
  it("requires a source turn and stable deduplication identity", () => {
    assert.equal(buildRecord(agent(), "out of credits", undefined, config, NOW, null), null);
    const first = record();
    const second = buildRecord(agent(), "out of credits", undefined, config, NOW, "turn-1");
    assert.equal(first.recordId, second?.recordId);
    assert.notEqual(first.recordId, buildRecord(agent(), "out of credits", undefined, config, NOW, "turn-2")?.recordId);
    assert.equal(first.configFingerprint, configFingerprint(agent()));
  });

  it("requires exact agent, model, mode, cwd, native session, and config fingerprint", () => {
    const value = record();
    assert.equal(isSameAgentAndSession(value, agent()), true);
    assert.equal(isSameAgentAndSession(value, agent({ model: "other" })), false);
    assert.equal(isSameAgentAndSession(value, agent({ currentModeId: "plan" })), false);
    assert.equal(isSameAgentAndSession(value, agent({ persistence: { provider: "claude", sessionId: "other", nativeHandle: "native-1" } })), false);
  });
});

describe("send gates", () => {
  it("blocks opted-out, web, archived, running, permission, attention, and newer-message cases", () => {
    const value = record();
    assert.deepEqual(shouldResume(value, agent({ labels: { noresume: "true" } }), config, Date.parse(value.notBefore)), { ok: false, reason: "opted-out" });
    assert.deepEqual(shouldResume(value, agent({ provider: "chatgpt-web" }), config, Date.parse(value.notBefore)), { ok: false, reason: "opted-out" });
    assert.deepEqual(shouldResume(value, agent({ status: "running" }), config, Date.parse(value.notBefore)), { ok: false, reason: "agent-status=running" });
    assert.deepEqual(shouldResume(value, agent({ pendingPermissions: [{}] }), config, Date.parse(value.notBefore)), { ok: false, reason: "pending-permission" });
    assert.deepEqual(shouldResume(value, agent({ requiresAttention: true }), config, Date.parse(value.notBefore)), { ok: false, reason: "requires-attention" });
    assert.deepEqual(shouldResume(value, agent({ lastUserMessageAt: "2026-09-25T12:00:01.000Z" }), config, Date.parse(value.notBefore)), { ok: false, reason: "newer-user-message" });
  });

  it("allows only a due idle record, whatever its attempt count", () => {
    const value = record();
    assert.deepEqual(shouldResume(value, agent(), config, NOW), { ok: false, reason: "not-due" });
    assert.deepEqual(shouldResume(value, agent(), config, Date.parse(value.notBefore)), { ok: true });
    const third = record({ attempts: [{ at: value.createdAt, messageId: "x", result: "sent" }, { at: value.createdAt, messageId: "y", result: "sent" }, { at: value.createdAt, messageId: "z", result: "sent" }] });
    assert.deepEqual(shouldResume(third, agent(), config, Date.parse(third.notBefore)), { ok: true });
  });
});

describe("post-send verification", () => {
  it("does not mark a send done until a resumed turn is observed", () => {
    const value = record({ state: "verifying", sentAt: new Date(NOW).toISOString(), resumeTurnId: null });
    assert.deepEqual(verificationDecision(value, agent(), NOW), { state: "uncertain", reason: "resume-turn-not-observed" });
  });

  it("tracks the exact resumed turn and marks a completed turn done", () => {
    const sent = record({ state: "verifying", sentAt: new Date(NOW).toISOString(), resumeTurnId: "resume-1", resumeFinishedAt: new Date(NOW + 1000).toISOString() });
    assert.deepEqual(verificationDecision(sent, agent(), NOW + 2000), { state: "done", reason: "resumed-turn-completed" });
    assert.deepEqual(verificationDecision(sent, agent({ activeTurn: { turnId: "resume-1" } }), NOW + 2000), { state: "pending", reason: "resumed-turn-active" });
    assert.deepEqual(verificationDecision(sent, agent({ activeTurn: { turnId: "user-turn" } }), NOW + 2000), { state: "uncertain", reason: "different-active-turn" });
  });

  it("fails closed on a new user message or changed identity", () => {
    const sent = record({ state: "verifying", resumeTurnId: "resume-1", resumeFinishedAt: new Date(NOW + 1000).toISOString() });
    assert.deepEqual(verificationDecision(sent, agent({ lastUserMessageAt: "2026-09-25T12:00:01.000Z" }), NOW + 2000), { state: "superseded", reason: "newer-user-message" });
    assert.deepEqual(verificationDecision(sent, agent({ model: "other" }), NOW + 2000), { state: "superseded", reason: "identity-changed" });
  });
});

describe("continuation identity", () => {
  it("does not replay the original prompt and creates a stable per-attempt id", () => {
    const value = record();
    const prompt = continuationPrompt(value);
    assert.match(prompt, /Continue the existing task/);
    assert.match(prompt, /Do not repeat completed side effects/);
    assert.equal(messageId(value), `${value.recordId}:attempt:1`);
    assert.equal(messageId({ ...value, attempts: [...value.attempts, { at: new Date(NOW).toISOString(), messageId: "x", result: "sent" }] }), `${value.recordId}:attempt:2`);
  });

  it("requires a persistence session before creating a record", () => {
    assert.equal(buildRecord(agent({ persistence: null }), "out of credits", undefined, config, NOW, "turn-1"), null);
  });
});

describe("Pi stock daemon session identity", () => {
  for (const thinking of ["high", "medium"]) {
    it(`retains Pi model and ${thinking} thinking across a failed-turn resume`, () => {
      const pi = agent({provider:"pi", model:"route/example-model", currentModeId:null,
        thinkingOptionId:thinking, persistence:{provider:"pi",sessionId:"pi-session",nativeHandle:"pi-session.jsonl"}});
      const failed = buildFailedTransientRecord(pi, timeline(""), {message:"provider temporarily unavailable"}, config, NOW, "pi-turn")!;
      assert.ok(failed);
      assert.deepEqual(shouldResume(failed, {...pi,status:"error"}, config, Date.parse(failed.notBefore)), {ok:true});
      assert.equal(isSameAgentAndSession(failed, {...pi,thinkingOptionId:thinking === "high" ? "medium" : "high"}), false);
      assert.equal(isSameAgentAndSession(failed, {...pi,persistence:{provider:"pi",sessionId:"replacement",nativeHandle:"other"}}), false);
      const sent = {...failed,state:"verifying" as const,resumeTurnId:"resume-pi",resumeFinishedAt:new Date(NOW+1000).toISOString(),verificationDeadlineAt:new Date(NOW+10000).toISOString()};
      assert.deepEqual(verificationDecision(sent,pi,NOW+2000),{state:"done",reason:"resumed-turn-completed"});
      const usage = buildRecord(pi,"insufficient_quota",undefined,config,NOW,"pi-usage")!;
      assert.ok(usage);assert.equal(usage.provider,"pi");assert.equal(usage.thinkingOptionId,thinking);
      assert.deepEqual(shouldResume(usage,pi,config,Date.parse(usage.notBefore)),{ok:true});
    });
  }
});

// Fixture pq documents (schemaVersion 1) shaped like Paceline's output; accounts are anonymous.
const SEC = (ms: number) => Math.floor(ms / 1000);
const H = 3600_000;
type Win = { id: string; leftPct: number; resetInMs: number | null; fresh?: boolean; state?: string };
const win = ({ id, leftPct, resetInMs, fresh = true, state = "live" }: Win) => ({
  id, name: id, state, fresh, usedPct: 100 - leftPct, leftPct, resetAt: resetInMs === null ? null : SEC(NOW + resetInMs), resetInSeconds: resetInMs === null ? null : SEC(resetInMs),
});
const account = (provider: string, windows: Win[], fresh = true) => ({ provider, plan: "Max", label: "fixture", state: fresh ? "live" : "stale", fresh, windows: windows.map(win) });
const pq = (accounts: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, snapshotStale: false, pools: [], accounts, ...extra });
const quotaSettings = { resetBufferSeconds: 60, maxDelaySeconds: 604800 };
const usageSettings = { ...quotaSettings, messageBufferSeconds: 30 };

describe("quota-aware timing", () => {
  it("maps an agent to the pool OPC reads for its provider and model", () => {
    assert.equal(agentPool("claude", "claude-opus-5-5[1m]"), "claude");
    assert.equal(agentPool("pi", "fleet/claude-fable-5-1"), "claude");
    assert.equal(agentPool("codex", "gpt-6.1-sol"), "codex");
    assert.equal(agentPool("pi", "fleet/gpt-6-luna"), "codex");
    assert.equal(agentPool("pi", "fleet/chatgpt-web/pro"), null);
    assert.equal(agentPool("pi", "local/qwen3.8-flash"), null);
  });

  it("schedules a usage resume a minute after the pool's earliest real reset instead of five hours", () => {
    const usage = record();
    // One account out on its 5h window (frees in 2h), one out on 5h and weekly (frees only at the weekly reset).
    const doc = pq([
      account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 2 * H }, { id: "seven_day", leftPct: 40, resetInMs: 90 * H }]),
      account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 1 * H }, { id: "seven_day", leftPct: 0, resetInMs: 30 * H }]),
      account("codex", [{ id: "seven_day", leftPct: 0, resetInMs: 0.5 * H }]),
    ]);
    const next = scheduleUsage(usage, poolQuota(doc, "claude", NOW), usageSettings, NOW);
    assert.equal(next.notBefore, new Date(SEC(NOW + 2 * H) * 1000 + 60_000).toISOString());
    assert.equal(next.quotaHold?.reason.startsWith("quota-blocked pool=claude window=five_hour"), true);
    // The other pool's earlier reset never applies.
    assert.notEqual(next.notBefore, scheduleUsage(usage, poolQuota(doc, "codex", NOW), usageSettings, NOW).notBefore);
    // With another account still holding quota, the resume still waits for the reset that frees the out account.
    const partly = pq([account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 3 * H }]), account("claude", [{ id: "five_hour", leftPct: 50, resetInMs: 4 * H }, { id: "seven_day", leftPct: 50, resetInMs: 50 * H }])]);
    const scheduled = scheduleUsage(usage, poolQuota(partly, "claude", NOW), usageSettings, NOW);
    assert.equal(scheduled.notBefore, new Date(SEC(NOW + 3 * H) * 1000 + 60_000).toISOString());
    assert.equal(scheduled.quotaHold, undefined);
    // But an out account that frees only at its weekly reset never pushes the resume past the flat delay while another has quota.
    const weeklyOne = pq([account("claude", [{ id: "seven_day", leftPct: 0, resetInMs: 20 * H }], false), account("claude", [{ id: "five_hour", leftPct: 50, resetInMs: 4 * H }, { id: "seven_day", leftPct: 50, resetInMs: 50 * H }])]);
    assert.equal(scheduleUsage(usage, poolQuota(weeklyOne, "claude", NOW), usageSettings, NOW).notBefore, usage.notBefore);
    // A pool with no out account keeps the flat delay.
    const fresh = pq([account("claude", [{ id: "five_hour", leftPct: 50, resetInMs: 4 * H }])]);
    assert.equal(scheduleUsage(usage, poolQuota(fresh, "claude", NOW), usageSettings, NOW).notBefore, usage.notBefore);
  });

  it("lets transient and other failures retry as today while some account has quota, and holds when the pool is out", () => {
    const failed = buildFailedTransientRecord(agent({ status: "error" }), timeline(""), { message: "provider temporarily unavailable" }, config, NOW, "turn-f")!;
    const some = pq([
      account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 2 * H }]),
      account("claude", [{ id: "five_hour", leftPct: 12, resetInMs: 2 * H }, { id: "seven_day", leftPct: 30, resetInMs: 40 * H }]),
    ]);
    assert.deepEqual(quotaDecision(failed, poolQuota(some, "claude", NOW), quotaSettings, NOW), { hold: null, changed: false });
    const out = pq([
      account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 2 * H }, { id: "seven_day", leftPct: 30, resetInMs: 40 * H }]),
      account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 3 * H }]),
    ]);
    const held = quotaDecision(failed, poolQuota(out, "claude", NOW), quotaSettings, NOW);
    assert.equal(held.hold?.until, new Date(SEC(NOW + 2 * H) * 1000 + 60_000).toISOString());
    assert.equal(held.changed, true);
    // The same hold is not written or logged again; once the reset passes the pool reads as unknown and sends resume.
    assert.equal(quotaDecision({ ...failed, quotaHold: held.hold }, poolQuota(out, "claude", NOW), quotaSettings, NOW).changed, false);
    const later = NOW + 2 * H + 61_000;
    assert.equal(quotaDecision(failed, poolQuota(out, "claude", later), quotaSettings, later).hold, null);
    // An account whose reading is neither out nor fresh with quota keeps the pool from reading as out.
    const unsure = pq([account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 2 * H }]), account("claude", [{ id: "five_hour", leftPct: 80, resetInMs: 2 * H }], false)]);
    assert.equal(quotaDecision(failed, poolQuota(unsure, "claude", NOW), quotaSettings, NOW).hold, null);
  });

  it("holds until the weekly reset with a visible quota-blocked reason when the pool is out for the week", () => {
    const transientRecord = transient();
    // A stale account still reads as out while its blocking weekly window has not reset.
    const weekly = pq([
      account("claude", [{ id: "five_hour", leftPct: 100, resetInMs: null, state: "parked" }, { id: "seven_day", leftPct: 0, resetInMs: 20 * H, fresh: false, state: "blocking" }], false),
      account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 1 * H }, { id: "seven_day", leftPct: 0, resetInMs: 60 * H }]),
    ]);
    const quota = poolQuota(weekly, "claude", NOW);
    assert.equal(quota.status === "known" && quota.weekly, true);
    const { hold } = quotaDecision(transientRecord, quota, quotaSettings, NOW);
    assert.equal(hold?.until, new Date(SEC(NOW + 20 * H) * 1000 + 60_000).toISOString());
    assert.match(hold!.reason, /^quota-blocked pool=claude weekly accounts=2 until=/);
    assert.equal(scheduleUsage(record(), quota, usageSettings, NOW).quotaHold?.reason, hold!.reason);
  });

  it("keeps today's behaviour when pq is missing, errors, or returns an unknown schema", () => {
    const usage = record();
    const failed = buildFailedTransientRecord(agent({ status: "error" }), timeline(""), { message: "provider temporarily unavailable" }, config, NOW, "turn-f")!;
    const outAccounts = [account("claude", [{ id: "five_hour", leftPct: 0, resetInMs: 2 * H }])];
    for (const doc of [pq(outAccounts, { schemaVersion: 2 }), pq(outAccounts, { snapshotStale: true }), pq(outAccounts, { accounts: "none" }), "not json", null, pq([])]) {
      const quota = poolQuota(doc, "claude", NOW);
      assert.equal(quota.status, "unknown");
      assert.deepEqual(scheduleUsage(usage, quota, usageSettings, NOW), usage);
      assert.equal(quotaDecision(failed, quota, quotaSettings, NOW).hold, null);
    }
    assert.equal(poolQuota(pq(outAccounts), null, NOW).status, "unknown");
  });

  it("bounds pq: a missing binary or a slow one reads as unavailable", async () => {
    const missing = await runPq([path.join(tmpdir(), "no-such-pq-fixture"), "--json"], 5000);
    assert.ok("error" in missing && /pq unavailable/.test(missing.error));
    const slow = await runPq([process.execPath, "-e", "setTimeout(() => {}, 20000)"], 300);
    assert.deepEqual(slow, { error: "pq gave no answer in 0.3s" });
    const ok = await runPq([process.execPath, "-e", "process.stdout.write(JSON.stringify({ schemaVersion: 1 }))"], 10000);
    assert.deepEqual(ok, { document: { schemaVersion: 1 } });
  });

  it("caches one pq reading so many failing agents start one pq process", async () => {
    let clock = NOW, runs = 0;
    const reader = new QuotaReader(async (): Promise<PqResult> => { runs++; return { document: pq([]) }; }, () => clock);
    const options = { ttlMs: 60_000, timeoutMs: 5000, bufferMs: 60_000 };
    await Promise.all(Array.from({ length: 10 }, () => reader.pool("claude", options)));
    clock += 59_000;
    await reader.pool("codex", options);
    assert.equal(runs, 1);
    clock += 2_000;
    await reader.pool("claude", options);
    assert.equal(runs, 2);
    const failing = new QuotaReader(async (): Promise<PqResult> => { runs++; throw new Error("boom"); }, () => clock);
    assert.deepEqual(await failing.pool("claude", options), { status: "unknown", pool: "claude", reason: "pq failed (boom)" });
    assert.equal((await failing.pool("claude", options)).status, "unknown");
    assert.equal(runs, 3);
  });
});

// Pace mode's off-pace rule on fixture pq documents. 84 hours to the weekly reset puts the even spend at 50%.
describe("pace mode rule", () => {
  const weekly = (label: string, usedPct: number, resetHours: number, extra: unknown[] = []) => ({ provider: "claude", label, fresh: true,
    windows: [{ id: "seven_day", fresh: true, usedPct, leftPct: 100 - usedPct, resetInSeconds: resetHours * 3600 }, ...extra] });
  const doc = (accounts: unknown[]) => ({ schemaVersion: 1, snapshotStale: false, accounts });

  it("is off pace when the pool gap is below -5, and on pace at -5", () => {
    // ((50 - 60) + (50 - 52)) / 2 = -6.
    assert.equal(paceOf(doc([weekly("a", 60, 84), weekly("b", 52, 84)]), ["a", "b"]).state, "off");
    assert.equal(paceOf(doc([weekly("a", 55, 84), weekly("b", 55, 84)]), ["a", "b"]).state, "on");
    // Hours to the reset clamp to the week: 200 hours is a fresh week, so a 6% use is behind.
    assert.equal(paceOf(doc([weekly("a", 6, 200)]), ["a"]).state, "off");
  });

  it("is off pace when a listed account has a five-hour window at 0% left before its reset, even ahead of pace", () => {
    assert.equal(paceOf(doc([weekly("a", 10, 84)]), ["a"]).state, "on");
    assert.equal(paceOf(doc([weekly("a", 10, 84, [{ id: "five_hour", fresh: true, usedPct: 100, leftPct: 0, resetAt: Math.floor(Date.now() / 1000) + 600, resetInSeconds: 600 }])]), ["a"]).state, "off");
    // Once its reset has passed, a window at 0% no longer counts as out.
    assert.equal(paceOf(doc([weekly("a", 10, 84, [{ id: "five_hour", fresh: true, usedPct: 100, leftPct: 0, resetAt: Math.floor(Date.now() / 1000) - 60, resetInSeconds: 0 }])]), ["a"]).state, "on");
  });

  it("leaves a listed account with no fresh weekly reading out of the sum and the divisor; none at all is undecided", () => {
    // A lone fresh account trips at more than 5 points over: 50 - 56 = -6 is off pace, 50 - 55 = -5 on pace.
    assert.equal(paceOf(doc([weekly("a", 56, 84)]), ["a"]).state, "off");
    assert.equal(paceOf(doc([weekly("a", 55, 84)]), ["a"]).state, "on");
    // b listed but missing, or with a stale weekly reading: a alone still decides (-6, off pace).
    assert.equal(paceOf(doc([weekly("a", 56, 84)]), ["a", "b"]).state, "off");
    assert.equal(paceOf(doc([weekly("a", 56, 84), { provider: "claude", label: "b", fresh: true, windows: [{ id: "seven_day", fresh: false, usedPct: 0, resetInSeconds: 3600 }] }]), ["a", "b"]).state, "off");
    assert.equal(paceOf(doc([]), ["a"]).state, "undecided");
    assert.equal(paceOf(doc([{ ...weekly("a", 58, 84), provider: "codex" }]), ["a"]).state, "undecided");
    assert.equal(paceOf(doc([{ provider: "claude", label: "a", fresh: true, windows: [{ id: "seven_day", fresh: false, usedPct: 58, resetInSeconds: 3600 }] }]), ["a"]).state, "undecided");
  });

  it("is undecided on an empty list, a stale snapshot or another schema", () => {
    assert.equal(paceOf(doc([weekly("a", 58, 84)]), []).state, "undecided");
    assert.equal(paceOf({ ...doc([weekly("a", 58, 84)]), snapshotStale: true }, ["a"]).state, "undecided");
    assert.equal(paceOf({ ...doc([weekly("a", 58, 84)]), schemaVersion: 2 }, ["a"]).state, "undecided");
    assert.equal(paceOf(null, ["a"]).state, "undecided");
  });
});

describe("remote pace transport", () => {
  const weekly = (label: string, usedPct: number, resetHours: number, extra: unknown[] = []) => ({
    provider: "claude",
    label,
    fresh: true,
    windows: [{ id: "seven_day", fresh: true, usedPct, leftPct: 100 - usedPct, resetInSeconds: resetHours * 3600 }, ...extra],
  });
  const doc = (accounts: unknown[], snapshotStale = false) => ({ schemaVersion: 1, snapshotStale, accounts });

  it("produces and validates tri-state verdicts via explicit ULR settings file and QuotaReader.pace with no quota/account leakage", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ulr-pace-read-"));
    try {
      const cfgPath = path.join(home, "settings", "auto-resume-config.json");
      await mkdir(path.dirname(cfgPath), { recursive: true });
      if (process.platform !== "win32") await chmod(path.dirname(cfgPath), 0o755);
      const writeCfg = async (values: Record<string, unknown>) => {
        await writeFile(cfgPath, JSON.stringify({ version: SETTINGS_VERSION, values }), "utf8");
        if (process.platform !== "win32") await chmod(cfgPath, 0o644);
      };
      await writeCfg({ quotaAware: true, pacePoolAccounts: ["acct-secret-1", "acct-secret-2"] });

      let currentDoc: unknown = doc([weekly("acct-secret-1", 30, 84), weekly("acct-secret-2", 30, 84)]);
      const reader = new QuotaReader(async () => ({ document: currentDoc }), () => NOW);

      const onPayload = await readLocalHostPace({ settingsFile: cfgPath, quota: reader, clock: () => NOW });
      assert.deepEqual(Object.keys(onPayload).sort(), ["asOf", "reason", "schemaVersion", "state"]);
      assert.deepEqual(onPayload, { schemaVersion: 1, state: "on", reason: "on-pace", asOf: new Date(NOW).toISOString() });
      const onWire = JSON.stringify(onPayload);
      assert.doesNotMatch(onWire, /acct-secret|usedPct|leftPct|reset|accounts/);
      assert.deepEqual(parseRemotePace(onWire, NOW + 5_000, 120_000).pace, { state: "on", reason: "on-pace" });

      currentDoc = doc([weekly("acct-secret-1", 80, 84), weekly("acct-secret-2", 70, 84)]);
      const offPayload = await readLocalHostPace({ settingsFile: cfgPath, quota: reader, clock: () => NOW });
      assert.deepEqual(offPayload, { schemaVersion: 1, state: "off", reason: "behind-pace", asOf: new Date(NOW).toISOString() });
      assert.deepEqual(parseRemotePace(JSON.stringify(offPayload), NOW + 5_000, 120_000).pace, { state: "off", reason: "behind-pace" });

      currentDoc = doc([weekly("acct-secret-1", 10, 84, [{ id: "five_hour", fresh: true, usedPct: 100, leftPct: 0, resetAt: Math.floor(NOW / 1000) + 600, resetInSeconds: 600 }]), weekly("acct-secret-2", 10, 84)]);
      const outPayload = await readLocalHostPace({ settingsFile: cfgPath, quota: reader, clock: () => NOW });
      assert.deepEqual(outPayload, { schemaVersion: 1, state: "off", reason: "account-out", asOf: new Date(NOW).toISOString() });
      assert.deepEqual(parseRemotePace(JSON.stringify(outPayload), NOW, 120_000).pace, { state: "off", reason: "account-out" });

      currentDoc = doc([weekly("acct-secret-1", 80, 84)], true);
      const stalePayload = await readLocalHostPace({ settingsFile: cfgPath, quota: reader, clock: () => NOW });
      assert.deepEqual(stalePayload, { schemaVersion: 1, state: "undecided", reason: "pq-stale", asOf: new Date(NOW).toISOString() });
      assert.deepEqual(parseRemotePace(JSON.stringify(stalePayload), NOW, 120_000).pace, { state: "undecided", reason: "pq-stale" });

      await writeCfg({ quotaAware: false, pacePoolAccounts: ["acct-secret-1"] });
      assert.deepEqual(await readLocalHostPace({ settingsFile: cfgPath, quota: reader, clock: () => NOW }), { schemaVersion: 1, state: "undecided", reason: "quotaAware-off", asOf: new Date(NOW).toISOString() });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails closed on missing, timed-out, stale, or invalid remote pace inputs", async () => {
    const emptyHome = await mkdtemp(path.join(tmpdir(), "ulr-pace-missing-"));
    try {
      let pqCalls = 0;
      const spyReader = new QuotaReader(async () => {
        pqCalls++;
        return { document: doc([weekly("acct-a", 80, 84)]) };
      }, () => NOW);
      const cfgDir = path.join(emptyHome, "settings");
      const cfgPath = path.join(cfgDir, "auto-resume-config.json");
      const invalidExpect = { schemaVersion: 1, state: "undecided", reason: "config-invalid", asOf: new Date(NOW).toISOString() };
      // Missing path, relative path, wrong filename, or missing file all fail closed without calling pq.
      for (const badPath of [undefined, "", "auto-resume-config.json", path.join(cfgDir, "other.json"), cfgPath]) {
        assert.deepEqual(await readLocalHostPace({ settingsFile: badPath, quota: spyReader, clock: () => NOW }), invalidExpect);
        assert.equal(pqCalls, 0);
      }
      await mkdir(cfgDir, { recursive: true });
      // Oversized file fails closed before parsing.
      await writeFile(cfgPath, " ".repeat(70_000), "utf8");
      assert.deepEqual(await readLocalHostPace({ settingsFile: cfgPath, quota: spyReader, clock: () => NOW }), invalidExpect);
      assert.equal(pqCalls, 0);
      // Remote-configured host refuses to chain-hop as a producer, and full ConfigSchema rejects invalid unrelated
      // settings (such as paceFallback as a string), unknown keys, or out-of-range fields without calling pq.
      for (const badValues of [
        { paceRemoteHost: "peer-host", paceRemoteCommand: ["node", "~/plugins/usage-limit-auto-resume/dist/pace-read.mjs", cfgPath] },
        { quotaAware: true, pacePoolAccounts: ["acct-a"], paceFallback: "true" },
        { quotaAware: true, pacePoolAccounts: ["acct-a"], baseDelaySeconds: 1 },
        { quotaAware: true, pacePoolAccounts: ["acct-a"], unknownSetting: true },
      ]) {
        await writeFile(cfgPath, JSON.stringify({ version: SETTINGS_VERSION, values: badValues }), "utf8");
        assert.deepEqual(await readLocalHostPace({ settingsFile: cfgPath, quota: spyReader, clock: () => NOW }), invalidExpect);
        assert.equal(pqCalls, 0);
      }
      // Valid fixture with unrelated settings passes full ConfigSchema and reuses the same QuotaReader.
      await writeFile(cfgPath, JSON.stringify({ version: SETTINGS_VERSION, values: { armed: true, paceFallback: true, quotaAware: true, pacePoolAccounts: ["acct-a"] } }), "utf8");
      if (process.platform !== "win32") {
        // Symlinked file, symlinked parent dir, group-writable file/parent, and world-writable file all fail closed without calling pq.
        await chmod(cfgDir, 0o755);
        await chmod(cfgPath, 0o644);
        const linkFileDir = path.join(emptyHome, "link-file");
        await mkdir(linkFileDir, { recursive: true });
        const linkFile = path.join(linkFileDir, "auto-resume-config.json");
        await symlink(cfgPath, linkFile);
        assert.deepEqual(await readLocalHostPace({ settingsFile: linkFile, quota: spyReader, clock: () => NOW }), invalidExpect);
        const linkDir = path.join(emptyHome, "link-dir");
        await symlink(cfgDir, linkDir);
        assert.deepEqual(await readLocalHostPace({ settingsFile: path.join(linkDir, "auto-resume-config.json"), quota: spyReader, clock: () => NOW }), invalidExpect);
        await chmod(cfgPath, 0o664);
        assert.deepEqual(await readLocalHostPace({ settingsFile: cfgPath, quota: spyReader, clock: () => NOW }), invalidExpect);
        await chmod(cfgPath, 0o644);
        await chmod(cfgDir, 0o775);
        assert.deepEqual(await readLocalHostPace({ settingsFile: cfgPath, quota: spyReader, clock: () => NOW }), invalidExpect);
        await chmod(cfgDir, 0o755);
        await chmod(cfgPath, 0o666);
        assert.deepEqual(await readLocalHostPace({ settingsFile: cfgPath, quota: spyReader, clock: () => NOW }), invalidExpect);
        await chmod(cfgPath, 0o644);
        assert.equal(pqCalls, 0);
      }
      assert.deepEqual(await readLocalHostPace({ settingsFile: cfgPath, quota: spyReader, clock: () => NOW }), { schemaVersion: 1, state: "off", reason: "behind-pace", asOf: new Date(NOW).toISOString() });
      assert.equal(pqCalls, 1);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }

    // Stale, future, blank-line-padded, duplicate-key (including conflicts and escapes), extra-key, bad-schema,
    // bad-reason, multiline, and oversized payloads all fail closed.
    const validLine = JSON.stringify(formatRemotePace({ state: "on", reason: "on-pace" }, NOW));
    assert.equal(parseRemotePace(validLine, NOW, 120_000).pace.state, "on");
    assert.equal(parseRemotePace(`${validLine}\n`, NOW, 120_000).pace.state, "on");
    assert.equal(parseRemotePace(`${validLine}\r\n`, NOW, 120_000).pace.state, "on");
    const stale = JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, NOW - 121_000));
    assert.deepEqual(parseRemotePace(stale, NOW, 120_000).pace, { state: "undecided", reason: "remote-stale" });
    const future = JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, NOW + 60_000));
    assert.deepEqual(parseRemotePace(future, NOW, 120_000).pace, { state: "undecided", reason: "remote-invalid" });
    const iso = new Date(NOW).toISOString();
    for (const bad of [
      "",
      "\n",
      `\n${validLine}\n`,
      `${validLine}\n\n`,
      ` ${validLine}\n`,
      `${validLine} \n`,
      "not json",
      `{"schemaVersion":1,"state":"on","state":"off","reason":"behind-pace","asOf":"${iso}"}`,
      `{"schemaVersion":1,"state":"off","state":"off","reason":"behind-pace","asOf":"${iso}"}`,
      `{"schemaVersion":1,"state":"on","\\u0073tate":"off","reason":"behind-pace","asOf":"${iso}"}`,
      `{"schemaVersion":1,"state":"off","reason":"account-out","reason":"behind-pace","asOf":"${iso}"}`,
      JSON.stringify({ schemaVersion: 1, state: "off", reason: "behind-pace", asOf: iso, accounts: [] }),
      JSON.stringify({ schemaVersion: 2, state: "off", reason: "behind-pace", asOf: iso }),
      JSON.stringify({ schemaVersion: 1, state: "unknown", reason: "pq-stale", asOf: iso }),
      JSON.stringify({ schemaVersion: 1, state: "off", reason: "on-pace", asOf: iso }),
      JSON.stringify({ schemaVersion: 1, state: "off", reason: "acct-secret", asOf: iso }),
      JSON.stringify({ schemaVersion: 1, state: "off", reason: "behind-pace", asOf: "2026-02-30T00:00:00Z" }),
      `${validLine}\nextra-line`,
      "x".repeat(5000),
    ]) {
      assert.deepEqual(parseRemotePace(bad, NOW, 120_000).pace, { state: "undecided", reason: "remote-invalid" }, bad.slice(0, 80));
    }

    // SSH argv enforces BatchMode, StrictHostKeyChecking=yes, ControlMaster=no, ControlPath=none, no forwarding/TTY, --, and safe ~/ quoting.
    const argv = remotePaceSshArgv("peer-host", ["node", "~/plugins/usage-limit-auto-resume/dist/pace-read.mjs", "/Users/fixture/settings/auto-resume-config.json"], 10_000);
    for (const opt of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ControlMaster=no", "ControlPath=none", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no", "RequestTTY=no"]) {
      assert.ok(argv.includes(opt), `missing ssh option ${opt}`);
    }
    assert.deepEqual(argv.slice(-3), ["--", "peer-host", "'node' ~/'plugins/usage-limit-auto-resume/dist/pace-read.mjs' '/Users/fixture/settings/auto-resume-config.json'"]);

    // Bundled producer artifact (dist/pace-read.mjs) is built and runs with absolute Node in an installed bare-env
    // layout with no node_modules: requires one explicit absolute settings file path, rejects missing/extra/unsafe
    // args and wrong-type unrelated settings (paceFallback string) without invoking pq or leaking file contents, and
    // reads valid host settings via QuotaReader.
    const builtProducer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "pace-read.mjs");
    await access(builtProducer);
    const installed = await mkdtemp(path.join(tmpdir(), "ulr-bare-installed-"));
    try {
      const dstDist = path.join(installed, "plugin", "dist");
      const dstProducer = path.join(dstDist, "pace-read.mjs");
      await mkdir(dstDist, { recursive: true });
      await copyFile(builtProducer, dstProducer);
      await assert.rejects(() => access(path.join(installed, "plugin", "node_modules")));
      const bareHome = path.join(installed, "home");
      const bareCfg = path.join(bareHome, "private-settings", "auto-resume-config.json");
      await mkdir(path.dirname(bareCfg), { recursive: true });
      if (process.platform !== "win32") await chmod(path.dirname(bareCfg), 0o755);
      await mkdir(path.join(bareHome, ".local", "bin"), { recursive: true });
      const pqCalledMarker = path.join(installed, "pq-called");
      const fakePq = path.join(bareHome, ".local", "bin", process.platform === "win32" ? "pq.mjs" : "pq");
      const pqBody = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pqCalledMarker)}, "1");\nprocess.stdout.write(JSON.stringify({schemaVersion:1,snapshotStale:false,accounts:[{provider:"claude",label:"acct-a",fresh:true,windows:[{id:"seven_day",fresh:true,usedPct:80,leftPct:20,resetInSeconds:84*3600}]}]}));\n`;
      await writeFile(fakePq, process.platform === "win32" ? pqBody : `#!${process.execPath}\n${pqBody}`, { mode: 0o755 });
      if (process.platform === "win32") {
        const routingPath = path.join(bareHome, ".config", "opc", "routing.json");
        await mkdir(path.dirname(routingPath), { recursive: true });
        await writeFile(routingPath, JSON.stringify({ pq: [process.execPath, fakePq] }), "utf8");
      }
      const bareEnv: NodeJS.ProcessEnv = process.platform === "win32"
        ? { HOME: bareHome, USERPROFILE: bareHome, PATH: process.env.PATH ?? "", ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) }
        : { HOME: bareHome, PATH: "/usr/bin:/bin" };

      // Regression: known unrelated setting of wrong type (paceFallback string) returns undecided/config-invalid, never calls pq, never leaks file contents.
      await writeFile(bareCfg, JSON.stringify({ version: SETTINGS_VERSION, values: { paceFallback: "secret-sentinel", quotaAware: true, pacePoolAccounts: ["acct-a"] } }), "utf8");
      const invalidRun = await promisify(execFile)(process.execPath, [dstProducer, bareCfg], { env: bareEnv, timeout: 10_000 });
      assert.equal(invalidRun.stderr, "");
      assert.doesNotMatch(invalidRun.stdout, /secret-sentinel|acct-a|private-settings/);
      assert.deepEqual(parseRemotePace(invalidRun.stdout, Date.now(), 120_000).pace, { state: "undecided", reason: "config-invalid" });
      await assert.rejects(() => access(pqCalledMarker), "quota subprocess must not run on invalid settings");

      // Missing arg, extra arg, and relative arg all fail closed without calling pq.
      for (const badArgs of [[dstProducer], [dstProducer, bareCfg, "extra"], [dstProducer, "auto-resume-config.json"]]) {
        const badRun = await promisify(execFile)(process.execPath, badArgs, { env: bareEnv, timeout: 10_000 });
        assert.equal(badRun.stderr, "");
        assert.deepEqual(parseRemotePace(badRun.stdout, Date.now(), 120_000).pace, { state: "undecided", reason: "config-invalid" });
        await assert.rejects(() => access(pqCalledMarker));
      }

      // Valid settings with explicit absolute path reject group-writable file/parent without calling pq, then pass on 0644 file / 0755 parent.
      await writeFile(bareCfg, JSON.stringify({ version: SETTINGS_VERSION, values: { paceFallback: true, quotaAware: true, pacePoolAccounts: ["acct-a"] } }), "utf8");
      if (process.platform !== "win32") {
        await chmod(bareCfg, 0o664);
        const groupFileRun = await promisify(execFile)(process.execPath, [dstProducer, bareCfg], { env: bareEnv, timeout: 10_000 });
        assert.equal(groupFileRun.stderr, "");
        assert.deepEqual(parseRemotePace(groupFileRun.stdout, Date.now(), 120_000).pace, { state: "undecided", reason: "config-invalid" });
        await chmod(bareCfg, 0o644);
        await chmod(path.dirname(bareCfg), 0o775);
        const groupDirRun = await promisify(execFile)(process.execPath, [dstProducer, bareCfg], { env: bareEnv, timeout: 10_000 });
        assert.equal(groupDirRun.stderr, "");
        assert.deepEqual(parseRemotePace(groupDirRun.stdout, Date.now(), 120_000).pace, { state: "undecided", reason: "config-invalid" });
        await assert.rejects(() => access(pqCalledMarker), "quota subprocess must not run on group-writable settings or parent");
        await chmod(path.dirname(bareCfg), 0o755);
      }
      const validRun = await promisify(execFile)(process.execPath, [dstProducer, bareCfg], { env: bareEnv, timeout: 10_000 });
      assert.equal(validRun.stderr, "");
      assert.deepEqual(parseRemotePace(validRun.stdout, Date.now(), 120_000).pace, { state: "off", reason: "behind-pace" });
      await access(pqCalledMarker);
    } finally {
      await rm(installed, { recursive: true, force: true });
    }

    // Missing ssh binary, timeout, non-zero exit, and oversized stdout all fail closed.
    assert.deepEqual(await runRemotePaceSsh("peer-host", ["echo"], 5000, path.join(tmpdir(), "no-such-ssh-fixture")), { error: "remote-unavailable" });
    // Directly executing a shebang fixture requires POSIX. Keep the parser and guard checks on all hosts.
    if (process.platform !== "win32") {
      const fakeDir = await mkdtemp(path.join(tmpdir(), "ulr-fake-ssh-"));
      try {
        const mkScript = async (name: string, body: string) => {
          const script = path.join(fakeDir, name);
          await writeFile(script, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
          return script;
        };
        const slow = await mkScript("slow-ssh", "setTimeout(() => {}, 20000);");
        assert.deepEqual(await runRemotePaceSsh("peer-host", ["cmd"], 250, slow), { error: "remote-timeout" });
        const failExit = await mkScript("fail-ssh", `process.stdout.write(${JSON.stringify(JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, NOW)))}); process.exit(1);`);
        assert.deepEqual(await runRemotePaceSsh("peer-host", ["cmd"], 5000, failExit), { error: "remote-unavailable" });
        const bigOut = await mkScript("big-ssh", "process.stdout.write('a'.repeat(5000));");
        assert.deepEqual(await runRemotePaceSsh("peer-host", ["cmd"], 5000, bigOut), { error: "remote-invalid" });
        const ok = await mkScript("ok-ssh", `process.stdout.write(${JSON.stringify(JSON.stringify(formatRemotePace({ state: "on", reason: "on-pace" }, NOW)) + "\n")});`);
        const got = await runRemotePaceSsh("peer-host", ["cmd"], 5000, ok);
        assert.ok("stdout" in got && parseRemotePace(got.stdout, NOW, 120_000).pace.state === "on");
      } finally {
        await rm(fakeDir, { recursive: true, force: true });
      }
    }

    // RemotePaceReader caches within TTL, skips cache when fresh (ttlMs=0), and fails closed when the runner throws.
    let clock = NOW, calls = 0;
    const reader = new RemotePaceReader(async (): Promise<RemotePaceRunResult> => {
      calls++;
      if (calls === 2) throw new Error("ssh boom");
      return { stdout: `${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, clock))}\n` };
    }, () => clock);
    assert.equal((await reader.read("peer", ["node", "pace-read.ts"], { ttlMs: 60_000, timeoutMs: 5000, maxAgeMs: 120_000 })).state, "off");
    clock += 30_000;
    assert.equal((await reader.read("peer", ["node", "pace-read.ts"], { ttlMs: 60_000, timeoutMs: 5000, maxAgeMs: 120_000 })).state, "off");
    assert.equal(calls, 1);
    assert.deepEqual(await reader.read("peer", ["node", "pace-read.ts"], { ttlMs: 0, timeoutMs: 5000, maxAgeMs: 120_000 }), { state: "undecided", reason: "remote-unavailable" });
    assert.equal(calls, 2);
  });
});

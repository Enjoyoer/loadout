import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_KEPT_ATTEMPTS, afterTransientFailure, attemptCount, buildFailedTransientRecord, buildRecord, buildTransientRecord, isTransientErrorMessage, configFingerprint, continuationPrompt, failureSignature, isSameAgentAndSession, isTransientAssistantText, isUsageLimitAssistantText, messageId, shouldResume, transientDelaySeconds, transientRejectionState, turnText, verificationDecision, verifyTransientTimeline, type AgentSnapshot, type ResumeConfig } from "../server/model.ts";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const config: ResumeConfig = {
  maxAttempts: 3,
  transientMaxAttempts: 3,
  transientBackoffSeconds: [0, 120, 300, 900],
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
  it("parks formatted Pi errors for five hours then resumes error status with an attempt cap", () => {
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
      assert.deepEqual(shouldResume({ ...usage, attempts: Array(3).fill({ at: "", messageId: "", result: "sent" }) }, pi, config, NOW + 18000 * 1000), { ok: false, reason: "max-attempts" });
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
  });

  it("retries immediately, then after 2, 5, and 15 minutes and caps attempts independently of the five-hour path", () => {
    const value = transient();
    assert.equal(Date.parse(value.notBefore) - NOW, 0);
    assert.deepEqual([0, 1, 2, 3, 4].map((attempts) => transientDelaySeconds(config, attempts)), [0, 120, 300, 900, 900]);
    assert.equal(value.retryPrompt, "Fix the bug exactly.");
    assert.equal(buildRecord(agent(), "usage_limit_exceeded", undefined, config, NOW, "turn-1")?.notBefore, new Date(NOW + 18_000_000).toISOString());
    const exhausted = { ...value, state: "parked" as const, attempts: [1, 2, 3].map((n) => ({ at: value.createdAt, messageId: `retry-${n}`, result: "sent" as const })) };
    assert.deepEqual(shouldResume(exhausted, agent(), config, Date.parse(value.notBefore)), { ok: false, reason: "max-attempts" });
  });

  it("uses continuation wording when the last user text is empty", () => {
    const value = buildTransientRecord(agent(), timeline(RATE_LIMIT, ""), config, NOW, "turn-1");
    assert.match(value?.retryPrompt ?? "", /Continue the last user request/);
  });

  it("reschedules failed retry turns at 2, 5, then 15 minutes, then exhausts", () => {
    let value = transient();
    const sentAt = new Date(NOW + 120_000).toISOString();
    for (const [attempt, delay] of [[1, 120], [2, 300], [3, 900]] as const) {
      value = afterTransientFailure({ ...value, attempts: [...value.attempts, { at: sentAt, messageId: `retry-${attempt}`, result: "sent" }] }, RATE_LIMIT, "Fix the bug exactly.", `retry-${attempt}`, sentAt, config, NOW + attempt * 120_000);
      assert.equal(Date.parse(value.notBefore) - (NOW + attempt * 120_000), delay * 1000);
      assert.equal(value.state, attempt === 3 ? "exhausted" : "parked");
    }
  });

  it("rejects changed timeline, newer user messages, permissions, and changed session", () => {
    const value = transient({ state: "parked" });
    assert.deepEqual(verifyTransientTimeline(value, timeline(RATE_LIMIT)), { ok: true });
    assert.deepEqual(verifyTransientTimeline(value, timeline(RATE_LIMIT, "Different request")), { ok: false, reason: "newer-user-message" });
    assert.deepEqual(verifyTransientTimeline(value, timeline("API Error: 529 overloaded")), { ok: false, reason: "failure-text-changed" });
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
    assert.deepEqual(verifyTransientTimeline(value, failedTimeline), { ok: true });
    assert.deepEqual(verifyTransientTimeline(value, [...failedTimeline, { type: "user_message", text: "New task", messageId: "user-2" }]), { ok: false, reason: "newer-user-message" });
    assert.ok(buildFailedTransientRecord(agent(), failedTimeline, { message: "invalid API key" }, config, NOW, "turn-1"), "any failed turn resumes");
    assert.equal(buildFailedTransientRecord(agent(), failedTimeline, { message: "usage_limit_exceeded" }, config, NOW, "turn-1"), null);
    assert.equal(buildFailedTransientRecord(agent(), [], { message: CAPACITY }, config, NOW, "turn-1"), null);
  });

  it("never exhausts failed-turn records, backing off at the last step", () => {
    let value = buildFailedTransientRecord(agent(), failedTimeline, { message: CAPACITY }, config, NOW, "turn-1")!;
    for (let attempt = 1; attempt <= 6; attempt++) {
      value = afterTransientFailure({ ...value, attempts: [...value.attempts, { at: value.createdAt, messageId: `retry-${attempt}`, result: "sent" }] }, `failed: ${CAPACITY}`, "continue", `retry-${attempt}`, agent().lastUserMessageAt!, config, NOW);
      assert.equal(value.state, "parked");
    }
    assert.equal(Date.parse(value.notBefore) - NOW, 900_000);
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
    assert.equal(Date.parse(value.notBefore) - NOW, 900_000);
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

  it("allows only a due idle record and caps attempts", () => {
    const value = record();
    assert.deepEqual(shouldResume(value, agent(), config, NOW), { ok: false, reason: "not-due" });
    assert.deepEqual(shouldResume(value, agent(), config, Date.parse(value.notBefore)), { ok: true });
    const exhausted = record({ attempts: [{ at: value.createdAt, messageId: "x", result: "sent" }, { at: value.createdAt, messageId: "y", result: "sent" }, { at: value.createdAt, messageId: "z", result: "sent" }] });
    assert.deepEqual(shouldResume(exhausted, agent(), config, Date.parse(exhausted.notBefore)), { ok: false, reason: "max-attempts" });
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

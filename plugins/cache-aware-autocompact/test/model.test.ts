import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { guardDecision, providerDelayMinutes, safeBoundary, strictnessTier, type AgentSnapshot } from "../server/model.ts";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const config = defaultConfig();
const answer: AgentTimelineItem = { type: "assistant_message", text: "Implemented and verified the change." };
const timeline: AgentTimelineItem[] = [answer];

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "a1", provider: "claude", cwd: "/repo", workspaceId: "w1", model: "model",
    features: [], thinkingOptionId: null, effectiveThinkingOptionId: null,
    createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:01:00.000Z",
    lastUserMessageAt: "2026-09-26T00:00:00.000Z", status: "idle", activeTurn: null,
    capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: true, supportsMcpServers: true, supportsReasoningStream: true, supportsToolInvocations: true },
    currentModeId: null, availableModes: [], pendingPermissions: [], persistence: null,
    runtimeInfo: undefined, lastUsage: { contextWindowUsedTokens: 200_000 }, lastError: undefined,
    title: null, labels: {}, requiresAttention: false, attentionReason: null, attentionTimestamp: null,
    archivedAt: null, providerUnavailable: false, ...overrides,
  };
}

describe("provider delays", () => {
  it("uses cache-aware defaults and skips other providers", () => {
    assert.equal(providerDelayMinutes("claude", config), 50);
    assert.equal(providerDelayMinutes("codex", config), 22);
    assert.equal(providerDelayMinutes("opencode", config), null);
    assert.equal(config.thresholdTokens, 100_000);
  });
});

describe("safe boundary classifier", () => {
  it("requires a final assistant answer and closed work", () => {
    assert.deepEqual(safeBoundary([]), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(safeBoundary([{ type: "todo", items: [{ text: "ship", completed: false }] }]), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(safeBoundary([{ type: "tool_call", callId: "t", name: "x", detail: { type: "plain_text", text: "x" }, status: "running", error: null }]), { ok: false, reason: "running-tool" });
    assert.deepEqual(safeBoundary([{ type: "tool_call", callId: "t", name: "x", detail: { type: "plain_text", text: "x" }, status: "failed", error: "bad" }]), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(safeBoundary([{ type: "user_message", text: "go" }]), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(safeBoundary(timeline), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(safeBoundary([{ type: "assistant_message", text: "I will wait for your answer." }]), { ok: true, reason: "safe-boundary" });
  });
});

describe("all compaction guards", () => {
  const check = (overrides: Partial<AgentSnapshot>, expected: string) => assert.deepEqual(guardDecision(agent(overrides), timeline, config, "2026-09-26T00:00:00.000Z"), { ok: false, reason: expected });
  it("fails closed for provider, busy, archived, permissions, attention, opt-out, message, and context", () => {
    check({ provider: "opencode" }, "provider-opencode");
    check({ status: "running", activeTurn: { turnId: "t", startedAt: null } }, "not-idle");
    check({ archivedAt: "2026-09-26T00:02:00.000Z" }, "archived");
    check({ pendingPermissions: [{ id: "p", provider: "claude", name: "tool", kind: "tool", description: "x" }] }, "pending-permission");
    check({ labels: { autocompact: "off" } }, "opted-out-label");
    check({ lastUserMessageAt: "2026-09-26T00:03:00.000Z" }, "new-user-message");
    check({ lastUsage: { contextWindowUsedTokens: 99_999 } }, "context-below-threshold(99999)");
  });
  it("allows an idle eligible Claude or Codex agent", () => {
    assert.deepEqual(guardDecision(agent(), timeline, config, "2026-09-26T00:00:00.000Z"), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(guardDecision(agent({ provider: "codex" }), timeline, config, "2026-09-26T00:00:00.000Z"), { ok: true, reason: "safe-boundary" });
  });
  it("scales boundary strictness with context size", () => {
    const config = defaultConfig();
    assert.equal(strictnessTier(200_000, config), "safe");
    assert.equal(strictnessTier(300_000, config), "recall");
    const failedTool: AgentTimelineItem[] = [
      { type: "tool_call", callId: "t", name: "x", detail: { type: "plain_text", text: "x" }, status: "failed", error: "bad" },
      { type: "assistant_message", text: "The completed work is ready." },
    ];
    assert.deepEqual(guardDecision(agent({ lastUsage: { contextWindowUsedTokens: 150_000 } }), failedTool, defaultConfig(), "2026-09-26T00:00:00.000Z"), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(guardDecision(agent({ lastUsage: { contextWindowUsedTokens: 60_000 } }), failedTool, defaultConfig(), "2026-09-26T00:00:00.000Z"), { ok: false, reason: "context-below-threshold(60000)" });
    const openEnded: AgentTimelineItem[] = [{ type: "assistant_message", text: "I will wait for your answer." }];
    assert.deepEqual(guardDecision(agent({ lastUsage: { contextWindowUsedTokens: 250_000 } }), openEnded, config, "2026-09-26T00:00:00.000Z"), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(guardDecision(agent({ lastUsage: { contextWindowUsedTokens: 300_000 } }), failedTool, config, "2026-09-26T00:00:00.000Z"), { ok: true, reason: "safe-boundary-recall" });
  });
  it("keeps hard safety guards blocking in recall tier", () => {
    const recall = defaultConfig({ softThreshold: 300_000 });
    const checkRecall = (overrides: Partial<AgentSnapshot>, expected: string) => assert.deepEqual(
      guardDecision(agent({ lastUsage: { contextWindowUsedTokens: 900_000 }, ...overrides }), timeline, recall, "2026-09-26T00:00:00.000Z"),
      { ok: false, reason: expected },
    );
    checkRecall({ status: "running", activeTurn: { turnId: "t", startedAt: null } }, "not-idle");
    checkRecall({ pendingPermissions: [{ id: "p", provider: "claude", name: "tool", kind: "tool", description: "x" }] }, "pending-permission");
    checkRecall({ attentionReason: "permission" }, "requires-attention-permission");
    checkRecall({ labels: { autocompact: "off" } }, "opted-out-label");
    checkRecall({ provider: "opencode" }, "provider-opencode");
    assert.deepEqual(guardDecision(agent({ lastUsage: { contextWindowUsedTokens: 900_000 } }), [{ type: "tool_call", callId: "t", name: "x", detail: { type: "plain_text", text: "x" }, status: "running", error: null }], recall, "2026-09-26T00:00:00.000Z"), { ok: false, reason: "running-tool" });
    assert.deepEqual(guardDecision(agent({ lastUsage: { contextWindowUsedTokens: 900_000 } }), [{ type: "todo", items: [{ text: "ship", completed: false }] }, { type: "assistant_message", text: "Next I'll wait for your answer." }], recall, "2026-09-26T00:00:00.000Z"), { ok: true, reason: "safe-boundary-recall" });
  });
  it("allows finished and null attention reasons", () => {
    const expected = "2026-09-26T00:00:00.000Z";
    assert.deepEqual(guardDecision(agent({ requiresAttention: true, attentionReason: "finished" }), timeline, config, expected), { ok: true, reason: "safe-boundary" });
    assert.deepEqual(guardDecision(agent({ requiresAttention: true, attentionReason: null }), timeline, config, expected), { ok: true, reason: "safe-boundary" });
  });
  it("blocks permission attention, including when a finished flag might otherwise be allowed", () => {
    check({ requiresAttention: true, attentionReason: "permission" }, "requires-attention-permission");
    check({ requiresAttention: true, attentionReason: "finished", pendingPermissions: [{ id: "p", provider: "claude", name: "tool", kind: "tool" }] }, "pending-permission");
  });
  it("blocks unknown attention reasons", () => {
    check({ requiresAttention: true, attentionReason: "unknown" as never }, "requires-attention-unknown(unknown)");
  });
});

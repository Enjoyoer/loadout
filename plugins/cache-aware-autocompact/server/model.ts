import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { AutoCompactConfig } from "./config.ts";

export type AgentSnapshot = AgentSnapshotPayload;
export type Decision = { ok: true; reason: string } | { ok: false; reason: string };
export type StrictnessTier = "safe" | "recall";

export function strictnessTier(contextUsedTokens: number | undefined, config: AutoCompactConfig): StrictnessTier {
  return typeof contextUsedTokens === "number" && contextUsedTokens >= config.softThreshold ? "recall" : "safe";
}

export function providerDelayMinutes(provider: string, config: AutoCompactConfig): number | null {
  if (provider === "claude") return config.claudeDelayMinutes;
  if (provider === "codex") return config.codexDelayMinutes;
  return null;
}

/**
 * The only boundary check is a running tool. Heuristics on the final answer,
 * open todos, or coordination wording are intentionally absent: an idle agent
 * with an ended turn is compactable, and the summary preserves open questions.
 * The tier only labels the decision for logs.
 */
export function safeBoundary(
  timeline: readonly AgentTimelineItem[],
  tier: StrictnessTier = "safe",
): Decision {
  if (timeline.some((item) => item.type === "tool_call" && item.status === "running")) {
    return { ok: false, reason: "running-tool" };
  }
  return { ok: true, reason: tier === "recall" ? "safe-boundary-recall" : "safe-boundary" };
}

export function guardDecision(
  agent: AgentSnapshot,
  timeline: readonly AgentTimelineItem[],
  config: AutoCompactConfig,
  expectedLastUserMessageAt: string | null,
): Decision {
  if (agent.provider !== "claude" && agent.provider !== "codex") return { ok: false, reason: `provider-${agent.provider}` };
  if (agent.status !== "idle" || agent.activeTurn) return { ok: false, reason: "not-idle" };
  if (agent.archivedAt) return { ok: false, reason: "archived" };
  if ((agent.pendingPermissions?.length ?? 0) > 0) return { ok: false, reason: "pending-permission" };
  const attentionReason = agent.attentionReason ?? null;
  if (attentionReason !== null && attentionReason !== "finished" && attentionReason !== "permission" && attentionReason !== "error") {
    return { ok: false, reason: `requires-attention-unknown(${String(attentionReason)})` };
  }
  if (attentionReason === "permission" || attentionReason === "error") {
    return { ok: false, reason: `requires-attention-${attentionReason}` };
  }
  if (agent.labels?.autocompact === "off") return { ok: false, reason: "opted-out-label" };
  if ((agent.lastUserMessageAt ?? null) !== expectedLastUserMessageAt) return { ok: false, reason: "new-user-message" };
  const used = agent.lastUsage?.contextWindowUsedTokens;
  if (typeof used !== "number" || used < config.thresholdTokens) return { ok: false, reason: `context-below-threshold(${used ?? "unknown"})` };
  return safeBoundary(timeline, strictnessTier(used, config));
}

export function checkpointKey(agentId: string, turnId: string | null, timeline: readonly AgentTimelineItem[]): string {
  if (turnId) return `${agentId}:${turnId}`;
  const tail = timeline.slice(-3).map((item) => item.type === "assistant_message" ? item.text : item.type).join("\u0000");
  return `${agentId}:timeline:${tail.slice(-500)}`;
}

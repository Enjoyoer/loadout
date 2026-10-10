import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { AutoCompactConfig } from "./config.ts";

export type AgentSnapshot = AgentSnapshotPayload;
export type Decision = { ok: true; reason: string } | { ok: false; reason: string };
export type StrictnessTier = "safe" | "recall";

export function strictnessTier(contextUsedTokens: number | undefined, config: AutoCompactConfig): StrictnessTier {
  return typeof contextUsedTokens === "number" && contextUsedTokens >= config.softThreshold ? "recall" : "safe";
}

// Pi is a harness, not a cache family. Only known fleet routes are eligible;
// web routes and unknown/missing models deliberately fail closed.
export function cacheFamily(provider: string, model?: string | null): "claude" | "codex" | null {
  if (provider === "claude" || provider === "codex") return provider;
  if (provider === "pi" && model?.startsWith("fleet/claude-")) return "claude";
  if (provider === "pi" && model?.startsWith("fleet/gpt-")) return "codex";
  return null;
}

/** Reference cache lifetime, shared by recovery and every pre-send evaluation. */
export function cacheExpired(provider: string, model: string | null | undefined, endedAt: string, now: number): boolean {
  const family = cacheFamily(provider, model);
  const ttlMs = family === "claude" ? 60 * 60_000 : family === "codex" ? 30 * 60_000 : null;
  const ended = Date.parse(endedAt);
  // An unreadable end time counts as expired, never as warm.
  return ttlMs !== null && (!Number.isFinite(ended) || now - ended >= ttlMs);
}

/** Cache expiry as a terminal skip. With extendIdleCompaction, a cold Claude-family agent still compacts once. */
export function cacheExpiredSkip(provider: string, model: string | null | undefined, endedAt: string, now: number, config: AutoCompactConfig): boolean {
  if (config.extendIdleCompaction && cacheFamily(provider, model) === "claude") return false;
  return cacheExpired(provider, model, endedAt, now);
}

export function providerDelayMinutes(provider: string, config: AutoCompactConfig, model?: string | null): number | null {
  if (provider === "pi" && cacheFamily(provider, model) === "codex" && !config.piGptEnabled) return null;
  const family = cacheFamily(provider, model);
  if (family === "claude") return config.claudeDelayMinutes;
  if (family === "codex") return config.codexDelayMinutes;
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

/**
 * The turn's timeline with each running tool call replaced by the same call from fresh
 * history, so a tool that has settled since the turn ended no longer blocks. A call that
 * fresh history does not include keeps its recorded status.
 */
export function withFreshToolState(timeline: readonly AgentTimelineItem[], fresh: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const latest = new Map<string, AgentTimelineItem>();
  for (const item of fresh) if (item.type === "tool_call") latest.set(item.callId, item);
  return timeline.map((item) => item.type === "tool_call" && item.status === "running" ? latest.get(item.callId) ?? item : item);
}

export function guardDecision(
  agent: AgentSnapshot,
  timeline: readonly AgentTimelineItem[],
  config: AutoCompactConfig,
  expectedLastUserMessageAt: string | null,
): Decision {
  if (!cacheFamily(agent.provider, agent.model)) return { ok: false, reason: agent.provider === "pi" ? "unsupported-pi-model" : `provider-${agent.provider}` };
  if (providerDelayMinutes(agent.provider, config, agent.model) === null) return { ok: false, reason: "pi-gpt-disabled" };
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
  if (typeof used !== "number") return { ok: false, reason: "context-unknown" };
  if (used < config.thresholdTokens) return { ok: false, reason: `context-below-threshold(${used})` };
  return safeBoundary(timeline, strictnessTier(used, config));
}

export function checkpointKey(agentId: string, turnId: string | null, timeline: readonly AgentTimelineItem[]): string {
  if (turnId) return `${agentId}:${turnId}`;
  const tail = timeline.slice(-3).map((item) => item.type === "assistant_message" ? item.text : item.type).join("\u0000");
  return `${agentId}:timeline:${tail.slice(-500)}`;
}

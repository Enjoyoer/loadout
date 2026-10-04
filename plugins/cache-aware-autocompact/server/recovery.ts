import { lstat } from "node:fs/promises";
import type { PaseoAgent, PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { FetchAgentTimelinePayload } from "@getpaseo/client/internal/daemon-client";
import type { AutoCompactConfig } from "./config.ts";
import { cacheFamily, checkpointKey, providerDelayMinutes } from "./model.ts";
import type { Checkpoint } from "./runtime.ts";

// Expired timers are spread over a small window, independently per agent.
export const REARM_JITTER_MIN_MS = 2_000;
export const REARM_JITTER_MAX_MS = 7_000;
// The cache windows underlying the plugin's default provider delays.
const CACHE_TTL_MS: Record<string, number> = { claude: 60 * 60_000, codex: 30 * 60_000 };

export function recoveryDelay(provider: string, endedAt: string, config: AutoCompactConfig, now: number, random = Math.random, model?: string | null) {
  const configuredMs = (providerDelayMinutes(provider, config, model) ?? 0) * 60_000;
  const elapsedMs = Math.max(0, now - Date.parse(endedAt));
  const remainingMs = Math.max(0, configuredMs - elapsedMs);
  const jitterApplied = remainingMs === 0 || elapsedMs >= (CACHE_TTL_MS[cacheFamily(provider, model) ?? ""] ?? 0);
  const delayMs = jitterApplied
    ? REARM_JITTER_MIN_MS + Math.floor(Math.min(1, Math.max(0, random())) * (REARM_JITTER_MAX_MS - REARM_JITTER_MIN_MS))
    : remainingMs;
  return { delayMs, remainingMs, jitterApplied };
}

export function rearmSkipReason(agent: PaseoAgent): string | null {
  if (!cacheFamily(agent.provider, agent.model)) return agent.provider === "pi" ? "unsupported-pi-model" : "unsupported-provider";
  if (agent.status !== "idle" || agent.activeTurn) return "not-idle";
  if (agent.archivedAt) return "archived";
  if (agent.labels?.autocompact === "off") return "opted-out-label";
  return null;
}

export async function recoveryCwdMissing(agent: PaseoAgent): Promise<boolean> {
  try {
    await lstat(agent.cwd);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
}

export function recoverTurn(agent: PaseoAgent, history: FetchAgentTimelinePayload, remembered: Checkpoint | null): Checkpoint | null {
  const tail = history.entries.at(-1);
  if (!tail) return remembered?.lastUserMessageAt === (agent.lastUserMessageAt ?? null) ? remembered : null;
  if (remembered && remembered.lastUserMessageAt === (agent.lastUserMessageAt ?? null) &&
    (!tail.turnId || !remembered.turnId || tail.turnId === remembered.turnId) &&
    Date.parse(tail.timestamp) <= Date.parse(remembered.endedAt)) {
    return remembered;
  }
  // Provider-native history after a daemon restart can omit daemon turn IDs.
  // The plugin's own durable turn retains the original identity and exact end time.
  if (tail.item.type === "compaction" && tail.item.status === "completed") return null;
  const turnId = tail.turnId ?? null;
  let entries = history.entries;
  if (turnId) entries = entries.filter((entry) => entry.turnId === turnId);
  else {
    const userIndex = entries.findLastIndex((entry) => entry.item.type === "user_message");
    if (userIndex >= 0) entries = entries.slice(userIndex);
  }
  // 0.9.2 has no lastTurnEndedAt field. For pre-upgrade turns, use finished
  // attention time, or the last persisted turn item if attention was cleared.
  const endedAt = agent.attentionReason === "finished" && agent.attentionTimestamp
    ? agent.attentionTimestamp : tail.timestamp;
  if (!Number.isFinite(Date.parse(endedAt)) ||
    Date.parse(endedAt) < Date.parse(agent.lastUserMessageAt ?? "1970-01-01T00:00:00Z")) return null;
  const timeline = entries.map((entry) => entry.item);
  return { agentId: agent.id, turnId, key: checkpointKey(agent.id, turnId, timeline), timeline,
    lastUserMessageAt: agent.lastUserMessageAt ?? null, retryCount: 0, endedAt };
}

/** Fetch the whole latest turn, so a running tool cannot be hidden by a tail page. */
export async function recoveryHistory(timeline: PaseoAgentTimelineHandle): Promise<FetchAgentTimelinePayload | null> {
  const history = await timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
  if (history.error || history.gap || history.staleCursor) return null;
  const turnId = history.entries.at(-1)?.turnId;
  let page = history;
  const cursors = new Set<string>();
  while (page.hasOlder && history.entries.length > 0 &&
    !history.entries.some((entry) => entry.item.type === "user_message" || (turnId && entry.turnId !== turnId))) {
    if (!page.startCursor) return null;
    const cursor = JSON.stringify(page.startCursor);
    if (cursors.has(cursor)) return null;
    cursors.add(cursor);
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 200, projection: "canonical" });
    if (page.error || page.gap || page.staleCursor || page.epoch !== history.epoch) return null;
    if (page.entries.length === 0 && page.hasOlder) return null;
    history.entries = [...page.entries, ...history.entries];
  }
  return history;
}

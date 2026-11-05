import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { formatAge, keptWorktreeLines, matchProjectPms, type OwnerKeys, type OwnerResolution } from "./cleanup.ts";
import { isPmAgent } from "./evaluate.ts";
import type { AgentView, Decision } from "./types.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";
import { paseoHome } from "./vendor/daemon-target.ts";
import { isAbsent } from "./vendor/fs-probe.ts";

// Stale sweep (setting staleSweep, full sweeps only). It flags to their PM:
//
// 1. live agents that are not PMs (no role=pm label, no standalone "PM" in the title), idle at least
//    staleAgentMinutes;
// 2. worktree workspaces, and workspaces under a disposable root (Paseo's worktrees, fleet-scratch), with no live
//    agent, idle at least staleWorkspaceMinutes.
//
// One message per PM, at most one per FLAG_INTERVAL_MS, each item listed at most once per FLAG_INTERVAL_MS; workspace
// cleanup's kept-worktree report goes into the same message, so this daemon sends a PM at most one a day. Items whose PM
// or project opted in (staleArchivePms, staleArchiveProjects) are archived instead when armed and every gate passes.
// Pinned workspaces, `noarchive` labels, staleExclude entries and PMs are never flagged or archived, and an agent owed a
// usage-limit-auto-resume resume is never archived. Only this daemon's agents and workspaces are swept; peer daemons are
// only asked for the PM, as in workspace cleanup.

/** An item is listed again, and a PM messaged again, only this long after the last time: daily, with room for timer drift. */
export const FLAG_INTERVAL_MS = 23 * 60 * 60_000;

/** At most this many items go into one PM's message; the rest wait for its next one. */
export const MAX_FLAG_ITEMS = 50;

/** How far up `paseo.parent-agent-id` / `parent` links the PM is looked for, on this daemon and on a peer. */
export const MAX_PARENT_HOPS = 8;

export interface StaleItem {
  kind: "agent" | "workspace";
  id: string;
  name: string;
  /** Agent: its workspace name and id; workspace: its directory. */
  where: string;
  /** Agent: its status; workspace: its kind. */
  status: string;
  branch: string | null;
  lastActivityAt: number;
  keys: OwnerKeys;
  /** Lower-cased project names, for staleArchiveProjects. */
  projects: string[];
  /** Why it may not be archived, or null when every gate passed. Set before an opt-in archive is considered. */
  blocked: string | null;
}

export const itemKey = (item: Pick<StaleItem, "kind" | "id">) => `${item.kind}:${item.id}`;
export const pmKey = (host: string | null, agentId: string) => `pm:${host ?? "local"}:${agentId}`;

const nonEmpty = (value: string | null | undefined): string | null => (value && value.trim() ? value.trim() : null);

/** A label as written on a workspace (`key`, `key=value` or `key:value`) or in an entry, as [lower-cased key, value]. */
function splitLabel(label: string): [string, string | null] {
  const at = label.search(/[=:]/);
  return at < 0 ? [label.trim().toLowerCase(), null] : [label.slice(0, at).trim().toLowerCase(), label.slice(at + 1).trim()];
}

export type LabelPairs = Array<[string, string | null]>;

export function agentLabelPairs(agent: AgentView): LabelPairs {
  return Object.entries(agent.labels ?? {}).map(([key, value]) => [key.trim().toLowerCase(), String(value).trim()]);
}

export function workspaceLabelPairs(labels: readonly string[] | undefined): LabelPairs {
  return (labels ?? []).map(splitLabel);
}

/** staleExclude: an entry matches an id exactly, a label key (any value), or `key=value` (value case-insensitive). */
export function exclusionMatch(entries: readonly string[], ids: readonly string[], labels: LabelPairs): string | null {
  for (const entry of entries) {
    if (ids.includes(entry)) return entry;
    const [key, value] = splitLabel(entry);
    const hit = labels.some(([labelKey, labelValue]) => labelKey === key && (value === null || (labelValue ?? "").toLowerCase() === value.toLowerCase()));
    if (hit) return entry;
  }
  return null;
}

export const hasNoArchive = (labels: LabelPairs) => labels.some(([key]) => key === "noarchive");

function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** An agent's latest activity: creation, update, last user message, attention, and newest delivered message (receipts). */
export function agentLastActivity(agent: AgentView, deliveries: ReadonlyMap<string, number> | null): number | null {
  const values = [parse(agent.createdAt), parse(agent.updatedAt), parse(agent.lastUserMessageAt), parse(agent.attentionTimestamp), deliveries?.get(agent.id) ?? null];
  let latest: number | null = null;
  for (const value of values) if (value !== null && (latest === null || value > latest)) latest = value;
  return latest;
}

/** What names an agent's PM: its own parent labels and project label, and its workspace's project name. */
export function agentOwnerKeys(agent: AgentView, workspaceProject: string | null | undefined): OwnerKeys {
  const parentId = nonEmpty(agent.labels?.["paseo.parent-agent-id"]);
  const names = [nonEmpty(agent.labels?.project), nonEmpty(workspaceProject)].filter((name): name is string => name !== null);
  return { parentId, parent: parentId ?? nonEmpty(agent.labels?.parent), names: [...new Set(names)] };
}

/** The live agent with this id, else the one live agent whose id starts with it. */
export function findLive(live: readonly AgentView[], id: string): AgentView | null {
  const exact = live.find((agent) => agent.id === id);
  if (exact) return exact;
  const byPrefix = live.filter((agent) => agent.id.startsWith(id));
  return byPrefix.length === 1 ? byPrefix[0]! : null;
}

/**
 * The PM that owns a stale item on this daemon: up the parent labels (`paseo.parent-agent-id`, else `parent`) through
 * live agents to the first PM; else the one live role=pm agent of the project. When none is found here, `peerKeys`
 * carries the first parent that is not live here (a full id) and the project names, for the peer lookup.
 */
export function resolveStalePm(keys: OwnerKeys, live: readonly AgentView[]): { owner: OwnerResolution; peerKeys: OwnerKeys } {
  const names = [...keys.names];
  let parent = keys.parent;
  let parentId = keys.parentId;
  const seen = new Set<string>();
  for (let hop = 0; parent && hop < MAX_PARENT_HOPS; hop += 1) {
    const agent = findLive(live, parent);
    if (!agent || seen.has(agent.id)) break;
    seen.add(agent.id);
    if (isPmAgent(agent)) return { owner: { kind: "agent", agentId: agent.id, via: "parent" }, peerKeys: keys };
    const project = nonEmpty(agent.labels?.project);
    if (project && !names.includes(project)) names.push(project);
    parentId = nonEmpty(agent.labels?.["paseo.parent-agent-id"]);
    parent = parentId ?? nonEmpty(agent.labels?.parent);
  }
  const peerKeys: OwnerKeys = { parentId, parent, names };
  if (names.length === 0) return { owner: { kind: "none", detail: "no PM up the parent labels and no project name" }, peerKeys };
  const pms = matchProjectPms(live, names);
  if (pms.length === 1) return { owner: { kind: "agent", agentId: pms[0]!.id, via: "project-pm" }, peerKeys };
  if (pms.length > 1) return { owner: { kind: "several", agentIds: pms.map((agent) => agent.id) }, peerKeys };
  const lower = [...new Set(names.map((name) => name.toLowerCase()))].join("|");
  return { owner: { kind: "none", detail: `no PM up the parent labels and no live role=pm agent for project ${lower}` }, peerKeys };
}

/** One PM's daily message: workspace cleanup's kept worktrees (each reported once), then the stale items. */
export function formatFlagMessage(
  items: readonly StaleItem[],
  config: { staleAgentMinutes: number; staleWorkspaceMinutes: number; staleExclude: readonly string[] },
  now: number,
  kept: ReadonlyArray<{ decision: Decision; directory: string }> = [],
): string {
  const agents = items.filter((item) => item.kind === "agent");
  const workspaces = items.filter((item) => item.kind === "workspace");
  const total = items.length + kept.length;
  const count = total === 1 ? "1 item you own needs" : `${total} items you own need`;
  const lines = [
    `[merged-worker-archiver] Daily report: ${count} a look. Close what is done (heartbeats and check-backs, then the agent, then its workspaces), or ask the owner to keep it with a staleExclude entry${config.staleExclude.length > 0 ? ` (now: ${config.staleExclude.join(", ")})` : ""}. Nothing listed here was archived. This daemon sends you at most one such message a day and lists each item at most once a day.`,
  ];
  if (kept.length > 0) {
    lines.push(
      "",
      `Worktrees with no agents and no activity for at least ${formatAge(config.staleWorkspaceMinutes * 60_000)}, kept because the branch is not merged into its base or the tree is not clean (each reported once):`,
      ...keptWorktreeLines(kept, now),
    );
  }
  let index = kept.length;
  const line = (item: StaleItem, detail: string) => {
    index += 1;
    lines.push(`${index}. ${item.name} (${item.id}), ${detail}, idle ${formatAge(now - item.lastActivityAt)}${item.blocked ? `; not archivable now: ${item.blocked}` : ""}`);
  };
  if (agents.length > 0) {
    lines.push("", `Agents idle at least ${formatAge(config.staleAgentMinutes * 60_000)}:`);
    for (const item of agents) line(item, `${item.status}, in ${item.where}`);
  }
  if (workspaces.length > 0) {
    lines.push("", `Workspaces with no live agent, idle at least ${formatAge(config.staleWorkspaceMinutes * 60_000)}:`);
    for (const item of workspaces) line(item, `${item.status} ${item.where}${item.branch ? `, branch ${item.branch}` : ""}`);
  }
  return lines.join("\n");
}

export interface FlagEntry {
  at: string;
  /** sent; unconfirmed (may have arrived); sending (stopped mid-send); unrouted (logged, no PM). None is resent within the interval. */
  status: "sending" | "sent" | "unconfirmed" | "unrouted";
  /** The PM messaged; absent for unrouted. */
  owner?: string;
  /** The peer daemon the PM lives on; absent on this daemon. */
  host?: string;
}

const FLAG_STATUSES = new Set(["sending", "sent", "unconfirmed", "unrouted"]);

export interface FlagStateStore {
  read(): Promise<Map<string, FlagEntry>>;
  write(entries: ReadonlyMap<string, FlagEntry>): Promise<void>;
}

/**
 * When each stale item was last listed, and each PM last messaged:
 * <PASEO_HOME>/plugin-state/merged-worker-archiver/stale-flags.json. Only a missing file reads as empty; an unreadable
 * or malformed one throws, and then no flag is sent that sweep. Entries older than two intervals are dropped on write.
 */
export class FlagStore implements FlagStateStore {
  readonly filePath: string;
  private readonly now: () => number;

  constructor(filePath = path.join(paseoHome(), "plugin-state", "merged-worker-archiver", "stale-flags.json"), now: () => number = Date.now) {
    this.filePath = filePath;
    this.now = now;
  }

  async read(): Promise<Map<string, FlagEntry>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isAbsent(error)) return new Map();
      throw new Error(`cannot read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = JSON.parse(raw) as { version?: unknown; entries?: unknown } | null;
    if (!state || state.version !== 1 || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
      throw new Error(`invalid ${this.filePath}`);
    }
    const entries = new Map<string, FlagEntry>();
    for (const [key, value] of Object.entries(state.entries as Record<string, unknown>)) {
      const entry = value as Partial<FlagEntry> | null;
      const valid = entry && typeof entry.at === "string" && typeof entry.status === "string" && FLAG_STATUSES.has(entry.status)
        && (entry.owner === undefined || typeof entry.owner === "string") && (entry.host === undefined || typeof entry.host === "string");
      if (!valid) throw new Error(`invalid entry ${key} in ${this.filePath}`);
      entries.set(key, entry as FlagEntry);
    }
    return entries;
  }

  async write(entries: ReadonlyMap<string, FlagEntry>): Promise<void> {
    const cutoff = this.now() - 2 * FLAG_INTERVAL_MS;
    const kept = [...entries].filter(([, entry]) => (parse(entry.at) ?? Infinity) >= cutoff);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomically(this.filePath, { version: 1, entries: Object.fromEntries(kept) }, { mode: 0o600 });
  }
}

/** usage-limit-auto-resume's plugin id; its resume records live in <PASEO_HOME>/plugin-state/<id>/state.json. */
export const AUTO_RESUME_PLUGIN_ID = "usage-limit-auto-resume";

/** Resume record states that can no longer act. Any other state (detected, parked, resuming, verifying, uncertain, or one unknown here) is owed. */
const SETTLED_RESUME_STATES = new Set(["done", "exhausted", "opted-out", "superseded"]);

export interface ResumeStateReader {
  /** Owed resume record ids per agent id, or null when there is no state file. Throws when it cannot be read or is invalid. */
  read(): Promise<Map<string, string[]> | null>;
}

/**
 * usage-limit-auto-resume's state file, read only. A record that is not settled means a resume is still owed to its agent,
 * possibly days away (a weekly quota hold), and archiving the agent would supersede it: such an agent is never archived.
 */
export class ResumeStateFile implements ResumeStateReader {
  readonly filePath: string;

  constructor(filePath = path.join(paseoHome(), "plugin-state", AUTO_RESUME_PLUGIN_ID, "state.json")) {
    this.filePath = filePath;
  }

  async read(): Promise<Map<string, string[]> | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isAbsent(error)) return null;
      throw new Error(`cannot read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = JSON.parse(raw) as { version?: unknown; records?: unknown } | null;
    if (!state || state.version !== 2 || !Array.isArray(state.records)) throw new Error(`invalid ${this.filePath}`);
    const owed = new Map<string, string[]>();
    state.records.forEach((value: unknown, index: number) => {
      const record = value as { agentId?: unknown; recordId?: unknown; state?: unknown } | null;
      if (!record || typeof record.agentId !== "string" || typeof record.recordId !== "string" || typeof record.state !== "string") {
        throw new Error(`invalid record at index ${index} in ${this.filePath}`);
      }
      if (!SETTLED_RESUME_STATES.has(record.state)) owed.set(record.agentId, [...(owed.get(record.agentId) ?? []), record.recordId]);
    });
    return owed;
  }
}

/** True when `key` was listed to a PM (any status but unrouted, or with `unrouted` only that) within the last interval. */
export function recentlyFlagged(entries: ReadonlyMap<string, FlagEntry>, key: string, now: number, unrouted = false): boolean {
  const entry = entries.get(key);
  if (!entry || (entry.status === "unrouted") !== unrouted) return false;
  const at = parse(entry.at);
  return at !== null && now - at < FLAG_INTERVAL_MS;
}

import { createHash } from "node:crypto";
import { evaluateCleanup, formatAge, formatNotification, headCommit, isCleanupEntry, LAST_TURN_ALLOWANCE_MS, lastActivity, ownerKeys, pmBusyReason, resolveOwner, type NotifiedEntry, type OwnerKeys, type OwnerResolution } from "./cleanup.ts";
import type { ArchiverConfig } from "./config.ts";
import { evaluateWorkspace, isDisposableDirectory, isPmAgent, type EvaluateDeps } from "./evaluate.ts";
import type { NotifyStateStore } from "./notify-store.ts";
import { PeerDirectory, type PeerConnector, type PeerSendOutcome } from "./peers.ts";
import type { DeliveryReader } from "./receipts.ts";
import {
  agentLabelPairs,
  agentLastActivity,
  agentOwnerKeys,
  AUTO_RESUME_PLUGIN_ID,
  exclusionMatch,
  type FlagEntry,
  type FlagStateStore,
  formatFlagMessage,
  hasNoArchive,
  itemKey,
  MAX_FLAG_ITEMS,
  pmKey,
  recentlyFlagged,
  resolveStalePm,
  type ResumeStateReader,
  type StaleItem,
  workspaceLabelPairs,
} from "./stale.ts";
import type { AgentView, CommonDirResolver, Decision, TerminalView, WorkspaceView } from "./types.ts";

// The slice of the Paseo daemon client this plugin uses (see daemon.ts).
interface Page<T> {
  entries: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}
interface PageRequest {
  page?: { limit: number; cursor?: string };
}
export interface ArchiverApi {
  workspaces: {
    list(options?: PageRequest & { filter?: { includeBackground?: boolean } }): Promise<Page<WorkspaceView>>;
    archive(workspaceId: string): Promise<{ archivedAt: string | null; error: string | null }>;
  };
  agents: {
    list(options?: PageRequest & { filter?: { includeBackground?: boolean; includeArchived?: boolean } }): Promise<Page<{ agent: AgentView }>>;
    /** One agent by id, archived included; null when there is none. Read just before a PM report is sent. */
    get?(agentId: string): Promise<AgentView | null>;
    /** Archive one agent (stale sweep, opt-in only). */
    archive?(agentId: string): Promise<unknown>;
  };
  /** Every schedule on the daemon, heartbeats (target type `agent`) included. Stale sweep only. */
  schedules?: {
    list(): Promise<ReadonlyArray<{ id: string; status: string; target: { type: string; agentId?: string } }>>;
  };
  /** The daemon's installed plugins. Stale sweep only: is usage-limit-auto-resume installed? */
  plugins?: {
    list(): Promise<ReadonlyArray<{ id: string }>>;
  };
  projects: {
    list(): Promise<{ projects: ReadonlyArray<{ projectRootPath?: string | null }> }>;
  };
  /** Every live terminal on the daemon. Workspace cleanup only. */
  terminals?: {
    list(): Promise<{ entries: ReadonlyArray<TerminalView> }>;
  };
  /**
   * True when the daemon has background workspaces (Paseo 0.12 and later), which every workspace and
   * agent listing must then ask for; older daemons have none, and the client refuses the filter there.
   */
  supportsBackgroundWorkspaces(): boolean;
  /**
   * Prompt an agent; the daemon keeps a receipt per (agent, messageId) and never delivers one twice.
   * "steer" adds the text to a turn that started meanwhile where the provider can steer.
   */
  sendAgentMessage?(agentId: string, text: string, options: { messageId: string; activeTurnBehavior: "steer" }): Promise<unknown>;
}

export interface ApiLease {
  api: ArchiverApi;
  release(): Promise<void>;
}

export interface SweeperDeps extends EvaluateDeps {
  acquireApi(): Promise<ApiLease>;
  log(line: string): void;
  resolveCommonDir: CommonDirResolver;
  /** Worktrees already reported to their PM (workspace cleanup). */
  notifyStore: NotifyStateStore;
  /** Paseo's message delivery receipts (workspace cleanup). Without one, archive times count instead. */
  deliveries?: DeliveryReader;
  /** Opens sessions to peer daemons, for their PMs (setting peerHosts). Without one, no peer is asked. */
  peerConnector?: PeerConnector;
  /** When stale items were last flagged (setting staleSweep). Without one, the stale sweep does not run. */
  flagStore?: FlagStateStore;
  /** usage-limit-auto-resume's resume records. Without one, no workspace with a live agent and no stale agent is archived. */
  resumeState?: ResumeStateReader;
}

export interface SweepOptions {
  trigger: string;
  /**
   * Event-scoped sweep: evaluate these workspaces plus every worktree in the same
   * project (projectId) or the same repository (git common dir). Omit for a full sweep.
   */
  triggerWorkspaceIds?: ReadonlySet<string>;
  /** When the first coalesced event arrived (ms epoch), for the latency log. */
  eventAt?: number;
  /** Force log-only mode regardless of config.armed: nothing is archived, sent, or written. */
  forceDryRun?: boolean;
}

export interface SweepResult {
  decisions: Decision[];
  archived: string[];
  /** Candidates that passed every gate except "merged": clean, idle, own commits. */
  pendingMerge: string[];
  error: string | null;
}

export function isPendingMerge(decision: Decision): boolean {
  return decision.candidate && decision.action === "skip" && decision.reason.startsWith("not-merged(");
}

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

/**
 * After its Nth consecutive failed archive call a workspace sits out the next
 * 2^(N-1) sweeps that find it eligible (1, 2, 4, then at most 8), so it stops taking
 * cap slots from the candidates behind it. Kept in memory only; it is always retried.
 */
const MAX_BACKOFF_EXPONENT = 3;

interface Backoff {
  failures: number;
  sweeps: number;
  skipsLeft: number;
}

async function listAll<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, label: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    all.push(...result.entries);
    if (!result.pageInfo.hasMore) return all;
    if (!result.pageInfo.nextCursor) throw new Error(`${label} pagination reported more pages without a cursor`);
    cursor = result.pageInfo.nextCursor;
  }
  // An incomplete agent list could hide a running agent: never decide on partial data.
  throw new Error(`${label} exceeded ${MAX_PAGES} pages`);
}

/** At most this many worktrees go into one PM report; the rest wait for the next full sweep. */
const MAX_REPORT_ITEMS = 20;

/**
 * Every project's root path. A missing project API, a failed call, or any project without a root path
 * throws, which aborts the sweep (nothing is archived), like an incomplete agent list.
 */
async function projectRoots(api: ArchiverApi): Promise<string[]> {
  if (typeof api.projects?.list !== "function") throw new Error("project list unavailable");
  const result = await api.projects.list();
  if (!result || !Array.isArray(result.projects)) throw new Error("project list malformed");
  const roots = result.projects.map((project) => project.projectRootPath);
  if (!roots.every((root): root is string => typeof root === "string" && root.length > 0)) throw new Error("project without a root path");
  return roots;
}

interface Snapshot {
  workspaces: WorkspaceView[];
  /** Non-archived agents per workspace. */
  agentsByWorkspace: Map<string, AgentView[]>;
  /** Every non-archived agent on the daemon. */
  liveAgents: AgentView[];
  projectRoots: string[];
  /** What workspace cleanup reads, when asked for; null when it could not be read (see cleanupError). */
  cleanup: CleanupData | null;
  cleanupError: string | null;
  /** Heartbeats and owed auto-resumes, read with the rest; an archive must not end either (see gateArchive). */
  gates: AgentGates;
}

interface CleanupData {
  /** Every agent per workspace, archived included. */
  historyByWorkspace: Map<string, AgentView[]>;
  /** Live terminals per workspace. */
  terminalsByWorkspace: Map<string, number>;
  /** Newest delivered message per agent, or null when the receipts could not be read (see deliveriesError). */
  deliveries: Map<string, number> | null;
  deliveriesError: string | null;
}

/** Where workspace cleanup reads delivery receipts from, and how far back they can matter. */
interface DeliverySource {
  reader: DeliveryReader | undefined;
  sinceMs: number;
}

function group<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/**
 * Live state. Background workspaces and their agents are listed whenever the daemon has them; a
 * client that cannot say whether it does aborts the sweep, as does a failed or incomplete workspace,
 * agent or project list. `withCleanup` also lists every agent with archived ones (a separate, larger
 * listing) and the terminals, which only workspace cleanup reads: if either fails or is incomplete,
 * only cleanup is left out (`cleanup` null), never the worker sweep.
 */
async function snapshot(api: ArchiverApi, withCleanup: DeliverySource | null, resumeState: ResumeStateReader | undefined): Promise<Snapshot> {
  if (typeof api.supportsBackgroundWorkspaces !== "function") throw new Error("daemon client cannot tell whether background workspaces exist");
  const background = api.supportsBackgroundWorkspaces() === true;
  const backgroundFilter = background ? { includeBackground: true } : {};
  const page = (cursor?: string) => ({ page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } });
  const workspaces = await listAll((cursor) => api.workspaces.list({ ...(background ? { filter: backgroundFilter } : {}), ...page(cursor) }), "workspaces");
  const agentEntries = await listAll((cursor) => api.agents.list({ ...(background ? { filter: backgroundFilter } : {}), ...page(cursor) }), "agents");
  const agentsByWorkspace = new Map<string, AgentView[]>();
  const liveAgents: AgentView[] = [];
  for (const { agent } of agentEntries) {
    if (agent.archivedAt) continue;
    liveAgents.push(agent);
    if (agent.workspaceId) group(agentsByWorkspace, agent.workspaceId, agent);
  }
  const roots = await projectRoots(api);
  let cleanup: CleanupData | null = null;
  let cleanupError: string | null = null;
  if (withCleanup) {
    try {
      cleanup = await cleanupData(api, backgroundFilter, page, withCleanup);
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  // Never throws: a schedule list or resume state that cannot be read blocks every archive of an agent instead.
  const gates = await readAgentGates(api, resumeState);
  return { workspaces, agentsByWorkspace, liveAgents, projectRoots: roots, cleanup, cleanupError, gates };
}

async function cleanupData(
  api: ArchiverApi,
  backgroundFilter: { includeBackground?: boolean },
  page: (cursor?: string) => PageRequest,
  source: DeliverySource,
): Promise<CleanupData> {
  const history = await listAll((cursor) => api.agents.list({ filter: { ...backgroundFilter, includeArchived: true }, ...page(cursor) }), "agent history");
  const historyByWorkspace = new Map<string, AgentView[]>();
  for (const { agent } of history) if (agent.workspaceId) group(historyByWorkspace, agent.workspaceId, agent);
  if (typeof api.terminals?.list !== "function") throw new Error("terminal list unavailable");
  const { entries } = await api.terminals.list();
  if (!Array.isArray(entries)) throw new Error("terminal list malformed");
  const terminalsByWorkspace = new Map<string, number>();
  for (const terminal of entries) {
    if (!terminal.workspaceId) throw new Error(`terminal ${terminal.id} has no workspace`);
    terminalsByWorkspace.set(terminal.workspaceId, (terminalsByWorkspace.get(terminal.workspaceId) ?? 0) + 1);
  }
  // Unreadable receipts do not skip cleanup: archive times count instead, which only makes workspaces newer.
  let deliveries: Map<string, number> | null = null;
  let deliveriesError: string | null = null;
  try {
    if (!source.reader) throw new Error("no receipt reader");
    deliveries = await source.reader.newestDeliveries(source.sinceMs);
  } catch (error) {
    deliveriesError = error instanceof Error ? error.message : String(error);
  }
  return { historyByWorkspace, terminalsByWorkspace, deliveries, deliveriesError };
}

export function formatDecision(decision: Decision, action: string, extra: Record<string, unknown> = {}): string {
  return `[merged-worker-archiver] ${JSON.stringify({
    action,
    workspaceId: decision.workspaceId,
    name: decision.workspaceName,
    agentIds: decision.agentIds,
    branch: decision.branch,
    base: decision.base,
    reason: decision.reason,
    ...(decision.cleanup ? { cleanup: decision.cleanup, lastActivityAt: decision.lastActivityAt ?? null } : {}),
    ...extra,
  })}`;
}

/**
 * The worker decision, or for a full sweep the workspace cleanup decision it hands over to. Without
 * cleanup data in the snapshot the worker decision stands. Either way an archive must pass gateArchive.
 */
async function decide(
  workspace: WorkspaceView,
  state: Snapshot,
  config: ArchiverConfig,
  deps: EvaluateDeps,
  cleanup: { notified: ReadonlyMap<string, NotifiedEntry> | null } | null,
): Promise<Decision> {
  const agents = state.agentsByWorkspace.get(workspace.id) ?? [];
  const decision = await evaluateWorkspace(workspace, agents, config, deps, state.projectRoots);
  if (!cleanup || !state.cleanup || !isCleanupEntry(decision)) return gateArchive(decision, agents, state.gates);
  return gateArchive(await evaluateCleanup(workspace, {
    config,
    deps,
    agents,
    history: state.cleanup.historyByWorkspace.get(workspace.id) ?? [],
    terminals: state.cleanup.terminalsByWorkspace.get(workspace.id) ?? 0,
    deliveries: state.cleanup.deliveries,
    notified: cleanup.notified,
  }), agents, state.gates);
}

/**
 * A workspace archive also archives every agent in it, which ends that agent's heartbeats and supersedes a resume
 * usage-limit-auto-resume still owes it. So an archive decision becomes a skip while any of its live agents has an active
 * or paused heartbeat or an unsettled resume record, or while either cannot be read (see agentGateBlock).
 */
function gateArchive(decision: Decision, agents: readonly AgentView[], gates: AgentGates): Decision {
  if (decision.action !== "archive") return decision;
  for (const agent of agents) {
    const block = agentGateBlock(agent, gates);
    if (block) return { ...decision, action: "skip", reason: `${block} on agent ${agent.id.slice(0, 8)}; else archivable: ${decision.reason}` };
  }
  return decision;
}

interface ReportItem {
  decision: Decision;
  directory: string;
  via: string;
}

/** One PM's report: on this daemon (host null) or on a peer. */
interface Recipient {
  host: string | null;
  agentId: string;
  items: ReportItem[];
}

/** How to reach a PM: read its state right before sending, and send. */
interface Channel {
  host: string | null;
  /** Why the PM must not be messaged now, or null when it is quiet. May throw. */
  busy(agentId: string): Promise<string | null>;
  send(agentId: string, text: string, messageId: string): Promise<PeerSendOutcome>;
}

/** Workspace cleanup's kept worktrees, handed to the stale sweep's daily message (staleSweep on). */
interface KeptInput {
  /** Its notify decisions this sweep. */
  candidates: Decision[];
  /** Worktrees already reported, or null when unreadable (then there are no candidates). */
  notified: Map<string, NotifiedEntry> | null;
  /** Workspace cleanup is not armed: log would-notify, report nothing. */
  wouldOnly: boolean;
}

/** A stale item's PM, on this daemon (host null) or a peer; owner null when none or several (detail says which). */
type StaleRoute = { host: string | null; owner: string; via: string; detail?: undefined } | { host: null; owner: null; via: ""; detail: string };

/** One PM's daily message: its stale items and kept worktrees. */
interface StaleGroup {
  host: string | null;
  owner: string;
  items: Array<{ item: StaleItem; via: string }>;
  kept: ReportItem[];
}

function addRecipient(groups: Map<string, Recipient>, host: string | null, agentId: string, item: ReportItem): void {
  const key = `${host ?? ""}\n${agentId}`;
  const recipient = groups.get(key) ?? { host, agentId, items: [] };
  recipient.items.push(item);
  groups.set(key, recipient);
}

/** The daemon refused before delivery, so the report may be sent again later. */
function isRetryableSendError(message: string): boolean {
  return /^Agent not found: /.test(message) || message === "agent messaging unavailable";
}

/** This daemon's PMs: read the PM's state right before sending, then send with "steer" and the caller's messageId. */
function localChannel(api: ArchiverApi): Channel {
  return {
    host: null,
    async busy(agentId) {
      if (typeof api.agents.get !== "function") throw new Error("agent lookup unavailable");
      return pmBusyReason(await api.agents.get(agentId));
    },
    async send(agentId, text, messageId) {
      try {
        if (typeof api.sendAgentMessage !== "function") throw new Error("agent messaging unavailable");
        await api.sendAgentMessage(agentId, text, { messageId, activeTurnBehavior: "steer" });
        return { status: "sent" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: isRetryableSendError(message) ? "retry" : "unconfirmed", why: message };
      }
    },
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function staleLine(action: string, item: StaleItem, now: number, extra: Record<string, unknown> = {}): string {
  return `[merged-worker-archiver] ${JSON.stringify({
    action,
    kind: item.kind,
    id: item.id,
    name: item.name,
    where: item.where,
    status: item.status,
    idle: formatAge(now - item.lastActivityAt),
    lastActivityAt: new Date(item.lastActivityAt).toISOString(),
    ...(item.blocked ? { blocked: item.blocked } : {}),
    ...extra,
  })}`;
}

/** Active or paused heartbeats per agent id (schedules whose target is that agent), or null with the error when unreadable. */
interface Heartbeats {
  byAgent: Map<string, string[]> | null;
  error: string | null;
}

async function readHeartbeats(api: ArchiverApi): Promise<Heartbeats> {
  try {
    if (typeof api.schedules?.list !== "function") throw new Error("schedule list unavailable");
    const byAgent = new Map<string, string[]>();
    for (const schedule of await api.schedules.list()) {
      const agentId = schedule.target?.type === "agent" ? schedule.target.agentId : undefined;
      if (!agentId || (schedule.status !== "active" && schedule.status !== "paused")) continue;
      byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), schedule.id]);
    }
    return { byAgent, error: null };
  } catch (error) {
    return { byAgent: null, error: errorText(error) };
  }
}

/** Owed usage-limit-auto-resume resumes per agent id, or null with the error when that cannot be known. */
interface ResumeHolds {
  byAgent: Map<string, string[]> | null;
  error: string | null;
}

/**
 * The resume records of usage-limit-auto-resume. An unreadable or invalid state file is unknown. A missing one means no
 * records only while that plugin is not installed; installed (or when the plugin list cannot be read) it is unknown too.
 */
async function readResumeHolds(api: ArchiverApi, reader: ResumeStateReader | undefined): Promise<ResumeHolds> {
  try {
    if (!reader) throw new Error("no reader");
    const byAgent = await reader.read();
    if (byAgent) return { byAgent, error: null };
  } catch (error) {
    return { byAgent: null, error: `state unreadable: ${errorText(error)}` };
  }
  try {
    if (typeof api.plugins?.list !== "function") throw new Error("plugin list unavailable");
    const installed = (await api.plugins.list()).some((plugin) => plugin.id === AUTO_RESUME_PLUGIN_ID);
    return installed ? { byAgent: null, error: "installed, state file missing" } : { byAgent: new Map(), error: null };
  } catch (error) {
    return { byAgent: null, error: `state file missing, plugin list unreadable: ${errorText(error)}` };
  }
}

/** What an agent archive is checked against besides the agent itself. */
interface AgentGates {
  heartbeats: Heartbeats;
  resume: ResumeHolds;
}

async function readAgentGates(api: ArchiverApi, reader: ResumeStateReader | undefined): Promise<AgentGates> {
  return { heartbeats: await readHeartbeats(api), resume: await readResumeHolds(api, reader) };
}

/**
 * Why the stale sweep leaves an item out entirely, or null: a staleExclude entry (`excluded`), or a pinned workspace or a
 * `noarchive` label (`kept`). An agent is matched with its workspace's id and labels too, a workspace with the labels of
 * every agent it held.
 */
function staleKeepReason(config: ArchiverConfig, ids: readonly string[], labels: ReturnType<typeof agentLabelPairs>, pinned: boolean): { count: "excluded" | "kept"; why: string } | null {
  const entry = exclusionMatch(config.staleExclude, ids, labels);
  if (entry) return { count: "excluded", why: `excluded(${entry})` };
  if (pinned) return { count: "kept", why: "pinned" };
  if (hasNoArchive(labels)) return { count: "kept", why: "noarchive-label" };
  return null;
}

function agentKeepReason(agent: AgentView, workspace: WorkspaceView | undefined, config: ArchiverConfig) {
  const labels = [...agentLabelPairs(agent), ...workspaceLabelPairs(workspace?.labels)];
  return staleKeepReason(config, [agent.id, ...(workspace ? [workspace.id] : [])], labels, Boolean(workspace?.pinnedAt));
}

function workspaceKeepReason(workspace: WorkspaceView, history: readonly AgentView[], config: ArchiverConfig) {
  const labels = [...workspaceLabelPairs(workspace.labels), ...history.flatMap(agentLabelPairs)];
  return staleKeepReason(config, [workspace.id], labels, Boolean(workspace.pinnedAt));
}

/** `child` names `parentId` as its parent: `paseo.parent-agent-id` (full id), else `parent` (an id prefix). */
function isChildOf(child: AgentView, parentId: string): boolean {
  const full = child.labels?.["paseo.parent-agent-id"]?.trim();
  if (full) return full === parentId;
  const prefix = child.labels?.parent?.trim();
  return Boolean(prefix) && parentId.startsWith(prefix!);
}

const ARCHIVABLE_AGENT_STATUSES = new Set(["idle", "closed"]);

/**
 * Why archiving this agent would end something it is still owed, or null: an active or paused heartbeat (a schedule
 * whose target is the agent), or a resume usage-limit-auto-resume has not settled. Unreadable state blocks too.
 */
function agentGateBlock(agent: AgentView, gates: AgentGates): string | null {
  const { byAgent: heartbeats, error: heartbeatError } = gates.heartbeats;
  if (!heartbeats) return `heartbeats-unknown(${heartbeatError ?? "no schedule list"})`;
  const own = heartbeats.get(agent.id);
  if (own && own.length > 0) return `heartbeat(${own.join(",")})`;
  if (!gates.resume.byAgent) return `auto-resume-unknown(${gates.resume.error ?? "no resume state"})`;
  const owed = gates.resume.byAgent.get(agent.id);
  if (owed && owed.length > 0) return `auto-resume(${owed.join(",")})`;
  return null;
}

/** Why a stale agent may not be archived, or null: the worker path's agent gates, nothing that still reports to it, and agentGateBlock. */
function agentArchiveBlock(agent: AgentView, gates: AgentGates, children: number): string | null {
  if (agent.archivedAt) return "already archived";
  if (isPmAgent(agent)) return "pm-agent";
  if (!ARCHIVABLE_AGENT_STATUSES.has(agent.status)) return `agent-status-${agent.status}`;
  if ((agent.pendingPermissions?.length ?? 0) > 0) return "pending-permission";
  if (agent.requiresAttention && agent.attentionReason !== "finished") return `attention-${agent.attentionReason ?? "unknown"}`;
  if (children > 0) return `live-children(${children})`;
  return agentGateBlock(agent, gates);
}

export class Sweeper {
  private running: Promise<SweepResult> | null = null;
  private readonly deps: SweeperDeps;
  private readonly backoffs = new Map<string, Backoff>();
  /** Workspaces an armed sweep deferred at the cap, with the number of the sweep that first deferred them. */
  private readonly waitingSince = new Map<string, number>();
  private sweepCount = 0;

  constructor(deps: SweeperDeps) {
    this.deps = deps;
  }

  private noteArchiveFailure(workspaceId: string): Backoff {
    const failures = (this.backoffs.get(workspaceId)?.failures ?? 0) + 1;
    const sweeps = 2 ** Math.min(failures - 1, MAX_BACKOFF_EXPONENT);
    const backoff = { failures, sweeps, skipsLeft: sweeps };
    this.backoffs.set(workspaceId, backoff);
    return backoff;
  }

  /** Triggers, plus every worktree sharing a trigger's projectId or git common dir. */
  private async scope(workspaces: readonly WorkspaceView[], triggerIds: ReadonlySet<string>): Promise<WorkspaceView[]> {
    const triggers = workspaces.filter((workspace) => triggerIds.has(workspace.id));
    const projectIds = new Set(triggers.map((workspace) => workspace.projectId).filter((id): id is string => Boolean(id)));
    const commonDirs = new Set<string>();
    for (const trigger of triggers) {
      if (!trigger.workspaceDirectory) continue;
      const commonDir = await this.deps.resolveCommonDir(trigger.workspaceDirectory);
      if (commonDir) commonDirs.add(commonDir);
    }
    const selected: WorkspaceView[] = [];
    for (const workspace of workspaces) {
      if (triggerIds.has(workspace.id) || (workspace.projectId && projectIds.has(workspace.projectId))) {
        selected.push(workspace);
        continue;
      }
      if (workspace.workspaceKind !== "worktree" || !workspace.workspaceDirectory || commonDirs.size === 0) continue;
      const commonDir = await this.deps.resolveCommonDir(workspace.workspaceDirectory);
      if (commonDir && commonDirs.has(commonDir)) selected.push(workspace);
    }
    return selected;
  }

  /** Serialized: a sweep requested while one runs waits for it, then runs fresh. */
  async sweep(config: ArchiverConfig, options: SweepOptions): Promise<SweepResult> {
    while (this.running) await this.running.catch(() => undefined);
    const current = this.runSweep(config, options);
    this.running = current;
    try {
      return await current;
    } finally {
      if (this.running === current) this.running = null;
    }
  }

  private async runSweep(config: ArchiverConfig, options: SweepOptions): Promise<SweepResult> {
    const dryRun = options.forceDryRun === true || config.armed !== true;
    // Workspace cleanup runs in full sweeps only and acts only when both switches are on.
    const fullSweep = !options.triggerWorkspaceIds;
    const cleanupDryRun = dryRun || config.armWorkspaceCleanup !== true;
    const log = this.deps.log;
    const sweepNumber = ++this.sweepCount;
    let lease: ApiLease;
    try {
      lease = await this.deps.acquireApi();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[merged-worker-archiver] sweep-aborted trigger=${options.trigger} reason=${JSON.stringify(`daemon-unavailable: ${message}`)}`);
      return { decisions: [], archived: [], pendingMerge: [], error: message };
    }
    const decisions: Decision[] = [];
    const archived: string[] = [];
    try {
      // Receipts older than the stale window plus the last-turn allowance cannot make a workspace recent.
      const deliverySource: DeliverySource = {
        reader: this.deps.deliveries,
        sinceMs: this.deps.now() - config.staleWorkspaceMinutes * 60_000 - LAST_TURN_ALLOWANCE_MS,
      };
      const state = await snapshot(lease.api, fullSweep ? deliverySource : null, this.deps.resumeState);
      // Cleanup data that cannot be read leaves out workspace cleanup only; the worker sweep goes on.
      const cleanupRuns = fullSweep && state.cleanup !== null;
      if (fullSweep && !cleanupRuns) {
        log(`[merged-worker-archiver] cleanup-skipped reason=${JSON.stringify(state.cleanupError)} (worker sweep continues; workspace cleanup waits for the next full sweep)`);
      }
      let notified: Map<string, NotifiedEntry> | null = null;
      if (cleanupRuns) {
        try {
          notified = await this.deps.notifyStore.read();
        } catch (error) {
          log(`[merged-worker-archiver] notify-state-unreadable reason=${JSON.stringify(error instanceof Error ? error.message : String(error))} (no PM report is sent until it is fixed or removed)`);
        }
      }
      const cleanupInput = cleanupRuns ? { notified } : null;
      const inScope = options.triggerWorkspaceIds
        ? await this.scope(state.workspaces, options.triggerWorkspaceIds)
        : state.workspaces;
      if (!options.triggerWorkspaceIds) {
        // A full sweep sees every workspace: forget back-offs and waits of workspaces that are gone.
        const listed = new Set(state.workspaces.map((workspace) => workspace.id));
        for (const workspaceId of this.backoffs.keys()) if (!listed.has(workspaceId)) this.backoffs.delete(workspaceId);
        for (const workspaceId of this.waitingSince.keys()) if (!listed.has(workspaceId)) this.waitingSince.delete(workspaceId);
      }
      // Fair order across sweeps: workspaces the cap deferred go first, longest-waiting first, then
      // the rest in listing order. Candidates ahead of a deferred one cannot hold the slots forever,
      // even when their archive calls keep failing.
      const waitRank = (workspace: WorkspaceView) => this.waitingSince.get(workspace.id) ?? Number.MAX_SAFE_INTEGER;
      const ordered = [...inScope].sort((a, b) => waitRank(a) - waitRank(b));
      let nonCandidates = 0;
      // Archive attempts (would-archive in dry-run) left this sweep; the rest wait for the next sweep.
      // Backed-off workspaces do not take a slot, so later candidates get it.
      let remaining = config.maxArchivesPerSweep;
      const deferred = new Set<string>();
      const backedOff = new Set<string>();
      const toNotify: Decision[] = [];
      for (const workspace of ordered) {
        // Dry-run attempts nothing, so only an armed sweep moves the queue; a workspace stays
        // queued, keeping its place, only while the cap keeps deferring it.
        const waitingSince = this.waitingSince.get(workspace.id);
        if (!dryRun) this.waitingSince.delete(workspace.id);
        const decision = await decide(workspace, state, config, this.deps, cleanupInput);
        decisions.push(decision);
        if (!decision.candidate) {
          nonCandidates += 1;
          if (config.logNonCandidates) log(formatDecision(decision, "skip"));
          continue;
        }
        if (decision.action === "skip") {
          log(formatDecision(decision, "skip"));
          continue;
        }
        if (decision.action === "notify") {
          toNotify.push(decision);
          continue;
        }
        if (decision.cleanup && cleanupDryRun && !dryRun) {
          // Worker archiving is armed but workspace cleanup is not: a preview that takes no armed slot.
          log(formatDecision(decision, "would-archive"));
          continue;
        }
        const backoff = this.backoffs.get(workspace.id);
        if (backoff && backoff.skipsLeft > 0) {
          backoff.skipsLeft -= 1;
          backedOff.add(workspace.id);
          const progress = `${backoff.sweeps - backoff.skipsLeft}/${backoff.sweeps}`;
          log(formatDecision({ ...decision, reason: `${decision.reason}; archive back-off sweep ${progress} after ${backoff.failures} failed archive call(s)` }, "backoff"));
          continue;
        }
        if (remaining <= 0) {
          deferred.add(workspace.id);
          if (!dryRun) this.waitingSince.set(workspace.id, waitingSince ?? sweepNumber);
          log(formatDecision({ ...decision, reason: `${decision.reason}; maxArchivesPerSweep=${config.maxArchivesPerSweep} reached` }, "deferred"));
          continue;
        }
        if (dryRun) {
          remaining -= 1;
          log(formatDecision(decision, "would-archive"));
          continue;
        }
        // Re-read live state and re-run every gate immediately before acting.
        const fresh = await snapshot(lease.api, decision.cleanup ? deliverySource : null, this.deps.resumeState);
        const freshWorkspace = fresh.workspaces.find((candidate) => candidate.id === workspace.id);
        if (!freshWorkspace) {
          log(formatDecision({ ...decision, reason: "recheck: workspace gone" }, "skip"));
          continue;
        }
        if (decision.cleanup && !fresh.cleanup) {
          log(formatDecision({ ...decision, reason: `recheck: cleanup data unavailable: ${fresh.cleanupError}` }, "skip"));
          continue;
        }
        const recheck = await decide(freshWorkspace, fresh, config, this.deps, decision.cleanup ? cleanupInput : null);
        if (recheck.action !== "archive" || recheck.cleanup !== decision.cleanup) {
          log(formatDecision({ ...recheck, reason: `recheck: ${recheck.reason}` }, "skip"));
          continue;
        }
        remaining -= 1;
        let failure: string;
        try {
          const result = await lease.api.workspaces.archive(workspace.id);
          if (!result.error) {
            this.backoffs.delete(workspace.id);
            archived.push(workspace.id);
            log(formatDecision(recheck, "archived"));
            continue;
          }
          failure = `archive error: ${result.error}`;
        } catch (error) {
          failure = `archive threw: ${error instanceof Error ? error.message : String(error)}`;
        }
        const { sweeps } = this.noteArchiveFailure(workspace.id);
        log(formatDecision({ ...recheck, reason: `${recheck.reason}; ${failure}; back-off ${sweeps} sweep(s)` }, "archive-failed"));
      }
      // With the stale sweep on, workspace cleanup's kept worktrees go into the stale sweep's daily message to each PM
      // instead of a report of their own, so this daemon messages a PM at most once a day.
      const daily = fullSweep && config.staleSweep === true;
      const reported = daily ? [] : await this.report(lease.api, toNotify, state, notified, config, cleanupDryRun, deliverySource);
      if (cleanupRuns && notified && !cleanupDryRun) await this.pruneNotified(notified, state);
      // Stale sweep: after everything above, on a fresh read, so nothing archived just now is flagged.
      let stale: Record<string, number> | undefined;
      if (daily) {
        const result = await this.stalePass(lease.api, config, {
          preview: options.forceDryRun === true,
          archivedNow: new Set(archived),
          deliverySource,
          kept: { candidates: toNotify, notified, wouldOnly: cleanupDryRun },
        });
        stale = result.counts;
        reported.push(...result.reported);
      }
      const counts = decisions.reduce<Record<string, number>>((acc, decision) => {
        const key = !decision.candidate
          ? "nonCandidate"
          : deferred.has(decision.workspaceId)
            ? "deferred"
            : backedOff.has(decision.workspaceId)
              ? "backoff"
              : decision.action;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const cleanup = fullSweep
        ? decisions.reduce<Record<string, number>>((acc, decision) => {
          if (!decision.cleanup) return acc;
          const key = decision.action === "skip" ? (decision.reason.includes("already-notified(") ? "alreadyNotified" : "skip") : decision.action;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {})
        : undefined;
      const pendingMerge = decisions.filter(isPendingMerge).map((decision) => decision.workspaceId);
      const latencyMs = options.eventAt === undefined ? undefined : this.deps.now() - options.eventAt;
      log(
        `[merged-worker-archiver] sweep-done ${JSON.stringify({
          trigger: options.trigger,
          mode: dryRun ? "dry-run" : "armed",
          ...(fullSweep
            ? {
              cleanupMode: cleanupDryRun ? "dry-run" : "armed",
              cleanup,
              reports: reported,
              ...(cleanupRuns ? {} : { cleanupSkipped: state.cleanupError }),
              ...(state.cleanup?.deliveriesError ? { receiptsUnreadable: state.cleanup.deliveriesError } : {}),
              ...(stale ? { stale } : {}),
            }
            : {}),
          evaluated: decisions.length,
          nonCandidates,
          counts,
          archived,
          deferred: deferred.size,
          backoff: backedOff.size,
          pendingMerge,
          latencyMs,
        })}`,
      );
      return { decisions, archived, pendingMerge, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[merged-worker-archiver] sweep-aborted trigger=${options.trigger} reason=${JSON.stringify(message)}`);
      return { decisions, archived, pendingMerge: [], error: message };
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  /**
   * Tell each kept worktree's PM about it, once. Armed: live state is re-read, every gate re-run and
   * the PM resolved again, and right before each send the PM's own status is read again (only an
   * idle or closed, unarchived PM without a pending permission is sent to, with "steer"); one message
   * per PM, at most MAX_REPORT_ITEMS worktrees each. A worktree with no PM on this daemon goes to its
   * PM on a peer daemon (peerHosts), resolved and sent over one session per peer after the local reports.
   * A worktree is recorded as reported before the
   * message goes out, so it is never reported twice: a refusal before delivery (the PM is gone)
   * removes the record again, any other failure keeps it as `unconfirmed`. Returns the worktrees
   * reported (or, in dry-run, that would be).
   */
  private async report(
    api: ArchiverApi,
    candidates: Decision[],
    state: Snapshot,
    notified: Map<string, NotifiedEntry> | null,
    config: ArchiverConfig,
    wouldOnly: boolean,
    deliverySource: DeliverySource,
  ): Promise<string[]> {
    const log = this.deps.log;
    if (candidates.length === 0 || !notified) return [];
    let current = state;
    let confirmed = candidates;
    if (!wouldOnly) {
      current = await snapshot(api, deliverySource, this.deps.resumeState);
      if (!current.cleanup) {
        for (const candidate of candidates) {
          log(formatDecision(candidate, "notify-deferred", { why: `cleanup data unavailable, next full sweep: ${current.cleanupError}` }));
        }
        return [];
      }
      confirmed = [];
      for (const candidate of candidates) {
        const workspace = current.workspaces.find((entry) => entry.id === candidate.workspaceId);
        const recheck = workspace ? await decide(workspace, current, config, this.deps, { notified }) : null;
        if (!recheck || recheck.action !== "notify") {
          log(formatDecision({ ...(recheck ?? candidate), reason: `recheck: ${recheck ? recheck.reason : "workspace gone"}` }, "skip"));
          continue;
        }
        confirmed.push(recheck);
      }
    }
    // This daemon's PMs first; with none here, peer daemons are asked afterwards, so a slow or unreachable
    // peer cannot delay a local report.
    const groups = new Map<string, Recipient>();
    const toPeers: Array<{ item: ReportItem; keys: OwnerKeys; localDetail: string }> = [];
    const peerHosts = this.deps.peerConnector ? config.peerHosts : [];
    for (const decision of confirmed) {
      const workspace = current.workspaces.find((entry) => entry.id === decision.workspaceId)!;
      const history = current.cleanup?.historyByWorkspace.get(workspace.id) ?? [];
      const owner = resolveOwner(workspace, history, current.liveAgents);
      const directory = workspace.workspaceDirectory ?? "";
      if (owner.kind === "agent") {
        addRecipient(groups, null, owner.agentId, { decision, directory, via: owner.via });
        continue;
      }
      if (owner.kind === "none" && peerHosts.length > 0) {
        toPeers.push({ item: { decision, directory, via: "" }, keys: ownerKeys(workspace, history), localDetail: owner.detail });
        continue;
      }
      const detail = owner.kind === "none" ? `no owner: ${owner.detail}` : `several owners: ${owner.agentIds.join(",")}`;
      log(formatDecision(decision, "notify-unrouted", { path: directory, lastCommit: decision.lastCommit ?? null, owner: detail }));
    }
    const reported: string[] = [];
    const local = localChannel(api);
    for (const recipient of groups.values()) reported.push(...(await this.deliver(recipient, local, notified, config, wouldOnly)));
    if (toPeers.length === 0) return reported;

    const peers = new PeerDirectory({
      connect: this.deps.peerConnector!,
      hosts: peerHosts,
      timeoutMs: config.commandTimeoutSeconds * 1000,
      now: this.deps.now,
      onError: (host, query, error) => log(`[merged-worker-archiver] ${JSON.stringify({ action: "notify-peer-error", peer: host, query, error })}`),
    });
    try {
      const peerGroups = new Map<string, Recipient>();
      for (const { item, keys, localDetail } of toPeers) {
        const owner = await peers.resolve(keys);
        if (owner.kind === "agent") {
          addRecipient(peerGroups, owner.host, owner.agentId, { ...item, via: owner.via });
          continue;
        }
        const peerDetail = owner.kind === "several"
          ? `several owners on peers: ${owner.matches.join(",")}`
          : owner.kind === "unknown"
            ? `owner unknown on peers: ${owner.detail}`
            : `no owner on peers: ${owner.detail}`;
        log(formatDecision(item.decision, "notify-unrouted", {
          path: item.directory,
          lastCommit: item.decision.lastCommit ?? null,
          owner: `no owner: ${localDetail}; ${peerDetail}`,
          peers: peerHosts,
          ...(peers.errors.size > 0 ? { peerErrors: Object.fromEntries(peers.errors) } : {}),
        }));
      }
      for (const recipient of peerGroups.values()) {
        const host = recipient.host!;
        const channel: Channel = {
          host,
          busy: async (agentId) => pmBusyReason(await peers.state(host, agentId)),
          send: (agentId, text, messageId) => peers.send(host, agentId, text, messageId),
        };
        reported.push(...(await this.deliver(recipient, channel, notified, config, wouldOnly)));
      }
    } finally {
      await peers.close();
    }
    return reported;
  }

  /**
   * One message to one PM, on this daemon or a peer: at most MAX_REPORT_ITEMS worktrees, only while the
   * PM is quiet (read again right here), recorded as `sending` before it goes out. Returns the worktrees
   * reported (or, in dry-run, that would be).
   */
  private async deliver(
    recipient: Recipient,
    channel: Channel,
    notified: Map<string, NotifiedEntry>,
    config: ArchiverConfig,
    wouldOnly: boolean,
  ): Promise<string[]> {
    const log = this.deps.log;
    const { agentId, items } = recipient;
    const host = channel.host;
    const where = host ? { host } : {};
    const reported: string[] = [];
    const batch = items.slice(0, MAX_REPORT_ITEMS);
    for (const item of items.slice(MAX_REPORT_ITEMS)) {
      log(formatDecision(item.decision, "notify-deferred", { owner: agentId, ...where, why: `more than ${MAX_REPORT_ITEMS} worktrees for one PM; next sweep` }));
    }
    const lineFor = (item: ReportItem, action: string, extra: Record<string, unknown> = {}) =>
      formatDecision(item.decision, action, { path: item.directory, lastCommit: item.decision.lastCommit ?? null, owner: agentId, ...where, via: item.via, ...extra });
    if (wouldOnly) {
      for (const item of batch) {
        log(lineFor(item, "would-notify"));
        reported.push(item.decision.workspaceId);
      }
      return reported;
    }
    // Send only to a quiet PM, read again right here: the rechecks before can take tens of seconds.
    // A message to an agent in a turn interrupts or steers it, one with a pending permission request
    // clears it, and one to an archived agent unarchives it.
    let busy: string | null;
    try {
      busy = await channel.busy(agentId);
    } catch (error) {
      busy = `status unreadable (${error instanceof Error ? error.message : String(error)})`;
    }
    if (busy) {
      for (const item of batch) log(lineFor(item, "notify-deferred", { why: `PM ${busy}; next full sweep` }));
      return reported;
    }
    const at = new Date(this.deps.now()).toISOString();
    for (const item of batch) notified.set(item.decision.workspaceId, { at, agentId, status: "sending", ...where });
    try {
      await this.deps.notifyStore.write(notified);
    } catch (error) {
      for (const item of batch) notified.delete(item.decision.workspaceId);
      for (const item of batch) log(lineFor(item, "notify-failed", { why: `state not written, nothing sent: ${error instanceof Error ? error.message : String(error)}` }));
      return reported;
    }
    const ids = batch.map((item) => item.decision.workspaceId).sort();
    const messageId = `merged-worker-archiver-report-${createHash("sha256").update(`${agentId}\n${ids.join("\n")}`).digest("hex").slice(0, 32)}`;
    const text = formatNotification(batch, config.staleWorkspaceMinutes, this.deps.now());
    const outcome = await channel.send(agentId, text, messageId);
    for (const item of batch) {
      if (outcome.status === "retry") notified.delete(item.decision.workspaceId);
      else notified.set(item.decision.workspaceId, { at, agentId, status: outcome.status, ...where });
    }
    try {
      await this.deps.notifyStore.write(notified);
    } catch (error) {
      log(`[merged-worker-archiver] notify-state-write-failed reason=${JSON.stringify(error instanceof Error ? error.message : String(error))} (entries stay marked sending, never resent)`);
    }
    for (const item of batch) {
      if (outcome.status === "sent") {
        log(lineFor(item, "notified", { messageId }));
        reported.push(item.decision.workspaceId);
      } else if (outcome.status === "retry") log(lineFor(item, "notify-deferred", { why: `refused before delivery, retried next full sweep: ${outcome.why}` }));
      else log(lineFor(item, "notify-failed", { why: `delivery unknown, not resent: ${outcome.why}` }));
    }
    return reported;
  }

  /**
   * The stale sweep (setting staleSweep; see stale.ts), on a fresh read. Each stale item goes to the PM that owns it, one
   * message per PM and at most one a day, each item listed at most once a day. Workspace cleanup's kept worktrees
   * (`kept`, its notify decisions) go into that same message, re-checked here and each reported once, so this daemon
   * sends a PM at most one message a day. An item whose PM or project opted in (or every item, with staleArchiveAll,
   * unrouted ones included) is archived instead when armed and every
   * gate passes (re-checked on a fresh read right before). `preview` (the dry-run script) sends, archives and writes
   * nothing. Returns counts for sweep-done and the kept worktrees reported.
   */
  private async stalePass(
    api: ArchiverApi,
    config: ArchiverConfig,
    options: { preview: boolean; archivedNow: ReadonlySet<string>; deliverySource: DeliverySource; kept: KeptInput },
  ): Promise<{ counts: Record<string, number>; reported: string[] }> {
    const log = this.deps.log;
    const now = this.deps.now();
    const counts: Record<string, number> = {};
    const reported: string[] = [];
    const bump = (key: string, by = 1) => {
      if (by > 0) counts[key] = (counts[key] ?? 0) + by;
    };
    const skipped = (reason: string) => {
      log(`[merged-worker-archiver] stale-skipped reason=${JSON.stringify(reason)} (the stale sweep waits for the next full sweep)`);
      for (const decision of options.kept.candidates) log(formatDecision(decision, "notify-deferred", { why: `stale sweep skipped, next full sweep: ${reason}` }));
      return { counts: { skipped: 1 }, reported };
    };
    const flagStore = this.deps.flagStore;
    if (!flagStore) return skipped("no flag store");
    // Receipts as far back as either stale window, so an agent's last delivered message always counts.
    const deliverySource: DeliverySource = {
      reader: options.deliverySource.reader,
      sinceMs: now - Math.max(config.staleAgentMinutes, config.staleWorkspaceMinutes) * 60_000 - LAST_TURN_ALLOWANCE_MS,
    };
    let state: Snapshot;
    try {
      state = await snapshot(api, deliverySource, this.deps.resumeState);
    } catch (error) {
      return skipped(`listing failed: ${errorText(error)}`);
    }
    if (!state.cleanup) return skipped(`cleanup data unavailable: ${state.cleanupError}`);
    let flags: Map<string, FlagEntry>;
    try {
      flags = await flagStore.read();
    } catch (error) {
      return skipped(`stale-flags state unreadable: ${errorText(error)}`);
    }
    const items = await this.staleItems(state, config, now, state.gates, options.archivedNow, bump);
    bump("stale", items.length);
    const kept = await this.keptReports(state, config, options.kept);

    const peerHosts = this.deps.peerConnector ? config.peerHosts : [];
    let peers: PeerDirectory | null = null;
    const peerDirectory = () =>
      (peers ??= new PeerDirectory({
        connect: this.deps.peerConnector!,
        hosts: peerHosts,
        timeoutMs: config.commandTimeoutSeconds * 1000,
        now: this.deps.now,
        onError: (host, query, error) => log(`[merged-worker-archiver] ${JSON.stringify({ action: "notify-peer-error", peer: host, query, error, pass: "stale" })}`),
      }));
    const peerErrors = () => (peers && peers.errors.size > 0 ? { peerErrors: Object.fromEntries(peers.errors) } : {});
    let dirty = false;
    try {
      const routes = await this.routeStale([...items.map((item) => item.keys), ...kept.map((report) => report.keys)], state.liveAgents, peerHosts, peerDirectory);
      const groups = new Map<string, StaleGroup>();
      const groupFor = (route: { host: string | null; owner: string }) => {
        const key = pmKey(route.host, route.owner);
        const group = groups.get(key) ?? { host: route.host, owner: route.owner, items: [], kept: [] };
        groups.set(key, group);
        return group;
      };

      // Opt-in archive, else flag.
      const optInProjects = new Set(config.staleArchiveProjects.map((name) => name.toLowerCase()));
      let archiveSlots = config.maxArchivesPerSweep;
      for (const [index, item] of items.entries()) {
        const route = routes[index]!;
        const listed = (route.owner !== null && config.staleArchivePms.includes(route.owner)) || item.projects.some((name) => optInProjects.has(name));
        const owned = {
          ...(route.owner ? { owner: route.owner, ...(route.host ? { host: route.host } : {}), via: route.via } : {}),
          ...(listed ? {} : { reason: "staleArchiveAll" }),
        };
        if (listed || config.staleArchiveAll) {
          if (item.kind === "workspace") item.blocked = await this.workspaceArchiveBlock(item.id, state, config);
          if (!item.blocked && options.preview) {
            log(staleLine("would-archive", item, now, owned));
            bump("wouldArchive");
            continue;
          }
          if (!item.blocked && config.armed !== true) {
            log(staleLine("would-archive", item, now, { ...owned, why: `armed is false; ${route.owner ? "flagged" : "logged stale-unrouted"} instead` }));
            item.blocked = "opt-in archive waits for armed";
          }
          if (!item.blocked && archiveSlots <= 0) {
            log(staleLine("stale-deferred", item, now, { ...owned, why: `maxArchivesPerSweep=${config.maxArchivesPerSweep} reached; next full sweep` }));
            bump("deferred");
            continue;
          }
          if (!item.blocked) {
            archiveSlots -= 1;
            const failure = await this.archiveStale(api, item, config, deliverySource);
            if (failure === null) {
              log(staleLine("stale-archived", item, now, owned));
              bump("archived");
              continue;
            }
            item.blocked = failure;
            log(staleLine("stale-archive-skipped", item, now, owned));
          }
        }
        if (route.owner === null) {
          const key = itemKey(item);
          if (recentlyFlagged(flags, key, now, true)) continue;
          log(staleLine(options.preview ? "would-flag-unrouted" : "stale-unrouted", item, now, { owner: route.detail, ...peerErrors() }));
          bump("unrouted");
          if (!options.preview) {
            flags.set(key, { at: new Date(now).toISOString(), status: "unrouted" });
            dirty = true;
          }
          continue;
        }
        groupFor(route).items.push({ item, via: route.via });
      }
      for (const [index, report] of kept.entries()) {
        const route = routes[items.length + index]!;
        const facts = { path: report.directory, lastCommit: report.decision.lastCommit ?? null };
        if (route.owner === null) {
          log(formatDecision(report.decision, "notify-unrouted", { ...facts, owner: route.detail, ...peerErrors() }));
          bump("reportUnrouted");
          continue;
        }
        if (options.kept.wouldOnly) {
          log(formatDecision(report.decision, "would-notify", { ...facts, owner: route.owner, ...(route.host ? { host: route.host } : {}), via: route.via }));
          bump("wouldNotify");
          continue;
        }
        groupFor(route).kept.push({ decision: report.decision, directory: report.directory, via: route.via });
      }

      // One message per PM, at most one a day.
      const local = localChannel(api);
      for (const [groupKey, group] of groups) {
        const where = group.host ? { host: group.host } : {};
        const lineFor = (action: string, entry: { item: StaleItem; via: string }, extra: Record<string, unknown> = {}) =>
          staleLine(action, entry.item, now, { owner: group.owner, ...where, via: entry.via, ...extra });
        const keptLine = (report: ReportItem, action: string, extra: Record<string, unknown> = {}) =>
          formatDecision(report.decision, action, { path: report.directory, lastCommit: report.decision.lastCommit ?? null, owner: group.owner, ...where, via: report.via, ...extra });
        if (recentlyFlagged(flags, groupKey, now)) {
          bump("held", group.items.length);
          for (const report of group.kept) log(keptLine(report, "notify-deferred", { why: "this daemon already sent this PM its daily message; next daily message" }));
          bump("reportDeferred", group.kept.length);
          continue;
        }
        const keptBatch = group.kept.slice(0, MAX_REPORT_ITEMS);
        for (const report of group.kept.slice(MAX_REPORT_ITEMS)) log(keptLine(report, "notify-deferred", { why: `more than ${MAX_REPORT_ITEMS} worktrees for one PM; next daily message` }));
        bump("reportDeferred", group.kept.length - keptBatch.length);
        // A kept worktree is listed once, with its report; it still counts as listed for the stale sweep.
        const keptIds = new Set(keptBatch.map((report) => report.decision.workspaceId));
        const candidates = group.items.filter(({ item }) => !(item.kind === "workspace" && keptIds.has(item.id)));
        const batch = candidates.filter(({ item }) => !recentlyFlagged(flags, itemKey(item), now)).slice(0, MAX_FLAG_ITEMS);
        bump("held", candidates.length - batch.length);
        if (batch.length === 0 && keptBatch.length === 0) continue;
        if (options.preview) {
          for (const entry of batch) log(lineFor("would-flag", entry));
          bump("wouldFlag", batch.length);
          continue;
        }
        const channel: Channel = group.host === null
          ? local
          : { host: group.host, busy: async (agentId) => pmBusyReason(await peerDirectory().state(group.host!, agentId)), send: (agentId, text, messageId) => peerDirectory().send(group.host!, agentId, text, messageId) };
        let busy: string | null;
        try {
          busy = await channel.busy(group.owner);
        } catch (error) {
          busy = `status unreadable (${errorText(error)})`;
        }
        if (busy) {
          for (const entry of batch) log(lineFor("stale-flag-deferred", entry, { why: `PM ${busy}; next full sweep` }));
          for (const report of keptBatch) log(keptLine(report, "notify-deferred", { why: `PM ${busy}; next full sweep` }));
          bump("deferred", batch.length);
          bump("reportDeferred", keptBatch.length);
          continue;
        }
        // Both records say `sending` before the message goes out, so an attempt that may have delivered is not repeated.
        const notified = options.kept.notified;
        const at = new Date(now).toISOString();
        const keys = [groupKey, ...batch.map(({ item }) => itemKey(item)), ...keptBatch.map((report) => itemKey({ kind: "workspace", id: report.decision.workspaceId }))];
        const previous = new Map(keys.map((key) => [key, flags.get(key)]));
        const restore = () => {
          for (const [key, entry] of previous) {
            if (entry) flags.set(key, entry);
            else flags.delete(key);
          }
          for (const report of keptBatch) notified?.delete(report.decision.workspaceId);
        };
        const mark = (status: "sending" | "sent" | "unconfirmed") => {
          for (const key of keys) flags.set(key, { at, status, owner: group.owner, ...where });
          for (const report of keptBatch) notified?.set(report.decision.workspaceId, { at, agentId: group.owner, status, ...where });
        };
        mark("sending");
        try {
          await flagStore.write(flags);
          if (keptBatch.length > 0) await this.deps.notifyStore.write(notified!);
        } catch (error) {
          restore();
          // Undo a flag record already written; if that fails too, the PM is only held for a day.
          await flagStore.write(flags).catch(() => undefined);
          const why = `state not written, nothing sent: ${errorText(error)}`;
          for (const entry of batch) log(lineFor("stale-flag-failed", entry, { why }));
          for (const report of keptBatch) log(keptLine(report, "notify-failed", { why }));
          bump("failed", batch.length + keptBatch.length);
          continue;
        }
        // One id per attempt: the text changes with every attempt (ages), and the daemon refuses a reused id with a
        // different text. The `sending` records above are what keep an attempt from being repeated.
        const ids = keys.slice(1).sort();
        const messageId = `merged-worker-archiver-stale-${createHash("sha256").update(`${group.owner}\n${at}\n${ids.join("\n")}`).digest("hex").slice(0, 32)}`;
        const text = formatFlagMessage(batch.map(({ item }) => item), config, now, keptBatch);
        const outcome = await channel.send(group.owner, text, messageId);
        if (outcome.status === "retry") restore();
        else mark(outcome.status);
        try {
          await flagStore.write(flags);
        } catch (error) {
          log(`[merged-worker-archiver] stale-state-write-failed reason=${JSON.stringify(errorText(error))} (entries stay marked sending, not resent within a day)`);
        }
        if (keptBatch.length > 0) {
          try {
            await this.deps.notifyStore.write(notified!);
          } catch (error) {
            log(`[merged-worker-archiver] notify-state-write-failed reason=${JSON.stringify(errorText(error))} (entries stay marked sending, never resent)`);
          }
        }
        for (const entry of batch) {
          if (outcome.status === "sent") log(lineFor("stale-flagged", entry, { messageId }));
          else if (outcome.status === "retry") log(lineFor("stale-flag-deferred", entry, { why: `refused before delivery, retried next full sweep: ${outcome.why}` }));
          else log(lineFor("stale-flag-failed", entry, { why: `delivery unknown, not resent within a day: ${outcome.why}` }));
        }
        for (const report of keptBatch) {
          if (outcome.status === "sent") {
            log(keptLine(report, "notified", { messageId }));
            reported.push(report.decision.workspaceId);
          } else if (outcome.status === "retry") log(keptLine(report, "notify-deferred", { why: `refused before delivery, retried next full sweep: ${outcome.why}` }));
          else log(keptLine(report, "notify-failed", { why: `delivery unknown, not resent: ${outcome.why}` }));
        }
        const result = outcome.status === "sent" ? "flagged" : outcome.status === "retry" ? "deferred" : "failed";
        bump(result, batch.length);
        bump(outcome.status === "sent" ? "reported" : outcome.status === "retry" ? "reportDeferred" : "failed", keptBatch.length);
        if (outcome.status === "sent") bump("messages");
      }
      if (dirty) {
        try {
          await flagStore.write(flags);
        } catch (error) {
          log(`[merged-worker-archiver] stale-state-write-failed reason=${JSON.stringify(errorText(error))}`);
        }
      }
    } finally {
      await (peers as PeerDirectory | null)?.close();
    }
    return { counts, reported };
  }

  /** Workspace cleanup's kept worktrees, each re-checked on the stale pass's read (it must still be reported), with its owner keys. */
  private async keptReports(state: Snapshot, config: ArchiverConfig, input: KeptInput): Promise<Array<{ decision: Decision; directory: string; keys: OwnerKeys }>> {
    if (input.candidates.length === 0 || !input.notified) return [];
    const reports: Array<{ decision: Decision; directory: string; keys: OwnerKeys }> = [];
    for (const candidate of input.candidates) {
      const workspace = state.workspaces.find((entry) => entry.id === candidate.workspaceId);
      const recheck = workspace ? await decide(workspace, state, config, this.deps, { notified: input.notified }) : null;
      if (!workspace || !recheck || recheck.action !== "notify") {
        this.deps.log(formatDecision({ ...(recheck ?? candidate), reason: `recheck: ${recheck ? recheck.reason : "workspace gone"}` }, "skip"));
        continue;
      }
      const history = state.cleanup?.historyByWorkspace.get(workspace.id) ?? [];
      reports.push({ decision: recheck, directory: workspace.workspaceDirectory ?? "", keys: ownerKeys(workspace, history) });
    }
    return reports;
  }

  /**
   * Each item's PM: on this daemon up the parent labels, else the project's PM (resolveStalePm); with none here, on the
   * peers, where a parent that is not a PM is climbed to its own PM and is never the answer itself.
   */
  private async routeStale(keysList: readonly OwnerKeys[], live: readonly AgentView[], peerHosts: readonly string[], peers: () => PeerDirectory): Promise<StaleRoute[]> {
    const routes: StaleRoute[] = [];
    for (const keys of keysList) {
      const { owner, peerKeys } = resolveStalePm(keys, live);
      if (owner.kind === "agent") {
        routes.push({ host: null, owner: owner.agentId, via: owner.via });
        continue;
      }
      const detail = owner.kind === "none" ? `no owner: ${owner.detail}` : `several owners: ${owner.agentIds.join(",")}`;
      if (owner.kind === "several" || peerHosts.length === 0) {
        routes.push({ host: null, owner: null, via: "", detail });
        continue;
      }
      const peer = await peers().resolve(peerKeys, { pmOnly: true });
      if (peer.kind === "agent") {
        routes.push({ host: peer.host, owner: peer.agentId, via: peer.via });
        continue;
      }
      const peerDetail = peer.kind === "several" ? `several owners on peers: ${peer.matches.join(",")}` : `${peer.kind === "unknown" ? "owner unknown on peers" : "no owner on peers"}: ${peer.detail}`;
      routes.push({ host: null, owner: null, via: "", detail: `${detail}; ${peerDetail}` });
    }
    return routes;
  }

  /** Stale agents and workspaces on a fresh read (see stale.ts). PMs, excluded, pinned and `noarchive` items are left out. */
  private async staleItems(
    state: Snapshot,
    config: ArchiverConfig,
    now: number,
    gates: AgentGates,
    archivedNow: ReadonlySet<string>,
    bump: (key: string, by?: number) => void,
  ): Promise<StaleItem[]> {
    const cleanup = state.cleanup!;
    const items: StaleItem[] = [];
    const workspaces = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
    const lower = (names: readonly string[]) => [...new Set(names.map((name) => name.toLowerCase()))];
    // 1. Agents that are not PMs. A delivered message also moves a live agent's updatedAt (its turn), so unreadable
    // receipts only drop a second source of the same time.
    for (const agent of state.liveAgents) {
      if (isPmAgent(agent)) {
        bump("pm");
        continue;
      }
      if (agent.workspaceId && archivedNow.has(agent.workspaceId)) continue;
      const workspace = agent.workspaceId ? workspaces.get(agent.workspaceId) : undefined;
      const keep = agentKeepReason(agent, workspace, config);
      if (keep) {
        bump(keep.count);
        continue;
      }
      if (agent.status === "running" || agent.status === "initializing") continue;
      const last = agentLastActivity(agent, cleanup.deliveries);
      if (last === null || now - last < config.staleAgentMinutes * 60_000) continue;
      const children = state.liveAgents.filter((other) => other.id !== agent.id && isChildOf(other, agent.id)).length;
      const keys = agentOwnerKeys(agent, workspace?.projectDisplayName);
      items.push({
        kind: "agent",
        id: agent.id,
        name: agent.title?.trim() || agent.id.slice(0, 8),
        where: workspace ? `${workspace.name} (${workspace.id})` : "no workspace",
        status: agent.status,
        branch: null,
        lastActivityAt: last,
        keys,
        projects: lower(keys.names),
        blocked: agentArchiveBlock(agent, gates, children),
      });
    }
    // 2. Worktree and disposable-root workspaces with no live agent.
    for (const workspace of state.workspaces) {
      if (archivedNow.has(workspace.id) || workspace.archivingAt || !workspace.workspaceDirectory) continue;
      if ((state.agentsByWorkspace.get(workspace.id)?.length ?? 0) > 0) continue;
      const worktree = workspace.workspaceKind === "worktree";
      const directory = workspace.workspaceDirectory;
      if (!worktree && !(await isDisposableDirectory(directory, this.deps))) continue;
      const history = cleanup.historyByWorkspace.get(workspace.id) ?? [];
      const keep = workspaceKeepReason(workspace, history, config);
      if (keep) {
        bump(keep.count);
        continue;
      }
      // A missing directory is left to Paseo's own reconciliation, as in workspace cleanup.
      if ((await this.deps.fs.isDirectory(directory)) !== true) continue;
      const head = worktree ? await headCommit(directory, { config, deps: this.deps }) : null;
      const paseoLatest = lastActivity(workspace, history, cleanup.deliveries);
      const latest = head && (paseoLatest === null || head.at > paseoLatest) ? head.at : paseoLatest;
      if (latest === null || now - latest < config.staleWorkspaceMinutes * 60_000) continue;
      const keys = ownerKeys(workspace, history);
      items.push({
        kind: "workspace",
        id: workspace.id,
        name: workspace.name,
        where: directory,
        status: workspace.workspaceKind,
        branch: workspace.gitRuntime?.currentBranch ?? null,
        lastActivityAt: latest,
        keys,
        projects: lower(keys.names),
        blocked: null,
      });
    }
    return items;
  }

  /** Why an agentless workspace may not be archived: the worker path's and workspace cleanup's own decision, or null. */
  private async workspaceArchiveBlock(workspaceId: string, state: Snapshot, config: ArchiverConfig): Promise<string | null> {
    const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) return "workspace gone";
    const decision = await decide(workspace, state, config, this.deps, { notified: new Map() });
    // The message shows the idle time already; workspace cleanup's notify reasons end with it.
    return decision.action === "archive" ? null : decision.reason.replace(/; idle=[^;]*$/, "");
  }

  /** Archive one opted-in stale item after re-reading live state and re-running every gate. Null when archived, else why not. */
  private async archiveStale(api: ArchiverApi, item: StaleItem, config: ArchiverConfig, deliverySource: DeliverySource): Promise<string | null> {
    let fresh: Snapshot;
    try {
      fresh = await snapshot(api, deliverySource, this.deps.resumeState);
    } catch (error) {
      return `recheck: listing failed: ${errorText(error)}`;
    }
    if (!fresh.cleanup) return `recheck: cleanup data unavailable: ${fresh.cleanupError}`;
    const now = this.deps.now();
    if (item.kind === "agent") {
      if (typeof api.agents.archive !== "function") return "agent archive unavailable";
      const agent = fresh.liveAgents.find((entry) => entry.id === item.id);
      if (!agent) return "recheck: agent gone or archived";
      const keep = agentKeepReason(agent, fresh.workspaces.find((entry) => entry.id === agent.workspaceId), config);
      if (keep) return `recheck: ${keep.why}`;
      const last = agentLastActivity(agent, fresh.cleanup.deliveries);
      if (last === null || now - last < config.staleAgentMinutes * 60_000) return "recheck: active again";
      const children = fresh.liveAgents.filter((other) => other.id !== agent.id && isChildOf(other, agent.id)).length;
      const block = agentArchiveBlock(agent, fresh.gates, children);
      if (block) return `recheck: ${block}`;
      try {
        await api.agents.archive(agent.id);
        return null;
      } catch (error) {
        return `archive threw: ${errorText(error)}`;
      }
    }
    const workspace = fresh.workspaces.find((entry) => entry.id === item.id);
    if (!workspace) return "recheck: workspace gone";
    const agents = fresh.agentsByWorkspace.get(workspace.id)?.length ?? 0;
    if (agents > 0) return `recheck: agents(${agents})`;
    const keep = workspaceKeepReason(workspace, fresh.cleanup.historyByWorkspace.get(workspace.id) ?? [], config);
    if (keep) return `recheck: ${keep.why}`;
    const block = await this.workspaceArchiveBlock(workspace.id, fresh, config);
    if (block) return `recheck: ${block}`;
    try {
      const result = await api.workspaces.archive(workspace.id);
      return result.error ? `archive error: ${result.error}` : null;
    } catch (error) {
      return `archive threw: ${errorText(error)}`;
    }
  }

  /** Armed workspace cleanup only: forget reported worktrees that are no longer listed. */
  private async pruneNotified(notified: Map<string, NotifiedEntry>, state: Snapshot): Promise<void> {
    const listed = new Set(state.workspaces.map((workspace) => workspace.id));
    const gone = [...notified.keys()].filter((workspaceId) => !listed.has(workspaceId));
    if (gone.length === 0) return;
    for (const workspaceId of gone) notified.delete(workspaceId);
    try {
      await this.deps.notifyStore.write(notified);
    } catch (error) {
      this.deps.log(`[merged-worker-archiver] notify-state-write-failed reason=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

import { matchProjectPms, type OwnerKeys } from "./cleanup.ts";
import type { AgentView } from "./types.ts";

// Peer daemons (setting peerHosts). When this daemon has no PM for a kept agentless worktree, the other daemons are
// asked in order, each over one connection per report pass (see peer-session.ts for how it is opened):
//
// - the last agent's `paseo.parent-agent-id` (a full id), which must be a live, unarchived agent there;
// - else the live role=pm agents whose `project` label matches a project name, by the same case-insensitive rule as
//   on this daemon.
//
// The owner must be unique across every peer. A peer that fails (connect, lookup, state read or send) logs one
// notify-peer-error and is asked nothing more in that pass; while one has failed no project PM is chosen, since it
// may hold another. Every call is bounded by commandTimeoutSeconds, and the whole pass by a time budget.

/** The only peer form accepted: `ssh://<alias>`, an ssh alias or host name with no user, port, path or query. */
export const PEER_HOST_PATTERN = /^ssh:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** One open connection to a peer daemon. Every call takes its own time limit. */
export interface PeerSession {
  /** Every non-archived agent (pages followed to the end). */
  listAgents(timeoutMs: number): Promise<AgentView[]>;
  /** One agent by id, archived included; null when there is none. */
  getAgent(agentId: string, timeoutMs: number): Promise<AgentView | null>;
  /** Prompt an agent with "steer"; the daemon keeps one receipt per (agent, messageId) and delivers it once. */
  send(agentId: string, text: string, messageId: string, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

/** Opens a session to `host` within `timeoutMs`; `lifetimeMs` bounds how long anything it starts may live. */
export type PeerConnector = (host: string, timeoutMs: number, lifetimeMs: number) => Promise<PeerSession>;

export type PeerResolution =
  | { kind: "agent"; host: string; agentId: string; via: "peer-parent" | "peer-project-pm" }
  | { kind: "none"; detail: string }
  | { kind: "several"; matches: string[] }
  /** A peer did not answer and no owner could be ruled unique. */
  | { kind: "unknown"; detail: string };

export type PeerSendOutcome = { status: "sent" } | { status: "retry" | "unconfirmed"; why: string };

/** Each listed peer adds this many command timeouts to one report pass's peer budget. */
export const PEER_BUDGET_TIMEOUTS = 2;

interface Failure {
  failure: string;
}

const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "failure" in value;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The daemon refused before delivery: the agent is not there. */
const NOT_FOUND = /Agent not found: /;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One report pass of peer lookups and sends: one session per peer, answers cached, a failed peer asked nothing more. */
export class PeerDirectory {
  readonly hosts: readonly string[];
  private readonly connect: PeerConnector;
  private readonly timeoutMs: number;
  private readonly budgetMs: number;
  private readonly deadline: number;
  private readonly now: () => number;
  private readonly onError: (host: string, query: string, error: string) => void;
  private readonly down = new Map<string, string>();
  private readonly sessions = new Map<string, PeerSession>();
  private readonly answers = new Map<string, unknown>();

  constructor(options: {
    connect: PeerConnector;
    hosts: readonly string[];
    timeoutMs: number;
    now: () => number;
    onError: (host: string, query: string, error: string) => void;
  }) {
    this.connect = options.connect;
    this.hosts = options.hosts;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now;
    this.onError = options.onError;
    this.budgetMs = PEER_BUDGET_TIMEOUTS * options.timeoutMs * options.hosts.length;
    this.deadline = options.now() + this.budgetMs;
  }

  /** Peers that failed in this pass, with their first error. */
  get errors(): ReadonlyMap<string, string> {
    return this.down;
  }

  private fail(host: string, query: string, error: string): Failure {
    if (!this.down.has(host)) {
      this.down.set(host, error);
      this.onError(host, query, error);
    }
    return { failure: this.down.get(host)! };
  }

  /** Time left for one call: the command timeout, cut to what is left of the pass's budget. */
  private allowance(): number {
    return Math.min(this.timeoutMs, this.deadline - this.now());
  }

  private get budgetSpent(): string {
    return `peer time budget spent (${Math.round(this.budgetMs / 1000)} s per sweep)`;
  }

  private async session(host: string, query: string): Promise<PeerSession | Failure> {
    const known = this.down.get(host);
    if (known !== undefined) return { failure: known };
    const open = this.sessions.get(host);
    if (open) return open;
    const ms = this.allowance();
    if (ms <= 0) return this.fail(host, query, this.budgetSpent);
    // Whatever the connector starts may live until the pass's budget ends, plus a margin for closing.
    const pending = this.connect(host, ms, Math.max(0, this.deadline - this.now()) + 5_000);
    try {
      const session = await withTimeout(pending, ms, "connect");
      this.sessions.set(host, session);
      return session;
    } catch (error) {
      // A connect that finishes after the time limit is closed at once.
      void pending.then((late) => late.close(), () => undefined);
      return this.fail(host, "connect", `cannot connect: ${message(error)}`);
    }
  }

  private async call<T>(host: string, query: string, run: (session: PeerSession, ms: number) => Promise<T>): Promise<T | Failure> {
    const session = await this.session(host, query);
    if (isFailure(session)) return session;
    const ms = this.allowance();
    if (ms <= 0) return this.fail(host, query, this.budgetSpent);
    try {
      return await withTimeout(run(session, ms), ms, query);
    } catch (error) {
      return this.fail(host, query, message(error));
    }
  }

  private async cached<T>(host: string, query: string, key: string, run: (session: PeerSession, ms: number) => Promise<T>): Promise<T | Failure> {
    const cacheKey = `${host}\n${query}\n${key}`;
    if (this.answers.has(cacheKey)) return this.answers.get(cacheKey) as T;
    const value = await this.call(host, query, run);
    if (!isFailure(value)) this.answers.set(cacheKey, value);
    return value;
  }

  /** The PM on a peer: the live parent by full id, else the one role=pm agent of the project, across every peer. */
  async resolve(keys: OwnerKeys): Promise<PeerResolution> {
    const unreachable = () => this.hosts.filter((host) => this.down.has(host));
    if (keys.parentId) {
      const parentId = keys.parentId;
      const found: string[] = [];
      for (const host of this.hosts) {
        const agent = await this.cached(host, "parent", parentId, (session, ms) => session.getAgent(parentId, ms));
        // The daemon also resolves id prefixes and titles; only this exact id counts.
        if (!isFailure(agent) && agent && agent.id === parentId && !agent.archivedAt) found.push(host);
      }
      if (found.length === 1) return { kind: "agent", host: found[0]!, agentId: parentId, via: "peer-parent" };
      if (found.length > 1) return { kind: "several", matches: found.map((host) => `${host} ${parentId}`) };
      // The parent may be on a peer that did not answer.
      if (unreachable().length > 0) return { kind: "unknown", detail: `parent ${parentId} not live on the peers that answered; unreachable: ${unreachable().join(",")}` };
    }
    if (keys.names.length === 0) return { kind: "none", detail: "no project name" };
    const matches: Array<{ host: string; agentId: string }> = [];
    for (const host of this.hosts) {
      const live = await this.cached(host, "list", "", (session, ms) => session.listAgents(ms));
      if (isFailure(live)) continue;
      for (const pm of matchProjectPms(live, keys.names)) matches.push({ host, agentId: pm.id });
    }
    if (matches.length > 1) return { kind: "several", matches: matches.map((match) => `${match.host} ${match.agentId}`) };
    const down = unreachable();
    if (down.length > 0) {
      const seen = matches.length === 1 ? `one role=pm agent (${matches[0]!.host} ${matches[0]!.agentId}), but` : "no role=pm agent on the peers that answered, and";
      return { kind: "unknown", detail: `${seen} unreachable: ${down.join(",")}` };
    }
    if (matches.length === 1) return { kind: "agent", host: matches[0]!.host, agentId: matches[0]!.agentId, via: "peer-project-pm" };
    const names = [...new Set(keys.names.map((name) => name.toLowerCase()))].join("|");
    return { kind: "none", detail: `no live role=pm agent for project ${names}${keys.parentId ? ` and parent ${keys.parentId} not live` : ""}` };
  }

  /** A fresh read of one agent on a peer, right before a send: null when it has none; throws when the peer fails. */
  async state(host: string, agentId: string): Promise<AgentView | null> {
    const agent = await this.call(host, "state", (session, ms) => session.getAgent(agentId, ms));
    if (isFailure(agent)) throw new Error(agent.failure);
    return agent && agent.id === agentId ? agent : null;
  }

  /**
   * Send with "steer" and a fixed messageId. Nothing sent yet (the peer is down or the budget is spent) or the agent
   * gone: may be retried. Any other failure may have delivered and is never resent; it also marks the peer down.
   */
  async send(host: string, agentId: string, text: string, messageId: string): Promise<PeerSendOutcome> {
    const session = await this.session(host, "send");
    if (isFailure(session)) return { status: "retry", why: session.failure };
    const ms = this.allowance();
    if (ms <= 0) return { status: "retry", why: this.fail(host, "send", this.budgetSpent).failure };
    try {
      await withTimeout(session.send(agentId, text, messageId, ms), ms, "send");
      return { status: "sent" };
    } catch (error) {
      const why = message(error);
      if (NOT_FOUND.test(why)) return { status: "retry", why };
      this.fail(host, "send", why);
      return { status: "unconfirmed", why };
    }
  }

  /** Close every session this pass opened. */
  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close().catch(() => undefined)));
    this.sessions.clear();
  }
}

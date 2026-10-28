import type { OwnerKeys } from "./cleanup.ts";
import type { CommandResult } from "./types.ts";

// Peer daemons (setting peerHosts). When this daemon has no PM for a kept agentless worktree, the other
// daemons are asked in order through the paseo CLI (`--host ssh://<alias>`), never through a shell:
//
// - `paseo inspect --host <peer> --json -- <id>` for the last agent's `paseo.parent-agent-id` (a full
//   id), which must be a live, unarchived agent there;
// - else `paseo ls --host <peer> -g --label role=pm --label project=<name> --json` for each project name,
//   as written and in lower case: the CLI filters labels exactly and does not print them.
//
// The owner must be unique across every peer. A peer that fails is asked nothing more in that pass and is
// logged once; while one is unreachable no project PM is chosen, since it may hold another.

/** The only peer form accepted: `ssh://<alias>`, an ssh alias or host name with no user, port, path or query. */
export const PEER_HOST_PATTERN = /^ssh:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Runs the paseo CLI with these arguments, without a shell. Must never throw. */
export type PaseoCli = (args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

// Only an id of this shape is passed to the CLI (after `--`, so it can never be read as an option).
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface PeerAgent {
  id: string;
  status: string;
  archived: boolean;
  pendingPermissions: number;
}

export type PeerResolution =
  | { kind: "agent"; host: string; agentId: string; via: "peer-parent" | "peer-project-pm" }
  | { kind: "none"; detail: string }
  | { kind: "several"; matches: string[] }
  /** A peer did not answer and no owner could be ruled unique. */
  | { kind: "unknown"; detail: string };

export type PeerSendOutcome = { status: "sent" } | { status: "retry" | "unconfirmed"; why: string };

interface Failure {
  failure: string;
}

const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "failure" in value;

/** The CLI's own error (`{"error":{"code","message"}}` on stderr with --json), or what is known of it. */
function cliError(result: CommandResult): { code: string | null; message: string } {
  if (result.notFound) return { code: null, message: "paseo CLI not found" };
  if (result.timedOut) return { code: null, message: "timed out" };
  const raw = (result.stderr.trim() || result.stdout.trim()).slice(0, 4000);
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } } | null;
    if (parsed?.error && typeof parsed.error.message === "string") {
      return { code: typeof parsed.error.code === "string" ? parsed.error.code : null, message: parsed.error.message };
    }
  } catch {
    // Not JSON: a usage error or a crash.
  }
  return { code: null, message: `exit ${result.code ?? "null"}: ${raw.split("\n")[0] ?? ""}` };
}

const describe = (error: { code: string | null; message: string }) => (error.code ? `${error.code}: ${error.message}` : error.message).slice(0, 300);

/** CLI output that is not JSON is a failure of that peer, never an empty answer. */
function parseJson(stdout: string, what: string): { value: unknown } | Failure {
  try {
    return { value: JSON.parse(stdout) as unknown };
  } catch {
    return { failure: `${what} output is not JSON` };
  }
}

function parseInspect(agentId: string, result: CommandResult): PeerAgent | null | Failure {
  if (result.code !== 0) {
    const error = cliError(result);
    return error.code === "AGENT_NOT_FOUND" ? null : { failure: describe(error) };
  }
  const parsed = parseJson(result.stdout, "inspect");
  if (isFailure(parsed)) return parsed;
  const data = parsed.value as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || typeof data.Id !== "string" || typeof data.Status !== "string" || typeof data.Archived !== "boolean" || !Array.isArray(data.PendingPermissions)) {
    return { failure: "inspect output malformed" };
  }
  // The CLI also resolves id prefixes; only this exact id counts.
  if (data.Id !== agentId) return null;
  return { id: data.Id, status: data.Status, archived: data.Archived, pendingPermissions: data.PendingPermissions.length };
}

function parseList(result: CommandResult): string[] | Failure {
  if (result.code !== 0) return { failure: describe(cliError(result)) };
  const parsed = parseJson(result.stdout, "ls");
  if (isFailure(parsed)) return parsed;
  const data = parsed.value;
  if (!Array.isArray(data) || !data.every((entry) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string")) {
    return { failure: "ls output malformed" };
  }
  return data.map((entry) => (entry as { id: string }).id);
}

/** One pass of peer lookups (a report): answers are cached, and a peer that fails once is asked nothing more. */
export class PeerDirectory {
  readonly hosts: readonly string[];
  private readonly cli: PaseoCli;
  private readonly timeoutMs: number;
  private readonly onError: (host: string, query: string, error: string) => void;
  private readonly down = new Map<string, string>();
  private readonly answers = new Map<string, unknown>();

  constructor(cli: PaseoCli, hosts: readonly string[], timeoutMs: number, onError: (host: string, query: string, error: string) => void) {
    this.cli = cli;
    this.hosts = hosts;
    this.timeoutMs = timeoutMs;
    this.onError = onError;
  }

  /** Peers that failed in this pass, with their first error. */
  get errors(): ReadonlyMap<string, string> {
    return this.down;
  }

  private async ask<T>(host: string, query: string, args: string[], parse: (result: CommandResult) => T | Failure): Promise<T | Failure> {
    const known = this.down.get(host);
    if (known !== undefined) return { failure: known };
    const key = `${host}\n${args.join("\n")}`;
    if (this.answers.has(key)) return this.answers.get(key) as T;
    const value = parse(await this.cli(args, this.timeoutMs));
    if (isFailure(value)) {
      this.down.set(host, value.failure);
      this.onError(host, query, value.failure);
    } else {
      this.answers.set(key, value);
    }
    return value;
  }

  private inspect(host: string, agentId: string): Promise<PeerAgent | null | Failure> {
    return this.ask(host, "inspect", ["inspect", "--host", host, "--json", "--", agentId], (result) => parseInspect(agentId, result));
  }

  private projectPms(host: string, project: string): Promise<string[] | Failure> {
    return this.ask(host, "ls", ["ls", "--host", host, "-g", "--label", "role=pm", "--label", `project=${project}`, "--json"], parseList);
  }

  /** The PM on a peer: the live parent by full id, else the one role=pm agent of the project, across every peer. */
  async resolve(keys: OwnerKeys): Promise<PeerResolution> {
    const unreachable = () => this.hosts.filter((host) => this.down.has(host));
    if (keys.parentId && AGENT_ID.test(keys.parentId)) {
      const found: string[] = [];
      for (const host of this.hosts) {
        const agent = await this.inspect(host, keys.parentId);
        if (agent && !isFailure(agent) && !agent.archived) found.push(host);
      }
      if (found.length === 1) return { kind: "agent", host: found[0]!, agentId: keys.parentId, via: "peer-parent" };
      if (found.length > 1) return { kind: "several", matches: found.map((host) => `${host} ${keys.parentId}`) };
      // The parent may be on a peer that did not answer.
      if (unreachable().length > 0) return { kind: "unknown", detail: `parent ${keys.parentId} not live on the peers that answered; unreachable: ${unreachable().join(",")}` };
    }
    if (keys.names.length === 0) return { kind: "none", detail: "no project name" };
    const variants = [...new Set(keys.names.flatMap((name) => [name, name.toLowerCase()]))];
    const matches: Array<{ host: string; agentId: string }> = [];
    for (const host of this.hosts) {
      const ids = new Set<string>();
      for (const name of variants) {
        const list = await this.projectPms(host, name);
        if (isFailure(list)) break;
        for (const id of list) ids.add(id);
      }
      if (this.down.has(host)) continue;
      for (const agentId of ids) matches.push({ host, agentId });
    }
    if (matches.length > 1) return { kind: "several", matches: matches.map((match) => `${match.host} ${match.agentId}`) };
    const down = unreachable();
    if (down.length > 0) {
      const seen = matches.length === 1 ? `one role=pm agent (${matches[0]!.host} ${matches[0]!.agentId}), but` : "no role=pm agent on the peers that answered, and";
      return { kind: "unknown", detail: `${seen} unreachable: ${down.join(",")}` };
    }
    if (matches.length === 1) return { kind: "agent", host: matches[0]!.host, agentId: matches[0]!.agentId, via: "peer-project-pm" };
    return { kind: "none", detail: `no live role=pm agent for project ${variants.join("|")}${keys.parentId ? ` and parent ${keys.parentId} not live` : ""}` };
  }

  /** A fresh read of one agent on a peer, right before a send: null when it has none; throws when the peer fails. */
  async state(host: string, agentId: string): Promise<PeerAgent | null> {
    if (!AGENT_ID.test(agentId)) return null;
    const value = parseInspect(agentId, await this.cli(["inspect", "--host", host, "--json", "--", agentId], this.timeoutMs));
    if (isFailure(value)) throw new Error(value.failure);
    return value;
  }

  /**
   * `paseo send --no-wait --behavior steer`. A failure that cannot have delivered (no CLI, a usage error, no
   * connection, the agent gone) may be retried; any other may have delivered and is never resent.
   */
  async send(host: string, agentId: string, text: string): Promise<PeerSendOutcome> {
    const result = await this.cli(["send", "--host", host, "--no-wait", "--behavior", "steer", "--json", "--", agentId, text], this.timeoutMs);
    if (result.code === 0) return { status: "sent" };
    const error = cliError(result);
    const beforeDelivery = result.notFound
      || /^error: /.test(result.stderr.trim())
      || error.message.startsWith("Cannot connect to daemon at ")
      || (error.code === "SEND_FAILED" && /Agent not found: /.test(error.message));
    return { status: beforeDelivery ? "retry" : "unconfirmed", why: describe(error) };
  }
}

// Canonical "history read raced a close or archive" helper for the Loadout plugins.
//
// Every plugin is staged and installed on its own, so none can import this file at
// runtime. Each one carries a byte-identical copy in server/vendor/ended-read.ts.
// Edit plugins/_shared/ended-read.ts only, copy it over every vendored copy, and
// run python3 scripts/check_vendored.py, which CI also runs.
//
// Every Paseo 0.11 and 0.13 timeline read loads an unloaded agent first, and none can be told to refuse a closed one,
// so a read still in flight when a user stops or archives the agent brings it back (closed -> idle, "Agent resumed from
// persistence"). A plugin cannot prevent that: whatever it checks before the read, the close can land between the
// daemon answering the check and receiving the read. Instead each read is watched, and afterwards the agent is put back:
// when this plugin saw the agent close or be archived while the read was in flight, or a fetch made after the read
// (a fetch never loads an agent) shows it closed, archived or deleted, the agent the read loaded again is archived again
// or killed again, through the call the user's own path makes, and the read's result is dropped.

import { resolveDaemonTarget } from "./daemon-target.ts";

/** The fields of an agent snapshot this reads. A loaded agent's snapshot carries activeTurn (null when idle); a stored one has none. */
export type EndedSnapshot = {
  status: string;
  archivedAt?: string | null;
  activeTurn?: unknown;
  lastUserMessageAt?: string | null;
};

/** How a read ended the work it was for, and what was done to put the agent back. */
export type ReadEnd = {
  end: "closed" | "archived" | "gone";
  restored: "none" | "archived" | "closed" | "skipped-active" | "failed";
  reason?: string;
};

/** The agent calls a watch makes after its read, on the same API the read used. */
export type AgentPort<S extends EndedSnapshot> = {
  /** A fetch, which never loads an agent; null for an agent the daemon does not know. */
  fetch: () => Promise<S | null>;
  /** The archive a user's archive (or a closed agent tab) makes. */
  archive: () => Promise<unknown>;
};

export type Decided<S> = { ended: false; after: S | undefined } | ({ ended: true } & ReadEnd);
export type ReadResult<T, S> = { ended: false; value: T; after: S | undefined } | ({ ended: true } & ReadEnd);

type Seen = { closed: boolean; archived: boolean };

/** The daemon's Agent MCP kill_agent, the call that closes an agent without archiving it (Paseo has no other). */
export async function killAgent(agentId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const url = new URL("/mcp/agents", resolveDaemonTarget(env).url.replace(/^ws/, "http"));
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kill_agent", arguments: { agentId } } }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`kill_agent answered HTTP ${response.status}`);
  // A streamable HTTP answer is one server-sent event; a plain JSON one is the body itself.
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("") || text;
  const message = JSON.parse(data) as { error?: { message?: string }; result?: { isError?: boolean; structuredContent?: { success?: boolean } } };
  if (message.error || message.result?.isError || message.result?.structuredContent?.success !== true) {
    throw new Error(`kill_agent refused: ${message.error?.message ?? text.slice(0, 200)}`);
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The watches of one plugin. `readsClosed` says whether the plugin reads a closed (unloaded) agent on purpose, as
 * usage-limit-auto-resume does after a daemon restart; when false, a read issued on a closed snapshot raced a close.
 */
export function endedReads(options: {
  kill: (agentId: string) => Promise<void>;
  log: (agentId: string, read: string, end: ReadEnd) => void;
  readsClosed: boolean;
}) {
  const watching = new Map<string, Set<Seen>>();
  // Open listings: the closes and archives of every agent noted since each began.
  const listings = new Set<Map<string, Seen>>();

  /**
   * Watches the agent from now until done(): a close or archive noted meanwhile ends every read decided after it.
   * `read` names the reads in the log. decide() runs after a read, on the snapshot the read was issued on (null when
   * there is none); run() is one read followed by decide(). `since` is what a listing noted before the watch opened.
   */
  function watch<S extends EndedSnapshot>(agentId: string, read: string, port: AgentPort<S>, since?: Seen) {
    const seen: Seen = { closed: since?.closed ?? false, archived: since?.archived ?? false };
    const set = watching.get(agentId) ?? new Set<Seen>();
    set.add(seen);
    watching.set(agentId, set);
    const done = () => {
      set.delete(seen);
      if (set.size === 0 && watching.get(agentId) === set) watching.delete(agentId);
    };

    async function decide(before: EndedSnapshot | null): Promise<Decided<S>> {
      let after: S | null | undefined;
      let fetchError = "";
      try {
        after = await port.fetch();
      } catch (error) {
        fetchError = errorText(error);
      }
      const closedBefore = before?.status === "closed";
      const end: ReadEnd["end"] | null = after === null ? "gone"
        : seen.archived || after?.archivedAt ? "archived"
        : seen.closed || (closedBefore && !options.readsClosed) || (after?.status === "closed" && !closedBefore) ? "closed"
        : null;
      if (!end) return { ended: false, after: after ?? undefined };
      const ended = await restore(end, before, after);
      options.log(agentId, read, ended);
      return { ended: true, ...ended };

      async function restore(end: ReadEnd["end"], before: EndedSnapshot | null, after: S | null | undefined): Promise<ReadEnd> {
        if (end === "gone") return { end, restored: "none" };
        if (after === undefined) return { end, restored: "failed", reason: `agent fetch failed: ${fetchError}` };
        // Not loaded: the agent is as the user left it.
        if (!after || after.status === "closed" || after.activeTurn === undefined) return { end, restored: "none" };
        if (end === "archived") {
          if (!after.archivedAt) return { end, restored: "none", reason: "unarchived-since" };
        } else {
          // A running turn or a newer user message: someone opened the agent again since, so it stays open.
          const resumed = after.status === "running" || after.status === "initializing" || !!after.activeTurn ||
            (!!before && (after.lastUserMessageAt ?? null) !== (before.lastUserMessageAt ?? null));
          if (resumed) return { end, restored: "skipped-active", reason: `status=${after.status}` };
        }
        try {
          if (end === "archived") await port.archive();
          else await options.kill(agentId);
          return { end, restored: end };
        } catch (error) {
          return { end, restored: "failed", reason: errorText(error) };
        }
      }
    }

    /** Runs the read, then decides. A read that throws is decided too, and its error rethrown unless the agent ended. */
    async function run<T>(before: EndedSnapshot | null, read: () => Promise<T>): Promise<ReadResult<T, S>> {
      let value: T | undefined;
      let failure: { error: unknown } | null = null;
      try {
        value = await read();
      } catch (error) {
        failure = { error };
      }
      const decided = await decide(before);
      if (decided.ended) return decided;
      if (failure) throw failure.error;
      return { ended: false, value: value as T, after: decided.after };
    }

    return { decide, run, done };
  }

  return {
    watch,
    /** One read, watched from its start until it is decided. */
    async read<T, S extends EndedSnapshot>(agentId: string, read: string, port: AgentPort<S>, before: EndedSnapshot | null, run: () => Promise<T>) {
      const watched = watch(agentId, read, port);
      try {
        return await watched.run(before, run);
      } finally {
        watched.done();
      }
    },
    /**
     * Watches every agent from now until done(), for reads of agents not known yet, such as the entries of a list page
     * being fetched: watch() opens one agent's watch that starts with any close or archive of it noted since. Watches
     * it opened stay open until their own done().
     */
    listing() {
      const noted = new Map<string, Seen>();
      listings.add(noted);
      return {
        watch: <S extends EndedSnapshot>(agentId: string, read: string, port: AgentPort<S>) => watch(agentId, read, port, noted.get(agentId)),
        done: () => { listings.delete(noted); },
      };
    },
    /** A close or archive of the agent, seen by the plugin: every read of it in flight ends. */
    note(agentId: string, end: "closed" | "archived") {
      for (const seen of watching.get(agentId) ?? []) seen[end] = true;
      for (const noted of listings) {
        const seen = noted.get(agentId) ?? { closed: false, archived: false };
        seen[end] = true;
        noted.set(agentId, seen);
      }
    },
    clear() {
      watching.clear();
      listings.clear();
    },
  };
}

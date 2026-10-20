import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { QuotaReader } from "../server/quota.ts";
import contribute from "../index.server.ts";
import { ConfigSchema } from "../server/config.ts";
import type { AgentSnapshot } from "../server/model.ts";
import { ResumeStore } from "../server/store.ts";

// The QBO PM incident, 2026-10-20: Pi compacts in its prompt preflight for longer than Paseo's 60 s prompt RPC timeout.
const START = Date.parse("2026-10-20T18:09:24.360Z");
const TIMEOUT = "Pi RPC request timed out phase=prompt elapsedMs=60003 timeoutMs=60000";
const ORIGINAL = "Cash PM: please pull the FSB check image for check 2843";

async function lane(run: (lane: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const scratch = path.join(homedir(), ".cache", "fleet-scratch", "loadout", "autoresume-regression");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, "rpc-timeout-"));
  const oldHome = process.env.PASEO_HOME;
  const oldLog = console.log;
  process.env.PASEO_HOME = home;
  console.log = () => undefined;
  mock.timers.enable({ apis: ["Date", "setInterval"], now: START });
  let current: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    current = await setup();
    await run(current);
  } finally {
    try {
      current?.plugin();
      await current?.plugin.idle();
    } finally {
      mock.timers.reset();
      console.log = oldLog;
      if (oldHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function setup() {
  const config = ConfigSchema.parse({ armed: true });
  const store = new ResumeStore();
  const snapshot: AgentSnapshot = {
    id: "qbo-pm", provider: "pi", model: "fleet/claude-opus-5-5", thinkingOptionId: "medium", cwd: "/qbo",
    status: "running", activeTurn: { turnId: "source-turn" },
    lastUserMessageAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    persistence: { provider: "pi", sessionId: "qbo-session", nativeHandle: "qbo-session.jsonl" },
  };
  type Entry = { item: AgentTimelineItem; timestamp: string; turnId: string | undefined; seqStart: number; seqEnd: number };
  const entries: Entry[] = [];
  const append = (item: AgentTimelineItem, turnId?: string) => {
    entries.push({ item, turnId, timestamp: new Date().toISOString(), seqStart: entries.length + 1, seqEnd: entries.length + 1 });
  };
  const sends: Array<{ prompt: string; messageId: string }> = [];
  const handlers = new Map<string, (event: unknown, context?: unknown) => void>();
  const api = {
    getConnectionState: () => ({ status: "connected" }),
    close: async () => undefined,
    agents: { ref: () => ({
      refresh: async () => ({ agent: { ...snapshot } }),
      timeline: { refetch: async (options: { cursor?: { seq: number }; limit: number }) => {
        const end = options.cursor ? options.cursor.seq - 1 : entries.length;
        const start = Math.max(0, end - options.limit);
        return { entries: entries.slice(start, end), epoch: "epoch-1", hasOlder: start > 0, hasNewer: !!options.cursor,
          startCursor: { epoch: "epoch-1", seq: start + 1 }, error: null, gap: false, staleCursor: false };
      } },
      send: async (prompt: string, options: { messageId: string }) => {
        sends.push({ prompt, messageId: options.messageId });
        const turnId = `resend-turn-${sends.length}`;
        append({ type: "user_message", text: prompt, messageId: options.messageId }, turnId);
        snapshot.lastUserMessageAt = new Date().toISOString();
        snapshot.updatedAt = new Date().toISOString();
        snapshot.status = "running";
        snapshot.activeTurn = { turnId };
        handlers.get("agent.turn_started")!({ agent: { id: snapshot.id }, turnId });
      },
    }) },
  } as unknown as PaseoClient;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: config }) }),
    on: (name: string, handler: (event: unknown, context?: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
  } as unknown as PluginServerContext;
  const plugin = contribute(server, async () => api, new QuotaReader(async () => ({ error: "pq disabled in tests" })));
  await plugin.idle();
  const end = async (at: number, turnId: string, outcome: unknown) => {
    mock.timers.setTime(at);
    snapshot.status = (outcome as { kind: string }).kind === "failed" ? "error" : "idle";
    snapshot.activeTurn = null;
    snapshot.updatedAt = new Date().toISOString();
    handlers.get("agent.turn_ended")!({ agent: { id: snapshot.id }, turnId, timeline: entries.map((entry) => entry.item), outcome }, { paseo: api });
    await plugin.idle();
  };
  return {
    store, snapshot, sends, plugin, append, end,
    async started(turnId: string) {
      handlers.get("agent.turn_started")!({ agent: { id: snapshot.id }, turnId });
      await plugin.idle();
    },
    async sweep(at: number) {
      mock.timers.setTime(at);
      mock.timers.tick(30_000);
      await plugin.idle();
    },
    // The original message, Pi's preflight compaction row, and the prompt RPC timing out 60 s later.
    async timeout() {
      append({ type: "user_message", text: ORIGINAL, messageId: "human-original" }, "source-turn");
      append({ type: "compaction", status: "loading", trigger: "auto" }, "source-turn");
      mock.timers.setTime(START + 60_000);
      append({ type: "assistant_message", text: `[System Error] ${TIMEOUT}` });
      await end(START + 60_000, "source-turn", { kind: "failed", error: { message: TIMEOUT } });
    },
    async record() {
      return (await store.read())[0]!;
    },
  };
}

it("a Pi prompt timeout is not resent immediately and waits while Pi is still compacting", async () => {
  await lane(async (lane) => {
    await lane.timeout();
    assert.equal(lane.sends.length, 0, "no immediate send");
    await lane.sweep(START + 10 * 60_000);
    assert.equal(lane.sends.length, 0, "compaction row still loading");
    const record = await lane.record();
    assert.equal(record.state, "parked");
    assert.equal(record.rpcTimeout?.waiting, "compaction-in-progress");
  });
});

it("after compaction ends and the agent stays idle, the original message is resent once and never again", async () => {
  await lane(async (lane) => {
    await lane.timeout();
    mock.timers.setTime(START + 82_000);
    lane.append({ type: "compaction", status: "completed", trigger: "auto" });
    await lane.sweep(START + 100_000);
    assert.equal(lane.sends.length, 0, "inside the quiet window after compaction");
    await lane.sweep(START + 150_000);
    assert.deepEqual(lane.sends.map((send) => send.prompt), [ORIGINAL]);
    lane.append({ type: "assistant_message", text: `[System Error] ${TIMEOUT}` });
    await lane.end(START + 210_000, "resend-turn-1", { kind: "failed", error: { message: TIMEOUT } });
    await lane.sweep(START + 20 * 60_000);
    await lane.sweep(START + 40 * 60_000);
    assert.equal(lane.sends.length, 1, "never sends twice");
    const record = await lane.record();
    assert.equal(record.state, "exhausted");
    assert.equal(record.terminalReason, "rpc-timeout-resend-failed");
  });
});

it("an agent that resumed by itself after the timeout gets no resend", async () => {
  for (const evidence of ["timeline", "turn-started", "turn-ended"]) {
    await lane(async (lane) => {
      await lane.timeout();
      mock.timers.setTime(START + 82_000);
      lane.append({ type: "compaction", status: "completed", trigger: "auto" });
      if (evidence === "timeline") {
        lane.append({ type: "reasoning", text: "Pi runs the pending prompt" }, "autonomous-1");
        lane.append({ type: "assistant_message", text: "Done." }, "autonomous-1");
      } else if (evidence === "turn-started") {
        // The hook alone ends the wait: the snapshot and timeline show nothing new.
        await lane.started("autonomous-1");
      } else {
        await lane.end(START + 120_000, "autonomous-1", { kind: "completed" });
      }
      await lane.sweep(START + 10 * 60_000);
      assert.equal(lane.sends.length, 0, evidence);
      const record = await lane.record();
      assert.equal(record.state, "superseded", evidence);
      assert.equal(record.terminalReason, "agent-resumed-itself", evidence);
    });
  }
});

it("a wait that never settles gives up after 30 minutes with a recorded reason", async () => {
  await lane(async (lane) => {
    await lane.timeout();
    await lane.sweep(START + 29 * 60_000);
    assert.equal((await lane.record()).state, "parked");
    await lane.sweep(START + 31 * 60_000 + 30_000);
    assert.equal(lane.sends.length, 0);
    const record = await lane.record();
    assert.equal(record.state, "exhausted");
    assert.equal(record.terminalReason, "rpc-timeout-wait-expired");
  });
});

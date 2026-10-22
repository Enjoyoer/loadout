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
import { buildFailedTransientRecord, buildRecord, isActive, type AgentSnapshot, type ResumeRecord } from "../server/model.ts";
import { ResumeStore } from "../server/store.ts";

const START = Date.parse("2026-10-13T03:49:59.979Z");
const OVERLOADED = "Our servers are currently overloaded";
const AUTH_UNAVAILABLE = "fleet API error (503): auth_unavailable: no auth available; server_is_overloaded";

async function recoveryLane(run: (lane: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const scratch = path.join(homedir(), ".cache", "fleet-scratch", "loadout", "autoresume-regression");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, "lane-"));
  const oldHome = process.env.PASEO_HOME;
  const oldLog = console.log;
  process.env.PASEO_HOME = home;
  console.log = () => undefined;
  mock.timers.enable({ apis: ["Date", "setInterval"], now: START });
  let lane: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    lane = await setup();
    await run(lane);
  } finally {
    try {
      lane?.plugin();
      await lane?.plugin.idle();
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
    id: "retry-agent", provider: "pi", model: "fleet/gpt-6.1-sol", thinkingOptionId: "xhigh", cwd: "/repo",
    status: "error", lastError: OVERLOADED, requiresAttention: true, attentionReason: "error",
    lastUserMessageAt: new Date(START - 1000).toISOString(), updatedAt: new Date(START).toISOString(),
    persistence: { provider: "pi", sessionId: "retry-session", nativeHandle: "retry-session.jsonl" },
  };
  type Entry = { item: AgentTimelineItem; timestamp: string; turnId: string; seqStart: number; seqEnd: number };
  let entries: Entry[] = [];
  const append = (item: AgentTimelineItem, turnId = "source-turn") => {
    entries.push({ item, turnId, timestamp: new Date().toISOString(), seqStart: entries.length + 1, seqEnd: entries.length + 1 });
  };
  append({ type: "user_message", text: "Finish the task", messageId: "human-original" });
  append({ type: "assistant_message", text: `[System Error] ${OVERLOADED}` });
  const sends: Array<{ prompt: string; messageId: string }> = [];
  const handlers = new Map<string, (event: unknown, context?: unknown) => void>();
  let olderReads = 0;
  let beforeRefresh: (() => void | Promise<void>) | null = null;
  // The daemon run the plugin sees; a test that restarts the daemon changes it.
  let daemonRun = "daemon-run-1";
  const api = {
    getConnectionState: () => ({ status: "connected" }),
    close: async () => undefined,
    agents: { ref: () => ({
      refresh: async () => { await beforeRefresh?.(); return { agent: { ...snapshot } }; },
      timeline: { refetch: async (options: { cursor?: { epoch: string; seq: number }; limit: number }) => {
        const end = options.cursor ? options.cursor.seq - 1 : entries.length;
        const start = Math.max(0, end - options.limit);
        if (options.cursor) olderReads++;
        return { entries: entries.slice(start, end), epoch: "epoch-1", hasOlder: start > 0, hasNewer: !!options.cursor,
          startCursor: { epoch: "epoch-1", seq: start + 1 }, error: null, gap: false, staleCursor: false };
      } },
      send: async (prompt: string, options: { messageId: string }) => {
        sends.push({ prompt, messageId: options.messageId });
        const turnId = `retry-turn-${sends.length}`;
        append({ type: "user_message", text: prompt, messageId: options.messageId }, turnId);
        snapshot.lastUserMessageAt = new Date().toISOString();
        snapshot.updatedAt = new Date().toISOString();
        snapshot.status = "running";
        snapshot.activeTurn = { turnId, startedAt: new Date().toISOString() };
        snapshot.lastError = undefined;
        handlers.get("agent.turn_started")!({ agent: { id: snapshot.id }, turnId });
      },
    }) },
  } as unknown as PaseoClient;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: config }) }),
    on: (name: string, handler: (event: unknown, context?: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
  } as unknown as PluginServerContext;
  // The host's real pq never decides these quota-blind cases.
  const plugin = contribute(server, async () => api, new QuotaReader(async () => ({ error: "pq disabled in tests" })), undefined, undefined, () => daemonRun);
  await plugin.idle();
  return {
    config, store, snapshot, sends, plugin, append,
    olderReads: () => olderReads,
    beforeRefresh: (action: (() => void | Promise<void>) | null) => { beforeRefresh = action; },
    /** Delivers a hook event without waiting for the plugin to settle. */
    emit: (name: string, event: unknown) => handlers.get(name)?.(event, { paseo: api }),
    timeline: () => entries.map((entry) => entry.item),
    /** A daemon restart: a new daemon run, every agent closed, and each user row rebuilt with a new ID and no clientMessageId. */
    restart() {
      daemonRun = `daemon-run-${Number(daemonRun.split("-").at(-1)) + 1}`;
      snapshot.status = "closed";
      entries = entries.map((entry, at) => entry.item.type === "user_message"
        ? { ...entry, item: { type: "user_message", text: entry.item.text, messageId: `rebuilt-${at}` } } : entry);
    },
    async complete(at: number) {
      mock.timers.setTime(at);
      const turnId = snapshot.activeTurn!.turnId;
      append({ type: "assistant_message", text: "Done." }, turnId);
      snapshot.status = "idle";
      snapshot.activeTurn = null;
      snapshot.lastError = undefined;
      snapshot.updatedAt = new Date().toISOString();
      handlers.get("agent.turn_ended")!({ agent: { id: snapshot.id }, turnId, timeline: entries.map((entry) => entry.item), outcome: { kind: "completed" } }, { paseo: api });
    },
    async sweep(at: number) {
      mock.timers.setTime(at);
      mock.timers.tick(30_000);
      await plugin.idle();
    },
    async fail(at: number, message: string, long = false, ambiguous = false) {
      mock.timers.setTime(at);
      const turnId = snapshot.activeTurn?.turnId ?? "source-turn";
      if (long) for (let n = 0; n < 450; n++) append({ type: "reasoning", text: "provider-level retry" }, turnId);
      append({ type: "assistant_message", text: `[System Error] ${message}` }, turnId);
      snapshot.status = "error";
      snapshot.activeTurn = null;
      snapshot.lastError = message;
      snapshot.updatedAt = new Date().toISOString();
      handlers.get("agent.turn_ended")!({ agent: { id: snapshot.id }, turnId,
        timeline: ambiguous ? entries.slice(-200).map((entry) => entry.item) : entries.map((entry) => entry.item),
        outcome: { kind: "failed", error: { message } } }, { paseo: api });
      await plugin.idle();
    },
    async seedUncertain(reason: string) {
      const original = buildFailedTransientRecord(snapshot, entries.map((entry) => entry.item), { message: OVERLOADED }, config, START, "source-turn")!;
      const ownId = `${original.recordId}:attempt:1`;
      append({ type: "user_message", text: "continue", messageId: ownId }, "unobserved-retry");
      for (let n = 0; n < 250; n++) append({ type: "reasoning", text: "provider retry" }, "unobserved-retry");
      append({ type: "assistant_message", text: `[System Error] ${AUTH_UNAVAILABLE}` }, "unobserved-retry");
      snapshot.lastError = AUTH_UNAVAILABLE;
      snapshot.lastUserMessageAt = new Date(START).toISOString();
      const record: ResumeRecord = { ...original, state: "uncertain", terminalReason: reason,
        sentAt: new Date(START).toISOString(), verificationDeadlineAt: new Date(START + 180_000).toISOString(),
        attempts: [{ at: new Date(START).toISOString(), messageId: ownId, result: "sent" }],
        resumeTurnId: "unobserved-retry" };
      await store.upsert(record);
      return record;
    },
  };
}

it("incident: a long failed resume turn ends with a third continue on the five-minute backoff", async () => {
  await recoveryLane(async (lane) => {
    await lane.fail(START, OVERLOADED);
    assert.deepEqual(lane.sends.map((send) => send.prompt), ["continue"]);
    await lane.fail(Date.parse("2026-10-13T03:50:25Z"), OVERLOADED);
    await lane.sweep(Date.parse("2026-10-13T03:52:10Z"));
    assert.equal(lane.sends.length, 2);
    await lane.sweep(Date.parse("2026-10-13T06:00:00Z"));
    assert.equal(lane.sends.length, 2, "no send during the 2h43m running turn");
    await lane.fail(Date.parse("2026-10-13T06:35:30.479Z"), AUTH_UNAVAILABLE, true);
    const [parked] = await lane.store.read();
    assert.equal(parked?.state, "parked");
    assert.equal(parked?.notBefore, "2026-10-13T06:40:30.479Z");
    await lane.sweep(Date.parse("2026-10-13T06:39:42Z"));
    assert.equal(lane.sends.length, 2);
    await lane.sweep(Date.parse("2026-10-13T06:40:12Z"));
    assert.deepEqual(lane.sends.map((send) => send.prompt), ["continue", "continue", "continue"]);
    assert.ok(lane.olderReads() >= 2, "walks back through the long retry to its user row");
    assert.match(lane.sends[2]!.messageId, /:attempt:3$/);
  });
});

it("uncertain transient records re-verify and retry a live failed turn, including ambiguous events and missing prompts", async () => {
  for (const reason of ["retry-turn-ambiguous", "user-prompt-missing"]) {
    await recoveryLane(async (lane) => {
      await lane.seedUncertain(reason);
      if (reason === "user-prompt-missing") {
        lane.snapshot.status = "idle"; // A live idle snapshot still ends in a failed System Error row.
        lane.snapshot.lastError = undefined;
      }
      await lane.sweep(START + 300_000);
      assert.deepEqual(lane.sends.map((send) => send.prompt), ["continue"]);
      assert.match(lane.sends[0]!.messageId, /:attempt:2$/);
      await lane.fail(START + 400_000, OVERLOADED, true, true);
      assert.equal((await lane.store.read())[0]?.state, "uncertain");
      await lane.sweep(START + 800_000);
      assert.equal(lane.sends.length, 2, "truncated retry end event is recovered on the next sweep");
    });
  }
});

it("transient recovery sends nothing while running or after a newer human message, including the pre-send race", async () => {
  for (const change of ["running", "human", "presend-human"]) {
    await recoveryLane(async (lane) => {
      await lane.seedUncertain("retry-turn-ambiguous");
      let refreshes = 0;
      if (change === "running") {
        lane.snapshot.status = "running";
        lane.snapshot.activeTurn = { turnId: "unobserved-retry" };
      } else if (change === "human") {
        lane.append({ type: "user_message", text: "New task", messageId: "human-new" });
        lane.snapshot.lastUserMessageAt = new Date(START + 1000).toISOString();
      } else {
        lane.beforeRefresh(() => {
          if (!lane.sends.length && lane.snapshot.status === "error") {
            // The fifth refresh is the final read after the claim, not the recovery or timeline send gates.
            refreshes++;
            if (refreshes === 5) {
              lane.append({ type: "user_message", text: "New task", messageId: "human-new" });
              lane.snapshot.lastUserMessageAt = new Date(START + 1000).toISOString();
              lane.snapshot.updatedAt = new Date(START + 1000).toISOString();
            }
          }
        });
      }
      await lane.sweep(START + 300_000);
      await lane.sweep(START + 900_000);
      assert.equal(lane.sends.length, 0, change);
      const [record] = await lane.store.read();
      assert.equal(record?.state, change === "running" ? "uncertain" : "superseded");
      if (change === "presend-human") assert.equal(record?.attempts.length, 1, "cancelled claim leaves no extra attempt");
    });
  }
});

/** Lets the plugin's pending work run while a hook handler is held, so the test cannot wait for idle(). */
async function settles(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = performance.now() + 5_000;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

it("a rebuilt timeline keeps a waiting retry, before its first send or after its own continue, until a newer user message", async () => {
  // Quota held the first retry, so nothing was sent; the daemon restarts and rebuilds the original human row.
  await recoveryLane(async (lane) => {
    const record = buildFailedTransientRecord(lane.snapshot, lane.timeline(), { message: OVERLOADED }, lane.config, START, "source-turn")!;
    await lane.store.upsert({ ...record, state: "parked", quotaHold: { until: new Date(START - 1).toISOString(), reason: "quota held the first retry" } });
    lane.restart();
    await lane.sweep(START);
    assert.deepEqual(lane.sends.map((send) => send.prompt), ["continue"]);
    assert.equal((await lane.store.read())[0]?.state, "verifying");
  });
  // A failed retry waits in uncertain behind a permission request; the permission clears and the daemon restarts,
  // rebuilding the plugin's own continue. With lastUserMessageAt unchanged it is still that continue.
  for (const newer of [false, true]) {
    await recoveryLane(async (lane) => {
      await lane.fail(START, OVERLOADED);
      await lane.fail(START + 25_000, OVERLOADED);
      lane.snapshot.pendingPermissions = [{ id: "permission-1" }];
      await lane.sweep(START + 150_000);
      assert.equal((await lane.store.read())[0]?.state, "uncertain");
      lane.snapshot.pendingPermissions = [];
      lane.restart();
      if (newer) {
        // A newer human message with the same text: the rebuilt row looks the same, but lastUserMessageAt moved.
        lane.append({ type: "user_message", text: "continue", messageId: "human-new" }, "human-turn");
        lane.snapshot.lastUserMessageAt = new Date(START + 200_000).toISOString();
      }
      await lane.sweep(START + 300_000);
      const [stored] = await lane.store.read();
      if (newer) {
        assert.equal(lane.sends.length, 1);
        assert.equal(stored?.state, "superseded");
        assert.equal(stored?.terminalReason, "newer-user-message");
      } else {
        assert.equal(lane.sends.length, 2);
        assert.match(lane.sends[1]!.messageId, /:attempt:2$/);
        assert.equal(stored?.state, "verifying");
      }
    });
  }
});

it("an explicit close ends a waiting retry, while a close from a daemon shutdown is cleared by the next daemon run", async () => {
  for (const close of ["explicit", "shutdown"]) {
    await recoveryLane(async (lane) => {
      await lane.fail(START, OVERLOADED);
      await lane.fail(START + 25_000, OVERLOADED);
      // The retry is due at START + 145 s; each sweep runs 30 s after the time it is given.
      const closedAt = START + 120_000;
      mock.timers.setTime(closedAt);
      lane.snapshot.status = "closed";
      lane.emit("agent.closed", { agent: { id: lane.snapshot.id } });
      await lane.plugin.idle();
      assert.ok((await lane.store.read())[0]?.agentClosed, "the close is marked on the waiting record");
      if (close === "shutdown") lane.restart();
      // Due, 30 s after the close.
      await lane.sweep(closedAt);
      if (close === "shutdown") {
        assert.equal(lane.sends.length, 2, "a new daemon run retries on the schedule");
        const [stored] = await lane.store.read();
        assert.equal(stored?.agentClosed, null);
        assert.equal(stored?.state, "verifying");
        return;
      }
      assert.equal(lane.sends.length, 1, "nothing is sent while the close is not decided");
      assert.equal((await lane.store.read())[0]?.state, "parked");
      // This daemon run outlived the close, so it was a kill or close by a user or an agent.
      await lane.sweep(closedAt + 40_000);
      const [stored] = await lane.store.read();
      assert.equal(stored?.state, "superseded");
      assert.equal(stored?.terminalReason, "agent-closed");
      lane.snapshot.status = "idle";
      await lane.sweep(closedAt + 3_600_000);
      assert.equal(lane.sends.length, 1, "an agent reopened later gets no retry");
    });
  }
});

it("a duplicate end event for a failed usage resume turn never resets or resends the successor after it succeeded", async () => {
  await recoveryLane(async (lane) => {
    lane.snapshot.lastError = "usage_limit_exceeded";
    const usage = buildRecord(lane.snapshot, "usage_limit_exceeded", undefined, lane.config, START - 6 * 3600_000, "source-turn", true)!;
    await lane.store.upsert({ ...usage, state: "parked", notBefore: new Date(START).toISOString() });
    await lane.sweep(START);
    assert.equal(lane.sends.length, 1);
    // The resume turn fails on the usage limit again, and its end is delivered twice. The first handler is held at
    // its agent read until the other one has handed off and the successor has resumed and succeeded.
    const turnId = lane.snapshot.activeTurn!.turnId;
    lane.append({ type: "assistant_message", text: "[System Error] usage_limit_exceeded" }, turnId);
    Object.assign(lane.snapshot, { status: "error", activeTurn: null, lastError: "usage_limit_exceeded", updatedAt: new Date().toISOString() });
    const event = { agent: { id: lane.snapshot.id }, turnId, outcome: { kind: "failed", error: { message: "usage_limit_exceeded" } }, timeline: lane.timeline() };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    lane.beforeRefresh(async () => { if (!held) { held = true; await barrier; } });
    lane.emit("agent.turn_ended", event);
    await settles(() => held, "the first handler's agent read");
    lane.emit("agent.turn_ended", structuredClone(event));
    const successor = async () => (await lane.store.read()).find((record) => record.sourceTurnId === turnId);
    await settles(async () => (await successor())?.state === "parked", "the successor");
    mock.timers.setTime(Date.parse((await successor())!.notBefore));
    mock.timers.tick(30_000);
    await settles(async () => (await successor())?.state === "verifying", "the successor's resume");
    await lane.complete(Date.now() + 60_000);
    await settles(async () => (await successor())?.state === "done", "the successor's success");
    release();
    await lane.plugin.idle();
    let next = await successor();
    assert.equal(next?.state, "done");
    assert.equal(next?.attempts.length, 1);
    await lane.sweep(Date.now() + 24 * 3600_000);
    next = await successor();
    assert.equal(next?.state, "done");
    assert.equal(lane.sends.length, 2);
    assert.equal((await lane.store.read()).filter(isActive).length, 0);
  });
});

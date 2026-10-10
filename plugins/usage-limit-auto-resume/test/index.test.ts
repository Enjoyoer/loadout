import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { ConfigSchema } from "../server/config.ts";
import { buildRecord, type AgentSnapshot, type ResumeRecord } from "../server/model.ts";
import { ResumeStore } from "../server/store.ts";

const agent: AgentSnapshot = {
  id: "agent-1",
  workspaceId: "workspace-1",
  provider: "claude",
  model: "claude-opus-5-5[1m]",
  currentModeId: "bypassPermissions",
  thinkingOptionId: "low",
  cwd: "/repo",
  status: "idle",
  persistence: { provider: "claude", sessionId: "session-1", nativeHandle: "native-1" },
};

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "condition not reached");
}

/** Rejects unless `promise` settles within `ms`, so a barrier that never opens fails the test instead of passing on. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The plugin instances one test starts. dispose() runs each one's cleanup (timer, hooks, client), even when the test
 * failed before its own cleanup call, then waits until the startup chain, sweeps and hook handlers each plugin still
 * has running have finished, and with them their state writes. Tests release the gates they own, then dispose, and
 * remove PASEO_HOME only once dispose() has returned, so nothing a plugin started writes to a removed home or logs
 * into a later test's captured console. If that work has not settled within the bound, dispose() throws and the test
 * keeps the home instead of deleting it under a write still in flight.
 */
function pluginTracker() {
  const started: Array<ReturnType<typeof contribute>> = [];
  return {
    start(server: PluginServerContext, open: Parameters<typeof contribute>[1]) {
      const plugin = contribute(server, open);
      started.push(plugin);
      return plugin;
    },
    async dispose(home: string) {
      for (const plugin of started) plugin();
      try {
        await within(Promise.all(started.map((plugin) => plugin.idle())), 10_000, "the plugin's startup, sweeps and hook handlers settling");
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; kept PASEO_HOME ${home}`);
      }
    },
  };
}

/**
 * Fires the poll interval until the next sweep has run to completion. A sweep starts only after the previous one has
 * returned (the plugin's running guard) and reads settings first, so a further sweep reading settings is the signal
 * that the next one finished. Needs mocked setInterval timers.
 */
async function completeNextSweep(settingsReads: () => number, intervalMs: number): Promise<void> {
  const before = settingsReads();
  for (const target of [before + 1, before + 2]) {
    await until(() => {
      if (settingsReads() < target) mock.timers.tick(intervalMs);
      return settingsReads() >= target;
    });
  }
}

it("opens a fresh daemon client on the sweep after the cached client's transport died", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-sweep-"));
  const plugins = pluginTracker();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  console.log = () => undefined;
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const config = ConfigSchema.parse({ armed: true, pollIntervalSeconds: 5 });
    // A five-hour usage record stays parked (not-due), so every sweep fetches the agent through the cached client.
    await new ResumeStore().upsert(buildRecord(agent, "out of credits", undefined, config, Date.now(), "turn-1")!);
    const clients: Array<{ status: string; closed: boolean; refreshes: number }> = [];
    const open = async () => {
      const state = { status: "connected", closed: false, refreshes: 0 };
      clients.push(state);
      return {
        getConnectionState: () => ({ status: state.status }),
        close: async () => { state.closed = true; },
        agents: { ref: () => ({ refresh: async () => {
          state.refreshes += 1;
          if (state.status !== "connected") throw new Error("Transport not connected");
          return { agent };
        } }) },
      } as unknown as PaseoClient;
    };
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r1", values: config }) }),
      on: () => () => undefined,
    } as unknown as PluginServerContext;
    const cleanup = plugins.start(server, open);
    await until(() => clients[0]?.refreshes === 1);
    await new Promise((resolve) => setImmediate(resolve));
    clients[0]!.status = "disconnected"; // the transport was disposed, as after liveness timeouts during sleep
    mock.timers.tick(5000);
    await until(() => clients[1]?.refreshes === 1);
    assert.equal(clients.length, 2);
    assert.equal(clients[0]!.closed, true);
    assert.equal(clients[0]!.refreshes, 1);
    (cleanup as () => void)();
  } finally {
    try {
      await plugins.dispose(home);
    } finally {
      mock.timers.reset();
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

it("leaves the record parked when the send fails because the transport is not connected", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-send-"));
  const plugins = pluginTracker();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (line: string) => { logs.push(line); };
  try {
    const config = ConfigSchema.parse({ armed: true });
    // Detected six hours ago, so the five-hour usage record is due on the first sweep.
    const record = buildRecord(agent, "out of credits", undefined, config, Date.now() - 6 * 3600_000, "turn-1")!;
    await new ResumeStore().upsert(record);
    let sends = 0;
    const open = async () => ({
      getConnectionState: () => ({ status: "connected" }),
      close: async () => undefined,
      agents: { ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => { sends += 1; throw new Error("Transport not connected (status: disconnected)"); },
      }) },
    } as unknown as PaseoClient);
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r1", values: config }) }),
      on: () => () => undefined,
    } as unknown as PluginServerContext;
    const cleanup = plugins.start(server, open);
    await until(() => logs.some((line) => line.includes("send-deferred")));
    (cleanup as () => void)();
    assert.equal(sends, 1);
    const [stored] = await new ResumeStore().read();
    assert.equal(stored?.state, "parked");
    assert.equal(stored?.terminalReason, null);
    assert.deepEqual(stored?.attempts, []);
  } finally {
    try {
      await plugins.dispose(home);
    } finally {
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps the turn identity and deadline when a turn starts during a claim and the send then loses its transport", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-race-"));
  const plugins = pluginTracker();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (line: string) => { logs.push(line); };
  try {
    const config = ConfigSchema.parse({ armed: true });
    const record = buildRecord(agent, "out of credits", undefined, config, Date.now() - 6 * 3600_000, "turn-1")!;
    const store = new ResumeStore();
    await store.upsert(record);
    const handlers = new Map<string, (event: unknown) => void>();
    let claimedDeadline: string | null = null;
    const open = async () => ({
      getConnectionState: () => ({ status: "connected" }),
      close: async () => undefined,
      agents: { ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => {
          claimedDeadline = (await store.read())[0]!.verificationDeadlineAt;
          handlers.get("agent.turn_started")!({ turnId: "turn-2", agent: { id: agent.id } });
          for (let attempt = 0; attempt < 200 && !(await store.read())[0]!.resumeTurnId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("Transport not connected (status: disconnected)");
        },
      }) },
    } as unknown as PaseoClient);
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r1", values: config }) }),
      on: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
    } as unknown as PluginServerContext;
    const cleanup = plugins.start(server, open);
    await until(() => logs.some((line) => line.includes("resume-uncertain") || line.includes("send-deferred")));
    (cleanup as () => void)();
    const [stored] = await store.read();
    assert.equal(stored?.state, "uncertain");
    assert.equal(stored?.resumeTurnId, "turn-2");
    assert.ok(claimedDeadline);
    assert.equal(stored?.verificationDeadlineAt, claimedDeadline);
    assert.equal(stored?.attempts.length, 1);
  } finally {
    try {
      await plugins.dispose(home);
    } finally {
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps the turn from a claim when the rollback commits before the turn-start handler's store write", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-late-turn-"));
  const plugins = pluginTracker();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (line: string) => { logs.push(line); };
  mock.timers.enable({ apis: ["setInterval"] });
  // Hold the store write the handler makes while it is dispatched until the rollback has committed.
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  let handlerWrite: Promise<unknown> | null = null;
  let holdingHandler = false;
  const update = ResumeStore.prototype.update;
  mock.method(ResumeStore.prototype, "update", function (this: ResumeStore, ...args: Parameters<ResumeStore["update"]>) {
    if (!holdingHandler) return update.apply(this, args);
    handlerWrite = handlerGate.then(() => update.apply(this, args));
    return handlerWrite;
  });
  try {
    const config = ConfigSchema.parse({ armed: true, pollIntervalSeconds: 5 });
    const record = buildRecord(agent, "out of credits", undefined, config, Date.now() - 6 * 3600_000, "turn-1")!;
    const store = new ResumeStore();
    await store.upsert(record);
    const handlers = new Map<string, (event: unknown) => void>();
    let sends = 0;
    let settingsReads = 0;
    let claimedDeadline: string | null = null;
    const open = async () => ({
      getConnectionState: () => ({ status: "connected" }),
      close: async () => undefined,
      agents: { ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => {
          sends += 1;
          claimedDeadline = (await store.read())[0]!.verificationDeadlineAt;
          holdingHandler = true;
          handlers.get("agent.turn_started")!({ turnId: "turn-2", agent: { id: agent.id } });
          holdingHandler = false;
          throw new Error("Transport not connected (status: disconnected)");
        },
      }) },
    } as unknown as PaseoClient);
    const server = {
      registerSettings: () => ({ read: async () => { settingsReads += 1; return { status: "ready", revision: "r1", values: config }; } }),
      on: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
    } as unknown as PluginServerContext;
    const cleanup = plugins.start(server, open);
    await until(() => logs.some((line) => line.includes("resume-uncertain") || line.includes("send-deferred")));
    assert.notEqual((await store.read())[0]?.state, "resuming", "rollback committed while the handler is still held");
    assert.ok(handlerWrite, "the handler's write was held");
    releaseHandler();
    await handlerWrite;
    const [stored] = await store.read();
    assert.equal(stored?.state, "uncertain");
    assert.equal(stored?.resumeTurnId, "turn-2");
    assert.ok(claimedDeadline);
    assert.equal(stored?.verificationDeadlineAt, claimedDeadline);
    assert.equal(stored?.attempts.length, 1);
    // The next sweep must not send again.
    await completeNextSweep(() => settingsReads, 5000);
    assert.equal(sends, 1);
    (cleanup as () => void)();
  } finally {
    // A held handler write never lands on its own; open the gate so the plugin can settle before it is drained.
    releaseHandler();
    try {
      await plugins.dispose(home);
    } finally {
      mock.restoreAll();
      mock.timers.reset();
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    // Windows can still hold a just-written file open for a moment; retry rather than mask a failure.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

it("keeps the turn from a claim when it starts while the rollback write is still being persisted", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-rollback-write-"));
  const plugins = pluginTracker();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (line: string) => { logs.push(line); };
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const config = ConfigSchema.parse({ armed: true, pollIntervalSeconds: 5 });
    const record = buildRecord(agent, "out of credits", undefined, config, Date.now() - 6 * 3600_000, "turn-1")!;
    const store = new ResumeStore();
    await store.upsert(record);
    const handlers = new Map<string, (event: unknown) => void>();
    let sends = 0;
    let settingsReads = 0;
    let claimedDeadline: string | null = null;
    let sendFailed = false;
    let holdingRollback = false;
    // Acknowledged with the handler's queued store write; wrapped so the barrier does not wait for the write itself.
    let acknowledgeHandlerWrite!: (write: { queued: Promise<unknown> }) => void;
    const handlerWriteQueued = new Promise<{ queued: Promise<unknown> }>((resolve) => { acknowledgeHandlerWrite = resolve; });
    const held: { barrier?: Promise<{ queued: Promise<unknown> }> } = {};
    const update = ResumeStore.prototype.update;
    mock.method(ResumeStore.prototype, "update", function (this: ResumeStore, ...args: Parameters<ResumeStore["update"]>) {
      const queued = update.apply(this, args);
      // The sweep waits on the held rollback, so a write requested meanwhile is the handler's; it is queued now.
      if (holdingRollback) acknowledgeHandlerWrite({ queued });
      return queued;
    });
    type Persisting = { persist(records: ResumeRecord[]): Promise<void> };
    const persist = (ResumeStore.prototype as unknown as Persisting).persist;
    mock.method(ResumeStore.prototype as unknown as Persisting, "persist", async function (this: Persisting, records: ResumeRecord[]) {
      // The rollback updater has already produced parked; deliver turn_started before that write lands.
      if (sendFailed && !holdingRollback && records.find((value) => value.recordId === record.recordId)?.state === "parked") {
        holdingRollback = true;
        handlers.get("agent.turn_started")!({ turnId: "turn-2", agent: { id: agent.id } });
        held.barrier = within(handlerWriteQueued, 1000, "the handler's store write queuing behind the held rollback");
        await held.barrier;
      }
      return persist.call(this, records);
    });
    const open = async () => ({
      getConnectionState: () => ({ status: "connected" }),
      close: async () => undefined,
      agents: { ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => {
          sends += 1;
          claimedDeadline = (await store.read())[0]!.verificationDeadlineAt;
          sendFailed = true;
          throw new Error("Transport not connected (status: disconnected)");
        },
      }) },
    } as unknown as PaseoClient);
    const server = {
      registerSettings: () => ({ read: async () => { settingsReads += 1; return { status: "ready", revision: "r1", values: config }; } }),
      on: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
    } as unknown as PluginServerContext;
    const cleanup = plugins.start(server, open);
    await until(() => held.barrier !== undefined);
    // Rejects if the handler's write never queued while the rollback write was held.
    const handlerWrite = await held.barrier!;
    await handlerWrite.queued;
    await until(() => logs.some((line) => line.includes("resume-uncertain") || line.includes("send-deferred")));
    const [stored] = await store.read();
    assert.equal(stored?.state, "uncertain");
    assert.equal(stored?.resumeTurnId, "turn-2");
    assert.ok(claimedDeadline);
    assert.equal(stored?.verificationDeadlineAt, claimedDeadline);
    assert.equal(stored?.attempts.length, 1);
    // The next sweep must not send again.
    await completeNextSweep(() => settingsReads, 5000);
    assert.equal(sends, 1);
    (cleanup as () => void)();
  } finally {
    try {
      await plugins.dispose(home);
    } finally {
      mock.restoreAll();
      mock.timers.reset();
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    // Windows can still hold a just-written file open for a moment; retry rather than mask a failure.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

it("sends nothing when a permission request's decision lands between the send gates and the resume claim", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-claim-"));
  const plugins = pluginTracker();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (line: string) => { logs.push(line); };
  try {
    const config = ConfigSchema.parse({ armed: true });
    const record: ResumeRecord = { ...buildRecord(agent, "out of credits", undefined, config, Date.now() - 6 * 3600_000, "turn-1")!, state: "parked" };
    const store = new ResumeStore();
    await store.upsert(record);
    const handlers = new Map<string, (event: unknown) => void>();
    let sends = 0;
    // The gates have passed and the claim is the sweep's first store write. Deliver the permission request first and
    // let its handler store its decision before the claim's write runs.
    let holdClaim = true;
    let permissionStored: Promise<void> | null = null;
    const update = ResumeStore.prototype.update;
    mock.method(ResumeStore.prototype, "update", function (this: ResumeStore, ...args: Parameters<ResumeStore["update"]>) {
      if (!holdClaim) return update.apply(this, args);
      holdClaim = false;
      handlers.get("agent.permission_requested")!({ agent: { id: agent.id } });
      permissionStored = (async () => {
        for (let attempt = 0; attempt < 200 && (await store.read())[0]?.state !== "uncertain"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      })();
      return permissionStored.then(() => update.apply(this, args));
    });
    const open = async () => ({
      getConnectionState: () => ({ status: "connected" }),
      close: async () => undefined,
      agents: { ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => { sends += 1; },
      }) },
    } as unknown as PaseoClient);
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r1", values: config }) }),
      on: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
    } as unknown as PluginServerContext;
    const cleanup = plugins.start(server, open);
    await until(() => logs.some((line) => line.includes("send-skipped") || line.includes("resume-sent")));
    assert.ok(permissionStored, "the claim's write was held behind the permission request");
    await permissionStored;
    (cleanup as () => void)();
    assert.equal(sends, 0);
    const [stored] = await store.read();
    assert.equal(stored?.state, "uncertain");
    assert.equal(stored?.terminalReason, "permission-requested");
    assert.deepEqual(stored?.attempts, []);
  } finally {
    try {
      await plugins.dispose(home);
    } finally {
      mock.restoreAll();
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

it("keeps verifying a long resumed turn whose only newer user message is the resume itself", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-verify-"));
  const plugins = pluginTracker();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (line: string) => { logs.push(line); };
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const config = ConfigSchema.parse({ armed: true, pollIntervalSeconds: 5 });
    const record = buildRecord(agent, "out of credits", undefined, config, Date.now() - 6 * 3600_000, "turn-1")!;
    const store = new ResumeStore();
    await store.upsert(record);
    const handlers = new Map<string, (event: unknown) => void>();
    let settingsReads = 0;
    let snapshot: AgentSnapshot = agent;
    let latestUser: { type: "user_message"; text: string; messageId: string } | null = null;
    const open = async () => ({
      getConnectionState: () => ({ status: "connected" }),
      close: async () => undefined,
      agents: { ref: () => ({
        refresh: async () => ({ agent: snapshot }),
        send: async (text: string, options: { messageId: string }) => {
          // The resume is a user message: the agent's latest user time moves on and the resumed turn keeps running.
          latestUser = { type: "user_message", text, messageId: options.messageId };
          snapshot = { ...agent, status: "running", activeTurn: { turnId: "turn-2" }, lastUserMessageAt: new Date().toISOString() };
          handlers.get("agent.turn_started")!({ turnId: "turn-2", agent: { id: agent.id } });
        },
        timeline: { refetch: async () => ({ entries: latestUser ? [{ item: latestUser }] : [], error: null, gap: false, staleCursor: false, hasNewer: false }) },
      }) },
    } as unknown as PaseoClient);
    const server = {
      registerSettings: () => ({ read: async () => { settingsReads += 1; return { status: "ready", revision: "r1", values: config }; } }),
      on: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
    } as unknown as PluginServerContext;
    const cleanup = plugins.start(server, open);
    await until(() => logs.some((line) => line.includes("resume-sent")));
    await completeNextSweep(() => settingsReads, 5000);
    let [stored] = await store.read();
    assert.equal(stored?.state, "verifying");
    assert.equal(stored?.resumeTurnId, "turn-2");
    assert.equal(stored?.lastUserMessageAt, snapshot.lastUserMessageAt);
    // A genuinely newer request still supersedes the record.
    latestUser = { type: "user_message", text: "Stop and do something else.", messageId: "user-2" };
    snapshot = { ...snapshot, lastUserMessageAt: new Date(Date.now() + 1000).toISOString() };
    await completeNextSweep(() => settingsReads, 5000);
    [stored] = await store.read();
    assert.equal(stored?.state, "superseded");
    assert.equal(stored?.terminalReason, "newer-user-message");
    (cleanup as () => void)();
  } finally {
    try {
      await plugins.dispose(home);
    } finally {
      mock.timers.reset();
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

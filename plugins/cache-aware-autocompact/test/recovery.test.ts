import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PaseoAgent, PaseoClient, PaseoAgentUpdateHandler, PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { FetchAgentTimelinePayload } from "@getpaseo/client/internal/daemon-client";
import type { PluginServerContext, PluginLifecycleEvents, PluginHookContext } from "@getpaseo/plugin/server";
import { defaultConfig } from "../server/config.ts";
import { rearmSkipReason, recoverTurn, recoveryHistory, recoveryDelay, REARM_JITTER_MIN_MS, REARM_JITTER_MAX_MS } from "../server/recovery.ts";
import { startScheduler, type Checkpoint } from "../server/runtime.ts";
import { StateStore, type WriteJson } from "../server/store.ts";
import type { TimerApi } from "../server/timer.ts";
import { writeJsonAtomically } from "../server/vendor/atomic-json.ts";

const endedAt = "2026-09-26T08:00:00.000Z";
const messageAt = "2026-09-26T07:55:00.000Z";
const endedMs = Date.parse(endedAt);
const config = defaultConfig({ armed: true });
function agent(overrides: Partial<PaseoAgent> = {}): PaseoAgent {
  return { id: "a1", provider: "claude", cwd: process.cwd(), workspaceId: "w1", model: "model",
    createdAt: messageAt, updatedAt: endedAt, lastUserMessageAt: messageAt, status: "idle", activeTurn: null,
    capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: true,
      supportsMcpServers: true, supportsReasoningStream: true, supportsToolInvocations: true },
    currentModeId: null, availableModes: [], pendingPermissions: [], persistence: null,
    lastUsage: { contextWindowUsedTokens: 200_000 }, title: null, labels: {},
    attentionReason: "finished", attentionTimestamp: endedAt, archivedAt: null, ...overrides };
}
function history(a: PaseoAgent, turnId: string | undefined = "t1"): FetchAgentTimelinePayload {
  return { requestId: "r1", agentId: a.id, agent: a, direction: "tail", projection: "canonical",
    epoch: "e1", reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, error: null,
    entries: [{ provider: a.provider, item: { type: "assistant_message", text: "Work completed." },
      turnId, timestamp: endedAt, seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [] }] };
}
class FakeTimers implements TimerApi {
  next = 0;
  pending = new Map<number, { callback: () => void; ms: number }>();
  setTimeout(callback: () => void, ms: number) { const id = ++this.next; this.pending.set(id, { callback, ms }); return id; }
  clearTimeout(id: unknown) { this.pending.delete(id as number); }
  fire() { const timers = [...this.pending]; this.pending.clear(); for (const [, timer] of timers) timer.callback(); }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.fail("Timed out waiting for scheduler");
}
async function fixture(run: (f: ReturnType<typeof harness> & { store: StateStore; file: string }) => Promise<void>) {
  const root = path.resolve("node_modules/.cache");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "rearm-test-"));
  const file = path.join(dir, "state.json");
  const f = { ...harness(), file, store: new StateStore(file) };
  // Drain every scheduler and store before the directory goes, so no state write is still landing in it.
  // rm still retries, since Windows can hold a just-written file open briefly.
  try { await run(f); } finally { await f.dispose(f.store); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
}
function harness() {
  let snapshots = [agent()];
  let now = endedMs + 30 * 60_000;
  let bootstrapFails = false;
  let compactFails = false;
  let sendGate: Promise<void> | null = null;
  let cleanup: () => Promise<void> = async () => {};
  // Every scheduler started and every store handed to one, for the final teardown.
  const stops: Array<() => Promise<void>> = [];
  const stores = new Set<StateStore>();
  let writeJson: WriteJson | undefined;
  let snapshotListener: (() => void) | undefined;
  const updates = new Set<PaseoAgentUpdateHandler>();
  const hooks = new Map<string, (event: never, context: PluginHookContext) => unknown>();
  const logs: { action: string; data: Record<string, unknown> }[] = [];
  const sends: string[] = [];
  const timers = new FakeTimers();
  const histories = new Map<string, FetchAgentTimelinePayload>();
  const historyErrors = new Map<string, Error>();
  const metrics: Record<string, unknown>[] = [];
  let pageSize = 200;
  let historyGate: Promise<void> | null = null;
  let historyCalls = 0;
  let listCalls = 0;
  const api = {
    agents: {
      async list(options: { subscribe?: {}; page?: { cursor?: string } } = {}) {
        if (!options.subscribe) listCalls++;
        const offset = Number(options.page?.cursor ?? 0);
        return { entries: snapshots.slice(offset, offset + pageSize).map((a) => ({ agent: a })),
          pageInfo: { hasMore: offset + pageSize < snapshots.length, nextCursor: offset + pageSize < snapshots.length ? String(offset + pageSize) : null },
          subscription: { subscribe(observer: { snapshot: () => void }) { snapshotListener = observer.snapshot; observer.snapshot(); return () => {}; } } };
      },
      ref(id: string) {
        return { refresh: async () => ({ agent: snapshots.find((a) => a.id === id) }),
          timeline: { refetch: async () => {
            historyCalls++; await historyGate;
            if (historyErrors.has(id)) throw historyErrors.get(id);
            return histories.get(id) ?? history(snapshots.find((a) => a.id === id)!);
          } },
          waitForFinish: async () => ({ status: "idle", final: null, error: null, lastMessage: null }),
          send: async (text: string) => {
            sends.push(text);
            await sendGate;
            const page = histories.get(id) ?? history(snapshots.find(a => a.id === id)!);
            const seq = (page.entries.at(-1)?.seqEnd ?? 0) + 1;
            page.entries.push({ ...page.entries[0]!, seqStart: seq, seqEnd: seq, item: { type: "compaction", status: "completed" } });
            if (compactFails) page.entries.push({ ...page.entries[0]!, seqStart: seq + 1, seqEnd: seq + 1, item: { type: "assistant_message", text: "[Error] Failed to compact context: Server is temporarily limiting requests" } });
            histories.set(id, page);
          } };
      },
      subscribe(listener: PaseoAgentUpdateHandler) { updates.add(listener); return () => { updates.delete(listener); }; },
    },
    close: async () => {},
  } as unknown as PaseoClient;
  const server = { on(name: string, callback: (event: never, context: PluginHookContext) => unknown) {
    hooks.set(name, callback); return () => { hooks.delete(name); };
  } } as unknown as PluginServerContext;
  return {
    timers, logs, sends, histories, historyErrors, metrics, api,
    setAgents(agents: PaseoAgent[]) { snapshots = agents; },
    setNow(value: number) { now = value; },
    failBootstrap() { bootstrapFails = true; },
    failCompact() { compactFails = true; },
    pauseSend(gate: Promise<void> | null) { sendGate = gate; },
    paginate(size: number) { pageSize = size; },
    pauseHistory(gate: Promise<void>) { historyGate = gate; },
    historyCalls() { return historyCalls; },
    listCalls() { return listCalls; },
    snapshot() { snapshotListener?.(); },
    update(a: PaseoAgent) { snapshots = snapshots.map((previous) => previous.id === a.id ? a : previous); for (const listener of updates) listener({ kind: "upsert", agent: a }); },
    event<Name extends keyof PluginLifecycleEvents>(name: Name, event: PluginLifecycleEvents[Name], contextApi = api) {
      hooks.get(name)?.(event as never, { paseo: contextApi, signal: new AbortController().signal });
    },
    writeStateWith(writer: WriteJson) { writeJson = writer; },
    start(store: StateStore | undefined, armed = true, piGptEnabled = false, extendIdleCompaction = true) {
      if (store) stores.add(store);
      cleanup = startScheduler(server, { store, writeJson, timerApi: timers, metrics: { append: async (record) => { metrics.push(record); } },
        now: () => now, random: () => 0.5, readConfig: async () => defaultConfig({ armed, piGptEnabled, extendIdleCompaction }),
        openApi: async () => { if (bootstrapFails) throw new Error("Unavailable"); return api; },
        log: (action, data) => { logs.push({ action, data }); } });
      stops.push(cleanup);
    },
    cleanup() { return cleanup(); },
    // Final teardown only; a test reloading the scheduler calls cleanup() and may pass the same store again.
    // Stops every scheduler (again, for those already stopped, which is harmless), then closes every store
    // passed in, since a scheduler leaves those open: close waits for the store's write in flight and drops later ones.
    async dispose(...owned: StateStore[]) {
      for (const stop of stops) await stop();
      for (const store of new Set([...stores, ...owned])) await store.close();
    },
    async recovered() { await until(() => logs.some((line) => line.action === "rearm-summary")); },
  };
}

describe("Pi scheduler", () => {
  it("retains the request time and re-arms a real user turn racing a failed result", async () => fixture(async (f) => {
    let release = () => {};
    f.pauseSend(new Promise<void>(resolve => { release = resolve; }));
    f.failCompact(); f.start(f.store); await f.recovered();
    f.timers.fire(); await until(() => f.sends.length === 1);
    const next = agent({ lastUserMessageAt: "2026-09-26T08:31:00.000Z" });
    f.setNow(endedMs + 32 * 60_000); f.update(next);
    const page = history(next, "real-user");
    page.entries[0] = { ...page.entries[0]!, timestamp: next.lastUserMessageAt!, item: { type: "user_message", text: "New real request" } };
    f.histories.set(next.id, page);
    f.event("agent.turn_ended", { agent: { ...next, parentAgentId: null }, turnId: "real-user", timeline: [page.entries[0]!.item], outcome: { kind: "completed" } } as PluginLifecycleEvents["agent.turn_ended"]);
    f.pauseSend(null); release();
    await until(() => f.logs.some(l => l.action === "compaction-failed") && f.timers.pending.size === 1);
    const failed = (await f.store.read()).find(entry => entry.outcome === "compaction-failed")!;
    assert.equal(failed.attemptedAt, "2026-09-26T08:30:00.000Z");
    assert.equal(failed.createdAt, "2026-09-26T08:32:00.000Z");
    f.timers.fire(); await until(() => f.logs.filter(l => l.action === "compaction-failed").length === 2);
  }));
  it("does not treat an automatic compact user row as a new real user turn", async () => fixture(async (f) => {
    await f.store.append({ key: "a1:old", agentId: "a1", turnId: "old", lastUserMessageAt: messageAt,
      createdAt: "2026-09-26T08:10:00Z", outcome: "compaction-failed", reason: "canceled" }, 100);
    const a = agent({ lastUserMessageAt: "2026-09-26T08:11:00Z", attentionTimestamp: "2026-09-26T08:12:00Z" });
    const page = history(a); page.entries[0] = { ...page.entries[0]!, timestamp: "2026-09-26T08:12:00Z", item: { type: "user_message", text: "/compact" } };
    f.setAgents([a]); f.histories.set(a.id, page); f.start(f.store); await f.recovered();
    f.timers.fire(); await until(() => f.logs.some(l => l.data.reason === "compaction-backoff"));
    assert.deepEqual(f.sends, []);
    await f.cleanup(); f.start(f.store); await until(() => f.timers.pending.size === 1);
    f.timers.fire(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.sends, []);
  }));
  it("skips GPT by default and backs off native compact failure until a real user turn", async () => fixture(async (f) => {
    f.setAgents([agent({ provider: "pi", model: "fleet/gpt-6.1-sol" })]);
    f.start(f.store); await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    await f.cleanup();
    f.setAgents([agent({ provider: "pi", model: "fleet/claude-opus-5-5" })]);
    f.failCompact(); f.start(f.store); await until(() => f.timers.pending.size === 1);
    f.timers.fire(); await until(() => f.logs.some(l => l.action === "compaction-failed"));
    assert.equal((await f.store.read()).at(-1)?.outcome, "compaction-failed");
    assert.equal(f.logs.some(l => l.action === "compacted"), false);
    f.event("agent.turn_ended", { agent: { ...agent({ provider: "pi", model: "fleet/claude-opus-5-5" }), parentAgentId: null }, turnId: "automatic", timeline: [], outcome: { kind: "completed" } } as PluginLifecycleEvents["agent.turn_ended"]);
    await until(() => f.timers.pending.size === 1);
    f.timers.fire(); await until(() => f.logs.some(l => l.data.reason === "compaction-backoff"));
    f.snapshot(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.sends, ["/compact"]);
    const next = agent({ provider: "pi", model: "fleet/claude-opus-5-5", lastUserMessageAt: "2026-09-26T10:00:00Z" });
    f.update(next);
    const nextHistory = history(next, "real-user");
    nextHistory.entries[0] = { ...nextHistory.entries[0]!, timestamp: next.lastUserMessageAt!, item: { type: "user_message", text: "Next real request" } };
    f.histories.set(next.id, nextHistory);
    f.event("agent.turn_ended", { agent: { ...agent(), parentAgentId: null }, turnId: "real-user", timeline: [], outcome: { kind: "completed" } } as PluginLifecycleEvents["agent.turn_ended"]);
    await until(() => f.timers.pending.size === 1); f.timers.fire();
    await until(() => f.logs.filter(l => l.action === "compaction-failed").length === 2);
    assert.equal(f.sends.length, 2);
  }));
  it("recovers both cache families and skips web routes", async () => fixture(async (f) => {
    f.setAgents([agent({ provider: "pi", model: "fleet/claude-opus-5-5" }),
      agent({ id: "a2", provider: "pi", model: "fleet/gpt-6.1-sol" }),
      agent({ id: "a3", provider: "pi", model: "fleet/chatgpt-web-pro" })]);
    assert.equal(rearmSkipReason(agent({ provider: "pi", model: null })), "unsupported-pi-model");
    f.setNow(endedMs + 29 * 60_000);
    f.start(f.store, true, true); await f.recovered();
    assert.equal(f.timers.pending.size, 2);
    assert.deepEqual([...f.timers.pending.values()].map(t => t.ms).sort((a, b) => a - b), [4500, 21 * 60_000]);
    assert.equal((f.logs.find(l => l.action === "rearm-summary")!.data.skipped as Record<string, number>)["unsupported-pi-model"], 1);
    f.timers.fire(); await until(() => f.logs.filter(l => l.action === "compacted").length === 2);
    assert.deepEqual(f.sends, ["/compact", "/compact"]);
  }));
  it("arms turn-end timers from the refreshed model rather than event model", async () => fixture(async (f) => {
    const pi = agent({ provider: "pi", model: "fleet/gpt-6.1-sol" });
    f.setAgents([pi]); f.start(f.store, true, true); await f.recovered();
    f.event("agent.turn_started", { agent: { ...pi, parentAgentId: null }, turnId: "new" } as PluginLifecycleEvents["agent.turn_started"]);
    f.event("agent.turn_ended", { agent: { ...pi, parentAgentId: null, model: "fleet/claude-opus-5-5" }, turnId: "new", timeline: [{ type: "assistant_message", text: "Done" }], outcome: { kind: "completed" } } as PluginLifecycleEvents["agent.turn_ended"]);
    await until(() => f.logs.some(l => l.action === "timer-started"));
    assert.equal(f.logs.find(l => l.action === "timer-started")!.data.delayMinutes, 22);
  }));
});

describe("cache TTL guards", () => {
  const routes = [
    { provider: "claude", model: "model", ttl: 60 },
    { provider: "codex", model: "model", ttl: 30 },
    { provider: "pi", model: "fleet/claude-opus-5-5", ttl: 60 },
    { provider: "pi", model: "fleet/gpt-6.1-sol", ttl: 30 },
  ];
  for (const route of routes) {
    // Claude-family cold skips are the extendIdleCompaction=false behavior; Codex-family skips hold by default.
    const extend = route.ttl !== 60;
    it(`skips cold ${route.provider}/${route.model} recovery at and beyond TTL`, async () => {
      await fixture(async f => {
        f.setAgents([agent(route)]); f.setNow(endedMs + route.ttl * 60_000);
        f.start(f.store, true, true, extend); await f.recovered();
        assert.equal(f.timers.pending.size, 0);
        assert.equal((f.logs.find(l => l.action === "rearm-summary")!.data.skipped as Record<string, number>)["cache-expired"], 1);
        f.timers.fire(); assert.deepEqual(f.sends, []);
        await new Promise(resolve => setTimeout(resolve, 25));
      });
    });
    it(`refuses a late ${route.provider}/${route.model} timer at TTL`, async () => fixture(async f => {
      f.setAgents([agent(route)]); f.setNow(endedMs + (route.ttl - 1) * 60_000);
      f.start(f.store, true, true, extend); await f.recovered();
      assert.equal(f.timers.pending.size, 1);
      f.setNow(endedMs + route.ttl * 60_000); f.timers.fire();
      await until(() => f.logs.some(l => l.data.reason === "cache-expired"));
      assert.deepEqual(f.sends, []);
      assert.equal((await f.store.read()).at(-1)?.reason, "cache-expired");
      assert.equal(f.timers.pending.size, 0);
    }));
    it(`refuses a ${route.provider}/${route.model} retry crossing TTL`, async () => fixture(async f => {
      const a = agent(route); const page = history(a);
      page.entries[0]!.item = { type: "tool_call", callId: "tool1", name: "tool", detail: { type: "plain_text", text: "work" }, status: "running", error: null };
      f.setAgents([a]); f.histories.set(a.id, page);
      f.setNow(endedMs + (route.ttl - 1) * 60_000);
      f.start(f.store, true, true, extend); await f.recovered(); f.timers.fire();
      await until(() => f.logs.some(l => l.action === "retry-scheduled"));
      f.setNow(endedMs + (route.ttl + 1) * 60_000); f.timers.fire();
      await until(() => f.logs.some(l => l.data.reason === "cache-expired"));
      assert.deepEqual(f.sends, []);
      assert.equal(f.timers.pending.size, 0);
      assert.equal((await f.store.read()).at(-1)?.reason, "cache-expired");
    }));
  }
});

describe("extended idle compaction", () => {
  const cold = endedMs + 3 * 60 * 60_000;
  it("recovers a cold idle Claude agent at 150k and leaves one at 60k", async () => fixture(async f => {
    f.setAgents([agent({ lastUsage: { contextWindowUsedTokens: 150_000 } }),
      agent({ id: "a2", lastUsage: { contextWindowUsedTokens: 60_000 } })]);
    f.setNow(cold); f.start(f.store); await f.recovered();
    assert.equal(f.timers.pending.size, 1);
    assert.deepEqual(f.logs.filter(l => l.action === "re-armed").map(l => [l.data.agentId, l.data.cacheExpired]), [["a1", true]]);
    assert.equal((f.logs.find(l => l.action === "rearm-summary")!.data.skipped as Record<string, number>)["cache-expired"], 1);
    f.timers.fire(); await until(() => f.logs.some(l => l.action === "compacted"));
    assert.deepEqual(f.sends, ["/compact"]);
  }));
  it("arms a timer after a failed turn", async () => fixture(async f => {
    f.setAgents([]); f.setNow(endedMs); f.start(f.store); await f.recovered();
    const a = agent();
    f.setAgents([a]);
    f.event("agent.turn_ended", { agent: { ...a, parentAgentId: null }, turnId: "t2", timeline: [],
      outcome: { kind: "failed", error: { message: "provider error" } } } as PluginLifecycleEvents["agent.turn_ended"]);
    f.update(agent({ status: "error", attentionReason: "error" }));
    await until(() => f.logs.some(l => l.action === "timer-started"));
    assert.equal(f.timers.pending.size, 1);
  }));
  it("skips the cold 150k Claude agent as cache-expired with the flag off", async () => fixture(async f => {
    f.setAgents([agent({ lastUsage: { contextWindowUsedTokens: 150_000 } })]);
    f.setNow(cold); f.start(f.store, true, false, false); await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.equal((f.logs.find(l => l.action === "rearm-summary")!.data.skipped as Record<string, number>)["cache-expired"], 1);
  }));
});

describe("restart recovery", () => {
  it("skips missing cwd and non-directory parents without fetching timelines", async () => fixture(async (f) => {
    const blocker = path.join(path.dirname(f.file), "blocker");
    await writeFile(blocker, "not a directory");
    f.setAgents([agent({ cwd: path.join(path.dirname(f.file), "missing") }),
      agent({ id: "a2", cwd: path.join(blocker, "child") })]);
    f.start(f.store); await f.recovered();
    assert.equal(f.historyCalls(), 0);
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.logs.find((line) => line.action === "rearm-summary")?.data.skipped, { "cwd-missing": 2 });
    assert.equal(f.logs.some((line) => line.action === "rearm-failed"), false);
  }));

  it("logs each distinct recovery error once per agent until recovery succeeds", async () => fixture(async (f) => {
    f.setAgents([agent({ lastUsage: undefined }), agent({ id: "a2", status: "running" })]);
    f.historyErrors.set("a1", new Error("History unavailable"));
    f.start(f.store); await f.recovered();
    await until(() => f.historyCalls() >= 2);
    f.snapshot();
    await until(() => f.historyCalls() >= 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.logs.filter((line) => line.action === "rearm-failed").length, 1);
    assert.deepEqual(f.logs.find((line) => line.action === "rearm-summary")?.data.skipped,
      { "recovery-failed": 1, "not-idle": 1 });

    f.historyErrors.set("a1", new Error("Different history error"));
    f.snapshot();
    await until(() => f.logs.filter((line) => line.action === "rearm-failed").length === 2);
    f.historyErrors.set("a1", new Error("History unavailable"));
    f.setAgents([agent({ lastUsage: undefined }), agent({ id: "a2", status: "running" }),
      agent({ id: "a3", provider: "opencode" })]);
    f.snapshot();
    await until(() => f.logs.filter((line) => line.action === "rearm-summary").length === 2);
    assert.equal(f.logs.filter((line) => line.action === "rearm-failed").length, 2);
    assert.equal((f.logs.at(-1)?.data.skipped as Record<string, number>)["recovery-failed"], 1);

    f.historyErrors.delete("a1");
    f.snapshot();
    await until(() => f.logs.some((line) => line.action === "re-armed"));
    f.timers.fire();
    await until(() => f.logs.some((line) => line.action === "skip"));
    f.historyErrors.set("a1", new Error("History unavailable"));
    f.snapshot();
    await until(() => f.logs.filter((line) => line.action === "rearm-failed").length === 3);
  }));

  it("clears cached recovery errors on a new turn, including snapshot updates", async () => {
    for (const trigger of ["turn-started", "turn-ended", "running-update", "message-update"]) await fixture(async (f) => {
      f.historyErrors.set("a1", new Error("History unavailable"));
      f.start(f.store); await f.recovered();
      await until(() => f.historyCalls() >= 2);
      const a = agent();
      const eventAgent = { ...a, workspaceId: "w1", parentAgentId: null };
      if (trigger === "turn-started") f.event("agent.turn_started", { agent: eventAgent, turnId: "t2" });
      if (trigger === "turn-ended") {
        f.event("agent.turn_ended", { agent: eventAgent, turnId: "t2", outcome: { kind: "completed" }, timeline: [] });
        await until(() => f.logs.some((line) => line.action === "timer-started"));
        f.timers.fire();
        await until(() => f.logs.some((line) => line.action === "compaction-failed"));
      }
      if (trigger === "running-update") { f.update(agent({ status: "running" })); f.setAgents([a]); }
      if (trigger === "message-update") f.update(agent({ lastUserMessageAt: "2026-09-26T09:00:00Z" }));
      f.snapshot();
      await until(() => f.logs.filter((line) => line.action === "rearm-failed").length === 2);
    });
  });

  it("keeps failure suppression and cache clearing independent per agent", async () => fixture(async (f) => {
    f.setAgents([agent(), agent({ id: "a2" })]);
    for (const id of ["a1", "a2"]) f.historyErrors.set(id, new Error("History unavailable"));
    f.start(f.store); await f.recovered();
    await until(() => f.historyCalls() >= 4);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.logs.filter((line) => line.action === "rearm-failed").length, 2);
    const a = agent();
    f.event("agent.turn_started", { agent: { ...a, workspaceId: "w1", parentAgentId: null }, turnId: "t2" });
    f.snapshot();
    await until(() => f.historyCalls() >= 6);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.logs.filter((line) => line.action === "rearm-failed").map((line) => line.data.agentId),
      ["a1", "a2", "a1"]);
  }));

  it("suppresses pending-only summaries but logs changed skip counts and new timers", async () => fixture(async (f) => {
    f.start(f.store); await f.recovered();
    f.snapshot(); f.snapshot();
    const a = agent();
    f.event("agent.permission_resolved", { agent: { ...a, workspaceId: "w1", parentAgentId: null }, requestId: "p1",
      resolution: { behavior: "allow" } }, { ...f.api });
    await until(() => f.listCalls() >= 6);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.logs.filter((line) => line.action === "rearm-summary").length, 1);
    assert.equal(f.historyCalls(), 1);

    f.setAgents([agent(), agent({ id: "a2", status: "running" })]);
    f.snapshot();
    await until(() => f.logs.filter((line) => line.action === "rearm-summary").length === 2);
    assert.deepEqual(f.logs.at(-1)?.data.skipped, { "already-pending": 1, "not-idle": 1 });
    f.setAgents([agent(), agent({ id: "a2", status: "running" }), agent({ id: "a3" })]);
    f.snapshot();
    await until(() => f.logs.filter((line) => line.action === "rearm-summary").length === 3);
    assert.equal(f.logs.at(-1)?.data.rearmed, 1);
    f.setAgents([agent(), agent({ id: "a3" })]);
    f.snapshot();
    await until(() => f.logs.filter((line) => line.action === "rearm-summary").length === 4);
    assert.deepEqual(f.logs.at(-1)?.data.skipped, { "already-pending": 2 });
    assert.equal(f.timers.pending.size, 2);
  }));

  it("records unknown context as a terminal skip with no retry or compaction metric", async () => fixture(async (f) => {
    f.setAgents([agent({ lastUsage: undefined })]);
    f.start(f.store); await f.recovered();
    f.timers.fire();
    await until(() => f.logs.some((line) => line.action === "skip"));
    assert.equal(f.logs.find((line) => line.action === "skip")?.data.reason, "context-unknown");
    const records = await f.store.read();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.key, "a1:t1");
    assert.equal(records[0]?.outcome, "skip");
    assert.equal(records[0]?.reason, "context-unknown");
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, []);
    assert.deepEqual(f.metrics, []);
    assert.equal(f.logs.some((line) => line.action === "retry-scheduled"), false);
    f.snapshot();
    await until(() => f.logs.some((line) => line.action === "rearm-summary" &&
      (line.data.skipped as Record<string, number>).checkpointed === 1));
    assert.equal(f.timers.pending.size, 0);
    await f.cleanup(); f.logs.length = 0;
    f.start(new StateStore(f.file)); await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, []);
  }));

  it("re-arms an idle agent with its remaining delay and evaluates through the normal path", async () => fixture(async (f) => {
    f.start(f.store);
    await f.recovered();
    assert.equal(f.timers.pending.size, 1);
    assert.equal([...f.timers.pending.values()][0]?.ms, 20 * 60_000);
    assert.deepEqual(f.logs.find((line) => line.action === "re-armed")?.data,
      { agentId: "a1", provider: "claude", idleSince: endedAt, delayMs: 1_200_000, remainingMs: 1_200_000, jitterApplied: false });
    f.snapshot();
    await until(() => f.listCalls() >= 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.logs.filter((line) => line.action === "rearm-summary").length, 1);
    assert.equal(f.timers.pending.size, 1);
    f.setNow(endedMs + 50 * 60_000);
    f.timers.fire();
    await until(() => f.logs.some((line) => line.action === "compacted"));
    assert.deepEqual(f.sends, ["/compact"]);
  }));

  it("re-arms an expired Codex timer with bounded jitter", async () => fixture(async (f) => {
    f.setAgents([agent({ provider: "codex" })]);
    f.setNow(endedMs + 29 * 60_000);
    f.start(f.store); await f.recovered();
    const delay = [...f.timers.pending.values()][0]!.ms;
    assert.ok(delay >= REARM_JITTER_MIN_MS && delay <= REARM_JITTER_MAX_MS);
    assert.equal(f.logs.find((line) => line.action === "re-armed")?.data.jitterApplied, true);
    f.timers.fire();
    await until(() => f.logs.some((line) => line.action === "compacted"));
    assert.deepEqual(f.sends, ["/compact"]);
  }));

  it("keeps exact turn identity and end time across cleanup and restart even with cleared attention", async () => fixture(async (f) => {
    f.setAgents([]);
    f.setNow(endedMs);
    f.start(f.store);
    await f.recovered();
    const a = agent({ attentionReason: null, attentionTimestamp: null });
    f.setAgents([a]);
    f.event("agent.turn_ended", { agent: { ...a, workspaceId: "w1", parentAgentId: null }, turnId: "t1",
      outcome: { kind: "completed" }, timeline: history(a).entries.map((entry) => entry.item) });
    await until(() => f.logs.some((line) => line.action === "timer-started"));
    await f.cleanup();
    assert.equal(f.timers.pending.size, 0);
    f.logs.length = 0;
    f.setNow(endedMs + 30 * 60_000);
    f.start(new StateStore(f.file));
    await f.recovered();
    assert.equal([...f.timers.pending.values()][0]?.ms, 20 * 60_000);
    assert.equal((await f.store.latestTurn("a1"))?.key, "a1:t1");
  }));

  it("does not send twice after a terminal checkpoint, including provider history without turn IDs", async () => fixture(async (f) => {
    f.start(f.store);
    await f.recovered();
    f.setNow(endedMs + 50 * 60_000);
    f.timers.fire();
    await until(() => f.logs.some((line) => line.action === "compacted"));
    await f.cleanup();
    f.logs.length = 0;
    const h = history(agent());
    h.entries[0]!.turnId = undefined;
    f.histories.set("a1", h);
    f.start(new StateStore(f.file));
    await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, ["/compact"]);
    assert.equal((f.logs.find((line) => line.action === "rearm-summary")?.data.skipped as Record<string, number>).checkpointed, 1);
  }));

  it("honors a pre-upgrade checkpoint when restored history omits turn identity", async () => fixture(async (f) => {
    const a = agent({ attentionTimestamp: "2026-09-26T08:10:00Z" });
    f.setAgents([a]);
    const h = history(a); h.entries[0]!.turnId = undefined; f.histories.set("a1", h);
    await f.store.append({ key: "a1:t1", agentId: "a1", turnId: "t1", lastUserMessageAt: messageAt,
      createdAt: "2026-09-26T08:05:00Z", outcome: "compacted", reason: "safe-boundary" }, 100);
    f.start(f.store); await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, []);
  }));

  it("skips running, active-turn, other providers, opted-out, archived, and checkpointed agents across pages", async () => fixture(async (f) => {
    f.paginate(2);
    f.setAgents([agent({ id: "busy", status: "running" }), agent({ id: "active", activeTurn: { turnId: "t2", startedAt: endedAt } }),
      agent({ id: "other", provider: "opencode" }), agent({ id: "off", labels: { autocompact: "off" } }),
      agent({ id: "archived", archivedAt: endedAt }), agent({ id: "handled" })]);
    await f.store.append({ key: "handled:t1", agentId: "handled", turnId: "t1", lastUserMessageAt: messageAt,
      createdAt: endedAt, outcome: "would-compact", reason: "disarmed" }, 100);
    f.start(f.store);
    await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.logs.find((line) => line.action === "rearm-summary")?.data,
      { trigger: "startup", rearmed: 0, skipped: { "not-idle": 2, "unsupported-provider": 1,
        "opted-out-label": 1, archived: 1, checkpointed: 1 }, skippedCount: 6 });
  }));

  it("recovers on the first hook when startup cannot connect", async () => fixture(async (f) => {
    f.failBootstrap();
    f.start(f.store);
    await until(() => f.logs.some((line) => line.action === "startup-rearm-failed"));
    const a = agent();
    f.event("agent.permission_resolved", { agent: { ...a, workspaceId: "w1", parentAgentId: null }, requestId: "p1", resolution: { behavior: "allow" } });
    await f.recovered();
    assert.equal(f.timers.pending.size, 1);
  }));

  it("preserves dry-run, token, tool, permission, opt-out and fresh busy guards", async () => {
    for (const reason of ["dry-run", "tokens", "tool", "permission", "off", "busy", "message"]) {
      await fixture(async (f) => {
        f.start(f.store, reason !== "dry-run");
        await f.recovered();
        const a = agent();
        if (reason === "tokens") a.lastUsage = { contextWindowUsedTokens: 99_999 };
        if (reason === "permission") a.pendingPermissions = [{ id: "p1", provider: "claude", name: "tool", kind: "tool" }];
        if (reason === "off") a.labels = { autocompact: "off" };
        if (reason === "busy") a.status = "running";
        if (reason === "message") a.lastUserMessageAt = "2026-09-26T08:05:00Z";
        if (reason === "tool") {
          const turn = (await f.store.latestTurn("a1"))!;
          // A recovered running tool uses the same retry path as a normal turn timer.
          turn.timeline = [{ type: "tool_call", callId: "tool1", name: "tool", detail: { type: "plain_text", text: "work" }, status: "running", error: null }];
          await f.store.rememberTurn(turn, 100);
          await f.cleanup(); f.logs.length = 0; f.start(f.store); await f.recovered();
        }
        f.setAgents([a]);
        f.timers.fire();
        await until(() => f.logs.some((line) => line.action === "skip" || line.action === "would-compact"));
        assert.deepEqual(f.sends, [], reason);
        if (reason === "tool" || reason === "busy") assert.equal(f.timers.pending.size, 1, reason);
      });
    }
  });

  it("cancels recovered timers on new turns, changed messages, and cleanup", async () => fixture(async (f) => {
    f.start(f.store); await f.recovered();
    f.update(agent({ lastUserMessageAt: "2026-09-26T08:10:00Z" }));
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, []);
  }));

  it("cancels a recovered timer when a turn starts or an agent becomes busy", async () => {
    for (const trigger of ["turn", "update", "archive", "cleanup"]) await fixture(async (f) => {
      f.start(f.store); await f.recovered();
      const a = agent();
      if (trigger === "turn") f.event("agent.turn_started", { agent: { ...a, workspaceId: "w1", parentAgentId: null }, turnId: "t2" });
      if (trigger === "update") f.update(agent({ status: "running" }));
      if (trigger === "archive") f.event("agent.archived", { agent: { ...a, workspaceId: "w1", parentAgentId: null }, archivedAt: endedAt });
      if (trigger === "cleanup") await f.cleanup();
      assert.equal(f.timers.pending.size, 0, trigger);
      f.timers.fire();
      assert.deepEqual(f.sends, [], trigger);
    });
  });

  it("preserves bounded retries across restart", async () => fixture(async (f) => {
    f.start(f.store); await f.recovered();
    const turn = (await f.store.latestTurn("a1"))!;
    turn.timeline = [{ type: "tool_call", callId: "tool1", name: "tool", detail: { type: "plain_text", text: "work" }, status: "running", error: null }];
    await f.store.rememberTurn(turn, 100);
    await f.cleanup(); f.logs.length = 0;
    f.setNow(endedMs + 55 * 60_000);
    f.start(f.store); await f.recovered();
    f.timers.fire();
    await until(() => f.logs.some((line) => line.action === "retry-scheduled"));
    await f.cleanup(); f.logs.length = 0;
    f.start(new StateStore(f.file)); await f.recovered();
    f.timers.fire();
    await until(() => f.logs.some((line) => line.action === "retry-scheduled"));
    assert.equal(f.logs.find((line) => line.action === "retry-scheduled")?.data.retryCount, 2);
    assert.deepEqual(f.sends, []);
  }));

  it("keeps teardown pending until the state write of the store it owns settles", async () => fixture(async (f) => {
    const home = process.env.PASEO_HOME;
    process.env.PASEO_HOME = path.dirname(f.file);
    try {
      let enter = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const landed: string[] = [];
      f.writeStateWith(async (filePath, value, options) => {
        enter(); await held;
        await writeJsonAtomically(filePath, value, options);
        landed.push(filePath);
      });
      // No store is passed in, so the scheduler creates its own under PASEO_HOME and closes it on teardown.
      f.start(undefined);
      await entered;
      let landedAtStop: string[] | undefined;
      const stopping = f.cleanup().then(() => { landedAtStop = [...landed]; });
      const stoppedWith = () => landedAtStop;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stoppedWith(), undefined);
      release();
      await stopping;
      const owned = path.join(path.dirname(f.file), "plugin-state", "cache-aware-autocompact", "state.json");
      assert.deepEqual(stoppedWith(), [owned]);
      assert.equal((await new StateStore(owned).latestTurn("a1"))?.key, "a1:t1");
    } finally {
      if (home === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = home;
    }
  }));

  it("does not arm a stale recovery when a new turn begins during history fetch", async () => fixture(async (f) => {
    let release = () => {};
    f.pauseHistory(new Promise<void>((resolve) => { release = resolve; }));
    f.start(f.store);
    await until(() => f.historyCalls() > 0);
    const a = agent();
    f.event("agent.turn_started", { agent: { ...a, workspaceId: "w1", parentAgentId: null }, turnId: "t2" });
    f.setAgents([agent({ status: "running", activeTurn: { turnId: "t2", startedAt: endedAt } })]);
    release(); await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, []);
  }));

  it("treats a durable pre-send reservation as handled after restart", async () => fixture(async (f) => {
    await f.store.append({ key: "a1:t1", agentId: "a1", turnId: "t1", lastUserMessageAt: messageAt,
      createdAt: endedAt, outcome: "compact-requested", reason: "send-reserved" }, 100);
    f.start(f.store); await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, []);
  }));

  it("fails closed on unreadable durable state", async () => fixture(async (f) => {
    await writeFile(f.file, "invalid json");
    f.start(f.store); await f.recovered();
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.sends, []);
  }));
});

describe("elapsed-delay math", () => {
  it("subtracts idle time for both providers and clamps future end times", () => {
    assert.deepEqual(recoveryDelay("claude", endedAt, config, endedMs + 20 * 60_000), { remainingMs: 1_800_000, delayMs: 1_800_000, jitterApplied: false });
    assert.equal(recoveryDelay("codex", endedAt, config, endedMs + 20 * 60_000).delayMs, 120_000);
    assert.equal(recoveryDelay("pi", endedAt, defaultConfig({ piGptEnabled: true }), endedMs + 20 * 60_000, () => 0, "fleet/gpt-6.1-sol").delayMs, 120_000);
    assert.equal(recoveryDelay("pi", endedAt, config, endedMs + 20 * 60_000, () => 0, "fleet/claude-opus-5-5").delayMs, 1_800_000);
    assert.equal(recoveryDelay("pi", endedAt, defaultConfig({ claudeDelayMinutes: 120 }), endedMs + 55 * 60_000, () => 0, "fleet/claude-opus-5-5").jitterApplied, false);
    assert.equal(recoveryDelay("claude", endedAt, config, endedMs - 1).delayMs, 3_000_000);
  });
  it("jitters overdue but warm timers within the documented bounds", () => {
    for (const elapsed of [50 * 60_000, 59 * 60_000]) {
      for (const random of [0, 0.5, 0.999999, 1]) {
        const delay = recoveryDelay("claude", endedAt, config, endedMs + elapsed, () => random);
        assert.equal(delay.remainingMs, 0);
        assert.equal(delay.jitterApplied, true);
        assert.ok(delay.delayMs >= REARM_JITTER_MIN_MS && delay.delayMs <= REARM_JITTER_MAX_MS);
      }
    }
  });
  it("keeps a longer configured delay for a warm cache", () => {
    const delay = recoveryDelay("claude", endedAt, defaultConfig({ claudeDelayMinutes: 120 }), endedMs + 55 * 60_000, () => 0);
    assert.equal(delay.remainingMs, 65 * 60_000);
    assert.equal(delay.jitterApplied, false);
    assert.equal(delay.delayMs, 65 * 60_000);
  });
  it("uses configured delays", () => {
    assert.equal(recoveryDelay("codex", endedAt, defaultConfig({ codexDelayMinutes: 10 }), endedMs + 60_000).delayMs, 9 * 60_000);
  });
});

describe("recovered identity", () => {
  it("keeps exact stored metadata when attention is cleared", () => {
    const a = agent({ attentionReason: null, attentionTimestamp: null });
    const turn = recoverTurn(agent(), history(a), null)!;
    const remembered: Checkpoint = { ...turn, endedAt: "2026-09-26T08:01:00Z" };
    assert.equal(recoverTurn(a, history(a), remembered), remembered);
  });
  it("recovers a stored empty turn with the same user message", () => {
    const a = agent(); const h = history(a); h.entries = [];
    const turn = recoverTurn(a, history(a), null)!;
    assert.equal(recoverTurn(a, h, turn), turn);
  });
  it("does not recover an already compacted or empty timeline", () => {
    const a = agent(); const h = history(a);
    h.entries[0]!.item = { type: "compaction", status: "completed" };
    assert.equal(recoverTurn(a, h, null), null);
    h.entries = [];
    assert.equal(recoverTurn(a, h, null), null);
  });
});

describe("timeline recovery", () => {
  it("loads older pages of the latest turn to retain a running-tool guard", async () => {
    const a = agent();
    const tail = history(a);
    tail.hasOlder = true;
    tail.startCursor = { epoch: "e1", seq: 1 };
    const older = history(a);
    older.entries = [
      { ...older.entries[0]!, seqStart: 0, seqEnd: 0, item: { type: "tool_call", callId: "tool1", name: "tool",
        detail: { type: "plain_text", text: "work" }, status: "running", error: null } },
    ];
    const requests: string[] = [];
    const result = await recoveryHistory({ refetch: async (options) => {
      requests.push(options?.direction ?? "tail");
      return options?.direction === "before" ? older : tail;
    } } as PaseoAgentTimelineHandle);
    assert.deepEqual(requests, ["tail", "before"]);
    assert.equal(recoverTurn(a, result!, null)?.timeline[0]?.type, "tool_call");
  });
  it("fails closed when timeline pagination changes epoch or has a gap", async () => {
    const a = agent(); const tail = history(a);
    tail.hasOlder = true; tail.startCursor = { epoch: "e1", seq: 1 };
    const older = history(a); older.epoch = "e2";
    assert.equal(await recoveryHistory({ refetch: async (options) => options?.direction === "before" ? older : tail } as PaseoAgentTimelineHandle), null);
    tail.gap = true;
    assert.equal(await recoveryHistory({ refetch: async () => tail } as unknown as PaseoAgentTimelineHandle), null);
  });
});

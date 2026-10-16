// Owner-specified PM quota fallback cases, through the plugin's real hooks, sweep and state files. Fixture data only.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { ConfigSchema, type Config } from "../server/config.ts";
import { ReturnStore } from "../server/fallback.ts";
import type { AgentSnapshot } from "../server/model.ts";
import { QuotaReader } from "../server/quota.ts";
import { ResumeStore } from "../server/store.ts";

const OPUS = "fleet/claude-opus-5-5";
const SOL = "fleet/gpt-6.1-sol";
const USAGE = "usage_limit_exceeded: fixture limit (stopReason=error, model=fleet/claude-opus-5-5)";
type Window = "out" | "ok";
type Pool = { five: Window; week: Window };

function fixture(home: string) {
  const agents = new Map<string, AgentSnapshot>();
  const timelines = new Map<string, unknown[]>();
  const calls = { apply: [] as Array<{ agentId: string; modelId: string; thinkingOptionId: string | null }>, labels: [] as Array<Record<string, string>>, sends: [] as string[], cancels: 0 };
  const pq: { claude: Pool; codex: Pool } = { claude: { five: "out", week: "out" }, codex: { five: "ok", week: "ok" } };
  let failApply = 0;
  let config: Config = ConfigSchema.parse({ armed: true, pmFallback: true, quotaCacheSeconds: 0 });
  const handlers = new Map<string, (event: unknown, context?: unknown) => void>();
  const now = () => Math.floor(Date.now() / 1000);
  const windows = (pool: Pool) => [
    { id: "five_hour", fresh: true, leftPct: pool.five === "out" ? 0 : 60, resetAt: now() + 3600 },
    { id: "seven_day", fresh: true, leftPct: pool.week === "out" ? 0 : 60, resetAt: now() + 86400 },
  ];
  const document = () => ({ schemaVersion: 1, snapshotStale: false, accounts: [
    { provider: "claude", fresh: true, windows: windows(pq.claude) },
    { provider: "codex", fresh: true, windows: windows(pq.codex) },
  ] });
  const api = {
    getConnectionState: () => ({ status: "connected" }), close: async () => undefined,
    providers: { listModels: async () => ({ models: [OPUS, SOL].map((id) => ({ id, thinkingOptions: ["low", "medium", "high"].map((t) => ({ id: t })) })) }) },
    agents: { ref: (id: string) => ({
      refresh: async () => agents.has(id) ? { agent: structuredClone(agents.get(id)!) } : null,
      timeline: { refetch: async () => ({ entries: (timelines.get(id) ?? []).map((item) => ({ item })), hasNewer: false, hasOlder: false }) },
      cancel: async () => { calls.cancels++; },
      send: async (prompt: string) => {
        const agent = agents.get(id)!;
        calls.sends.push(`${id}:${agent.model}:${prompt.slice(0, 20)}`);
        Object.assign(agent, { status: "running", activeTurn: { turnId: `resume-${calls.sends.length}` }, lastUserMessageAt: new Date().toISOString(), requiresAttention: false });
        handlers.get("agent.turn_started")!({ agent: { id }, turnId: `resume-${calls.sends.length}` });
      },
    }) },
    agentSettings: {
      apply: async (agentId: string, settings: { modelId: string; thinkingOptionId: string | null }) => {
        calls.apply.push({ agentId, ...settings });
        if (failApply > 0) { failApply--; throw new Error("fixture apply rejected"); }
        Object.assign(agents.get(agentId)!, { model: settings.modelId, thinkingOptionId: settings.thinkingOptionId });
      },
      setLabels: async (agentId: string, labels: Record<string, string>) => {
        calls.labels.push(labels);
        const agent = agents.get(agentId)!;
        agent.labels = { ...agent.labels, ...labels };
      },
    },
  } as unknown as PaseoClient;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: config }) }),
    on: (name: string, handler: (event: unknown, context?: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
  } as unknown as PluginServerContext;
  let plugin: ReturnType<typeof contribute> | null = null;
  const start = async () => {
    plugin = contribute(server, async () => api, new QuotaReader(async () => ({ document: document() })), new ReturnStore(path.join(home, "pm-return.json")));
    await plugin.idle();
  };
  const stop = async () => { plugin?.(); await plugin?.idle(); plugin = null; };
  const add = (id: string, role: string, extra: Partial<AgentSnapshot> = {}) => {
    agents.set(id, { id, provider: "pi", model: OPUS, thinkingOptionId: "high", cwd: "/fixture", status: "idle", labels: { role },
      lastUserMessageAt: "2026-01-02T00:00:00.000Z", persistence: { provider: "pi", sessionId: `${id}-session` }, ...extra });
  };
  const endTurn = async (id: string, outcome: { kind: "failed"; error: { message: string } } | { kind: "completed" }, turnId: string) => {
    const agent = agents.get(id)!;
    Object.assign(agent, outcome.kind === "failed" ? { status: "error", lastError: outcome.error.message, requiresAttention: true, attentionReason: "error" } : { status: "idle" }, { activeTurn: null });
    const timeline = [{ type: "user_message", text: "fixture work", messageId: `${turnId}-user` }];
    timelines.set(id, timeline);
    handlers.get("agent.turn_ended")!({ agent: { id }, turnId, outcome, timeline }, { paseo: api });
    await plugin!.idle();
  };
  const tick = async () => { mock.timers.tick(30_000); await plugin!.idle(); };
  return {
    agents, calls, pq, start, stop, add, endTurn, tick, handlers,
    returns: new ReturnStore(path.join(home, "pm-return.json")), records: new ResumeStore(),
    failApplies: (n: number) => { failApply = n; },
    setConfig: (patch: Partial<Config>) => { config = ConfigSchema.parse({ ...config, ...patch }); },
  };
}

async function scenario(run: (f: ReturnType<typeof fixture>, logs: string[]) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "pm-fallback-"));
  const oldHome = process.env.PASEO_HOME;
  const oldLog = console.log;
  const logs: string[] = [];
  process.env.PASEO_HOME = home;
  console.log = (line: string) => { logs.push(line); };
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2026-01-02T10:00:00Z") });
  const f = fixture(home);
  try {
    await f.start();
    await run(f, logs);
  } finally {
    try { await f.stop(); } finally {
      mock.timers.reset();
      console.log = oldLog;
      if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
      await rm(home, { recursive: true, force: true });
    }
  }
}

// Swap a PM: its Claude turn fails on a usage limit while pq shows every Claude account out.
async function swapPm(f: ReturnType<typeof fixture>, id = "pm") {
  f.add(id, "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn(id, { kind: "failed", error: { message: USAGE } }, `${id}-turn-1`);
}

it("PM fallback swaps exactly and resumes the same session on Sol; a worker on the same failure is untouched", () => scenario(async (f, logs) => {
  f.add("worker", "worker");
  await f.endTurn("worker", { kind: "failed", error: { message: USAGE } }, "worker-turn-1");
  await swapPm(f);
  assert.deepEqual(f.calls.apply, [{ agentId: "pm", modelId: SOL, thinkingOptionId: "medium" }]);
  assert.deepEqual(f.calls.labels, [{ "opc.service-tier": "fast" }]);
  assert.equal(f.agents.get("worker")!.model, OPUS);
  const [obligation] = (await f.returns.read()).obligations;
  assert.deepEqual(obligation!.original, { model: OPUS, thinkingOptionId: "high", serviceTier: null });
  assert.equal(obligation!.phase, "fallback");
  assert.deepEqual(f.calls.sends.filter((s) => s.startsWith("pm:")).map((s) => s.split(":")[1]), [SOL]);
  assert.ok(logs.some((l) => l.includes("pm-swap-start agentId=pm")) && logs.some((l) => l.includes("pm-swap-verified agentId=pm")));
  const pmRecord = (await f.records.read()).find((r) => r.agentId === "pm")!;
  assert.equal(pmRecord.model, SOL);
  assert.equal(pmRecord.persistenceSessionId, "pm-session");
  // The worker's record stays on its own model and quota hold: no swap, no send.
  const workerRecord = (await f.records.read()).find((r) => r.agentId === "worker")!;
  assert.equal(workerRecord.model, OPUS);
  assert.ok(workerRecord.quotaHold);
  assert.ok(!f.calls.sends.some((s) => s.startsWith("worker:")));
}));

it("quota release restores the exact original profile, also mid-turn without interrupting it", () => scenario(async (f, logs) => {
  await swapPm(f);
  await f.endTurn("pm", { kind: "completed" }, "resume-1");
  // A new user turn is running on Sol when Claude frees up.
  Object.assign(f.agents.get("pm")!, { status: "running", activeTurn: { turnId: "user-turn-2" } });
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.deepEqual(f.calls.apply.at(-1), { agentId: "pm", modelId: OPUS, thinkingOptionId: "high" });
  assert.deepEqual(f.calls.labels.at(-1), { "opc.service-tier": "" });
  assert.equal(f.calls.cancels, 0, "a running turn is never cancelled");
  assert.equal(f.agents.get("pm")!.activeTurn?.turnId, "user-turn-2");
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(logs.some((l) => l.includes("pm-restore-due agentId=pm")) && logs.some((l) => l.includes("pm-restore-verified agentId=pm")));
}));

it("plugin reload and daemon restart keep the obligation; the restore still happens", () => scenario(async (f) => {
  await swapPm(f);
  await f.stop();
  f.pq.claude = { five: "ok", week: "ok" };
  await f.start();
  assert.equal(f.agents.get("pm")!.model, OPUS, "the restart's first sweep restores");
  assert.deepEqual((await f.returns.read()).obligations, []);
}));

it("a newer user message supersedes the retry record but not the return obligation", () => scenario(async (f) => {
  await swapPm(f);
  Object.assign(f.agents.get("pm")!, { status: "idle", activeTurn: null, lastUserMessageAt: "2026-01-02T10:05:00.000Z" });
  await f.endTurn("pm", { kind: "completed" }, "user-turn-new");
  const pmRecords = (await f.records.read()).filter((r) => r.agentId === "pm");
  assert.ok(pmRecords.every((r) => r.state !== "parked"));
  assert.equal((await f.returns.read()).obligations.length, 1);
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, OPUS);
}));

it("a failing restore keeps the obligation, blocks fallback resends, and retries at the next turn end", () => scenario(async (f, logs) => {
  await swapPm(f);
  await f.endTurn("pm", { kind: "completed" }, "resume-1");
  const sendsBefore = f.calls.sends.length;
  f.pq.claude = { five: "ok", week: "ok" };
  // Two restore attempts fail; meanwhile a user turn on Sol fails transiently and would normally retry at once.
  f.failApplies(2);
  await f.endTurn("pm", { kind: "failed", error: { message: "503 temporarily unavailable" } }, "user-turn-2");
  assert.ok(logs.filter((l) => l.includes("pm-restore-failed agentId=pm")).length >= 1);
  assert.ok(logs.some((l) => l.includes("send-deferred agentId=pm") && l.includes("reason=pm-profile-change-pending")));
  assert.equal(f.agents.get("pm")!.model, OPUS, "a later trigger restored it");
  assert.deepEqual((await f.returns.read()).obligations, []);
  // The retry went out once, on the restored profile, never on Sol after the return was due.
  assert.deepEqual(f.calls.sends.slice(sendsBefore).map((s) => s.split(":")[1]), [OPUS]);
}));

it("GPT also exhausted: ordinary quota hold, no swap", () => scenario(async (f, logs) => {
  f.pq.codex = { five: "out", week: "ok" };
  await swapPm(f);
  assert.deepEqual(f.calls.apply, []);
  assert.equal((await f.returns.read()).obligations.length, 0);
  assert.ok((await f.records.read()).find((r) => r.agentId === "pm")!.quotaHold);
  assert.ok(logs.some((l) => l.includes("pm-fallback-held agentId=pm") && l.includes("fallback-pool-exhausted")));
}));

it("a weekly-exhausted Claude pool is not restored when only its five-hour window resets; unknown quota proves nothing", () => scenario(async (f) => {
  await swapPm(f);
  f.pq.claude = { five: "ok", week: "out" };
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  f.setConfig({ quotaAware: false });
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  f.setConfig({ quotaAware: true });
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, OPUS);
}));

it("only an explicit owner cancel ends the return; manual drift and role loss do not", () => scenario(async (f, logs) => {
  await swapPm(f);
  const [obligation] = (await f.returns.read()).obligations;
  Object.assign(f.agents.get("pm")!, { model: "fleet/claude-fable-5-1", labels: { project: "fixture" } });
  await f.tick();
  assert.equal((await f.returns.read()).obligations.length, 1);
  f.setConfig({ pmFallbackCancel: [obligation!.obligationId] });
  await f.tick();
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(logs.some((l) => l.includes(`pm-return-cancelled agentId=pm obligationId=${obligation!.obligationId} by=owner-setting`)));
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, "fleet/claude-fable-5-1");
}));

it("a crash after a settings update but before its acknowledgement is finished, not repeated or lost", () => scenario(async (f) => {
  f.add("pm", "pm");
  const { newObligation } = await import("../server/fallback.ts");
  // Swap intent stored, settings applied, then the process died before the verified state was written.
  await f.returns.add(newObligation("pm", { model: OPUS, thinkingOptionId: "high", serviceTier: null }, { model: SOL, thinkingOptionId: "medium", serviceTier: "fast" }, "auto", "switching"));
  Object.assign(f.agents.get("pm")!, { model: SOL, thinkingOptionId: "medium", labels: { role: "pm", "opc.service-tier": "fast" } });
  await f.tick();
  assert.equal((await f.returns.read()).obligations[0]!.phase, "fallback");
  assert.deepEqual(f.calls.apply, []);
  // Restore applied, then a crash before the obligation was removed.
  f.pq.claude = { five: "ok", week: "ok" };
  await f.returns.update((await f.returns.read()).obligations[0]!.obligationId, (o) => ({ ...o, restoreDueAt: new Date().toISOString() }));
  Object.assign(f.agents.get("pm")!, { model: OPUS, thinkingOptionId: "high", labels: { role: "pm", "opc.service-tier": "" } });
  await f.tick();
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.deepEqual(f.calls.apply, []);
}));

it("owner enrollment registers an already-fallen-back PM once and returns it on release; opt-out and archive are respected", () => scenario(async (f, logs) => {
  f.add("manual", "pm", { model: SOL, thinkingOptionId: "medium" });
  f.add("pinned", "pm", { labels: { role: "pm", nofallback: "true" } });
  f.setConfig({ pmFallbackEnroll: [{ agentId: "manual", model: OPUS, thinkingOptionId: "high", serviceTier: null }] });
  await f.tick();
  await f.tick();
  const obligations = (await f.returns.read()).obligations;
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0]!.source, "enrolled");
  assert.equal(logs.filter((l) => l.includes("pm-enrolled agentId=manual")).length, 1);
  await f.endTurn("pinned", { kind: "failed", error: { message: USAGE } }, "pinned-turn-1");
  assert.equal(f.agents.get("pinned")!.model, OPUS);
  f.agents.get("manual")!.archivedAt = "2026-01-02T11:00:00.000Z";
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("manual")!.model, SOL, "archived agents are not touched");
  assert.equal((await f.returns.read()).obligations.length, 1, "the obligation waits");
  f.agents.get("manual")!.archivedAt = null;
  await f.tick();
  assert.equal(f.agents.get("manual")!.model, OPUS);
}));

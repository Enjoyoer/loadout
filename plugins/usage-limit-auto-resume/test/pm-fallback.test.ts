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
import { newObligation, profileOf, ReturnStore, type Profile } from "../server/fallback.ts";
import type { AgentSnapshot } from "../server/model.ts";
import { QuotaReader } from "../server/quota.ts";
import { ResumeStore } from "../server/store.ts";

const OPUS = "fleet/claude-opus-5-5";
const SOL = "fleet/gpt-6.1-sol";
const USAGE = "usage_limit_exceeded: fixture limit (stopReason=error, model=fleet/claude-opus-5-5)";
// The provider errors of the 10/21 incident, as Pi reports them on a failed turn.
const RATE_LIMIT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} (stopReason=error, model=fleet/claude-opus-5-5)';
const CREDIT = '402 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}} (stopReason=error, model=fleet/claude-opus-5-5)';
type Window = "out" | "ok" | "missing";
type Pool = { five: Window; week: Window };

function fixture(home: string) {
  const agents = new Map<string, AgentSnapshot>();
  const timelines = new Map<string, unknown[]>();
  const calls = { apply: [] as Array<{ agentId: string; modelId: string; thinkingOptionId: string | null }>, labels: [] as Array<Record<string, string>>, sends: [] as string[], cancels: 0 };
  // `unproven` adds a second Claude account pq cannot read as out or as having quota: a rolled-over 5-hour window, or a
  // stale reading that still shows quota left.
  const pq: { claude: Pool; codex: Pool; stale: boolean; unproven: "rolled_over" | "stale" | null } = { claude: { five: "out", week: "out" }, codex: { five: "ok", week: "ok" }, stale: false, unproven: null };
  // The plugin's own message per turn it started, which is that turn's newest user row.
  const sent = new Map<string, { text: string; messageId: string }>();
  let failApply = 0;
  // What the daemon's stored record holds per agent: it follows memory unless the agent's background persist fails.
  const unpersisted = new Map<string, Profile[]>();
  const stored = async (id: string): Promise<Profile[]> => unpersisted.get(id) ?? (agents.has(id) ? [profileOf(agents.get(id)!)!] : []);
  let config: Config = ConfigSchema.parse({ armed: true, pmFallback: true, quotaCacheSeconds: 0 });
  const handlers = new Map<string, (event: unknown, context?: unknown) => void>();
  const now = () => Math.floor(Date.now() / 1000);
  const windows = (pool: Pool) => [
    { id: "five_hour", fresh: true, leftPct: pool.five === "out" ? 0 : 60, resetAt: now() + 3600, missing: pool.five === "missing" },
    { id: "seven_day", fresh: true, leftPct: pool.week === "out" ? 0 : 60, resetAt: now() + 86400, missing: pool.week === "missing" },
  ].filter((window) => !window.missing);
  const unproven = () => pq.unproven === "rolled_over"
    ? { provider: "claude", state: "rolled_over", fresh: false, availability: null, windows: [
      { id: "five_hour", state: "window_reset", fresh: false, leftPct: null, resetAt: now() - 600 },
      { id: "seven_day", state: "stale", fresh: false, leftPct: 40, resetAt: now() + 86400 },
    ] }
    : { provider: "claude", state: "stale", fresh: false, availability: null, windows: [
      { id: "five_hour", state: "stale", fresh: false, leftPct: 30, resetAt: now() + 3600 },
      { id: "seven_day", state: "stale", fresh: false, leftPct: 40, resetAt: now() + 86400 },
    ] };
  const document = () => ({ schemaVersion: 1, snapshotStale: pq.stale, accounts: [
    { provider: "claude", fresh: true, windows: windows(pq.claude) },
    ...(pq.unproven ? [unproven()] : []),
    { provider: "codex", fresh: true, windows: windows(pq.codex) },
  ] });
  const api = {
    getConnectionState: () => ({ status: "connected" }), close: async () => undefined,
    providers: { listModels: async () => ({ models: [OPUS, SOL].map((id) => ({ id, defaultThinkingOptionId: id === OPUS ? "medium" : "high", thinkingOptions: ["low", "medium", "high"].map((t) => ({ id: t })) })) }) },
    agents: { ref: (id: string) => ({
      refresh: async () => agents.has(id) ? { agent: structuredClone(agents.get(id)!) } : null,
      timeline: { refetch: async () => ({ entries: (timelines.get(id) ?? []).map((item) => ({ item })), hasNewer: false, hasOlder: false }) },
      cancel: async () => { calls.cancels++; },
      send: async (prompt: string, options: { messageId: string }) => {
        const agent = agents.get(id)!;
        calls.sends.push(`${id}:${agent.model}:${prompt.slice(0, 20)}`);
        sent.set(`resume-${calls.sends.length}`, { text: prompt, messageId: options.messageId });
        Object.assign(agent, { status: "running", activeTurn: { turnId: `resume-${calls.sends.length}` }, lastUserMessageAt: new Date().toISOString(), requiresAttention: false });
        handlers.get("agent.turn_started")!({ agent: { id }, turnId: `resume-${calls.sends.length}` });
      },
    }) },
    agentSettings: {
      apply: async (agentId: string, settings: { modelId: string; thinkingOptionId: string | null }) => {
        calls.apply.push({ agentId, ...settings });
        if (failApply > 0) { failApply--; throw new Error("fixture apply rejected"); }
        Object.assign(agents.get(agentId)!, { model: settings.modelId, thinkingOptionId: settings.thinkingOptionId ?? "medium" });
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
    plugin = contribute(server, async () => api, new QuotaReader(async () => ({ document: document() })), new ReturnStore(path.join(home, "pm-return.json")), stored);
    await plugin.idle();
  };
  const stop = async () => { plugin?.(); await plugin?.idle(); plugin = null; };
  const add = (id: string, role: string, extra: Partial<AgentSnapshot> = {}) => {
    agents.set(id, { id, provider: "pi", model: OPUS, thinkingOptionId: "high", cwd: "/fixture", status: "idle", labels: { role },
      lastUserMessageAt: "2026-01-02T00:00:00.000Z", persistence: { provider: "pi", sessionId: `${id}-session` }, ...extra });
  };
  const endTurn = async (id: string, outcome: { kind: "failed"; error: { message: string; code?: string } } | { kind: "completed" }, turnId: string, reply?: string) => {
    const agent = agents.get(id)!;
    Object.assign(agent, outcome.kind === "failed" ? { status: "error", lastError: outcome.error.message, requiresAttention: true, attentionReason: "error" } : { status: "idle" }, { activeTurn: null });
    const own = sent.get(turnId);
    const timeline: unknown[] = [{ type: "user_message", text: own?.text ?? "fixture work", messageId: own?.messageId ?? `${turnId}-user` }];
    if (reply) timeline.push({ type: "assistant_message", text: reply });
    timelines.set(id, timeline);
    handlers.get("agent.turn_ended")!({ agent: { id }, turnId, outcome, timeline }, { paseo: api });
    await plugin!.idle();
  };
  const tick = async () => { mock.timers.tick(30_000); await plugin!.idle(); };
  return {
    agents, calls, pq, start, stop, add, endTurn, tick, handlers, unpersisted,
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

// Review of f244965: a restore acknowledged in memory whose stored record still holds Sol (Paseo's background persist
// failed) is not settled; the obligation stays and the return is written again on later triggers until it is stored.
it("a restore that is not persisted keeps the obligation across a restart and is written again until stored", () => scenario(async (f, logs) => {
  f.add("pm", "pm", { labels: { role: "pm", "opc.service-tier": "fast" } });
  await f.endTurn("pm", { kind: "failed", error: { message: USAGE } }, "pm-turn-1");
  assert.equal(f.agents.get("pm")!.model, SOL);
  // The original Fast label equals the fallback's, so only model and thinking change on return.
  f.unpersisted.set("pm", [{ model: SOL, thinkingOptionId: "medium", serviceTier: "fast" }]);
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, OPUS, "memory reads back the original");
  assert.equal((await f.returns.read()).obligations.length, 1, "never settled on the in-memory readback");
  assert.ok(logs.some((l) => l.includes("pm-restore-unpersisted agentId=pm")));
  // A restart loads the stored Sol record; the obligation is still there and restores it.
  await f.stop();
  Object.assign(f.agents.get("pm")!, { model: SOL, thinkingOptionId: "medium" });
  f.unpersisted.delete("pm");
  const applies = f.calls.apply.length;
  await f.start();
  assert.ok(f.calls.apply.length > applies, "written again after the restart");
  assert.equal(f.agents.get("pm")!.model, OPUS);
  assert.deepEqual((await f.returns.read()).obligations, [], "removed once the stored record holds the original");
}));

it("a persisted swap intent is re-checked before it is applied; one that already landed stays a return", () => scenario(async (f, logs) => {
  const original = { model: OPUS, thinkingOptionId: "high", serviceTier: null };
  const fallback = { model: SOL, thinkingOptionId: "medium", serviceTier: "fast" };
  const cases: Array<[string, Partial<AgentSnapshot>, () => void]> = [
    ["pinned", { labels: { role: "pm", nofallback: "true" } }, () => undefined],
    ["worker", { labels: { role: "worker" } }, () => undefined],
    ["nonclaude", { model: "local/qwen3.8-27b" }, () => undefined],
    ["freed", {}, () => { f.pq.claude = { five: "ok", week: "ok" }; }],
    ["unknown", {}, () => { f.pq.stale = true; }],
  ];
  for (const [id, extra, setQuota] of cases) {
    f.pq.claude = { five: "out", week: "out" };
    f.pq.stale = false;
    f.add(id, "pm", extra);
    await f.returns.add(newObligation(id, original, fallback, "auto", "switching"));
    setQuota();
    await f.tick();
    assert.ok(!f.calls.apply.some((call) => call.agentId === id), `${id} never swapped`);
    assert.equal(await f.returns.get(id), null, `${id}: the unapplied intent is dropped`);
    assert.ok(logs.some((l) => l.includes(`pm-swap-dropped agentId=${id}`)));
  }
}));

it("a swap that partly landed before a crash is finished on stale quota: repaired, rebound, and its retry still runs", () => scenario(async (f, logs) => {
  // The PM's usage turn failed on Opus and its record is held on the out Claude pool; the crash came after the model
  // change but before thinking, the Fast label and the obligation's acknowledgement.
  await f.stop();
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  f.pq.codex = { five: "out", week: "out" };
  await f.start();
  await f.endTurn("pm", { kind: "failed", error: { message: USAGE } }, "pm-turn-1");
  assert.ok((await f.records.read()).find((r) => r.agentId === "pm")?.quotaHold, "held, not swapped");
  await f.returns.add(newObligation("pm", { model: OPUS, thinkingOptionId: "high", serviceTier: null }, { model: SOL, thinkingOptionId: "medium", serviceTier: "fast" }, "auto", "switching"));
  Object.assign(f.agents.get("pm")!, { model: SOL });
  f.pq.codex = { five: "ok", week: "ok" };
  f.pq.stale = true;
  await f.stop();
  await f.start();
  assert.deepEqual(f.calls.apply.at(-1), { agentId: "pm", modelId: SOL, thinkingOptionId: "medium" }, "the partial swap is repaired");
  assert.equal(f.agents.get("pm")!.labels?.["opc.service-tier"], "fast");
  const ob = await f.returns.get("pm");
  assert.equal(ob?.phase, "fallback");
  assert.ok(logs.some((l) => l.includes("pm-swap-verified agentId=pm")));
  const record = (await f.records.read()).find((r) => r.agentId === "pm")!;
  assert.equal(record.model, SOL, "the resume record follows the PM to Sol");
  assert.ok(record.state !== "exhausted" && record.terminalReason !== "identity-changed");
  f.pq.stale = false;
  await f.tick();
  assert.deepEqual(f.calls.sends.filter((s) => s.startsWith("pm:")).map((s) => s.split(":")[1]), [SOL], "the retry resumes on Sol");
}));

it("a completed reply that only mentions a usage limit never swaps a PM", () => scenario(async (f) => {
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn("pm", { kind: "completed" }, "pm-turn-1", "The log shows usage_limit_exceeded: rate limit reached for the fixture account; nothing else failed.");
  assert.deepEqual(f.calls.apply, []);
  assert.equal(f.agents.get("pm")!.model, OPUS);
  assert.deepEqual((await f.returns.read()).obligations, []);
}));

it("an earlier due reading never authorizes a restore on stale or unknown quota", () => scenario(async (f) => {
  await swapPm(f);
  const [obligation] = (await f.returns.read()).obligations;
  await f.returns.update(obligation!.obligationId, (o) => ({ ...o, restoreDueAt: "2026-01-01T00:00:00.000Z" }));
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.stale = true;
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  assert.equal((await f.returns.read()).obligations[0]!.restoreDueAt, null, "no longer due, so Sol resumes are not held");
  f.pq.stale = false;
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, OPUS);
}));

it("a Claude reading without a weekly window is no capacity", () => scenario(async (f) => {
  await swapPm(f);
  f.pq.claude = { five: "ok", week: "missing" };
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  assert.equal((await f.returns.read()).obligations.length, 1);
}));

it("enrolling with an unset thinking option stores the catalog default, so the restore verifies", () => scenario(async (f, logs) => {
  f.add("manual", "pm", { model: SOL, thinkingOptionId: "medium" });
  f.setConfig({ pmFallbackEnroll: [{ agentId: "manual", model: OPUS, thinkingOptionId: null, serviceTier: null }] });
  await f.tick();
  assert.deepEqual((await f.returns.get("manual"))?.original, { model: OPUS, thinkingOptionId: "medium", serviceTier: null });
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.deepEqual(f.calls.apply.at(-1), { agentId: "manual", modelId: OPUS, thinkingOptionId: "medium" });
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(logs.some((l) => l.includes("pm-restore-verified agentId=manual")));
}));

// Review r3 of 002a93f.
it("a pinned agent with a landed swap is never repaired or returned; its resume sends are not held", () => scenario(async (f, logs) => {
  f.add("pm", "pm", { model: SOL, thinkingOptionId: "high", labels: { role: "pm", nofallback: "true" } });
  const ob = await f.returns.add(newObligation("pm", { model: OPUS, thinkingOptionId: "high", serviceTier: null }, { model: SOL, thinkingOptionId: "medium", serviceTier: "fast" }, "auto", "switching"));
  await f.stop();
  f.pq.stale = true;
  await f.start();
  f.pq.stale = false;
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.deepEqual(f.calls.apply, []);
  assert.deepEqual(f.calls.labels, []);
  assert.deepEqual(profileOf(f.agents.get("pm")!), { model: SOL, thinkingOptionId: "high", serviceTier: null });
  const kept = await f.returns.get("pm");
  assert.equal(kept?.obligationId, ob!.obligationId, "the return waits for the owner");
  assert.equal(kept?.restoreDueAt, null);
  assert.equal(kept?.phase, "fallback");
  assert.ok(logs.some((l) => l.includes("pm-return-waiting agentId=pm") && l.includes("reason=opted-out")));
}));

it("a cancel in settings wins on the turn-end path before the sweep reads it", () => scenario(async (f, logs) => {
  f.add("pm", "pm", { model: SOL, thinkingOptionId: "high" });
  const ob = await f.returns.add(newObligation("pm", { model: OPUS, thinkingOptionId: "high", serviceTier: null }, { model: SOL, thinkingOptionId: "medium", serviceTier: "fast" }, "auto", "switching"));
  f.setConfig({ pmFallbackCancel: [ob!.obligationId] });
  await f.endTurn("pm", { kind: "completed" }, "pm-turn-2", "Work completed.");
  assert.deepEqual(f.calls.apply, []);
  assert.deepEqual(f.calls.labels, []);
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(logs.some((l) => l.includes(`pm-return-cancelled agentId=pm obligationId=${ob!.obligationId}`)));
}));

it("a completed reply starting 'API Error: usage_limit_exceeded' never swaps, on the turn or from its held record", () => scenario(async (f) => {
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn("pm", { kind: "completed" }, "pm-turn-1", "API Error: usage_limit_exceeded is now handled in quota.ts; typecheck passed.");
  await f.tick();
  await f.tick();
  assert.deepEqual(f.calls.apply, []);
  assert.equal(f.agents.get("pm")!.model, OPUS);
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(!f.calls.sends.some((s) => s.includes(SOL)));
}));

// Owner cases from the 10/21 incident: every Claude account out, PMs got Anthropic 429s and the API-key route's 402, and
// the plugin kept sending "continue" instead of swapping.
// Review of #189: a 429 that is not an HTTP status, or a 429 whose error type is a blocked one, is no quota refusal.
const NOT_QUOTA = [
  "Connection closed for request id=job-429-a",
  "ENOENT: no such file or directory, open '/fixture/job-429/output.json'",
  '429 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}} (stopReason=error, model=fleet/claude-opus-5-5)',
  '429 {"type":"error","error":{"type":"invalid_request_error","message":"context_length_exceeded"}} (stopReason=error, model=fleet/claude-opus-5-5)',
];

for (const [name, error, decoys] of [["a 429 rate limit", RATE_LIMIT, NOT_QUOTA], ["a 402 credit balance", CREDIT, []]] as const) {
  it(`${name} on a failed PM turn while pq shows the Claude pool out swaps the PM; nothing more is sent on Claude`, () => scenario(async (f, logs) => {
    for (const [n, message] of decoys.entries()) {
      f.add(`decoy-${n}`, "pm", { labels: { role: "pm", project: "fixture" } });
      await f.endTurn(`decoy-${n}`, { kind: "failed", error: { message } }, `decoy-${n}-turn-1`);
    }
    assert.equal(f.calls.apply.length, 0, "a failure that is not a quota refusal never swaps");
    assert.equal(f.calls.sends.length, 0, "and is held on the out pool like any failed turn");
    f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
    await f.endTurn("pm", { kind: "failed", error: { message: error } }, "pm-turn-1");
    assert.deepEqual(f.calls.apply, [{ agentId: "pm", modelId: SOL, thinkingOptionId: "medium" }]);
    assert.equal((await f.returns.get("pm"))?.phase, "fallback");
    assert.ok(logs.some((l) => l.includes("pm-swap-start agentId=pm") && l.includes("trigger=usage-limit-turn")));
    assert.deepEqual(f.calls.sends.map((s) => s.split(":")[1]), [SOL], "the retry runs on Sol, never on Claude");
    assert.equal((await f.records.read()).find((r) => r.agentId === "pm")?.model, SOL);
  }));
}

it("a 429 while pq shows Claude capacity stays transient: retried on Claude, no swap", () => scenario(async (f, logs) => {
  f.pq.claude = { five: "ok", week: "ok" };
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn("pm", { kind: "failed", error: { message: RATE_LIMIT } }, "pm-turn-1");
  assert.deepEqual(f.calls.apply, []);
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.deepEqual(f.calls.sends, [`pm:${OPUS}:continue`]);
  const record = (await f.records.read()).find((r) => r.agentId === "pm")!;
  assert.equal(record.kind, "transient");
  assert.equal(record.quotaHold ?? null, null);
  assert.ok(logs.some((l) => l.includes("pm-fallback-held agentId=pm") && l.includes("claude-pool-has-capacity")));
}));

it("a rolled-over or stale Claude account still returning 429 counts as out: the PM swaps instead of retrying on Claude", async () => {
  for (const unproven of ["rolled_over", "stale"] as const) {
    await scenario(async (f, logs) => {
      f.pq.unproven = unproven;
      f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
      await f.endTurn("pm", { kind: "failed", error: { message: RATE_LIMIT } }, "pm-turn-1");
      assert.deepEqual(f.calls.apply, [{ agentId: "pm", modelId: SOL, thinkingOptionId: "medium" }], unproven);
      assert.deepEqual(f.calls.sends.map((s) => s.split(":")[1]), [SOL], `${unproven}: no continue on Claude`);
      assert.ok(logs.some((l) => l.includes("quota-hold agentId=pm") && l.includes("unproven=1")), unproven);
    });
  }
});

it("the same quota error on consecutive retries stops the loop once, logged once, with no send-skipped repeats", async () => {
  // Review of #189: a quota refusal known only by its structured code repeats the same way.
  const CODE_ONLY = { message: "Provider request rejected. Try again later.", code: "429" };
  for (const [role, error] of [["pm", { message: RATE_LIMIT }], ["worker", { message: RATE_LIMIT }], ["pm", CODE_ONLY], ["worker", CODE_ONLY]] as const) {
    await scenario(async (f, logs) => {
      const label = `${role} ${"code" in error ? "code-only" : "message"}`;
      // pq shows capacity, so the 429 stays transient and is retried; every retry fails the same way.
      f.pq.claude = { five: "ok", week: "ok" };
      f.add("agent", role);
      await f.endTurn("agent", { kind: "failed", error }, "agent-turn-1");
      assert.equal(f.calls.sends.length, 1, label);
      await f.endTurn("agent", { kind: "failed", error }, "resume-1");
      assert.equal((await f.records.read())[0]!.state, "parked", `${label}: one repeat still retries`);
      for (let n = 0; n < 4 && f.calls.sends.length < 2; n++) await f.tick();
      assert.equal(f.calls.sends.length, 2, label);
      await f.endTurn("agent", { kind: "failed", error }, "resume-2");
      for (let n = 0; n < 40; n++) await f.tick();
      assert.equal(f.calls.sends.length, 2, `${label}: no send after the stop`);
      const [record] = await f.records.read();
      assert.equal(record!.state, "exhausted");
      assert.equal(record!.terminalReason, "quota-error-repeated");
      assert.equal(logs.filter((l) => l.includes("retry-stopped agentId=agent")).length, 1, label);
      assert.equal(logs.filter((l) => l.includes("send-skipped agentId=agent")).length, 1, `${label}: the wait for retry 2 is logged once`);
      // A PM is considered for a swap on every quota failure; with Claude capacity it is held, and said once.
      assert.equal(logs.filter((l) => l.includes("pm-fallback-held agentId=agent")).length, role === "pm" ? 1 : 0, label);
      assert.deepEqual(f.calls.apply, []);
    });
  }
});

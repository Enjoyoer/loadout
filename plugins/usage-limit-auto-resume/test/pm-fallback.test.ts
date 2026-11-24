// Owner-specified PM quota fallback cases, through the plugin's real hooks, sweep and state files. Fixture data only.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { ConfigSchema, type Config } from "../server/config.ts";
import { newObligation, profileOf, ReturnStore, type Profile } from "../server/fallback.ts";
import type { AgentSnapshot } from "../server/model.ts";
import { formatRemotePace, QuotaReader, RemotePaceReader, type RemotePaceRunResult } from "../server/quota.ts";
import { ResumeStore } from "../server/store.ts";

const OPUS = "fleet/claude-opus-5-5";
const SOL = "fleet/gpt-6.2-sol";
const FABLE = "fleet/claude-fable-5-2";
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
  // `codexUnproven` adds the same kind of account to the codex pool.
  // `pace` replaces the Claude accounts with labelled ones for pace mode: weekly use and hours to the weekly reset, and a
  // five-hour window's left percentage (null: no five-hour window).
  const pq: { claude: Pool; codex: Pool; stale: boolean; unproven: "rolled_over" | "stale" | null; codexUnproven: boolean; pace: Array<{ label: string; usedPct: number; resetHours: number; five?: number | null }> | null } = { claude: { five: "out", week: "out" }, codex: { five: "ok", week: "ok" }, stale: false, unproven: null, codexUnproven: false, pace: null };
  // The plugin's own message per turn it started, which is that turn's newest user row.
  const sent = new Map<string, { text: string; messageId: string }>();
  let failApply = 0;
  // Race hooks (T9, T11): run before an agent read, after it with the snapshot it returns, and on a settings write
  // (T17: a promise holds the write in flight).
  // T12, T13, T15: run before a send; a throw fails it, and a promise holds it in flight.
  let beforeSend: ((agent: AgentSnapshot) => void | Promise<void>) | undefined;
  let beforeFetch: ((id: string) => Promise<void>) | undefined;
  let afterFetch: ((agent: AgentSnapshot | undefined) => Promise<void>) | undefined;
  let onApply: ((agentId: string, model: string) => void | Promise<void>) | undefined;
  // M8: runs inside every pq read, before the reading is returned (a relabel while a decision awaits pq).
  let onPq: (() => void | Promise<void>) | undefined;
  // Remote pace fixture: when pqUnavailable is true, local pq returns ENOENT (modeling a vm host without pq).
  let pqUnavailable = false;
  let onRemotePace: ((host: string, command: readonly string[], timeoutMs: number) => Promise<RemotePaceRunResult>) | undefined;
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
  const paced = () => pq.pace!.map(({ label, usedPct, resetHours, five = 60 }) => ({ provider: "claude", label, fresh: true, windows: [
    ...(five === null ? [] : [{ id: "five_hour", fresh: true, leftPct: five, usedPct: 100 - five, resetAt: now() + 3600, resetInSeconds: 3600 }]),
    { id: "seven_day", fresh: true, leftPct: 100 - usedPct, usedPct, resetAt: now() + resetHours * 3600, resetInSeconds: resetHours * 3600 },
  ] }));
  const document = () => ({ schemaVersion: 1, snapshotStale: pq.stale, accounts: [
    ...(pq.pace ? paced() : [{ provider: "claude", fresh: true, windows: windows(pq.claude) }]),
    ...(pq.unproven ? [unproven()] : []),
    ...(pq.codexUnproven ? [{ ...unproven(), provider: "codex" }] : []),
    { provider: "codex", fresh: true, windows: windows(pq.codex) },
  ] });
  const api = {
    getConnectionState: () => ({ status: "connected" }), close: async () => undefined,
    providers: { listModels: async () => ({ models: [OPUS, SOL, FABLE].map((id) => ({ id, defaultThinkingOptionId: id === OPUS ? "medium" : "high", thinkingOptions: ["low", "medium", "high"].map((t) => ({ id: t })) })) }) },
    agents: { list: async (options?: { filter?: { labels?: Record<string, string> } }) => ({
      entries: [...agents.values()].filter((agent) => !agent.archivedAt && Object.entries(options?.filter?.labels ?? {}).every(([key, value]) => agent.labels?.[key] === value)).map((agent) => ({ agent: structuredClone(agent) })),
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    }), ref: (id: string) => ({
      refresh: async () => {
        await beforeFetch?.(id);
        const agent = agents.has(id) ? structuredClone(agents.get(id)!) : undefined;
        await afterFetch?.(agent);
        return agent ? { agent } : null;
      },
      timeline: { refetch: async () => ({ entries: (timelines.get(id) ?? []).map((item) => ({ item })), hasNewer: false, hasOlder: false }) },
      cancel: async () => { calls.cancels++; },
      send: async (prompt: string, options: { messageId: string }) => {
        const agent = agents.get(id)!;
        await beforeSend?.(agent);
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
        await onApply?.(agentId, settings.modelId);
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
    const quotaReader = new QuotaReader(async () => {
      await onPq?.();
      return pqUnavailable ? { error: "pq unavailable (no local pq)" } : { document: document() };
    });
    const remoteReader = new RemotePaceReader(async (host, command, timeoutMs) =>
      onRemotePace ? onRemotePace(host, command, timeoutMs) : { error: "remote-unavailable" });
    plugin = contribute(server, async () => api, quotaReader, new ReturnStore(path.join(home, "pm-return.json")), stored, undefined, undefined, undefined, remoteReader);
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
    home, agents, calls, pq, start, stop, add, endTurn, tick, handlers, unpersisted, timelines, sent,
    returns: new ReturnStore(path.join(home, "pm-return.json")), records: new ResumeStore(),
    failApplies: (n: number) => { failApply = n; },
    setPqUnavailable: (value: boolean) => { pqUnavailable = value; },
    setRemotePace: (fn: typeof onRemotePace) => { onRemotePace = fn; },
    hooks: (set: { beforeFetch?: typeof beforeFetch; afterFetch?: typeof afterFetch; onApply?: typeof onApply; beforeSend?: typeof beforeSend; onPq?: typeof onPq }) => { ({ beforeFetch, afterFetch, onApply, beforeSend, onPq } = set); },
    // Delivers a turn end as given (T13, T15: a late event for an older turn); resolves when the plugin is idle.
    emit: (event: unknown) => { handlers.get("agent.turn_ended")!(event, { paseo: api }); return plugin!.idle(); },
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

// Decision 302 a: a worker on the same failure swaps and resumes the same way as a PM.
it("PM fallback swaps exactly and resumes the same session on Sol; a worker on the same failure swaps too", () => scenario(async (f, logs) => {
  f.add("worker", "worker");
  await f.endTurn("worker", { kind: "failed", error: { message: USAGE } }, "worker-turn-1");
  await swapPm(f);
  assert.deepEqual(f.calls.apply, [{ agentId: "worker", modelId: SOL, thinkingOptionId: "medium" }, { agentId: "pm", modelId: SOL, thinkingOptionId: "medium" }]);
  assert.deepEqual(f.calls.labels, [{ "opc.service-tier": "standard" }, { "opc.service-tier": "standard" }]);
  assert.equal(f.agents.get("worker")!.model, SOL);
  const obligation = await f.returns.get("pm");
  assert.deepEqual(obligation!.original, { model: OPUS, thinkingOptionId: "high", serviceTier: null });
  assert.equal(obligation!.phase, "fallback");
  assert.deepEqual(f.calls.sends.filter((s) => s.startsWith("pm:")).map((s) => s.split(":")[1]), [SOL]);
  assert.ok(logs.some((l) => l.includes("pm-swap-start agentId=pm")) && logs.some((l) => l.includes("pm-swap-verified agentId=pm")));
  const pmRecord = (await f.records.read()).find((r) => r.agentId === "pm")!;
  assert.equal(pmRecord.model, SOL);
  assert.equal(pmRecord.persistenceSessionId, "pm-session");
  // The worker's record follows it to Sol and is resent there once, as the PM's is.
  assert.deepEqual((await f.returns.get("worker"))!.original, { model: OPUS, thinkingOptionId: "high", serviceTier: null });
  assert.equal((await f.records.read()).find((r) => r.agentId === "worker")!.model, SOL);
  assert.deepEqual(f.calls.sends.filter((s) => s.startsWith("worker:")).map((s) => s.split(":")[1]), [SOL]);
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

it("an owner cancel or an explicit model change ends the return; role loss does not", () => scenario(async (f, logs) => {
  await swapPm(f);
  const [obligation] = (await f.returns.read()).obligations;
  Object.assign(f.agents.get("pm")!, { labels: { ...f.agents.get("pm")!.labels, role: "worker" } });
  await f.tick();
  assert.equal((await f.returns.read()).obligations.length, 1, "a lost role keeps the return");
  f.setConfig({ pmFallbackCancel: [obligation!.obligationId] });
  await f.tick();
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(logs.some((l) => l.includes(`pm-return-cancelled agentId=pm obligationId=${obligation!.obligationId} by=owner-setting`)));
  f.setConfig({ pmFallbackCancel: [] });
  await swapPm(f, "pm2");
  Object.assign(f.agents.get("pm2")!, { model: "fleet/claude-fable-5-1" });
  await f.tick();
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(logs.some((l) => l.includes("pm-return-dropped agentId=pm2") && l.includes("reason=profile-changed")));
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("pm2")!.model, "fleet/claude-fable-5-1");
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

it("owner enrollment registers an already-fallen-back PM once and returns it on release; archive is respected, a nofallback label is not", () => scenario(async (f, logs) => {
  f.add("manual", "pm", { model: SOL, thinkingOptionId: "medium" });
  f.add("labelled", "pm", { labels: { role: "pm", nofallback: "true" } });
  f.setConfig({ pmFallbackEnroll: [{ agentId: "manual", model: OPUS, thinkingOptionId: "high", serviceTier: null }] });
  await f.tick();
  await f.tick();
  const obligations = (await f.returns.read()).obligations;
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0]!.source, "enrolled");
  assert.equal(logs.filter((l) => l.includes("pm-enrolled agentId=manual")).length, 1);
  await f.endTurn("labelled", { kind: "failed", error: { message: USAGE } }, "labelled-turn-1");
  assert.equal(f.agents.get("labelled")!.model, SOL, "the nofallback label is ignored");
  f.agents.get("manual")!.archivedAt = "2026-01-02T11:00:00.000Z";
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("manual")!.model, SOL, "archived agents are not touched");
  assert.ok(await f.returns.get("manual"), "the obligation waits");
  assert.equal(f.agents.get("labelled")!.model, OPUS, "the labelled PM returns like any other");
  f.agents.get("manual")!.archivedAt = null;
  await f.tick();
  assert.equal(f.agents.get("manual")!.model, OPUS);
}));

// Review of f244965: a restore acknowledged in memory whose stored record still holds Sol (Paseo's background persist
// failed) is not settled; the obligation stays and the return is written again on later triggers until it is stored.
it("a restore that is not persisted keeps the obligation across a restart and is written again until stored", () => scenario(async (f, logs) => {
  // The fallback tier is set to the original's (the default is standard since 0.4.2).
  f.setConfig({ pmFallbackServiceTier: "fast" });
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
    ["archived", { archivedAt: "2026-01-02T09:00:00.000Z" }, () => undefined],
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

// 10/21: a PM that inherited nofallback=true through a PM reassignment was never swapped. The label is ignored now.
it("a nofallback label is ignored: the PM swaps on a quota refusal, a landed swap is finished, and both return", () => scenario(async (f, logs) => {
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture", nofallback: "true" } });
  await f.endTurn("pm", { kind: "failed", error: { message: RATE_LIMIT } }, "pm-turn-1");
  assert.deepEqual(f.calls.apply, [{ agentId: "pm", modelId: SOL, thinkingOptionId: "medium" }]);
  assert.deepEqual(f.calls.sends.map((s) => s.split(":")[1]), [SOL], "the retry runs on Sol");
  // A swap that landed before a restart is repaired and kept as a return, not left pinned.
  f.add("landed", "pm", { model: SOL, thinkingOptionId: "high", labels: { role: "pm", nofallback: "true" } });
  await f.returns.add(newObligation("landed", { model: OPUS, thinkingOptionId: "high", serviceTier: null }, { model: SOL, thinkingOptionId: "medium", serviceTier: "fast" }, "auto", "switching"));
  await f.tick();
  assert.deepEqual(f.calls.apply.at(-1), { agentId: "landed", modelId: SOL, thinkingOptionId: "medium" });
  assert.equal((await f.returns.get("landed"))?.phase, "fallback");
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, OPUS);
  assert.deepEqual(profileOf(f.agents.get("landed")!), { model: OPUS, thinkingOptionId: "high", serviceTier: null });
  assert.deepEqual((await f.returns.read()).obligations, []);
  assert.ok(!logs.some((l) => l.includes("opted-out")), "no opt-out path is left");
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
// Review of #189, every round: a 429 that is not a leading status, a status inside an ID, a path or a URL (escaped
// quotes included), or a 429 whose error type is a blocked one, is no quota refusal.
const NOT_QUOTA = [
  "Connection closed for request id=job-429-a",
  "ENOENT: no such file or directory, open '/fixture/job-429/output.json'",
  "429 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}} (stopReason=error, model=fleet/claude-opus-5-5)",
  "429 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"context_length_exceeded\"}} (stopReason=error, model=fleet/claude-opus-5-5)",
  "ENOENT: no such file or directory, open /fixture/job-429/output.json",
  "Tool process exited with code 1; processed 429 files",
  "429 {\"error\":{\"type\":\"overloaded_error\",\"message\":\"Try again later\"}}",
  "429 {\"error\":{\"type\":\"context_length_exceeded\",\"message\":\"input too long\"}}",
  "Transport failed for id=code429",
  "Transport failed for id=status429",
  "Transport failed for id=http429",
  "ENOENT: open '/fixture/status=429'",
  "ENOENT: open '/fixture/code429'",
  "429 files processed before transport broke",
  "429 bytes read; connection closed",
  "Transport failed after 429 files",
  "Request 1429 failed",
  "Transport failure, request_id=abc429def",
  "ENOENT: open '/fixture/rate_limit_error'",
  "Transport failed id=rate_limit_error-id",
  "429 temporarily limiting requests",
  "429 overloaded_error",
  "429 context_length_exceeded",
  "429 model_cooldown_active",
  "Connection refused https://example.test/?status=429",
  "Connection refused https://example.test/resource;status=429",
  "ENOENT: open 'C:\\fixture\\code429'",
  "ENOENT: open 'C:\\fixture\\status=429'",
  "ENOENT: open 'C:\\fixture\\status code 429\\output.json'",
  "ENOENT: open 'C:\\fixture\\job code 429'",
  "ENOENT: open '\\\\server\\share\\status=429'",
  "ENOENT: open /fixture/job;status=429",
  "ENOENT: open /fixture/code/429",
  "ENOENT: open \"/fixture/\\\" status=429\"",
  // Fifth review: a rule-B phrase inside a path.
  "ENOENT: open 'C:\\fixture\\insufficient_credits\\output.json'",
  "ENOENT: open '/fixture/Too Many Requests.log'",
  "ENOENT: open '/fixture/credit balance is too low.log'",
];

// A credit message that also carries a billing URL is still a refusal (fourth review).
const CREDIT_URL = '402 {"error":{"type":"invalid_request_error","message":"Your credit balance is too low. Please visit https://example.test/billing"}} (stopReason=error, model=fleet/claude-opus-5-5)';

for (const [name, error, decoys] of [["a 429 rate limit", RATE_LIMIT, NOT_QUOTA], ["a 402 credit balance", CREDIT, []], ["a 402 credit balance with a billing URL", CREDIT_URL, []]] as const) {
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
  // Review of #189: a refusal counts only for the pool that refused. After the swap, Sol failing with the same generic
  // text and no code is no Codex refusal, whether its end event arrives or only the live error is re-read.
  const CODE_ONLY = { message: "Provider request rejected. Try again later.", code: "429" };
  for (const mode of ["end-event", "re-verified"] as const) {
    await scenario(async (f, logs) => {
      f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
      await f.endTurn("pm", { kind: "failed", error: CODE_ONLY }, "pm-turn-1");
      assert.equal(f.agents.get("pm")!.model, SOL, mode);
      f.pq.codex = { five: "out", week: "ok" };
      f.pq.codexUnproven = true;
      if (mode === "end-event") await f.endTurn("pm", { kind: "failed", error: { message: CODE_ONLY.message } }, "resume-1");
      else {
        Object.assign(f.agents.get("pm")!, { status: "error", lastError: CODE_ONLY.message, activeTurn: null, requiresAttention: true, attentionReason: "error" });
        f.timelines.set("pm", [{ type: "user_message", ...f.sent.get("resume-1")! }, { type: "assistant_message", text: `[System Error] ${CODE_ONLY.message}` }]);
      }
      for (let n = 0; n < 6; n++) await f.tick();
      const record = (await f.records.read()).find((r) => r.agentId === "pm")!;
      assert.equal(record.refusedPool ?? null, null, `${mode}: Claude's refusal never moves to the codex pool`);
      assert.ok(!logs.some((l) => l.includes("quota-hold agentId=pm") && l.includes("pool=codex")), `${mode}: no codex hold`);
      assert.equal(f.calls.sends.filter((s) => s.includes(SOL)).length, 2, `${mode}: the retry on Sol is sent`);
    });
  }
  // And a Sol refusal carried through a restore and a re-verification is never Claude's: no second swap.
  await scenario(async (f, logs) => {
    f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
    await f.endTurn("pm", { kind: "failed", error: CODE_ONLY }, "pm-turn-1");
    await f.endTurn("pm", { kind: "failed", error: CODE_ONLY }, "resume-1");
    assert.equal((await f.records.read())[0]!.refusedPool, "codex", "Sol's own refusal is codex's");
    f.pq.claude = { five: "ok", week: "ok" };
    await f.tick();
    assert.equal(f.agents.get("pm")!.model, OPUS, "restored");
    // A resolved permission request sends the parked record through re-verification of the live (Sol) error.
    f.handlers.get("agent.permission_requested")!({ agent: { id: "pm" } });
    await f.tick();
    await f.tick();
    f.pq.claude = { five: "out", week: "ok" };
    f.pq.unproven = "stale";
    for (let n = 0; n < 10; n++) await f.tick();
    assert.equal(logs.filter((l) => l.includes("pm-swap-start agentId=pm")).length, 1, "no swap without a new Claude refusal");
    assert.deepEqual(f.calls.apply.map((c) => c.modelId), [SOL, OPUS]);
    assert.deepEqual(f.calls.sends.map((s) => s.split(":")[1]), [SOL, OPUS], "the retry after the restore runs on Claude");
  });
});

// The 10/21 incident: PMs got Anthropic's 429 rate_limit_error while pq showed weekly quota left, and every record ended
// `quota-error-repeated` after two retries, leaving the PM idle. Now every retry goes out on the backoff, past the
// third, until a success or a newer user message.
it("a repeated 429 rate_limit_error with pool capacity keeps retrying on the backoff past attempt 3, until success or a newer user message", async () => {
  // Review of #189: a quota refusal known only by its structured code repeats the same way.
  const CODE_ONLY = { message: "Provider request rejected. Try again later.", code: "429" };
  const cases = [["pm", { message: RATE_LIMIT }, "success"], ["worker", { message: RATE_LIMIT }, "newer-user-message"], ["pm", CODE_ONLY, "newer-user-message"], ["worker", CODE_ONLY, "success"]] as const;
  for (const [role, error, end] of cases) {
    await scenario(async (f, logs) => {
      const label = `${role} ${"code" in error ? "code-only" : "message"} ${end}`;
      // pq shows capacity, so the 429 stays transient and is retried; every retry fails the same way.
      f.pq.claude = { five: "ok", week: "ok" };
      f.add("agent", role);
      await f.endTurn("agent", { kind: "failed", error }, "agent-turn-1");
      // Seconds from each failure to the send that retries it.
      const gaps: number[] = [];
      let failedAt = Date.now();
      const sent = async (count: number) => {
        for (let n = 0; n < 100 && f.calls.sends.length < count; n++) await f.tick();
        assert.equal(f.calls.sends.length, count, label);
        gaps.push((Date.now() - failedAt) / 1000);
      };
      await sent(1);
      for (let retry = 1; retry <= 6; retry++) {
        await f.endTurn("agent", { kind: "failed", error }, `resume-${retry}`);
        failedAt = Date.now();
        assert.equal((await f.records.read())[0]!.state, "parked", `${label}: retry ${retry} failed and is parked again`);
        await sent(retry + 1);
      }
      assert.deepEqual(gaps, [0, 120, 300, 900, 1800, 1800, 1800], label);
      assert.ok(f.calls.sends.every((s) => s === `agent:${OPUS}:continue`), label);
      if (end === "success") {
        await f.endTurn("agent", { kind: "completed" }, "resume-7", "Work completed.");
        assert.deepEqual(await f.records.read(), [], `${label}: the success removes the record`);
      } else {
        await f.endTurn("agent", { kind: "failed", error }, "resume-7");
        await f.tick();
        Object.assign(f.agents.get("agent")!, { lastUserMessageAt: new Date().toISOString() });
        await f.endTurn("agent", { kind: "completed" }, "user-turn-2", "Answered.");
        const [record] = await f.records.read();
        assert.equal(record!.state, "superseded", label);
        assert.equal(record!.terminalReason, "newer-user-message", label);
      }
      for (let n = 0; n < 120; n++) await f.tick();
      assert.equal(f.calls.sends.length, 7, `${label}: nothing is sent after the stop`);
      // One line per retry, never one per poll.
      assert.equal(logs.filter((l) => l.includes("retry-sent agentId=agent")).length, 7, label);
      assert.equal(logs.filter((l) => l.includes("retry-scheduled agentId=agent")).length, end === "success" ? 6 : 7, label);
      assert.equal(logs.filter((l) => l.includes("send-skipped agentId=agent")).length, end === "success" ? 6 : 7, `${label}: each wait is logged once`);
      assert.ok(!logs.some((l) => l.includes("retry-stopped") || l.includes("exhausted")), label);
      // Any Pi agent (a PM or, since decision 302 a, a worker) is considered for a swap on every quota failure; with
      // Claude capacity it is held, and said once.
      assert.equal(logs.filter((l) => l.includes("pm-fallback-held agentId=agent")).length, 1, label);
      assert.deepEqual(f.calls.apply, []);
    });
  }
});

// PM-specified (decision 236): the router's 503 when it has no usable Claude account, with and without Pi's lead.
const CPA_UNAVAILABLE = 'Claude 5h limit; retry after Jan 3 10:00 EST (account quota exceeded). 503 {"type":"error","error":{"type":"api_error","message":"auth_unavailable: no auth available (providers=claude, model=claude-opus-5-5; last upstream error: rate_limit_error: This request would exceed your account\'s rate limit. Please try again later.); check Claude auth"}} (stopReason=error, model=fleet/claude-opus-5-5)';
const CPA_NOT_FOUND = '503 {"type":"error","error":{"type":"api_error","message":"auth_not_found: no auth candidates (providers=claude, model=claude-opus-5-5); check Claude auth"}} (stopReason=error, model=fleet/claude-opus-5-5)';

// One turn fails with auth_unavailable, its immediate retry with auth_not_found. Returns the retry's turn id.
async function cpaTwice(f: ReturnType<typeof fixture>, id: string, turn: string) {
  const before = f.calls.sends.length;
  await f.endTurn(id, { kind: "failed", error: { message: CPA_UNAVAILABLE } }, turn);
  assert.equal(f.calls.sends.length, before + 1, "the first failure is retried at once");
  const retry = `resume-${f.calls.sends.length}`;
  await f.endTurn(id, { kind: "failed", error: { message: CPA_NOT_FOUND } }, retry);
  return retry;
}

it("T1: an Opus PM refused twice in a row by CPA's 503 moves to Sol high on the second, though pq shows Claude capacity and Codex out", () => scenario(async (f, logs) => {
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.setConfig({ pmFallbackThinking: "high" });
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_UNAVAILABLE } }, "pm-turn-1");
  assert.deepEqual(f.calls.apply, [], "no swap after the first");
  assert.deepEqual(f.calls.sends, [`pm:${OPUS}:continue`]);
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_NOT_FOUND } }, "resume-1");
  assert.deepEqual(f.calls.apply, [{ agentId: "pm", modelId: SOL, thinkingOptionId: "high" }], "swap after the second");
  const obligation = await f.returns.get("pm");
  assert.equal(obligation?.phase, "fallback");
  assert.equal(obligation?.cpa503, true);
  assert.equal((await f.returns.read()).cpaStreaks?.pm, undefined, "the run ends with the move");
  assert.ok(logs.some((l) => l.includes("pm-swap-start agentId=pm") && l.includes("trigger=cpa-503-twice evidence=cpa-503")));
  assert.equal((await f.records.read()).find((r) => r.agentId === "pm")?.model, SOL, "its resume record follows it to Sol");
}));

// Decision 302 a replaces decision 236's T2 (a non-PM never swapped): a worker moves exactly as a PM does.
it("T2: a worker with the same two failures moves to Sol on the second, as a PM does", () => scenario(async (f, logs) => {
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("worker", "worker");
  await cpaTwice(f, "worker", "worker-turn-1");
  assert.deepEqual(f.calls.apply, [{ agentId: "worker", modelId: SOL, thinkingOptionId: "medium" }]);
  assert.equal((await f.returns.get("worker"))?.cpa503, true);
  assert.equal((await f.returns.read()).cpaStreaks?.worker, undefined, "the run ends with the move");
  assert.ok(logs.some((l) => l.includes("pm-swap-start agentId=worker") && l.includes("trigger=cpa-503-twice evidence=cpa-503")));
  assert.equal((await f.records.read()).find((r) => r.agentId === "worker")?.model, SOL, "its resume record follows it to Sol");
}));

it("T3: a failed turn on Sol after the CPA swap changes no model and starts no return", () => scenario(async (f, logs) => {
  f.pq.claude = { five: "ok", week: "ok" };
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  await cpaTwice(f, "pm", "pm-turn-1");
  for (let n = 0; n < 5; n++) await f.tick();
  assert.deepEqual(f.calls.sends.map((s) => s.split(":")[1]), [OPUS, SOL], "the resume goes out on Sol");
  await f.endTurn("pm", { kind: "failed", error: { message: "503 temporarily unavailable (stopReason=error, model=fleet/gpt-6.2-sol)" } }, "resume-2");
  for (let n = 0; n < 20; n++) await f.tick();
  assert.deepEqual(f.calls.apply.map((c) => c.modelId), [SOL], "no further change");
  assert.equal(f.agents.get("pm")!.model, SOL);
  assert.equal((await f.returns.get("pm"))?.restoreDueAt, null, "no return");
  assert.equal(logs.filter((l) => l.includes("pm-fallback-turn-failed agentId=pm")).length, 1);
  assert.ok(f.calls.sends.length > 2 && f.calls.sends.slice(2).every((s) => s.split(":")[1] === SOL), "its record retries on Sol as usual");
}));

it("T4: a CPA return comes at once on a seen Claude success, and on pq alone at most once per 60 minutes", async () => {
  await scenario(async (f, logs) => {
    f.pq.claude = { five: "ok", week: "ok" };
    f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
    f.add("other", "worker");
    await cpaTwice(f, "pm", "pm-turn-1");
    assert.equal(f.agents.get("pm")!.model, SOL);
    await f.tick();
    assert.equal(f.agents.get("pm")!.model, SOL, "pq capacity alone does not return it");
    assert.ok(logs.some((l) => l.includes("pm-return-waiting agentId=pm") && l.includes("reason=pq-contradicted")));
    await f.endTurn("other", { kind: "completed" }, "other-turn-1", "Work completed.");
    await f.tick();
    assert.equal(f.agents.get("pm")!.model, OPUS);
    assert.ok(logs.some((l) => l.includes("pm-restore-due agentId=pm") && l.includes("reason=claude-success agent=other")));
  });
  await scenario(async (f, logs) => {
    f.pq.claude = { five: "ok", week: "ok" };
    f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
    await cpaTwice(f, "pm", "pm-turn-1");
    const swappedAt = Date.now();
    for (let n = 0; n < 5; n++) await f.tick();
    await f.endTurn("pm", { kind: "completed" }, "resume-2", "Done on Sol.");
    while (Date.now() < swappedAt + 59 * 60_000) await f.tick();
    assert.equal(f.agents.get("pm")!.model, SOL, "no return on pq before 60 minutes");
    while (Date.now() < swappedAt + 61 * 60_000) await f.tick();
    assert.equal(f.agents.get("pm")!.model, OPUS, "the hourly pq probe returns it");
    assert.ok(logs.some((l) => l.includes("pm-restore-due agentId=pm") && l.includes("reason=pq-probe")));
    // Refused twice again: back on Sol, and pq does not return it for another hour.
    await cpaTwice(f, "pm", "pm-turn-2");
    assert.equal(f.agents.get("pm")!.model, SOL);
    const again = Date.now();
    while (Date.now() < again + 59 * 60_000) await f.tick();
    assert.equal(f.agents.get("pm")!.model, SOL);
    assert.equal(logs.filter((l) => l.includes("pm-restore-due agentId=pm")).length, 1);
  });
});

it("T6: with pq showing Claude and Codex out, an Opus PM's CPA resend is not held, its second CPA 503 moves it to Sol high, and the resend on Sol goes out at once", () => scenario(async (f, logs) => {
  f.pq.claude = { five: "out", week: "out" };
  f.pq.codex = { five: "out", week: "out" };
  f.setConfig({ pmFallbackThinking: "high" });
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_UNAVAILABLE } }, "pm-turn-1");
  assert.deepEqual(f.calls.sends, [`pm:${OPUS}:continue`], "the first CPA 503 is resent after the first transient delay, not held");
  assert.ok(!logs.some((l) => l.includes("quota-hold agentId=pm")));
  assert.deepEqual(f.calls.apply, []);
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_UNAVAILABLE } }, "resume-1");
  assert.deepEqual(f.calls.apply, [{ agentId: "pm", modelId: SOL, thinkingOptionId: "high" }], "the second moves it to Sol high");
  assert.deepEqual(f.calls.sends, [`pm:${OPUS}:continue`, `pm:${SOL}:continue`], "the resend on Sol goes out at once");
  assert.ok(!logs.some((l) => l.includes("quota-hold agentId=pm")));
}));

it("T7: a CPA count from Opus does not survive the PM's change to another model", () => scenario(async (f, logs) => {
  const fable = "fleet/claude-fable-5-2";
  f.pq.claude = { five: "out", week: "out" };
  f.pq.codex = { five: "out", week: "out" };
  f.setConfig({ pmFallback: false, pmFallbackThinking: "high" });
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_NOT_FOUND } }, "pm-turn-1");
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_NOT_FOUND } }, "pm-turn-2");
  assert.equal((await f.returns.read()).cpaStreaks?.pm?.count, 2, "two on Opus while fallback is off");
  Object.assign(f.agents.get("pm")!, { model: fable });
  f.setConfig({ pmFallback: true, pmFallbackThinking: "high" });
  await f.tick();
  assert.deepEqual(f.calls.apply, [], "the Opus count moves no PM now on Fable");
  assert.ok(!logs.some((l) => l.includes("pm-swap-start agentId=pm")));
  assert.ok(logs.some((l) => l.includes("pm-cpa-count-dropped agentId=pm reason=profile-changed")));
  assert.equal((await f.returns.read()).cpaStreaks?.pm, undefined);
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_NOT_FOUND.replace(/claude-opus-5-5/g, "claude-fable-5-2") } }, "pm-turn-3");
  assert.equal((await f.returns.read()).cpaStreaks?.pm?.count, 1, "a Fable refusal starts a new count");
  await f.endTurn("pm", { kind: "failed", error: { message: CPA_NOT_FOUND } }, "pm-turn-4");
  assert.equal((await f.returns.read()).cpaStreaks?.pm, undefined, "a refusal of the old model counts nothing on the new one");
}));

it("T8: a diagnostic that only quotes CPA's refusal does not count", () => scenario(async (f) => {
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  const quoted = '503 {"type":"error","error":{"type":"api_error","message":"Diagnostic quoting auth_unavailable: no auth available (providers=claude, model=claude-opus-5-5)"}} (stopReason=error, model=fleet/claude-opus-5-5)';
  await f.endTurn("pm", { kind: "failed", error: { message: quoted } }, "pm-turn-1");
  await f.endTurn("pm", { kind: "failed", error: { message: quoted } }, "resume-1");
  for (let n = 0; n < 5; n++) await f.tick();
  assert.deepEqual(f.calls.apply, []);
  assert.equal((await f.returns.read()).cpaStreaks, undefined);
  assert.ok(f.calls.sends.every((s) => s.startsWith(`pm:${OPUS}:`)), "it retries on Opus as on main");
}));

// CPA's 503 for a turn on `model`.
const cpaOn = (model: string) => ({ kind: "failed" as const, error: { message: CPA_NOT_FOUND.replace(/claude-opus-5-5/g, model.split("/").at(-1)!) } });
// Rejects after `ms` of real time, so a race that never reaches its pause fails the test instead of hanging it.
const within = (ms: number, label: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), ms).unref());

it("T9: a newer user turn whose record is written after a sweep made the CPA move takes the move's one pq-free resend on Sol", () => scenario(async (f, logs) => {
  f.setConfig({ pmFallbackThinking: "high", transientBackoffSeconds: [60, 120] });
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("pm", "pm");
  await f.endTurn("pm", cpaOn(OPUS), "user-1");
  assert.equal((await f.records.activeForAgent("pm"))?.state, "parked");
  // User turn 2 fails the same way. Its handler pauses after the first record was superseded and before its own is
  // written, while the timer sweep moves the PM.
  let entered!: () => void, release!: () => void, moved!: () => void;
  const enteredP = new Promise<void>((resolve) => { entered = resolve; });
  const releaseP = new Promise<void>((resolve) => { release = resolve; });
  const movedP = new Promise<void>((resolve) => { moved = resolve; });
  let blocked = false;
  f.hooks({
    beforeFetch: async (id) => {
      if (id !== "pm" || blocked || (await f.returns.read()).cpaStreaks?.pm?.count !== 2 || await f.records.activeForAgent("pm")) return;
      blocked = true; entered(); await releaseP;
    },
    onApply: () => moved(),
  });
  Object.assign(f.agents.get("pm")!, { lastUserMessageAt: new Date().toISOString() });
  const ended = f.endTurn("pm", cpaOn(OPUS), "user-2");
  try {
    await Promise.race([enteredP, within(2000, "no gap before the new record")]);
    mock.timers.tick(30_000);
    await Promise.race([movedP, within(2000, "the sweep did not move the PM")]);
  } finally { release(); await ended; }
  f.hooks({});
  assert.deepEqual(f.calls.apply.map((c) => c.modelId), [SOL]);
  assert.deepEqual(f.calls.sends, [`pm:${SOL}:continue`], "turn 2's record resends at once on Sol");
  for (let n = 0; n < 8; n++) await f.tick();
  assert.equal(f.calls.sends.length, 1, "exactly one Sol send");
  const records = (await f.records.read()).map((r) => [r.sourceTurnId, r.state, !!r.quotaHold]);
  assert.deepEqual(records, [["user-1", "superseded", false], ["user-2", "verifying", false]]);
  assert.ok(!logs.some((l) => l.includes("quota-hold agentId=pm")));
  assert.equal((await f.returns.get("pm"))?.cpaResend, false, "the owed resend is spent");
}));

it("T10: a CPA chain steps back from Sol to Opus at most once an hour; a Fable success still returns the PM at once", async () => {
  // Fable PM on Sol by CPA's 503 (Fable twice, Opus twice); an unrelated Opus success steps it back; refused twice
  // again on Opus, it is on Sol again; a second Opus success comes. Returns the time of the first step back.
  const bounce = async (f: ReturnType<typeof fixture>) => {
    f.setConfig({ pmFallbackThinking: "high", pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
    f.pq.claude = { five: "ok", week: "ok" };
    f.pq.codex = { five: "out", week: "out" };
    f.add("pm", "pm", { model: FABLE });
    f.add("other", "worker");
    const fail = (model: string, id?: string) => f.endTurn("pm", cpaOn(model), id ?? `resume-${f.calls.sends.length}`);
    await fail(FABLE, "fable-1"); await fail(FABLE); await fail(OPUS); await fail(OPUS);
    assert.deepEqual(f.calls.apply.map((c) => c.modelId), [OPUS, SOL]);
    await f.tick();
    await f.endTurn("other", { kind: "completed" }, "other-1", "Normal reply on Opus.");
    await f.tick();
    assert.equal(f.agents.get("pm")!.model, OPUS, "the first step back");
    const steppedBack = Date.parse((await f.returns.get("pm"))!.steppedBackAt!);
    Object.assign(f.agents.get("pm")!, { lastUserMessageAt: new Date().toISOString() });
    await fail(OPUS, "fresh-opus-failure"); await fail(OPUS);
    assert.equal(f.agents.get("pm")!.model, SOL);
    await f.tick();
    await f.endTurn("other", { kind: "completed" }, "other-2", "Another normal reply on Opus.");
    await f.tick();
    return steppedBack;
  };
  await scenario(async (f, logs) => {
    const steppedBack = await bounce(f);
    assert.equal(f.agents.get("pm")!.model, SOL, "no second step back inside the hour");
    assert.ok(logs.some((l) => l.includes("pm-stage-waiting agentId=pm") && l.includes("reason=stepped-back-within-interval")));
    while (Date.now() < steppedBack + 59 * 60_000) await f.tick();
    assert.equal(f.agents.get("pm")!.model, SOL);
    while (Date.now() < steppedBack + 61 * 60_000) await f.tick();
    assert.equal(f.agents.get("pm")!.model, OPUS, "the waiting step back once the window opens");
    assert.equal(logs.filter((l) => l.includes("pm-stage-start agentId=pm") && l.includes("from=last to=first")).length, 2);
  });
  await scenario(async (f) => {
    await bounce(f);
    assert.equal(f.agents.get("pm")!.model, SOL);
    f.add("fable-worker", "worker", { model: FABLE });
    await f.endTurn("fable-worker", { kind: "completed" }, "fable-ok", "Normal reply on Fable.");
    await f.tick();
    assert.equal(f.agents.get("pm")!.model, FABLE, "a Fable success returns it at once");
  });
});

it("T11: a sweep that read the PM before its change to Fable drops only the count it read; the new Fable count stands and moves the PM", () => scenario(async (f, logs) => {
  f.setConfig({ pmFallback: false, transientBackoffSeconds: [90, 120], pmFallbackThinking: "high", pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("pm", "pm");
  await f.endTurn("pm", cpaOn(OPUS), "opus-1");
  assert.equal((await f.returns.read()).cpaStreaks?.pm?.count, 1);
  // A sweep reads the PM on Opus and pauses; meanwhile the PM changes to Fable and its first Fable turn fails, counted
  // by both turn hooks.
  let reached!: () => void, release!: () => void, accounted!: () => void;
  const reachedP = new Promise<void>((resolve) => { reached = resolve; });
  const releaseP = new Promise<void>((resolve) => { release = resolve; });
  const accountedP = new Promise<void>((resolve) => { accounted = resolve; });
  let paused = false;
  f.hooks({ afterFetch: async (agent) => { if (agent?.model === OPUS && !paused) { paused = true; reached(); await releaseP; } } });
  const sweep = f.tick();
  let fableCalls = 0;
  const addCpa = ReturnStore.prototype.addCpa;
  ReturnStore.prototype.addCpa = async function (...args: Parameters<typeof addCpa>) {
    const count = await addCpa.apply(this, args);
    if (args[1].model === FABLE && args[3] === "fable-1" && ++fableCalls === 2) accounted();
    return count;
  };
  let ended: Promise<void> | undefined;
  try {
    await Promise.race([reachedP, within(2000, "the sweep did not read Opus")]);
    Object.assign(f.agents.get("pm")!, { model: FABLE, lastUserMessageAt: new Date().toISOString() });
    f.setConfig({ pmFallback: true });
    ended = f.endTurn("pm", cpaOn(FABLE), "fable-1");
    await Promise.race([accountedP, within(2000, "the Fable turn was not counted twice")]);
  } finally { release(); await sweep; await ended; ReturnStore.prototype.addCpa = addCpa; f.hooks({}); }
  const after = (await f.returns.read()).cpaStreaks?.pm;
  assert.equal(after?.model, FABLE);
  assert.equal(after?.count, 1, "the old sweep left the Fable count");
  assert.ok(!logs.some((l) => l.includes("pm-cpa-count-dropped agentId=pm")));
  mock.timers.setTime(Date.now() + 1000);
  Object.assign(f.agents.get("pm")!, { lastUserMessageAt: new Date().toISOString() });
  await f.endTurn("pm", cpaOn(FABLE), "fable-2");
  assert.deepEqual(f.calls.apply.map((c) => c.modelId), [OPUS], "the second Fable failure moves it to the chain's first stage");
}));

// An Opus PM refused twice by CPA's 503 (user-1, then a newer user-2) is moved to Sol, but every send on Sol fails
// before delivery until `deliver` is called: the move's owed resend is still pending.
async function cpaMovePending(f: ReturnType<typeof fixture>) {
  f.setConfig({ pmFallbackThinking: "high", transientBackoffSeconds: [60, 120] });
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("pm", "pm");
  f.hooks({ beforeSend: (agent) => { if (agent.model === SOL) throw new Error("Transport not connected"); } });
  await f.endTurn("pm", cpaOn(OPUS), "user-1");
  mock.timers.setTime(Date.now() + 1000);
  Object.assign(f.agents.get("pm")!, { lastUserMessageAt: new Date().toISOString() });
  await f.endTurn("pm", cpaOn(OPUS), "user-2");
  assert.deepEqual(f.calls.sends, []);
  assert.deepEqual(f.calls.apply.map((c) => c.modelId), [SOL]);
  assert.equal((await f.returns.get("pm"))?.cpaResend, true);
  return { deliver: () => f.hooks({}) };
}

it("T12: a restart after the owed Sol resend went out, before its flag was cleared, gives no second pq-free send", () => scenario(async (f, logs) => {
  const { deliver } = await cpaMovePending(f);
  deliver();
  // The send and its receipt land; the write that clears the flag is lost.
  const update = ReturnStore.prototype.update;
  let lost = 0;
  ReturnStore.prototype.update = function (id, apply) {
    return update.call(this, id, (o) => { const next = apply(o); if (o.cpaResend && !next.cpaResend) { lost++; throw new Error("fixture: write lost"); } return next; });
  };
  try { await f.tick(); } finally { ReturnStore.prototype.update = update; }
  assert.deepEqual(f.calls.sends, [`pm:${SOL}:continue`]);
  assert.equal(lost, 1);
  assert.equal((await f.returns.get("pm"))?.cpaResend, true, "the flag survived on disk");
  await f.stop();
  await f.start();
  const bypasses = logs.filter((l) => l.includes("reason=cpa-503-moved")).length;
  await f.endTurn("pm", { kind: "failed", error: { message: "503 upstream unavailable (stopReason=error, model=fleet/gpt-6.2-sol)" } }, "resume-1");
  for (let n = 0; n < 8; n++) await f.tick();
  assert.deepEqual(f.calls.sends, [`pm:${SOL}:continue`], "the failed Sol turn's resend is held on pq");
  assert.equal(logs.filter((l) => l.includes("reason=cpa-503-moved")).length, bypasses, "no second pq-free send");
  assert.ok(logs.some((l) => l.includes("pm-cpa-resend-done agentId=pm") && l.includes("reason=sent")));
  assert.equal((await f.returns.get("pm"))?.cpaResend, false);
}));

it("T13: a late completed event for an older turn keeps the owed resend of the newer unanswered input", () => scenario(async (f, logs) => {
  const { deliver } = await cpaMovePending(f);
  await f.emit({ agent: { id: "pm" }, turnId: "prior-completed", outcome: { kind: "completed" }, timeline: [{ type: "user_message", text: "old question", messageId: "old-user" }, { type: "assistant_message", text: "old reply" }] });
  await f.tick();
  assert.equal((await f.returns.get("pm"))?.cpaResend, true, "still owed");
  assert.ok(!logs.some((l) => l.includes("pm-cpa-resend-done agentId=pm") && l.includes("reason=answered")));
  deliver();
  for (let n = 0; n < 4; n++) await f.tick();
  assert.deepEqual(f.calls.sends, [`pm:${SOL}:continue`], "user-2's resend goes out on Sol");
  const records = (await f.records.read()).map((r) => [r.sourceTurnId, r.state, !!r.quotaHold]);
  assert.deepEqual(records, [["user-1", "superseded", false], ["user-2", "verifying", false]]);
}));

it("T14: the hour between a CPA chain's step backs counts from the step that landed, not from a rejected attempt", () => scenario(async (f, logs) => {
  f.setConfig({ pmFallbackThinking: "high", pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("pm", "pm", { model: FABLE });
  f.add("other", "worker");
  const fail = (model: string, id?: string) => f.endTurn("pm", cpaOn(model), id ?? `resume-${f.calls.sends.length}`);
  await fail(FABLE, "fable-1"); await fail(FABLE); await fail(OPUS); await fail(OPUS);
  assert.equal(f.agents.get("pm")!.model, SOL);
  await f.tick();
  await f.endTurn("other", { kind: "completed" }, "other-1", "Normal reply on Opus.");
  // The step back's settings write is rejected until 58.5 minutes after it was first tried.
  f.failApplies(100);
  await f.tick();
  const intended = Date.now();
  assert.equal(f.agents.get("pm")!.model, SOL);
  mock.timers.setTime(intended + 58 * 60_000 + 30_000);
  f.failApplies(0);
  await f.tick();
  const landed = Date.now();
  assert.equal(f.agents.get("pm")!.model, OPUS, "the first step back lands");
  Object.assign(f.agents.get("pm")!, { lastUserMessageAt: new Date().toISOString() });
  await fail(OPUS, "fresh-opus-1"); await fail(OPUS);
  assert.equal(f.agents.get("pm")!.model, SOL);
  await f.tick();
  await f.endTurn("other", { kind: "completed" }, "other-2", "Another normal reply on Opus.");
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL, "no second step back a minute after the first landed");
  assert.ok(logs.some((l) => l.includes("pm-stage-waiting agentId=pm") && l.includes("reason=stepped-back-within-interval")));
  while (Date.now() < landed + 59 * 60_000) await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  while (Date.now() < landed + 61 * 60_000) await f.tick();
  assert.equal(f.agents.get("pm")!.model, OPUS, "the second step back once the hour from the landing is over");
}));

it("T15: an older turn's event that turns the owed Sol resend's record uncertain while its send is in flight spends nothing; after the send fails the newer input gets one Sol send", () => scenario(async (f, logs) => {
  await cpaMovePending(f);
  let reached!: () => void, release!: () => void, uncertain!: () => void;
  const reachedP = new Promise<void>((resolve) => { reached = resolve; });
  const releaseP = new Promise<void>((resolve) => { release = resolve; });
  const uncertainP = new Promise<void>((resolve) => { uncertain = resolve; });
  f.hooks({ beforeSend: async (agent) => { if (agent.model === SOL) { reached(); await releaseP; throw new Error("Transport not connected"); } } });
  const update = ResumeStore.prototype.update;
  ResumeStore.prototype.update = async function (id, apply) {
    const next = await update.call(this, id, apply);
    if (next?.state === "uncertain") uncertain();
    return next;
  };
  const sweep = f.tick();
  try {
    await Promise.race([reachedP, within(3000, "the Sol send was not reached")]);
    // An older turn's completed event arrives while the send is in flight: it turns the claimed record uncertain.
    void f.emit({ agent: { id: "pm" }, turnId: "prior-completed", outcome: { kind: "completed" }, timeline: [{ type: "user_message", text: "old question", messageId: "old-user" }, { type: "assistant_message", text: "old reply" }] });
    await Promise.race([uncertainP, within(3000, "the late event did not turn the record uncertain")]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await f.returns.get("pm"))?.cpaResend, true, "still owed while the send is in flight");
  } finally {
    ResumeStore.prototype.update = update;
    release();
    await sweep;
  }
  f.hooks({});
  assert.equal((await f.returns.get("pm"))?.cpaResend, true, "still owed after the send reported non-delivery");
  mock.timers.setTime(Date.now() + 1000);
  Object.assign(f.agents.get("pm")!, { lastUserMessageAt: new Date().toISOString() });
  await f.endTurn("pm", { kind: "failed", error: { message: "503 upstream unavailable (stopReason=error, model=fleet/gpt-6.2-sol)" } }, "user-3");
  for (let n = 0; n < 5; n++) await f.tick();
  assert.deepEqual(f.calls.sends, [`pm:${SOL}:continue`], "exactly one Sol send");
  assert.equal(logs.filter((l) => l.includes("pm-cpa-resend-done agentId=pm")).length, 1);
  assert.equal((await f.returns.get("pm"))?.cpaResend, false);
}));

it("T16: a Fable success while the CPA chain's step back to Opus is still pending returns the PM to Fable", () => scenario(async (f, logs) => {
  f.setConfig({ pmFallbackThinking: "high", pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("pm", "pm", { model: FABLE });
  f.add("other", "worker");
  const fail = (model: string, id?: string) => f.endTurn("pm", cpaOn(model), id ?? `resume-${f.calls.sends.length}`);
  await fail(FABLE, "fable-1"); await fail(FABLE); await fail(OPUS); await fail(OPUS);
  assert.equal(f.agents.get("pm")!.model, SOL);
  await f.tick();
  await f.endTurn("other", { kind: "completed" }, "other-1", "Normal reply on Opus.");
  // The step back to Opus starts; its settings write is rejected, so it stays pending.
  f.failApplies(100);
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  assert.equal((await f.returns.get("pm"))?.phase, "switching");
  f.add("fable-peer", "worker", { model: FABLE });
  await f.endTurn("fable-peer", { kind: "completed" }, "fable-ok", "A normal reply on Fable.");
  await f.tick();
  f.failApplies(0);
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, FABLE, "back on Fable, not Opus");
  assert.ok(logs.some((l) => l.includes("pm-restore-verified agentId=pm")));
  assert.equal(await f.returns.get("pm"), null);
}));

it("T17: a Fable success recorded while the CPA chain's step-back write to Opus is in flight returns the PM to Fable once the step lands", () => scenario(async (f, logs) => {
  f.setConfig({ pmFallbackThinking: "high", pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
  f.pq.claude = { five: "ok", week: "ok" };
  f.pq.codex = { five: "out", week: "out" };
  f.add("pm", "pm", { model: FABLE });
  f.add("other", "worker");
  const fail = (model: string, id?: string) => f.endTurn("pm", cpaOn(model), id ?? `resume-${f.calls.sends.length}`);
  await fail(FABLE, "fable-1"); await fail(FABLE); await fail(OPUS); await fail(OPUS);
  assert.equal(f.agents.get("pm")!.model, SOL);
  await f.tick();
  await f.endTurn("other", { kind: "completed" }, "other-1", "Normal reply on Opus.");
  // The step back to Opus starts on the next sweep; its settings write is held in flight.
  let entered!: () => void, release!: () => void, witnessRead!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const read = new Promise<void>((resolve) => { witnessRead = resolve; });
  f.add("fable-peer", "worker", { model: FABLE });
  f.hooks({
    onApply: async (agentId, model) => { if (agentId === "pm" && model === OPUS) { entered(); await released; } },
    afterFetch: async (agent) => { if (agent?.id === "fable-peer") witnessRead(); },
  });
  const sweep = f.tick();
  let peer: Promise<void> | undefined;
  try {
    await Promise.race([inFlight, within(3_000, "step-back write in flight")]);
    assert.equal((await f.returns.get("pm"))?.stepBackPending, true);
    assert.equal(f.agents.get("pm")!.model, SOL);
    // A Fable worker's normal reply ends while the write is in flight; its hook reads the worker and records the success.
    peer = f.endTurn("fable-peer", { kind: "completed" }, "fable-ok-in-flight", "A normal reply on Fable.");
    await Promise.race([read, within(3_000, "Fable success read")]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    mock.timers.setTime(Date.now() + 1_000);
  } finally {
    release();
    await sweep; await peer;
    f.hooks({});
  }
  await f.tick(); await f.tick();
  assert.equal(f.agents.get("pm")!.model, FABLE, "back on Fable, not left on Opus");
  assert.equal(logs.filter((l) => l.includes("pm-restore-verified agentId=pm")).length, 1);
  assert.equal(await f.returns.get("pm"), null);
}));

// Pace mode (owner decision, 2026-11-21). Fixture account labels only. 84 hours to the weekly reset puts the even spend
// at 50%: a use of 80% is off pace, 30% on pace.
const PACE_ACCOUNTS = ["acct-a", "acct-b"];
const paceAt = (usedPct: number, five: number | null = 60) => PACE_ACCOUNTS.map((label) => ({ label, usedPct, resetHours: 84, five }));
const SOL_MEDIUM: Profile = { model: SOL, thinkingOptionId: "medium", serviceTier: "standard" };
const OPUS_HIGH: Profile = { model: OPUS, thinkingOptionId: "high", serviceTier: null };
// A configured host: both lists set. The excluded prefix is made up.
const PACE_ON = { paceFallback: true, pacePoolAccounts: PACE_ACCOUNTS, paceFallbackExcludedAgents: ["excl0001"] };
const later = (minutes: number) => mock.timers.setTime(Date.now() + minutes * 60_000);

it("P1: off pace, an eligible PM moves in place to Sol medium and returns to its exact original on a fresh on-pace reading", () => scenario(async (f, logs) => {
  f.setConfig(PACE_ON);
  f.pq.pace = paceAt(80);
  f.add("pm-a", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("pm-a")!), SOL_MEDIUM);
  const obligation = await f.returns.get("pm-a");
  assert.equal(obligation?.pace, true);
  assert.deepEqual(obligation?.original, OPUS_HIGH);
  assert.ok(logs.some((l) => /pm-swap-start agentId=pm-a \S+ trigger=pace/.test(l)));
  assert.ok(logs.some((l) => /pm-swap-verified agentId=pm-a \S+ trigger=pace/.test(l)));
  f.pq.pace = paceAt(30);
  later(31);
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("pm-a")!), OPUS_HIGH);
  assert.equal(await f.returns.get("pm-a"), null);
  assert.ok(logs.some((l) => /pm-restore-verified agentId=pm-a \S+ trigger=pace/.test(l)));
  // Booleans, reasons and times only: no account label or figure.
  for (const line of logs.filter((l) => /pace/.test(l))) assert.doesNotMatch(line, /acct-|usedPct|gap|%/);
}));

it("P2: pace mode leaves a main PM, an excluded id prefix, a noresume PM, a worker and an API-billed Claude PM where they are", () => scenario(async (f, logs) => {
  // A host list adds to the main PM projects and never drops them.
  f.setConfig({ ...PACE_ON, paceFallbackExcludedProjects: ["fixture-other"] });
  f.pq.pace = paceAt(80);
  f.add("main", "pm", { labels: { role: "pm", project: "config" } });
  f.add("excl0001-fixture", "pm", { labels: { role: "pm", project: "fixture-held" } });
  f.add("quiet", "pm", { labels: { role: "pm", project: "fixture", noresume: "true" } });
  f.add("worker", "worker", { labels: { role: "worker", project: "fixture" } });
  f.add("api", "pm", { model: "fleet/api/claude-opus-5-5", labels: { role: "pm", project: "fixture" } });
  await f.tick(); await f.tick();
  assert.equal(f.calls.apply.length, 0);
  assert.deepEqual((await f.returns.read()).obligations, []);
  for (const [id, reason] of [["main", "excluded-project"], ["excl0001-fixture", "excluded-agent"], ["quiet", "excluded-label"]]) {
    assert.ok(logs.some((l) => l.includes(`pm-pace-held agentId=${id} reason=${reason}`)), `${id} ${reason}`);
  }
}));

it("P3: an undecided pq reading makes neither a pace swap nor a pace return", () => scenario(async (f, logs) => {
  f.setConfig(PACE_ON);
  f.add("pm-a", "pm", { labels: { role: "pm", project: "fixture" } });
  f.pq.pace = paceAt(80);
  f.pq.stale = true;
  await f.tick();
  assert.equal(f.calls.apply.length, 0);
  assert.ok(logs.some((l) => l === "[usage-limit-auto-resume] pm-pace-held reason=undecided"));
  f.pq.stale = false;
  await f.tick();
  assert.equal(f.agents.get("pm-a")!.model, SOL);
  // Past the flap guard: a stale snapshot, then no fresh weekly reading at all, keep the PM where it is.
  later(31);
  f.pq.pace = paceAt(30);
  f.pq.stale = true;
  await f.tick();
  f.pq.stale = false;
  f.pq.pace = [];
  await f.tick();
  assert.equal(f.agents.get("pm-a")!.model, SOL);
  assert.equal((await f.returns.get("pm-a"))?.pace, true);
  assert.ok(logs.some((l) => /pm-pace-held agentId=pm-a \S+ reason=undecided/.test(l)));
}));

it("P4: the flap guard holds a pace return for 30 minutes after the swap landed, and the next pace swap for 30 minutes after the return, across a restart", () => scenario(async (f, logs) => {
  f.setConfig(PACE_ON);
  f.pq.pace = paceAt(80);
  f.add("pm-a", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.tick();
  assert.equal(f.agents.get("pm-a")!.model, SOL);
  f.pq.pace = paceAt(30);
  later(10);
  await f.tick();
  assert.equal(f.agents.get("pm-a")!.model, SOL, "return held by the flap guard");
  assert.ok(logs.some((l) => /pm-pace-held agentId=pm-a obligationId=\S+ reason=flap-guard/.test(l)));
  later(21);
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("pm-a")!), OPUS_HIGH);
  f.pq.pace = paceAt(80);
  await f.stop();
  await f.start();
  await f.tick();
  assert.equal(f.agents.get("pm-a")!.model, OPUS, "next swap held by the flap guard after a restart");
  assert.ok(logs.some((l) => /pm-pace-held agentId=pm-a reason=flap-guard/.test(l)));
  later(31);
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("pm-a")!), SOL_MEDIUM);
}));

it("P5: a PM on a Claude-out return is not returned on an on-pace reading alone, nor on Claude proof while off pace", () => scenario(async (f, logs) => {
  // Every listed account out on its five-hour window: Claude is out, and the PM takes the usual Claude-out swap.
  f.pq.pace = paceAt(80, 0);
  await swapPm(f);
  const obligation = await f.returns.get("pm");
  assert.ok(obligation && !obligation.pace);
  assert.deepEqual(profileOf(f.agents.get("pm")!), { model: SOL, thinkingOptionId: "medium", serviceTier: "standard" });
  f.setConfig(PACE_ON);
  // On pace, but no account proves Claude capacity (no five-hour reading): the return keeps waiting.
  f.pq.pace = paceAt(30, null);
  await f.tick(); await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  // Claude capacity proven, but off pace: still held.
  f.pq.pace = paceAt(80);
  await f.tick();
  assert.equal(f.agents.get("pm")!.model, SOL);
  assert.ok(logs.some((l) => /pm-return-waiting agentId=pm obligationId=\S+ reason=off-pace/.test(l)));
  // Both hold: the usual verified restore.
  f.pq.pace = paceAt(30);
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("pm")!), OPUS_HIGH);
  assert.equal(await f.returns.get("pm"), null);
}));

it("P6: an unconfigured host, with no excluded agent prefix or no pool accounts, moves nothing", () => scenario(async (f, logs) => {
  f.pq.pace = paceAt(80);
  f.add("pm-a", "pm", { labels: { role: "pm", project: "fixture" } });
  for (const patch of [{ paceFallbackExcludedAgents: [] }, { pacePoolAccounts: [] }]) {
    f.setConfig({ ...PACE_ON, ...patch });
    const before = logs.filter((l) => l.endsWith("pm-pace-held reason=unconfigured")).length;
    await f.tick(); await f.tick();
    assert.equal(f.calls.apply.length, 0);
    assert.deepEqual((await f.returns.read()).obligations, []);
    assert.equal(logs.filter((l) => l.endsWith("pm-pace-held reason=unconfigured")).length, before + 2, "once per sweep");
  }
}));

// Owner decision 333a, phase 1: a main PM (role=pm, project config, work or personal) is never moved by the plugin.
// Fixture ids and projects only.
const MAIN_PMS = [["main-config", "config"], ["main-work", "work"], ["main-personal", "personal"]] as const;
const capAlerts = (logs: string[], id: string) => logs.filter((l) => l.includes(`pm-main-cap-alert agentId=${id} `));

it("M1: at a Claude cap each main PM stays on Opus with one alert and resumes there; similar labels and a child PM fall back as before", () => scenario(async (f, logs) => {
  for (const [id, project] of MAIN_PMS) f.add(id, "pm", { labels: { role: "pm", project } });
  // Near misses: a child PM, a worker in a main project, other roles and projects that only look alike.
  const similar: Array<[string, Record<string, string>]> = [
    ["child", { role: "pm", project: "fixture" }],
    ["worker-in-config", { role: "worker", project: "config" }],
    ["pm-worker", { role: "pm-worker", project: "work" }],
    ["config-worker", { role: "pm", project: "config-worker" }],
    ["cased", { role: "pm", project: "Work" }],
    ["unlabelled", { role: "pm" }],
  ];
  for (const [id, labels] of similar) f.add(id, labels.role!, { labels });
  for (const id of [...MAIN_PMS.map(([id]) => id), ...similar.map(([id]) => id)]) await f.endTurn(id, { kind: "failed", error: { message: USAGE } }, `${id}-turn-1`);
  await f.tick(); await f.tick();
  for (const [id] of MAIN_PMS) {
    assert.equal(f.agents.get(id)!.model, OPUS, `${id} stays on Opus`);
    assert.equal(await f.returns.get(id), null, `${id} gets no return obligation`);
    assert.ok(!f.calls.apply.some((c) => c.agentId === id), `${id} is never written`);
    assert.equal(capAlerts(logs, id).length, 1, `${id}: one alert across sweeps`);
    const record = (await f.records.read()).find((r) => r.agentId === id)!;
    assert.equal(record.model, OPUS);
    assert.ok(record.quotaHold, `${id}: the ordinary hold`);
  }
  for (const [id] of similar) {
    assert.equal(f.agents.get(id)!.model, SOL, `${id} falls back as before`);
    assert.equal(capAlerts(logs, id).length, 0);
  }
  // Reasons only in the alert: no quota figures or account labels.
  for (const line of logs.filter((l) => l.includes("pm-main-cap-alert"))) assert.doesNotMatch(line, /quota=|leftPct|capacity|acct-|%/);
  // Claude frees up after the weekly reset the hold waits for: the held record resumes each main PM on Opus.
  f.pq.claude = { five: "ok", week: "ok" };
  later(25 * 60);
  await f.tick(); await f.tick();
  for (const [id] of MAIN_PMS) assert.ok(f.calls.sends.some((s) => s.startsWith(`${id}:${OPUS}:`)), `${id} resumed on Opus`);
  assert.ok(!f.calls.sends.some((s) => s.startsWith("main-") && s.includes(SOL)));
}));

it("M2: CPA's 503 twice moves a child PM but not a main PM; the main PM's second refusal alerts once", () => scenario(async (f, logs) => {
  f.pq.claude = { five: "ok", week: "ok" };
  f.add("main-config", "pm", { labels: { role: "pm", project: "config" } });
  f.add("child", "pm", { labels: { role: "pm", project: "fixture" } });
  await cpaTwice(f, "main-config", "main-turn-1");
  await cpaTwice(f, "child", "child-turn-1");
  await f.tick(); await f.tick();
  assert.deepEqual(f.calls.apply.map((c) => c.agentId), ["child"]);
  assert.equal(f.agents.get("main-config")!.model, OPUS);
  assert.equal(await f.returns.get("main-config"), null);
  assert.equal(capAlerts(logs, "main-config").length, 1);
  assert.ok(capAlerts(logs, "main-config")[0]!.includes("trigger=cpa-503-twice"));
  // A completed turn ends the episode: the next cap alerts again.
  await f.endTurn("main-config", { kind: "completed" }, "main-ok", "Normal reply.");
  Object.assign(f.agents.get("main-config")!, { lastUserMessageAt: new Date().toISOString() });
  await cpaTwice(f, "main-config", "main-turn-2");
  assert.equal(capAlerts(logs, "main-config").length, 2);
  assert.equal(f.agents.get("main-config")!.model, OPUS);
}));

it("M3: a main PM's stored obligations from before the upgrade: an unapplied intent is dropped, an exact landing settles with its record, a partial one goes back to the exact original at once and keeps its resume, a settled one returns on proof", () => scenario(async (f, logs) => {
  const original: Profile = { model: OPUS, thinkingOptionId: "high", serviceTier: null };
  const fallback: Profile = { model: SOL, thinkingOptionId: "medium", serviceTier: "standard" };
  // Each main PM's turn was refused while every Claude account is out: its resume record waits on Opus.
  const ids = [["intent", "work"], ["partial", "personal"], ["exact", "config"], ["landed", "config"]] as const;
  for (const [id, project] of ids) {
    f.add(id, "pm", { labels: { role: "pm", project } });
    await f.endTurn(id, { kind: "failed", error: { message: USAGE } }, `${id}-turn-1`);
  }
  await f.stop();
  await f.returns.add(newObligation("intent", original, fallback, "auto", "switching"));
  // Landed on Sol before a crash, but thinking and the Fast label were not written.
  Object.assign(f.agents.get("partial")!, { model: SOL });
  await f.returns.add(newObligation("partial", original, fallback, "auto", "switching"));
  // Landed exactly, but the crash came before the swap was settled.
  Object.assign(f.agents.get("exact")!, { model: SOL, thinkingOptionId: "medium", labels: { ...f.agents.get("exact")!.labels, "opc.service-tier": "standard" } });
  await f.returns.add(newObligation("exact", original, fallback, "auto", "switching"));
  // Settled on Sol before the upgrade.
  Object.assign(f.agents.get("landed")!, { model: SOL, thinkingOptionId: "medium", labels: { ...f.agents.get("landed")!.labels, "opc.service-tier": "standard" } });
  await f.returns.add(newObligation("landed", original, fallback, "auto", "fallback"));
  await f.start();
  await f.tick();
  assert.equal(await f.returns.get("intent"), null);
  assert.ok(logs.some((l) => l.includes("pm-swap-dropped agentId=intent") && l.includes("main-pm")));
  assert.ok(logs.some((l) => /pm-swap-not-completed agentId=partial \S+ reason=main-pm return=kept/.test(l)));
  // Nothing is written toward Sol; the only write is the partial PM's exact original.
  assert.deepEqual(f.calls.apply, [{ agentId: "partial", modelId: OPUS, thinkingOptionId: "high" }]);
  assert.deepEqual(profileOf(f.agents.get("partial")!), original);
  assert.equal(await f.returns.get("partial"), null);
  assert.ok(logs.some((l) => /pm-restore-due agentId=partial \S+ reason=main-pm-partial/.test(l)));
  // Its resume record is kept, back on Opus and held on the out pool: no send while Claude is out.
  const partialRecord = (await f.records.read()).find((r) => r.agentId === "partial")!;
  assert.equal(partialRecord.model, OPUS);
  assert.ok(partialRecord.quotaHold && partialRecord.state === "parked");
  assert.ok(!f.calls.sends.some((s) => s.startsWith("partial:")));
  // The exact landing settles with no write; its record follows it to Sol and resumes there.
  assert.equal((await f.returns.get("exact"))?.phase, "fallback");
  assert.ok(logs.some((l) => l.includes("pm-swap-verified agentId=exact")));
  assert.equal((await f.records.read()).find((r) => r.agentId === "exact" && r.state !== "superseded")?.model ?? SOL, SOL);
  assert.ok(f.calls.sends.some((s) => s.startsWith(`exact:${SOL}:`)), "resumed on Sol, not lost");
  // The settled return is not forced back and its sends are not blocked; it returns on Claude proof.
  assert.ok(await f.returns.get("landed"));
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  for (const id of ["exact", "landed"]) {
    assert.deepEqual(profileOf(f.agents.get(id)!), original, `${id} back on its original`);
    assert.equal(await f.returns.get(id), null);
  }
  assert.equal(f.agents.get("intent")!.model, OPUS);
}));

it("M4: a main PM on a chain's first stage refused there is not stepped on to Sol; its return to the original stands; a child PM steps on", () => scenario(async (f, logs) => {
  f.setConfig({ pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
  const original: Profile = { model: FABLE, thinkingOptionId: "high", serviceTier: null };
  const first: Profile = { model: OPUS, thinkingOptionId: "high", serviceTier: null };
  const last: Profile = { model: SOL, thinkingOptionId: "medium", serviceTier: "standard" };
  for (const [id, project] of [["main", "personal"], ["child", "fixture"]] as const) {
    f.add(id, "pm", { labels: { role: "pm", project } });
    await f.returns.add(newObligation(id, original, first, "auto", "fallback", Date.now(), { stages: { first, last }, stage: "first" }));
    await f.endTurn(id, { kind: "failed", error: { message: USAGE } }, `${id}-turn-1`);
  }
  await f.tick();
  assert.equal(f.agents.get("main")!.model, OPUS, "the main PM stays on the first stage");
  assert.equal((await f.returns.get("main"))?.stage, "first");
  assert.equal(capAlerts(logs, "main").length, 1);
  assert.ok(capAlerts(logs, "main")[0]!.includes("would=step"));
  assert.equal(f.agents.get("child")!.model, SOL, "a child PM steps on as before");
  f.add("fable-worker", "worker", { model: FABLE });
  await f.endTurn("fable-worker", { kind: "completed" }, "fable-ok", "Normal reply on Fable.");
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("main")!), original, "the main PM returns to Fable");
  assert.equal(await f.returns.get("main"), null);
}));

it("M5: pace mode leaves all three main PMs alone and still moves PMs whose labels only look alike", () => scenario(async (f, logs) => {
  f.setConfig(PACE_ON);
  f.pq.pace = paceAt(80);
  for (const [id, project] of MAIN_PMS) f.add(id, "pm", { labels: { role: "pm", project } });
  f.add("config-worker", "pm", { labels: { role: "pm", project: "config-worker" } });
  f.add("cased", "pm", { labels: { role: "pm", project: "Personal" } });
  await f.tick();
  for (const [id] of MAIN_PMS) {
    assert.equal(f.agents.get(id)!.model, OPUS);
    assert.ok(logs.some((l) => l.includes(`pm-pace-held agentId=${id} reason=excluded-project`)));
  }
  for (const id of ["config-worker", "cased"]) assert.deepEqual(profileOf(f.agents.get(id)!), SOL_MEDIUM, `${id} moves`);
}));

it("M6: a child PM relabelled to a main project after its swap keeps its return and goes back to Opus; a main PM relabelled to a child project falls back as a child PM", () => scenario(async (f, logs) => {
  await swapPm(f, "moved-in");
  assert.equal(f.agents.get("moved-in")!.model, SOL);
  f.agents.get("moved-in")!.labels = { ...f.agents.get("moved-in")!.labels, project: "work" };
  f.add("moved-out", "pm", { labels: { role: "pm", project: "personal" } });
  await f.endTurn("moved-out", { kind: "failed", error: { message: USAGE } }, "moved-out-turn-1");
  assert.equal(f.agents.get("moved-out")!.model, OPUS);
  assert.equal(capAlerts(logs, "moved-out").length, 1);
  f.agents.get("moved-out")!.labels = { role: "pm", project: "fixture" };
  await f.tick();
  assert.equal(f.agents.get("moved-out")!.model, SOL, "now a child PM: the usual fallback");
  assert.ok(await f.returns.get("moved-in"), "the relabelled PM keeps its return");
  f.pq.claude = { five: "ok", week: "ok" };
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("moved-in")!), OPUS_HIGH);
  assert.equal(await f.returns.get("moved-in"), null);
}));

const FABLE_HIGH: Profile = { model: FABLE, thinkingOptionId: "high", serviceTier: null };
const CHAIN = { stages: { first: OPUS_HIGH, last: SOL_MEDIUM } };

it("M7: a main PM's chain never writes its first stage: no new or stored step back, partial onward or back moves return to the exact original, and a cancelled CPA move owes no pq-free resend", async () => {
  // A new step back on Opus proof, then a stored step-back intent: the main PM stays on Sol; a Fable success returns it.
  await scenario(async (f, logs) => {
    f.setConfig({ pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
    f.add("main", "pm", { model: SOL, thinkingOptionId: "medium", labels: { role: "pm", project: "work", "opc.service-tier": "standard" } });
    const ob = await f.returns.add({ ...newObligation("main", FABLE_HIGH, SOL_MEDIUM, "auto", "fallback", Date.now(), { ...CHAIN, stage: "last" }) });
    f.add("opus-worker", "worker");
    later(1);
    await f.endTurn("opus-worker", { kind: "completed" }, "opus-ok", "Normal reply on Opus.");
    await f.tick(); await f.tick();
    assert.equal(f.calls.apply.length, 0, "no step back to Opus");
    assert.ok(!logs.some((l) => l.includes("pm-stage-start agentId=main")), "no step back is even started");
    await f.returns.update(ob!.obligationId, (o) => ({ ...o, phase: "switching", stage: "first", fallback: OPUS_HIGH, stepBackPending: true }));
    await f.tick();
    assert.equal(f.calls.apply.length, 0, "the stored step back is not written");
    const kept = await f.returns.get("main");
    assert.equal(kept?.phase, "fallback");
    assert.equal(kept?.stage, "last");
    assert.ok(logs.some((l) => l.includes("pm-stage-dropped agentId=main") && l.includes("main-pm")));
    f.add("fable-worker", "worker", { model: FABLE });
    await f.endTurn("fable-worker", { kind: "completed" }, "fable-ok", "Normal reply on Fable.");
    await f.tick();
    assert.deepEqual(f.calls.apply.map((c) => c.modelId), [FABLE]);
    assert.deepEqual(profileOf(f.agents.get("main")!), FABLE_HIGH);
  });
  // Partial onward (Sol model, other thinking) and partial back (Opus model, other thinking): the exact original at once.
  await scenario(async (f, logs) => {
    f.setConfig({ pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
    f.add("onward", "pm", { model: SOL, thinkingOptionId: "high", labels: { role: "pm", project: "work" } });
    await f.returns.add({ ...newObligation("onward", FABLE_HIGH, SOL_MEDIUM, "auto", "switching", Date.now(), { ...CHAIN, stage: "last" }) });
    f.add("back", "pm", { model: OPUS, thinkingOptionId: "medium", labels: { role: "pm", project: "personal", "opc.service-tier": "standard" } });
    await f.returns.add({ ...newObligation("back", FABLE_HIGH, OPUS_HIGH, "auto", "switching", Date.now(), { ...CHAIN, stage: "first" }), stepBackPending: true });
    await f.tick();
    assert.deepEqual(f.calls.apply.map((c) => [c.agentId, c.modelId]).sort(), [["back", FABLE], ["onward", FABLE]]);
    for (const id of ["onward", "back"]) {
      assert.deepEqual(profileOf(f.agents.get(id)!), FABLE_HIGH, id);
      assert.equal(await f.returns.get(id), null);
    }
    assert.ok(!logs.some((l) => /pm-swap-apply/.test(l)));
  });
  // A CPA onward move stored before the upgrade, cancelled for a main PM: no pq-free resend on the stage it stays on.
  await scenario(async (f, logs) => {
    f.setConfig({ pmFallbackFirst: [{ from: FABLE, model: OPUS, thinking: "high" }] });
    f.pq.codex = { five: "out", week: "out" };
    f.add("main", "pm", { labels: { role: "pm", project: "config" } });
    await f.endTurn("main", { kind: "failed", error: { message: USAGE } }, "main-turn-1");
    assert.ok((await f.records.read()).find((r) => r.agentId === "main")?.quotaHold);
    await f.returns.add({ ...newObligation("main", FABLE_HIGH, SOL_MEDIUM, "auto", "switching", Date.now(), { ...CHAIN, stage: "last" }, true), cpaResendMessageId: null });
    await f.tick(); await f.tick();
    const kept = await f.returns.get("main");
    assert.equal(kept?.stage, "first");
    assert.equal(kept?.phase, "fallback");
    assert.equal(kept?.cpaResend, false);
    assert.equal(kept?.cpaResendMessageId, null);
    assert.deepEqual(f.calls.apply, []);
    assert.deepEqual(f.calls.sends, [], "the held resume is not sent past the pq hold");
    assert.ok(!logs.some((l) => l.includes("cpa-503-moved")));
    assert.ok(logs.some((l) => l.includes("pm-stage-dropped agentId=main") && l.includes("main-pm")));
  });
});

it("M8: a PM relabelled to a main project while its swap decision awaits pq is not written; the intent is then dropped", () => scenario(async (f, logs) => {
  f.add("pm", "pm", { labels: { role: "pm", project: "fixture" } });
  f.hooks({ onPq: async () => {
    if (await f.returns.get("pm")) f.agents.get("pm")!.labels = { ...f.agents.get("pm")!.labels, project: "work" };
  } });
  await f.endTurn("pm", { kind: "failed", error: { message: USAGE } }, "pm-turn-1");
  assert.deepEqual(f.calls.apply, []);
  assert.ok(logs.some((l) => /pm-swap-deferred agentId=pm \S+ reason=main-pm/.test(l)));
  f.hooks({});
  await f.tick();
  assert.equal(await f.returns.get("pm"), null);
  assert.deepEqual(f.calls.apply, []);
  assert.equal(f.agents.get("pm")!.model, OPUS);
  assert.ok((await f.records.read()).find((r) => r.agentId === "pm")?.quotaHold, "its resume keeps the ordinary hold");
}));

it("M9: with Claude and Codex both out a main PM still alerts once; a late completion of an older turn does not reset it; a child PM is held as before", () => scenario(async (f, logs) => {
  f.pq.codex = { five: "out", week: "out" };
  f.add("main", "pm", { labels: { role: "pm", project: "personal" } });
  f.add("child", "pm", { labels: { role: "pm", project: "fixture" } });
  await f.endTurn("main", { kind: "failed", error: { message: USAGE } }, "main-turn-1");
  await f.endTurn("child", { kind: "failed", error: { message: USAGE } }, "child-turn-1");
  assert.equal(capAlerts(logs, "main").length, 1);
  assert.equal(capAlerts(logs, "child").length, 0);
  assert.ok(logs.some((l) => l.includes("pm-fallback-held agentId=child") && l.includes("fallback-pool-exhausted")));
  // A late completed event of an older turn while the capped work still waits.
  f.timelines.set("main", [{ type: "user_message", text: "older work", messageId: "older-user" }, { type: "assistant_message", text: "Older normal reply." }]);
  await f.emit({ agent: { id: "main" }, turnId: "older-turn", outcome: { kind: "completed" }, timeline: [] });
  assert.ok((await f.records.read()).some((r) => r.agentId === "main" && r.state === "parked"), "the capped work still waits");
  await f.tick(); await f.tick(); await f.tick();
  assert.equal(capAlerts(logs, "main").length, 1, "deduplicated for the whole episode");
  assert.deepEqual(f.calls.apply, []);
}));

// Decision 386: narrow remote tri-state pace transport for a host without local pq. No private exclusion entries required.
const REMOTE_PACE_ON = {
  paceFallback: true,
  pacePoolAccounts: [] as string[],
  paceRemoteHost: "pace-source-host",
  paceRemoteCommand: ["/usr/local/bin/node", "~/plugins/usage-limit-auto-resume/server/pace-read.ts"],
  paceFallbackExcludedProjects: [] as string[],
  paceFallbackExcludedAgents: [] as string[],
};

it("R1: remote tri-state pace swaps and restores a project PM with both exclusion lists empty, without local pq or retained pace state", () => scenario(async (f, logs) => {
  f.setPqUnavailable(true);
  f.setConfig(REMOTE_PACE_ON);
  let wire: RemotePaceRunResult = { stdout: `${JSON.stringify(formatRemotePace({ state: "undecided", reason: "pq-stale" }, Date.now()))}\n` };
  f.setRemotePace(async () => wire);
  f.add("pm-proj", "pm", { labels: { role: "pm", project: "fixture-proj" } });

  // Undecided moves nothing.
  await f.tick();
  assert.equal(f.agents.get("pm-proj")!.model, OPUS);
  assert.equal(await f.returns.get("pm-proj"), null);
  assert.ok(logs.some((l) => l === "[usage-limit-auto-resume] pm-pace-held reason=undecided"));

  // Off swaps via the exact same obligation + verified swap path.
  wire = { stdout: `${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, Date.now()))}\n` };
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("pm-proj")!), SOL_MEDIUM);
  const obligation = await f.returns.get("pm-proj");
  assert.equal(obligation?.pace, true);
  assert.deepEqual(obligation?.original, OPUS_HIGH);
  assert.ok(logs.some((l) => /pm-swap-start agentId=pm-proj \S+ trigger=pace/.test(l)));
  assert.ok(logs.some((l) => /pm-swap-verified agentId=pm-proj \S+ trigger=pace/.test(l)));

  // On obeys the 30-min flap guard, then restores to the exact original profile.
  wire = { stdout: `${JSON.stringify(formatRemotePace({ state: "on", reason: "on-pace" }, Date.now()))}\n` };
  later(10);
  await f.tick();
  assert.equal(f.agents.get("pm-proj")!.model, SOL, "flap guard holds early restore");
  later(21);
  wire = { stdout: `${JSON.stringify(formatRemotePace({ state: "on", reason: "on-pace" }, Date.now()))}\n` };
  await f.tick();
  assert.deepEqual(profileOf(f.agents.get("pm-proj")!), OPUS_HIGH);
  assert.equal(await f.returns.get("pm-proj"), null);
  assert.ok(logs.some((l) => /pm-restore-verified agentId=pm-proj \S+ trigger=pace/.test(l)));

  // No retained pace state files written to PASEO_HOME, and no quota/account text in logs.
  assert.deepEqual(await readdir(f.home), ["pm-return.json"]);
  for (const line of logs.filter((l) => /pace/.test(l))) assert.doesNotMatch(line, /acct-|usedPct|gap|%|pace-source-host/);
}));

it("R2: remote pace fails closed on missing, timeout, stale, invalid, duplicate-key, blank-line, or misconfigured inputs for both swap and restore", () => scenario(async (f) => {
  f.setPqUnavailable(true);
  f.add("pm-swap", "pm", { labels: { role: "pm", project: "fixture-proj" } });
  const nowIso = () => new Date(Date.now()).toISOString();
  const badResults = (): RemotePaceRunResult[] => [
    { error: "remote-unavailable" },
    { error: "remote-timeout" },
    { stdout: `${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, Date.now() - 180_000))}\n` },
    { stdout: `${JSON.stringify({ schemaVersion: 1, state: "off", reason: "behind-pace", asOf: nowIso(), accounts: [] })}\n` },
    { stdout: `{"schemaVersion":1,"state":"on","state":"off","reason":"behind-pace","asOf":"${nowIso()}"}\n` },
    { stdout: `\n${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, Date.now()))}\n` },
    { stdout: `${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, Date.now()))}\n\n` },
    { stdout: "not-json\n" },
  ];
  f.setConfig(REMOTE_PACE_ON);
  for (const bad of badResults()) {
    f.setRemotePace(async () => bad);
    await f.tick();
    assert.equal(f.agents.get("pm-swap")!.model, OPUS);
  }
  // Incomplete or ambiguous remote configs fail closed too.
  f.setRemotePace(async () => ({ stdout: `${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, Date.now()))}\n` }));
  for (const patch of [
    { paceRemoteCommand: null },
    { paceRemoteHost: null },
    { pacePoolAccounts: ["acct-a"] },
  ]) {
    f.setConfig({ ...REMOTE_PACE_ON, ...patch });
    await f.tick();
    assert.equal(f.agents.get("pm-swap")!.model, OPUS);
  }
  // Swap cleanly, advance past flap guard, then confirm missing/timeout/stale/invalid/duplicate-key never trigger a restore.
  f.setConfig(REMOTE_PACE_ON);
  await f.tick();
  assert.equal(f.agents.get("pm-swap")!.model, SOL);
  later(31);
  for (const bad of [
    { error: "remote-unavailable" } as RemotePaceRunResult,
    { error: "remote-timeout" } as RemotePaceRunResult,
    { stdout: `${JSON.stringify(formatRemotePace({ state: "on", reason: "on-pace" }, Date.now() - 180_000))}\n` },
    { stdout: `${JSON.stringify({ schemaVersion: 1, state: "on", reason: "on-pace", asOf: nowIso(), extra: 1 })}\n` },
    { stdout: `{"schemaVersion":1,"state":"off","state":"on","reason":"on-pace","asOf":"${nowIso()}"}\n` },
    { stdout: `\n${JSON.stringify(formatRemotePace({ state: "on", reason: "on-pace" }, Date.now()))}\n` },
  ]) {
    f.setRemotePace(async () => bad);
    await f.tick();
    assert.equal(f.agents.get("pm-swap")!.model, SOL);
    assert.equal((await f.returns.get("pm-swap"))?.pace, true);
  }
}));

it("R3: remote pace protects hardcoded main PMs, optional user exclusions, and re-checks fresh live labels before writes", () => scenario(async (f, logs) => {
  f.setPqUnavailable(true);
  f.setConfig({ ...REMOTE_PACE_ON, paceFallbackExcludedProjects: ["fixture-excluded"], paceFallbackExcludedAgents: ["excl0001"] });
  f.setRemotePace(async () => ({ stdout: `${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, Date.now()))}\n` }));
  for (const [id, project] of MAIN_PMS) f.add(id, "pm", { labels: { role: "pm", project } });
  f.add("excl-proj", "pm", { labels: { role: "pm", project: "fixture-excluded" } });
  f.add("excl0001-fixture", "pm", { labels: { role: "pm", project: "fixture-proj" } });
  f.add("quiet", "pm", { labels: { role: "pm", project: "fixture-proj", noresume: "true" } });
  f.add("worker", "worker", { labels: { role: "worker", project: "fixture-proj" } });
  f.add("api-pm", "pm", { model: "fleet/api/claude-opus-5-5", labels: { role: "pm", project: "fixture-proj" } });
  await f.tick();
  assert.equal(f.calls.apply.length, 0);
  assert.deepEqual((await f.returns.read()).obligations, []);

  // A project PM relabelled into an excluded project (or main PM) while awaiting the fresh remote SSH check is not written.
  f.add("raced-main", "pm", { labels: { role: "pm", project: "fixture-proj" } });
  f.add("raced-excl", "pm", { labels: { role: "pm", project: "fixture-proj" } });
  f.setRemotePace(async () => {
    if (await f.returns.get("raced-main")) f.agents.get("raced-main")!.labels = { role: "pm", project: "work" };
    if (await f.returns.get("raced-excl")) f.agents.get("raced-excl")!.labels = { role: "pm", project: "fixture-excluded" };
    return { stdout: `${JSON.stringify(formatRemotePace({ state: "off", reason: "behind-pace" }, Date.now()))}\n` };
  });
  await f.tick();
  assert.equal(f.calls.apply.length, 0);
  assert.ok(logs.some((l) => /pm-swap-deferred agentId=raced-main \S+ reason=main-pm/.test(l)));
  assert.ok(logs.some((l) => /pm-swap-deferred agentId=raced-excl \S+ reason=excluded-project/.test(l)));
  await f.tick();
  assert.equal(await f.returns.get("raced-main"), null);
  assert.equal(await f.returns.get("raced-excl"), null);
  assert.equal(f.agents.get("raced-main")!.model, OPUS);
  assert.equal(f.agents.get("raced-excl")!.model, OPUS);
}));

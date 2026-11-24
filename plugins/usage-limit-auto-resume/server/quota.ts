// Quota awareness. Reads Paceline's `pq --json` (schemaVersion 1), the same source and argv OPC's route pace uses
// (skills/orchestration/opc/references/routing.md, Pace and Settings), and reduces one provider pool to a timing
// decision. Anything uncertain reads as "unknown", which keeps the plugin's quota-blind behaviour exactly.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type QuotaPool = "claude" | "codex";
export type QuotaWindow = "five_hour" | "seven_day";

// The windows that free an account. Model-scoped windows (for example seven_day_fable) never decide whether an account
// or the pool is out; they are only summarized per window id in `scoped`.
const WINDOWS: readonly QuotaWindow[] = ["five_hour", "seven_day"];
export const DEFAULT_PQ_ARGV: readonly string[] = ["~/.local/bin/pq", "--json"];

/** What the pool's quota means for a send: unknown (quota-blind), some account has quota, or every account is out. */
export type PoolQuota =
  | { status: "unknown"; pool: QuotaPool | null; reason: string }
  | {
    status: "known";
    pool: QuotaPool;
    accounts: number;
    available: number;
    unknown: number;
    // Every account in the pool is out; a send would only burn a retry.
    exhausted: boolean;
    // The earliest time an out account frees again (all of its out windows reset), and the window that frees it last.
    earliestReset: { at: number; window: QuotaWindow } | null;
    // Every account in the pool is out for the week.
    weekly: boolean;
    // Accounts with fresh five_hour AND seven_day readings that both show quota left. A missing window is no evidence.
    capacity: number;
    // Per model-scoped window id (seven_day_fable): `capacity` counts accounts that are capacity above and whose fresh
    // reading of this window shows quota left too; `out` counts accounts where this window is out (0% left or blocking,
    // reset still ahead), whatever their other windows read.
    scoped?: Record<string, { capacity: number; out: number }>;
  };

// Claude routes (Opus, Sonnet, Fable, Haiku) read the claude accounts, GPT routes (Sol, Luna, Astra) the codex accounts,
// as OPC's LABEL_POOLS and isClaudeModel do. Web models and local models draw on no pq pool.
export function agentPool(provider: string, model: string | null | undefined): QuotaPool | null {
  const text = `${provider}/${model ?? ""}`;
  if (/chatgpt-web/i.test(text)) return null;
  const names = (label: string) => new RegExp(`(?:^|[/._-])${label}(?:$|[/._\\[-])`, "i").test(text);
  if (["claude", "opus", "sonnet", "fable", "haiku"].some(names)) return "claude";
  if (["codex", "gpt", "sol", "luna", "astra"].some(names)) return "codex";
  return null;
}

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * One pool's quota from a parsed pq document. A window is out while its leftPct is 0 (or pq marks it blocking) and its
 * reset, plus the buffer, is still ahead: usage only grows inside a window, so an out reading stays true until the
 * reset even when the account's reading is stale. An account counts as having quota only on a fresh reading whose
 * windows all show some left. An account that is neither, or a stale snapshot, keeps the pool from reading as out.
 */
export function poolQuota(document: unknown, pool: QuotaPool | null, now = Date.now(), bufferMs = 60_000): PoolQuota {
  const unknown = (reason: string): PoolQuota => ({ status: "unknown", pool, reason });
  if (!pool) return unknown("agent draws on no pq pool");
  if (!document || typeof document !== "object" || Array.isArray(document)) return unknown("pq output unparseable");
  const data = document as Record<string, unknown>;
  if (data.schemaVersion !== 1) return unknown(`pq schemaVersion ${String(data.schemaVersion ?? "missing")}, need 1`);
  if (!Array.isArray(data.accounts)) return unknown("pq output has no accounts");
  if (data.snapshotStale !== false) return unknown("pq snapshot is stale");
  const accounts = data.accounts.filter((account): account is Record<string, unknown> =>
    !!account && typeof account === "object" && (account as Record<string, unknown>).provider === pool);
  if (!accounts.length) return unknown(`pq shows no ${pool} accounts`);
  let available = 0, unknownCount = 0, weeklyOut = 0, capacity = 0;
  const frees: Array<{ at: number; window: QuotaWindow }> = [];
  const scoped: Record<string, { capacity: number; out: number }> = {};
  for (const account of accounts) {
    const all = (Array.isArray(account.windows) ? account.windows : []).filter((window): window is Record<string, unknown> =>
      !!window && typeof window === "object" && typeof (window as Record<string, unknown>).id === "string" && !WINDOWS.includes((window as Record<string, unknown>).id as QuotaWindow));
    for (const window of all) {
      const entry = scoped[window.id as string] ??= { capacity: 0, out: 0 };
      if ((num(window.leftPct) && window.leftPct <= 0 || window.state === "blocking") && num(window.resetAt) && window.resetAt * 1000 + bufferMs > now) entry.out++;
    }
    const windows = (Array.isArray(account.windows) ? account.windows : [])
      .filter((window): window is Record<string, unknown> => !!window && typeof window === "object" && WINDOWS.includes((window as Record<string, unknown>).id as QuotaWindow));
    const out = windows.filter((window) => (num(window.leftPct) && window.leftPct <= 0 || window.state === "blocking") &&
      num(window.resetAt) && window.resetAt * 1000 + bufferMs > now);
    if (out.length) {
      const last = out.reduce((a, b) => (b.resetAt as number) > (a.resetAt as number) ? b : a);
      frees.push({ at: (last.resetAt as number) * 1000, window: last.id as QuotaWindow });
      if (out.some((window) => window.id === "seven_day")) weeklyOut++;
    } else if (account.fresh === true && windows.length > 0 && windows.every((window) => window.fresh !== false && num(window.leftPct) && window.leftPct > 0)) {
      available++;
      if (WINDOWS.every((id) => windows.some((window) => window.id === id))) {
        capacity++;
        for (const window of all) if (window.fresh !== false && num(window.leftPct) && window.leftPct > 0) scoped[window.id as string]!.capacity++;
      }
    } else {
      unknownCount++;
    }
  }
  const earliestReset = frees.length ? frees.reduce((a, b) => b.at < a.at ? b : a) : null;
  const exhausted = available === 0 && unknownCount === 0 && earliestReset !== null;
  return { status: "known", pool, accounts: accounts.length, available, unknown: unknownCount, exhausted, earliestReset, weekly: exhausted && weeklyOut === accounts.length, capacity, scoped };
}

/**
 * Pace mode's reading of the listed Claude accounts: `off` (behind pace, or a listed account out), `on`, or `undecided`
 * when it cannot tell. `reason` is a word for the log, never a figure.
 */
export type Pace = { state: "on" | "off" | "undecided"; reason: string };

const WEEK_HOURS = 168;
// The pool may run this many points ahead of its even weekly spend before it counts as off pace.
const PACE_TOLERANCE = 5;

/**
 * The pace of the listed pq accounts (by label, provider claude), from one parsed pq document. For each listed account
 * with a fresh weekly window (`seven_day`, numeric `usedPct` and `resetInSeconds`), the expected use is the share of the
 * week gone, E = 100 * (168 - hours to the reset, clamped to 0..168) / 168, and the use is U = `usedPct`. The pool gap
 * is the sum of E - U over those accounts divided by their number: a listed account with no fresh weekly reading
 * changes neither the sum nor the divisor. With at least one such reading, off pace when the gap is below -5, or a
 * listed account has a `five_hour` or `seven_day` window with nothing left whose reset is still ahead. Undecided on an
 * empty list, an unparseable, other-schema or stale snapshot, or no fresh weekly reading at all.
 */
export function paceOf(document: unknown, labels: readonly string[], now = Date.now()): Pace {
  const undecided = (reason: string): Pace => ({ state: "undecided", reason });
  if (!labels.length) return undecided("no-pool-accounts");
  if (!document || typeof document !== "object" || Array.isArray(document)) return undecided("pq-unparseable");
  const data = document as Record<string, unknown>;
  if (data.schemaVersion !== 1) return undecided("pq-schema");
  if (!Array.isArray(data.accounts)) return undecided("pq-no-accounts");
  if (data.snapshotStale !== false) return undecided("pq-stale");
  let gap = 0, readings = 0, out = false;
  for (const label of labels) {
    const account = data.accounts.find((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" &&
      (entry as Record<string, unknown>).provider === "claude" && (entry as Record<string, unknown>).label === label);
    const windows = (Array.isArray(account?.windows) ? account.windows : []).filter((window): window is Record<string, unknown> => !!window && typeof window === "object");
    // Out as the pool reader counts it: nothing left, and its reset still ahead.
    if (windows.some((window) => WINDOWS.includes(window.id as QuotaWindow) && num(window.leftPct) && window.leftPct <= 0 && num(window.resetAt) && window.resetAt * 1000 > now)) out = true;
    const week = windows.find((window) => window.id === "seven_day");
    if (!week || week.fresh === false || !num(week.usedPct) || !num(week.resetInSeconds)) continue;
    const hours = Math.min(WEEK_HOURS, Math.max(0, week.resetInSeconds / 3600));
    gap += 100 * (WEEK_HOURS - hours) / WEEK_HOURS - week.usedPct;
    readings++;
  }
  if (!readings) return undecided("no-fresh-weekly");
  if (out) return { state: "off", reason: "account-out" };
  if (gap / readings < -PACE_TOLERANCE) return { state: "off", reason: "behind-pace" };
  return { state: "on", reason: "on-pace" };
}

/**
 * Whether the pool reads as out. `refused` means the provider just refused this pool's request for quota (a usage limit,
 * a 429 rate limit, a 402 credit balance): then an account pq cannot show with quota left, such as a stale or rolled-over
 * reading, counts as out too, and only a fresh reading with quota left is capacity.
 */
export function poolOut(quota: PoolQuota, refused = false): boolean {
  return quota.status === "known" && (quota.exhausted || (refused && quota.available === 0));
}

export type QuotaSettings = { resetBufferSeconds: number; maxDelaySeconds: number };

/**
 * When a usage-limit resume is due: about a buffer after the pool's earliest real reset, the first time an out account
 * frees, never before a reset the error itself named. Null when pq names no out account in the pool; the caller then
 * keeps its quota-blind delay.
 */
export function usageResumeAt(quota: PoolQuota, messageResetAt: string | null, messageBufferSeconds: number, settings: QuotaSettings, now = Date.now()): number | null {
  if (quota.status !== "known" || !quota.earliestReset) return null;
  const fromPool = quota.earliestReset.at + settings.resetBufferSeconds * 1000;
  const fromMessage = messageResetAt ? Date.parse(messageResetAt) + messageBufferSeconds * 1000 : 0;
  return Math.min(Math.max(fromPool, fromMessage, now), now + settings.maxDelaySeconds * 1000);
}

/** A hold on a send while the whole pool is out: until the earliest reset plus the buffer, with a visible reason. */
export type QuotaHold = { until: string; reason: string };

export function quotaHold(quota: PoolQuota, settings: QuotaSettings, now = Date.now(), refused = false): QuotaHold | null {
  if (quota.status !== "known" || !poolOut(quota, refused) || !quota.earliestReset) return null;
  const until = Math.min(quota.earliestReset.at + settings.resetBufferSeconds * 1000, now + settings.maxDelaySeconds * 1000);
  if (until <= now) return null;
  const iso = new Date(until).toISOString();
  return {
    until: iso,
    reason: `quota-blocked pool=${quota.pool} ${quota.weekly ? "weekly" : `window=${quota.earliestReset.window}`} accounts=${quota.accounts}${quota.exhausted ? "" : ` unproven=${quota.unknown}`} until=${iso}`,
  };
}

/** The pq argv: routing.json's `pq` key when it is a nonempty string array, else the OPC default. */
export function pqArgv(home = homedir(), routingPath = path.join(home, ".config", "opc", "routing.json")): string[] {
  let argv: readonly string[] = DEFAULT_PQ_ARGV;
  try {
    const value = JSON.parse(readFileSync(routingPath, "utf8")) as { pq?: unknown };
    if (Array.isArray(value?.pq) && value.pq.length && value.pq.every((arg) => typeof arg === "string" && arg)) argv = value.pq as string[];
  } catch {
    // Missing or unreadable routing.json: the default applies, as in OPC.
  }
  const [command, ...args] = argv;
  return [command === "~" || command!.startsWith("~/") ? path.join(home, command!.slice(1)) : command!, ...args];
}

export type PqResult = { document: unknown } | { error: string };

/** Runs pq without a shell, settles on the first complete JSON document, and gives up after timeoutMs. */
export function runPq(argv: readonly string[], timeoutMs: number): Promise<PqResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const [file, ...args] = argv;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (result: PqResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: `pq gave no answer in ${timeoutMs / 1000}s` }), timeoutMs);
    try {
      child = spawn(file!, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish({ error: `pq unavailable (${error instanceof Error ? error.message : String(error)})` });
      return;
    }
    if (!child) return;
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 << 20) return finish({ error: "pq output too large" });
      try { finish({ document: JSON.parse(stdout) }); } catch { /* not complete yet */ }
    });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ error: error.code === "ENOENT" ? `pq unavailable (${file} not found)` : `pq unavailable (${error.message})` }));
    child.on("close", (exit: number | null) => finish({ error: `pq unavailable (${stderr.trim().split(/\r?\n/)[0] || `exit ${exit}`})` }));
  });
}

/**
 * One pq reading shared by every caller for ttlMs, so many failing agents start one pq process, not one each. A
 * reading in progress is shared too. Failures are cached for the same time, so a missing pq is not retried per agent.
 */
export class QuotaReader {
  private cached: { at: number; result: Promise<PqResult> } | null = null;

  private readonly run: (timeoutMs: number) => Promise<PqResult>;
  private readonly clock: () => number;

  constructor(run: (timeoutMs: number) => Promise<PqResult> = (timeoutMs) => runPq(pqArgv(), timeoutMs), clock: () => number = Date.now) {
    this.run = run;
    this.clock = clock;
  }

  read(ttlMs: number, timeoutMs: number): Promise<PqResult> {
    const now = this.clock();
    if (this.cached && now - this.cached.at < ttlMs) return this.cached.result;
    const result = this.run(timeoutMs).catch((error: unknown) => ({ error: `pq failed (${error instanceof Error ? error.message : String(error)})` }));
    this.cached = { at: now, result };
    return result;
  }

  async pool(pool: QuotaPool | null, options: { ttlMs: number; timeoutMs: number; bufferMs: number }, now = this.clock()): Promise<PoolQuota> {
    if (!pool) return { status: "unknown", pool, reason: "agent draws on no pq pool" };
    const result = await this.read(options.ttlMs, options.timeoutMs);
    return "error" in result ? { status: "unknown", pool, reason: result.error } : poolQuota(result.document, pool, now, options.bufferMs);
  }

  /** Pace mode's reading of the listed accounts, from the same shared pq reading. A failed pq run is undecided. */
  async pace(labels: readonly string[], options: { ttlMs: number; timeoutMs: number }): Promise<Pace> {
    if (!labels.length) return { state: "undecided", reason: "no-pool-accounts" };
    const result = await this.read(options.ttlMs, options.timeoutMs);
    return "error" in result ? { state: "undecided", reason: "pq-unavailable" } : paceOf(result.document, labels, this.clock());
  }
}

export const REMOTE_PACE_SCHEMA_VERSION = 1;
export const MAX_REMOTE_PACE_BYTES = 4096;
const MAX_REMOTE_FUTURE_SKEW_MS = 30_000;

// The exact reason words that may cross the remote pace wire for each state: never figures, labels or arbitrary text.
const PACE_REASONS: Readonly<Record<Pace["state"], readonly string[]>> = {
  on: ["on-pace"],
  off: ["behind-pace", "account-out"],
  undecided: [
    "no-pool-accounts", "pq-unparseable", "pq-schema", "pq-no-accounts",
    "pq-stale", "no-fresh-weekly", "pq-unavailable", "quotaAware-off", "config-invalid",
  ],
};

export type RemotePacePayload = {
  schemaVersion: 1;
  state: Pace["state"];
  reason: string;
  asOf: string;
};

const RFC3339_UTC = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z$/;

function parseUtcIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_UTC.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((match[7] ?? "0").padEnd(3, "0"));
  const time = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? time : null;
}

/** Encodes a local Pace verdict into the minimal strict wire payload (no pq, labels, or quota/reset data). */
export function formatRemotePace(pace: Pace, now = Date.now()): RemotePacePayload {
  const allowed = PACE_REASONS[pace.state];
  const safe: Pace = allowed?.includes(pace.reason) ? pace : { state: "undecided", reason: "pq-unavailable" };
  return { schemaVersion: REMOTE_PACE_SCHEMA_VERSION, state: safe.state, reason: safe.reason, asOf: new Date(now).toISOString() };
}

export type ValidatedRemotePace = { pace: Pace; asOfMs: number | null };

/** Whether already-parsed JSON text repeats any key in any object (decoding escaped spellings). */
export function repeatsKey(text: string): boolean {
  const objects: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const keys = objects.at(-1);
      if (keys && expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      i = end;
    } else if (c === "{") {
      objects.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      objects.push(null);
      expectKey = false;
    } else if (c === "}" || c === "]") {
      objects.pop();
      expectKey = false;
    } else if (c === ",") {
      expectKey = objects.at(-1) != null;
    }
  }
  return false;
}

/**
 * Strictly validates one single-line JSON wire payload from the remote pace producer (only an optional final line
 * terminator, no surrounding blank lines or whitespace, and four unique canonical keys with no duplicate keys). Any
 * unknown/duplicate key, bad schema, unallowlisted reason, malformed or future timestamp, stale reading, or oversized
 * output fails closed as undecided.
 */
export function parseRemotePace(raw: string, now = Date.now(), maxAgeMs = 120_000): ValidatedRemotePace {
  const fail = (reason: string): ValidatedRemotePace => ({ pace: { state: "undecided", reason }, asOfMs: null });
  if (Buffer.byteLength(raw, "utf8") > MAX_REMOTE_PACE_BYTES) return fail("remote-invalid");
  let line = raw;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (!line || line.includes("\n") || line.includes("\r") || !line.startsWith("{") || !line.endsWith("}")) {
    return fail("remote-invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail("remote-invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || repeatsKey(line)) return fail("remote-invalid");
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 4 || keys[0] !== "asOf" || keys[1] !== "reason" || keys[2] !== "schemaVersion" || keys[3] !== "state") {
    return fail("remote-invalid");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion !== REMOTE_PACE_SCHEMA_VERSION) return fail("remote-invalid");
  if (doc.state !== "on" && doc.state !== "off" && doc.state !== "undecided") return fail("remote-invalid");
  if (typeof doc.reason !== "string" || !PACE_REASONS[doc.state].includes(doc.reason)) return fail("remote-invalid");
  const asOfMs = parseUtcIso(doc.asOf);
  if (asOfMs === null || asOfMs > now + MAX_REMOTE_FUTURE_SKEW_MS) return fail("remote-invalid");
  if (now - asOfMs > maxAgeMs) return fail("remote-stale");
  return { pace: { state: doc.state, reason: doc.reason }, asOfMs };
}

function posixQuote(arg: string): string {
  if (arg === "~") return "~";
  if (arg.startsWith("~/")) return `~/'${arg.slice(2).replace(/'/g, "'\\''")}'`;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function remotePaceSshArgv(host: string, command: readonly string[], timeoutMs: number, sshBin = "ssh"): string[] {
  const connectSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    sshBin,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "RequestTTY=no",
    "-o", `ConnectTimeout=${connectSeconds}`,
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "--",
    host,
    command.map(posixQuote).join(" "),
  ];
}

export type RemotePaceRunResult = { stdout: string } | { error: "remote-timeout" | "remote-unavailable" | "remote-invalid" };

/**
 * Runs the remote pace command over existing authenticated SSH without a local shell. Enforces timeoutMs,
 * MAX_REMOTE_PACE_BYTES, exit status 0, and discards stderr so remote diagnostics never reach local logs.
 */
export function runRemotePaceSsh(host: string, command: readonly string[], timeoutMs: number, sshBin = "ssh"): Promise<RemotePaceRunResult> {
  return new Promise((resolve) => {
    const [file, ...args] = remotePaceSshArgv(host, command, timeoutMs, sshBin);
    let stdout = "", stdoutBytes = 0, done = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (result: RemotePaceRunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "remote-timeout" }), timeoutMs);
    try {
      child = spawn(file!, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      finish({ error: "remote-unavailable" });
      return;
    }
    if (!child) return;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_REMOTE_PACE_BYTES) return finish({ error: "remote-invalid" });
      stdout += chunk;
    });
    // Drain stderr without storing or logging it so remote messages never reach local logs.
    child.stderr!.resume();
    child.on("error", () => finish({ error: "remote-unavailable" }));
    child.on("close", (exit: number | null, signal: NodeJS.Signals | null) => {
      if (exit === 0 && signal === null) finish({ stdout });
      else finish({ error: "remote-unavailable" });
    });
  });
}

export type RemotePaceRunner = (host: string, command: readonly string[], timeoutMs: number) => Promise<RemotePaceRunResult>;

/**
 * One remote pace verdict shared in memory for ttlMs (never written to disk), keyed by host and command.
 * Missing, timed-out, stale, or invalid responses fail closed as undecided.
 */
export class RemotePaceReader {
  private cached: { key: string; at: number; result: Promise<ValidatedRemotePace> } | null = null;
  private readonly run: RemotePaceRunner;
  private readonly clock: () => number;

  constructor(run: RemotePaceRunner = runRemotePaceSsh, clock: () => number = () => Date.now()) {
    this.run = run;
    this.clock = clock;
  }

  async read(host: string, command: readonly string[], options: { ttlMs: number; timeoutMs: number; maxAgeMs: number }): Promise<Pace> {
    const now = this.clock();
    const key = JSON.stringify([host, command]);
    if (this.cached && this.cached.key === key && now - this.cached.at < options.ttlMs) {
      const hit = await this.cached.result;
      if (hit.asOfMs === null) return hit.pace;
      const current = this.clock();
      if (hit.asOfMs <= current + MAX_REMOTE_FUTURE_SKEW_MS && current - hit.asOfMs <= options.maxAgeMs) return hit.pace;
    }
    const result = this.run(host, command, options.timeoutMs)
      .then((raw): ValidatedRemotePace => "error" in raw
        ? { pace: { state: "undecided", reason: raw.error }, asOfMs: null }
        : parseRemotePace(raw.stdout, this.clock(), options.maxAgeMs))
      .catch((): ValidatedRemotePace => ({ pace: { state: "undecided", reason: "remote-unavailable" }, asOfMs: null }));
    this.cached = { key, at: now, result };
    return (await result).pace;
  }
}

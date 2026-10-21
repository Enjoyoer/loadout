// Quota awareness. Reads Paceline's `pq --json` (schemaVersion 1), the same source and argv OPC's route pace uses
// (skills/orchestration/opc/references/routing.md, Pace and Settings), and reduces one provider pool to a timing
// decision. Anything uncertain reads as "unknown", which keeps the plugin's quota-blind behaviour exactly.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type QuotaPool = "claude" | "codex";
export type QuotaWindow = "five_hour" | "seven_day";

// The windows that free an account. Model-scoped windows (for example seven_day_fable) are not read.
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
  for (const account of accounts) {
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
      if (WINDOWS.every((id) => windows.some((window) => window.id === id))) capacity++;
    } else {
      unknownCount++;
    }
  }
  const earliestReset = frees.length ? frees.reduce((a, b) => b.at < a.at ? b : a) : null;
  const exhausted = available === 0 && unknownCount === 0 && earliestReset !== null;
  return { status: "known", pool, accounts: accounts.length, available, unknown: unknownCount, exhausted, earliestReset, weekly: exhausted && weeklyOut === accounts.length, capacity };
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
}

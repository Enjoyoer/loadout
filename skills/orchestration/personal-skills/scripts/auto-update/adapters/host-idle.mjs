#!/usr/bin/env node
// Read-only host idle probes for the auto-update runner. Each prints one JSON line
// {ok, observed_at, detail, counters?, identity?} and exits 0; a signal it cannot read is an error (exit 1), which the
// runner treats as unknown and keeps the gate closed. Output is counts and short codes only: never agent names,
// prompts, process arguments, log lines, environment or secrets.
//
//   host-idle.mjs paseo [--paseo <cli>]
//       No local Paseo agent in an active turn: `paseo ls -g -a --json` against the local daemon; every agent must be
//       idle or closed (any other status, or no answer, closes the gate).
//   host-idle.mjs load [--max-load-per-core N] [--max-cpu-pct N] [--min-mem-free-pct N] [--min-avail-mb N]
//                      [--heavy-lock <dir>]... [--heavy-queue <dir>]... [--heavy-flock <file>]...
//       Below normal load under the hosts' existing policy: no job holds or waits for the host's `heavy` lock, the
//       5-minute load average per core is at most N (POSIX; Windows has none, so CPU busy % over a 1 s sample),
//       and free memory is above the floor (macOS memory_pressure free %, Linux MemAvailable MB, Windows free %).
//   host-idle.mjs quiet --launchd <name>=<label>...
//       macOS: cumulative CPU time of each launchd job's process, in centiseconds, as counters; identity is the PIDs.
//       The runner compares two ticks' counters (quiet in the registry); one reading alone never proves quiet.
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i];
  const v = rest[i + 1];
  if (!k || !k.startsWith("--") || v === undefined) fail("usage: see the header of host-idle.mjs");
  (opts[k.slice(2)] ||= []).push(v);
}
const one = (k, d) => (opts[k] ? opts[k][opts[k].length - 1] : d);
const numOpt = (k, d) => { const v = Number(one(k, d)); if (!Number.isFinite(v)) fail(`--${k}: a number`); return v; };
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function fail(why) { process.stderr.write(`host-idle: ${why}\n`); process.exit(1); }
function out(ok, detail, extra = {}) { process.stdout.write(JSON.stringify({ ok, observed_at: iso(), detail, ...extra }) + "\n"); process.exit(0); }
function run(argv, opt = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20000, maxBuffer: 64 << 20, windowsHide: true, ...opt });
  if (r.error || r.status !== 0) fail(`${argv[0].split(/[\\/]/).pop()} failed`);
  return r.stdout;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

if (cmd === "paseo") {
  const cli = one("paseo", "paseo");
  const text = process.platform === "win32" && /\.cmd$/i.test(cli)
    ? run(["cmd.exe", "/d", "/s", "/c", `"${cli}" ls -g -a --json`], { windowsVerbatimArguments: true })
    : run([cli, "ls", "-g", "-a", "--json"]);
  let agents;
  try { agents = JSON.parse(text); } catch { fail("paseo ls output not JSON"); }
  if (!Array.isArray(agents) || agents.some((a) => !a || typeof a.status !== "string")) fail("paseo ls output has no statuses");
  const active = agents.filter((a) => !["idle", "closed"].includes(a.status));
  const kinds = [...new Set(active.map((a) => a.status.replace(/[^a-z_-]/g, "").slice(0, 20)))].sort().join(",");
  out(active.length === 0, `${active.length} of ${agents.length} agents active${kinds ? ` (${kinds})` : ""}`);
}

if (cmd === "load") {
  const why = [];
  for (const dir of opts["heavy-lock"] || []) {
    if (!fs.existsSync(dir)) continue;
    let pid = null;
    try { pid = Number((/^pid=(\d+)$/m.exec(fs.readFileSync(`${dir}/owner`, "utf8")) || [])[1]) || null; } catch {}
    if (pid === null || alive(pid)) why.push("heavy job running");
  }
  for (const dir of opts["heavy-queue"] || []) {
    let n = 0;
    try { n = fs.readdirSync(dir).length; } catch (e) { if (e.code !== "ENOENT") fail("heavy queue unreadable"); }
    if (n) why.push(`heavy queue ${n}`);
  }
  for (const file of opts["heavy-flock"] || []) {
    let st;
    try { st = fs.statSync(file); } catch (e) { if (e.code === "ENOENT") continue; fail("heavy lock unreadable"); }
    const major = Number((BigInt(st.dev) >> 8n) & 0xfffn);
    const minor = Number((BigInt(st.dev) & 0xffn) | ((BigInt(st.dev) >> 12n) & 0xfff00n));
    const id = `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${st.ino}`;
    let locks;
    try { locks = fs.readFileSync("/proc/locks", "utf8"); } catch { fail("/proc/locks unreadable"); }
    if (locks.split("\n").some((l) => l.split(/\s+/).includes(id))) why.push("heavy job running");
  }
  const cores = os.cpus().length;
  if (!cores) fail("no CPU count");
  let loadText;
  if (process.platform === "win32") {
    const busy = (c) => c.times.user + c.times.nice + c.times.sys + c.times.irq;
    const total = (c) => busy(c) + c.times.idle;
    const a = os.cpus();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // a 1 s measurement, not a wait for idle
    const b = os.cpus();
    const sum = (f, xs) => xs.reduce((n, c) => n + f(c), 0);
    const dt = sum(total, b) - sum(total, a);
    if (dt <= 0) fail("no CPU sample");
    const pct = (100 * (sum(busy, b) - sum(busy, a))) / dt;
    const max = numOpt("max-cpu-pct", 50);
    loadText = `cpu ${pct.toFixed(0)}% (max ${max})`;
    if (pct > max) why.push("cpu busy");
  } else {
    const per = os.loadavg()[1] / cores;
    const max = numOpt("max-load-per-core", 1);
    loadText = `load5/core ${per.toFixed(2)} (max ${max})`;
    if (per > max) why.push("load high");
  }
  let memText = "";
  if (process.platform === "darwin") {
    const m = /free percentage:\s*(\d+)%/.exec(run(["/usr/bin/memory_pressure", "-Q"]));
    if (!m) fail("memory_pressure gave no free percentage");
    const min = numOpt("min-mem-free-pct", 15);
    memText = `, memory free ${m[1]}% (min ${min})`;
    if (Number(m[1]) < min) why.push("memory low");
  } else if (process.platform === "linux") {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (!m) fail("no MemAvailable");
    const mb = Math.floor(Number(m[1]) / 1024);
    const min = numOpt("min-avail-mb", 3072);
    memText = `, available ${mb} MB (min ${min})`;
    if (mb < min) why.push("memory low");
  } else {
    const pct = (100 * os.freemem()) / os.totalmem();
    const min = numOpt("min-mem-free-pct", 15);
    memText = `, memory free ${pct.toFixed(0)}% (min ${min})`;
    if (pct < min) why.push("memory low");
  }
  out(why.length === 0, `${why.length ? why.join(", ") + "; " : ""}${loadText}${memText}`);
}

if (cmd === "quiet") {
  if (process.platform !== "darwin") fail("quiet: macOS launchd jobs only");
  const pairs = (opts.launchd || []).map((x) => /^([a-z0-9][a-z0-9-]{0,30})=([A-Za-z0-9._-]{1,128})$/.exec(x));
  if (!pairs.length || pairs.some((m) => !m)) fail("quiet: --launchd <name>=<label>");
  const uid = process.getuid();
  const counters = {};
  const ids = [];
  for (const [, name, label] of pairs) {
    const pid = (/^\s*pid = (\d+)$/m.exec(run(["/bin/launchctl", "print", `gui/${uid}/${label}`])) || [])[1];
    if (!pid) fail(`${name}: not running`);
    const t = run(["/bin/ps", "-o", "time=", "-p", pid]).trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(t);
    if (!m) fail(`${name}: CPU time unreadable`);
    const [, d = 0, h = 0, mi, se, frac = "0"] = m;
    counters[name] = (((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(se)) * 100 + Math.round(Number(`0.${frac}`) * 100);
    ids.push(`${name}:${pid}`);
  }
  out(true, "cpu time sampled", { counters, identity: ids.join(",") });
}

fail("usage: host-idle.mjs paseo|load|quiet ...");

#!/usr/bin/env node
// Read-only host idle probes for the auto-update runner. Each prints one JSON line
// {ok, observed_at, detail, metrics?, counters?, identity?} and exits 0; a signal it cannot read is an error (exit 1), which the
// runner treats as unknown and keeps the gate closed. Output is counts and short codes only: never agent names,
// prompts, process arguments, log lines, environment or secrets.
//
//   host-idle.mjs paseo [--paseo <cli>] [--home <dir>]
//       No Paseo agent on this host in an active turn. Unambiguous only when this host runs exactly one Paseo daemon
//       (one supervisor process) and it is the one the home's paseo.pid names; a second daemon, such as a scratch
//       one with its own home, makes the answer incomplete, so the gate closes. Then `paseo ls -g -a --json --home`
//       lists the daemon's agents (unique ids, string statuses; idle, closed and error are not in a turn, anything
//       else is), and every agent record stored in the home whose last status is not idle, closed or error must be
//       in that list, or the enumeration is ambiguous and the gate closes.
//   host-idle.mjs exit-gate -- <argv...>
//       Runs an existing reviewed idle gate as-is (no shell) whose exit code is 0 idle, 1 busy, 2 unknown and whose
//       last stdout line is JSON with "state" idle, busy or unknown matching it. Anything else, unknown included,
//       is an error. Only the gate's plain numbers are passed on.
//   host-idle.mjs listener-clients --lsof <path> --addr <ipv4:port>
//       No client connected to a local TCP listener. lsof must first show the listener itself (proof that this
//       user can see that process's sockets), then no ESTABLISHED connection on the address, then the listener
//       again. lsof's exit 1 with no output is the normal empty match; any other exit, any stderr, or a listener
//       it cannot see is an error. lsof only reads socket tables, so the probe adds no traffic.
//   host-idle.mjs load [--max-load-per-core N] [--max-cpu-pct N] [--min-mem-free-pct N] [--min-avail-mb N]
//                      [--job-lock <dir>]... [--job-queue <dir>]... [--job-flock <file>]...
//       Below normal load under the hosts' existing policy: no job holds or waits for the host's one-job build lock
//       (a mkdir lock whose owner file says pid=N, its queue directory, or a flock seen in /proc/locks), the
//       5-minute load average per core is at most N (POSIX; Windows has none, so CPU busy % over a 1 s sample),
//       and free memory is above the floor (macOS memory_pressure free %, Linux MemAvailable MB, Windows free %).
//   host-idle.mjs quiet --launchd <name>=<label>...
//       macOS: cumulative CPU time of each launchd job's process, in centiseconds, as counters; identity is the PIDs.
//       Diagnostic only: its reading says "diagnostic": true, and the runner never lets it open a gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [cmd, ...all] = process.argv.slice(2);
const dash = all.indexOf("--");
const rest = dash < 0 ? all : all.slice(0, dash);
const tail = dash < 0 ? [] : all.slice(dash + 1);
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
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const RESTING = ["idle", "closed", "error"]; // not in a turn

// PIDs of every Paseo supervisor on this host, one per running daemon, whatever its home.
// Fixtures only: AUTO_UPDATE_TEST_PS names a file of "pid args" lines standing in for the process table.
function supervisors() {
  const test = process.env.AUTO_UPDATE_TEST_PS;
  if (!test && process.platform === "win32") {
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'supervisor-entrypoint\\.js' -or $_.CommandLine -eq 'Paseo Supervisor' } | ForEach-Object { $_.ProcessId }";
    return run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps]).split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim())).map(Number);
  }
  return (test ? fs.readFileSync(test, "utf8") : run(["/bin/ps", "-Ao", "pid=,args="])).split(/\r?\n/).map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => m[2].trim() === "Paseo Supervisor" || /supervisor-entrypoint\.js/.test(m[2])).map((m) => Number(m[1]));
}

if (cmd === "paseo") {
  const cli = one("paseo", "paseo");
  const home = expand(one("home", "~/.paseo"));
  let pid = null;
  try { pid = JSON.parse(fs.readFileSync(path.join(home, "paseo.pid"), "utf8")).pid; } catch { fail("no readable paseo.pid in the home"); }
  if (!Number.isInteger(pid) || !alive(pid)) fail("the home's daemon is not running");
  const sups = supervisors();
  if (sups.length !== 1 || sups[0] !== pid) {
    out(false, `ambiguous: ${sups.length} Paseo daemons on this host${sups.includes(pid) ? "" : ", none is the home's"}`, { metrics: { daemons: sups.length } });
  }
  const text = process.platform === "win32" && /\.cmd$/i.test(cli)
    ? run(["cmd.exe", "/d", "/s", "/c", `""${cli}" ls -g -a --json --home "${home}""`], { windowsVerbatimArguments: true })
    : run([cli, "ls", "-g", "-a", "--json", "--home", home]);
  let agents;
  try { agents = JSON.parse(text); } catch { fail("paseo ls output not JSON"); }
  if (!Array.isArray(agents) || agents.some((a) => !a || typeof a.status !== "string" || typeof a.id !== "string")) fail("paseo ls output has no ids or statuses");
  const listed = new Set(agents.map((a) => a.id));
  if (listed.size !== agents.length) out(false, "ambiguous: paseo ls repeats an agent", { metrics: { agents: agents.length } });
  // Stored records: only id and last status are read.
  let unlisted = 0, unreadable = 0;
  const root = path.join(home, "agents");
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (e) { if (e.code !== "ENOENT") fail("agent store unreadable"); }
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d.name))) {
      if (!f.endsWith(".json")) continue;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(root, d.name, f), "utf8")); } catch { unreadable += 1; continue; }
      const st = rec && typeof rec.lastStatus === "string" ? rec.lastStatus : null;
      if (st !== null && RESTING.includes(st)) continue;
      if (!listed.has(rec && rec.id)) unlisted += 1;
    }
  }
  if (unlisted || unreadable) out(false, `ambiguous: ${unlisted} stored agents possibly in a turn are not listed, ${unreadable} unreadable`, { metrics: { unlisted, unreadable } });
  const active = agents.filter((a) => !RESTING.includes(a.status));
  const kinds = [...new Set(active.map((a) => a.status.replace(/[^a-z_-]/g, "").slice(0, 20)))].sort().join(",");
  out(active.length === 0, `${active.length} of ${agents.length} agents active${kinds ? ` (${kinds})` : ""}`,
    { metrics: { active: active.length, agents: agents.length, daemons: 1 } });
}

if (cmd === "exit-gate") {
  if (!tail.length) fail("exit-gate: -- <argv> required");
  const r = spawnSync(tail[0], tail.slice(1), { encoding: "utf8", timeout: 60000, maxBuffer: 1 << 20, windowsHide: true });
  if (r.error) fail("exit-gate: gate did not run");
  const states = { 0: "idle", 1: "busy" };
  if (!(r.status in states)) fail(r.status === 2 ? "exit-gate: gate says unknown" : `exit-gate: gate exit ${r.status}`);
  let v;
  try { v = JSON.parse((r.stdout || "").trim().split(/\r?\n/).pop()); } catch { fail("exit-gate: gate output not JSON"); }
  if (!v || typeof v !== "object" || v.state !== states[r.status]) fail("exit-gate: gate state does not match its exit code");
  const metrics = Object.fromEntries(Object.entries(v).filter(([k, x]) => /^[a-z][a-z0-9_]{0,23}$/.test(k) && Number.isFinite(x)).slice(0, 6));
  out(r.status === 0, `state ${v.state}${Object.keys(metrics).length ? " " + Object.entries(metrics).map(([k, x]) => `${k}=${x}`).join(" ") : ""}`, { metrics });
}

if (cmd === "listener-clients") {
  const lsof = one("lsof");
  const addr = one("addr");
  if (!lsof || !path.isAbsolute(lsof)) fail("listener-clients: --lsof <absolute path>");
  if (!addr || !/^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(addr)) fail("listener-clients: --addr <ipv4:port>");
  const q = (state) => {
    const r = spawnSync(lsof, ["-nP", `-iTCP@${addr}`, `-sTCP:${state}`], { encoding: "utf8", timeout: 20000, maxBuffer: 8 << 20 });
    if (r.error || (r.stderr || "").trim()) fail(`listener-clients: lsof ${state} errored`);
    const rows = (r.stdout || "").split("\n").slice(1).filter((l) => l.trim());
    if (r.status === 1 && !rows.length && !(r.stdout || "").trim()) return [];
    if (r.status !== 0 || !rows.length) fail(`listener-clients: lsof ${state} exit ${r.status}`);
    return rows;
  };
  const listening = () => q("LISTEN").filter((l) => l.includes(` ${addr} (LISTEN)`)).length;
  if (!listening()) fail("listener-clients: listener not visible");
  const conns = q("ESTABLISHED").filter((l) => l.includes(`${addr}->`) || l.includes(`->${addr} `));
  if (!listening()) fail("listener-clients: listener gone during the check");
  const clients = new Set(conns.map((l) => (/(\S+->\S+) \(ESTABLISHED\)/.exec(l) || [])[1]).filter(Boolean)
    .map((c) => c.split("->").sort().join("<>"))).size;
  out(clients === 0 && conns.length === 0, `${clients} established clients`, { metrics: { clients } });
}

if (cmd === "load") {
  const why = [];
  const metrics = {};
  for (const dir of opts["job-lock"] || []) {
    if (!fs.existsSync(dir)) continue;
    let pid = null;
    try { pid = Number((/^pid=(\d+)$/m.exec(fs.readFileSync(`${dir}/owner`, "utf8")) || [])[1]) || null; } catch {}
    if (pid === null || alive(pid)) why.push("job lock held");
  }
  for (const dir of opts["job-queue"] || []) {
    let n = 0;
    try { n = fs.readdirSync(dir).length; } catch (e) { if (e.code !== "ENOENT") fail("job queue unreadable"); }
    if (n) why.push(`job queue ${n}`);
  }
  for (const file of opts["job-flock"] || []) {
    let st;
    try { st = fs.statSync(file); } catch (e) { if (e.code === "ENOENT") continue; fail("job lock unreadable"); }
    const major = Number((BigInt(st.dev) >> 8n) & 0xfffn);
    const minor = Number((BigInt(st.dev) & 0xffn) | ((BigInt(st.dev) >> 12n) & 0xfff00n));
    const id = `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${st.ino}`;
    let locks;
    try { locks = fs.readFileSync("/proc/locks", "utf8"); } catch { fail("/proc/locks unreadable"); }
    if (locks.split("\n").some((l) => l.split(/\s+/).includes(id))) why.push("job lock held");
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
    metrics.cpu_pct = Math.round(pct);
    if (pct > max) why.push("cpu busy");
  } else {
    const per = os.loadavg()[1] / cores;
    const max = numOpt("max-load-per-core", 1);
    loadText = `load5/core ${per.toFixed(2)} (max ${max})`;
    metrics.load_per_core = Math.round(per * 100) / 100;
    if (per > max) why.push("load high");
  }
  let memText = "";
  if (process.platform === "darwin") {
    const m = /free percentage:\s*(\d+)%/.exec(run(["/usr/bin/memory_pressure", "-Q"]));
    if (!m) fail("memory_pressure gave no free percentage");
    const min = numOpt("min-mem-free-pct", 15);
    memText = `, memory free ${m[1]}% (min ${min})`;
    metrics.mem_free_pct = Number(m[1]);
    if (Number(m[1]) < min) why.push("memory low");
  } else if (process.platform === "linux") {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (!m) fail("no MemAvailable");
    const mb = Math.floor(Number(m[1]) / 1024);
    const min = numOpt("min-avail-mb", 3072);
    memText = `, available ${mb} MB (min ${min})`;
    metrics.avail_mb = mb;
    if (mb < min) why.push("memory low");
  } else {
    const pct = (100 * os.freemem()) / os.totalmem();
    const min = numOpt("min-mem-free-pct", 15);
    memText = `, memory free ${pct.toFixed(0)}% (min ${min})`;
    metrics.mem_free_pct = Math.round(pct);
    if (pct < min) why.push("memory low");
  }
  metrics.job_lock = why.some((w) => w.startsWith("job")) ? 1 : 0;
  out(why.length === 0, `${why.length ? why.join(", ") + "; " : ""}${loadText}${memText}`, { metrics });
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
  out(true, "cpu time sampled (diagnostic only)", { counters, identity: ids.join(","), diagnostic: true });
}

fail("usage: host-idle.mjs paseo|load|quiet ...");

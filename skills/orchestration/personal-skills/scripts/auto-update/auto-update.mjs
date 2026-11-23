#!/usr/bin/env node
// Loadout fleet auto-update runner. One fixed-rule decision core per host; no model decisions, no service.
//
//   node auto-update.mjs plan --host <name> [--now <ISO>]   would-apply lines, reads only, writes nothing
//   node auto-update.mjs run  --host <name> [--now <ISO>] [--wait]
//                                                           scheduler entry: at most one apply, silent on success;
//                                                           --wait stays until the transaction and watchdog end
//   node auto-update.mjs validate                           check the registry for every host
//   node auto-update.mjs export --host <self> --for <host>  relay copies of this host's feed and canary receipts
//   node auto-update.mjs txn <dir> | watchdog <dir>         internal: the detached transaction and its rollback timer
//
// Inputs: <fleet>/auto-update/registry.json and switch.json (Config-owned, private fleet), the available-versions
// feed (data only, never executed) and canary receipts. State: <state>/ (attempts, holds, applied log, lock).
// See README.md beside this file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ADAPTERS = path.join(path.dirname(SELF), "adapters");
const WINDOWS = process.platform === "win32";
const OS_NAME = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];

const REGISTRY_SCHEMA = "loadout.auto-update.registry/1";
const SWITCH_SCHEMA = "loadout.auto-update.switch/1";
const FEED_SCHEMA = "loadout.auto-update.available/1";
const RECEIPT_SCHEMA = "loadout.auto-update.canary/1";
const STATE_SCHEMA = "loadout.auto-update.state/1";
const GATES_SCHEMA = "loadout.auto-update.gates/1";
const RELAY_SCHEMA = "loadout.auto-update.relay/1";
const GATE_DAYS_KEPT = 31;

const ID_RE = /^[a-z0-9][a-z0-9.@+-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
// An installed version may also carry a Homebrew revision (15.2.0_1); the feed never does.
const INSTALLED_RE = /^[0-9][0-9A-Za-z._+-]{0,63}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/; // a window may run to the end of the day
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TXN_RE = /^\d{8}T\d{6}Z-[a-z0-9][a-z0-9.@+-]{0,63}-[0-9a-f]{6}$/;
// A Windows scheduler task waits for the transaction (run --wait); its time limit must outlast the longest one.
const WINDOWS_TXN_MAX_SECONDS = 4 * 3600;
const WATCHDOG_MARGIN_S = 10;
// Shared by every agent on a host: never automatic, whatever a registry says.
const PROTECTED = ["paseo", "node", "nodejs", "npm", "python", "python3", "homebrew", "git", "openssh", "ssh"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const OSES = ["macos", "linux", "windows"];
const STEPS = ["check", "stage", "precheck", "apply", "health", "rollback"];
const PLACEHOLDERS = new Set(["version", "installed", "digest", "adapters", "txn", "component", "host", "node"]);
const ACTIVE = new Set(["started", "staging", "prechecking", "applying", "health", "rolling-back"]);
const MAX_INPUT = 256 * 1024;
const MAX_FEED = 64 * 1024;
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const STALE_LOCK_MS = 10 * 60 * 1000;

class Refusal extends Error {}

// ---------- small helpers ----------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function exactKeys(obj, where, required, optional = []) {
  if (!isObj(obj)) throw new Refusal(`${where}: not an object`);
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) throw new Refusal(`${where}: unknown key ${JSON.stringify(k)}`);
  }
  for (const k of required) if (!(k in obj)) throw new Refusal(`${where}: missing ${k}`);
}

function parseTs(v, where) {
  if (typeof v !== "string" || !TS_RE.test(v)) throw new Refusal(`${where}: not a UTC YYYY-MM-DDTHH:MM:SSZ time`);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || iso(ms) !== v) throw new Refusal(`${where}: invalid time`);
  return ms;
}

function num(v, where, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new Refusal(`${where}: must be an integer ${min}..${max}`);
  return v;
}

function str(v, where, re) {
  if (typeof v !== "string" || (re && !re.test(v))) throw new Refusal(`${where}: invalid value`);
  return v;
}

function regex(v, where) {
  str(v, where);
  if (!v.startsWith("^") || !v.endsWith("$")) throw new Refusal(`${where}: pattern must be anchored with ^ and $`);
  try { return new RegExp(v); } catch { throw new Refusal(`${where}: invalid pattern`); }
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Read a trusted JSON input: a regular file (no link), this user's, not writable by group or other, size-capped.
function readJson(file, max = MAX_INPUT) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return { missing: true }; throw new Refusal(`${file}: unreadable`); }
  if (!st.isFile()) throw new Refusal(`${file}: not a regular file`);
  if (st.size > max) throw new Refusal(`${file}: larger than ${max} bytes`);
  if (!WINDOWS) {
    if (st.uid !== process.getuid()) throw new Refusal(`${file}: not owned by this user`);
    if (st.mode & 0o022) throw new Refusal(`${file}: writable by group or other`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const again = fs.fstatSync(fd);
    if (again.ino !== st.ino || again.dev !== st.dev || again.size > max) throw new Refusal(`${file}: changed while reading`);
    const text = fs.readFileSync(fd, "utf8");
    try { return { value: JSON.parse(text), text }; } catch { throw new Refusal(`${file}: not valid JSON`); }
  } finally { fs.closeSync(fd); }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // On Windows a rename over a file another process has open (a reader of state.json) fails for that moment.
  for (let i = 0; ; i++) {
    try { fs.renameSync(temp, file); return; } catch (e) {
      if (!WINDOWS || !["EPERM", "EACCES", "EBUSY"].includes(e.code) || i >= 50) { fs.rmSync(temp, { force: true }); throw e; }
      sleepMs(100);
    }
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------- locations ----------

function fleetDir() {
  const env = process.env.LOADOUT_FLEET;
  if (env) {
    if (!fs.existsSync(env)) throw new Refusal(`LOADOUT_FLEET ${env} does not exist`);
    return env;
  }
  if (WINDOWS) return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "loadout", "fleet");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "loadout", "fleet");
}

function stateDir() {
  if (WINDOWS) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "loadout", "auto-update");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "loadout", "auto-update");
}

// ---------- registry ----------

function validateWindow(w, where) {
  exactKeys(w, where, ["tz", "days", "start", "end"]);
  str(w.tz, `${where}.tz`);
  try { new Intl.DateTimeFormat("en-US", { timeZone: w.tz }); } catch { throw new Refusal(`${where}.tz: unknown time zone`); }
  if (!Array.isArray(w.days) || !w.days.length || w.days.some((d) => !DAYS.includes(d))) throw new Refusal(`${where}.days: use sun..sat`);
  str(w.start, `${where}.start`, HHMM_RE);
  str(w.end, `${where}.end`, END_RE);
  if (w.end <= w.start) throw new Refusal(`${where}: end must be after start on the same day`);
}

const CHECK_PLACEHOLDERS = new Set(["adapters", "component", "host", "node"]);

function validateArgv(a, where, allowed = PLACEHOLDERS) {
  if (!Array.isArray(a) || !a.length || a.some((x) => typeof x !== "string" || !x.length || x.length > 4096)) {
    throw new Refusal(`${where}: argv must be a non-empty list of strings`);
  }
  for (const x of a) {
    for (const m of x.matchAll(/\{([^}]*)\}/g)) if (!allowed.has(m[1])) throw new Refusal(`${where}: placeholder {${m[1]}} not allowed here`);
  }
  if (/\.(cmd|bat)$/i.test(a[0])) throw new Refusal(`${where}: run .cmd/.bat through powershell.exe -File, not directly`);
}

function validateRegistry(r) {
  exactKeys(r, "registry", ["schema", "feed", "notify", "hosts", "components"], ["blackouts", "notes"]);
  if (r.schema !== REGISTRY_SCHEMA) throw new Refusal(`registry.schema: expected ${REGISTRY_SCHEMA}`);
  exactKeys(r.feed, "registry.feed", ["path", "max_age_hours"], ["source_host"]);
  str(r.feed.path, "registry.feed.path");
  num(r.feed.max_age_hours, "registry.feed.max_age_hours", 1, 168);
  exactKeys(r.notify, "registry.notify", ["command", "labels"], ["host"]);
  validateArgv(r.notify.command, "registry.notify.command");
  if (!Array.isArray(r.notify.labels) || !r.notify.labels.length || r.notify.labels.some((l) => !/^[a-z0-9._-]+=[A-Za-z0-9._-]+$/.test(l))) {
    throw new Refusal("registry.notify.labels: key=value strings");
  }
  if (r.notify.host !== undefined) str(r.notify.host, "registry.notify.host", /^ssh:\/\/[A-Za-z0-9._-]+$/);
  for (const [i, b] of (r.blackouts || []).entries()) validateWindow(b, `registry.blackouts[${i}]`);
  if (!isObj(r.hosts) || !Object.keys(r.hosts).length) throw new Refusal("registry.hosts: at least one host");
  if (r.feed.source_host !== undefined && !r.hosts[r.feed.source_host]) throw new Refusal("registry.feed.source_host: not in registry.hosts");
  for (const [name, h] of Object.entries(r.hosts)) {
    const where = `registry.hosts.${name}`;
    if (!HOST_RE.test(name)) throw new Refusal(`${where}: invalid host name`);
    exactKeys(h, where, ["os", "tz", "allow"], ["preconditions", "deny_tiers", "notify_host", "notify_command", "ssh"]);
    if (h.notify_command !== undefined) validateArgv(h.notify_command, `${where}.notify_command`, new Set(["node"]));
    // A process started without a shell cannot run a .cmd shim; on Windows the notifier is node or a real .exe.
    const notifyArgv0 = (h.notify_command || r.notify.command)[0];
    if (h.os === "windows" && notifyArgv0 !== "{node}" && !/\.exe$/i.test(notifyArgv0)) {
      throw new Refusal(`${where}.notify_command: on Windows give {node} with the CLI's script, or an .exe`);
    }
    if (h.ssh !== undefined) str(h.ssh, `${where}.ssh`, /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/);
    if (h.notify_host !== undefined) str(h.notify_host, `${where}.notify_host`, /^ssh:\/\/[A-Za-z0-9._-]+$/);
    if (!OSES.includes(h.os)) throw new Refusal(`${where}.os: macos, linux or windows`);
    validateWindow({ tz: h.tz, days: ["sun"], start: "00:00", end: "00:01" }, `${where}.tz`);
    if (!Array.isArray(h.allow) || h.allow.some((c) => !ID_RE.test(c))) throw new Refusal(`${where}.allow: component ids`);
    for (const [i, p] of (h.preconditions || []).entries()) {
      const pw = `${where}.preconditions[${i}]`;
      exactKeys(p, pw, ["name", "argv", "max_age_seconds"], ["timeout_seconds"]);
      str(p.name, `${pw}.name`, ID_RE);
      validateArgv(p.argv, `${pw}.argv`, new Set(["adapters", "node"]));
      num(p.max_age_seconds, `${pw}.max_age_seconds`, 1, 3600);
      if (p.timeout_seconds !== undefined) num(p.timeout_seconds, `${pw}.timeout_seconds`, 1, 300);
    }
    if (h.deny_tiers !== undefined && (!Array.isArray(h.deny_tiers) || h.deny_tiers.some((t) => ![1, 2, 3].includes(t)))) {
      throw new Refusal(`${where}.deny_tiers: tiers 1..3`);
    }
  }
  if (!Array.isArray(r.components)) throw new Refusal("registry.components: a list");
  const seen = new Set();
  for (const [i, c] of r.components.entries()) {
    const where = `registry.components[${i}]`;
    exactKeys(c, where, ["component", "tier", "mode", "hosts", "version_pattern", "bounds", "window", "soak_hours", "adapters"],
      ["host_windows", "security_soak_hours", "canary", "watchdog_seconds", "exclusive_group", "require_digest", "timeouts", "notes"]);
    if (c.require_digest !== undefined && typeof c.require_digest !== "boolean") throw new Refusal(`${where}.require_digest: true or false`);
    str(c.component, `${where}.component`, ID_RE);
    if (seen.has(c.component)) throw new Refusal(`${where}: duplicate component ${c.component}`);
    seen.add(c.component);
    if (![1, 2].includes(c.tier)) throw new Refusal(`${where}.tier: only tiers 1 and 2 may be automatic`);
    if (!["apply", "hold", "observe"].includes(c.mode)) throw new Refusal(`${where}.mode: apply, hold or observe`);
    // No Homebrew rollout or rollback is proven yet, so formula rows can only be held or observed, whatever their id.
    const brew = c.component.startsWith("brew.") || Object.values(c.adapters || {}).some((a) => isObj(a) &&
      [...((isObj(a.check) && Array.isArray(a.check.argv)) ? a.check.argv : []), ...Object.values(a).flat(2)].some((x) => typeof x === "string" && /(^|[\\/])(brew|brew-formula\.sh)$/.test(x)));
    if (brew && c.mode === "apply") throw new Refusal(`${where}.mode: Homebrew rows stay hold or observe until a rollback is proven`);
    if (PROTECTED.includes(c.component) && c.mode === "apply") throw new Refusal(`${where}.mode: ${c.component} is shared by every agent on the host; never automatic`);
    if (!Array.isArray(c.hosts) || !c.hosts.length) throw new Refusal(`${where}.hosts: at least one host`);
    for (const h of c.hosts) {
      const host = r.hosts[h];
      if (!host) throw new Refusal(`${where}.hosts: ${h} is not in registry.hosts`);
      if (!host.allow.includes(c.component)) throw new Refusal(`${where}.hosts: ${h} does not allow ${c.component}`);
      if ((host.deny_tiers || []).includes(c.tier)) throw new Refusal(`${where}.hosts: ${h} denies tier ${c.tier}`);
    }
    regex(c.version_pattern, `${where}.version_pattern`);
    exactKeys(c.bounds, `${where}.bounds`, ["max_bump"], ["deny"]);
    if (!["patch", "minor", "major"].includes(c.bounds.max_bump)) throw new Refusal(`${where}.bounds.max_bump: patch, minor or major`);
    for (const [j, d] of (c.bounds.deny || []).entries()) regex(d, `${where}.bounds.deny[${j}]`);
    validateWindow(c.window, `${where}.window`);
    for (const [h, w] of Object.entries(c.host_windows || {})) {
      if (!c.hosts.includes(h)) throw new Refusal(`${where}.host_windows: ${h} is not one of its hosts`);
      validateWindow(w, `${where}.host_windows.${h}`);
    }
    num(c.soak_hours, `${where}.soak_hours`, 0, 24 * 60);
    if (c.security_soak_hours !== undefined) num(c.security_soak_hours, `${where}.security_soak_hours`, 0, c.soak_hours);
    if (c.canary !== undefined) {
      exactKeys(c.canary, `${where}.canary`, ["host", "receipt", "max_age_hours"]);
      if (!c.hosts.includes(c.canary.host)) throw new Refusal(`${where}.canary.host: must be one of its hosts`);
      str(c.canary.receipt, `${where}.canary.receipt`);
      num(c.canary.max_age_hours, `${where}.canary.max_age_hours`, 1, 24 * 30);
    }
    if (c.watchdog_seconds !== undefined) {
      num(c.watchdog_seconds, `${where}.watchdog_seconds`, 10, 6 * 3600);
      // The timer must outlast a transaction that is still working (apply, every health step, the version check),
      // so it only ever fires for one that is stuck or gone. Its stop-and-restore needs POSIX process groups.
      if (c.adapters && c.adapters.windows) throw new Refusal(`${where}: a rollback watchdog is POSIX only`);
      const t = { check: 30, apply: 600, health: 300, ...(c.timeouts || {}) };
      const need = Math.max(0, ...Object.values(c.adapters || {}).map((a) => t.apply + ((a && a.health) || []).length * t.health + t.check)) + WATCHDOG_MARGIN_S;
      if (c.watchdog_seconds < need) throw new Refusal(`${where}.watchdog_seconds: at least ${need} (apply, health and check timeouts and a margin)`);
    }
    if (c.tier === 2 && !c.watchdog_seconds) throw new Refusal(`${where}: tier 2 needs watchdog_seconds (self-rollback timer)`);
    if (c.tier === 2 && !c.exclusive_group) throw new Refusal(`${where}: tier 2 needs an exclusive_group`);
    if (c.exclusive_group !== undefined) str(c.exclusive_group, `${where}.exclusive_group`, ID_RE);
    if (c.timeouts !== undefined) {
      exactKeys(c.timeouts, `${where}.timeouts`, [], STEPS);
      for (const [k, v] of Object.entries(c.timeouts)) num(v, `${where}.timeouts.${k}`, 1, 3600);
    }
    if (!isObj(c.adapters) || !Object.keys(c.adapters).length) throw new Refusal(`${where}.adapters: at least one OS`);
    for (const [o, a] of Object.entries(c.adapters)) {
      const aw = `${where}.adapters.${o}`;
      if (!OSES.includes(o)) throw new Refusal(`${aw}: unknown OS`);
      exactKeys(a, aw, ["check"], ["stage", "precheck", "apply", "health", "rollback"]);
      exactKeys(a.check, `${aw}.check`, ["argv", "regex"]);
      validateArgv(a.check.argv, `${aw}.check.argv`, CHECK_PLACEHOLDERS);
      regex(a.check.regex, `${aw}.check.regex`);
      for (const s of ["stage", "precheck", "health"]) {
        if (a[s] === undefined) continue;
        if (!Array.isArray(a[s])) throw new Refusal(`${aw}.${s}: a list of argv`);
        a[s].forEach((x, j) => validateArgv(x, `${aw}.${s}[${j}]`));
      }
      for (const s of ["apply", "rollback"]) if (a[s] !== undefined) validateArgv(a[s], `${aw}.${s}`);
      if (c.mode === "apply" && (!a.apply || !a.rollback || !a.health || !a.health.length)) {
        throw new Refusal(`${aw}: mode apply needs apply, health and rollback`);
      }
    }
    for (const h of c.hosts) {
      if (c.mode === "apply" && !c.adapters[r.hosts[h].os]) throw new Refusal(`${where}: no ${r.hosts[h].os} adapter for ${h}`);
    }
    if (c.adapters.windows && worstCaseSeconds(c, c.adapters.windows) > WINDOWS_TXN_MAX_SECONDS) {
      throw new Refusal(`${where}: a windows transaction could outlast the scheduler task's ${WINDOWS_TXN_MAX_SECONDS / 3600} h limit`);
    }
  }
  return r;
}

// Longest a transaction and its watchdog can run with these timeouts (the same defaults as startTransaction).
function worstCaseSeconds(row, a) {
  const t = { check: 30, stage: 900, precheck: 300, apply: 600, health: 300, rollback: 600, ...(row.timeouts || {}) };
  const n = (s) => (a[s] || []).length;
  const before = n("stage") * t.stage + n("precheck") * t.precheck;
  const after = Math.max(t.apply + n("health") * t.health + t.check, row.watchdog_seconds || 0) + t.rollback + t.check;
  return before + after + 60;
}

// ---------- switch, feed, receipts ----------

function readSwitch(fleet, state) {
  if (fs.existsSync(path.join(state, "STOP"))) return { allowed: false, why: "local STOP file" };
  let doc;
  try { doc = readJson(path.join(fleet, "auto-update", "switch.json")); } catch (e) { return { allowed: false, why: `switch unreadable: ${e.message}` }; }
  if (doc.missing) return { allowed: false, why: "switch.json missing" };
  const s = doc.value;
  if (!isObj(s) || Object.keys(s).some((k) => !["schema", "apply", "notes"].includes(k)) || s.schema !== SWITCH_SCHEMA) {
    return { allowed: false, why: "switch.json invalid" };
  }
  if (s.apply !== "allowed") return { allowed: false, why: `switch apply=${JSON.stringify(s.apply)}` };
  return { allowed: true, why: "allowed" };
}

function validateFeed(f, now, maxAgeHours) {
  exactKeys(f, "feed", ["schema", "generated_at", "publisher", "components"]);
  if (f.schema !== FEED_SCHEMA) throw new Refusal(`feed.schema: expected ${FEED_SCHEMA}`);
  const gen = parseTs(f.generated_at, "feed.generated_at");
  if (gen > now + FUTURE_SLACK_MS) throw new Refusal("feed.generated_at: in the future");
  if (now - gen > maxAgeHours * 3600e3) throw new Refusal(`feed stale: generated ${f.generated_at}`);
  str(f.publisher, "feed.publisher", /^[a-z0-9-]{1,32}$/);
  if (!isObj(f.components)) throw new Refusal("feed.components: an object");
  const out = {};
  for (const [id, e] of Object.entries(f.components)) {
    const where = `feed.components.${id}`;
    if (!ID_RE.test(id)) throw new Refusal(`${where}: invalid component id`);
    exactKeys(e, where, ["version", "first_seen_at", "security"], ["by_os", "digest"]);
    str(e.version, `${where}.version`, VERSION_RE);
    const seen = parseTs(e.first_seen_at, `${where}.first_seen_at`);
    if (seen > gen) throw new Refusal(`${where}.first_seen_at: after generated_at`);
    if (typeof e.security !== "boolean") throw new Refusal(`${where}.security: true or false`);
    if (e.by_os !== undefined) {
      exactKeys(e.by_os, `${where}.by_os`, [], OSES);
      for (const [o, v] of Object.entries(e.by_os)) str(v, `${where}.by_os.${o}`, VERSION_RE);
    }
    if (e.digest !== undefined) str(e.digest, `${where}.digest`, DIGEST_RE);
    out[id] = { ...e, first_seen_ms: seen };
  }
  return out;
}

// ---------- relay copies (feed and canary receipts from the publishing host) ----------

const relayFile = (state, name) => path.join(state, "relay", ...(name === "feed" ? ["available.json"] : ["canary", `${name.slice(7)}.json`]));
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// A relay copy carries the original file's exact bytes, which host made it and which host it is for. It is read only
// when it is for this host, from the expected source, and intact; then the original is validated as usual.
function readRelay(state, name, kind, source, host, max) {
  const doc = readJson(relayFile(state, name), 2 * max + 4096);
  if (doc.missing) return { missing: true };
  const w = doc.value;
  exactKeys(w, "relay", ["schema", "kind", "source_host", "for_host", "sent_at", "sha256", "data"]);
  if (w.schema !== RELAY_SCHEMA || w.kind !== kind) throw new Refusal("relay copy: wrong schema or kind");
  if (w.source_host !== source) throw new Refusal("relay copy: from another host than the expected source");
  if (w.for_host !== host) throw new Refusal("relay copy: made for another host");
  parseTs(w.sent_at, "relay.sent_at");
  if (typeof w.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(w.data)) throw new Refusal("relay copy: data not base64");
  const bytes = Buffer.from(w.data, "base64");
  if (bytes.length > max) throw new Refusal("relay copy: too large");
  if (typeof w.sha256 !== "string" || sha256hex(bytes) !== w.sha256) throw new Refusal("relay copy: digest mismatch");
  try { return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }; } catch { throw new Refusal("relay copy: data not JSON"); }
}

// The publishing host (feed.source_host, or every host when none is named) reads the feed file itself; every other
// host reads only its relay copy.
function readFeed(ctx) {
  const { registry, now, host, state } = ctx;
  const source = registry.feed.source_host;
  try {
    const doc = source && source !== host
      ? readRelay(state, "feed", "feed", source, host, MAX_FEED)
      : readJson(expandHome(registry.feed.path), MAX_FEED);
    if (doc.missing) return { error: "feed missing" };
    return { components: validateFeed(doc.value, now, registry.feed.max_age_hours) };
  } catch (e) {
    return { error: e instanceof Refusal ? e.message : "feed unreadable" };
  }
}

// Strict check of one receipt document; returns null when it is valid, else why not.
function receiptProblem(r, component, host, now, maxAgeHours) {
  exactKeys(r, "receipt", ["schema", "component", "version", "host", "result", "finished_at", "txn"]);
  if (r.schema !== RECEIPT_SCHEMA) throw new Refusal("receipt.schema");
  str(r.txn, "receipt.txn", TXN_RE);
  const at = parseTs(r.finished_at, "receipt.finished_at");
  if (r.component !== component || r.host !== host) return "canary receipt is for another component or host";
  if (!["pass", "fail"].includes(r.result)) return "canary receipt result invalid";
  str(r.version, "receipt.version", VERSION_RE);
  if (at > now + FUTURE_SLACK_MS) return "canary receipt in the future";
  if (now - at > maxAgeHours * 3600e3) return "canary receipt too old";
  return null;
}

// Another host than the canary reads the canary's receipt only from its relay copy.
function checkReceipt(canary, component, version, ctx) {
  let doc;
  try { doc = readRelay(ctx.state, `canary/${component}`, "receipt", canary.host, ctx.host, MAX_INPUT); } catch (e) { return `canary receipt rejected: ${e.message}`; }
  if (doc.missing) return "canary receipt missing";
  const r = doc.value;
  try {
    const bad = receiptProblem(r, component, canary.host, ctx.now, canary.max_age_hours);
    if (bad) return bad;
    if (r.version !== version) return `canary proved ${String(r.version).slice(0, 64)}, not ${version}`;
    if (r.result !== "pass") return `canary result ${JSON.stringify(String(r.result).slice(0, 16))}`;
    return null;
  } catch (e) {
    return `canary receipt rejected: ${e.message}`;
  }
}

// ---------- versions and windows ----------

function parts(v) {
  const core = v.split(/[+-]/)[0].split(/[._]/);
  return core.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
}

function compare(a, b) {
  const pa = parts(a), pb = parts(b);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a === b ? 0 : null; // equal cores but different suffixes: not comparable
}

function bumpOk(installed, candidate, max) {
  const a = parts(installed), b = parts(candidate);
  if (max === "major") return true;
  if (a[0] !== b[0]) return false;
  return max === "minor" || a[1] === b[1];
}

function localTime(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: p.weekday.slice(0, 3).toLowerCase(), hhmm: `${p.hour}:${p.minute}`, date: `${p.year}-${p.month}-${p.day}` };
}

function inWindow(ms, w) {
  const t = localTime(ms, w.tz);
  return w.days.includes(t.day) && t.hhmm >= w.start && t.hhmm < w.end;
}

// ---------- commands ----------

// {node} is the Node running this runner, so probes and adapters written in JS need no PATH lookup.
function fill(argv, given) {
  const vars = { node: process.execPath, ...given };
  return argv.map((x, i) => {
    const out = x.replace(/\{([a-z]+)\}/g, (_, k) => {
      if (vars[k] === undefined) throw new Refusal(`placeholder {${k}} has no value here`);
      return vars[k];
    });
    return i === 0 || out.startsWith("~") ? expandHome(out) : out;
  });
}

// Exit 75 (EX_TEMPFAIL) from a stage, precheck or apply step means "not now, nothing changed" (for example a CLI
// process is running): the attempt is dropped without a hold or an alert and the next scheduled run decides again.
const NOT_NOW = 75;

// Schedulers start with a bare PATH; put this Node (and the npm beside it) first so adapters find both.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
const STEP_ENV = { ...process.env, [PATH_KEY]: [path.dirname(process.execPath), process.env[PATH_KEY] || ""].join(path.delimiter), DISABLE_AUTOUPDATER: "1" };

function runArgv(argv, timeoutSeconds, log) {
  const done = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: timeoutSeconds * 1000, windowsHide: true, maxBuffer: 4 << 20, env: STEP_ENV });
  if (log) {
    const tail = (s) => (s || "").slice(-4000);
    log(`$ ${argv.map((a) => JSON.stringify(a)).join(" ")}\nexit=${done.status} signal=${done.signal || ""}${done.error ? ` error=${done.error.code}` : ""}\n${tail(done.stdout)}${tail(done.stderr)}`);
  }
  return { ok: done.status === 0 && !done.error, stdout: done.stdout || "", status: done.status, error: done.error && done.error.code };
}

function installedVersion(adapter, vars, timeouts) {
  const r = runArgv(fill(adapter.check.argv, vars), (timeouts && timeouts.check) || 30);
  if (!r.ok) return { error: `check failed (${r.error || `exit ${r.status}`})` };
  const re = new RegExp(adapter.check.regex);
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m && m[1] && INSTALLED_RE.test(m[1])) return { version: m[1] };
  }
  return { error: "check output did not match" };
}

// One host gate reading. A probe prints one JSON line {ok, observed_at, detail?, counters?, identity?}; anything
// missing, late, malformed or stale is "unknown" and closes the gate. Only counts and short codes are kept.
function probe(p, now) {
  const r = runArgv(fill(p.argv, { adapters: ADAPTERS }), p.timeout_seconds || 30);
  const no = (why) => ({ why: `precondition ${p.name}: ${why}` });
  if (!r.ok) return no(`probe failed (${r.error || `exit ${r.status}`})`);
  let v;
  try { v = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { return no("probe output not JSON"); }
  if (!isObj(v) || typeof v.ok !== "boolean") return no("probe output invalid");
  let at;
  try { at = parseTs(v.observed_at, "observed_at"); } catch { return no("no valid observed_at"); }
  if (at > now + 60e3 || now - at > p.max_age_seconds * 1000) return no("reading stale");
  const detail = typeof v.detail === "string" ? v.detail.replace(/[^\w .,:%/<>=+-]/g, "").slice(0, 120) : "";
  // A few plain numbers (load per core, free memory, active agents) kept with the gate samples.
  const metrics = isObj(v.metrics) ? Object.fromEntries(Object.entries(v.metrics)
    .filter(([k, x]) => /^[a-z][a-z0-9_]{0,23}$/.test(k) && Number.isFinite(x)).slice(0, 8).map(([k, x]) => [k, Math.round(x * 100) / 100])) : {};
  if (!v.ok) return { why: `precondition ${p.name}: not met${detail ? ` (${detail})` : ""}`, metrics };
  return { why: null, metrics };
}

// Every host gate, all evaluated so a sample names every blocker.
function evalGates(hostRow, registry, now) {
  const blocked = [];
  const metrics = {};
  if ((registry.blackouts || []).some((b) => inWindow(now, b))) blocked.push({ name: "blackout", why: "blackout" });
  for (const p of hostRow.preconditions || []) {
    const r = probe(p, now);
    if (r.metrics && Object.keys(r.metrics).length) metrics[p.name] = r.metrics;
    if (r.why) blocked.push({ name: p.name, why: r.why });
  }
  const idle = blocked.filter((b) => b.name !== "blackout");
  return { open: !blocked.length, idleOpen: !idle.length, why: idle.map((b) => b.why).join("; "), blocked, metrics };
}

// ---------- gate samples ----------

function loadGates(dir) {
  const doc = readJson(path.join(dir, "gates.json"), 4 << 20);
  const ok = !doc.missing && isObj(doc.value) && doc.value.schema === GATES_SCHEMA && isObj(doc.value.days);
  return ok ? { schema: GATES_SCHEMA, days: doc.value.days } : { schema: GATES_SCHEMA, days: {} };
}

// Per local day: samples, open samples, closed->open and open->closed transitions, blocker counts and a compact tick
// list [HH:MM, open, blockers, metrics]. Gate names, short codes and plain numbers only: no agent names,
// processes, paths or log text.
function recordSample(dir, hostRow, now, gates, stored) {
  const t = localTime(now, hostRow.tz);
  const days = stored.days;
  const prevKey = Object.keys(days).sort().pop();
  const wasOpen = prevKey ? days[prevKey].last_open : null;
  const day = days[t.date] || (days[t.date] = { samples: 0, open: 0, opened: 0, closed: 0, last_open: null, first_at: iso(now), last_at: null, blocked: {}, ticks: [] });
  day.samples += 1;
  if (gates.open) day.open += 1;
  if (wasOpen === false && gates.open) day.opened += 1;
  if (wasOpen === true && !gates.open) day.closed += 1;
  day.last_open = gates.open;
  day.last_at = iso(now);
  for (const b of gates.blocked) {
    const code = `${b.name}: ${b.why.replace(/^precondition [^:]+: /, "").replace(/\(.*\)/, "").replace(/[0-9]+(\.[0-9]+)?/g, "#").trim()}`;
    day.blocked[code] = (day.blocked[code] || 0) + 1;
  }
  day.ticks.push([t.hhmm, gates.open ? 1 : 0, gates.blocked.map((b) => b.name).join(","), gates.metrics]);
  day.ticks = day.ticks.slice(-400);
  for (const k of Object.keys(days).sort().slice(0, -GATE_DAYS_KEPT)) delete days[k];
  writeAtomic(path.join(dir, "gates.json"), JSON.stringify(stored) + "\n");
}

// ---------- state ----------

function emptyState() { return { schema: STATE_SCHEMA, attempts: {}, applied: [], alerts: {} }; }

function loadState(dir) {
  const doc = readJson(path.join(dir, "state.json"), 4 << 20);
  if (doc.missing) return emptyState();
  const s = doc.value;
  if (!isObj(s) || s.schema !== STATE_SCHEMA || !isObj(s.attempts) || !Array.isArray(s.applied) || !isObj(s.alerts)) {
    throw new Refusal("state.json invalid; refusing to act (inspect and repair it by hand)");
  }
  return s;
}

// Short read-modify-write of state.json under a mkdir mutex, so the runner, a transaction and its watchdog never
// lose each other's records.
function updateState(dir, fn) {
  const mutex = path.join(dir, "state.mutex");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const until = Date.now() + 15000;
  for (;;) {
    try { fs.mkdirSync(mutex); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(mutex).mtimeMs > 60000) { fs.rmdirSync(mutex); continue; } } catch {}
      if (Date.now() > until) throw new Refusal("state mutex busy");
      sleepMs(50);
    }
  }
  try {
    const s = loadState(dir);
    const out = fn(s);
    writeAtomic(path.join(dir, "state.json"), JSON.stringify(s, null, 2) + "\n");
    return out;
  } finally { fs.rmdirSync(mutex); }
}

const attemptKey = (host, component, version) => `${host}/${component}@${version}`;

// ---------- processes ----------

// A recorded process is {pid, marks}. It counts as running only while that PID runs a command line holding every
// mark (this runner's path, its subcommand, its transaction directory), so a PID the system has since handed to
// another process, after a restart say, does not hold anything. A command line that cannot be read counts as
// running: a live transaction is never taken over on a guess (the lock-age alert covers a lock that never clears).
const procRecord = (pid, marks) => ({ pid, marks });
const bootMs = () => Math.round(Date.now() - os.uptime() * 1000);

function commandLine(pid) {
  try {
    if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    const r = WINDOWS
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", timeout: 30000, windowsHide: true })
      : spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10000 });
    if (r.error || (WINDOWS && r.status !== 0)) return null;
    return r.status === 0 ? r.stdout.trim() : "";
  } catch (e) {
    return e.code === "ENOENT" ? "" : null;
  }
}

// "yes", "no" or "unknown".
function procState(rec) {
  if (Number.isInteger(rec)) rec = { pid: rec }; // an older record: a PID only
  if (!rec || !alive(rec.pid)) return "no";
  if (!Array.isArray(rec.marks) || !rec.marks.length) return "unknown";
  const line = commandLine(rec.pid);
  if (line === null) return "unknown";
  return line && rec.marks.every((m) => line.includes(m)) ? "yes" : "no";
}
const running = (rec) => procState(rec) !== "no";

// The host lock: a directory holding owner.json with every process that may still act (runner, transaction, watchdog).
function lockOwners(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, "lock", "owner.json"), "utf8"));
    return isObj(o) ? { procs: Array.isArray(o.procs) ? o.procs : Array.isArray(o.pids) ? o.pids : [], at: o.at } : null;
  } catch { return null; }
}

function acquireLock(dir, me) {
  const lock = path.join(dir, "lock");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      setLockProcs(dir, [me]);
      return { ok: true };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = lockOwners(dir);
      if (owner) {
        const states = owner.procs.map(procState);
        if (states.includes("yes") || states.includes("unknown")) return { ok: false, since: owner.at, unverified: !states.includes("yes") };
      } else {
        let age = Infinity;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
        if (age < STALE_LOCK_MS) return { ok: false }; // being created right now
      }
      const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
      try { fs.renameSync(lock, aside); fs.rmSync(aside, { recursive: true, force: true }); } catch { return { ok: false }; }
    }
  }
  return { ok: false };
}

function setLockProcs(dir, procs) {
  writeAtomic(path.join(dir, "lock", "owner.json"), JSON.stringify({ procs, at: iso(Date.now()) }));
}

// Hand the lock to whichever of the others still run, or release it.
function leaveLock(dir) {
  const owners = lockOwners(dir);
  const rest = owners ? owners.procs.filter((p) => (Number.isInteger(p) ? p : p && p.pid) !== process.pid && running(p)) : [];
  if (rest.length) setLockProcs(dir, rest); else releaseLock(dir);
}

function releaseLock(dir) {
  const lock = path.join(dir, "lock");
  const aside = `${lock}.done-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try { fs.renameSync(lock, aside); fs.rmSync(aside, { recursive: true, force: true }); } catch {}
}

// ---------- notify ----------

let notifyFrom = null; // this host's name, for its notify_host

// One line to the owning PM, resolved by labels at send time; exactly one match or nothing is sent.
function sendLine(registry, line) {
  const n = registry.notify;
  const via = (notifyFrom && registry.hosts[notifyFrom] && registry.hosts[notifyFrom].notify_host) || n.host;
  const host = via ? ["--host", via] : [];
  const own = notifyFrom && registry.hosts[notifyFrom] && registry.hosts[notifyFrom].notify_command;
  const base = fill(own || n.command, {});
  const ls = runArgv([...base, "ls", ...n.labels.flatMap((l) => ["--label", l]), "--json", ...host], 30);
  if (!ls.ok) return false;
  let agents;
  try { agents = JSON.parse(ls.stdout); } catch { return false; }
  if (!Array.isArray(agents) || agents.length !== 1 || typeof agents[0].id !== "string") return false;
  return runArgv([...base, "send", "--no-wait", ...host, agents[0].id, line], 60).ok;
}

// Record an alert once per key and deliver it; an undelivered alert is retried once on the next scheduled run.
function alert(dir, registry, key, line) {
  const fresh = updateState(dir, (s) => {
    const a = s.alerts[key];
    if (a && a.line === line) return false;
    s.alerts[key] = { line, at: iso(Date.now()), delivered: false };
    return true;
  });
  if (fresh) deliver(dir, registry, key);
}

function deliver(dir, registry, key) {
  const line = updateState(dir, (s) => (s.alerts[key] && !s.alerts[key].delivered ? s.alerts[key].line : null));
  if (!line) return;
  const ok = sendLine(registry, line);
  updateState(dir, (s) => { if (s.alerts[key] && s.alerts[key].line === line) { s.alerts[key].delivered = ok; s.alerts[key].tried = iso(Date.now()); } });
}

// ---------- decisions ----------

function context(args, mode) {
  const fixedNow = args.now !== undefined;
  const now = fixedNow ? parseTs(args.now, "--now") : Date.now();
  const fleet = fleetDir();
  const state = stateDir();
  const regDoc = readJson(path.join(fleet, "auto-update", "registry.json"));
  if (regDoc.missing) throw new Refusal("registry.json missing");
  const registry = validateRegistry(regDoc.value);
  const host = args.host;
  if (!host || !HOST_RE.test(host)) throw new Refusal("--host <name> required");
  const hostRow = registry.hosts[host];
  if (!hostRow) throw new Refusal(`host ${host} is not in the registry`);
  notifyFrom = host;
  if (hostRow.os !== OS_NAME) throw new Refusal(`host ${host} is ${hostRow.os} in the registry but this is ${OS_NAME}`);
  return { now, fixedNow, fleet, state, registry, host, hostRow, mode };
}

function decide(ctx, st, sw, feed, gates) {
  const { registry, host, hostRow, now } = ctx;
  const rows = registry.components.filter((c) => c.hosts.includes(host)).sort((a, b) => a.tier - b.tier);
  const today = localTime(now, hostRow.tz).date;
  const exclusiveToday = new Map();
  // Any attempt today counts, failed or rolled back too: each one disrupted the access path.
  for (const a of [...st.applied, ...Object.values(st.attempts)]) {
    if (a.host === host && a.group && a.local_date === today) exclusiveToday.set(a.group, a.component);
  }
  const out = [];
  for (const row of rows) {
    const line = { component: row.component, host, tier: row.tier, mode: row.mode, installed: null, candidate: null, decision: "skip", reason: "" };
    out.push(line);
    const adapter = row.adapters[hostRow.os];
    if (!adapter) { line.reason = `unsupported on ${hostRow.os}`; continue; }
    const got = installedVersion(adapter, { adapters: ADAPTERS, component: row.component, host }, row.timeouts);
    line.installed = got.version || null;
    if (row.mode === "observe") { line.decision = "observe"; line.reason = got.error || "observe only"; continue; }
    if (feed.error) { line.reason = feed.error; continue; }
    const entry = feed.components[row.component];
    if (!entry) { line.reason = "no feed entry"; continue; }
    const candidate = (entry.by_os && entry.by_os[hostRow.os]) || entry.version;
    line.candidate = candidate;
    if (!new RegExp(row.version_pattern).test(candidate)) { line.reason = "bound: candidate does not match version_pattern"; continue; }
    if (row.require_digest && !entry.digest) { line.reason = "bound: feed gives no image digest"; continue; }
    if (got.error) { line.reason = got.error; continue; }
    if (got.version === candidate) { line.decision = "current"; line.reason = "installed equals candidate"; continue; }
    const cmp = compare(got.version, candidate);
    if (cmp === null) { line.reason = "bound: versions not comparable"; continue; }
    if (cmp > 0) { line.reason = "bound: candidate older than installed (no downgrade)"; continue; }
    if (!bumpOk(got.version, candidate, row.bounds.max_bump)) { line.reason = `bound: bump beyond ${row.bounds.max_bump}`; continue; }
    if ((row.bounds.deny || []).some((d) => new RegExp(d).test(candidate))) { line.reason = "bound: denied version"; continue; }
    const held = st.attempts[attemptKey(host, row.component, candidate)];
    if (held) { line.reason = `held: earlier attempt ${held.status}`; continue; }
    if (row.mode === "hold") { line.reason = "mode hold"; continue; }
    const soak = (entry.security && row.security_soak_hours !== undefined ? row.security_soak_hours : row.soak_hours) * 3600e3;
    if (now - entry.first_seen_ms < soak) { line.reason = `soaking until ${iso(entry.first_seen_ms + soak)}`; continue; }
    if (row.canary && row.canary.host !== host) {
      const bad = checkReceipt(row.canary, row.component, candidate, ctx);
      if (bad) { line.reason = bad; continue; }
    }
    if (!sw.allowed) { line.reason = `kill switch: ${sw.why}`; continue; }
    const blackout = (registry.blackouts || []).find((b) => inWindow(now, b));
    if (blackout) { line.reason = "blackout"; continue; }
    const w = (row.host_windows && row.host_windows[host]) || row.window;
    if (!inWindow(now, w)) { line.reason = "outside window"; continue; }
    if (row.exclusive_group && exclusiveToday.has(row.exclusive_group)) {
      line.reason = `exclusive: ${exclusiveToday.get(row.exclusive_group)} already applied on ${host} today`; continue;
    }
    if (!gates.idleOpen) { line.reason = gates.why; continue; }
    line.decision = "would-apply";
    line.reason = row.canary && row.canary.host === host ? "canary host: precheck proves the exact version" : "all gates passed";
    line._row = row;
    line._installed = got.version;
    line._candidate = candidate;
    line._digest = entry.digest || "";
  }
  return out;
}

function publicLine(l) {
  const { _row, _installed, _candidate, _digest, ...rest } = l;
  return rest;
}

function cmdPlan(args) {
  const ctx = context(args, "plan");
  const sw = readSwitch(ctx.fleet, ctx.state);
  let st;
  try { st = loadState(ctx.state); } catch (e) { st = emptyState(); console.log(JSON.stringify({ warning: e.message })); }
  const feed = readFeed(ctx);
  const gates = evalGates(ctx.hostRow, ctx.registry, ctx.now);
  console.log(JSON.stringify({ host: ctx.host, now: iso(ctx.now), switch: sw.why, feed: feed.error || "ok",
    gates: gates.open ? "open" : "closed", blocked: gates.blocked.map((b) => b.why) }));
  let first = true;
  for (const l of decide(ctx, st, sw, feed, gates)) {
    const p = publicLine(l);
    if (p.decision === "would-apply") { p.next = first; first = false; }
    console.log(JSON.stringify(p));
  }
  return 0;
}

// Attempts whose transaction and watchdog are gone are interrupted: held, reported once, never retried. Nothing is
// rolled back here: after a restart or a kill the host may hold either version, so the line says to check by hand.
function sweepInterrupted(ctx) {
  const boot = bootMs();
  const found = updateState(ctx.state, (s) => {
    const out = [];
    for (const [k, a] of Object.entries(s.attempts)) {
      if (!ACTIVE.has(a.status)) continue;
      if ([a.txn_proc, a.watchdog_proc].some((p) => p && running(p))) continue;
      a.interrupted_in = a.status;
      a.restarted = Number.isFinite(a.boot) && Math.abs(a.boot - boot) > 5 * 60e3;
      a.status = "interrupted";
      a.finished_at = iso(Date.now());
      out.push([k, a]);
    }
    return out;
  });
  for (const [k, a] of found) {
    if (PRE_APPLY.has(a.interrupted_in)) pruneArtifacts(path.join(ctx.state, "txn", a.txn));
    const how = a.restarted ? "the host restarted" : "interrupted";
    alert(ctx.state, ctx.registry, `attempt:${k}`, `auto-update HOLD ${k}: ${how} during ${a.interrupted_in}; nothing was rolled back, no retry, check by hand (txn ${a.txn})`);
  }
}

// Transaction directories of attempts no longer in state (dropped as not now) go after a week; their large files
// went when they were dropped. Held, applied and running attempts keep theirs: logs and backups for recovery.
function pruneOldTxns(ctx, st) {
  const root = path.join(ctx.state, "txn");
  const keep = new Set(Object.values(st.attempts).map((a) => a.txn));
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    if (keep.has(d) || !TXN_RE.test(d)) continue;
    try { if (Date.now() - fs.statSync(path.join(root, d)).mtimeMs > 7 * 86400e3) fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch {}
  }
}

const LOCK_ALERT_MS = 8 * 3600e3; // above the longest transaction and watchdog any row may have

function cmdRun(args) {
  const ctx = context(args, "run");
  fs.mkdirSync(ctx.state, { recursive: true, mode: 0o700 });
  const lock = acquireLock(ctx.state, procRecord(process.pid, [SELF, ` run --host ${ctx.host}`]));
  if (!lock.ok) {
    // Another run, transaction or watchdog is active: silent, unless the lock has outlived any transaction.
    const since = lock.since ? Date.parse(lock.since) : NaN;
    if (Number.isFinite(since) && Date.now() - since > LOCK_ALERT_MS) {
      alert(ctx.state, ctx.registry, `lock:${ctx.host}`, `auto-update ${ctx.host}: host lock held since ${lock.since}${lock.unverified ? " by a process that cannot be identified" : ""}; nothing applies until it is released, check by hand`);
    }
    return 0;
  }
  let handedOver = false;
  try {
    sweepInterrupted(ctx);
    const st0 = loadState(ctx.state);
    pruneOldTxns(ctx, st0);
    for (const k of Object.keys(st0.alerts)) if (!st0.alerts[k].delivered) deliver(ctx.state, ctx.registry, k);
    // Every tick samples the host gates, whatever else happens, so the days show when the host is really idle.
    const stored = loadGates(ctx.state);
    const gates = evalGates(ctx.hostRow, ctx.registry, ctx.now);
    recordSample(ctx.state, ctx.hostRow, ctx.now, gates, stored);
    const sw = readSwitch(ctx.fleet, ctx.state);
    if (!sw.allowed) return 0;
    const feed = readFeed(ctx);
    if (feed.error) {
      alert(ctx.state, ctx.registry, `feed:${ctx.host}`, `auto-update ${ctx.host}: ${feed.error}; nothing applied`);
      return 0;
    }
    if (st0.alerts[`feed:${ctx.host}`]) updateState(ctx.state, (s) => { delete s.alerts[`feed:${ctx.host}`]; });
    const st = loadState(ctx.state);
    const next = decide(ctx, st, sw, feed, gates).find((l) => l.decision === "would-apply");
    if (!next) return 0;
    handedOver = startTransaction(ctx, next);
    return 0;
  } finally {
    if (!handedOver) releaseLock(ctx.state);
    // A Windows scheduler task stays running for the whole transaction, so its end cannot take the transaction with it.
    else if (args.wait) waitForHandover(ctx.state);
  }
}

function waitForHandover(dir) {
  for (;;) {
    const owners = lockOwners(dir);
    if (!owners || !owners.procs.some(running)) return;
    sleepMs(WINDOWS ? 5000 : 2000);
  }
}

function startTransaction(ctx, l) {
  const row = l._row;
  const adapter = row.adapters[ctx.hostRow.os];
  const key = attemptKey(ctx.host, row.component, l._candidate);
  const id = `${iso(ctx.now).replace(/[-:]/g, "")}-${row.component}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(ctx.state, "txn", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const vars = { version: l._candidate, installed: l._installed, digest: l._digest, adapters: ADAPTERS, txn: dir, component: row.component, host: ctx.host };
  const t = row.timeouts || {};
  const plan = {
    id, key, host: ctx.host, component: row.component, version: l._candidate, previous: l._installed, group: row.exclusive_group || null,
    local_date: localTime(ctx.now, ctx.hostRow.tz).date, state: ctx.state, fleet: ctx.fleet,
    check: { argv: fill(adapter.check.argv, vars), regex: adapter.check.regex, timeout: t.check || 30 },
    stage: (adapter.stage || []).map((a) => fill(a, vars)), stage_timeout: t.stage || 900,
    precheck: (adapter.precheck || []).map((a) => fill(a, vars)), precheck_timeout: t.precheck || 300,
    apply: fill(adapter.apply, vars), apply_timeout: t.apply || 600,
    health: adapter.health.map((a) => fill(a, vars)), health_timeout: t.health || 300,
    rollback: fill(adapter.rollback, vars), rollback_timeout: t.rollback || 600,
    watchdog_seconds: row.watchdog_seconds || 0,
    receipt: row.canary && row.canary.host === ctx.host ? expandHome(row.canary.receipt) : null,
    // Re-checked right before apply: a long stage must not carry the change into a blackout or past the window.
    // A run given --now (fixtures) keeps that clock; a live run uses the real clock at the recheck.
    window: (row.host_windows && row.host_windows[ctx.host]) || row.window, blackouts: ctx.registry.blackouts || [],
    clock_offset_ms: ctx.fixedNow ? ctx.now - Date.now() : 0,
    gate_host: ctx.hostRow,
  };
  writeAtomic(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  // The attempt is persisted before anything runs: a crash from here on holds this version.
  updateState(ctx.state, (s) => {
    s.attempts[key] = { status: "started", host: ctx.host, component: row.component, group: plan.group, local_date: plan.local_date, txn: id, started_at: iso(Date.now()), boot: bootMs(), txn_proc: null, watchdog_proc: null };
  });
  const child = detach(["txn", dir], dir);
  const rec = procRecord(child, [SELF, "txn", dir]);
  updateState(ctx.state, (s) => { s.attempts[key].txn_proc = rec; });
  setLockProcs(ctx.state, [rec]);
  return true;
}

function detach(argv, dir) {
  const log = fs.openSync(path.join(dir, `${argv[0]}.out`), "a", 0o600);
  const child = spawn(process.execPath, [SELF, ...argv], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

// ---------- the detached transaction ----------

const PRE_APPLY = new Set(["started", "staging", "prechecking"]);
const TXN_KEEP = new Set(["plan.json", "log.txt", "txn.out", "watchdog.out", "decision", "watchdog.armed"]);

// Staged downloads of an attempt that never reached apply: nothing on the host depends on them.
function pruneArtifacts(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const f of names) if (!TXN_KEEP.has(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
}

function txnLogger(dir) {
  const file = path.join(dir, "log.txt");
  return (text) => fs.appendFileSync(file, `[${iso(Date.now())}] ${text}\n`, { mode: 0o600 });
}

// Exactly one of the transaction (confirm, roll back, not now) and the watchdog decides; the first to create the
// decision file wins, and only the winner ends the attempt.
function claimDecision(dir, who) {
  try { fs.writeFileSync(path.join(dir, "decision"), who, { flag: "wx", mode: 0o600 }); return true; } catch { return false; }
}
function decisionOf(dir) { try { return fs.readFileSync(path.join(dir, "decision"), "utf8"); } catch { return null; } }

// Status changes only while the attempt is this transaction's and still active, and the transaction's own writes
// stop once the watchdog has decided: an ended attempt is never overwritten. Returns whether it was written.
function setStatus(plan, status, extra = {}, actor = "txn", also = null) {
  const dir = path.join(plan.state, "txn", plan.id);
  return updateState(plan.state, (s) => {
    const a = s.attempts[plan.key];
    if (!a || a.txn !== plan.id || !ACTIVE.has(a.status)) return false;
    const d = decisionOf(dir);
    if (actor === "txn" ? d === "watchdog" : d !== "watchdog") return false;
    Object.assign(a, { status }, extra);
    if (also) also(s);
    return true;
  });
}

function verifyInstalled(plan, want, log) {
  const r = runArgv(plan.check.argv, plan.check.timeout, log);
  if (!r.ok) return false;
  const re = new RegExp(plan.check.regex);
  return r.stdout.split(/\r?\n/).some((line) => { const m = re.exec(line.trim()); return m && m[1] === want; });
}

const rollbackVerified = (plan, log) => runArgv(plan.rollback, plan.rollback_timeout, log).ok && verifyInstalled(plan, plan.previous, log);

function writeReceipt(plan, result) {
  if (!plan.receipt) return;
  writeAtomic(plan.receipt, JSON.stringify({ schema: RECEIPT_SCHEMA, component: plan.component, version: plan.version, host: plan.host, result, finished_at: iso(Date.now()), txn: plan.id }, null, 2) + "\n");
}

// Right before the first change, after every wait: the kill switch and a local STOP file, the row's mode, tier and
// this host's allow list as they are on disk now, and the attempt still this transaction's. Unreadable or changed
// means not now. Rollback never asks: recovery is always allowed.
function stillAllowed(plan) {
  const sw = readSwitch(plan.fleet, plan.state);
  if (!sw.allowed) return `kill switch: ${sw.why}`;
  let reg;
  try {
    const doc = readJson(path.join(plan.fleet, "auto-update", "registry.json"));
    if (doc.missing) return "registry missing";
    reg = validateRegistry(doc.value);
  } catch (e) { return `registry unreadable: ${String(e.message).slice(0, 80)}`; }
  const host = reg.hosts[plan.host];
  const row = reg.components.find((c) => c.component === plan.component);
  if (!host || !row || !row.hosts.includes(plan.host) || !host.allow.includes(plan.component)) return "no longer allowed on this host";
  if (row.mode !== "apply") return `mode ${row.mode}`;
  if ((host.deny_tiers || []).includes(row.tier)) return `tier ${row.tier} denied on this host`;
  const a = loadState(plan.state).attempts[plan.key];
  if (!a || a.txn !== plan.id || !ACTIVE.has(a.status)) return "attempt is no longer this transaction's";
  return null;
}

function cmdTxn(dir) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const log = txnLogger(dir);
  notifyFrom = plan.host;
  let registry = null;
  try { registry = validateRegistry(JSON.parse(fs.readFileSync(path.join(plan.fleet, "auto-update", "registry.json"), "utf8"))); } catch {}
  let mutated = false; // the apply step has started: from here on an error needs a verified rollback
  const me = procRecord(process.pid, [SELF, "txn", dir]);
  const notNow = (step) => {
    updateState(plan.state, (s) => { const a = s.attempts[plan.key]; if (a && a.txn === plan.id) delete s.attempts[plan.key]; });
    pruneArtifacts(dir);
    log(`${step}: not now; attempt dropped, nothing changed`);
  };
  const fail = (status, why) => {
    if (!setStatus(plan, status, { finished_at: iso(Date.now()), reason: why })) { log(`not recorded (${status}): the attempt had already ended`); return; }
    writeReceipt(plan, "fail");
    if (!mutated) pruneArtifacts(dir);
    if (registry) alert(plan.state, registry, `attempt:${plan.key}`, `auto-update HOLD ${plan.key}: ${why}; held, no retry (txn ${plan.id})`);
  };
  try {
    if (!setStatus(plan, "staging", { txn_proc: me })) { log("attempt is no longer this transaction's; nothing done"); return; }
    const before = stillAllowed(plan);
    if (before) return notNow(`before stage: ${before}`);
    for (const a of plan.stage) {
      const r = runArgv(a, plan.stage_timeout, log);
      if (r.status === NOT_NOW) return notNow("stage");
      if (!r.ok) return fail("failed", "stage failed, nothing changed");
    }
    setStatus(plan, "prechecking");
    for (const a of plan.precheck) {
      const r = runArgv(a, plan.precheck_timeout, log);
      if (r.status === NOT_NOW) return notNow("precheck");
      if (!r.ok) return fail("failed", "precheck failed, nothing changed");
    }
    const at = Date.now() + plan.clock_offset_ms;
    if (plan.blackouts.some((b) => inWindow(at, b)) || !inWindow(at, plan.window)) return notNow("window closed before apply");
    const g = evalGates(plan.gate_host, { blackouts: plan.blackouts }, at);
    if (!g.open) return notNow(`host gate closed before apply: ${g.why || "blackout"}`);
    if (plan.watchdog_seconds) {
      const pid = detach(["watchdog", dir], dir);
      const wd = procRecord(pid, [SELF, "watchdog", dir]);
      setLockProcs(plan.state, [me, wd]);
      setStatus(plan, "prechecking", { watchdog_proc: wd });
      log(`watchdog armed: pid ${pid}, ${plan.watchdog_seconds}s`);
      // Do not disrupt anything until the watchdog has proved it is running.
      const until = Date.now() + 10000;
      while (!fs.existsSync(path.join(dir, "watchdog.armed"))) {
        if (Date.now() > until) { claimDecision(dir, "txn-abort"); return fail("failed", "watchdog did not arm, nothing changed"); }
        sleepMs(100);
      }
    }
    const why = stillAllowed(plan);
    if (why) { claimDecision(dir, "not-now"); return notNow(`before apply: ${why}`); }
    if (!setStatus(plan, "applying")) { log("attempt ended before apply; nothing changed"); return; }
    mutated = true;
    const ar = runArgv(plan.apply, plan.apply_timeout, log);
    if (ar.status === NOT_NOW && claimDecision(dir, "not-now")) { mutated = false; return notNow("apply"); }
    let healthy = ar.ok;
    if (healthy) {
      setStatus(plan, "health");
      for (const a of plan.health) if (!runArgv(a, plan.health_timeout, log).ok) { healthy = false; break; }
      healthy = healthy && verifyInstalled(plan, plan.version, log);
    }
    if (healthy && claimDecision(dir, "confirm")) {
      setStatus(plan, "applied", { finished_at: iso(Date.now()) }, "txn", (s) => {
        s.applied.push({ host: plan.host, component: plan.component, version: plan.version, previous: plan.previous, group: plan.group, local_date: plan.local_date, at: iso(Date.now()) });
        s.applied = s.applied.slice(-200);
      });
      writeReceipt(plan, "pass");
      log("applied and confirmed");
      return;
    }
    if (!claimDecision(dir, "txn-rollback")) { log("watchdog decided first; leaving rollback to it"); return; }
    setStatus(plan, "rolling-back");
    const rolled = rollbackVerified(plan, log);
    fail(rolled ? "rolled-back" : "rollback-failed", `${ar.ok ? "health check failed" : "apply failed"}; ${rolled ? `rolled back to ${plan.previous}` : "ROLLBACK FAILED, fix by hand"}`);
  } catch (e) {
    log(`error: ${e.stack || e}`);
    try {
      if (!mutated) {
        fail("failed", `transaction error before apply, nothing changed: ${String(e.message).slice(0, 120)}`);
      } else if (claimDecision(dir, "txn-rollback")) {
        // An error once apply has started: restore the previous version before anything else, then record it.
        const rolled = rollbackVerified(plan, log);
        log(rolled ? `rolled back to ${plan.previous} after the error` : "rollback after the error FAILED");
        fail(rolled ? "rolled-back" : "rollback-failed", `transaction error after apply; ${rolled ? `rolled back to ${plan.previous}` : "ROLLBACK FAILED, fix by hand"}`);
      } else {
        log(`error after the ${decisionOf(dir)} decision; leaving the attempt to it`);
      }
    } catch (e2) { log(`error while recording the error: ${e2.message}`); }
  } finally {
    leaveLock(plan.state);
  }
}

// POSIX: the transaction is a process group leader (detached); its steps share the group. True once no process of
// that group is left. The group is signalled only while its leader is provably this transaction or provably gone,
// never when the PID now belongs to something else.
function stopTransaction(rec, log) {
  const group = () => { try { process.kill(-rec.pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  const who = procState(rec);
  if (who === "unknown" || (who === "no" && alive(rec.pid))) return false;
  if (!group()) return true;
  log(`watchdog: stopping the transaction's process group ${rec.pid}`);
  try { process.kill(-rec.pid, "SIGKILL"); } catch {}
  for (let i = 0; i < 100 && group(); i++) sleepMs(100);
  return !group();
}

function cmdWatchdog(dir) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const log = txnLogger(dir);
  fs.writeFileSync(path.join(dir, "watchdog.armed"), String(process.pid), { mode: 0o600 });
  // Wake early once the transaction has decided, so a confirmed change does not keep the host lock for the whole timer.
  const until = Date.now() + plan.watchdog_seconds * 1000;
  while (Date.now() < until && !fs.existsSync(path.join(dir, "decision"))) sleepMs(Math.min(1000, Math.max(0, until - Date.now())));
  try {
    if (!claimDecision(dir, "watchdog")) return;
    // The budget covers apply, health and check, so a transaction still here is stuck or gone. Nothing is restored
    // while it, or a step it started, may still be changing things.
    log("watchdog: no decision in time");
    let registry = null;
    try { registry = validateRegistry(JSON.parse(fs.readFileSync(path.join(plan.fleet, "auto-update", "registry.json"), "utf8"))); } catch {}
    notifyFrom = plan.host;
    const a = loadState(plan.state).attempts[plan.key];
    const say = (line) => { if (registry) alert(plan.state, registry, `attempt:${plan.key}`, `auto-update HOLD ${plan.key}: ${line} (txn ${plan.id})`); };
    if (!a || !a.txn_proc || !stopTransaction(a.txn_proc, log)) {
      if (setStatus(plan, "rollback-failed", { finished_at: iso(Date.now()), reason: "transaction could not be stopped" }, "watchdog")) {
        say(`not confirmed within ${plan.watchdog_seconds}s and the transaction could not be stopped; nothing was rolled back, fix by hand`);
      }
      return;
    }
    if (!setStatus(plan, "rolling-back", {}, "watchdog")) return;
    const rolled = rollbackVerified(plan, log);
    if (!setStatus(plan, rolled ? "rolled-back-by-watchdog" : "rollback-failed", { finished_at: iso(Date.now()) }, "watchdog")) return;
    writeReceipt(plan, "fail");
    say(`not confirmed within ${plan.watchdog_seconds}s; ${rolled ? `watchdog rolled back to ${plan.previous}` : "watchdog ROLLBACK FAILED, fix by hand"}`);
  } finally {
    leaveLock(plan.state);
  }
}

// A receipt is relayed only when this host's own state shows the transaction that wrote it finished with that
// result: a pass only after a confirmed apply, a fail only after a held failure. A version found installed (by hand,
// or by discovery) never yields a receipt, and an interrupted attempt yields none either.
const PASS_STATUS = ["applied"];
const FAIL_STATUS = ["failed", "rolled-back", "rollback-failed", "rolled-back-by-watchdog"];
function fromCanaryTxn(r, st) {
  const a = st.attempts[attemptKey(r.host, r.component, r.version)];
  if (!a || a.txn !== r.txn) return "receipt not from a completed canary transaction here";
  if (!(r.result === "pass" ? PASS_STATUS : FAIL_STATUS).includes(a.status)) return `receipt result does not match the transaction (${a.status})`;
  return null;
}

// On the publishing host: relay copies of the feed and of this host's canary receipts for one other host, one JSON
// line each after a header. Only inputs that validate now are exported; nothing is written.
function cmdExport(args) {
  const ctx = context(args, "export");
  const to = args.for;
  const target = to && ctx.registry.hosts[to];
  if (!target || to === ctx.host) throw new Refusal("--for <another registry host> required");
  const wrap = (kind, text) => {
    const data = Buffer.from(text, "utf8");
    return { schema: RELAY_SCHEMA, kind, source_host: ctx.host, for_host: to, sent_at: iso(Date.now()), sha256: sha256hex(data), data: data.toString("base64") };
  };
  const docs = [];
  const skipped = [];
  const st = loadState(ctx.state);
  if (ctx.registry.feed.source_host === ctx.host) {
    try {
      const doc = readJson(expandHome(ctx.registry.feed.path), MAX_FEED);
      if (doc.missing) throw new Refusal("feed missing");
      validateFeed(doc.value, ctx.now, ctx.registry.feed.max_age_hours);
      docs.push({ name: "feed", max_age_hours: ctx.registry.feed.max_age_hours, doc: wrap("feed", doc.text) });
    } catch (e) { skipped.push({ name: "feed", why: e instanceof Refusal ? e.message : "unreadable" }); }
  }
  for (const row of ctx.registry.components) {
    if (!row.canary || row.canary.host !== ctx.host || !row.hosts.includes(to)) continue;
    const name = `canary/${row.component}`;
    try {
      const doc = readJson(expandHome(row.canary.receipt));
      if (doc.missing) { skipped.push({ name, why: "no receipt yet" }); continue; }
      const bad = receiptProblem(doc.value, row.component, ctx.host, ctx.now, row.canary.max_age_hours) || fromCanaryTxn(doc.value, st);
      if (bad) throw new Refusal(bad);
      docs.push({ name, max_age_hours: row.canary.max_age_hours, doc: wrap("receipt", doc.text) });
    } catch (e) { skipped.push({ name, why: e instanceof Refusal ? e.message : "unreadable" }); }
  }
  console.log(JSON.stringify({ for_host: to, ssh: target.ssh || null, skipped }));
  for (const d of docs) console.log(JSON.stringify(d));
  return 0;
}

function cmdValidate() {
  const doc = readJson(path.join(fleetDir(), "auto-update", "registry.json"));
  if (doc.missing) throw new Refusal("registry.json missing");
  const r = validateRegistry(doc.value);
  for (const [h, row] of Object.entries(r.hosts)) {
    const comps = r.components.filter((c) => c.hosts.includes(h)).map((c) => `${c.component}(t${c.tier},${c.mode})`);
    console.log(`${h} ${row.os}: ${comps.join(" ") || "none"}`);
  }
  return 0;
}

// ---------- main ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" || argv[i] === "--now" || argv[i] === "--for") { out[argv[i].slice(2)] = argv[++i]; }
    else if (argv[i] === "--wait") out.wait = true;
    else if (argv[i].startsWith("--")) throw new Refusal(`unknown option ${argv[i]}`);
    else out._.push(argv[i]);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, arg] = args._;
  if (!OS_NAME) throw new Refusal(`unsupported platform ${process.platform}`);
  if (cmd === "plan") return cmdPlan(args);
  if (cmd === "run") return cmdRun(args);
  if (cmd === "validate") return cmdValidate();
  if (cmd === "export") return cmdExport(args);
  if (cmd === "txn" && arg) return cmdTxn(arg);
  if (cmd === "watchdog" && arg) return cmdWatchdog(arg);
  throw new Refusal("usage: auto-update.mjs plan|run --host <name> [--now <ISO>] [--wait] | validate | export --host <self> --for <host>");
}

try {
  process.exitCode = main() || 0;
} catch (e) {
  console.error(`auto-update: ${e instanceof Refusal ? e.message : e.stack || e}`);
  process.exitCode = 2;
}

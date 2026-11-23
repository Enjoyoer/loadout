// Receive auto-update relay copies (the publishing host's available-versions feed and canary receipts) on one host.
// Shipped by auto_update_relay.py through fleet.run_node in a digest-checked stdin envelope; process.argv[2] is the
// gzip+base64 JSON payload {dry_run, for_host, docs: [{name, max_age_hours, doc}]}, each doc a
// loadout.auto-update.relay/1 copy as `auto-update.mjs export` printed it.
//
// Destinations are fixed: <state>/relay/available.json and <state>/relay/canary/<component>.json, where <state> is
// the runner's state directory (${XDG_STATE_HOME:-~/.local/state}/loadout/auto-update, %LOCALAPPDATA% on Windows).
// No path comes from the payload. Directories are owner-only (0700), files 0600, written through a temp file in the
// same directory, fsynced, then renamed over the old copy. A copy is refused when it is malformed, its digest does
// not match, it was sent more than 10 minutes ago, its contents are stale or in the future, or it is older than (or
// differs at the same time from) the copy already here, so an old envelope cannot be replayed. Which host a copy is
// for is checked again by the runner, which knows its own registry name.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const RELAY_SCHEMA = "loadout.auto-update.relay/1";
const FEED_SCHEMA = "loadout.auto-update.available/1";
const RECEIPT_SCHEMA = "loadout.auto-update.canary/1";
const MAX = 64 * 1024;
const SENT_MAX_AGE_MS = 10 * 60 * 1000;
const FUTURE_MS = 5 * 60 * 1000;
const NAME = /^(feed|canary\/[a-z0-9][a-z0-9.@+-]{0,63})$/;
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS = process.platform === "win32";
const result = { status: null, written: [], same: [], rejected: [], error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ts = (v) => (typeof v === "string" && TS.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

function stateRoot() {
  if (WINDOWS) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "loadout", "auto-update");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "loadout", "auto-update");
}

// A directory of ours: a real directory, owned by this user and not open to group or other (POSIX).
function checkDir(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a plain directory: ${path.basename(dir)}`);
  if (!WINDOWS && (st.uid !== process.getuid() || (st.mode & 0o077))) throw new Error(`not owner-only: ${path.basename(dir)}`);
}

function ensureDir(dir, create) {
  try { checkDir(dir); return true; } catch (e) {
    if (e.code !== "ENOENT") throw e;
    if (!create) return false;
    fs.mkdirSync(dir, { mode: 0o700 });
    if (!WINDOWS) fs.chmodSync(dir, 0o700);
    checkDir(dir);
    return true;
  }
}

// The inner document's own time: generated_at for a feed, finished_at for a receipt.
function inner(kind, w, name, maxAgeHours, now) {
  if (!isObj(w) || Object.keys(w).sort().join() !== "data,for_host,kind,schema,sent_at,sha256,source_host") throw new Error("malformed copy");
  if (w.schema !== RELAY_SCHEMA || w.kind !== kind) throw new Error("wrong schema or kind");
  if (!HOST.test(String(w.source_host)) || !HOST.test(String(w.for_host))) throw new Error("bad host names");
  if (typeof w.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(w.data)) throw new Error("data not base64");
  const bytes = Buffer.from(w.data, "base64");
  if (bytes.length > MAX) throw new Error("too large");
  if (sha(bytes) !== w.sha256) throw new Error("digest mismatch");
  let d;
  try { d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("data not JSON"); }
  if (!isObj(d)) throw new Error("data not an object");
  let at;
  if (kind === "feed") {
    if (d.schema !== FEED_SCHEMA) throw new Error("not a feed");
    at = ts(d.generated_at);
  } else {
    if (d.schema !== RECEIPT_SCHEMA || d.component !== name.slice(7) || d.host !== w.source_host) throw new Error("receipt is for another component or host");
    at = ts(d.finished_at);
  }
  if (at === null) throw new Error("no valid time in the document");
  if (at > now + FUTURE_MS) throw new Error("document in the future");
  if (now - at > maxAgeHours * 3600e3) throw new Error("document stale");
  return { at, sha: w.sha256 };
}

function readExisting(file, kind, name) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("existing copy is not a regular file");
  if (!WINDOWS && st.uid !== process.getuid()) throw new Error("existing copy is not ours");
  try { return inner(kind, JSON.parse(fs.readFileSync(file, "utf8")), name, 1e6, Date.now()); } catch { return { invalid: true }; }
}

function replace(dir, file, text) {
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  if (!WINDOWS) { const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
}

try {
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(process.argv[2], "base64")).toString());
  if (!isObj(p) || !Array.isArray(p.docs) || !HOST.test(String(p.for_host))) throw new Error("malformed payload");
  const now = Date.now();
  const root = stateRoot();
  const relay = path.join(root, "relay");
  const canary = path.join(relay, "canary");
  const write = !p.dry_run;
  // The state directory and its relay folders: created owner-only only when something is written.
  let ready = null;
  const prepare = (needCanary) => {
    if (ready === null) {
      fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
      ensureDir(root, true);
      ensureDir(relay, true);
      ready = true;
    }
    if (needCanary) ensureDir(canary, true);
  };
  for (const d of p.docs) {
    const name = isObj(d) ? d.name : null;
    try {
      if (typeof name !== "string" || !NAME.test(name)) throw new Error("not a relay name");
      const kind = name === "feed" ? "feed" : "receipt";
      if (!Number.isFinite(d.max_age_hours) || d.max_age_hours <= 0 || d.max_age_hours > 24 * 30) throw new Error("bad max age");
      const w = d.doc;
      const sent = isObj(w) ? ts(w.sent_at) : null;
      if (sent === null || now - sent > SENT_MAX_AGE_MS || sent > now + FUTURE_MS) throw new Error("envelope not sent just now (replay or clock skew)");
      if (w.for_host !== p.for_host) throw new Error("copy is for another host");
      const got = inner(kind, w, name, d.max_age_hours, now);
      const dir = kind === "feed" ? relay : canary;
      const file = path.join(dir, kind === "feed" ? "available.json" : `${name.slice(7)}.json`);
      const exists = fs.existsSync(root) && fs.existsSync(relay) && (kind === "feed" || fs.existsSync(canary));
      if (exists) { checkDir(root); checkDir(relay); if (kind !== "feed") checkDir(canary); }
      const old = exists ? readExisting(file, kind, name) : null;
      if (old && !old.invalid) {
        if (got.at < old.at) throw new Error("older than the copy here (replay)");
        if (got.at === old.at && got.sha === old.sha) { result.same.push(name); continue; }
        if (got.at === old.at) throw new Error("differs from the copy here at the same time");
      }
      if (write) { prepare(kind !== "feed"); replace(dir, file, JSON.stringify(w) + "\n"); }
      result.written.push(name);
    } catch (e) {
      result.rejected.push({ name: typeof name === "string" ? name.slice(0, 80) : null, why: String(e.message).slice(0, 160) });
    }
  }
  result.status = result.rejected.length ? "partial" : write ? (result.written.length ? "updated" : "same") : (result.written.length ? "would update" : "same");
  done(0);
} catch (e) {
  result.status = "failed";
  result.error = String(e && e.message || e).slice(0, 200);
  done(1);
}

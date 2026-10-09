// Replace this host's fleet directory with the source host's copy.
// Shipped by fleet.py push through fleet.run_node in a digest-checked stdin envelope; process.argv[2] is the gzip+base64 JSON payload
// {dry_run, target, files: {relative path: {sha256, data (base64)}}}.
// A file may change only when it matches the last synced version recorded in
// .loadout-sync.json; anything else is a hand edit and stops the host.
// checkAncestors comes from remote_common.js, which fleet.run_node ships ahead of this file.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const RECORD = ".loadout-sync.json";
const TMP = ".loadout-tmp";
// Finder's .DS_Store and a temp file this sync itself writes (<managed file>.loadout-tmp or the
// record's) are not hand edits. Any other *.loadout-tmp is still reported.
let managed = new Set();
const skipped = (name, r) => name === ".DS_Store" ||
  r.endsWith(TMP) && !managed.has(r) && (managed.has(r.slice(0, -TMP.length)) || r === RECORD + TMP);
const result = { status: null, target: null, added: [], changed: [], removed: [], conflicts: [], error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
function defaultTarget() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "loadout", "fleet");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "loadout", "fleet");
}
function walk(dir, rel, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name), r = rel ? rel + "/" + name : name;
    if (skipped(name, r)) continue;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new Error("symlink in fleet directory: " + r);
    if (st.isDirectory()) walk(full, r, out);
    else if (st.isFile()) { if (r !== RECORD) out[r] = sha(fs.readFileSync(full)); }
    else throw new Error("unexpected file type: " + r);
  }
  return out;
}
try {
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(process.argv[2], "base64")).toString());
  const target = p.target || defaultTarget();
  result.target = target;
  const desired = {};
  for (const [rel, f] of Object.entries(p.files)) {
    const parts = rel.split("/");
    // A backslash or drive prefix is a separator or root on a Windows target.
    if (path.isAbsolute(rel) || /\\|^[A-Za-z]:/.test(rel) || parts.some(x => x === "" || x === "." || x === "..") || rel === RECORD)
      throw new Error("invalid path from source: " + rel);
    checkAncestors(fs, path, target, path.join(target, ...parts));
    const data = Buffer.from(f.data, "base64");
    if (sha(data) !== f.sha256) throw new Error("hash mismatch in transfer: " + rel);
    desired[rel] = { data, sha256: f.sha256 };
  }
  // The fleet directory and its loadout parent must be real directories.
  for (const dir of [path.dirname(target), target])
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw new Error("not a real directory: " + dir);
  const recordPath = path.join(target, RECORD);
  const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf8")).files || {} : {};
  managed = new Set([...Object.keys(desired), ...Object.keys(record)]);
  const existing = fs.existsSync(target) ? walk(target, "", {}) : {};
  for (const rel of new Set([...Object.keys(desired), ...Object.keys(existing)])) {
    const want = desired[rel] && desired[rel].sha256, have = existing[rel];
    if (have === want) continue;
    if (have && have !== record[rel]) { result.conflicts.push(rel); continue; }
    (!have ? result.added : want ? result.changed : result.removed).push(rel);
  }
  const edits = result.added.length + result.changed.length + result.removed.length;
  if (result.conflicts.length) { result.status = "conflict"; done(5); }
  result.status = edits ? (p.dry_run ? "would update" : "updated") : "same";
  if (p.dry_run) done(0);
  for (const rel of [...result.added, ...result.changed]) {
    const dest = path.join(target, ...rel.split("/")), tmp = dest + TMP;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, desired[rel].data, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  }
  for (const rel of result.removed) fs.unlinkSync(path.join(target, ...rel.split("/")));
  const after = walk(target, "", {});
  const expect = Object.fromEntries(Object.entries(desired).map(([k, v]) => [k, v.sha256]));
  if (JSON.stringify(Object.keys(after).sort().map(k => [k, after[k]])) !== JSON.stringify(Object.keys(expect).sort().map(k => [k, expect[k]])))
    throw new Error("fleet directory does not match the source after writing");
  const newRecord = JSON.stringify({ version: 1, files: expect }, null, 2);
  if (!fs.existsSync(recordPath) || fs.readFileSync(recordPath, "utf8") !== newRecord) {
    fs.writeFileSync(recordPath + TMP, newRecord, { mode: 0o600 });
    fs.renameSync(recordPath + TMP, recordPath);
  }
  done(0);
} catch (e) {
  result.status = "failed";
  result.error = String(e && e.message || e);
  done(3);
}

// Replace this host's fleet directory with the source host's copy.
// Shipped by fleet.py push through fleet.run_node in a digest-checked stdin envelope; process.argv[2] is the gzip+base64 JSON payload
// {dry_run, target, files: {relative path: {sha256, data (base64)}}}.
// A file may change only when it matches the last synced version recorded in
// .loadout-sync.json, or a version a cut-off run recorded there as pending before writing it;
// anything else is a hand edit and stops the host.
// Helpers come from remote_common.js, which fleet.run_node ships ahead of this file.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const RECORD = ".loadout-sync.json";
// Finder's .DS_Store, and a regular file a cut-off run left beside a managed file or the record
// (<name>.loadout-tmp from an older sync, or <name>.loadout-tmp-<hex>), are not hand edits; nothing
// here opens them. Any other *.loadout-tmp, or one that is not a regular file, is still reported.
const TMP = /\.loadout-tmp(-[0-9a-f]{16})?$/;
let managed = new Set();
const skipped = (name, r, st) => name === ".DS_Store" || st.isFile() && TMP.test(r) && !managed.has(r) &&
  (managed.has(r.replace(TMP, "")) || r.replace(TMP, "") === RECORD);
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
    const full = path.join(dir, name), r = rel ? rel + "/" + name : name, st = fs.lstatSync(full);
    if (skipped(name, r, st)) continue;
    if (st.isSymbolicLink()) throw new Error("symlink in fleet directory: " + r);
    if (st.isDirectory()) walk(full, r, out);
    else if (st.isFile()) { if (r !== RECORD) out[r] = sha(fs.readFileSync(full)); }
    else throw new Error("unexpected file type: " + r);
  }
  return out;
}
try {
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(process.argv[2], "base64")).toString());
  const target = p.target || defaultTarget(), base = baseFor(path, os.homedir(), target);
  result.target = target;
  // A path inside the fleet directory, its directories checked again from base down: every write and
  // removal calls this right before it, since a preflight is not a lock.
  const at = rel => {
    const file = path.join(target, ...rel.split("/"));
    checkAncestors(fs, path, target, file, base);
    return file;
  };
  const desired = {};
  for (const [rel, f] of Object.entries(p.files)) {
    const parts = rel.split("/");
    // A backslash or drive prefix is a separator or root on a Windows target.
    if (path.isAbsolute(rel) || /\\|^[A-Za-z]:/.test(rel) || parts.some(x => x === "" || x === "." || x === "..") || rel === RECORD)
      throw new Error("invalid path from source: " + rel);
    at(rel);
    const data = Buffer.from(f.data, "base64");
    if (sha(data) !== f.sha256) throw new Error("hash mismatch in transfer: " + rel);
    desired[rel] = { data, sha256: f.sha256 };
  }
  // The fleet directory and its loadout parent must be real directories.
  for (const dir of [path.dirname(target), target])
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw new Error("not a real directory: " + dir);
  const recordPath = path.join(target, RECORD);
  const saved = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf8")) : {};
  const record = saved.files || {}, pending = saved.pending || {};
  managed = new Set([...Object.keys(desired), ...Object.keys(record), ...Object.keys(pending)]);
  const existing = fs.existsSync(target) ? walk(target, "", {}) : {};
  for (const rel of new Set([...Object.keys(desired), ...Object.keys(existing)])) {
    const want = desired[rel] && desired[rel].sha256, have = existing[rel];
    if (have === want) continue;
    if (have && have !== record[rel] && !(pending[rel] || []).includes(have)) { result.conflicts.push(rel); continue; }
    (!have ? result.added : want ? result.changed : result.removed).push(rel);
  }
  const edits = result.added.length + result.changed.length + result.removed.length;
  if (result.conflicts.length) { result.status = "conflict"; done(5); }
  result.status = edits ? (p.dry_run ? "would update" : "updated") : "same";
  if (p.dry_run) done(0);
  // The record is written through an exclusively created temp file, then read back.
  const writeRecord = doc => {
    const text = JSON.stringify(doc, null, 2);
    replaceFile(fs, recordPath, text, 0o600, null, () => at(RECORD));
    const st = fs.lstatSync(recordPath);
    if (!st.isFile() || fs.readFileSync(recordPath, "utf8") !== text) throw new Error("sync record did not verify after writing: " + recordPath);
  };
  if (edits) {
    // Before any change, record the versions this run writes as pending, so a run cut off part way
    // recognizes its own writes next time instead of reporting them as hand edits.
    const intent = { ...pending };
    for (const rel of [...result.added, ...result.changed]) intent[rel] = [...new Set([...(intent[rel] || []), desired[rel].sha256])];
    fs.mkdirSync(target, { recursive: true });
    writeRecord({ version: 1, files: record, pending: intent });
  }
  for (const rel of [...result.added, ...result.changed]) {
    const dest = at(rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    replaceFile(fs, dest, desired[rel].data, 0o600, null, () => checkUnchanged(fs, at(rel), existing[rel] ? [existing[rel]] : null));
  }
  for (const rel of result.removed) removeFile(fs, at(rel), [existing[rel]]);
  const after = walk(target, "", {});
  const expect = Object.fromEntries(Object.entries(desired).map(([k, v]) => [k, v.sha256]));
  if (JSON.stringify(Object.keys(after).sort().map(k => [k, after[k]])) !== JSON.stringify(Object.keys(expect).sort().map(k => [k, expect[k]])))
    throw new Error("fleet directory does not match the source after writing");
  const newRecord = { version: 1, files: expect };
  if (!fs.existsSync(recordPath) || fs.readFileSync(recordPath, "utf8") !== JSON.stringify(newRecord, null, 2)) writeRecord(newRecord);
  done(0);
} catch (e) {
  result.status = "failed";
  result.error = String(e && e.message || e);
  done(3);
}

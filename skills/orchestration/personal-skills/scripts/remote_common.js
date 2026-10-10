// Shared by the remote programs: fleet.run_node ships it ahead of each one as a single script.
// Callers pass fs, path and os, so no top-level name here clashes with a program's own.

// Throws unless file is strictly inside root and each existing directory from root down to the
// file's parent is real: lstat, so a symlink (even a dangling one) or a file is refused. base, a
// trusted directory above root (see baseFor), extends the check to every directory below base down to root.
function checkAncestors(fs, path, root, file, base) {
  const rel = path.relative(root, file), up = base === undefined ? "" : path.relative(base, root);
  // Also refuses root itself, "..x" directly under root, and another drive on Windows.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escapes its root: " + file);
  if (up.startsWith("..") || path.isAbsolute(up)) throw new Error("path escapes its root: " + root);
  const dirs = r => r && r !== "." ? r.split(path.sep) : [];
  let cur = path.resolve(up ? base : root); // with a trailing separator, lstat would follow a symlinked root
  for (const part of (up ? dirs(up) : [""]).concat(dirs(path.dirname(rel)))) {
    cur = part ? path.join(cur, part) : cur;
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory: " + cur);
  }
}

// The trusted directory checkAncestors starts from: home for a root inside it, so a linked ~/.claude or
// ~/.config is refused too; otherwise root's own parent, so a root named outside home is checked from itself down.
function baseFor(path, home, root) {
  const rel = path.relative(home, root);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? home : path.dirname(root);
}

// Whether a path from the source names the same file on every host: "/"-separated components that are
// not empty, "." or "..", hold no backslash, colon (a drive or an NTFS stream) or control character, and
// neither end in a dot or space nor name a device, which Windows drops or maps.
const portable = rel => rel.split("/").every(x =>
  x && x !== "." && x !== ".." && !/[\\:\x00-\x1f]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(x));

// One key for names a case-insensitive (macOS or Windows) host treats as the same file.
const foldPath = rel => rel.normalize("NFC").toUpperCase().toLowerCase();

// Throws unless every path is portable and no two name one file on a case-insensitive host.
function checkPaths(rels) {
  const seen = new Map();
  for (const rel of rels) {
    if (!portable(rel)) throw new Error("invalid path from source: " + rel);
    const key = foldPath(rel);
    if (seen.has(key)) throw new Error(`paths from source name one file on a case-insensitive host: ${seen.get(key)}, ${rel}`);
    seen.set(key, rel);
  }
}

// The per-user Loadout directory that holds this host's sync records.
const loadoutDir = (path, os) => process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "loadout")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "loadout");

const sha256 = buf => require("crypto").createHash("sha256").update(buf).digest("hex");

// Throws unless file is still what preflight accepted: absent when accepted is null, else a regular
// file whose sha256 is one of accepted. Run at the point of use, since a preflight is not a lock.
function checkUnchanged(fs, file, accepted) {
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (accepted === null ? st : !st || !st.isFile() || !accepted.includes(sha256(fs.readFileSync(file))))
    throw new Error("changed since preflight, nothing written there: " + file);
}

// A unique temp file, created exclusively, replaces file only while it is still the inode this run wrote,
// and only when check, run just before the rename, does not throw. A temp file this run wrote is never
// left behind, and one that is not ours is never removed.
function replaceFile(fs, file, data, mode = 0o666, prep, check) {
  const tmp = file + ".loadout-tmp-" + require("crypto").randomBytes(8).toString("hex"), fd = fs.openSync(tmp, "wx", mode);
  const own = fs.fstatSync(fd), ours = () => {
    try { const now = fs.lstatSync(tmp); return now.ino === own.ino && now.dev === own.dev; } catch { return false; }
  };
  let renamed = false;
  try {
    try { fs.writeFileSync(fd, data); if (prep) prep(fd); } finally { fs.closeSync(fd); }
    if (!ours()) throw new Error("temp file is not ours: " + tmp);
    if (check) check();
    fs.renameSync(tmp, file);
    renamed = true;
  } finally {
    try { if (!renamed && ours()) fs.unlinkSync(tmp); } catch { /* the error on its way out says more */ }
  }
}

// Removes file only while it is a regular file whose sha256 is one of accepted. It is first renamed to a
// unique name beside itself, so the bytes checked are the bytes removed. A changed file is put back
// (a hard link never replaces what took the path meanwhile); anything else, or a file that cannot be
// put back, is kept at that name. Either way the removal throws.
function removeFile(fs, file, accepted) {
  const held = file + ".loadout-rm-" + require("crypto").randomBytes(8).toString("hex");
  fs.renameSync(file, held);
  const st = fs.lstatSync(held);
  if (st.isFile() && accepted.includes(sha256(fs.readFileSync(held)))) return fs.unlinkSync(held);
  let back = false;
  if (st.isFile()) try { fs.linkSync(held, file); fs.unlinkSync(held); back = true; } catch { /* kept at held */ }
  throw new Error("changed since preflight, not removed: " + file + (back ? "" : "; kept at " + held));
}

if (typeof module === "object") module.exports = { checkAncestors, baseFor, portable, foldPath, checkPaths, loadoutDir, checkUnchanged, replaceFile, removeFile };

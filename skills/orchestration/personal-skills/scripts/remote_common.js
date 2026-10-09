// Shared by the remote programs: fleet.run_node ships it ahead of each one as a single script.
// Callers pass fs, path and os, so no top-level name here clashes with a program's own.

// Throws unless file is strictly inside root and each existing directory from root down to the
// file's parent is real: lstat, so a symlink (even a dangling one) or a file is refused.
function checkAncestors(fs, path, root, file) {
  const rel = path.relative(root, file);
  // Also refuses root itself, "..x" directly under root, and another drive on Windows.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escapes its root: " + file);
  let cur = path.resolve(root); // with a trailing separator, lstat would follow a symlinked root
  for (const part of [""].concat(path.dirname(rel) === "." ? [] : path.dirname(rel).split(path.sep))) {
    cur = part ? path.join(cur, part) : cur;
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory: " + cur);
  }
}

// The per-user Loadout directory that holds this host's sync records.
const loadoutDir = (path, os) => process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "loadout")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "loadout");

// A unique temp file, created exclusively, replaces file only while it is still the inode this run wrote.
function replaceFile(fs, file, data, mode = 0o666, prep) {
  const tmp = file + ".loadout-tmp-" + require("crypto").randomBytes(8).toString("hex"), fd = fs.openSync(tmp, "wx", mode);
  let st;
  try { fs.writeFileSync(fd, data); if (prep) prep(fd); st = fs.fstatSync(fd); } finally { fs.closeSync(fd); }
  const now = fs.lstatSync(tmp);
  if (now.ino !== st.ino || now.dev !== st.dev) throw new Error("temp file is not ours: " + tmp);
  fs.renameSync(tmp, file);
}

if (typeof module === "object") module.exports = { checkAncestors, loadoutDir, replaceFile };

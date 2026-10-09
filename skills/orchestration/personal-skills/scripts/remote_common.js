// Shared by the remote programs: fleet.run_node ships it ahead of each one as a single script.
// Callers pass fs and path, so no top-level name here clashes with a program's own.

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

if (typeof module === "object") module.exports = { checkAncestors };

// Helpers shared by the remote programs. fleet.run_node ships this file ahead of each program as
// one script, so a host needs no installed copy. Callers pass their own fs and path modules: this
// file declares nothing at top level that a program might also declare.

// Throws unless file lies strictly inside root and every existing component from root down to the
// file's parent is a real directory, not a symlink or a file. A missing component ends the check.
function checkAncestors(fs, path, root, file) {
  const rel = path.relative(root, file);
  // Also refuses root itself, a name like "..x" directly under root, and another drive on Windows.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escapes its root: " + file);
  // Resolved: a trailing separator would make lstat follow a symlinked root.
  let cur = path.resolve(root);
  for (const part of [""].concat(path.dirname(rel) === "." ? [] : path.dirname(rel).split(path.sep))) {
    cur = part ? path.join(cur, part) : cur;
    // lstat, not exists: a dangling symlink is refused, and only ENOENT means not there yet.
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory: " + cur);
  }
}

if (typeof module === "object") module.exports = { checkAncestors };

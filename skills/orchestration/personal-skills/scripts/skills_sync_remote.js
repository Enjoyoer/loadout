// Install verified Loadout skill files and global instructions on this host.
// Shipped gzip+base64 by skills_sync.py; stdin is the gzip+base64 JSON payload
// {dry_run, clients, files: {"<skill>/<file>": {sha256, data, prior}},
//  global: {sha256, data, targets: {client: path}} | null}.
// Preflight first, write second: a file may be replaced only when it matches the
// desired blob or a prior publication (skills), or the last synced version
// (global instructions). Anything else is a conflict and nothing is written.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const result = { status: null, clients: {}, added: [], changed: [], same: 0, conflicts: [], error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const home = os.homedir();
const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
const CLIENT_HOMES = { codex: codexHome, claude: path.join(home, ".claude"), opencode: path.join(home, ".config", "opencode") };
const SKILL_ROOTS = { codex: path.join(codexHome, "skills"), claude: path.join(home, ".claude", "skills") };
const recordDir = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "loadout")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "loadout");
const recordPath = path.join(recordDir, "global-sync.json");

function expand(template) {
  let p = template.replace(/\$CODEX_HOME|\$\{CODEX_HOME\}/g, codexHome)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, v) => process.env[v] || m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, v) => process.env[v] || m);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(home, p.slice(1));
  return path.resolve(p);
}

// Every existing component from root down to the file must be a real directory.
function checkAncestors(root, file) {
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escapes its root: " + file);
  let cur = root;
  for (const part of [""].concat(path.dirname(rel) === "." ? [] : path.dirname(rel).split(path.sep))) {
    cur = part ? path.join(cur, part) : cur;
    if (!fs.existsSync(cur)) return;
    const st = fs.lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory: " + cur);
  }
}

// Returns "same", "added", "changed", or "conflict".
function plan(file, root, want, allowed) {
  checkAncestors(root, file);
  if (!fs.existsSync(file)) return "added";
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) return "conflict";
  const have = sha(fs.readFileSync(file));
  if (have === want) return "same";
  return allowed.includes(have) ? "changed" : "conflict";
}

try {
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64")).toString());
  // A configured Loadout Pi receives the same selected, verified skill blobs.
  // Discover its home from the host's provider command, not a second fleet list.
  const cfgPath = path.join(home, '.paseo', 'config.json');
  if (fs.existsSync(cfgPath)) {
    const provider = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).agents?.providers?.pi;
    const launcher = provider?.command?.find(arg => path.basename(arg) === 'launch.mjs');
    if (launcher) {
      const runtimeRoot = path.dirname(expand(launcher));
      const agentHome = path.join(runtimeRoot, 'agent');
      const pkg = path.join(runtimeRoot, 'app', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
      checkAncestors(home, path.join(agentHome, 'skills', 'probe'));
      if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).version === '1.0.0') {
        CLIENT_HOMES.pi = agentHome;
        SKILL_ROOTS.pi = path.join(agentHome, 'skills');
        p.clients = [...new Set([...p.clients, 'pi'])];
        if (p.global) p.global.targets.pi = path.join(agentHome, 'AGENTS.md');
      }
    }
  }
  const data = {};
  for (const [rel, f] of Object.entries(p.files)) {
    const parts = rel.split("/");
    if (parts.length < 2 || parts.some(x => !x || x === "." || x === "..")) throw new Error("invalid path from source: " + rel);
    data[rel] = Buffer.from(f.data, "base64");
    if (sha(data[rel]) !== f.sha256) throw new Error("hash mismatch in transfer: " + rel);
  }
  const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf8")) : {};
  const writes = [], records = {};
  const consider = (file, root, want, allowed, label, bytes, isGlobal) => {
    const kind = plan(file, root, want, allowed);
    if (kind === "conflict") result.conflicts.push(label);
    else if (kind === "same") { result.same++; if (isGlobal) records[file] = want; }
    else writes.push({ file, label, kind, data: bytes, global: isGlobal });
  };
  for (const client of p.clients) {
    if (!CLIENT_HOMES[client] || !fs.existsSync(CLIENT_HOMES[client])) { result.clients[client] = "absent"; continue; }
    const root = SKILL_ROOTS[client];
    result.clients[client] = root ? "present" : "no skill directory";
    if (root)
      for (const [rel, f] of Object.entries(p.files))
        consider(path.join(root, ...rel.split("/")), root, f.sha256, f.prior, client + ":" + rel, data[rel], false);
    if (p.global && p.global.targets[client]) {
      const g = Buffer.from(p.global.data, "base64");
      if (sha(g) !== p.global.sha256) throw new Error("hash mismatch in transfer: global instructions");
      const file = expand(p.global.targets[client]);
      consider(file, path.dirname(file), p.global.sha256, record[file] ? [record[file]] : [], client + ":global", g, true);
    }
  }
  if (result.conflicts.length) { result.status = "conflict"; done(5); }
  for (const w of writes) result[w.kind].push(w.label);
  result.status = writes.length ? (p.dry_run ? "would update" : "updated") : "same";
  if (p.dry_run) done(0);
  for (const w of writes) {
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    const tmp = w.file + ".loadout-tmp";
    fs.writeFileSync(tmp, w.data);
    fs.renameSync(tmp, w.file);
    if (sha(fs.readFileSync(w.file)) !== sha(w.data)) throw new Error("verification failed after write: " + w.label);
    if (w.global) records[w.file] = sha(w.data);
  }
  if (Object.entries(records).some(([f, h]) => record[f] !== h)) {
    Object.assign(record, records);
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  }
  done(0);
} catch (e) {
  result.status = "failed";
  result.error = String(e && e.message || e);
  done(3);
}

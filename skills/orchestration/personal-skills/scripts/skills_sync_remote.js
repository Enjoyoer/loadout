// Install verified Loadout skill files and global instructions on this host.
// Shipped gzip+base64 by skills_sync.py; stdin is the gzip+base64 JSON payload
// {dry_run, clients, files: {"<skill>/<file>": {sha256, data, prior}},
//  global: {sha256, data, targets: {client: path}} | null}.
// Preflight first, write second: a file may be replaced only when it matches the
// desired blob or a prior publication (skills), or the last synced version
// (global instructions). Anything else is a conflict and nothing is written.
// global.claude may be "managed-settings:claudeMd": the claudeMd string field of
// Claude Code's managed-settings.json, preflighted by value; only that field changes.
// keep (null: retire nothing) names skills never retired. The record's skills section lists each
// skill file the sync installed or found current; a recorded skill not in keep is removed while
// every file in it is one of those, unedited, and otherwise kept, reported, and dropped from the record.
// Helpers come from remote_common.js, which fleet.run_node ships ahead of this file.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const { execFileSync } = require("child_process");
const result = { status: null, clients: {}, added: [], changed: [], same: 0, conflicts: [], elevation: [], retired: [], kept: [], error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const home = os.homedir();
const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
const CLIENT_HOMES = { codex: codexHome, claude: path.join(home, ".claude"), opencode: path.join(home, ".config", "opencode") };
const SKILL_ROOTS = { codex: path.join(codexHome, "skills"), claude: path.join(home, ".claude", "skills") };
const recordPath = path.join(loadoutDir(path, os), "global-sync.json");
const MANAGED_CLAUDE_MD = "managed-settings:claudeMd";
// Every other global target is a path: ~, /, $VAR or ${VAR}, %VAR%, or a drive like C:\.
const GLOBAL_PATH = /^(~([\\/]|$)|\/|\$\{?[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%|[A-Za-z]:[\\/])/;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");

// Expand ~, $CODEX_HOME, %VAR%, $VAR, and ${VAR}; unset variables stay as written and land in unresolved.
function expandVars(template, unresolved = []) {
  const env = (m, a, b) => process.env[a || b] || (unresolved.push(m), m);
  let p = template.replace(/\$CODEX_HOME|\$\{CODEX_HOME\}/g, codexHome)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, env)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, env);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(home, p.slice(1));
  return p;
}
const expand = template => path.resolve(expandVars(template));

// A global target that is not a path, or not absolute once expanded, is refused: never a file in the cwd.
function globalFile(client, target) {
  const unresolved = [];
  const p = GLOBAL_PATH.test(target) ? expandVars(target, unresolved) : "";
  if (!p || unresolved.length || !path.isAbsolute(p))
    throw new Error(`global.${client} is not an absolute path` + (client === "claude" ? ` or ${MANAGED_CLAUDE_MD}` : "")
      + `: ${JSON.stringify(target)}; refused, nothing written`);
  return path.resolve(p);
}

function managedSettingsPath() {
  const override = process.env.LOADOUT_CLAUDE_MANAGED_SETTINGS;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("LOADOUT_CLAUDE_MANAGED_SETTINGS must be an absolute path");
    return path.resolve(override);
  }
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform !== "win32") return "/etc/claude-code/managed-settings.json";
  const files = path.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json");
  const data = path.join(process.env.ProgramData || "C:\\ProgramData", "ClaudeCode", "managed-settings.json");
  return fs.existsSync(data) && !fs.existsSync(files) ? data : files;
}

// Preflight the claudeMd field by value: {kind, why?, settings, text, st}.
function planManaged(file, want, allowed) {
  checkAncestors(fs, path, path.dirname(file), file);
  if (!fs.existsSync(file)) return { kind: "added", settings: {}, text: "", st: null };
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) return { kind: "conflict", why: "not a regular file" };
  const text = fs.readFileSync(file, "utf8");
  let settings;
  try { settings = JSON.parse(text); } catch { return { kind: "conflict", why: "not valid JSON" }; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { kind: "conflict", why: "not a JSON object" };
  if (!Object.hasOwn(settings, "claudeMd")) return { kind: "added", settings, text, st };
  if (typeof settings.claudeMd !== "string") return { kind: "conflict", why: "claudeMd is not a string" };
  const have = sha(Buffer.from(settings.claudeMd, "utf8"));
  return { kind: have === want ? "same" : allowed.includes(have) ? "changed" : "conflict", settings, text, st };
}

// The same document with only claudeMd replaced, in the file's indent and line endings.
function renderManaged(plan, claudeMd) {
  const indent = (plan.text.match(/\n([ \t]+)"/) || [null, "  "])[1];
  const eol = plan.text.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify({ ...plan.settings, claudeMd }, null, indent).replace(/\n/g, eol);
  return Buffer.from(body + (plan.text && !plan.text.endsWith("\n") ? "" : eol));
}

// Whether this user can replace the file in place without changing its owner.
function canWrite(file) {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    if (fs.existsSync(file)) {
      const uid = process.getuid ? process.getuid() : null;
      if (uid !== null && uid !== 0 && fs.statSync(file).uid !== uid) return false;
      fs.closeSync(fs.openSync(file, "r+"));
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

function sudo(...args) {
  try { execFileSync("sudo", ["-n", ...args], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`sudo -n ${args[0]} failed: ${String(e.stderr || e.message).trim()}`); }
}

// Back up, replace atomically keeping owner and mode, then check that only claudeMd changed.
function writeManaged(w) {
  const { plan, bytes, elevate } = w.managed, st = plan.st, file = w.file;
  const mode = st ? st.mode & 0o7777 : 0o644;
  const backup = st ? `${file}.bak-${stamp}` : null, staged = file + ".loadout-tmp-" + crypto.randomBytes(8).toString("hex");
  if (!elevate) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (backup) { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, mode); }
      replaceFile(fs, file, bytes, mode, fd => {
        fs.fchmodSync(fd, mode);
        if (st && process.platform !== "win32") try { fs.fchownSync(fd, st.uid, st.gid); } catch { /* keep the user's group */ }
      });
    } catch (e) {
      if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
      throw new Error(`not permitted to write ${file} (${e.code})`
        + (process.platform === "win32" ? "; run the sync from an administrator shell" : ""));
    }
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-"));
    try {
      const tmp = path.join(dir, "managed-settings.json");
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      if (backup) sudo("cp", "-p", file, backup); else sudo("mkdir", "-p", path.dirname(file));
      sudo("cp", tmp, staged);
      if (st) sudo("chown", `${st.uid}:${st.gid}`, staged);
      sudo("chmod", mode.toString(8), staged);
      const own = fs.lstatSync(staged);
      if (!own.isFile() || own.uid !== (st ? st.uid : 0)) throw new Error("staged file is not ours: " + staged);
      sudo("mv", "-f", staged, file);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const now = JSON.parse(fs.readFileSync(file, "utf8")), after = fs.statSync(file);
  const others = o => JSON.stringify(Object.entries(o).filter(([k]) => k !== "claudeMd"));
  if (typeof now.claudeMd !== "string" || sha(Buffer.from(now.claudeMd, "utf8")) !== sha(w.data)
      || others(now) !== others(plan.settings) || (st && (after.uid !== st.uid || (after.mode & 0o7777) !== mode)))
    throw new Error("verification failed after write: " + w.label + (backup ? "; backup at " + backup : ""));
}

// Returns "same", "added", "changed", or "conflict".
function plan(file, root, want, allowed) {
  checkAncestors(fs, path, root, file);
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
      checkAncestors(fs, path, home, path.join(agentHome, 'skills', 'probe'));
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
  const before = JSON.stringify(record), owned = record.skills || {}, roots = [], drops = [];
  const writes = [], records = {};
  const retire = (root, skill, label) => {
    const dir = path.join(root, skill), tree = {};
    checkAncestors(fs, path, root, dir);
    const walk = d => fs.readdirSync(d).forEach(n => {
      const f = path.join(d, n), st = fs.lstatSync(f);
      if (st.isDirectory()) walk(f); else tree[path.relative(root, f).split(path.sep).join("/")] = st.isFile() && sha(fs.readFileSync(f));
    });
    let mine = false;
    if (fs.existsSync(dir)) {
      if (fs.lstatSync(dir).isDirectory()) { walk(dir); mine = Object.entries(tree).every(([r, h]) => h && owned[root][r] === h); }
      result[mine ? "retired" : "kept"].push(label);
    }
    drops.push({ root, skill, dir: mine && dir });
  };
  const consider = (file, root, want, allowed, label, bytes, isGlobal) => {
    const kind = plan(file, root, want, allowed);
    if (kind === "conflict") result.conflicts.push(label);
    else if (kind === "same") { result.same++; if (isGlobal) records[file] = want; }
    else writes.push({ file, key: file, label, kind, data: bytes, global: isGlobal });
  };
  const considerManaged = (label, g) => {
    const file = managedSettingsPath(), key = file + "#claudeMd", claudeMd = g.toString("utf8");
    if (!Buffer.from(claudeMd, "utf8").equals(g)) throw new Error("global instructions are not UTF-8 text; claudeMd needs text");
    const plan = planManaged(file, p.global.sha256, record[key] ? [record[key]] : []);
    if (plan.kind === "conflict") return result.conflicts.push(`${label} (managed settings claudeMd${plan.why ? ": " + plan.why : ""})`);
    if (plan.kind === "same") { result.same++; records[key] = p.global.sha256; return; }
    const elevate = !canWrite(file);
    if (elevate) result.elevation.push(label + (process.platform === "win32" ? " (administrator)" : " (sudo -n)"));
    writes.push({ file, key, label, kind: plan.kind, data: g, global: true,
      managed: { plan, bytes: renderManaged(plan, claudeMd), elevate } });
  };
  for (const client of p.clients) {
    if (!CLIENT_HOMES[client] || !fs.existsSync(CLIENT_HOMES[client])) { result.clients[client] = "absent"; continue; }
    const root = SKILL_ROOTS[client];
    result.clients[client] = root ? "present" : "no skill directory";
    if (root) {
      roots.push(root);
      for (const [rel, f] of Object.entries(p.files))
        consider(path.join(root, ...rel.split("/")), root, f.sha256, f.prior, client + ":" + rel, data[rel], false);
      for (const skill of p.keep ? new Set(Object.keys(owned[root] || {}).map(r => r.split("/")[0])) : [])
        if (!p.keep.includes(skill)) retire(root, skill, client + ":" + skill);
    }
    if (p.global && p.global.targets[client]) {
      const g = Buffer.from(p.global.data, "base64");
      if (sha(g) !== p.global.sha256) throw new Error("hash mismatch in transfer: global instructions");
      const target = p.global.targets[client];
      if (target === MANAGED_CLAUDE_MD && client === "claude") { considerManaged(client + ":global", g); continue; }
      const file = globalFile(client, target);
      consider(file, path.dirname(file), p.global.sha256, record[file] ? [record[file]] : [], client + ":global", g, true);
    }
  }
  if (result.conflicts.length) { result.status = "conflict"; done(5); }
  for (const w of writes) result[w.kind].push(w.label);
  result.status = writes.length + result.retired.length + result.kept.length ? (p.dry_run ? "would update" : "updated") : "same";
  if (p.dry_run) done(0);
  // Elevation is checked before any write, and never prompts.
  for (const w of writes.filter(x => x.managed && x.managed.elevate)) {
    if (process.platform === "win32")
      throw new Error(`${w.file} is not writable; run the sync from an administrator shell; nothing written`);
    try { sudo("true"); } catch (e) { throw new Error("elevation needs a password; nothing written (" + e.message + ")"); }
  }
  for (const w of writes) {
    if (w.managed) { writeManaged(w); records[w.key] = sha(w.data); continue; }
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    replaceFile(fs, w.file, w.data);
    if (sha(fs.readFileSync(w.file)) !== sha(w.data)) throw new Error("verification failed after write: " + w.label);
    if (w.global) records[w.key] = sha(w.data);
  }
  for (const d of drops) {
    if (d.dir) fs.rmSync(d.dir, { recursive: true });
    for (const r of Object.keys(owned[d.root])) if (r.startsWith(d.skill + "/")) delete owned[d.root][r];
  }
  for (const root of roots) for (const [rel, f] of Object.entries(p.files)) (owned[root] = owned[root] || {})[rel] = f.sha256;
  Object.assign(record, records, Object.keys(owned).length ? { skills: owned } : {});
  if (JSON.stringify(record) !== before) {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    replaceFile(fs, recordPath, JSON.stringify(record, null, 2), 0o600);
  }
  done(0);
} catch (e) {
  result.status = "failed";
  result.error = String(e && e.message || e);
  done(3);
}

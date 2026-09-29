// Stage, install, and confirm verified Loadout Paseo plugins on this host.
// Shipped gzip+base64 by plugins_sync.py; stdin is the gzip+base64 JSON payload
// {dry_run, plugin_root, stage, install, migrate_path, plugins: {id: {pin, files: {rel: {sha256, data, prior}}}}}.
// Never writes plugin settings, plugin state, or pluginsEnabled, and never arms a plugin. The one
// exception is migrate_path: `paseo plugin remove` deletes <PASEO_HOME>/plugin-settings/<id>, so a
// migration backs that directory up first and restores the host's own bytes, hash-verified.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const { execSync } = require("child_process");
const result = { status: null, plugins: {}, conflicts: [], daemon: null, error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const home = os.homedir();
const SKIP = new Set(["node_modules", ".git"]);

function expand(template) {
  let p = template.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, v) => process.env[v] || m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, v) => process.env[v] || m);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(home, p.slice(1));
  return path.resolve(p);
}

function checkAncestors(root, file) {
  let cur = path.dirname(root);
  const parts = path.relative(cur, path.dirname(file)).split(path.sep);
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) return;
    const st = fs.lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("not a real directory: " + cur);
  }
}

function hashTree(dir, skip = SKIP, rel = "", out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!rel && skip.has(name)) continue;
    const full = path.join(dir, name), r = rel ? rel + "/" + name : name, st = fs.lstatSync(full);
    if (st.isDirectory() && !st.isSymbolicLink()) hashTree(full, skip, r, out);
    else if (st.isFile()) out[r] = sha(fs.readFileSync(full));
  }
  return out;
}

function sh(command, cwd, timeout = 900000) {
  return execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, env: process.env });
}

const WINDOWS_PASEO = "C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd";
function paseo(args) {
  const bins = ["paseo"];
  if (process.platform === "win32" && fs.existsSync(WINDOWS_PASEO)) bins.push(`"${WINDOWS_PASEO}"`);
  let last;
  for (const bin of bins) {
    try { return sh(bin + " " + args, undefined, 120000); } catch (e) { last = e; }
  }
  throw new Error(("paseo " + args + ": " + String(last.stderr || last.message)).trim().slice(0, 300));
}

// Semver range of space-separated comparators; a prerelease never satisfies.
function satisfies(version, range) {
  const m = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(-\S+)?$/);
  if (!m || m[4]) return false;
  const v = m.slice(1, 4).map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  return range.trim().split(/\s+/).every(part => {
    const c = part.match(/^(>=|<=|>|<|=)?v?(\d+)\.(\d+)\.(\d+)$/);
    if (!c) throw new Error("unsupported version range: " + range);
    const d = cmp(v, c.slice(2, 5).map(Number));
    return { ">=": d >= 0, "<=": d <= 0, ">": d > 0, "<": d < 0, "=": d === 0, undefined: d === 0 }[c[1]];
  });
}

const paseoHome = () => process.env.PASEO_HOME || path.join(home, ".paseo");
function daemonConfig() {
  const file = path.join(paseoHome(), "config.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

const sameTree = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");

// Move an installed plugin to `dir`: back up its settings, remove, install, restore the same bytes, reload.
function migrate(id, dir, from) {
  const settings = path.join(paseoHome(), "plugin-settings", id);
  const had = fs.existsSync(settings), want = had ? hashTree(settings, new Set()) : {};
  const backup = path.join(paseoHome(), "plugin-settings.bak-loadout-" + stamp, id);
  if (had) {
    fs.cpSync(settings, backup, { recursive: true });
    if (!sameTree(hashTree(backup, new Set()), want)) throw new Error("settings backup did not verify: " + backup);
  }
  const keep = had ? "; settings backup kept at " + backup : "";
  try {
    paseo("plugin remove " + id);
    paseo(`plugin install "${dir}"`);
  } catch (e) {
    throw new Error(e.message + keep + "; the plugin may be removed, reinstall it from " + dir);
  } finally {
    if (had) {
      fs.rmSync(settings, { recursive: true, force: true });
      fs.cpSync(backup, settings, { recursive: true });
      if (!sameTree(hashTree(settings, new Set()), want)) throw new Error("restored settings did not verify" + keep);
    }
  }
  if (!had) return `migrated from ${from}; no settings to carry`;
  paseo("plugin reload " + id);
  return `migrated from ${from}; settings restored (${Object.keys(want).length} files, hashes verified)${keep}`;
}

try {
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64")).toString());
  const data = {};
  for (const [id, plugin] of Object.entries(p.plugins))
    for (const [rel, f] of Object.entries(plugin.files)) {
      if (rel.split("/").some(x => !x || x === "." || x === "..")) throw new Error("invalid path from source: " + rel);
      const buf = Buffer.from(f.data, "base64");
      if (sha(buf) !== f.sha256) throw new Error("hash mismatch in transfer: " + id + "/" + rel);
      data[id + "/" + rel] = buf;
    }

  // Plugins managed elsewhere: report whether the installed source matches.
  if (p.plugin_root === null) {
    const cfg = daemonConfig();
    for (const id of Object.keys(p.plugins)) {
      const dir = cfg.plugins && cfg.plugins[id] && cfg.plugins[id].path;
      if (!dir) { result.plugins[id] = { state: "not installed" }; continue; }
      const have = hashTree(dir), want = p.plugins[id].files;
      const differ = Object.keys(want).filter(r => have[r] !== want[r].sha256);
      result.plugins[id] = { state: differ.length ? "differs" : "matches", differ: differ.slice(0, 8) };
    }
    result.status = Object.values(result.plugins).every(x => x.state === "matches") ? "same" : "drift";
    done(0);
  }

  // 1. Stage: preflight every file of every staged plugin before writing any.
  const root = expand(p.plugin_root);
  const writes = [];
  for (const id of p.stage) {
    const dir = path.join(root, id), plugin = p.plugins[id];
    const info = result.plugins[id] = { staged: "same", checked: false, installed: null, running: null };
    for (const [rel, f] of Object.entries(plugin.files)) {
      const file = path.join(dir, ...rel.split("/"));
      checkAncestors(root, file);
      if (!fs.existsSync(file)) { writes.push({ id, file, buf: data[id + "/" + rel] }); info.staged = "changed"; continue; }
      const st = fs.lstatSync(file);
      const have = st.isFile() && !st.isSymbolicLink() ? sha(fs.readFileSync(file)) : null;
      if (have === f.sha256) continue;
      if (have && f.prior.includes(have)) { writes.push({ id, file, buf: data[id + "/" + rel] }); info.staged = "changed"; }
      else result.conflicts.push(id + "/" + rel);
    }
  }
  if (result.conflicts.length) { result.status = "conflict"; done(5); }

  // Daemon gates for install: version inside every pin, and pluginsEnabled already true.
  let gate = null;
  if (p.install.length) {
    // Pin-check the running daemon, not the CLI on PATH: they can differ after a staged upgrade.
    let version = null, cli = null;
    try { cli = paseo("--version").trim().split(/\s+/).pop(); } catch (e) { gate = "paseo CLI not found"; }
    if (!gate) {
      try { version = JSON.parse(paseo("daemon status --json")).daemonVersion || null; } catch (e) { /* below */ }
      if (!version) gate = "the running daemon did not report its version (paseo daemon status --json)";
    }
    const enabled = daemonConfig().pluginsEnabled === true;
    result.daemon = { version, cli, pluginsEnabled: enabled };
    if (!gate && !enabled) gate = "pluginsEnabled is not true on this daemon; the owner must allow trusted plugins first";
    for (const id of p.install)
      if (!gate && !satisfies(version, p.plugins[id].pin)) gate = `paseo ${version} is outside ${id}'s pin ${p.plugins[id].pin}`;
  }

  // An install ID already installed from another directory needs migrate_path.
  const elsewhere = {};
  for (const id of p.install) {
    const current = (daemonConfig().plugins || {})[id];
    if (current && current.path && path.resolve(current.path) !== path.join(root, id)) elsewhere[id] = current;
  }

  if (p.dry_run) {
    let blockedHere = !!gate, migrating = false;
    for (const id of p.stage) {
      if (!p.install.includes(id)) continue;
      const info = result.plugins[id], from = elsewhere[id];
      if (gate) info.installed = "blocked: " + gate;
      else if (from && !p.migrate_path) { info.installed = "blocked: installed from " + from.path + " (use --migrate-path)"; blockedHere = true; }
      else if (from && from.enabled === false) { info.installed = "blocked: disabled plugin installed from " + from.path; blockedHere = true; }
      else if (from) { info.installed = "would migrate from " + from.path + " (settings backed up and restored)"; migrating = true; }
      else info.installed = "would install or reload";
    }
    const changed = migrating || p.stage.some(id => result.plugins[id].staged === "changed");
    result.status = blockedHere ? "blocked" : changed ? "would update" : "same";
    done(0);
  }

  for (const w of writes) {
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    fs.writeFileSync(w.file + ".loadout-tmp", w.buf);
    fs.renameSync(w.file + ".loadout-tmp", w.file);
    if (sha(fs.readFileSync(w.file)) !== sha(w.buf)) throw new Error("verification failed after write: " + w.file);
  }

  let failed = false;
  // 2. Check: npm ci and the package's check (or typecheck) script, when staged source changed or deps are missing.
  for (const id of p.stage) {
    const dir = path.join(root, id), info = result.plugins[id];
    if (info.staged === "same" && fs.existsSync(path.join(dir, "node_modules"))) { info.checked = "skipped (unchanged)"; continue; }
    const scripts = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts || {};
    const script = scripts.check ? "check" : scripts.typecheck ? "typecheck" : null;
    try {
      sh("npm ci", dir);
      if (script) sh("npm run " + script, dir);
      info.checked = script || "no check script";
    } catch (e) {
      info.checked = "FAILED: " + String(e.stderr || e.message).trim().split("\n").slice(-3).join(" ").slice(0, 300);
      failed = true;
    }
  }

  // 3. Install or reload, then confirm running and enabled.
  let blocked = false;
  for (const id of p.install) {
    const info = result.plugins[id], dir = path.join(root, id);
    if (typeof info.checked === "string" && info.checked.startsWith("FAILED")) { info.installed = "skipped (check failed)"; continue; }
    if (gate) { info.installed = "blocked: " + gate; blocked = true; continue; }
    const current = (daemonConfig().plugins || {})[id], from = elsewhere[id];
    try {
      if (from && !p.migrate_path) {
        info.installed = "blocked: installed from " + from.path + " (use --migrate-path)"; blocked = true; continue;
      }
      if (from && from.enabled === false) {
        info.installed = "blocked: disabled plugin installed from " + from.path; blocked = true; continue;
      }
      if (from) info.installed = migrate(id, dir, from.path);
      else if (!current) { paseo(`plugin install "${dir}"`); info.installed = "installed"; }
      else if (info.staged === "changed") { paseo("plugin reload " + id); info.installed = "reloaded"; }
      else info.installed = "already installed";
      const listed = JSON.parse(paseo("plugin ls --json")).find(x => x.id === id);
      info.running = !!listed && listed.status === "running" && listed.enabled === true;
      if (!info.running) { info.installed += "; not running: " + (listed ? (listed.error || listed.status) : "missing"); failed = true; }
    } catch (e) {
      info.installed = "FAILED: " + String(e.message).slice(0, 300);
      failed = true;
    }
  }
  const changed = p.stage.some(id => result.plugins[id].staged === "changed")
    || Object.values(result.plugins).some(x => x.installed === "installed" || x.installed === "reloaded"
      || String(x.installed).startsWith("migrated"));
  result.status = failed ? "failed" : blocked ? "blocked" : changed ? "updated" : "same";
  done(failed ? 3 : 0);
} catch (e) {
  result.status = "failed";
  result.error = String(e && e.message || e);
  done(3);
}

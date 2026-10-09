// Merge managed Codex and Claude Code settings into this host's client config.
// Shipped gzip+base64 by client_config.py; stdin is the gzip+base64 JSON payload
// {codex: {top, sections, reportOnly}, claude: {settings, env, token_env, minVersion},
//  token, stamp, dry_run, update_claude}. The token arrives only on stdin and is
// never printed. Only managed keys are written; everything else stays host-local.
// replaceFile comes from remote_common.js, which fleet.run_node ships ahead of this file.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const { execSync } = require("child_process");
const result = { codex: null, claude: null, claude_code: null, error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}

// Managed keys, section names and reportOnly entries become TOML lines and a regex: bare
// keys, optionally dotted, only.
const TOML_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
function checkNames(codex) {
  const names = [...Object.keys(codex.top), ...codex.reportOnly];
  for (const [name, keys] of Object.entries(codex.sections)) names.push(name, ...Object.keys(keys));
  const bad = names.filter(n => typeof n !== "string" || !TOML_NAME.test(n));
  if (bad.length) throw new Error("refused, nothing written: managed Codex names must be bare TOML keys: " + JSON.stringify(bad));
}

function tomlValue(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  throw new Error("unsupported TOML value for a managed key");
}

// Line-based merge: keeps CRLF, comments, other keys and other sections.
function mergeToml(text, top, sections) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const changes = [];
  const header = l => l.match(/^\s*\[([^\]]+)\]\s*$/);
  const keyOf = l => (l.match(/^\s*([A-Za-z0-9_.-]+)\s*=/) || [])[1];
  let firstHeader = lines.findIndex(l => header(l));
  if (firstHeader < 0) firstHeader = lines.length;
  for (const [k, v] of Object.entries(top)) {
    const want = `${k} = ${tomlValue(v)}`;
    const i = lines.slice(0, firstHeader).findIndex(l => keyOf(l) === k);
    if (i >= 0) { if (lines[i].trim() !== want) { lines[i] = want; changes.push(k); } }
    else {
      // Insert before the blank lines that precede the first header.
      let at = firstHeader;
      while (at > 0 && lines[at - 1].trim() === "") at--;
      lines.splice(at, 0, want); firstHeader++; changes.push("+" + k);
    }
  }
  for (const [name, keys] of Object.entries(sections)) {
    let start = lines.findIndex(l => (header(l) || [])[1] === name);
    if (start < 0) {
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(`[${name}]`);
      start = lines.length - 1;
      changes.push("+[" + name + "]");
    }
    let end = lines.findIndex((l, i) => i > start && header(l));
    if (end < 0) end = lines.length;
    for (const [k, v] of Object.entries(keys)) {
      const want = `${k} = ${tomlValue(v)}`;
      const i = lines.slice(start + 1, end).findIndex(l => keyOf(l) === k);
      if (i >= 0) { if (lines[start + 1 + i].trim() !== want) { lines[start + 1 + i] = want; changes.push(name + "." + k); } }
      else {
        let at = end;
        while (at > start + 1 && lines[at - 1].trim() === "") at--;
        lines.splice(at, 0, want); end++; changes.push("+" + name + "." + k);
      }
    }
  }
  return { text: lines.join(eol), changes };
}

function write(p, file, before, after) {
  if (p.dry_run || before === after) return null;
  let backup = null;
  if (before !== null) {
    backup = `${file}.bak-loadout-${p.stamp}`;
    fs.copyFileSync(file, backup);
  }
  replaceFile(fs, file, after, 0o600);
  return backup && path.basename(backup);
}

// sort -V style: compare the numeric runs left to right.
function versionAtLeast(have, want) {
  const a = (have.match(/\d+/g) || []).map(Number), b = (want.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

function claudeVersion() {
  try {
    const out = execSync("claude --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
    return (out.trim().split(/\s+/)[0]) || null;
  } catch (e) { return null; }
}

try {
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64")).toString());
  checkNames(p.codex);

  const codexFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  if (!fs.existsSync(codexFile)) result.codex = { status: "absent" };
  else {
    const before = fs.readFileSync(codexFile, "utf8");
    const r = mergeToml(before, p.codex.top, p.codex.sections);
    const report = {};
    for (const k of p.codex.reportOnly) {
      const m = before.split(/\r?\n/).find(l => new RegExp(`^\\s*${k.replace(/[.]/g, "\\.")}\\s*=`).test(l));
      report[k] = m ? m.split("=").slice(1).join("=").trim() : "unset";
    }
    result.codex = { status: r.changes.length ? "changed" : "unchanged", changes: r.changes,
                     backup: write(p, codexFile, before, r.text), report };
  }

  const claudeFile = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(path.dirname(claudeFile))) result.claude = { status: "absent" };
  else {
    const before = fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile, "utf8") : null;
    const cfg = before ? JSON.parse(before) : {};
    const changes = [];
    for (const [k, v] of Object.entries(p.claude.settings)) {
      if (JSON.stringify(cfg[k]) !== JSON.stringify(v)) { cfg[k] = v; changes.push(k); }
    }
    const env = Object.assign({}, p.claude.env);
    if (p.claude.token_env) {
      if (!p.token) throw new Error("token required for " + p.claude.token_env);
      env[p.claude.token_env] = p.token;
    }
    if (Object.keys(env).length) cfg.env = cfg.env || {};
    for (const [k, v] of Object.entries(env)) {
      if (cfg.env[k] !== v) { cfg.env[k] = v; changes.push("env." + k); }
    }
    const after = changes.length ? JSON.stringify(cfg, null, 2) + "\n" : before;
    result.claude = { status: changes.length ? "changed" : "unchanged", changes,
                      backup: write(p, claudeFile, before, after) };
  }

  if (p.claude.minVersion && result.claude.status !== "absent") {
    const have = claudeVersion();
    const cc = { have, min: p.claude.minVersion, ok: !!have && versionAtLeast(have, p.claude.minVersion), updated_to: null };
    if (!cc.ok && p.update_claude && !p.dry_run && have) {
      try { execSync("claude update", { stdio: "ignore", timeout: 600000 }); } catch (e) { /* reported below */ }
      cc.updated_to = claudeVersion();
      cc.ok = !!cc.updated_to && versionAtLeast(cc.updated_to, p.claude.minVersion);
    }
    result.claude_code = cc;
  }
  done(0);
} catch (e) {
  result.error = String(e && e.message || e);
  done(3);
}

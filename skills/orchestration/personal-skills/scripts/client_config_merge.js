// Merge managed Codex and Claude Code settings into this host's client config.
// Shipped by client_config.py through fleet.run_node in a digest-checked stdin envelope; process.argv[2] is the gzip+base64 JSON payload
// {codex: {top, sections, reportOnly}, claude: {settings, env, token_env, minVersion},
//  token, stamp, dry_run, update_claude}. The token arrives only on stdin and is
// never printed. Only managed keys are written; everything else stays host-local.
// replaceFile comes from remote_common.js, which fleet.run_node ships ahead of this file.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const { execSync, execFileSync } = require("child_process");
// Test-only hook: LOADOUT_TEST_CLAUDE is a JSON [interpreter, fake script] run as argv, without a shell.
// It is never set outside tests; unset, claude runs through the shell strings below unchanged.
const testClaude = process.env.LOADOUT_TEST_CLAUDE;
function runTestClaude(arg, options) {
  const [interpreter, script] = JSON.parse(testClaude);
  return execFileSync(interpreter, [script, arg], options);
}
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

// A conservative TOML structure scan, one record per line: blank, comment, a table header (its key path, and
// whether it is an array table), a key line (its key path), or "more", a line inside a multiline string, array or
// inline table. Only a header or key line starts a statement. Anything it cannot read safely is refused.
function tomlScan(lines) {
  const refuse = n => new Error(`refused, nothing written: config.toml line ${n + 1} is TOML the merge cannot read safely`);
  const out = [];
  let ml = null, depth = 0;
  // A dotted key path from i, bare or quoted parts, whitespace around the dots; returns [keys, index after it].
  const keyPath = (line, i, n) => {
    for (const keys = []; ; i++) {
      while (line[i] === " " || line[i] === "\t") i++;
      const q = line[i], bare = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (q === '"' || q === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== q) j += q === '"' && line[j] === "\\" ? 2 : 1;
        if (j >= line.length) throw refuse(n);
        try { keys.push(q === '"' ? JSON.parse(line.slice(i, j + 1)) : line.slice(i + 1, j)); } catch (e) { throw refuse(n); }
        i = j + 1;
      } else if (bare) { keys.push(bare[0]); i += bare[0].length; }
      else throw refuse(n);
      while (line[i] === " " || line[i] === "\t") i++;
      if (line[i] !== ".") return [keys, i];
    }
  };
  // Follow a value from i to the end of its line: strings, comments, and array or inline-table nesting.
  const value = (line, i, n) => {
    while (i < line.length) {
      if (ml) {
        if (ml === '"""' && line[i] === "\\") { i += 2; continue; }
        if (!line.startsWith(ml, i)) { i++; continue; }
        let j = i + 3;
        while (line[j] === ml[0] && j - i < 5) j++;  // up to two more quotes belong to the string
        i = j; ml = null; continue;
      }
      const c = line[i];
      if (c === "#") return;
      if (c === '"' || c === "'") {
        if (line.startsWith(c.repeat(3), i)) { ml = c.repeat(3); i += 3; continue; }
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += c === '"' && line[j] === "\\" ? 2 : 1;
        if (j >= line.length) throw refuse(n);
        i = j + 1; continue;
      }
      if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && --depth < 0) throw refuse(n);
      i++;
    }
  };
  lines.forEach((line, n) => {
    const t = line.trim();
    if (ml || depth) { out.push({ kind: "more" }); value(line, 0, n); }
    else if (!t) out.push({ kind: "blank" });
    else if (t[0] === "#") out.push({ kind: "comment" });
    else if (t[0] === "[") {
      const array = t[1] === "[", [keys, i] = keyPath(t, array ? 2 : 1, n), close = array ? "]]" : "]";
      if (!t.startsWith(close, i) || !/^\s*(#.*)?$/.test(t.slice(i + close.length))) throw refuse(n);
      out.push({ kind: "header", keys, array });
    } else {
      const [keys, i] = keyPath(t, 0, n);
      if (t[i] !== "=") throw refuse(n);
      out.push({ kind: "key", keys });
      value(t, i + 1, n);
    }
  });
  if (ml || depth) throw refuse(lines.length - 1);
  return out;
}

const samePath = (keys, name) => keys.join("\u0000") === name.split(".").join("\u0000");

// The merged document must still scan, and define no table or key twice: a header the merge appended for a
// section it did not recognize, or a key it inserted beside one it did not, would make the file invalid.
function tomlCheck(text) {
  const id = keys => JSON.stringify(keys), tables = new Set(), arrays = [], taken = new Set();
  let table = [], nested = false, seen = new Set();
  for (const line of tomlScan(text.split(/\r?\n/))) {
    if (line.kind === "header") {
      nested = line.array || arrays.some(a => a.every((k, i) => line.keys[i] === k));
      if (line.array) arrays.push(line.keys);
      else if (!nested && (tables.has(id(line.keys)) || taken.has(id(line.keys))))
        throw new Error(`refused, nothing written: the merged config.toml would define [${line.keys.join(".")}] twice`);
      else if (!nested) tables.add(id(line.keys));
      table = line.keys; seen = new Set();
    } else if (line.kind === "key") {
      if (seen.has(id(line.keys)))
        throw new Error(`refused, nothing written: the merged config.toml would set ${[...table, ...line.keys].join(".")} twice`);
      seen.add(id(line.keys));
      // A key line defines its value and, for a dotted key, the tables leading to it.
      const full = [...table, ...line.keys];
      for (let n = table.length + 1; !nested && n <= full.length; n++) taken.add(id(full.slice(0, n)));
    }
  }
  for (const key of tables) if (taken.has(key) || arrays.some(a => id(a) === key))
    throw new Error(`refused, nothing written: the merged config.toml would define [${JSON.parse(key).join(".")}] twice`);
}

// Line-based merge on the scan: keeps CRLF, comments, other keys and other sections.
function mergeToml(text, top, sections) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const changes = [];
  // Set a key at line i, replacing its whole value (with any continuation lines), or insert it at `at`, above
  // the blank lines that precede the next header but not above floor.
  const put = (kinds, i, at, floor, want, label) => {
    if (i >= 0) {
      let n = 1;
      while (kinds[i + n] && kinds[i + n].kind === "more") n++;
      if (n > 1 || lines[i].trim() !== want) { lines.splice(i, n, want); changes.push(label); }
      return;
    }
    while (at > floor && kinds[at - 1].kind === "blank") at--;
    lines.splice(at, 0, want); changes.push("+" + label);
  };
  for (const [k, v] of Object.entries(top)) {
    const kinds = tomlScan(lines);
    let first = kinds.findIndex(l => l.kind === "header");
    if (first < 0) first = lines.length;
    put(kinds, kinds.findIndex((l, i) => i < first && l.kind === "key" && samePath(l.keys, k)), first, 0,
        `${k} = ${tomlValue(v)}`, k);
  }
  for (const [name, keys] of Object.entries(sections)) {
    if (!tomlScan(lines).some(l => l.kind === "header" && !l.array && samePath(l.keys, name))) {
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(`[${name}]`);
      changes.push("+[" + name + "]");
    }
    for (const [k, v] of Object.entries(keys)) {
      const kinds = tomlScan(lines);
      const start = kinds.findIndex(l => l.kind === "header" && !l.array && samePath(l.keys, name));
      let end = kinds.findIndex((l, i) => i > start && l.kind === "header");
      if (end < 0) end = lines.length;
      put(kinds, kinds.findIndex((l, i) => i > start && i < end && l.kind === "key" && samePath(l.keys, k)),
          end, start + 1, `${k} = ${tomlValue(v)}`, name + "." + k);
    }
  }
  const merged = lines.join(eol);
  tomlCheck(merged);
  return { text: merged, changes };
}

// Replace file only while it still holds the bytes the merge read, after backing up exactly those bytes under a
// name no other run uses. A change anyone made in between is never overwritten: the next run merges onto it.
function write(p, file, bytes, before, after) {
  if (p.dry_run || before === after) return null;
  let backup = null;
  if (bytes !== null) {
    backup = `${file}.bak-loadout-${p.stamp}-${require("crypto").randomBytes(4).toString("hex")}`;
    fs.writeFileSync(backup, bytes, { mode: 0o600, flag: "wx" });
    if (!fs.readFileSync(backup).equals(bytes)) throw new Error("backup did not verify: " + backup);
  }
  const now = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (now === null ? bytes !== null : bytes === null || !now.equals(bytes)) {
    if (backup) fs.rmSync(backup, { force: true });
    throw new Error(path.basename(file) + " changed during the merge, so it was left as is; the next run merges onto it");
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
    const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 };
    const out = testClaude ? runTestClaude("--version", options) : execSync("claude --version", options);
    return (out.trim().split(/\s+/)[0]) || null;
  } catch (e) { return null; }
}

try {
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(process.argv[2], "base64")).toString());
  checkNames(p.codex);

  const codexFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  if (!fs.existsSync(codexFile)) result.codex = { status: "absent" };
  else {
    const bytes = fs.readFileSync(codexFile), before = bytes.toString("utf8");
    const r = mergeToml(before, p.codex.top, p.codex.sections);
    const report = {}, lines = before.split(/\r?\n/), kinds = tomlScan(lines);
    let first = kinds.findIndex(l => l.kind === "header");
    if (first < 0) first = lines.length;
    for (const k of p.codex.reportOnly) {
      const i = kinds.findIndex((l, n) => n < first && l.kind === "key" && samePath(l.keys, k));
      report[k] = i >= 0 ? lines[i].split("=").slice(1).join("=").trim() : "unset";
    }
    result.codex = { status: r.changes.length ? "changed" : "unchanged", changes: r.changes,
                     backup: write(p, codexFile, bytes, before, r.text), report };
  }

  const claudeFile = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(path.dirname(claudeFile))) result.claude = { status: "absent" };
  else {
    const bytes = fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile) : null, before = bytes && bytes.toString("utf8");
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
                      backup: write(p, claudeFile, bytes, before, after) };
  }

  if (p.claude.minVersion && result.claude.status !== "absent") {
    const have = claudeVersion();
    const cc = { have, min: p.claude.minVersion, ok: !!have && versionAtLeast(have, p.claude.minVersion), updated_to: null };
    if (!cc.ok && p.update_claude && !p.dry_run && have) {
      const options = { stdio: "ignore", timeout: 600000 };
      try { testClaude ? runTestClaude("update", options) : execSync("claude update", options); } catch (e) { /* reported below */ }
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

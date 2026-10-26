// Launch a harness with fleet credentials in memory only. Never source shell code.
// mcp-env.json holds {servers, providers}: MCP servers whose env files load for every wrapped harness, and per
// provider launch settings (`tokenFiles`, `args`) for the harness named by `--provider <id>`. A bare array is the
// servers list from before provider settings. On Windows a server has no env file: its token is a user environment
// variable, read afresh at each launch.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const file = path.join(__dirname, 'mcp-env.json');
const windows = process.platform === 'win32';
// Only these codes mean a path is absent; any other error propagates.
const absent = e => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
// A file that is present but not owner-only, or not a single safe value.
class Unsafe extends Error {}
// The Windows owner-only check, in PowerShell's .NET: no cmdlet module autoloads, which stalls in a sparse
// environment. It refuses a link, junction or other reparse point on the path, opens the file sharing only reads
// (so it cannot be replaced, renamed or written while open), and judges the ACL of that open handle, the bytes it
// then reads coming from the same handle: inheritance off, an owner that is the current user, SYSTEM or
// Administrators, allow rules only for those or OWNER RIGHTS (which grants only the owner), and one for the
// current user. SIDs, so a localized name cannot slip through. The path arrives in the environment, never in the
// script text; the value leaves only base64 on stdout, to this process.
const OWNER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:LOADOUT_OWNER_FILE
$link = {
  $q = $p
  while ($q) {
    if ([IO.File]::GetAttributes($q).HasFlag([IO.FileAttributes]::ReparsePoint)) { return $q }
    $q = [IO.Path]::GetDirectoryName($q)
  }
}
$l = & $link
if ($l) { 'unsafe:a link or junction at ' + $l; exit }
$fs = [IO.FileStream]::new($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $acl = $fs.GetAccessControl()
  $sid = [Security.Principal.SecurityIdentifier]
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $ok = @($me, 'S-1-5-18', 'S-1-5-32-544')
  $allow = @(@($acl.GetAccessRules($true, $true, $sid)).Where({ $_.AccessControlType -eq 'Allow' }))
  $bad = @($allow.Where({ ($ok + 'S-1-3-4') -notcontains $_.IdentityReference.Value }))
  $mine = @($allow.Where({ $_.IdentityReference.Value -eq $me }))
  $name = { param($r) try { $r.IdentityReference.Translate([Security.Principal.NTAccount]).Value } catch { $r.IdentityReference.Value } }
  $why = @()
  if (-not $acl.AreAccessRulesProtected) { $why += 'ACL inheritance on' }
  if ($ok -notcontains $acl.GetOwner($sid).Value) { $why += 'owned by another account' }
  if ($bad.Count) { $why += 'other accounts allowed: ' + (@($bad.ForEach({ & $name $_ })) -join ' and ') }
  if (-not $mine.Count) { $why += 'no rule for the current user' }
  if ($fs.Length -lt 1 -or $fs.Length -gt 65536) { $why += 'empty or over 64 KiB' }
  $l = & $link
  if ($l) { $why += 'a link or junction at ' + $l }
  if ($why.Count) { 'unsafe:' + ($why -join ', ') }
  elseif ($env:LOADOUT_OWNER_READ -eq '1') {
    $b = [byte[]]::new($fs.Length); $n = 0
    while ($n -lt $b.Length) { $r = $fs.Read($b, $n, $b.Length - $n); if ($r -le 0) { throw 'short read' }; $n += $r }
    'ok:' + [Convert]::ToBase64String($b)
  } else { 'ok' }
} finally { $fs.Dispose() }
`;
// Windows system programs by absolute path, never by bare name: a bare name would also find a planted program in the
// harness's cwd, which Windows searches first.
const system32 = exe => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
function windowsOwnerFile(target, read) {
  const env = { ...process.env, LOADOUT_OWNER_FILE: target };
  delete env.LOADOUT_OWNER_READ;
  if (read) env.LOADOUT_OWNER_READ = '1';
  const out = execFileSync(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(OWNER_SCRIPT, 'utf16le').toString('base64')], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true }).trim();
  if (out.startsWith('unsafe:')) throw new Unsafe(out.slice(7));
  if (!read && out === 'ok') return true;
  if (read && out.startsWith('ok:')) return Buffer.from(out.slice(3), 'base64').toString('utf8');
  throw Error('owner-only check gave no verdict');
}
// HOME is the trusted boundary, and macOS may spell its temporary root through /var. Canonicalize that boundary,
// but still refuse links anywhere below it. The file must be owner-only: on POSIX mode 0600 and our uid, checked on
// the descriptor read; on Windows the ACL check above. Returns the file's text when read is set, else true; throws when unsafe.
function ownerFile(name, read) {
  const target = name.replace(/^~(?=[\\/])/, fs.realpathSync(os.homedir()));
  if (!path.isAbsolute(target)) throw new Unsafe('not an absolute path');
  for (const part of [target, ...parents(path.dirname(target))]) {
    const st = fs.lstatSync(part);
    if (st.isSymbolicLink() || (part === target ? !st.isFile() : !st.isDirectory()))
      throw new Unsafe('a link or wrong file type at ' + part);
  }
  if (windows) return windowsOwnerFile(target, read);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || !st.size || st.size > 65536) throw new Unsafe('empty or over 64 KiB');
    if ((st.mode & 0o777) !== 0o600 || st.uid !== process.getuid()) throw new Unsafe('not mode 0600 and ours');
    return read ? fs.readFileSync(fd, 'utf8') : true;
  } finally { fs.closeSync(fd); }
}
// For the providers step: null when a token file is present and owner-only, else why not, without reading its
// value. Any other error, such as a denied directory or a failed ACL read, propagates.
function tokenFileProblem(name) {
  try { ownerFile(name, false); return null; }
  catch (e) { if (e instanceof Unsafe) return e.message; if (absent(e)) return 'missing'; throw e; }
}
const safeValue = value => value && !/[\x00-\x1f\x7f]/.test(value);
// One variable as the current user's environment holds it now (HKCU\Environment), not as this process inherited
// it: reg.exe, without a shell. Its output must be a blank line, the key and that one value line; anything else, or a
// failed or timed-out run, throws. A non-zero exit, which reg gives for no such value (or one it cannot read), gives
// null, and so does an expanding value that names another variable, since reg prints it unexpanded.
function readUserEnv(name) {
  const done = spawnSync(system32('reg.exe'), ['query', 'HKCU\\Environment', '/v', name],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true });
  if (done.error) throw done.error;
  if (done.status !== 0) return null;
  const lines = done.stdout.replace(/(\r?\n)+$/, '').split(/\r?\n/);
  const m = lines.length === 3 && lines[0] === '' && lines[1] === 'HKEY_CURRENT_USER\\Environment'
    && /^ {4}(\S+) {4}(REG_SZ|REG_EXPAND_SZ)(?: {4}(.*))?$/.exec(lines[2]);
  if (!m || m[1].toUpperCase() !== name) throw Error('unexpected reg output');
  const value = m[3] || '';
  return m[2] === 'REG_SZ' || !value.includes('%') ? value : null;
}
// Windows: a Paseo daemon inherits the user environment once, when it starts, so after a token rotation its copy
// is stale. Each enabled server's bearer variable, and no other, is read from the user environment at this launch
// and replaces the inherited one, so a rotation needs no daemon restart. A value that is absent or empty, or shows a
// character other than printable ASCII in reg's output, or a read that fails or times out, keeps the inherited value,
// so at most that server fails to authenticate, as before. Values must be printable ASCII, as bearer tokens are: reg
// prints in the console code page, so a character outside that page arrives already replaced (for example as ?) and
// goes undetected. The notice names only variables, never a value.
function windowsUserEnv(out, servers) {
  const names = [...new Set(servers.filter(s => s.enabled).map(s => s.bearerTokenEnvVar))];
  if (names.some(name => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name)))
    throw Error('invalid MCP bearer env name in mcp-env.json');
  const kept = [];
  for (const name of names) {
    let value;
    try { value = readUserEnv(name); } catch (e) { kept.push(name + ' (' + (e.code || e.message) + ')'); continue; }
    if (!value || !/^[\x20-\x7e]+$/.test(value)) { kept.push(name); continue; }
    // Windows env names ignore case, so no other spelling of the name may linger beside it.
    for (const key of Object.keys(out)) if (key.toUpperCase() === name) delete out[key];
    out[name] = value;
  }
  if (kept.length)
    process.stderr.write('MCP user env has no usable ' + kept.join(', ') + '; keeping any inherited value\n');
}
function loadEnv(servers, env = process.env, provider = {}) {
  const out = { ...env };
  if (windows) windowsUserEnv(out, servers);
  else for (const s of servers.filter(s => s.enabled && s.envFile)) {
    const key = s.bearerTokenEnvVar;
    try {
      const lines = ownerFile(s.envFile, true).split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
      if (lines.length !== 1 || !lines[0].startsWith(key + '=')) throw Error();
      const value = lines[0].slice(key.length + 1);
      if (!safeValue(value)) throw Error();
      out[key] = value;
    } catch { throw Error('MCP env file unavailable or unsafe for ' + key + ' (requires owner-only 0600 VAR= line)'); }
  }
  // A token file holds the bare value on one line, surrounding whitespace ignored, like the source host's token_file.
  for (const [key, tokenFile] of Object.entries(provider.tokenFiles || {})) {
    try {
      const value = ownerFile(tokenFile, true).trim();
      if (!safeValue(value)) throw Error();
      out[key] = value;
    } catch (e) {
      throw Error('token file unavailable or unsafe for ' + key + (e instanceof Unsafe ? ': ' + e.message : '') + (windows
        ? ' (requires one line in a file only the current user, SYSTEM and Administrators can access, inheritance off)'
        : ' (requires an owner-only 0600 file holding one line)'));
    }
  }
  return out;
}
function parents(dir) {
  const out = [];
  for (;;) { out.push(dir); const next = path.dirname(dir); if (next === dir) return out; dir = next; }
}
const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { if (absent(e)) return false; throw e; } };
// Windows resolves a bare harness name as Paseo does (the `which` package): each PATH directory in order, without
// surrounding quotes, trying the PATHEXT extensions (the bare name only when it has an extension), then winget
// package executables.
function windowsExecutable(command, env) {
  const get = name => env[Object.keys(env).find(k => k.toUpperCase() === name)];
  const exts = (get('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = [...(path.extname(command) ? [command] : []), ...exts.map(ext => command + ext)];
  if (/[\\/]/.test(command)) return names.find(isFile) || null;
  for (const part of (get('PATH') || '').split(';')) {
    const dir = /^".*"$/.test(part) ? part.slice(1, -1) : part;
    if (dir) for (const name of names) if (isFile(path.join(dir, name))) return path.join(dir, name);
  }
  const winget = path.join(get('LOCALAPPDATA') || '', 'Microsoft', 'WinGet', 'Packages');
  let packages = [];
  try { packages = fs.readdirSync(winget, { withFileTypes: true }).filter(e => e.isDirectory()); }
  catch (e) { if (!absent(e)) throw e; }
  return packages.map(e => path.join(winget, e.name, command + '.exe')).find(isFile) || null;
}
// What an npm command shim runs, found as npm's read-cmd-shim finds it: [program, ...leading args], or null.
// A Node script runs under the shim's own node.exe when it ships one, else this node; never through cmd.exe.
function shimTarget(shim) {
  const m = /"%(?:~dp0|dp0%)\\([^"]+?)"\s+%[*]/.exec(fs.readFileSync(shim, 'utf8'));
  const target = m && path.join(path.dirname(shim), m[1]);
  if (!target || !isFile(target)) return null;
  if (/\.exe$/i.test(target)) return [target];
  if (!/\.[cm]?js$/i.test(target)) return null;
  const own = path.join(path.dirname(shim), 'node.exe');
  return [isFile(own) ? own : process.execPath, target];
}
// Any other command script runs through cmd.exe, which expands % and ! and obeys its operators even inside an
// argument, so no forwarded argument may hold them; the rest are quoted for the program's own command-line parser.
const CMD_UNSAFE = /[%!^&|<>()\x00-\x1f]/;
function cmdLine(script, args) {
  if (/[%!"\x00-\x1f]/.test(script) || args.some(a => CMD_UNSAFE.test(a)))
    throw Error('refusing to pass % ! ^ & | < > ( ) or control characters through cmd.exe to ' + path.basename(script));
  const quote = a => a && !/[\s"]/.test(a) ? a
    : '"' + a.replace(/(\\*)"/g, (_m, s) => s + s + '\\"').replace(/\\+$/, s => s + s) + '"';
  return ['"' + script + '"', ...args.map(quote)].join(' ');
}
function launch(command, args, env) {
  const options = { env, stdio: 'inherit', windowsHide: true };
  if (!windows) return spawn(command, args, options);
  const resolved = windowsExecutable(command, env);
  if (!resolved) throw Error('harness not found on PATH: ' + command);
  if (!/\.(cmd|bat)$/i.test(resolved)) return spawn(resolved, args, options);
  const target = shimTarget(resolved);
  if (target) return spawn(target[0], [...target.slice(1), ...args], options);
  // One command line avoids Node's DEP0190 warning for args with shell:true.
  return spawn(cmdLine(resolved, args), { ...options, shell: true });
}
module.exports = { loadEnv, tokenFileProblem };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let id = null;
    if (args[0] === '--provider') { args.shift(); id = args.shift(); }
    if (args.shift() !== '--' || !args.length) throw Error('usage: node mcp-env.cjs [--provider <id>] -- <harness> [args]');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const descriptor = Array.isArray(raw) ? { servers: raw } : raw;
    const provider = (id && (descriptor.providers || {})[id]) || {};
    const env = loadEnv(descriptor.servers || [], process.env, provider);
    // Provider args go right after the executable, so they are global flags before any subcommand the caller adds.
    const child = launch(args[0], [...(provider.args || []), ...args.slice(1)], env);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', () => { process.stderr.write('MCP harness launch failed\n'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

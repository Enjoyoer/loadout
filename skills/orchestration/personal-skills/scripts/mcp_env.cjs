// Launch a harness with fleet credentials in memory only. Never source shell code.
// mcp-env.json holds {servers, providers}: MCP servers whose env files load for every wrapped harness, and per
// provider launch settings (`tokenFiles`, `args`) for the harness named by `--provider <id>`. A bare array is the
// servers list from before provider settings.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const file = path.join(__dirname, 'mcp-env.json');
const windows = process.platform === 'win32';
// Only these codes mean a path is absent; any other error propagates.
const absent = e => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
// A file that is present but not owner-only, or not a single safe value.
class Unsafe extends Error {}
// Owner-only on Windows, read through PowerShell's .NET: inheritance off, the owner and every allow rule the current
// user, SYSTEM, Administrators or OWNER RIGHTS, and one allow rule for the current user. SIDs, so a localized name cannot slip through.
// The path arrives in the environment, never in the script text.
const ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  // .NET, not Get-Acl: a cmdlet module would autoload, which stalls in a sparse environment.
  '$acl=[IO.File]::GetAccessControl($env:LOADOUT_OWNER_FILE)',
  '$sid=[Security.Principal.SecurityIdentifier]',
  '$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "$ok=@($me,'S-1-5-18','S-1-5-32-544')",
  "$allow=@(@($acl.GetAccessRules($true,$true,$sid)).Where({ $_.AccessControlType -eq 'Allow' }))",
  // OWNER RIGHTS (S-1-3-4) grants only the owner, which must itself be one of $ok.
  "$bad=@($allow.Where({ ($ok+'S-1-3-4') -notcontains $_.IdentityReference.Value }))",
  '$mine=@($allow.Where({ $_.IdentityReference.Value -eq $me }))',
  "$why=@()",
  "if(-not $acl.AreAccessRulesProtected){$why+='inheritance on'}",
  "if($ok -notcontains $acl.GetOwner($sid).Value){$why+='owned by another account'}",
  "$name={param($r) try{$r.IdentityReference.Translate([Security.Principal.NTAccount]).Value}catch{$r.IdentityReference.Value}}",
  "if($bad.Count){$why+='other accounts allowed: '+(@($bad.ForEach({& $name $_})) -join ' and ')}",
  "if(-not $mine.Count){$why+='no rule for the current user'}",
  "if($why.Count){$why -join ', '}else{'owner-only'}",
].join(';');
// Null when owner-only, else the reasons it is not.
function aclProblem(target) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], {
    env: { ...process.env, LOADOUT_OWNER_FILE: target }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000, windowsHide: true });
  return out.trim() === 'owner-only' ? null : 'ACL: ' + out.trim();
}
// HOME is the trusted boundary, and macOS may spell its temporary root through /var. Canonicalize that boundary,
// but still refuse links anywhere below it. The file must be owner-only: mode 0600 and our uid on POSIX, the ACL
// above on Windows. Returns the file's text when read is set, else true; throws when unsafe.
function ownerFile(name, read) {
  const target = name.replace(/^~(?=[\\/])/, fs.realpathSync(os.homedir()));
  if (!path.isAbsolute(target)) throw new Unsafe('not an absolute path');
  for (const part of [target, ...parents(path.dirname(target))]) {
    const st = fs.lstatSync(part);
    if (st.isSymbolicLink() || (part === target ? !st.isFile() : !st.isDirectory()))
      throw new Unsafe('a link or wrong file type at ' + part);
  }
  const acl = windows && aclProblem(target);
  if (acl) throw new Unsafe(acl);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || !st.size || st.size > 65536) throw new Unsafe('empty or over 64 KiB');
    if (!windows && ((st.mode & 0o777) !== 0o600 || st.uid !== process.getuid())) throw new Unsafe('not mode 0600 and ours');
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
function loadEnv(servers, env = process.env, provider = {}) {
  const out = { ...env };
  for (const s of servers.filter(s => s.enabled && s.envFile)) {
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
// Windows resolves a bare harness name as Paseo does: each PATH directory in order, trying the PATHEXT extensions
// (the bare name only when it has an extension), then winget package executables.
function windowsExecutable(command, env) {
  const get = name => env[Object.keys(env).find(k => k.toUpperCase() === name)];
  const exts = (get('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = [...(path.extname(command) ? [command] : []), ...exts.map(ext => command + ext)];
  const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { if (absent(e)) return false; throw e; } };
  if (/[\\/]/.test(command)) return names.find(isFile) || null;
  for (const dir of (get('PATH') || '').split(';').filter(Boolean))
    for (const name of names) if (isFile(path.join(dir, name))) return path.join(dir, name);
  const winget = path.join(get('LOCALAPPDATA') || '', 'Microsoft', 'WinGet', 'Packages');
  let packages = [];
  try { packages = fs.readdirSync(winget, { withFileTypes: true }).filter(e => e.isDirectory()); }
  catch (e) { if (!absent(e)) throw e; }
  return packages.map(e => path.join(winget, e.name, command + '.exe')).find(isFile) || null;
}
// cmd.exe quoting as Paseo applies it to a .cmd or .bat launch.
function cmdQuote(value) {
  const quoted = value.startsWith('"') && value.endsWith('"');
  const bare = quoted ? value.slice(1, -1) : value;
  const escaped = bare.replace(/([&|^<>()!])/g, '^$1');
  if (!quoted && !/[\s"]/u.test(bare)) return escaped;
  return '"' + escaped.replace(/(\\*)"/g, (_m, s) => s + s + '\\"').replace(/\\+$/u, s => s + s) + '"';
}
function launch(command, args, env) {
  const options = { env, stdio: 'inherit', windowsHide: true };
  if (!windows) return spawn(command, args, options);
  const resolved = windowsExecutable(command, env);
  if (!resolved) throw Error('harness not found on PATH: ' + command);
  // A command script only runs through cmd.exe; one command line avoids Node's DEP0190 warning.
  if (/\.(cmd|bat)$/i.test(resolved))
    return spawn([resolved, ...args].map(cmdQuote).join(' '), { ...options, shell: true });
  return spawn(resolved, args, options);
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

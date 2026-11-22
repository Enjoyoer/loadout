// Launch a harness with fleet credentials in memory only. Never source shell code.
// mcp-env.json holds {servers, providers, unnamed}: the host's fleet MCP servers, each with an owner-only env file
// holding its bearer, per provider launch settings (`tokenFiles`, `args`, `mcpTokens`) for the harness named by
// `--provider <id>`, and `unnamed: {mcpTokens}` for a launch without `--provider`. A bare array is the servers list
// from before provider settings. Only a launch with `mcpTokens: true` (Codex, which has no other way to read an HTTP
// bearer, or a client the providers step bridges during a rollout) gets the servers' bearer variables, read from
// their env files at launch; every other harness gets none of them, inherited ones removed, and reads each bearer at
// connect time through `--mcp-header` instead.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
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
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// One server's bearer from its env file: exactly one line `NAME=value` besides blank and # lines, no quoting or
// expansion, in an owner-only file (mode 0600 and ours on POSIX, the ACL check above on Windows), read afresh each
// time so a rotation reaches the next launch or connection. Throws, naming only the variable, when unavailable.
function envFileValue(s) {
  const key = s.bearerTokenEnvVar;
  try {
    if (typeof s.envFile !== 'string') throw Error('no env file');
    const lines = ownerFile(s.envFile, true).split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
    if (lines.length !== 1 || !lines[0].startsWith(key + '=')) throw Error('not one ' + key + '= line');
    const value = lines[0].slice(key.length + 1);
    if (!safeValue(value)) throw Error('an empty value or a control character');
    return value;
  } catch (e) {
    throw Error('MCP env file unavailable or unsafe for ' + key + ': ' + (absent(e) ? 'missing' : e.message) + (windows
      ? ' (requires one ' + key + '= line in a file only the current user, SYSTEM and Administrators can access, inheritance off)'
      : ' (requires an owner-only 0600 file holding one ' + key + '= line)'));
  }
}
function bearerNames(servers) {
  const names = [...new Set(servers.map(s => s.bearerTokenEnvVar))];
  if (names.some(name => typeof name !== 'string' || !ENV_NAME.test(name)))
    throw Error('invalid MCP bearer env name in mcp-env.json');
  return names;
}
function loadEnv(servers, env = process.env, provider = {}) {
  const out = { ...env };
  // No harness keeps an inherited bearer variable: a POSIX daemon or shell, or the Windows user environment, may
  // hold one. Windows env names ignore case, so every spelling goes.
  const names = bearerNames(servers);
  for (const key of Object.keys(out)) if (names.includes(windows ? key.toUpperCase() : key)) delete out[key];
  if (provider.mcpTokens === true)
    for (const s of servers.filter(s => s.enabled)) out[s.bearerTokenEnvVar] = envFileValue(s);
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
// `--mcp-header pi|claude <server>`: the Authorization header for one enabled server, read from its env file at the
// moment the harness connects. Pi runs it as a `!command` header value and sends its stdout, `Bearer <value>`; Claude
// Code runs it as `headersHelper` and merges the JSON object it prints. Only the server name is on the command line.
// Missing, unsafe or unreadable means no output and exit 1, so the harness sends no header; it never falls back to
// an environment variable. The value must be printable ASCII without spaces, as a bearer token is, so the header is
// exactly that one line.
function mcpHeader(servers, client, name) {
  if (client !== 'pi' && client !== 'claude') throw Error('usage: node mcp-env.cjs --mcp-header pi|claude <server>');
  const s = servers.find(s => s.name === name && s.enabled);
  if (!s) throw Error('no enabled MCP server ' + (/^[A-Za-z0-9_-]+$/.test(name || '') ? name : '') + ' in mcp-env.json');
  bearerNames([s]);
  const value = envFileValue(s);
  if (!/^[\x21-\x7e]+$/.test(value)) throw Error('MCP env file value for ' + s.bearerTokenEnvVar + ' is not a bearer token');
  return client === 'pi' ? 'Bearer ' + value : JSON.stringify({ Authorization: 'Bearer ' + value });
}
// `--mcp-stdio <server>`: a stdio MCP server for a harness that can neither run a header command nor keep a bearer
// out of its config and environment (Antigravity). It forwards each newline-delimited JSON-RPC message on stdin to
// the enabled server's Streamable HTTP url and writes each JSON-RPC message the server sends back, from a JSON or an
// event-stream body, to stdout, one per line; diagnostics go to stderr. The bearer is read from the server's env file
// at each request, so a rotation reaches the next one; a missing or unsafe file answers that request with a JSON-RPC
// error and sends nothing, never falling back to an environment variable. The token is never on the command line,
// in the environment, on stdout or stderr. Redirects are refused, so the bearer cannot reach another origin. Requests
// run concurrently with no client timeout, as a tool call can run many minutes. The session id from the initialize
// response, and the protocol version it negotiated, go on later requests; a 404 on a session re-sends the cached
// initialize (and notifications/initialized) for a new session and retries that request once. On stdin EOF it gives
// open requests 5 seconds, ends the rest, ends the session with a DELETE (best effort) and exits 0.
function mcpStdio(servers, name) {
  const s = servers.find(s => s.name === name && s.enabled);
  if (!s) throw Error('no enabled MCP server ' + (/^[A-Za-z0-9_-]+$/.test(name || '') ? name : '') + ' in mcp-env.json');
  bearerNames([s]);
  let url = null;
  try { url = new URL(s.url); } catch {}
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
    throw Error('MCP server ' + name + ' has no http or https url in mcp-env.json');
  const http = require(url.protocol === 'https:' ? 'node:https' : 'node:http');
  // A fresh connection per request: a pooled socket the server closed while idle would fail a POST that cannot be
  // retried safely, such as a tool call that dials.
  const agent = new http.Agent({ keepAlive: false });
  const say = text => process.stderr.write('mcp-stdio ' + name + ': ' + text + '\n');
  // U+2028 and U+2029 are escaped so a reader that also splits lines on them sees one message per line.
  const out = m => process.stdout.write(JSON.stringify(m).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n');
  process.stdout.on('error', () => process.exit(0));
  const visible = v => typeof v === 'string' && /^[\x21-\x7e]+$/.test(v);
  const requests = new Set();
  let closing = false, session = null, protocol = null, init = null, initialized = null, renewing = null, opening = Promise.resolve();
  // One stdin line, one JSON body and one event-stream event are each held to this many characters; a larger one
  // fails its request instead of growing memory without bound.
  const MAX = 32 * 1024 * 1024, tooBig = 'over 32 MiB';
  // The Windows owner check runs PowerShell synchronously, so a value read there is reused for 5 seconds rather than
  // stalling every concurrent request; a rotation still reaches requests after that. Only a good read is kept.
  let cached = null;
  const bearer = () => {
    if (windows && cached && Date.now() - cached.at < 5000) return cached.value;
    const value = envFileValue(s);
    if (!visible(value)) throw Error('MCP env file value for ' + s.bearerTokenEnvVar + ' is not a bearer token');
    if (windows) cached = { value, at: Date.now() };
    return value;
  };
  // One HTTP exchange. Resolves {status, sent, text} once the body ends: sent is the session id it carried, text the
  // start of a non-2xx body. Each JSON-RPC message of a 2xx body goes to deliver as it arrives.
  // limit, when set, is an idle timeout in ms: only the opening POSTs and the DELETE have one, never a tool call.
  const exchange = (method, body, deliver, initializing, limit) => new Promise((resolve, reject) => {
    if (closing && method !== 'DELETE') throw Error('the client closed stdin');
    const token = bearer();
    const headers = { Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const sent = initializing ? null : session;
    if (sent) headers['Mcp-Session-Id'] = sent;
    if (!initializing && protocol) headers['MCP-Protocol-Version'] = protocol;
    const req = http.request(url, { method, headers, agent }, res => {
      const status = res.statusCode, type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      res.setEncoding('utf8');
      res.on('error', reject);
      res.on('close', () => reject(Error('response ended early')));
      const over = () => { reject(Error('the answer is ' + tooBig)); req.destroy(); };
      if (status < 200 || status > 299) {
        // The start of the body, with any copy of the bearer taken out before it can be quoted in an error.
        let text = '';
        res.on('data', chunk => { if (text.length < 4096 + token.length) text += chunk; });
        res.on('end', () => resolve({ status, sent, text: text.split(token).join('').slice(0, 4096) }));
        return;
      }
      // A server that answers initialize without a session id is stateless: an older id must not linger.
      if (initializing) session = visible(res.headers['mcp-session-id']) ? res.headers['mcp-session-id'] : null;
      const message = data => {
        let m;
        try { m = JSON.parse(data); } catch { say('dropped a message that is not JSON'); return; }
        if (initializing && m && m.result && visible(m.result.protocolVersion)) protocol = m.result.protocolVersion;
        deliver(m);
      };
      // Chunks are kept in a list and joined once, so a long line or body costs linear time.
      let parts = [], size = 0;
      if (type === 'text/event-stream') {
        let data = [], dataSize = 0, event = '', cr = false;
        const field = line => {
          if (line === '') {
            // An event with empty data (a priming event carrying only an id) dispatches nothing, as in EventSource.
            if (data.join('\n') && (event === '' || event === 'message')) message(data.join('\n'));
            data = []; dataSize = 0; event = '';
          } else if (!line.startsWith(':')) {
            const at = line.indexOf(':'), key = at < 0 ? line : line.slice(0, at);
            const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
            if (key === 'data') { data.push(value); dataSize += value.length + 1; } else if (key === 'event') event = value;
          }
        };
        const add = piece => { parts.push(piece); size += piece.length; return size + dataSize <= MAX; };
        // Lines end at CRLF, LF or CR; a CR that ends one chunk may pair with an LF that starts the next.
        const ends = /\r\n|\r|\n/g;
        res.on('data', chunk => {
          let from = cr && chunk.startsWith('\n') ? 1 : 0;
          cr = false;
          ends.lastIndex = from;
          for (let m; (m = ends.exec(chunk));) {
            if (!add(chunk.slice(from, m.index))) return over();
            field(parts.join('')); parts = []; size = 0;
            from = ends.lastIndex;
            if (m[0] === '\r' && from === chunk.length) cr = true;
          }
          if (!add(chunk.slice(from))) over();
        });
        res.on('end', () => { if (size) field(parts.join('')); field(''); resolve({ status, sent }); });
      } else {
        res.on('data', chunk => { parts.push(chunk); size += chunk.length; if (size > MAX) over(); });
        res.on('end', () => {
          const text = parts.join('');
          if (text.trim()) {
            if (type === 'application/json') message(text); else say('dropped a ' + (type || 'untyped') + ' body');
          }
          resolve({ status, sent });
        });
      }
    });
    req.on('error', reject);
    requests.add(req);
    req.on('close', () => requests.delete(req));
    // TCP keepalive finds a peer that vanished during a long tool call; the agent keeps no pooled sockets.
    req.on('socket', socket => socket.setKeepAlive(true, 30000));
    if (limit) req.setTimeout(limit, () => req.destroy(Error('timed out')));
    req.end(body);
  });
  // A 401 or 403 body is never repeated, in case a server echoes the credential.
  const failure = r => 'HTTP ' + r.status + (r.status > 299 && r.status < 400 ? ' redirect refused' : '') + (() => {
    if (r.status === 401 || r.status === 403) return '';
    let e;
    // A body that is not JSON carries no message to quote.
    try { e = JSON.parse(r.text)?.error; } catch (err) { if (!(err instanceof SyntaxError)) throw err; }
    return e && typeof e.message === 'string' ? ': ' + e.message.slice(0, 200) : '';
  })();
  const OPEN_LIMIT = 60000;
  // A new session after the server forgot one, shared by every request that saw that session expire.
  const renew = stale => {
    if (renewing) return renewing;
    if (session !== stale) return Promise.resolve();
    renewing = (async () => {
      if (!init) throw Error('session expired before an initialize');
      const r = await exchange('POST', init, () => {}, true, OPEN_LIMIT);
      if (r.status < 200 || r.status > 299) throw Error('re-initialize failed: ' + failure(r));
      if (initialized) await exchange('POST', initialized, () => {}, false, OPEN_LIMIT);
    })().finally(() => { renewing = null; });
    return renewing;
  };
  const forward = async line => {
    let msg;
    try { msg = JSON.parse(line); }
    catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const list = (Array.isArray(msg) ? msg : [msg]).filter(m => m && typeof m === 'object');
    const ids = list.filter(m => typeof m.method === 'string' && m.id !== undefined && m.id !== null).map(m => m.id);
    const initializing = list.some(m => m.method === 'initialize');
    const open = initializing || list.some(m => m.method === 'notifications/initialized');
    if (initializing) { init = line; initialized = null; }
    else if (open) initialized = line;
    // Every later message waits until the server has the initialize and notifications/initialized POSTs, which a
    // client sends without waiting for the second; the opening POSTs themselves keep their order.
    const before = opening;
    let done;
    if (open) opening = Promise.all([before, new Promise(r => { done = r; })]);
    try { await before; } catch {}
    const answered = new Set();
    const deliver = m => {
      for (const one of Array.isArray(m) ? m : [m]) if (one && one.method === undefined) answered.add(one.id);
      out(m);
    };
    const fail = text => {
      say(text);
      for (const id of ids) if (!answered.has(id)) out({ jsonrpc: '2.0', id, error: { code: -32000, message: text } });
    };
    try {
      if (renewing && !initializing) await renewing.catch(() => {});
      // The opening POSTs hold every later message, so they alone have an idle timeout.
      const limit = open ? OPEN_LIMIT : 0;
      let r = await exchange('POST', line, deliver, initializing, limit);
      if (r.status === 404 && r.sent) { await renew(r.sent); r = await exchange('POST', line, deliver, false, limit); }
      if (r.status < 200 || r.status > 299) fail(failure(r));
      else if (ids.some(id => !answered.has(id))) fail('the server ended its answer without a response');
    } catch (e) { fail(e.message); }
    finally { if (done) done(); }
  };
  const pending = new Set();
  // Lines split only at \n (readline would also split inside a string at U+2028), decoded as UTF-8 across chunks.
  const take = line => {
    line = line.replace(/\r$/, '');
    if (!line.trim()) return;
    const p = forward(line);
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  // A line over the cap is skipped to its end and answered once with an error; its id is unknown, so id is null.
  let parts = [], size = 0, skipping = false;
  const oversized = () => {
    say('dropped a message ' + tooBig);
    out({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'message ' + tooBig } });
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    let from = 0;
    for (let at; (at = chunk.indexOf('\n', from)) >= 0; from = at + 1) {
      const piece = chunk.slice(from, at);
      if (skipping) skipping = false;
      else if (size + piece.length > MAX) oversized();
      else take(parts.join('') + piece);
      parts = []; size = 0;
    }
    const tail = chunk.slice(from);
    if (skipping || !tail) return;
    if (size + tail.length > MAX) { oversized(); skipping = true; parts = []; size = 0; }
    else { parts.push(tail); size += tail.length; }
  });
  process.stdin.on('end', async () => {
    if (!skipping) take(parts.join(''));
    // The client is gone: open requests get a short grace, never a many-minute wait, before the session ends.
    const all = Promise.allSettled([...pending]);
    await Promise.race([all, new Promise(r => setTimeout(r, 5000).unref())]);
    closing = true;
    for (const req of requests) req.destroy();
    await all;
    if (session) await exchange('DELETE', undefined, () => {}, false, 5000).catch(() => {});
    agent.destroy();
    process.exitCode = 0;
  });
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
// POSIX resolves a bare harness name as execvp and spawn do: a name with a slash as given, else the first executable
// regular file on the PATH of the env the harness gets (the system default when it has none), skipping an absent or
// non-executable one as execvp does. Null when none.
function posixExecutable(command, env) {
  const runnable = file => {
    try { fs.accessSync(file, fs.constants.X_OK); }
    catch (e) { if (absent(e) || e.code === 'EACCES') return false; throw e; }
    return isFile(file);
  };
  if (command.includes('/')) return runnable(command) ? command : null;
  for (const dir of (env.PATH ?? '/usr/bin:/bin').split(':'))
    if (runnable((dir || '.') + '/' + command)) return (dir || '.') + '/' + command;
  return null;
}
// Whether process.execve can start file without killing this process. A failed execve aborts the process (SIGABRT) on
// Node 22.15 to 26.0 and throws from 26.1, so on every Node only a file this OS's execve can start execs: a #! script,
// and an ELF binary on Linux or a Mach-O binary (fat included) on macOS. Any other goes to spawn, which runs a file
// without #! through /bin/sh on Linux as before. Still aborting before 26.1: a #! script whose interpreter is missing,
// and a race (the file replaced or removed meanwhile, ETXTBSY, E2BIG); the abort prints no secret.
const EXEC_MAGIC = process.platform === 'darwin'
  ? ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'] : ['7f454c46'];
function execTarget(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (e) { if (absent(e) || e.code === 'EACCES') return false; throw e; }
  try {
    const head = Buffer.alloc(4), hex = head.subarray(0, fs.readSync(fd, head, 0, 4, 0)).toString('hex');
    return hex.startsWith('2321') || EXEC_MAGIC.includes(hex);
  } finally { fs.closeSync(fd); }
}
// The env as spawn passes it: an undefined value is dropped and any other becomes its string.
const spawnEnv = env => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => [k, `${v}`]));
// On POSIX the launcher becomes the harness (same PID), so the harness gets signals and its exit status reaches the
// caller directly. Node ignores SIGPIPE and SIGXFSZ, and an ignored signal stays ignored across exec while a caught
// one resets, so a listener gives the harness the default handling spawn gave it. Nothing on this path (token and env
// file reads included) creates process.stdin, process.stdout or process.stderr, which would leave those fds
// non-blocking for the harness. Returns only when the harness should be spawned instead: not found, not a file execve
// can start, or a failed exec from Node 26.1. process.execve queues an ExperimentalWarning that a failed exec would
// print on the next tick, creating process.stderr after the spawn; no warning listener means no print.
function execHarness(command, args, env) {
  const file = posixExecutable(command, env);
  if (!file || !execTarget(file)) return;
  for (const signal of ['SIGPIPE', 'SIGXFSZ']) process.on(signal, () => {});
  process.removeAllListeners('warning');
  try { process.execve(file, [command, ...args], spawnEnv(env)); } catch {}
}
// Windows has no exec, and a Node without process.execve (before 22.15, or 23.0 to 23.10) neither, so there the
// launcher spawns the harness and waits, as it does when the exec is not taken.
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
module.exports = { loadEnv, tokenFileProblem, mcpHeader };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const descriptor = Array.isArray(raw) ? { servers: raw } : raw;
    if (args[0] === '--mcp-header') {
      if (args.length !== 3) throw Error('usage: node mcp-env.cjs --mcp-header pi|claude <server>');
      process.stdout.write(mcpHeader(descriptor.servers || [], args[1], args[2]));
    } else if (args[0] === '--mcp-stdio') {
      if (args.length !== 2) throw Error('usage: node mcp-env.cjs --mcp-stdio <server>');
      mcpStdio(descriptor.servers || [], args[1]);
    } else {
      let id = null;
      if (args[0] === '--provider') { args.shift(); id = args.shift(); }
      if (args.shift() !== '--' || !args.length) throw Error('usage: node mcp-env.cjs [--provider <id>] -- <harness> [args]');
      const provider = id ? (descriptor.providers || {})[id] || {}
        : { mcpTokens: (descriptor.unnamed || {}).mcpTokens === true };
      const env = loadEnv(descriptor.servers || [], process.env, provider);
      // Provider args go right after the executable, so they are global flags before any subcommand the caller adds.
      const argv = [...(provider.args || []), ...args.slice(1)];
      if (!windows && typeof process.execve === 'function') execHarness(args[0], argv, env);
      const child = launch(args[0], argv, env);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
      child.on('error', () => { process.stderr.write('MCP harness launch failed\n'); process.exitCode = 1; });
      child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    }
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

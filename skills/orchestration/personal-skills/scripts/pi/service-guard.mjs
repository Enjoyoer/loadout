// Shared fleet service guard, dependency-free (Node built-ins only), used by fleet-routing.mjs for Pi and runnable as
// a hook: `node service-guard.mjs [--runtime <runtime.json>]` reads one JSON object on stdin ({"command": ...} or a
// Claude Code PreToolUse payload with tool_input.command), prints nothing and exits 0 to allow, or prints the reason
// on stderr and exits 2 to refuse.
//
// A backstop, not a sandbox: it refuses the plain and lightly obfuscated shell forms that
// stop, unload, disable or kill a shared fleet service (the model bridge, router, Tailscale, a Paseo daemon), so a
// forged instruction cannot take the fleet's own model traffic down with one bare command. Pi runs every bash and
// powershell call, nested codemode calls included, through tool_call first, and a handler error blocks the call.
// Variables, generated names, interpreters other than a shell (python, node) and binaries it never sees still pass.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const GUARD_RULE = 'shared fleet service: use one detached nohup script that changes, restarts, health-checks and rolls back';
// Generic defaults, always on: the Paseo daemon (its process titles, launchd label shape and server package) and
// Tailscale. Real labels, units and process names come from runtime.json guard.protectedServices.
export const DEFAULT_PROTECTED = ['Paseo Daemon', 'Paseo Supervisor', 'paseo-daemon', '@getpaseo/server', 'tailscaled', 'tailscale'];
const SCRIPT_CAP = 256 * 1024;
const MAX_DEPTH = 3;
const norm = value => String(value).toLowerCase().replace(/[\s_]+/g, '-');
const base = word => word.split(/[\\/]/).pop().replace(/\.exe$/, '');

/** runtime.json's guard.protectedServices plus the defaults; a missing or invalid value keeps the defaults and warns. */
export function guardConfig(runtime) {
  const list = runtime?.guard?.protectedServices;
  if (runtime?.guard === undefined) return { protectedServices: [...DEFAULT_PROTECTED], warning: 'runtime.json has no guard.protectedServices; the service guard uses its defaults only' };
  if (!Array.isArray(list) || !list.every(entry => typeof entry === 'string' && entry.trim().length >= 3))
    return { protectedServices: [...DEFAULT_PROTECTED], warning: 'runtime.json guard.protectedServices is not a list of names of 3 or more characters; the service guard uses its defaults only' };
  return { protectedServices: [...new Set([...DEFAULT_PROTECTED, ...list.map(entry => entry.trim())])] };
}

/**
 * Split a command line into segments of words: quotes and escapes are removed first, so a quoted `bash -c '...'`,
 * `eval "..."`, `$(...)` or heredoc body becomes segments of its own, and every operator, redirect and newline ends
 * a segment. Each word keeps its raw text (for file paths) and a lowercased form.
 */
export function segments(command, shell = 'posix') {
  let text = String(command).replace(/\\\r?\n/g, ' ');
  text = shell === 'powershell' ? text.replace(/`(.)/g, '$1') : text.replace(/\\(.)/g, '$1');
  text = text.replace(/["']/g, '');
  return text.split(/[;&|(){}<>`\r\n]+|\$\(/).map(part => part.trim().split(/\s+/).filter(Boolean).map(raw => ({ raw, lc: raw.toLowerCase() })))
    .filter(words => words.length);
}

const LAUNCHCTL = new Set(['bootout', 'unload', 'remove', 'kill', 'disable', 'stop']);
const SYSTEMCTL = new Set(['stop', 'disable', 'kill', 'mask', 'restart', 'try-restart', 'reload-or-restart', 'condrestart']);
const PKILL_ARG = new Set(['-u', '-U', '-g', '-G', '-P', '-s', '-t', '-F', '--signal']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'setsid', 'time', 'nice', 'timeout', 'stdbuf', 'caffeinate', 'builtin']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'source', '.']);

export function serviceGuard({ protectedServices = DEFAULT_PROTECTED, resolvePid = defaultResolvePid, listProcesses = defaultListProcesses,
  readScript = defaultReadScript } = {}) {
  const names = protectedServices.map(entry => ({ entry, n: norm(entry) }));
  // A target word names a protected service when it contains an entry, or is a 4+ character part of one.
  const targetHit = word => {
    const n = norm(word);
    return names.find(({ n: p }) => n.includes(p) || (n.length >= 4 && p.includes(n)))?.entry;
  };
  const textHit = text => { const n = norm(text); return names.find(({ n: p }) => n.includes(p))?.entry; };
  const patternHit = pattern => {
    const hit = targetHit(pattern);
    if (hit || pattern.length < 3) return hit;
    try { const re = new RegExp(pattern, 'i'); return names.find(({ entry }) => re.test(entry))?.entry; } catch { return undefined; }
  };
  const refuse = (what, entry) => ({ what, entry });
  let processes;
  const running = async () => processes ??= (async () => { try { return await listProcesses(); } catch { return null; } })();

  // Findings for one segment's words (anywhere in the segment, so wrappers such as sudo, env, nohup, xargs, eval
  // and an echo of the command are all seen through).
  async function inspect(words, whole) {
    const lc = words.map(word => word.lc);
    for (let i = 0; i < lc.length; i++) {
      const cmd = base(lc[i]);
      const rest = words.slice(i + 1);
      const restLc = lc.slice(i + 1);
      const anyTarget = list => { for (const word of list) { const hit = targetHit(word.raw); if (hit) return hit; } };
      if (cmd === 'launchctl' && LAUNCHCTL.has(restLc[0])) {
        const hit = anyTarget(rest.slice(1)); if (hit) return refuse(`launchctl ${restLc[0]}`, hit);
      }
      if (cmd === 'systemctl') {
        const verb = restLc.find(word => !word.startsWith('-'));
        if (SYSTEMCTL.has(verb)) { const hit = anyTarget(rest.slice(restLc.indexOf(verb) + 1)); if (hit) return refuse(`systemctl ${verb}`, hit); }
      }
      if (cmd === 'service' && restLc.some(word => ['stop', 'restart'].includes(word))) {
        const hit = anyTarget(rest); if (hit) return refuse('service stop', hit);
      }
      if (cmd === 'brew' && restLc[0] === 'services' && ['stop', 'restart', 'kill'].includes(restLc[1])) {
        const hit = anyTarget(rest.slice(2)); if (hit) return refuse(`brew services ${restLc[1]}`, hit);
      }
      if (['stop-service', 'suspend-service', 'remove-service'].includes(cmd) || (cmd === 'set-service' && restLc.includes('disabled'))) {
        const hit = anyTarget(rest); if (hit) return refuse(cmd, hit);
      }
      if ((cmd === 'sc' && (['stop', 'delete', 'pause'].includes(restLc[0]) || (restLc[0] === 'config' && restLc.some(word => word.includes('disabled')))))
        || (cmd === 'net' && restLc[0] === 'stop')) {
        const hit = anyTarget(rest.slice(1)); if (hit) return refuse(`${cmd} ${restLc[0]}`, hit);
      }
      if (cmd === 'schtasks' && (restLc.includes('/end') || restLc.includes('/delete') || (restLc.includes('/change') && restLc.includes('/disable')))) {
        const hit = anyTarget(rest); if (hit) return refuse('schtasks', hit);
      }
      if (['stop-scheduledtask', 'disable-scheduledtask', 'unregister-scheduledtask'].includes(cmd)) {
        const hit = anyTarget(rest); if (hit) return refuse(cmd, hit);
      }
      if (cmd === 'paseo') {
        const at = restLc.indexOf('daemon');
        const verb = at >= 0 && restLc.slice(at + 1).find(word => !word.startsWith('-') && !word.includes('://'));
        if (['stop', 'restart', 'uninstall'].includes(verb)) return refuse(`paseo daemon ${verb}`, 'Paseo daemon');
      }
      if (cmd === 'tailscale') {
        const verb = restLc.find(word => !word.startsWith('-'));
        if (verb === 'down' || verb === 'logout') return refuse(`tailscale ${verb}`, 'tailscale');
        if ((verb === 'serve' || verb === 'funnel') && restLc.some(word => word === 'off' || word === 'reset' || word.endsWith('=off')))
          return refuse(`tailscale ${verb} off/reset`, 'tailscale serve');
      }
      if (cmd === 'kill' || cmd === 'stop-process' || cmd === 'spps') { const found = await killTargets(rest, whole); if (found) return found; }
      if (cmd === 'pkill' || cmd === 'killall') { const found = await patternTargets(cmd, rest, whole); if (found) return found; }
      if (cmd === 'taskkill') { const found = await taskkillTargets(rest, whole); if (found) return found; }
    }
    return null;
  }
  async function pidHit(pid) {
    let line;
    try { line = await resolvePid(pid); }
    catch { return refuse(`kill ${pid}`, 'a process whose command line could not be read in time'); }
    const hit = line && textHit(line);
    return hit ? refuse(`kill ${pid}`, hit) : null;
  }
  async function killTargets(rest, whole) {
    const args = rest.map(word => word.lc);
    let i = 0, literal = 0, signalled = false;
    if (args[i] === '-l' || args[i] === '-L') return null;
    if (args[i] === '-s' || args[i] === '-n') { i += 2; signalled = true; }
    else if (args[i]?.startsWith('-') && args[i] !== '--' && !['-id', '-name', '-processname', '-force', '-inputobject'].includes(args[i])) { i++; signalled = true; }
    if (signalled && i === 1 && args[0] === '-1' && args.length === 1) return refuse('kill -1', 'every process');
    let flag = null;
    for (; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') continue;
      if (['-id', '-name', '-processname', '-inputobject'].includes(arg)) { flag = arg; continue; }
      if (arg === '-force' || arg === '-passthru') continue;
      for (const value of arg.split(',').filter(Boolean)) {
        if (flag === '-name' || flag === '-processname') { literal++; const hit = patternHit(value); if (hit) return refuse('Stop-Process -Name', hit); continue; }
        if (/^-\d+$/.test(value) || value === '0') return refuse(`kill ${value}`, 'a process group');
        if (/^\d+$/.test(value)) { literal++; const found = await pidHit(value); if (found) return found; continue; }
        if (value.startsWith('%')) { literal++; continue; }
      }
    }
    // kill $(pgrep ...) or ... | xargs kill: the target is computed, so refuse when the command names a protected service.
    if (!literal) { const hit = textHit(whole); if (hit) return refuse('kill of a computed target', hit); }
    return null;
  }
  async function patternTargets(cmd, rest, whole) {
    const patterns = [];
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i].raw;
      if (PKILL_ARG.has(word) || (cmd === 'killall' && ['-s', '-u', '-t', '-c', '--signal', '--user'].includes(word))) { i++; continue; }
      if (word.startsWith('-')) continue;
      patterns.push(word);
    }
    for (const pattern of patterns) { const hit = patternHit(pattern); if (hit) return refuse(`${cmd} ${pattern}`, hit); }
    if (!patterns.length) { const hit = textHit(whole); return hit ? refuse(`${cmd} of a computed target`, hit) : null; }
    const list = await running();
    for (const pattern of patterns) {
      let re; try { re = new RegExp(pattern, 'i'); } catch { re = null; }
      const match = line => (cmd === 'killall' ? line.split(/\s+/).some(part => base(part).toLowerCase() === pattern.toLowerCase()) : false)
        || (re ? re.test(line) : line.toLowerCase().includes(pattern.toLowerCase()));
      for (const proc of list ?? []) { const hit = match(proc.command) && textHit(proc.command); if (hit) return refuse(`${cmd} ${pattern}`, hit); }
    }
    return null;
  }
  async function taskkillTargets(rest, whole) {
    let literal = 0;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i].lc, value = rest[i + 1]?.raw;
      if (flag === '/im' && value) { literal++; const hit = patternHit(value.replace(/\.exe$/i, '').replace(/\*/g, '')); if (hit) return refuse('taskkill /IM', hit); }
      if (flag === '/pid' && value) { literal++; const found = await pidHit(value); if (found) return found; }
    }
    if (!literal) { const hit = textHit(whole); if (hit) return refuse('taskkill of a computed target', hit); }
    return null;
  }

  // Local script files a segment runs: `bash|sh|zsh|pwsh <file>`, `source|. <file>`, `pwsh -File <file>`, `& <file>`,
  // or a path in command position (after wrappers such as sudo, env X=, nohup).
  function scriptsOf(words) {
    const found = [];
    let i = 0;
    const skipWrappers = () => {
      while (i < words.length) {
        const w = base(words[i].lc);
        if (WRAPPERS.has(w) || /^[a-z_][a-z0-9_]*=/.test(words[i].lc) || (i > 0 && words[i].lc.startsWith('-')) || (base(words[i - 1]?.lc ?? '') === 'timeout' && /^\d/.test(words[i].lc))) i++;
        else break;
      }
    };
    skipWrappers();
    if (i < words.length && /^(\.{1,2}[\\/]|[\\/]|~[\\/]|[a-z]:[\\/])/i.test(words[i].raw) && !SHELLS.has(base(words[i].lc))) found.push(words[i].raw);
    for (let j = 0; j < words.length; j++) {
      if (!SHELLS.has(base(words[j].lc)) && words[j].raw !== '&') continue;
      for (let k = j + 1; k < words.length; k++) {
        const lc = words[k].lc;
        if (lc === '-c' || lc === '-command' || lc === '-encodedcommand') break;
        if (lc === '-file' || lc === '-f' || lc.startsWith('-')) continue;
        found.push(words[k].raw); break;
      }
    }
    return found;
  }
  const RESTART = /launchctl\s+kickstart\s+(?:-\w+\s+)*-k|launchctl\s+kickstart\s+-k|launchctl\s+bootstrap|systemctl\s+(?:--\S+\s+)*restart|paseo\s+(?:--\S+\s+\S+\s+)*daemon\s+start/i;
  const HEALTH = /\bcurl\b|\bwget\b|invoke-webrequest|invoke-restmethod|paseo\s+(?:--\S+\s+\S+\s+)*daemon\s+status|paseo\s+(?:--\S+\s+\S+\s+)*ls\b|launchctl\s+print|systemctl\s+(?:--\S+\s+)*is-active|\bnc\s+-z/i;
  /** A detached repair script: content that restarts a service and health-checks it after the restart. */
  const repairScript = text => { const at = text.search(RESTART); return at >= 0 && HEALTH.test(text.slice(at)); };
  async function check(command, { cwd = process.cwd(), shell = 'posix', depth = 0 } = {}) {
    const whole = String(command);
    if (depth === 0) processes = undefined;  // one process list per checked command, never a stale one
    // A trailing or standalone & (not &&, >&, &>) puts the command in the background.
    const background = /(^|[^&>])&(?![&>])/.test(whole);
    let dir = cwd;
    for (const words of segments(whole, shell)) {
      if (base(words[0].lc) === 'cd' && words[1]) { dir = resolvePath(dir, words[1].raw); continue; }
      const found = await inspect(words, whole);
      if (found) return found;
      if (depth >= MAX_DEPTH) continue;
      const detached = background && words.some(word => ['nohup', 'setsid'].includes(base(word.lc))) || words.some((word, at) => base(word.lc) === 'setsid' && words[at + 1]?.lc === '-f');
      for (const file of scriptsOf(words)) {
        const path = resolvePath(dir, file);
        const text = await readScript(path);
        if (typeof text !== 'string') continue;
        const inner = await check(text, { cwd: dir, shell: /\.ps1$/i.test(path) ? 'powershell' : shell, depth: depth + 1 });
        if (inner && !(detached && repairScript(text))) return refuse(`script ${file} runs ${inner.what}`, inner.entry);
      }
    }
    return null;
  }
  return { check, protectedServices: names.map(({ entry }) => entry) };
}

/** Refusal text for a finding: what ran, which protected name it touches, and the rule. */
export const refusalReason = found => `Refused by the fleet service guard: ${found.what} touches protected service "${found.entry}". Rule: ${GUARD_RULE}. `
  + 'Write that script with the write tool and run it as nohup bash <script> >log 2>&1 &. This guard is a backstop, not a sandbox.';

/**
 * Pure entry point for any harness: {block: false} or {block: true, reason, what, entry}. Options: protectedServices
 * (defaults added), resolvePid(pid) -> command line, listProcesses() -> [{pid, command}], readScript(path) -> text,
 * cwd, and shell ('posix' or 'powershell').
 */
export async function check(command, { protectedServices = [], cwd, shell, ...hooks } = {}) {
  const guard = serviceGuard({ protectedServices: [...new Set([...DEFAULT_PROTECTED, ...protectedServices])], ...hooks });
  const found = await guard.check(command, { cwd, shell });
  return found ? { block: true, reason: refusalReason(found), ...found } : { block: false };
}

/** guardConfig of a runtime.json path; an unreadable file keeps the defaults and warns. */
export function loadGuardConfig(path) {
  let runtime;
  try { runtime = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { protectedServices: [...DEFAULT_PROTECTED], warning: `cannot read ${path}; the service guard uses its defaults only` }; }
  return guardConfig(runtime);
}
function resolvePath(dir, file) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (/^~[\\/]/.test(file)) return join(home, file.slice(2));
  return isAbsolute(file) ? file : resolve(dir, file);
}
async function defaultReadScript(path) {
  try {
    const info = statSync(path);
    if (!info.isFile()) return null;
    const handle = readFileSync(path);
    return handle.subarray(0, SCRIPT_CAP).toString('utf8');
  } catch { return null; }
}
const run = (file, args, timeout) => new Promise((done, fail) => {
  execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    if (error && (error.killed || error.code === 'ENOENT' || typeof error.code !== 'number')) fail(error);
    else done({ code: error ? error.code : 0, stdout: String(stdout) });
  });
});
/** The command line of one process, '' when there is none; throws when it cannot be read in time. */
async function defaultResolvePid(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if($p){$p.Name+' '+$p.CommandLine}`], 5000);
    return stdout.trim();
  }
  const { code, stdout } = await run('ps', ['-ww', '-o', 'command=', '-p', String(Number(pid))], 3000);
  return code === 0 ? stdout.trim() : '';
}
async function defaultListProcesses() {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + ' ' + $_.Name + ' ' + $_.CommandLine }"], 8000);
    return stdout.split(/\r?\n/).filter(Boolean).map(line => ({ pid: line.split(' ')[0], command: line.slice(line.indexOf(' ') + 1) }));
  }
  const { stdout } = await run('ps', ['-axww', '-o', 'pid=,command='], 5000);
  return stdout.split('\n').filter(Boolean).map(line => { const m = /^\s*(\d+)\s+(.*)$/.exec(line); return m ? { pid: m[1], command: m[2] } : null; }).filter(Boolean);
}

// Hook mode. Anything unexpected (bad JSON, a guard error) refuses with exit 2, as Pi's tool_call does.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--runtime');
  const config = at > 0 ? loadGuardConfig(process.argv[at + 1]) : { protectedServices: [...DEFAULT_PROTECTED] };
  if (config.warning) process.stderr.write('service guard: ' + config.warning + '\n');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const event = JSON.parse(input || '{}');
      const command = event.command ?? event.tool_input?.command;
      if (typeof command !== 'string') process.exit(0);
      const shell = /powershell/i.test(event.tool_name ?? '') || event.shell === 'powershell' ? 'powershell' : 'posix';
      const verdict = await check(command, { protectedServices: config.protectedServices, cwd: event.cwd ?? process.cwd(), shell });
      if (verdict.block) { process.stderr.write(verdict.reason + '\n'); process.exit(2); }
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Refused by the fleet service guard: it failed (${String(error?.message ?? error).slice(0, 120)}). Rule: ${GUARD_RULE}.\n`);
      process.exit(2);
    }
  });
}

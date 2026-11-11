// Shared fleet service guard, dependency-free (Node built-ins only), used by fleet-routing.mjs for Pi and runnable as
// a hook: `node service-guard.mjs [--runtime <runtime.json>]` reads one JSON object on stdin ({"command": ...} or a
// Claude Code PreToolUse payload with tool_input.command), prints nothing and exits 0 to allow, or prints the reason
// on stderr and exits 2 to refuse.
//
// A backstop, not a sandbox: it refuses the plain and lightly obfuscated shell forms that stop, unload, disable or
// kill a shared fleet service (the model bridge, router, Tailscale, a Paseo daemon), so a forged instruction cannot
// take the fleet's own model traffic down with one bare command. Pi runs every bash and powershell call, nested
// codemode calls included, through tool_call first, and a handler error blocks the call. Generated names, interpreters
// other than a shell (python, node) and binaries it never sees still pass.
//
// How it reads a command: a quote-aware parse (POSIX or PowerShell) into segments of words, each segment ended by an
// operator. `$(...)`, backticks and PowerShell `(...)` leave a placeholder in their word and are checked as commands
// of their own; text in quotes is also checked as a mention (literal protected names only); `bash -c`, `eval`,
// `pwsh -Command` strings, heredocs into a shell and local scripts a segment runs are checked as commands. A refused
// verb whose target is not a plain literal (computed, piped, a variable or a glob) falls back to the whole command.
import { execFile } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
export const GUARD_RULE = 'shared fleet service: use one detached nohup script that changes, restarts, health-checks and rolls back';
// Generic defaults, always on: the Paseo daemon (its process titles, launchd label shape and server package) and
// Tailscale. Real labels, units and process names come from runtime.json guard.protectedServices.
export const DEFAULT_PROTECTED = ['Paseo Daemon', 'Paseo Supervisor', 'paseo-daemon', '@getpaseo/server', 'tailscaled', 'tailscale'];
const SCRIPT_CAP = 256 * 1024;
const MAX_DEPTH = 4;
const REGEX_MS = 250;
// The output of a substitution inside a word, and unquoted brace characters awaiting brace expansion.
const SUB = '\u0001', BO = '\u0002', BC = '\u0003', BS = '\u0004';
const norm = value => String(value).toLowerCase().replace(/[\s_]+/g, '-');
const base = word => String(word).split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
const home = () => process.env.HOME ?? process.env.USERPROFILE ?? '';
// A target written out in full: no substitution, variable, glob, brace or xargs placeholder.
const isPlain = word => !/[\u0001$*?[\]{}`]/.test(word.v);
const options = list => list.filter(word => !/^-./.test(word.v));

/** runtime.json's guard.protectedServices plus the defaults; a missing or invalid value keeps the defaults and warns. */
export function guardConfig(runtime) {
  const list = runtime?.guard?.protectedServices;
  if (runtime?.guard === undefined) return { protectedServices: [...DEFAULT_PROTECTED], warning: 'runtime.json has no guard.protectedServices; the service guard uses its defaults only' };
  if (!Array.isArray(list) || !list.every(entry => typeof entry === 'string' && entry.trim().length >= 3))
    return { protectedServices: [...DEFAULT_PROTECTED], warning: 'runtime.json guard.protectedServices is not a list of names of 3 or more characters; the service guard uses its defaults only' };
  return { protectedServices: [...new Set([...DEFAULT_PROTECTED, ...list.map(entry => entry.trim())])] };
}

// ---- Parsing -------------------------------------------------------------------------------------------------------

const segment = prev => ({ words: [], redirects: [], input: [], subs: [], nested: [], end: null, pipeIn: prev === '|' });
function expandBraces(value, limit = 64) {
  const out = [], queue = [value];
  while (queue.length && out.length + queue.length <= limit) {
    const cur = queue.shift();
    let split = false;
    for (let a = cur.indexOf(BO); a >= 0 && !split; a = cur.indexOf(BO, a + 1)) {
      let depth = 0;
      const commas = [];
      for (let b = a; b < cur.length; b++) {
        if (cur[b] === BO) depth++;
        else if (cur[b] === BS && depth === 1) commas.push(b);
        else if (cur[b] === BC && --depth === 0) {
          if (commas.length) {
            let from = a + 1;
            for (const at of [...commas, b]) { queue.push(cur.slice(0, a) + cur.slice(from, at) + cur.slice(b + 1)); from = at + 1; }
            split = true;
          }
          break;
        }
      }
    }
    if (!split) out.push(cur);
  }
  const words = [...out, ...queue].map(word => word.replaceAll(BO, '{').replaceAll(BC, '}').replaceAll(BS, ','));
  return words.length > 1 ? words.filter(Boolean) : words;
}
const ANSI = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

class Parser {
  constructor(text, shell) { this.s = text; this.i = 0; this.ps = shell === 'powershell'; this.heredocs = []; }
  // A list of segments up to `close` (')' for a substitution or subshell) or the end of the text.
  list(close) {
    const s = this.s, nodes = [];
    let seg = segment(null), word = null, redirect = null;
    const W = () => (word ??= { v: '', quoted: false });
    const take = () => {
      if (!word) return;
      const done = word; word = null;
      if (redirect) {
        const op = redirect, v = expandBraces(done.v)[0];
        redirect = null;
        if (op === '<<' || op === '<<-') this.heredocs.push({ seg, delim: v, strip: op === '<<-' });
        else if (op === '<<<') seg.input.push(v);
        else seg.redirects.push({ op, target: { v, quoted: done.quoted } });
        return;
      }
      for (const v of expandBraces(done.v)) seg.words.push({ v, quoted: done.quoted });
    };
    const end = op => {
      take(); redirect = null;
      if (seg.words.length || seg.subs.length || seg.redirects.length || seg.input.length || seg.nested.length) { seg.end = op; nodes.push(seg); }
      seg = segment(op);
    };
    const sub = () => { seg.nested.push(this.list(')')); W().v += SUB; };
    while (this.i < s.length) {
      const c = s[this.i], n = s[this.i + 1];
      if (close && c === close) { this.i++; end(close); return nodes; }
      if (c === ' ' || c === '\t' || c === '\r') { take(); this.i++; continue; }
      if (c === '\n') { end('\n'); this.i++; this.readHeredocs(); continue; }
      if (this.ps && c === '<' && n === '#') { const at = s.indexOf('#>', this.i + 2); this.i = at < 0 ? s.length : at + 2; continue; }
      if (c === '#' && !word) { while (this.i < s.length && s[this.i] !== '\n') this.i++; continue; }
      if (!this.ps && c === '\\') { if (n === '\n') { this.i += 2; continue; } W().v += n ?? ''; word.quoted = true; this.i += 2; continue; }
      if (this.ps && c === '`') { if (n === '\n') { this.i += 2; continue; } W().v += n ?? ''; this.i += 2; continue; }
      if (c === "'") { W().v += this.single(); word.quoted = true; continue; }
      if (!this.ps && c === '$' && n === "'") { this.i++; W().v += this.ansi(); word.quoted = true; continue; }
      if (!this.ps && c === '$' && n === '"') { this.i++; continue; }
      if (c === '"') { W().v += this.double(seg); word.quoted = true; continue; }
      if (c === '$' && n === '{') { const at = s.indexOf('}', this.i); const to = at < 0 ? s.length : at + 1; W().v += s.slice(this.i, to); this.i = to; continue; }
      if ((c === '$' || (this.ps && c === '@')) && n === '(') { this.i += 2; sub(); continue; }
      if (this.ps && c === '@' && (n === "'" || n === '"') && /[\r\n]/.test(s[this.i + 2] ?? '')) {
        const at = s.indexOf('\n' + n + '@', this.i + 2), to = at < 0 ? s.length : at;
        W().v += s.slice(this.i + 3, to); word.quoted = true; this.i = at < 0 ? s.length : at + 3; continue;
      }
      if (!this.ps && c === '`') { seg.nested.push(this.backtick()); W().v += SUB; continue; }
      if (!this.ps && (c === '<' || c === '>') && n === '(' && !word) { this.i += 2; sub(); continue; }
      if (c === '(') {
        this.i++;
        if (this.ps) sub();
        else { take(); seg.subs.push(this.list(')')); }
        continue;
      }
      if (c === ')') { end(')'); this.i++; continue; }
      if (this.ps && (c === '{' || c === '}')) { end(c); this.i++; continue; }
      if (!this.ps && (c === '{' || c === '}' || c === ',')) { W().v += c === '{' ? BO : c === '}' ? BC : BS; this.i++; continue; }
      if (c === ';') { end(';'); this.i += n === ';' ? 2 : 1; continue; }
      if (c === '|') { end(n === '|' ? '||' : '|'); this.i += n === '|' || n === '&' ? 2 : 1; continue; }
      if (c === '&') {
        if (n === '&') { end('&&'); this.i += 2; continue; }
        if (!this.ps && n === '>') { take(); redirect = '&>'; this.i += s[this.i + 2] === '>' ? 3 : 2; continue; }
        if (this.ps && !word && !seg.words.length) { seg.words.push({ v: '&', quoted: false }); this.i++; continue; }  // call operator
        end('&'); this.i++; continue;
      }
      if (c === '<' || c === '>') {
        if (word && !word.quoted && (/^\d+$/.test(word.v) || word.v === '*')) word = null; else take();
        let op = c, j = this.i + 1;
        if (c === '>' && '>|&'.includes(s[j] ?? '-')) op += s[j++];
        else if (c === '<' && s[j] === '<') { op += s[j++]; if (s[j] === '<' || s[j] === '-') op += s[j++]; }
        else if (c === '<' && '&>'.includes(s[j] ?? '-')) op += s[j++];
        this.i = j; redirect = op; continue;
      }
      W().v += c; this.i++;
    }
    end(null);
    return nodes;
  }
  single() {
    const s = this.s;
    let j = this.i + 1, out = '';
    while (j < s.length) {
      if (s[j] === "'") { if (this.ps && s[j + 1] === "'") { out += "'"; j += 2; continue; } break; }
      out += s[j++];
    }
    this.i = j + 1;
    return out;
  }
  ansi() {
    const s = this.s;
    let j = this.i + 1, out = '';
    while (j < s.length && s[j] !== "'") {
      if (s[j] !== '\\') { out += s[j++]; continue; }
      const e = s[j + 1];
      let m;
      if ((m = /^x([0-9a-fA-F]{1,2})/.exec(s.slice(j + 1))) || (m = /^u([0-9a-fA-F]{1,4})/.exec(s.slice(j + 1))) || (m = /^U([0-9a-fA-F]{1,8})/.exec(s.slice(j + 1)))) {
        out += String.fromCodePoint(Math.min(parseInt(m[1], 16), 0x10ffff)); j += 1 + m[0].length; continue;
      }
      if ((m = /^[0-7]{1,3}/.exec(s.slice(j + 1)))) { out += String.fromCharCode(parseInt(m[0], 8)); j += 1 + m[0].length; continue; }
      if (e === 'c' && s[j + 2]) { out += String.fromCharCode(s.charCodeAt(j + 2) & 31); j += 3; continue; }
      out += ANSI[e] ?? '\\' + (e ?? ''); j += 2;
    }
    this.i = j + 1;
    return out;
  }
  double(seg) {
    const s = this.s;
    let out = '';
    this.i++;
    while (this.i < s.length) {
      const c = s[this.i], n = s[this.i + 1];
      if (c === '"') { if (this.ps && n === '"') { out += '"'; this.i += 2; continue; } break; }
      if (this.ps && c === '`') { out += n ?? ''; this.i += 2; continue; }
      if (!this.ps && c === '\\' && '$`"\\\n'.includes(n ?? '-')) { if (n !== '\n') out += n; this.i += 2; continue; }
      if (c === '$' && n === '(') { this.i += 2; seg.nested.push(this.list(')')); out += SUB; continue; }
      if (!this.ps && c === '`') { seg.nested.push(this.backtick()); out += SUB; continue; }
      out += c; this.i++;
    }
    this.i++;
    return out;
  }
  backtick() {
    const s = this.s;
    let j = this.i + 1, body = '';
    while (j < s.length && s[j] !== '`') { if (s[j] === '\\' && '`\\$'.includes(s[j + 1] ?? '-')) { body += s[j + 1]; j += 2; continue; } body += s[j++]; }
    this.i = j + 1;
    return new Parser(body, 'posix').list(null);
  }
  readHeredocs() {
    const s = this.s;
    for (const doc of this.heredocs.splice(0)) {
      const lines = [];
      while (this.i < s.length) {
        const at = s.indexOf('\n', this.i), to = at < 0 ? s.length : at;
        const line = s.slice(this.i, to).replace(/\r$/, '');
        this.i = at < 0 ? s.length : at + 1;
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
        lines.push(line);
      }
      doc.seg.input.push(lines.join('\n'));
    }
  }
}

/** Parse a command line or script into segments: {words: [{v, quoted}], redirects, input, subs, nested, end, pipeIn}. */
export function parse(text, shell = 'posix') { return new Parser(String(text), shell).list(null); }
const flatten = (nodes, out = []) => {
  for (const seg of nodes) { out.push(seg); for (const list of [...seg.subs, ...seg.nested]) flatten(list, out); }
  return out;
};

// ---- Command shapes ------------------------------------------------------------------------------------------------

const LAUNCHCTL = new Set(['bootout', 'unload', 'remove', 'kill', 'disable', 'stop']);
const SYSTEMCTL = new Set(['stop', 'disable', 'kill', 'mask', 'restart', 'try-restart', 'reload-or-restart', 'condrestart']);
const STOP_SERVICE = new Set(['stop-service', 'spsv', 'suspend-service', 'remove-service', 'restart-service']);
const STOP_TASK = new Set(['stop-scheduledtask', 'disable-scheduledtask', 'unregister-scheduledtask']);
const PKILL_ARG = new Set(['-u', '-U', '-g', '-G', '-P', '-s', '-t', '-F', '--signal', '--euid', '--uid', '--group', '--pgroup', '--session', '--terminal', '--pidfile', '--ns', '--nslist']);
const KILLALL_ARG = new Set(['-s', '-u', '-t', '-c', '-o', '-y', '--signal', '--user', '--context', '--older-than', '--younger-than']);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish']);
const PS_SHELLS = new Set(['pwsh', 'powershell']);
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'coproc']);
// Commands that run the rest of their words as a command, with the options that take a value and leading positionals.
const WRAPPERS = {
  sudo: { vals: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir', '--close-from', '--role', '--type', '--other-user', '--command-timeout'] },
  doas: { vals: ['-u', '-C'] }, env: { vals: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'] }, nice: { vals: ['-n', '--adjustment'] },
  ionice: { vals: ['-c', '-n', '-p', '--class', '--classdata'] }, timeout: { vals: ['-s', '-k', '--signal', '--kill-after'], pos: 1 },
  time: { vals: ['-f', '-o', '--format', '--output'] }, stdbuf: { vals: ['-i', '-o', '-e'] }, caffeinate: { vals: ['-t', '-w'] },
  xargs: { vals: ['-I', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--eof', '--max-lines', '--max-chars'] },
  watch: { vals: ['-n', '--interval'] }, exec: { vals: ['-a'] }, nohup: { vals: [] }, setsid: { vals: [] }, command: { vals: [] },
  builtin: { vals: [] }, unbuffer: { vals: [] }, chronic: { vals: [] },
};
// Where the command of a segment starts, past assignments, keywords and wrappers, and whether nohup or setsid ran it.
function commandAt(words) {
  let i = 0, nohup = false, setsid = false, fork = false;
  const strings = [];
  while (i < words.length) {
    const v = words[i].v, b = base(v);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v) || KEYWORDS.has(v.toLowerCase())) { i++; continue; }
    const wrap = WRAPPERS[b];
    if (!wrap || /[\\/]/.test(v) && !/^\/(usr\/)?(s?bin)\//.test(v)) break;
    if (b === 'nohup') nohup = true;
    if (b === 'setsid') setsid = true;
    i++;
    while (i < words.length && /^-./.test(words[i].v)) {
      const option = words[i].v;
      if (option === '--') { i++; break; }
      if (b === 'setsid' && (option === '-f' || option === '--fork')) fork = true;
      if (b === 'env' && (option === '-S' || option === '--split-string') && words[i + 1]) strings.push(words[i + 1].v);
      i += wrap.vals.includes(option) ? 2 : 1;
    }
    i += wrap.pos ?? 0;
  }
  return { at: i, nohup, setsid, fork, strings };
}
const psOption = (word, name, min) => word.length >= min && name.startsWith(word);
const PS_VALUED = ['-executionpolicy', '-windowstyle', '-workingdirectory', '-configurationname', '-outputformat', '-inputformat', '-version', '-psconsolefile', '-custompipename', '-settingsfile'];

// ---- The guard -----------------------------------------------------------------------------------------------------

// A JavaScript regex run in a vm context with a time limit, so a pattern such as (a|aa)+$ cannot block the event loop.
const REGEX_TEST = new Script('result = null; const re = new RegExp(pattern, "i"); result = lines.map(line => re.test(line));');
let regexContext;
class PatternTimeout extends Error {}
/** For each line, whether the pattern matches it; null when the pattern is not a valid regex; throws on a timeout. */
function regexTest(pattern, lines) {
  regexContext ??= createContext({});
  Object.assign(regexContext, { pattern, lines, result: null });
  try { REGEX_TEST.runInContext(regexContext, { timeout: REGEX_MS }); }
  catch (error) { if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new PatternTimeout('pattern timeout'); return null; }
  return Array.from(regexContext.result);
}

export function serviceGuard({ protectedServices = DEFAULT_PROTECTED, resolvePid = defaultResolvePid, listProcesses = defaultListProcesses,
  readScript = defaultReadScript } = {}) {
  const names = protectedServices.map(entry => ({ entry, n: norm(entry) }));
  // Every protected entry a word names: it contains the entry, or (4+ characters) is part of one; for a glob, any
  // literal fragment of 4+ characters that is part of an entry. A substitution's placeholder splits the word.
  const hitsOf = value => {
    const hits = new Set();
    const glob = /[*?[]/.test(value);
    for (const piece of String(value).split(SUB)) {
      const n = norm(piece);
      if (!n) continue;
      for (const { entry, n: p } of names) if (n.includes(p) || (n.length >= 4 && p.includes(n))) hits.add(entry);
      if (glob) for (const fragment of piece.split(/[*?[\]\\/{}\s]+/)) {
        const f = norm(fragment);
        if (f.length >= 4) for (const { entry, n: p } of names) if (p.includes(f) || f.includes(p)) hits.add(entry);
      }
    }
    return hits;
  };
  const wordHit = value => hitsOf(value).values().next().value;
  // Literal mention: the text contains a whole entry.
  const textHit = text => { const n = norm(text); return names.find(({ n: p }) => n.includes(p))?.entry; };
  const patternHit = pattern => {
    const hit = wordHit(pattern);
    if (hit || pattern.length < 3) return hit;
    const matches = regexTest(pattern, names.map(({ entry }) => entry));
    return matches ? names[matches.indexOf(true)]?.entry : undefined;
  };
  const refuse = (what, entry) => ({ what, entry });
  const running = job => job.processes ??= Promise.resolve().then(listProcesses);

  async function pidHit(pid) {
    let line;
    try { line = await resolvePid(pid); }
    catch { return refuse(`kill ${pid}`, 'a process whose command line could not be read in time'); }
    const hit = line && textHit(line);
    return hit ? refuse(`kill ${pid}`, hit) : null;
  }
  // The protected process a list of pgrep/pkill patterns would match on this host.
  async function processHit(cmd, patterns, job) {
    let list;
    try { list = await running(job); }
    catch { return 'a process list that could not be read in time'; }
    const lines = list.map(proc => String(proc.command));
    for (const pattern of patterns) {
      let matches;
      try { matches = regexTest(pattern, lines); } catch { return 'a pattern too complex to check in time'; }
      const lower = pattern.toLowerCase();
      for (let k = 0; k < lines.length; k++) {
        const match = (cmd === 'killall' && lines[k].split(/\s+/).some(part => base(part) === lower))
          || (matches ? matches[k] : lines[k].toLowerCase().includes(lower));
        const hit = match && textHit(lines[k]);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  const patternsOf = (cmd, rest) => {
    const valued = cmd === 'killall' ? KILLALL_ARG : PKILL_ARG, out = [];
    for (let j = 0; j < rest.length; j++) {
      if (valued.has(rest[j].v)) { j++; continue; }
      if (!rest[j].v.startsWith('-')) out.push(rest[j]);
    }
    return out;
  };
  // The fallback for a refused verb with a computed target: any argument word anywhere in the text that names a
  // protected service, or a pgrep/pidof/Get-Process pattern that matches a protected process on this host.
  function wholeHit(run) {
    return run.whole ??= (async () => {
      const segs = flatten(run.root);
      for (const seg of segs) {
        const { at } = commandAt(seg.words);
        for (let j = 0; j < seg.words.length; j++) { if (j === at) continue; const hit = wordHit(seg.words[j].v); if (hit) return hit; }
      }
      for (const seg of segs) {
        for (let i = 0; i < seg.words.length; i++) {
          const cmd = base(seg.words[i].v);
          if (!['pgrep', 'pidof', 'get-process', 'gps'].includes(cmd)) continue;
          const patterns = patternsOf('pkill', seg.words.slice(i + 1)).map(word => word.v).filter(v => !v.includes(SUB));
          const hit = patterns.length && await processHit(cmd, patterns, run.job);
          if (hit) return hit;
        }
      }
      return undefined;
    })();
  }

  // The refusal for one segment, or null. Verbs are matched anywhere in the segment, so wrappers and echoes are seen
  // through. In a mention (quoted text) only a literal protected name refuses.
  async function inspect(seg, run, mention) {
    const words = seg.words, lc = words.map(word => word.v.toLowerCase());
    const xargsAt = lc.findIndex(word => base(word) === 'xargs');
    const decide = async (what, targets, at) => {
      for (const word of targets) { const hit = mention ? textHit(word.v.replaceAll(SUB, ' ')) : wordHit(word.v); if (hit) return refuse(what, hit); }
      if (mention) return null;
      if (targets.length && targets.every(isPlain) && !seg.pipeIn && !(xargsAt >= 0 && xargsAt < at)) return null;
      const hit = await wholeHit(run);
      return hit ? refuse(`${what} of a computed target`, hit) : null;
    };
    const without = (list, k) => options(list.filter((_, j) => j !== k));
    for (let i = 0; i < words.length; i++) {
      const cmd = base(lc[i]), rest = words.slice(i + 1), rl = lc.slice(i + 1);
      let found = null;
      if (cmd === 'launchctl') {
        const k = rl.findIndex(word => LAUNCHCTL.has(word));
        if (k >= 0) {
          const targets = without(rest, k);
          if (!mention && rl[k] === 'bootout' && targets.length === 1 && /^((gui|user|login|session)\/(\d+|\u0001)|system)$/.test(targets[0].v.toLowerCase()))
            return refuse('launchctl bootout of a whole domain', 'every service in that domain');
          found = await decide(`launchctl ${rl[k]}`, targets, i);
        }
      } else if (cmd === 'systemctl') {
        const k = rl.findIndex(word => SYSTEMCTL.has(word));
        if (k >= 0) found = await decide(`systemctl ${rl[k]}`, without(rest, k), i);
      } else if (cmd === 'service') {
        const k = rl.findIndex(word => ['stop', 'restart', 'force-stop', 'force-reload'].includes(word));
        if (k >= 0) found = await decide(`service ${rl[k]}`, without(rest, k), i);
      } else if (cmd === 'brew' && rl[0] === 'services' && ['stop', 'restart', 'kill'].includes(rl[1])) {
        found = await decide(`brew services ${rl[1]}`, options(rest.slice(2)), i);
      } else if (STOP_SERVICE.has(cmd) || STOP_TASK.has(cmd)) {
        found = await decide(cmd, options(rest), i);
      } else if (cmd === 'set-service') {
        const stopped = word => /^(-(status|startuptype):)?(stopped|paused|disabled)$/.test(word);
        if (rl.some(stopped)) found = await decide('Set-Service stopped or disabled', options(rest.filter((_, j) => !stopped(rl[j]))), i);
      } else if (cmd === 'sc') {
        const k = rl.findIndex(word => ['stop', 'delete', 'pause'].includes(word));
        if (k >= 0 || (rl.includes('config') && rl.some(word => word.includes('disabled'))))
          found = await decide(`sc ${k >= 0 ? rl[k] : 'config disabled'}`, options(rest.filter((_, j) => !['stop', 'delete', 'pause', 'config', 'start=', 'disabled', 'start=disabled'].includes(rl[j]))), i);
      } else if (cmd === 'net' && rl[0] === 'stop') {
        found = await decide('net stop', options(rest.slice(1)), i);
      } else if (cmd === 'schtasks') {
        if (rl.includes('/end') || rl.includes('/delete') || (rl.includes('/change') && rl.includes('/disable')))
          found = await decide('schtasks', rest.filter(word => !/^[-/]/.test(word.v)), i);
      } else if (cmd === 'paseo') {
        const at = rl.indexOf('daemon');
        const verb = at >= 0 && rl.slice(at + 1).find(word => ['stop', 'restart', 'uninstall'].includes(word));
        if (verb) return refuse(`paseo daemon ${verb}`, 'Paseo daemon');
      } else if (cmd === 'tailscale') {
        const verb = rl.find(word => ['down', 'logout', 'switch'].includes(word));
        if (verb) return refuse(`tailscale ${verb}`, 'tailscale');
        if ((rl.includes('serve') || rl.includes('funnel')) && rl.some(word => word === 'off' || word === 'reset' || word.endsWith('=off')))
          return refuse('tailscale serve off/reset', 'tailscale serve');
        if (rl.includes('set') && rl.some(word => word === '--shields-up' || word === '--shields-up=true'))
          return refuse('tailscale set --shields-up', 'tailscale');
      } else if (cmd === 'kill' || cmd === 'stop-process' || cmd === 'spps') {
        found = await killTargets(cmd, rest, run, mention);
      } else if (cmd === 'pkill' || cmd === 'killall') {
        found = await patternTargets(cmd, rest, run, mention);
      } else if (cmd === 'taskkill') {
        found = await taskkillTargets(rest, run, mention);
      }
      if (found) return found;
    }
    return null;
  }
  async function killTargets(cmd, rest, run, mention) {
    const args = rest.map(word => word.v.toLowerCase());
    let i = 0, literal = 0, computed = 0, signalled = false, flag = null;
    if (args[0] === '-l' || args[0] === '-L') return null;
    if (args[0] === '-s' || args[0] === '-n') { i = 2; signalled = true; }
    else if (args[0]?.startsWith('-') && args[0] !== '--' && !['-id', '-name', '-processname', '-force', '-inputobject'].includes(args[0])) { i = 1; signalled = true; }
    if (!mention && signalled && i === 1 && args[0] === '-1' && args.length === 1) return refuse('kill -1', 'every process');
    for (; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') continue;
      if (['-id', '-name', '-processname', '-inputobject'].includes(arg)) { flag = arg; continue; }
      if (['-force', '-passthru', '-confirm', '-whatif'].includes(arg)) continue;
      for (const value of rest[i].v.split(',').filter(Boolean)) {
        if (flag === '-name' || flag === '-processname') {
          literal++;
          let hit;
          try { hit = mention ? textHit(value) : patternHit(value); } catch { return refuse('Stop-Process -Name', 'a pattern too complex to check in time'); }
          if (hit) return refuse('Stop-Process -Name', hit);
          continue;
        }
        if (mention) continue;
        if (/^-\d+$/.test(value) || value === '0') return refuse(`kill ${value}`, 'a process group');
        if (/^\d+$/.test(value)) { literal++; const found = await pidHit(value); if (found) return found; continue; }
        if (value.startsWith('%')) { literal++; continue; }
        computed++;
      }
    }
    if (mention || (literal && !computed)) return null;
    // kill $(pgrep ...), ... | xargs kill or kill $PID: the target is computed, so check the whole command.
    const hit = await wholeHit(run);
    return hit ? refuse(`${cmd} of a computed target`, hit) : null;
  }
  async function patternTargets(cmd, rest, run, mention) {
    const patterns = patternsOf(cmd, rest);
    for (const pattern of patterns) {
      let hit;
      try { hit = mention ? textHit(pattern.v) : patternHit(pattern.v); } catch { return refuse(`${cmd} ${pattern.v}`, 'a pattern too complex to check in time'); }
      if (hit) return refuse(`${cmd} ${pattern.v}`, hit);
    }
    if (mention) return null;
    if (!patterns.length || patterns.some(pattern => /\u0001|\$[A-Za-z_{(]/.test(pattern.v))) {
      const hit = await wholeHit(run);
      if (hit) return refuse(`${cmd} of a computed target`, hit);
    }
    const literal = patterns.map(pattern => pattern.v).filter(v => !v.includes(SUB));
    const hit = literal.length && await processHit(cmd, literal, run.job);
    return hit ? refuse(`${cmd} ${literal.join(' ')}`, hit) : null;
  }
  async function taskkillTargets(rest, run, mention) {
    let literal = 0, computed = 0;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i].v.toLowerCase(), value = rest[i + 1]?.v;
      if (flag === '/im' && value) { literal++; const hit = mention ? textHit(value) : wordHit(value.replace(/\.exe$/i, '').replace(/\*/g, '')); if (hit) return refuse('taskkill /IM', hit); }
      if (flag === '/pid' && value && !mention) { if (/^\d+$/.test(value)) { literal++; const found = await pidHit(value); if (found) return found; } else computed++; }
      if (flag === '/fi') computed++;
    }
    if (mention || (literal && !computed)) return null;
    const hit = await wholeHit(run);
    return hit ? refuse('taskkill of a computed target', hit) : null;
  }

  // What one segment runs besides itself: command strings (bash -c, eval, pwsh -Command, env -S) and script files.
  function runsOf(seg) {
    const words = seg.words, lc = words.map(word => word.v.toLowerCase());
    const { at, nohup, setsid, fork, strings } = commandAt(words);
    const items = strings.map(command => ({ command, shell: 'posix' }));
    // Detached: the segment's own command starts with nohup or setsid and the segment ends in a bare & (or setsid -f).
    const detached = (nohup || setsid) && (seg.end === '&' || fork);
    const script = word => items.push({ file: word.v, detached });
    if (at >= words.length) return items;
    const c = base(lc[at]);
    if (c === 'eval') { items.push({ command: words.slice(at + 1).map(word => word.v).join(' '), shell: 'posix' }); return items; }
    if (POSIX_SHELLS.has(c)) {
      let j = at + 1;
      for (; j < words.length; j++) {
        const a = words[j].v;
        if (a === '--') { j++; break; }
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) { if (words[j + 1]) items.push({ command: words[j + 1].v, shell: 'posix' }); return items; }
        if (['-o', '+o', '-O', '+O'].includes(a)) { j++; continue; }
        if (a === '--rcfile' || a === '--init-file') { if (words[j + 1]) script(words[j + 1]); j++; continue; }
        if (/^[-+]./.test(a)) continue;
        break;
      }
      if (j < words.length) { script(words[j]); return items; }
      for (const redirect of seg.redirects) if (redirect.op === '<') script(redirect.target);
      const prev = seg.pipeIn && seg.prev;
      if (prev) {
        const from = commandAt(prev.words).at;
        if (['cat', 'type', 'get-content', 'gc', 'more'].includes(base(prev.words[from]?.v ?? ''))) for (const word of options(prev.words.slice(from + 1))) script(word);
      }
      return items;
    }
    if (PS_SHELLS.has(c)) {
      for (let j = at + 1; j < words.length; j++) {
        const a = lc[j].replace(/^\//, '-');
        if (a === '-ex' || a === '-ep' || PS_VALUED.some(name => psOption(a, name, 3))) { j++; continue; }
        if (psOption(a, '-file', 2)) { if (words[j + 1]) script(words[j + 1]); return items; }
        if (psOption(a, '-command', 2)) { items.push({ command: words.slice(j + 1).map(word => word.v).join(' '), shell: 'powershell' }); return items; }
        if (psOption(a, '-encodedcommand', 2) || a === '-ec') {
          const text = Buffer.from(words[j + 1]?.v ?? '', 'base64').toString('utf16le');
          items.push({ command: text, shell: 'powershell' }); return items;
        }
        if (a.startsWith('-')) continue;
        script(words[j]); items.push({ command: words.slice(j).map(word => word.v).join(' '), shell: 'powershell' }); return items;
      }
      return items;
    }
    if (c === 'source' || c === '.' || c === '&') { if (words[at + 1]) script(words[at + 1]); return items; }
    if (/^(\.{1,2}[\\/]|[\\/]|~[\\/]|[a-z]:[\\/])/i.test(words[at].v)) script(words[at]);
    return items;
  }
  // Relative script paths resolve against the segment's directory, and against every other directory the command
  // could have moved to when a cd could not be followed or went to more than one place.
  function candidates(file, state, job) {
    let path = file.replace(/^~(?=[\\/]|$)/, home());
    let unresolved = false;
    if (/[\u0001$]/.test(path)) { unresolved = true; path = path.replace(/^.*[\u0001$][^\\/]*[\\/]?/, ''); if (!path) return { paths: [], unresolved }; }
    if (isAbsolute(path)) return { paths: [path], unresolved };
    const dirs = [state.dir, ...((state.uncertain || unresolved || job.dirs.size > 1) ? [...job.dirs, home()] : [])];
    return { paths: [...new Set(dirs.map(dir => resolve(dir, path)))], unresolved };
  }
  async function scriptFinding(item, run, state, mention) {
    const { paths, unresolved } = candidates(item.file, state, run.job);
    let seen = 0;
    for (const path of paths) {
      const text = await readScript(path);
      if (text === null || text === undefined) continue;
      seen++;
      if (typeof text === 'object' && text.tooLarge) {
        if (mention) continue;
        return refuse(`script ${item.file} is over ${SCRIPT_CAP / 1024} KB`, 'a script too large to check');
      }
      if (typeof text !== 'string') continue;
      if (run.depth + 1 > MAX_DEPTH) {
        if (mention) continue;
        return refuse(`script ${item.file} runs scripts more than ${MAX_DEPTH} levels deep`, 'a script nested too deeply to check');
      }
      const inner = await analyze(text, /\.ps1$/i.test(path) ? 'powershell' : 'posix', state.dir, run.depth + 1, run.job, true);
      if (!inner.findings.length || (item.detached && !mention && repaired(inner))) continue;
      return refuse(`script ${item.file} runs ${inner.findings[0].what}`, inner.findings[0].entry);
    }
    if (!seen && !mention && (state.uncertain || unresolved) && /stop|kill|bootout|unload|disable|down|remove|restart/i.test(base(item.file)))
      return refuse(`script ${item.file}, which could not be located`, 'a script that could not be located');
    return null;
  }
  // A detached repair script: every stop it makes is followed (or made) by a restart naming the same entry, and a
  // health check comes after that restart. Comments never count: the parser drops them.
  const repaired = run => run.findings.every(found => run.restarts.some(restart => restart.index >= found.index
    && (restart.entries.has(norm(found.entry)) || restart.words.some(word => hitsOf(word.v).has(found.entry)))
    && run.healths.some(at => at > restart.index)));
  function restartOf(words) {
    const lc = words.map(word => word.v.toLowerCase()), out = { words: [], entries: new Set() };
    for (let i = 0; i < words.length; i++) {
      const cmd = base(lc[i]), rest = words.slice(i + 1), rl = lc.slice(i + 1);
      if ((cmd === 'launchctl' && rl.some(word => ['kickstart', 'bootstrap', 'load', 'enable'].includes(word)))
        || (cmd === 'systemctl' && rl.some(word => ['start', 'restart', 'try-restart', 'reload-or-restart'].includes(word)))
        || (cmd === 'service' && rl.some(word => ['start', 'restart'].includes(word)))
        || (cmd === 'brew' && rl[0] === 'services' && ['start', 'restart'].includes(rl[1]))
        || ['start-service', 'sasv', 'restart-service', 'start-scheduledtask'].includes(cmd)
        || (cmd === 'set-service' && rl.some(word => /running$/.test(word)))
        || ((cmd === 'sc' || cmd === 'net') && rl.includes('start')) || (cmd === 'schtasks' && rl.includes('/run'))) out.words.push(...options(rest));
      if (cmd === 'paseo' && rl.includes('daemon') && rl.some(word => word === 'start' || word === 'restart')) out.entries.add(norm('Paseo daemon'));
      if (cmd === 'tailscale' && rl.includes('up')) out.entries.add('tailscale');
      if (cmd === 'tailscale' && (rl.includes('serve') || rl.includes('funnel')) && !rl.some(word => word === 'off' || word === 'reset')) { out.entries.add('tailscale-serve'); out.entries.add('tailscale'); }
    }
    return out.words.length || out.entries.size ? out : null;
  }
  const healthOf = words => {
    const lc = words.map(word => word.v.toLowerCase());
    return lc.some((word, i) => {
      const cmd = base(word), rl = lc.slice(i + 1);
      return ['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'test-netconnection', 'nc', 'pgrep', 'get-service'].includes(cmd)
        || (cmd === 'launchctl' && rl.includes('print')) || (cmd === 'systemctl' && (rl.includes('is-active') || rl.includes('status')))
        || (cmd === 'paseo' && (rl.includes('status') || rl.includes('ls'))) || (cmd === 'tailscale' && (rl.includes('status') || rl.includes('ping')))
        || (cmd === 'sc' && rl.includes('query'));
    });
  };

  // Known variables ($HOME, $PWD and earlier NAME=value assignments) are expanded; an unquoted expansion with spaces
  // splits into words, as the shell does.
  const expandVars = (words, state) => words.flatMap(word => {
    if (!word.v.includes('$')) return [word];
    let changed = false;
    const v = word.v.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (match, a, b) => {
      const name = a ?? b;
      const value = name === 'HOME' ? home() : name === 'PWD' ? state.dir : state.vars[name];
      if (value === undefined) return match;
      changed = true;
      return value;
    });
    if (!changed) return [word];
    return !word.quoted && /\s/.test(v) ? v.split(/\s+/).filter(Boolean).map(part => ({ v: part, quoted: false })) : [{ ...word, v }];
  });
  const copy = state => ({ ...state, vars: { ...state.vars } });
  const stopped = run => !run.collect && run.findings.length > 0;
  async function walk(nodes, run, state, mention) {
    let prev = null;
    for (const seg of nodes) {
      const index = run.order++;
      for (const list of [...seg.subs, ...seg.nested]) { await walk(list, run, copy(state), mention); if (stopped(run)) return; }
      const words = expandVars(seg.words, state);
      const view = { ...seg, words, prev };
      prev = view;
      if (!words.length && !seg.input.length && !seg.redirects.length) continue;
      const { at } = commandAt(words);
      const cmd = base(words[at]?.v ?? '');
      if (['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl', 'push-location', 'pop-location'].includes(cmd)) {
        const arg = options(words.slice(at + 1))[0] ?? words.slice(at + 1).find(word => word.v === '-');
        if (cmd === 'popd' || cmd === 'pop-location' || arg?.v === '-') state.uncertain = true;
        else if (!arg || arg.v === '~') state.dir = home();
        else if (/[\u0001$]/.test(arg.v)) state.uncertain = true;
        else state.dir = resolvePath(state.dir, arg.v);
        run.job.dirs.add(state.dir);
        continue;
      }
      if (words.length && words.every(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.v) || ['export', 'local', 'declare', 'readonly'].includes(word.v)))
        for (const word of words) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word.v); if (m && !m[2].includes(SUB)) state.vars[m[1]] = m[2]; }
      const found = await inspect(view, run, mention);
      if (found) { run.findings.push({ ...found, index }); if (stopped(run)) return; }
      if (run.collect && !mention) {
        const restart = restartOf(words);
        if (restart) run.restarts.push({ index, ...restart });
        if (healthOf(words)) run.healths.push(index);
      }
      // Heredocs and here-strings: a shell reading them runs them; anything else only mentions them.
      for (const text of seg.input) {
        const shellInput = POSIX_SHELLS.has(cmd) || PS_SHELLS.has(cmd) || cmd === 'ssh';
        await walk(parse(text, PS_SHELLS.has(cmd) ? 'powershell' : 'posix'), run, copy(state), mention || !shellInput);
        if (stopped(run)) return;
      }
      for (const word of words) {
        if (!word.quoted || !/[\s;&|<>`]/.test(word.v)) continue;
        await walk(parse(word.v.replaceAll(SUB, ' '), run.shell), run, copy(state), true);
        if (stopped(run)) return;
      }
      for (const item of runsOf(view)) {
        if (item.command !== undefined) await walk(parse(item.command, item.shell), run, copy(state), mention);
        else { const inner = await scriptFinding(item, run, state, mention); if (inner) run.findings.push({ ...inner, index }); }
        if (stopped(run)) return;
      }
    }
  }
  /** Findings, restarts and health checks of one text (a command line or a script), in segment order. */
  async function analyze(text, shell, cwd, depth, job, collect) {
    const root = parse(text, shell);
    const run = { job, depth, collect, shell, root, findings: [], restarts: [], healths: [], order: 0, whole: undefined };
    await walk(root, run, { dir: cwd, uncertain: false, vars: {} }, false);
    return run;
  }
  async function check(command, { cwd = process.cwd(), shell = 'posix' } = {}) {
    const job = { processes: undefined, dirs: new Set([cwd]) };
    const run = await analyze(String(command), shell, cwd, 0, job, false);
    const found = run.findings[0];
    return found ? refuse(found.what, found.entry) : null;
  }
  return { check, protectedServices: names.map(({ entry }) => entry) };
}

/** Refusal text for a finding: what ran, which protected name it touches, and the rule. */
export const refusalReason = found => `Refused by the fleet service guard: ${found.what} touches protected service "${found.entry}". Rule: ${GUARD_RULE}. `
  + 'Write that script with the write tool and run it as nohup bash <script> >log 2>&1 &. This guard is a backstop, not a sandbox.';

/**
 * Pure entry point for any harness: {block: false} or {block: true, reason, what, entry}. Options: protectedServices
 * (defaults added), resolvePid(pid) -> command line, listProcesses() -> [{pid, command}], readScript(path) -> text,
 * {tooLarge: true} or null, cwd, and shell ('posix' or 'powershell').
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
  if (/^~([\\/]|$)/.test(file)) return join(home(), file.slice(2));
  return isAbsolute(file) ? file : resolve(dir, file);
}
/** A script's text; {tooLarge: true} over SCRIPT_CAP; null when it is missing, not a regular file or a binary. */
async function defaultReadScript(path) {
  let fd;
  try {
    const info = statSync(path);
    if (!info.isFile()) return null;
    fd = openSync(path, 'r');
    const head = Buffer.alloc(Math.min(info.size, 4096));
    readSync(fd, head, 0, head.length, 0);
    const utf16 = head[0] === 0xff && head[1] === 0xfe;
    if (!utf16 && head.includes(0)) return null;  // a compiled binary, not a script
    if (info.size > SCRIPT_CAP) return { tooLarge: true };
    const data = readFileSync(fd);
    return utf16 ? data.subarray(2).toString('utf16le') : data.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); } // probe-ok: a script that cannot be read is skipped by design, so only the command line itself can refuse; expires 2027-05-08
}
const run = (file, args, timeout) => new Promise((done, fail) => {
  execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    if (error && (error.killed || error.code === 'ENOENT' || typeof error.code !== 'number')) fail(error);
    else done({ code: error ? error.code : 0, stdout: String(stdout) });
  });
});
// '' when no process has this PID; throws when one exists (or may) but its command line could not be read.
function absent(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error?.code === 'ESRCH') return ''; }
  throw Error(`process ${pid} exists but its command line could not be read`);
}
/** The name and command line of one process (ps comm and args), '' when there is none; throws when it cannot be read. */
async function defaultResolvePid(pid) {
  const id = Number(pid);
  if (process.platform === 'win32') {
    const { code, stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${id}' -ErrorAction Stop; if($p){$p.Name+' '+$p.CommandLine}`], 5000);
    if (code !== 0) throw Error(`process ${id} could not be read`);
    return stdout.trim() || absent(id);
  }
  const { code, stdout } = await run('ps', ['-ww', '-o', 'comm=,args=', '-p', String(id)], 3000);
  return (code === 0 && stdout.trim()) || absent(id);
}
async function defaultListProcesses() {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + ' ' + $_.Name + ' ' + $_.CommandLine }"], 8000);
    return stdout.split(/\r?\n/).filter(Boolean).map(line => ({ pid: line.split(' ')[0], command: line.slice(line.indexOf(' ') + 1) }));
  }
  const { stdout } = await run('ps', ['-axww', '-o', 'pid=,comm=,args='], 5000);
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

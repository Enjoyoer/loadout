// Router protocol metadata and an explicit, catalog-checked service tier (Fast/Standard/Ultrafast).
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { loadGuardConfig, refusalReason, serviceGuard } from './service-guard.mjs';
export function validateCodemode(pi) {
  const tools = pi.getActiveTools();
  if (pi.getSettings().codemode?.mode !== 'on' || !tools.includes('codemode'))
    throw Error('Pi requires Codemode on in the effective session and active tool list');
  return { codemode: 'on', activeTools: tools };
}
export function enforceCodemode(pi, terminate = code => process.exit(code)) {
  try { return validateCodemode(pi); }
  catch (error) {
    process.stderr.write(error.message + '\n');
    // Pi reports extension exceptions and continues, so throwing alone is insufficient.
    terminate(78);
    throw error;
  }
}
export function preparePayload(payload, { model, sessionId, turnId, cwd, tier, requestId }) {
  if (!payload || typeof payload !== 'object') return payload;
  const result = structuredClone(payload);
  if (model?.provider === 'opencode') {
    // Zen is direct, never a router route, even for its Responses model.
    delete result.service_tier;
    return result;
  }
  if (model?.api === 'openai-responses') {
    const web = model.id.startsWith('chatgpt-web/');
    // The Web backend gets a neutral absolute path ending in the folder name: the full path carries the local user
    // name, and the gateway accepts only absolute cwd and root paths.
    const where = web ? '/workspace' + (basename(cwd) ? '/' + basename(cwd) : '') : cwd;
    const metadata = { thread_id: sessionId, turn_id: turnId, sandbox: 'none', workspaces: { [where]: {} } };
    result.client_metadata = { ...result.client_metadata, 'x-codex-turn-metadata': JSON.stringify(metadata),
      ...(requestId ? { 'x-fleet-request-id': requestId } : {}) };
    if (web) {
      const xml = where.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      // Codex's shape: the environment is a user item of the current turn, directly before the real instruction, so
      // the gateway reads cwd and roots from it alone and never from Pi's system prompt, which holds the local path.
      const environment = { type:'message', role:'user', internal_chat_message_metadata_passthrough:{turn_id:turnId},
        content:[{type:'input_text',text:
        `<environment_context>\n<cwd>${xml}</cwd>\n<filesystem><workspace_roots><root>${xml}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`}] };
      const input = Array.isArray(result.input) ? [...result.input] : [];
      // The Web backend binds replay to the latest real user instruction's turn.
      const at = input.findLastIndex(item => item.role === 'user');
      if (at >= 0) {
        input[at] = { ...input[at], type:'message', internal_chat_message_metadata_passthrough:{turn_id:turnId} };
        input.splice(at, 0, environment);
      } else input.unshift(environment);
      result.input = input;
    }
    // A resolved tier (explicit or the Standard default) is sent as-is; an inherited preference sends no
    // tier so the upstream default applies. A stray client tier never survives an inherit.
    if (tier?.wire) result.service_tier = tier.wire;
    else delete result.service_tier;
  }
  return result;
}

// Tier semantics. opc.service-tier (fast|standard|ultrafast|inherit, with priority/default
// aliases) wins; legacy opc.fast-requested 'true'/'false' (written by OPC) means fast/standard;
// absent means inherit the fleet default. Fast is off by default fleet-wide (owner decision
// 2026-11-06): on a GPT route whose catalog lists the priority tier, no choice sends an explicit
// Standard (tierDecision), so a Fast-capable route never depends on an upstream default; only an
// explicit fast/priority/ultrafast label turns Fast on.
const TIER_ALIASES = { fast: 'fast', priority: 'fast', standard: 'standard', default: 'standard', ultrafast: 'ultrafast', inherit: 'inherit' };
export const TIER_WIRE = { fast: 'priority', standard: 'default', ultrafast: 'ultrafast' };
const CATALOG_TIER = { fast: 'priority', ultrafast: 'ultrafast' };
export function resolveTierIntent(labels = {}) {
  const raw = labels['opc.service-tier'];
  if (raw !== undefined && String(raw).trim() !== '') {
    const tier = TIER_ALIASES[String(raw).trim().toLowerCase()];
    return tier ? { tier, source: 'opc.service-tier' } : { tier: null, source: 'opc.service-tier', error: `unsupported opc.service-tier value "${raw}" (use fast, standard, ultrafast or inherit)` };
  }
  const legacy = labels['opc.fast-requested'];
  if (legacy === 'true') return { tier: 'fast', source: 'opc.fast-requested' };
  if (legacy === 'false') return { tier: 'standard', source: 'opc.fast-requested' };
  return { tier: 'inherit', source: 'fleet-default' };
}
// catalogTiers: the model's catalog service_tiers ids, or null when the catalog could not be read.
export function tierDecision(intent, model, catalogTiers) {
  const codexRoute = model?.api === 'openai-responses' && !model.id.startsWith('chatgpt-web/');
  // A failed or unfinished label lookup must never fall back to a stale or inherited tier.
  if (intent?.lookupFailed) return codexRoute ? { status: 'lookup-failed', error: intent.error } : { status: 'lookup-failed-untiered' };
  if (intent?.error) return { status: 'invalid', error: intent.error };
  // No choice (absent or inherit) is an explicit Standard where the catalog offers Fast, and inherits elsewhere.
  if (!intent || intent.tier === 'inherit') return codexRoute && catalogTiers?.includes(CATALOG_TIER.fast)
    ? { status: 'fleet-default-standard', wire: TIER_WIRE.standard, header: 'standard' }
    : { status: 'inherited', header: codexRoute ? 'inherit' : undefined };
  // A tier label left over from a GPT route must not break a later swap to an untiered route
  // (Claude, web): send no tier and record it.
  if (!codexRoute) return { status: 'ignored-untiered' };
  if (intent.tier === 'standard') return { status: 'explicit', wire: TIER_WIRE.standard, header: 'standard' };
  if (catalogTiers && !catalogTiers.includes(CATALOG_TIER[intent.tier]))
    return { status: 'unsupported', error: `service tier "${intent.tier}" is not supported for ${model.id}: the fleet catalog lists [${catalogTiers.join(', ')}]` };
  return { status: catalogTiers ? 'explicit' : 'explicit-unverified', wire: TIER_WIRE[intent.tier], header: intent.tier };
}
async function agentLabels() {
  const url=process.env.LOADOUT_PI_MCP_URL;const id=process.env.PASEO_AGENT_ID;
  if (!url || !id) return {};
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'route-status',method:'tools/call',params:{name:'get_agent_status',arguments:{agentId:id}}}),signal:AbortSignal.timeout(10000)});
  const text=await response.text();const value=response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(line=>line.startsWith('data:')).slice(5)) : JSON.parse(text);
  if (!response.ok || value.error || value.result?.isError) throw Error('route snapshot unavailable');
  return value.result?.structuredContent?.snapshot?.labels ?? {};
}
// Hash of the file this process actually loaded, so deployment and loaded version can be told apart.
export const EXTENSION_SHA256 = (() => { try { return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'); } catch { return null; } })();
// The guard module was imported above, so it is readable; a read failure here should surface.
export const GUARD_SHA256 = createHash('sha256').update(readFileSync(fileURLToPath(new URL('./service-guard.mjs', import.meta.url)))).digest('hex');
// Shell tools the service guard checks. Any other tool whose input carries a string `command` is checked as POSIX.
const GUARD_SHELLS = { bash: 'posix', powershell: 'powershell' };
// Evidence keeps the start of a refused command with credential-shaped values masked: NAME=value, Bearer/Basic/Token
// values, API key and cookie headers, --token/--password-style options and URL userinfo.
export const guardExcerpt = command => String(command)
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@"']+@/gi, '$1<redacted>@')
  .replace(/\b(bearer|basic|token|digest)\s+[^\s"']+/gi, '$1 <redacted>')
  .replace(/\b((?:x-)?api-?key|cookie|private-token|x-auth-token)\s*:\s*[^\s"']+/gi, '$1: <redacted>')
  .replace(/(--?(?:[a-z0-9]+-)*(?:token|password|passwd|pass|secret|api-?key|auth|credentials?)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1<redacted>')
  .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']+)/g, '$1=<redacted>')
  .slice(0, 120);
/**
 * tool_call handler for the shared fleet service guard (service-guard.mjs). It refuses a shell command that stops,
 * unloads, disables or kills a protected service; an error inside it refuses too. options.guard replaces the guard
 * built from runtime.json (tests).
 */
export function serviceGuardHandler(record, { guard, runtime = join(dirname(fileURLToPath(import.meta.url)), 'runtime.json') } = {}) {
  // Built at the first shell call, so a session that never runs one writes no config row.
  const load = () => {
    const config = loadGuardConfig(runtime);
    if (config.warning) {
      try { process.stderr.write('fleet-routing: ' + config.warning + '\n'); } catch {}
      record({ event: 'service-guard-config', warning: config.warning });
    }
    return serviceGuard({ protectedServices: config.protectedServices });
  };
  return async (event, ctx) => {
    const command = event?.input?.command;
    if (typeof command !== 'string') return undefined;
    const shell = GUARD_SHELLS[event.toolName] ?? 'posix';
    let reason;
    try {
      guard ??= load();
      const found = await guard.check(command, { cwd: ctx?.cwd ?? process.cwd(), shell });
      if (!found) return undefined;
      reason = refusalReason(found);
    } catch (error) {
      reason = `Refused by the fleet service guard: it failed (${String(error?.message ?? error).slice(0, 80)}).`;
    }
    record({ event: 'service-guard', tool: event.toolName, reason, command: guardExcerpt(command) });
    return { block: true, reason };
  };
}
// Secret-shaped text in tool results is masked as [REDACTED:<kind>] before the model or the session sees it; the tool's
// own effects (files it wrote, output it piped or redirected) are untouched. The patterns are the security audit's
// scanner patterns, compiled once. Every pattern runs on the original text, and the match spans of all kinds are merged
// and replaced once, so an earlier kind cannot hide part of a later token; oauth-refresh-json masks only its value and
// keeps the key.
export const SECRET_PATTERNS = [
  ['anthropic', String.raw`sk-ant-(?:api|oat|ort|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}`],
  ['openai', String.raw`sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{40,}`],
  ['github', String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}`],
  ['slack', String.raw`xox[abposr]-[A-Za-z0-9-]{10,}`],
  ['aws', String.raw`\bAKIA[0-9A-Z]{16}\b`],
  ['google-refresh', String.raw`\b1//0[A-Za-z0-9_-]{30,}`],
  ['google-access', String.raw`\bya29\.[A-Za-z0-9_-]{30,}`],
  ['tailscale', String.raw`tskey-(?:auth|api|client|webhook)-[A-Za-z0-9-]{20,}`],
  ['huggingface', String.raw`\bhf_[A-Za-z0-9]{30,}`],
  ['bws-access-token', String.raw`\b0\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{20,}:[A-Za-z0-9+/=]{20,}`],
  ['telegram-bot', String.raw`\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b`],
  ['cloudflare-tunnel', String.raw`eyJhIjoi[A-Za-z0-9+/=]{40,}`],
  ['oauth-refresh-json', String.raw`"refresh_token"\s*:\s*"([^"]{20,})"`],
  ['google-apikey', String.raw`\bAIza[0-9A-Za-z_-]{35}`],
];
// [kind, source, mask, value]: value is true for oauth-refresh-json, whose span is its captured value, which sits just
// before the closing quote. The compiled patterns are in semantics() below.
const PASSES = SECRET_PATTERNS.map(([kind, source]) => [kind, source, `[REDACTED:${kind}]`, kind === 'oauth-refresh-json']);
// A mask this hook writes; a write or edit carrying one would put the mask in place of the real secret.
const MASK = new RegExp(String.raw`\[REDACTED:(?:${SECRET_PATTERNS.map(([kind]) => kind).join('|')})\]`);
// A mask's '[' and ']' give a glued \b pattern the word boundary the raw text lacked. These variants find such a match
// next to a span in pass 1: after drops the leading \b and is tried at a span's end; before drops the trailing \b and
// must end at a span's start, within the 64 characters before it.
//
// check.py runs these patterns with Python's re, where \s also covers U+001C to U+001F and U+0085, and \b treats every
// Unicode letter and digit as a word character. JS differs on both, so text holding any of those characters gets the
// same patterns compiled with Python's meaning (u flag, \b as a lookaround). Other text keeps the faster ASCII form,
// which gives the same matches there.
const PY_TRIGGER = /[\x1c-\x1f\u0080-\uffff]/;
const PY_WORD = String.raw`[\p{L}\p{N}_]`;
const PY_B = String.raw`(?:(?<=${PY_WORD})(?!${PY_WORD})|(?<!${PY_WORD})(?=${PY_WORD}))`;
// A \b just before a word character can only be the start of a word, a lookbehind alone, which is much faster.
const toPython = source => source.replace(/\\s/g, String.raw`[\s\x1c-\x1f\x85]`)
  .replace(/\\b(?=[A-Za-z0-9_]|\[0-9\])/g, `(?<!${PY_WORD})`).replace(/\\b/g, PY_B);
function semantics(py) {
  const compile = (source, flags) => py ? new RegExp(toPython(source), flags + 'u') : new RegExp(source, flags);
  const isWord = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const before = new RegExp(`(?<=${PY_WORD})`, 'uy'), after = new RegExp(PY_WORD, 'uy');
  const glued = SECRET_PATTERNS.map(([, source], k) => [k, source.replace(/(^|\|)\\b/g, '$1')]).filter(([k, source]) => source !== SECRET_PATTERNS[k][1]);
  const ending = SECRET_PATTERNS.map(([, source], k) => [k, `(?:${source.replace(/\\b(?=$|\|)/g, '')})`]).filter(([k, source]) => source !== `(?:${SECRET_PATTERNS[k][1]})`);
  return {
    patterns: SECRET_PATTERNS.map(([, source]) => compile(source, 'g')),
    // One combined pattern first: nearly every span edge has no match, and one scan is cheaper than one per kind.
    anyAfter: compile(glued.map(([, source]) => `(?:${source})`).join('|'), 'y'),
    after: glued.map(([k, source]) => [k, compile(source, 'y')]),
    anyBefore: compile(`(?:${ending.map(([, source]) => source).join('|')})$`, ''),
    before: ending.map(([k, source]) => [k, compile(`${source}$`, '')]),
    // Whether the character just before i, or the one at i, is a word character.
    wordBefore: py ? (text, i) => i > 0 && (before.lastIndex = i, before.test(text))
      : (text, i) => i > 0 && isWord(text.charCodeAt(i - 1)),
    wordAfter: py ? (text, i) => i < text.length && (after.lastIndex = i, after.test(text))
      : (text, i) => i < text.length && isWord(text.charCodeAt(i)),
  };
}
const ASCII = semantics(false), PYTHON = semantics(true);
/** [kind index, end] of the longest match a mask ending at e would create, or null. */
function gluedAfter(text, e, sem) {
  if (!sem.wordBefore(text, e) || !sem.wordAfter(text, e)) return null;
  sem.anyAfter.lastIndex = e;
  if (!sem.anyAfter.test(text)) return null;
  let best = null;
  for (const [k, pattern] of sem.after) {
    pattern.lastIndex = e;
    const m = pattern.exec(text);
    if (m && (!best || e + m[0].length > best[1])) best = [k, e + m[0].length];
  }
  return best;
}
/** [kind index, start] of the earliest match, at or after floor (the previous mask's end), that a mask starting at s would create, or null. */
function gluedBefore(text, s, floor, sem) {
  if (s <= floor || !sem.wordBefore(text, s) || !sem.wordAfter(text, s)) return null;
  const from = Math.max(floor, s - 64), window = text.slice(from, s);
  if (!sem.anyBefore.test(window)) return null;
  let best = null;
  for (const [k, pattern] of sem.before) {
    const m = pattern.exec(window);
    if (!m) continue;
    const t = from + m.index;
    // At the window's edge the \b held only inside the window; it holds in the text after a mask, at 0, or at a real boundary.
    if (t === from && from > floor && sem.wordBefore(text, t)) continue;
    if (!best || t < best[1]) best = [k, t];
  }
  return best;
}
/**
 * text with every secret-shaped run masked; counts gets one per match, by kind. Pass 1 masks every match in the original
 * text, and every \b match a mask next to it creates. Pass 2 runs once on the result, for matches the masking still
 * created; there a span is widened to whole masks so none is split, and a span with no raw character is dropped.
 */
export function redactText(text, counts) {
  const sem = PY_TRIGGER.test(text) ? PYTHON : ASCII;
  const first = maskSpans(text, counts, null, sem);
  return first.masks.length ? maskSpans(first.text, counts, first.masks, sem).text : first.text;
}
/**
 * One pass: the match spans of every kind on text, merged where they overlap or touch, each merged span replaced once by
 * the mask of the span that starts first (on a tie, the longest). guard lists the masks already in text as flat
 * [start, end] pairs in order, or is null. sem is ASCII or PYTHON. Returns the text and its masks, likewise.
 */
function maskSpans(text, counts, guard, sem = PY_TRIGGER.test(text) ? PYTHON : ASCII) {
  const starts = [], ends = [], kinds = [];
  let sorted = true;
  for (let k = 0; k < PASSES.length; k++) {
    const pattern = sem.patterns[k], value = PASSES[k][3];
    pattern.lastIndex = 0;
    const from = starts.length;
    for (let m; (m = pattern.exec(text));) {
      const end = value ? m.index + m[0].length - 1 : m.index + m[0].length;
      starts.push(value ? end - m[1].length : m.index); ends.push(end); kinds.push(k);
      // Resume at the span's end: a value's closing quote can open the next "refresh_token" key.
      pattern.lastIndex = end;
    }
    if (from && starts.length > from) sorted = false;
  }
  const n = starts.length;
  if (!n) return { text, masks: [] };
  let order = null;
  if (!sorted) order = starts.map((_, i) => i).sort((a, b) => starts[a] - starts[b] || ends[b] - ends[a]);
  const pieces = [], masks = [], hit = new Array(PASSES.length).fill(0), members = [];
  let pos = 0, len = 0, g = 0, i = 0;
  while (i < n) {
    let at = order ? order[i] : i;
    let start = starts[at], end = ends[at], kind = kinds[at];
    // Pass 1 keeps every span, so it counts at once; pass 2 counts a span's members only if the span is kept.
    members.length = 0;
    for (;;) {
      for (; i < n && starts[at = order ? order[i] : i] <= end; i++) {
        if (guard) members.push(kinds[at]); else hit[kinds[at]]++;
        if (ends[at] > end) end = ends[at];
      }
      if (guard) {
        // Widen over every mask the span overlaps; a widened end can reach further spans, so merge again.
        while (g < guard.length && guard[g + 1] <= start) g += 2;
        if (g < guard.length && guard[g] < start) start = guard[g];
        let grew = false;
        for (let j = g; j < guard.length && guard[j] < end; j += 2) if (guard[j + 1] > end) { end = guard[j + 1]; grew = true; }
        if (!grew || i >= n || starts[order ? order[i] : i] > end) break;
        continue;
      }
      // A match this mask's end would create joins the span; so may further spans it reaches.
      const next = gluedAfter(text, end, sem);
      if (!next) break;
      hit[next[0]]++; end = next[1];
    }
    if (guard) {
      // Drop a span made only of masks; it holds no raw character.
      let covered = 0;
      for (let j = g; j < guard.length && guard[j] < end; j += 2) covered += Math.min(guard[j + 1], end) - Math.max(guard[j], start);
      if (covered >= end - start) continue;
      for (const k of members) hit[k]++;
    } else for (let prior; (prior = gluedBefore(text, start, pos, sem));) { hit[prior[0]]++; [kind, start] = prior; }
    const mask = PASSES[kind][2];
    pieces.push(text.slice(pos, start), mask);
    len += start - pos;
    masks.push(len, len + mask.length);
    len += mask.length;
    pos = end;
  }
  if (!masks.length) return { text, masks };
  pieces.push(text.slice(pos));
  for (let k = 0; k < PASSES.length; k++) if (hit[k]) counts[PASSES[k][0]] = (counts[PASSES[k][0]] ?? 0) + hit[k];
  return { text: pieces.join(''), masks };
}
const REFRESH_KEY = 'refresh_token';
/**
 * Every string in plain JSON-like data (details, structuredContent), rebuilt only where something was masked. Every
 * non-empty string under a refresh_token key is masked whole, whatever its length or content: once JSON-escaped, a
 * short value or one holding '"' or a newline can still match the JSON pattern in the saved session. The walk stops
 * below MAX_DEPTH, so deep data cannot overflow the stack. seen maps each object walked to its result: a complete result is reused anywhere, so shared and cyclic objects are walked once; a result the depth cap cut
 * short is reused only where the object is met as deep or deeper, never nearer the top, where a walk reaches further.
 */
export function redactValue(value, counts) { return walkValue(value, counts, 0, new Map()).out; }
const MAX_DEPTH = 64;
const OAUTH_MASK = PASSES.find(([kind]) => kind === 'oauth-refresh-json')[2];
function walkValue(value, counts, depth, seen) {
  if (typeof value === 'string') return { out: redactText(value, counts), cut: false };
  if (!value || typeof value !== 'object') return { out: value, cut: false };
  const known = seen.get(value);
  // An object still being walked (a cycle) resolves to itself; a complete result is reused past the cap too.
  if (known && (!known.cut || depth >= known.depth)) return { out: known.out, cut: known.cut };
  if (depth > MAX_DEPTH) return { out: value, cut: true };
  seen.set(value, { out: value, cut: false, depth });
  let out = value, cut = false;
  const step = item => { const next = walkValue(item, counts, depth + 1, seen); cut ||= next.cut; return next.out; };
  if (Array.isArray(value)) {
    const items = value.map(step);
    if (items.some((item, i) => item !== value[i])) out = items;
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) for (const [key, item] of Object.entries(value)) {
      let next;
      if (key === REFRESH_KEY && typeof item === 'string' && item.length) {
        counts['oauth-refresh-json'] = (counts['oauth-refresh-json'] ?? 0) + 1;
        next = OAUTH_MASK;
      } else next = step(item);
      if (next !== item) { if (out === value) out = { ...value }; out[key] = next; }
    }
  }
  seen.set(value, { out, cut, depth });
  return { out, cut };
}
/**
 * tool_execution_update handler: masks a running tool's live partial result (text parts and details) in place. Pi
 * awaits extension handlers on the same partialResult object before it forwards the update to its client (Paseo), so
 * the client never gets the raw text. Tools build a fresh partial object per update, so the tool itself is untouched.
 * No evidence row per update; the final result's tool_result row counts the masks.
 */
export function redactUpdateHandler() {
  return event => {
    try {
      const partial = event?.partialResult;
      if (!partial || typeof partial !== 'object') return;
      const counts = {};
      if (Array.isArray(partial.content)) partial.content = partial.content.map(part =>
        part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: redactText(part.text, counts) } : part);
      if (partial.details !== undefined) partial.details = redactValue(partial.details, counts);
    } catch {}
  };
}
/**
 * tool_result handler: masks every text part of every tool result (a codemode script's nested calls get their own
 * tool_result, so the script sees masked text too), and the strings in details and structuredContent, which Pi saves
 * with the result. One evidence row per masked result: tool and counts by kind, never a value. On an error the result
 * stays as it was and one row records the failure.
 */
export function redactHandler(record) {
  return event => {
    try {
      const counts = {};
      const content = Array.isArray(event.content) ? event.content.map(part =>
        part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: redactText(part.text, counts) } : part) : event.content;
      const details = redactValue(event.details, counts);
      const structured = event.structuredContent !== undefined;
      const structuredContent = structured ? redactValue(event.structuredContent, counts) : undefined;
      if (!Object.keys(counts).length) return undefined;
      record({ event: 'redact', tool: event.toolName, ...(event.parentToolCallId ? { nested: true } : {}), kinds: counts });
      // Pi drops structuredContent when a handler replaces content without it.
      return { content, ...(details !== event.details ? { details } : {}), ...(structured ? { structuredContent } : {}) };
    } catch (error) {
      record({ event: 'redact', tool: typeof event?.toolName === 'string' ? event.toolName : null, status: 'failed', error: String(error?.name ?? 'Error') });
      return undefined;
    }
  };
}
export const REDACT_REFUSAL = 'This text contains a [REDACTED:...] mask from a tool result. Writing it would replace the real secret. Leave that value as it is, or change the file with a command that does not print the secret.';
/** tool_call handler: refuses a write or edit whose new text carries a mask from redactHandler. */
export function writeBackGuard(record) {
  return event => {
    if (event?.toolName !== 'write' && event?.toolName !== 'edit') return undefined;
    const input = event.input ?? {};
    const texts = [input.content, input.newText, ...(Array.isArray(input.edits) ? input.edits.map(edit => edit?.newText) : [])];
    if (!texts.some(text => typeof text === 'string' && MASK.test(text))) return undefined;
    record({ event: 'redact-guard', tool: event.toolName });
    return { block: true, reason: REDACT_REFUSAL };
  };
}
export const BLOCKED_MODEL_PREFIX = 'fleet-service-tier-refused';
export function blockedPayload(payload, error) {
  const reason = String(error).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  let base = {};
  try { base = payload && typeof payload === 'object' ? structuredClone(payload) : {}; } catch {}
  return { ...base, model: `${BLOCKED_MODEL_PREFIX}:${reason}` };
}
const catalogCache = new Map();
async function catalogTiers(ctx) {
  const model = ctx.model;
  if (model?.provider === 'opencode') return [];
  if (model?.api !== 'openai-responses' || model.id.startsWith('chatgpt-web/') || !model.baseUrl) return null;
  const cached = catalogCache.get(model.baseUrl);
  let catalog = cached && Date.now() - cached.at < 10 * 60_000 ? cached.catalog : undefined;
  if (!catalog) {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth?.ok) return null;
      const headers = { ...(auth.headers ?? {}), Accept: 'application/json' };
      if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/models?client_version=0.160.0`, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return null;
      catalog = await response.json();
      catalogCache.set(model.baseUrl, { at: Date.now(), catalog });
    } catch { return null; }
  }
  const rows = Array.isArray(catalog?.models) ? catalog.models : [];
  const row = rows.find(entry => (entry.slug ?? entry.id) === model.id);
  return row ? (row.service_tiers ?? []).map(entry => entry.id) : null;
}
// Fleet credential. configure.py sets the router provider's apiKey, and each credentialHeaders value, to one command,
// !"<python>" "<root>/credential.py" "<root>/runtime.json". Pi runs it synchronously for the key and again for each
// such header on every request, with a 10 s timeout and no retry, so a host under load can fail a turn although the
// credential is fine. Instead, before each model request of a run (turn_start), before each compaction
// (session_before_compact, manual or automatic) and before a branch summary (session_before_tree with a summary), this
// extension runs that same helper itself, without a shell, with up to two retries (CREDENTIAL), and lends the value to
// Pi as an in-memory provider override (registerProvider with the value as an escaped literal), so Pi spawns nothing
// for it. If every try fails, it lends the value of the last successful read, but only up to CREDENTIAL.maxAgeMs after
// that read. A run holds the lend until agent_end and a compaction until session_compact or session_compact_failed. Pi
// reads a branch summary's credential once, right after the session_before_tree handlers return, and a failed or
// cancelled summary emits no end event, so a summary holds the lend only for a short lease after its refresh
// (CREDENTIAL.summaryLeaseMs), ended early by session_tree or the summary's abort. The end of one holder never
// withdraws a lend another still holds. Without such a value, once no operation holds the lend, and once a lent value
// reaches that age, the override
// is withdrawn and Pi runs its own command again, so a failed refresh leaves the operation exactly as before: a
// process that never read a value fails closed. A successful read always replaces the held value, so
// a rotation applies to the next request. The value stays in this process's memory: it is never written to a file, a
// log, argv or the environment, and evidence rows carry only the outcome (compact_failed carries no upstream text).
export const CREDENTIAL = { timeoutMs: 15_000, retryDelaysMs: [1_000, 2_000], maxAgeMs: 15 * 60_000, summaryLeaseMs: 30_000 };
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;
const HELPER_COMMAND = new RegExp(`^!${QUOTED} ${QUOTED} ${QUOTED}$`);
/**
 * The provider whose apiKey is exactly configure.py's credential.py command for this root (the router provider; a
 * direct provider's command carries a key path, so it never matches), with that command's argv and the headers that
 * use the same command. Null when there is none, so the extension changes nothing.
 */
export function credentialHelper(models, root) {
  const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  for (const [provider, config] of Object.entries(models?.providers ?? {})) {
    const match = typeof config?.apiKey === 'string' ? HELPER_COMMAND.exec(config.apiKey) : null;
    if (!match) continue;
    const argv = match.slice(1).map(arg => arg.replaceAll('\\"', '"'));
    if (!same(argv[1], join(root, 'credential.py')) || !same(argv[2], join(root, 'runtime.json'))) continue;
    const headers = Object.keys(config.headers ?? {}).filter(name => config.headers[name] === config.apiKey);
    return { provider, command: config.apiKey, argv, headers };
  }
  return null;
}
// Pi reads a config value as a template: "$$" is a literal "$" and a leading "$!" a literal "!", so the value is never
// taken for an environment reference or a command.
export const credentialLiteral = value => (value.startsWith('!') ? '$' : '') + value.replace(/\$/g, () => '$$');
/**
 * One run of the helper: its one stdout line, or null on any failure (a nonzero exit, a timeout, an abort, no line).
 * env, when given, replaces the inherited environment (the isolated launcher passes a cleaned copy).
 */
export function readCredential(argv, { timeoutMs = CREDENTIAL.timeoutMs, signal, env } = {}) {
  return new Promise(done => {
    let out = '', settled = false, child, guard;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(guard); child?.stdout?.destroy(); done(value);
    };
    try { child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: timeoutMs, signal, ...(env ? { env } : {}) }); }
    catch { finish(null); return; }
    // A process the helper left behind can hold stdout open after the helper exits; the try still ends on time.
    guard = setTimeout(() => { child.kill(); finish(null); }, timeoutMs + 1_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 65_536) child.kill(); });
    child.on('error', () => finish(null));
    child.on('exit', code => { if (code !== 0) finish(null); });
    child.on('close', code => { const value = out.trim(); finish(code === 0 && value && !/[\r\n]/.test(value) ? value : null); });
  });
}
const pause = (ms, signal) => new Promise(done => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});
function fleetCredential(pi, record) {
  let found, held = null, lent = null, expiry = null;
  // Holders of the lend: the run (turn_start..agent_end), open compactions counted by reason (Pi names manual,
  // threshold and overflow apart), and one branch summary lease (Pi runs one summary at a time); summary numbers the
  // latest summary so a stale abort or lease of an earlier one never ends it.
  let running = false, summarizing = false, summary = 0, lease = null;
  const compactions = new Map();
  const holding = () => running || summarizing || compactions.size > 0;
  // The models.json this Pi process loaded: the agent home's copy, which the launcher rebuilt at this launch.
  const target = () => {
    if (found === undefined) {
      try {
        const dir = process.env.PI_CODING_AGENT_DIR;
        found = dir ? credentialHelper(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')), dirname(fileURLToPath(import.meta.url))) : null;
      } catch { found = null; }
    }
    return found;
  };
  const withdraw = reason => {
    clearTimeout(expiry); expiry = null;
    if (lent === null) return;
    lent = null;
    try { pi.unregisterProvider(found.provider); } catch {}
    if (reason) record({ event: 'credential', provider: found.provider, status: reason });
  };
  const lend = (value, at) => {
    if (lent !== value) {
      const literal = credentialLiteral(value);
      pi.registerProvider(found.provider, { apiKey: literal, ...(found.headers.length ? { headers: Object.fromEntries(found.headers.map(name => [name, literal])) } : {}) });
      lent = value;
    }
    clearTimeout(expiry);
    expiry = setTimeout(() => withdraw('expired'), Math.max(0, at + CREDENTIAL.maxAgeMs - Date.now()));
    expiry.unref?.();
  };
  const refresh = async (ctx, signal = ctx?.signal) => {
    if (!target() || ctx?.model?.provider !== found.provider) return;
    let value = null, tries = 0;
    for (const delay of [0, ...CREDENTIAL.retryDelaysMs]) {
      if (delay) await pause(delay, signal);
      if (signal?.aborted) return;
      tries++;
      if ((value = await readCredential(found.argv, { timeoutMs: CREDENTIAL.timeoutMs, signal }))) break;
    }
    // The operation that asked ended while the helper ran: lend nothing it would leave behind.
    if (signal?.aborted || !holding()) return;
    try {
      if (value) {
        held = { value, at: Date.now() };
        lend(value, held.at);
        if (tries > 1) record({ event: 'credential', provider: found.provider, status: 'read-after-retry', tries });
        return;
      }
      const ageMs = held ? Date.now() - held.at : null;
      if (held && ageMs < CREDENTIAL.maxAgeMs) {
        lend(held.value, held.at);
        record({ event: 'credential', provider: found.provider, status: 'last-good', tries, ageMs });
        return;
      }
      held = null;
      withdraw();
      record({ event: 'credential', provider: found.provider, status: 'unavailable', tries });
    } catch {
      // A refused override must never leave an older value lent: Pi falls back to its own command.
      withdraw();
      record({ event: 'credential', provider: found.provider, status: 'override-failed' });
    }
  };
  const release = () => { if (!holding()) withdraw(); };
  return {
    routes: ctx => Boolean(target()) && ctx?.model?.provider === found.provider,
    turnStart: ctx => { running = true; return refresh(ctx); },
    runEnd: () => { running = false; release(); },
    compactionStart: (event, ctx) => {
      compactions.set(event?.reason, (compactions.get(event?.reason) ?? 0) + 1);
      return refresh(ctx, event?.signal);
    },
    // Pi also reports some compactions that failed before session_before_compact; those find no count to take.
    compactionEnd: event => {
      const open = compactions.get(event?.reason) ?? 0;
      if (open > 1) compactions.set(event.reason, open - 1); else compactions.delete(event?.reason);
      release();
    },
    summaryStart: async (event, ctx) => {
      const prep = event?.preparation;
      if (!prep?.userWantsSummary || !prep.entriesToSummarize?.length) return;
      const id = ++summary;
      const end = () => { if (id !== summary) return; clearTimeout(lease); lease = null; summarizing = false; release(); };
      clearTimeout(lease); lease = null; summarizing = true;
      event.signal?.addEventListener('abort', end, { once: true });
      await refresh(ctx, event.signal);
      if (id !== summary || !summarizing) return;
      lease = setTimeout(end, CREDENTIAL.summaryLeaseMs);
      lease.unref?.();
    },
    summaryEnd: () => { clearTimeout(lease); lease = null; summarizing = false; release(); },
    shutdown: () => { clearTimeout(lease); lease = null; running = summarizing = false; compactions.clear(); withdraw(); },
  };
}
// The kind of a failed compaction, from Pi's own wording only (core/compaction/compaction.js getSummarizationFailure):
// 'token-cap' when the summary hit its output cap, 'aborted', or 'upstream' for anything else, with the provider's
// HTTP status when the text has Pi's "<label> failed: <NNN>:" or a provider's "API error (<NNN>)" shape. Nothing of the
// text itself is returned.
export function compactFailure(event) {
  const text = typeof event?.errorMessage === 'string' ? event.errorMessage : '';
  const errorKind = event?.aborted === true ? 'aborted'
    : text.endsWith('generation hit the token cap and the summary is incomplete') ? 'token-cap' : 'upstream';
  const status = /\bfailed: (\d{3}):/.exec(text) ?? /\bAPI error \((\d{3})\)/.exec(text);
  return { errorKind, httpStatus: status ? Number(status[1]) : null };
}
// Fleet compaction. At a high thinking level the summary's reasoning can use most of its output cap (Pi sizes it from
// compaction.reserveTokens), and the summary itself grows with every compaction. For a router model this extension
// therefore runs Pi's own compact() itself from session_before_compact, after the credential refresh above, with the
// lower of the agent's thinking level and COMPACTION.thinking, and with COMPACTION.lengthBound appended to the user's
// /compact text, clamped to the model's levels as Pi clamps its own. compact() keeps Pi's prompts, its split-turn
// prefix summary and its file lists. Pi carries file lists only from its own (fromHook false) summaries and never drops
// a path, so for every provider this code first adds the previous fleet summary's lists to Pi's own preparation, in
// place, and caps each list at COMPACTION.maxFiles paths, most recent first (mergeFileLists): Pi's default compaction
// gets that same object when this handler returns nothing. The fleet summary also says how many paths were dropped. The
// request goes through the model registry with the credential this process lent, the headers Pi's default summary
// request carries (service tier, client request id), and Pi's timeout settings; its retries are capped at
// COMPACTION.maxRetries, because Pi's default compaction follows any failure as a second full attempt. Pi saves the
// returned summary as its own. compact() is used only from a tested Pi version with its known 12-parameter shape. On
// any failure, an empty summary included, it returns nothing, so Pi's default compaction runs exactly as before; a
// failure that was not an abort leaves a compact_failed row with fallback 'pi-default' (errorKind 'unavailable' when
// compact() could not be loaded or has another shape). The thinking cap, the length bound and maxFiles are pi.runtime
// keys (runtime.json "compaction": {"thinking", "lengthBound", "maxFiles"}), which configure.py validates.
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const COMPACTION = {
  thinking: 'medium',
  lengthBound: 'Keep the whole summary under 8,000 words. Drop finished items that no longer affect the next steps.',
  maxRetries: 2,
  maxFiles: 100,
  versions: ['1.0.0'],
  // Pi's own bundled entry beside the cli.js launch.mjs starts, so compact() comes from the module instances Pi runs.
  // A dynamic import of the package name would not resolve: Pi maps that name only for an extension's static imports.
  load: () => import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js')).href),
};
/** The configured values from <root>/runtime.json, each falling back to its default when absent or not valid. */
export function compactionSettings(root = dirname(fileURLToPath(import.meta.url))) {
  let own = {};
  try { own = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')).compaction ?? {}; } catch {}
  return {
    thinking: THINKING_LEVELS.includes(own.thinking) ? own.thinking : COMPACTION.thinking,
    lengthBound: typeof own.lengthBound === 'string' && own.lengthBound.trim() ? own.lengthBound.trim() : COMPACTION.lengthBound,
    maxFiles: Number.isSafeInteger(own.maxFiles) && own.maxFiles >= 0 && own.maxFiles <= 100_000 ? own.maxFiles : COMPACTION.maxFiles,
  };
}
// Pi's clampThinkingLevel (pi-ai models.js): the model's own level, else the next one up it supports, else down.
function clampThinking(model, level) {
  const supported = !model?.reasoning ? ['off'] : THINKING_LEVELS.filter(name => {
    const mapped = model.thinkingLevelMap?.[name];
    return mapped !== null && (name === 'xhigh' || name === 'max' ? mapped !== undefined : true);
  });
  if (supported.includes(level)) return level;
  const at = THINKING_LEVELS.indexOf(level);
  if (at < 0) return supported[0] ?? 'off';
  return THINKING_LEVELS.slice(at).find(name => supported.includes(name))
    ?? THINKING_LEVELS.slice(0, at).reverse().find(name => supported.includes(name)) ?? supported[0] ?? 'off';
}
/** The lower of the agent's level and the cap (the cap alone when the agent reports none), clamped to the model. */
export function compactionThinking(agent, cap, model) {
  const at = THINKING_LEVELS.indexOf(agent);
  const level = at < 0 ? cap : THINKING_LEVELS[Math.min(at, THINKING_LEVELS.indexOf(cap))];
  return model ? clampThinking(model, level) : level;
}
export const compactionInstructions = (user, bound) => [typeof user === 'string' ? user.trim() : '', bound].filter(Boolean).join('\n\n');
// Pi's timeout parsing (core/http-dispatcher.js parseHttpIdleTimeoutMs): a number, a numeric string or "disabled" (0).
function timeoutSetting(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.toLowerCase() === 'disabled') return 0;
    return text ? timeoutSetting(Number(text)) : undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
// Pi's own request options for a summary (core/sdk.js buildRequestOptions): the provider timeout and retry settings.
function requestDefaults(settings) {
  const provider = settings?.retry?.provider ?? {};
  const idle = timeoutSetting(settings?.httpIdleTimeoutMs) ?? 300_000;
  return { timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle), maxRetries: provider.maxRetries,
    maxRetryDelayMs: provider.maxRetryDelayMs ?? 60_000, websocketConnectTimeoutMs: timeoutSetting(settings?.websocketConnectTimeoutMs) };
}
function retryPolicy(settings) {
  const retry = settings?.retry ?? {};
  return { enabled: retry.enabled ?? true, maxRetries: Math.min(retry.maxRetries ?? 3, COMPACTION.maxRetries),
    baseDelayMs: retry.baseDelayMs ?? 2_000, maxAgentDelayMs: retry.maxAgentDelayMs ?? 60_000 };
}
// Pi's tool calls that touch a file (core/compaction/utils.js addFileOp), from the message or, for a Codemode script,
// from the calls recorded on its result, in the order they ran.
function fileCalls(message) {
  if (message?.role === 'toolResult') return message.nestedCalls?.calls ?? [];
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter(block => block && typeof block === 'object' && block.type === 'toolCall');
}
// The paths the messages read and modified, each in call order.
function fileTouches(messages) {
  const read = [], modified = [];
  for (const message of messages) for (const call of fileCalls(message)) {
    const path = call?.arguments?.path;
    if (typeof path !== 'string' || !path) continue;
    if (call.name === 'read') read.push(path);
    else if (call.name === 'write' || call.name === 'edit') modified.push(path);
  }
  return { read, modified };
}
const strings = list => Array.isArray(list) ? list.filter(item => typeof item === 'string') : [];
// Oldest first, each path once, at its latest position.
const byRecency = (...lists) => { const seen = new Set(); for (const list of lists) for (const item of list) { seen.delete(item); seen.add(item); } return seen; };
// The fleet details mark their lists as oldest first; Pi's own details (computeFileLists) are sorted, so their order
// says nothing about recency.
export const FILES_ORDER = 'oldest-first';
const NOTE = /\n\n\(\d+ older file paths? (?:was|were) dropped; each list keeps the \d+ most recent\.\)$/;
/**
 * The file lists the next summary carries, set in Pi's own preparation, in place, for every provider. Pi carries lists
 * only from its own (fromHook false) summaries, so the previous fleet summary's lists are added; Pi never drops a path,
 * so each list keeps at most maxFiles paths (0 keeps all), most recent first. Recency comes from the last call that
 * touched a path in the whole branch (Pi keeps every entry) and then the summarized span, so the span's paths always
 * win; a path no call in the branch touched is older than all of those, in its stored order only when the previous
 * details say they are oldest first. A path lands in exactly one list, as Pi's computeFileLists decides it, after the
 * cap: modified when it is among the kept modified paths, else read. The previous summary's trailing list block and
 * dropped-count line are removed from preparation.previousSummary, so a split turn that copies it verbatim carries them
 * once, at the end. Returns both lists oldest first and how many paths were dropped.
 */
export function mergeFileLists(preparation, entries, maxFiles = COMPACTION.maxFiles) {
  const ops = preparation?.fileOps;
  if (!ops?.read || !ops?.edited || !ops?.written) return undefined;
  const branch = Array.isArray(entries) ? entries : [];
  const previous = branch.findLast(entry => entry?.type === 'compaction');
  const ordered = previous?.fromHook === true && previous?.details?.filesOrder === FILES_ORDER;
  const stored = list => { const paths = strings(list); return ordered ? paths : [...paths].sort(); };
  const prevRead = stored(previous?.details?.readFiles), prevModified = stored(previous?.details?.modifiedFiles);
  const span = fileTouches([...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])]);
  const all = fileTouches(branch.filter(entry => entry?.type === 'message').map(entry => entry.message));
  const modifiedAll = byRecency(prevModified, [...ops.edited, ...ops.written], span.modified);
  const readAll = byRecency(prevRead, ops.read, span.read);
  const reorder = (set, branchOrder, spanOrder) => [...byRecency([...set], branchOrder.filter(path => set.has(path)), spanOrder)];
  const keep = list => maxFiles > 0 ? list.slice(-maxFiles) : list;
  const modifiedFiles = keep(reorder(modifiedAll, all.modified, span.modified));
  const keptModified = new Set(modifiedFiles);
  const readFiles = keep(reorder(readAll, all.read, span.read).filter(path => !keptModified.has(path)));
  const dropped = new Set([...modifiedAll, ...readAll]).size - readFiles.length - modifiedFiles.length;
  ops.read.clear(); ops.edited.clear(); ops.written.clear();
  for (const path of readFiles) ops.read.add(path);
  for (const path of modifiedFiles) ops.edited.add(path);
  if (typeof preparation.previousSummary === 'string') {
    let text = preparation.previousSummary.replace(NOTE, '');
    const block = fileBlock(strings(previous?.details?.readFiles).sort(), strings(previous?.details?.modifiedFiles).sort());
    if (block && text.endsWith(block)) text = text.slice(0, -block.length);
    preparation.previousSummary = text;
  }
  return { readFiles, modifiedFiles, dropped, maxFiles };
}
// Pi's list block (core/compaction/utils.js formatFileOperations), from its sorted lists.
function fileBlock(readFiles, modifiedFiles) {
  const sections = [];
  if (readFiles.length) sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
  if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`);
  return sections.length ? `\n\n${sections.join('\n\n')}` : '';
}
/**
 * The fleet summary with the capped lists: Pi's own block, plus one line with the dropped count when any was dropped,
 * and details holding the lists oldest first, marked so.
 */
export function withFileLists(compaction, lists) {
  if (!lists || typeof compaction?.summary !== 'string') return compaction;
  const block = fileBlock([...lists.readFiles].sort(), [...lists.modifiedFiles].sort());
  // No paths, or a block that is not Pi's own: Pi's summary as it is (its lists are already capped).
  if (!block || !compaction.summary.endsWith(block)) return compaction;
  const note = lists.dropped > 0
    ? `\n\n(${lists.dropped} older file path${lists.dropped === 1 ? ' was' : 's were'} dropped; each list keeps the ${lists.maxFiles} most recent.)` : '';
  return { ...compaction, summary: compaction.summary + note,
    details: { ...compaction.details, readFiles: lists.readFiles, modifiedFiles: lists.modifiedFiles, filesOrder: FILES_ORDER } };
}
const unavailable = () => Object.assign(Error('compact() unavailable'), { kind: 'unavailable' });
async function fleetCompaction(pi, event, ctx, record, summaryHeaders, lists) {
  const { preparation, signal } = event ?? {};
  const model = ctx?.model, registry = ctx?.modelRegistry;
  if (signal?.aborted || !preparation || !model || typeof registry?.streamSimple !== 'function') return undefined;
  const own = compactionSettings();
  const thinking = compactionThinking(ctx.thinkingLevel, own.thinking, model);
  const failed = (errorKind, error) => {
    let sessionId = null;
    try { sessionId = ctx.sessionManager?.getSessionId() ?? null; } catch {}
    const kind = errorKind ? { errorKind, httpStatus: null } : compactFailure({ errorMessage: String(error?.message ?? error) });
    record({ event: 'compact_failed', reason: event?.reason ?? null, aborted: false, ...kind, sessionId, model: model.id ?? null,
      thinking, fallback: 'pi-default' });
    return undefined;
  };
  try {
    let compact;
    try {
      const mod = await COMPACTION.load();
      compact = mod?.compact;
      if (!COMPACTION.versions.includes(mod?.VERSION) || typeof compact !== 'function' || compact.length !== 12) throw unavailable();
    } catch (error) { if (signal?.aborted) return undefined; throw error?.kind ? error : unavailable(); }
    if (signal?.aborted) return undefined;
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth?.ok) throw Error('Summarization failed: request credential unavailable');
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    let settings = {};
    try { settings = pi.getSettings?.() ?? {}; } catch {}
    const defaults = requestDefaults(settings);
    const stream = (m, context, options) => registry.streamSimple(m, context, { ...defaults, ...options });
    const headers = { ...(auth.headers ?? {}), ...summaryHeaders(model) };
    const compaction = await compact(preparation, requestModel, auth.apiKey, headers,
      compactionInstructions(event.customInstructions, own.lengthBound), signal, thinking, stream, auth.env, retryPolicy(settings),
      undefined, undefined);
    if (signal?.aborted) return undefined;
    if (!compaction?.summary?.trim()) return failed('upstream');
    return { compaction: withFileLists(compaction, lists), thinking };
  } catch (error) {
    if (signal?.aborted) return undefined;
    return failed(error?.kind, error);
  }
}
// Pi creates session files and their directories under the normal umask (0644/0755), and they hold transcripts.
// Keep the agent's own session data private on POSIX without touching the umask: on session_start the session
// directory, its sessions/ parent and any non-private file in it; on turn_end the session file, once it exists.
// Best effort: never throws, never writes to stdout, one session-mode evidence row on the first failure per session.
export function sessionPrivacy(record, platform = process.platform) {
  const privateFiles = new Set(), failed = new Set();
  const fail = (ctx, stage, error) => {
    let sessionId = null;
    try { sessionId = ctx?.sessionManager?.getSessionId() ?? null; } catch {}
    if (failed.has(sessionId)) return;
    failed.add(sessionId);
    record({ event: 'session-mode', stage, sessionId, code: error?.code ?? 'error' });
  };
  // Drops group and other bits from a directory or regular file that has them; a missing path is not a failure.
  const tighten = (path, keep) => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) return false;
    if (st.mode & 0o077) chmodSync(path, st.mode & keep);
    return true;
  };
  return {
    start(ctx) {
      if (platform === 'win32') return;
      try {
        const dir = ctx?.sessionManager?.getSessionDir();
        if (!dir) return;
        const parent = dirname(dir);
        // Only a sessions/ parent: a custom sessionDir's parent can be any folder.
        if (basename(parent) === 'sessions') tighten(parent, 0o700);
        if (!tighten(dir, 0o700)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const path = join(dir, entry.name);
          if (tighten(path, 0o600)) privateFiles.add(path);
        }
      } catch (error) { fail(ctx, 'session_start', error); }
    },
    turnEnd(ctx) {
      if (platform === 'win32') return;
      let file;
      try {
        file = ctx?.sessionManager?.getSessionFile();
        if (!file || privateFiles.has(file)) return;
        // One call per turn: Pi creates the file with 0666 under the umask, so 0600 is mode & 0o600.
        chmodSync(file, 0o600);
        privateFiles.add(file);
      } catch (error) { if (error?.code !== 'ENOENT') fail(ctx, 'turn_end', error); }
    },
  };
}
export default function(pi) {
  let turnId=randomUUID();let intent={tier:'inherit',source:'fleet-default'};let tiers=null;
  // One request id shared by the payload and header hooks, whichever runs first.
  const slot={id:null,payload:false,headers:false};
  const requestId=()=>slot.id??=randomUUID();
  const settle=part=>{slot[part]=true;if(slot.payload&&slot.headers){slot.id=null;slot.payload=slot.headers=false;}};
  // Diagnostics are best effort: an evidence write failure must never escape a hook,
  // because Pi swallows hook exceptions and would send the unmodified request.
  const record = row => {
    try { if(process.env.PI_CODING_AGENT_DIR) appendFileSync(join(process.env.PI_CODING_AGENT_DIR,'route-evidence.jsonl'),JSON.stringify(row)+'\n',{mode:0o600}); } catch {}
  };
  const credential = fleetCredential(pi, record);
  const privacy = sessionPrivacy(record);
  pi.on('turn_end', (_event, ctx) => { privacy.turnEnd(ctx); });
  pi.on('tool_call', serviceGuardHandler(record));
  pi.on('tool_call', writeBackGuard(record));
  pi.on('tool_result', redactHandler(record));
  pi.on('tool_execution_update', redactUpdateHandler());
  pi.on('turn_start', (_event, ctx) => credential.turnStart(ctx));
  pi.on('agent_end', () => credential.runEnd());
  // The thinking level each running fleet compaction used, by reason, for its evidence row.
  const used = new Map();
  // The headers Pi's default summary request gets from before_provider_headers below, with a fresh request id.
  const summaryHeaders = model => {
    const headers = {}, tier = tierDecision(intent, model, tiers);
    if (tier.header) headers['X-Fleet-Service-Tier'] = tier.header;
    if (model?.api === 'openai-responses' && model.provider !== 'opencode') headers['X-Client-Request-Id'] = randomUUID();
    return headers;
  };
  pi.on('session_before_compact', async (event, ctx) => {
    // Every provider, so a fallback to Pi's default, or a later model switch, keeps the fleet summary's file lists,
    // bounded the same way.
    const lists = mergeFileLists(event?.preparation, event?.branchEntries, compactionSettings().maxFiles);
    await credential.compactionStart(event, ctx);
    if (!credential.routes(ctx)) return undefined;
    const done = await fleetCompaction(pi, event, ctx, record, summaryHeaders, lists);
    if (!done) return undefined;
    used.set(event?.reason, done.thinking);
    return { compaction: done.compaction };
  });
  pi.on('session_compact', (event, ctx) => {
    credential.compactionEnd(event);
    // A saved summary: its size and its output tokens (reasoning included), never its text.
    const thinking = event?.fromExtension ? used.get(event?.reason) ?? null : null;
    used.delete(event?.reason);
    let sessionId = null, model = null, agentThinking = null;
    try { sessionId = ctx?.sessionManager?.getSessionId() ?? null; model = ctx?.model?.id ?? null; agentThinking = ctx?.thinkingLevel ?? null; } catch {}
    const entry = event?.compactionEntry;
    record({ event: 'compact', reason: event?.reason ?? null, fromExtension: event?.fromExtension === true, sessionId, model,
      thinking: thinking ?? agentThinking, outputTokens: entry?.usage?.output ?? null,
      summaryChars: typeof entry?.summary === 'string' ? entry.summary.length : null, tokensBefore: entry?.tokensBefore ?? null });
  });
  pi.on('session_compact_failed', (event, ctx) => {
    credential.compactionEnd(event);
    used.delete(event?.reason);
    // A failed compaction saves nothing, so make it visible. Upstream error text can echo a credential or quote request
    // content, so none of it is written: only its kind, and the HTTP status Pi puts in its "<label> failed: <NNN>:" text.
    let sessionId = null, model = null, thinking = null;
    try { sessionId = ctx?.sessionManager?.getSessionId() ?? null; model = ctx?.model?.id ?? null; thinking = ctx?.thinkingLevel ?? null; } catch {}
    record({ event: 'compact_failed', reason: event?.reason ?? null, aborted: event?.aborted === true, ...compactFailure(event), sessionId, model, thinking });
  });
  pi.on('session_before_tree', (event, ctx) => credential.summaryStart(event, ctx));
  pi.on('session_tree', () => credential.summaryEnd());
  pi.on('session_shutdown', () => credential.shutdown());
  pi.on('session_start',(_event,ctx)=>{
    privacy.start(ctx);
    const check = enforceCodemode(pi);
    const evidence = { event: 'codemode-check', ...check, sessionId: ctx.sessionManager.getSessionId(), extensionSha256: EXTENSION_SHA256, guardSha256: GUARD_SHA256 };
    record(evidence);
    pi.appendEntry('loadout-codemode-check', evidence);
  });
  pi.on('before_agent_start',async(_event,ctx)=>{
    enforceCodemode(pi);turnId=randomUUID();
    // Fail closed for this turn until its own lookup succeeds; never keep the previous turn's tier.
    intent={tier:null,source:'opc labels',lookupFailed:true,error:'agent label lookup did not complete'};tiers=null;
    try{intent=resolveTierIntent(await agentLabels());}
    catch(error){intent={tier:null,source:'opc labels',lookupFailed:true,error:`agent label lookup failed: ${String(error?.message??error).slice(0,80)}`};}
    try{tiers=ctx?.model?await catalogTiers(ctx):null;}catch{tiers=null;}
  });
  pi.on('before_provider_request',(event,ctx)=>{
    enforceCodemode(pi);
    // Pi swallows handler exceptions and would send the original payload, which then inherits
    // the fleet default: a silent mapping. Every refusal or failure below returns a model id the
    // proxy rejects, so the turn errors visibly and nothing reaches the provider.
    let id=null;
    try{
      id=requestId();settle('payload');
      const tier=tierDecision(intent,ctx.model,tiers);
      const row={event:'request',requestId:id,turnId,sessionId:ctx.sessionManager.getSessionId(),model:ctx.model?.id,thinking:ctx.thinkingLevel,
        tierIntent:intent.tier,tierSource:intent.source,tierStatus:tier.status,service_tier:tier.wire??null,catalogTiers:tiers,error:tier.error};
      if(tier.error){
        const blocked=blockedPayload(event.payload,tier.error);
        record(row);try{pi.appendEntry('loadout-service-tier-refused',{requestId:id,error:tier.error});}catch{}
        return blocked;
      }
      const prepared=preparePayload(event.payload,{model:ctx.model,sessionId:ctx.sessionManager.getSessionId(),turnId,cwd:ctx.cwd,tier,requestId:id});
      record(row);
      return prepared;
    }catch(error){
      record({event:'request',requestId:id,turnId,tierStatus:'routing-error'});
      return blockedPayload(event.payload,'fleet routing failed before the request');
    }
  });
  pi.on('before_provider_headers',(event,ctx)=>{
    const tier=tierDecision(intent,ctx?.model,tiers);
    if(tier.header) event.headers['X-Fleet-Service-Tier']=tier.header;
    if(ctx?.model?.api==='openai-responses' && ctx.model.provider !== 'opencode') event.headers['X-Client-Request-Id']=requestId();
    settle('headers');
  });
  pi.on('provider_stream_event',event=>{
    const response=event.data?.response;
    if(event.data?.type==='response.completed') record({event:'response',model:event.model,service_tier:response?.service_tier,responseId:response?.id});
  });
}

// Router protocol metadata and an explicit, catalog-checked service tier (Fast/Standard/Ultrafast).
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, lstatSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
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

// Advisor. On the subscription route (provider fleet, a bare claude-* id on anthropic-messages) for every Claude model
// but Fable, each agent turn's request carries Anthropic's advisor server tool, backed by ADVISOR.tool.model, while
// runtime.json holds "advisor": {"enabled": true}. The file is read again whenever it changes, so an edit applies to
// the next request with no restart; a missing, unreadable or invalid value is off. Pi's Anthropic client sends
// payload.betas as the anthropic-beta header, so the tool and its beta are added together, in
// the payload. Pi runs before_provider_request for agent turns only (its compaction and branch summary requests skip
// it), and a request with no tools is left as it is too. The tool goes last in tools and the guidance at the end of the
// last system block (never a block of its own, see withSystemText), the same on every turn, so the prompt cache prefix
// stays stable. Fable executors never get the tool: the router may serve plain Fable requests from API-credit keys,
// and the advisor must never run on the API; those keys exclude the other Claude models.
//
// Pi 1.0 keeps only text, thinking and tool_use blocks of a response, so it drops each advisor call (a server_tool_use
// block and its advisor_tool_result) from the session, and the model later takes its own mentions of advice for
// invented ones. So a reply that got advice, seen in the raw stream events, gets ADVISOR.note as a text block (before
// its first tool call, else at the end), and every later request whose history holds that note gets ADVISOR.history
// last in its system prompt (an Anthropic system array, or the leading item of a Responses input), whatever the model
// or the switch: the system prompt changes once, at the first note.
//
// Rejection. When the API refuses an agent-turn request that carried the advisor with a 400 invalid_request_error that
// names the advisor's beta or tool type (advisorRejection: a retired beta or tool type, or an account not entitled to
// it), message_end records one advisor row with outcome rejected and asks agent_before_settle (settleRetry, the path the
// account limit uses) for one more request with the failed answer left out of the context. From then on this agent
// process adds no advisor until runtime.json changes or the process restarts, so a retired beta costs one failed
// request per agent, not one per turn. The marked error keeps no upstream text, so Pi's own retry never runs on it. The
// retry carries no advisor, so it is never retried again: if it fails too, the turn fails with that second error as before. Any other error, and any request without the advisor, is left alone.
//
// Context usage. When a response ran a server tool (the advisor included), Anthropic's top-level usage is the sum of
// its executor steps (usage.iterations, type 'message'): an advisor call at about 200K of context reads about 400K.
// Pi takes that sum as the context size and clamps the next request's max_tokens to the window minus it, floored at 1,
// so a large session gets empty length-stop replies. So an Anthropic reply with more than one executor step gets, in
// message_end, the input, cacheRead, cacheWrite and cacheWrite1h of its last step (withContextUsage). Its cost and output
// stay as reported. Pi's session token totals then count these per-reply context figures, not the billed executor input;
// that is accepted, and the dollar totals are unchanged. A reply with zero or one step, an error or aborted reply, and a
// last step without usable prompt counters are left alone.
// Stream events carry no request identity, Pi's cache warmer sends side requests through the same stream hook while
// the main one runs, and SDK sessions sharing one resource loader share this extension's handlers. So executorSteps
// keeps streams per session (the handler context's sessionManager). An Anthropic stream sends one message_delta, after
// its message_start, so a delta goes to the one stream of that session still waiting for its delta, and a reply takes
// the stream its responseId started. A delta while two streams wait, a further delta, or a reply whose stream was not
// seen leaves the reply alone, as does a delta that does not reproduce the reply's recorded counters (a check only).
// Each reply's end clears its session's streams: the session's next request starts after it, and Pi aborts a running
// cache warm before that request is sent, so no older stream can send anything once the next one starts.
export const ADVISOR = {
  beta: 'advisor-tool-2026-03-01',
  tool: { type: 'advisor_20260301', name: 'advisor', model: 'claude-fable-5-2' },
  guidance: 'You have an `advisor` tool: a stronger reviewer model that reads this whole conversation (it takes no '
    + 'input) and answers in one to three minutes. You must call it once before you deliver a final report or an '
    + 'owner-facing decision on a task that took real work (several steps or tool calls), and once when you are stuck '
    + 'after two failed attempts. Do not call it for a quick answer or a single-step task; otherwise use your judgment. '
    + 'Weigh its advice seriously; where evidence you checked yourself contradicts it, say so and follow the evidence. '
    + 'The history does not keep advisor calls, so after a call, state the advice you act on in a line or two.',
  note: '(Advisor consulted during this reply; the call and its advice are not kept in the history.)',
  history: 'Some replies in this conversation carry the note "(Advisor consulted during this reply; ...)". Those '
    + 'replies did consult the advisor tool; its advice is not kept in the history, only what the reply says about it.',
};
const textParts = item => Array.isArray(item?.content) ? item.content.filter(part => typeof part?.text === 'string') : [];
const mentions = (items, text) => Array.isArray(items) && items.some(item => textParts(item).some(part => part.text.includes(text)));
/**
 * What one advisor_tool_result block brought: 'advice', 'refusal' (the advisor declined), or the error code of a failed
 * call. A failed call does not fail the request: the API answers 200 with an advisor_tool_result_error block (for
 * example too_many_requests when the advisor model is rate-limited) and the model carries on without advice.
 */
export function advisorOutcome(block) {
  const content = block?.content;
  if (content?.type === 'advisor_tool_result_error') return typeof content.error_code === 'string' ? content.error_code : 'unknown';
  if (content?.type !== 'advisor_result' && content?.type !== 'advisor_redacted_result') return 'unknown';
  return content.stop_reason === 'refusal' ? 'refusal' : 'advice';
}
/** Counts the advisor results that carried advice in one streamed Anthropic response, from its raw events. */
export function advisorResults() {
  let count = 0;
  return {
    event(data) {
      if (data?.type === 'message_start') count = 0;
      else if (data?.type === 'content_block_start' && data.content_block?.type === 'advisor_tool_result'
        && advisorOutcome(data.content_block) === 'advice') count++;
    },
    take() { const done = count; count = 0; return done; },
  };
}
const USAGE_FIELDS = [['input_tokens', 'input'], ['output_tokens', 'output'], ['cache_read_input_tokens', 'cacheRead'],
  ['cache_creation_input_tokens', 'cacheWrite']];
/**
 * The executor steps (usage.iterations of type 'message') of Anthropic responses, from their raw events, handed to the
 * reply they belong to (see the Context usage comment above). `session` is the handler context's sessionManager; each
 * session keeps at most `keep` open streams.
 */
export function executorSteps(keep = 16) {
  const sessions = new WeakMap(), none = { open: [] };
  const streams = session => {
    if (session === null || typeof session !== 'object') return none;
    let found = sessions.get(session);
    if (!found) sessions.set(session, found = { open: [] });
    return found;
  };
  return {
    event(data, api, session) {
      if (api !== 'anthropic-messages') return;
      const scope = streams(session);
      if (data?.type === 'message_start') {
        scope.open.push({ id: data.message?.id, start: data.message?.usage ?? {}, delta: null, known: true });
        if (scope.open.length > keep) scope.open.shift();
      } else if (data?.type === 'message_delta') {
        const waiting = scope.open.filter(stream => !stream.delta);
        if (waiting.length === 1) waiting[0].delta = data.usage ?? {};
        else for (const stream of waiting.length ? waiting : scope.open) stream.known = false;
      }
    },
    take(message, session) {
      const scope = streams(session), open = scope.open;
      scope.open = [];
      const id = message?.responseId, own = typeof id === 'string' ? open.find(stream => stream.id === id) : undefined;
      if (!own?.known || !own.delta || !message.usage) return [];
      // pi-ai: each counter is the delta's value when present, else message_start's, else 0.
      if (!USAGE_FIELDS.every(([wire, key]) => (own.delta[wire] ?? (own.start[wire] || 0)) === message.usage[key])) return [];
      return Array.isArray(own.delta.iterations) ? own.delta.iterations.filter(step => step?.type === 'message') : [];
    },
  };
}
const sessionOf = ctx => ctx?.sessionManager;
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/**
 * The assistant message with its usage context read from the last executor step when it had more than one, else the
 * message itself. totalTokens = last.input_tokens + last.cache_read_input_tokens + last.cache_creation_input_tokens
 * + usage.output: the prompt the last step saw plus this reply's whole output, the same sum Pi forms, without the
 * earlier steps' prompts. cacheWrite1h, Pi's 1h subset of cacheWrite, comes from the same step's
 * cache_creation.ephemeral_1h_input_tokens, else is capped at the new cacheWrite. usage.cost, output and the other
 * fields are kept, so billing stays as reported. A last step whose three prompt counters (or a reply whose output) are
 * not all finite non-negative numbers leaves the message as it is.
 */
export function withContextUsage(message, steps) {
  if (message?.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted'
    || message.api !== 'anthropic-messages' || !message.usage || !Array.isArray(steps) || steps.length < 2) return message;
  const last = steps.at(-1);
  const input = last?.input_tokens, cacheRead = last?.cache_read_input_tokens, cacheWrite = last?.cache_creation_input_tokens;
  if (![input, cacheRead, cacheWrite, message.usage.output].every(count)) return message;
  const usage = { ...message.usage, input, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + message.usage.output };
  const long = last.cache_creation?.ephemeral_1h_input_tokens;
  if (count(long)) usage.cacheWrite1h = Math.min(long, cacheWrite);
  else if (usage.cacheWrite1h !== undefined) usage.cacheWrite1h = Math.min(count(usage.cacheWrite1h) ? usage.cacheWrite1h : 0, cacheWrite);
  return { ...message, usage };
}
/** The assistant message with ADVISOR.note before its first tool call, else at the end. */
export function withAdvisorNote(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const at = content.findIndex(block => block?.type === 'toolCall');
  const note = { type: 'text', text: ADVISOR.note };
  return { ...message, content: at < 0 ? [...content, note] : [...content.slice(0, at), note, ...content.slice(at)] };
}
/**
 * An Anthropic system prompt with text added at the end of its last block, after a blank line. It never adds a block
 * to a non-empty prompt: on some requests any second system block makes Opus answer stop_reason refusal with no output.
 * A string stays one string; a missing or empty prompt becomes one block.
 */
export function withSystemText(system, text) {
  if (typeof system === 'string' && system) return system + '\n\n' + text;
  if (!Array.isArray(system) || !system.length) return [{ type: 'text', text }];
  const last = system.at(-1);
  if (last?.type !== 'text' || typeof last.text !== 'string') return [...system, { type: 'text', text }];
  return [...system.slice(0, -1), { ...last, text: last.text ? last.text + '\n\n' + text : text }];
}
const systemHas = (system, text) => typeof system === 'string' ? system.includes(text)
  : Array.isArray(system) && system.some(block => typeof block?.text === 'string' && block.text.includes(text));
/** The payload with ADVISOR.history last in its system prompt when its history holds ADVISOR.note, else itself. */
export function withAdvisorHistory(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  // Anthropic Messages only: an OpenAI chat payload also has messages, but no system field.
  if (Array.isArray(payload.messages) && (Array.isArray(payload.system) || typeof payload.system === 'string')) {
    if (!mentions(payload.messages, ADVISOR.note) || systemHas(payload.system, ADVISOR.history)) return payload;
    return { ...payload, system: withSystemText(payload.system, ADVISOR.history) };
  }
  // Pi sends a Responses system prompt as the leading item's content string.
  const lead = Array.isArray(payload.input) ? payload.input[0] : null;
  const string = typeof lead?.content === 'string';
  if (!['developer', 'system'].includes(lead?.role) || !(string || Array.isArray(lead.content))
    || (string ? lead.content.includes(ADVISOR.history) : textParts(lead).some(part => part.text === ADVISOR.history))
    || !mentions(payload.input.slice(1), ADVISOR.note)) return payload;
  const content = string ? lead.content + '\n\n' + ADVISOR.history : [...lead.content, { type: 'input_text', text: ADVISOR.history }];
  return { ...payload, input: [{ ...lead, content }, ...payload.input.slice(1)] };
}
const advisorFiles = new Map();
/** Whether <root>/runtime.json turns the advisor on, read again only when the file's identity, size or mtime changes. */
export function advisorEnabled(root = dirname(fileURLToPath(import.meta.url))) {
  const file = join(root, 'runtime.json');
  try {
    const st = statSync(file);
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const known = advisorFiles.get(file);
    if (known?.key === key) return known.on;
    const on = JSON.parse(readFileSync(file, 'utf8'))?.advisor?.enabled === true;
    advisorFiles.set(file, { key, on });
    return on;
  } catch {
    // Not cached, so a file caught mid-edit is read again on the next request.
    advisorFiles.delete(file);
    return false;
  }
}
/** The identity, size and mtime advisorEnabled last read <root>/runtime.json at, or null when it could not read it. */
export const advisorRuntimeKey = (root = dirname(fileURLToPath(import.meta.url))) => advisorFiles.get(join(root, 'runtime.json'))?.key ?? null;
/**
 * Why the API refused a request that carried the advisor: 'beta' (the anthropic-beta value), 'tool' (the tool type),
 * 'other' (another 400 invalid_request_error naming either), or null for any other error. A tool type error about
 * another tool lists the advisor type among the expected tags, so it is not an advisor rejection.
 */
export function advisorRejection(message, sent = ADVISOR) {
  if (message?.role !== 'assistant' || message.stopReason !== 'error' || typeof message.errorMessage !== 'string') return null;
  const text = message.errorMessage;
  if (!/\b400\b/.test(text) || !text.includes('invalid_request_error')) return null;
  const tag = /Input tag '([^']*)' found using 'type'/.exec(text);
  if (tag) return tag[1] === sent.tool.type ? 'tool' : null;
  if (text.includes(sent.beta)) return text.includes('anthropic-beta') ? 'beta' : 'other';
  return text.includes(sent.tool.type) ? 'other' : null;
}
export const ADVISOR_RETRY = 'Advisor rejected; trying again without it';
export const advisorRoute = model => model?.api === 'anthropic-messages' && model.provider === 'fleet'
  && typeof model.id === 'string' && model.id.startsWith('claude-')
  && !model.id.startsWith('claude-fable-');
/** The payload with the advisor tool, its beta and its guidance, or the payload itself when it does not qualify. */
export function withAdvisor(payload, model) {
  if (!advisorRoute(model) || !payload || typeof payload !== 'object' || payload.model !== model.id
    || !Array.isArray(payload.tools) || !payload.tools.length || payload.tools.some(tool => tool?.name === ADVISOR.tool.name)) return payload;
  const betas = Array.isArray(payload.betas) ? payload.betas : [];
  return { ...payload, tools: [...payload.tools, { ...ADVISOR.tool }], system: withSystemText(payload.system, ADVISOR.guidance),
    betas: betas.includes(ADVISOR.beta) ? betas : [...betas, ADVISOR.beta] };
}

// Tier semantics. opc.service-tier (fast|standard|ultrafast|inherit, with priority/default
// aliases) wins; legacy opc.fast-requested 'true'/'false' (written by OPC) means fast/standard;
// absent means inherit the fleet default. Fast is off by default fleet-wide (owner decision
// 2026-11-06): on a GPT route whose catalog lists the priority tier, no choice sends an explicit
// Standard (tierDecision), so a Fast-capable route never depends on an upstream default; only an
// explicit fast/priority/ultrafast label turns Fast on. Luna is the exception (owner 2026-11-17): on a Luna model
// whose catalog lists priority, every turn sends priority whatever the labels say (status luna-fast); an ultrafast
// label still wins where the catalog lists ultrafast.
const TIER_ALIASES = { fast: 'fast', priority: 'fast', standard: 'standard', default: 'standard', ultrafast: 'ultrafast', inherit: 'inherit' };
export const TIER_WIRE = { fast: 'priority', standard: 'default', ultrafast: 'ultrafast' };
const CATALOG_TIER = { fast: 'priority', ultrafast: 'ultrafast' };
const LUNA_MODEL = /(?:^|\/)gpt-[0-9.]+-luna$/i;
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
  if (codexRoute && LUNA_MODEL.test(model.id) && catalogTiers?.includes(CATALOG_TIER.fast) &&
      !(intent?.tier === 'ultrafast' && catalogTiers.includes(CATALOG_TIER.ultrafast)))
    return { status: 'luna-fast', wire: TIER_WIRE.fast, header: 'fast' };
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
// scanner patterns, x-api-key and bearer included, compiled once. Every pattern runs on the original text, and the
// match spans of all kinds are merged and replaced once, so an earlier kind cannot hide part of a later token.
// [kind, source, value]: a kind with value set masks only its capture group, which ends the match, and keeps the key
// before it.
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
  ['oauth-refresh-json', String.raw`"refresh_token"\s*:\s*"([^"]{20,})(?=")`, true],
  ['google-apikey', String.raw`\bAIza[0-9A-Za-z_-]{35}`],
  // The value of an X-Api-Key header (or an X_API_KEY variable; each separator is - or _) in TOML, JSON, HTTP, env or
  // YAML form, also inside a JSON string (\" quotes). Its character set leaves out $, {, < and *, so a placeholder
  // stays. The case is spelled out so both compiles in semantics() keep it.
  ['x-api-key', String.raw`[Xx][-_][Aa][Pp][Ii][-_][Kk][Ee][Yy](?:\\?["'])?[ \t]*[=:][ \t]*(?:\\?["'])?([A-Za-z0-9_.+/=-]{16,})`, true],
  // The token of an Authorization: Bearer header in the same forms (RFC 6750 b64token, so a JWT is masked whole); the
  // name and "Bearer " stay, and so does a placeholder or a token under 16 characters.
  ['bearer', String.raw`[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn](?:\\?["'])?[ \t]*[=:][ \t]*(?:\\?["'])?[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+([A-Za-z0-9._~+/-]{16,}=*)`, true],
];
// [kind, source, mask, value]. The compiled patterns are in semantics() below.
const PASSES = SECRET_PATTERNS.map(([kind, source, value]) => [kind, source, `[REDACTED:${kind}]`, value === true]);
// A mask this hook writes; a write or edit carrying one would put the mask in place of the real secret.
const MASK = new RegExp(String.raw`\[REDACTED:(?:${SECRET_PATTERNS.map(([kind]) => kind).join('|')})\]`);
// A mask's '[' and ']' give a glued \b pattern the word boundary the raw text lacked. These variants find such a match
// next to a span in pass 1: after drops the leading \b and is tried at a span's end; before drops the trailing \b and
// must end at a span's start, within the 64 characters before it.
//
// check.py runs these patterns with Python's re, where \s also covers U+001C to U+001F and U+0085, and \b treats every
// Unicode letter and digit as a word character. JS differs on both, so text holding any of those characters gets the
// same patterns compiled with Python's meaning (u flag, \b as a lookaround), and masks the union of what those and the
// ASCII form find: every check.py match, plus a token glued to a non-ASCII letter as before (Python's \b fails there).
// Other text keeps the ASCII form alone, which gives the same matches there.
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
    py,
    patterns: SECRET_PATTERNS.map(([, source]) => compile(source, 'g')),
    // A pattern with no \b or \s matches the same text under both meanings.
    same: SECRET_PATTERNS.map(([, source]) => !/\\[bs]/.test(source)),
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
// Cheap first checks at a span's edge: a glued match after it starts with one of these (sk-, gh, AKIA, AIza, 1//0,
// ya29., hf_, 0., Telegram digits).
const startsAfter = c => c === 115 || c === 103 || c === 65 || c === 121 || c === 104 || (c >= 48 && c <= 57);
// The patterns with a trailing \b are AWS (AKIA and 16 characters) and Telegram (:AA and 33 characters), so a match
// ending at s has its fixed part at s - 20 or s - 36; should that set change, the check passes everything.
const TRAILING = SECRET_PATTERNS.filter(([, source]) => /\\b(?:$|\|)/.test(source)).map(([kind]) => kind).join();
const endsBefore = TRAILING === 'aws,telegram-bot'
  ? (text, s) => text.startsWith('AKIA', s - 20) || text.startsWith(':AA', s - 36) : () => true;
/** [kind index, end] of the longest match a mask ending at e would create, under either meaning on the Python path. */
function gluedAfter(text, e, sem) {
  if (!startsAfter(text.charCodeAt(e))) return null;
  const a = gluedAfterIn(text, e, sem), b = sem.py ? gluedAfterIn(text, e, ASCII) : null;
  return b && (!a || b[1] > a[1]) ? b : a;
}
/** [kind index, start] of the earliest match before a mask starting at s, under either meaning on the Python path. */
function gluedBefore(text, s, floor, sem) {
  if (s <= floor || !endsBefore(text, s)) return null;
  const a = gluedBeforeIn(text, s, floor, sem), b = sem.py ? gluedBeforeIn(text, s, floor, ASCII) : null;
  return b && (!a || b[1] < a[1]) ? b : a;
}
function gluedAfterIn(text, e, sem) {
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
// The earliest match, at or after floor (the previous mask's end), that a mask starting at s would create.
function gluedBeforeIn(text, s, floor, sem) {
  if (!sem.wordBefore(text, s) || !sem.wordAfter(text, s)) return null;
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
 * The span indices in order of start, then longest first, from runs that are each in that order already (bottom-up merge
 * of the non-empty runs; a comparator sort is far slower on a fresh process). Always an Int32Array, so the loop that
 * reads it sees one type and is not recompiled midway through a large result.
 */
function mergeRuns(starts, ends, runs) {
  const n = starts.length, bounds = [];
  for (let r = 0; r < runs.length; r++) {
    const end = r + 1 < runs.length ? runs[r + 1] : n;
    if (end > runs[r]) bounds.push(runs[r]);
  }
  let a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  if (bounds.length < 2) return a;
  bounds.push(n);
  let b = new Int32Array(n);
  for (let width = 1; width < bounds.length - 1; width *= 2) {
    for (let r = 0; r + 1 < bounds.length; r += 2 * width) {
      const lo = bounds[r], mid = bounds[Math.min(r + width, bounds.length - 1)], hi = bounds[Math.min(r + 2 * width, bounds.length - 1)];
      let i = lo, j = mid, o = lo;
      while (i < mid && j < hi) {
        const x = a[i], y = a[j];
        // On a tie the earlier run (the lower kind) goes first.
        if (starts[y] < starts[x] || (starts[y] === starts[x] && ends[y] > ends[x])) { b[o++] = y; j++; } else { b[o++] = x; i++; }
      }
      while (i < mid) b[o++] = a[i++];
      while (j < hi) b[o++] = a[j++];
    }
    [a, b] = [b, a];
  }
  return a;
}
/**
 * One pass: the match spans of every kind on text, merged where they overlap or touch, each merged span replaced once by
 * the mask of the span that starts first (on a tie, the longest). guard lists the masks already in text as flat
 * [start, end] pairs in order, or is null. sem is ASCII or PYTHON. Returns the text and its masks, likewise.
 */
function maskSpans(text, counts, guard, sem = PY_TRIGGER.test(text) ? PYTHON : ASCII) {
  // Small functions, each compiled on its own: one large function took tens of milliseconds to optimize, and a large
  // result ran slowly until it was.
  const spans = collectSpans(text, sem);
  if (!spans.starts.length) return { text, masks: [] };
  const order = mergeRuns(spans.starts, spans.ends, spans.runs);
  const out = { pieces: [], masks: [], len: 0, pos: 0, hit: new Array(PASSES.length).fill(0), guard };
  if (guard) replaceGuarded(text, spans, order, guard, out); else replaceSpans(text, spans, order, sem, out);
  if (!out.masks.length) return { text, masks: out.masks };
  out.pieces.push(text.slice(out.pos));
  for (let k = 0; k < PASSES.length; k++) if (out.hit[k]) counts[PASSES[k][0]] = (counts[PASSES[k][0]] ?? 0) + out.hit[k];
  return { text: out.pieces.join(''), masks: out.masks };
}
/** The match spans of every kind on text; runs holds where each scan's spans begin, as each scan yields them in order. */
function collectSpans(text, sem) {
  const spans = { starts: [], ends: [], kinds: [], runs: [] };
  for (let k = 0; k < PASSES.length; k++) {
    const from = spans.starts.length;
    spans.runs.push(from);
    scan(text, sem.patterns[k], k, spans);
    if (sem.py && !sem.same[k]) {
      // The union: add the ASCII matches of this kind that the Python scan did not find.
      spans.runs.push(spans.starts.length);
      scanUnion(text, ASCII.patterns[k], k, spans, from);
    }
  }
  return spans;
}
function scan(text, pattern, k, { starts, ends, kinds }) {
  const value = PASSES[k][3];
  pattern.lastIndex = 0;
  for (let m; (m = pattern.exec(text));) {
    const end = m.index + m[0].length;
    starts.push(value ? end - m[1].length : m.index); ends.push(end); kinds.push(k);
    // Resume at the span's end: a value's closing quote can open the next "refresh_token" key.
    pattern.lastIndex = end;
  }
}
/** Like scan, skipping a match the run from `from` (the same kind, in order) already holds. */
function scanUnion(text, pattern, k, { starts, ends, kinds }, from) {
  const value = PASSES[k][3], mid = starts.length;
  let j = from;
  pattern.lastIndex = 0;
  for (let m; (m = pattern.exec(text));) {
    const end = m.index + m[0].length, start = value ? end - m[1].length : m.index;
    while (j < mid && starts[j] < start) j++;
    if (!(j < mid && starts[j] === start && ends[j] === end)) { starts.push(start); ends.push(end); kinds.push(k); }
    pattern.lastIndex = end;
  }
}
/** Pass 1: merges spans that overlap or touch, with the matches a mask would create next to them, and masks each. */
function replaceSpans(text, { starts, ends, kinds }, order, sem, out) {
  const n = starts.length, hit = out.hit;
  let i = 0;
  while (i < n) {
    let at = order[i];
    let start = starts[at], end = ends[at], kind = kinds[at];
    for (;;) {
      for (; i < n && starts[at = order[i]] <= end; i++) {
        hit[kinds[at]]++;
        if (ends[at] > end) end = ends[at];
      }
      // A match this mask's end would create joins the span; so may further spans it reaches.
      const next = gluedAfter(text, end, sem);
      if (!next) break;
      hit[next[0]]++; end = next[1];
    }
    for (let prior; (prior = gluedBefore(text, start, out.pos, sem));) { hit[prior[0]]++; [kind, start] = prior; }
    emit(out, text, start, end, kind);
  }
}
/** Pass 2: widens each merged span over the masks it overlaps, so none is split, and drops one with no raw character. */
function replaceGuarded(text, { starts, ends, kinds }, order, guard, out) {
  const n = starts.length, members = [];
  let i = 0, g = 0;
  while (i < n) {
    let at = order[i];
    let start = starts[at], end = ends[at];
    const kind = kinds[at];
    members.length = 0;
    for (;;) {
      for (; i < n && starts[at = order[i]] <= end; i++) {
        members.push(kinds[at]);
        if (ends[at] > end) end = ends[at];
      }
      // A widened end can reach further spans, so merge again.
      while (g < guard.length && guard[g + 1] <= start) g += 2;
      if (g < guard.length && guard[g] < start) start = guard[g];
      let grew = false;
      for (let j = g; j < guard.length && guard[j] < end; j += 2) if (guard[j + 1] > end) { end = guard[j + 1]; grew = true; }
      if (!grew || i >= n || starts[order[i]] > end) break;
    }
    let covered = 0;
    for (let j = g; j < guard.length && guard[j] < end; j += 2) covered += Math.min(guard[j + 1], end) - Math.max(guard[j], start);
    if (covered >= end - start) continue;
    for (const k of members) out.hit[k]++;
    emit(out, text, start, end, kind);
  }
}
/** Appends the raw text before start and the mask of kind for [start, end). */
function emit(out, text, start, end, kind) {
  const { pieces, pos } = out, mask = PASSES[kind][2];
  pieces.push(text.slice(pos, start), mask);
  out.len += start - pos;
  out.masks.push(out.len, out.len + mask.length);
  out.len += mask.length;
  out.pos = end;
}
const REFRESH_KEY = 'refresh_token';
// Run every path once at import on short samples (both passes, merged runs, glued tokens before and after a span, ASCII
// and non-ASCII text), so the code is compiled having seen them all: a path first met inside a large result otherwise
// costs a recompile there (up to about 80 ms on 1 MB). The samples are built here.
{
  const r = (c, n) => c.repeat(n);
  const sample = '{"' + REFRESH_KEY + '":"ab' + 'xo' + 'xb-' + r('1', 10) + '.."} ' + 'AK' + 'IA' + r('Q', 16) + 'tskey' + '-auth-' + r('f', 20)
    + ' ' + 'AI' + 'za' + r('m', 35) + 'h' + 'f_' + r('g', 30) + ' ' + 'gh' + 'p_' + r('C', 36) + ' ';
  for (const extra of ['', '\u00e9']) for (let i = 0; i < 3; i++) redactText((sample + extra).repeat(4), {});
}
/**
 * Every string in plain JSON-like data (details, structuredContent), rebuilt only where something was masked. Every
 * non-empty string under a refresh_token key is masked whole, whatever its length or content: once JSON-escaped, a
 * short value or one holding '"' or a newline can still match the JSON pattern in the saved session. A string under a
 * header key in KEY_RULES (X-Api-Key or X_API_KEY, Authorization; any letter case) gets that header's value rule, so
 * placeholders and short values stay. The walk stops below MAX_DEPTH, so deep data cannot overflow the stack. seen maps
 * each object walked to its result: a complete result is reused anywhere, so shared and cyclic objects are walked once;
 * a result the depth cap cut short is reused only where the object is met as deep or deeper, never nearer the top,
 * where a walk reaches further.
 */
export function redactValue(value, counts) { return walkValue(value, counts, 0, new Map()).out; }
const MAX_DEPTH = 64;
const OAUTH_MASK = PASSES.find(([kind]) => kind === 'oauth-refresh-json')[2];
// A parsed JSON header is a key and a bare value; the value is put back behind its header name, so the pattern
// decides. [key name, prefix].
const KEY_RULES = [[/^x[-_]api[-_]key$/i, 'X-Api-Key: '], [/^authorization$/i, 'Authorization: ']];
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
      let next, rule;
      if (key === REFRESH_KEY && typeof item === 'string' && item.length) {
        counts['oauth-refresh-json'] = (counts['oauth-refresh-json'] ?? 0) + 1;
        next = OAUTH_MASK;
      } else if (typeof item === 'string' && (rule = KEY_RULES.find(([name]) => name.test(key)))) {
        next = redactText(rule[1] + item, counts).slice(rule[1].length);
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
  const stop = () => { clearTimeout(timer); done(); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); done(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
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
// Pi's own bundled entry beside the cli.js launch.mjs starts, so its exports come from the module instances Pi runs.
// A dynamic import of the package name would not resolve: Pi maps that name only for an extension's static imports.
const piPackage = () => import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js')).href);
export const COMPACTION = {
  thinking: 'medium',
  lengthBound: 'Keep the whole summary under 8,000 words. Drop finished items that no longer affect the next steps.',
  maxRetries: 2,
  maxFiles: 100,
  versions: ['1.0.0'],
  load: piPackage,
};
// Image size cap. Pi scales prompt images to 2000 px a side only when the agent is idle, so an image queued as a steer
// or follow-up while it streams is stored as sent, and Anthropic then refuses every later request of a many-image chat.
// The context_with_system handler fixes the model-facing copy of each request instead: every image block (any message)
// whose header says a side is over IMAGES.maxSide is replaced by Pi's own resizeImage output plus Pi's dimension note as
// a text block after it. The session, the queue and the user's text stay as they were, so this also heals a session that
// already holds such an image. A request with no such image is left alone (undefined, nothing mutated); only a few header
// bytes are decoded, and an image whose header is unknown is not capped. Each image is resized once by content hash and
// the result is kept while the image stays in the context, so a settled image sends the same bytes on every request.
// At most IMAGES.workers resizes hold a slot at once (live threads can exceed that; see Limits). An image that is not resized by the request's
// deadline (IMAGES.deadlineMs from the start of the request, judged by when the job finished) or cannot be resized goes
// out as Pi's omitted-image text, since the original would fail the request; a later request uses the finished result.
// Limits: Pi's worker has no timeout and cannot be stopped from here, so a job still running after IMAGES.holdMs gives up
// its slot and counts as failed while its thread runs on, and threads of hung resizes can add up; a Pi package load that
// never settles keeps its slot; and when Pi's worker fails, Pi retries on the main thread, which blocks the agent meanwhile.
// Pi's images.autoResize false turns this off. Evidence rows carry sizes, MIME tokens, outcome and times only.
export const IMAGES = { maxSide: 2000, deadlineMs: 20_000, holdMs: 120_000, workers: 2, load: piPackage };
const OMITTED_IMAGE = '[Image omitted: could not be resized below the inline image size limit.]';
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const mimeToken = mime => { const token = String(mime).split(';')[0].trim().toLowerCase(); return /^image\/[a-z0-9][a-z0-9.+-]{0,40}$/.test(token) ? token : 'unknown'; };
/** `length` bytes from byte `start` of base64 `data`, decoding only the characters that hold them. */
function base64Bytes(data, start, length) {
  const from = Math.floor(start / 3) * 4, skip = start % 3;
  return Buffer.from(data.slice(from, from + Math.ceil((skip + length) / 3) * 4), 'base64').subarray(skip, skip + length);
}
/** Width and height from the PNG, GIF, WebP or JPEG header of base64 `data`; null when unknown. */
export function imageSize(data) {
  const b = base64Bytes(data, 0, 32);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1]; }
    if (kind === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
    return null;
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // JPEG: jump from segment to segment, decoding 16 bytes at each marker, up to the frame header.
  for (let at = 2, step = 0; step < 512; step++) {
    const w = base64Bytes(data, at, 16);
    let i = 0;
    while (i < w.length && w[i] === 0xff) i++;
    if (i === 0 || i + 8 > w.length) return null;
    const marker = w[i];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += i + 1; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (SOF.has(marker)) return [w.readUInt16BE(i + 6), w.readUInt16BE(i + 4)];
    at += i + 1 + w.readUInt16BE(i + 1);
  }
  return null;
}
export function imageContextHandler(pi, record, options = {}) {
  const images = { ...IMAGES, ...options };
  // Content hash -> job { state: queued, running or done, done: Promise, outcome, doneAt, wantedUntil, timedOut }.
  // Queued and running jobs are never dropped by a request; finished ones are kept while their image is in the context.
  const jobs = new Map();
  let current = new Set(); // hashes of the over-cap images in the latest request
  let running = 0; const waiting = [];
  const acquire = () => { if (running < images.workers) { running++; return Promise.resolve(); } return new Promise(go => waiting.push(go)); };
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; }; // the slot passes straight on
  const start = (key, image, size, wantedUntil) => {
    const job = { state: 'queued', wantedUntil, timedOut: false };
    const row = { event: 'image-resize', width: size[0], height: size[1], mimeType: mimeToken(image.mimeType) };
    const finish = (outcome, fields) => {
      if (fields) record({ ...row, ...fields, ...(job.timedOut ? { afterTimeout: true } : {}) });
      Object.assign(job, { state: 'done', outcome, doneAt: Date.now() });
      if (!current.has(key) && jobs.get(key) === job) jobs.delete(key);
      return outcome;
    };
    job.done = (async () => {
      await acquire();
      // Nobody waits for it any more: every request's deadline has passed and the image left the context.
      if (Date.now() > job.wantedUntil && !current.has(key)) { release(); return finish({ omitted: true }); }
      job.state = 'running';
      const started = Date.now();
      let pkg = null, result = null, stuck = false, hold;
      try {
        pkg = await images.load();
        const work = pkg.resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, { maxWidth: images.maxSide, maxHeight: images.maxSide });
        result = await Promise.race([work, new Promise(go => { hold = setTimeout(() => { stuck = true; go(null); }, images.holdMs); hold.unref?.(); })]);
      } catch {} finally { clearTimeout(hold); release(); }
      const ms = Date.now() - started;
      if (stuck) return finish({ omitted: true }, { outcome: 'stuck', ms });
      if (!result) return finish({ omitted: true }, { outcome: pkg ? 'failed' : 'unavailable', ms });
      // A header that overstated the size: Pi found the image within its limits, so it goes out as it is.
      if (!result.wasResized) return finish({ keep: true }, { outcome: 'within-limits', to: [result.width, result.height], ms });
      let note; try { note = pkg.formatDimensionNote(result); } catch {}
      return finish({ block: { type: 'image', data: result.data, mimeType: result.mimeType }, note },
        { outcome: 'resized', to: [result.width, result.height], toMimeType: mimeToken(result.mimeType), ms });
    })();
    return job;
  };
  return async event => {
    const messages = event?.messages;
    if (!Array.isArray(messages)) return undefined;
    let on = true;
    try { on = pi.getSettings()?.images?.autoResize !== false; } catch {}
    if (!on) return undefined;
    const found = [];
    messages.forEach((message, at) => {
      if (message?.role === 'system' || !Array.isArray(message?.content)) return;
      message.content.forEach((block, part) => {
        if (block?.type !== 'image' || typeof block.data !== 'string' || typeof block.mimeType !== 'string' || !block.mimeType.startsWith('image/')) return;
        let size = null; try { size = imageSize(block.data); } catch {}
        if (size && Math.max(size[0], size[1]) > images.maxSide) found.push({ at, part, block, size });
      });
    });
    const began = Date.now(), deadline = began + images.deadlineMs;
    for (const f of found) f.key = createHash('sha256').update(f.block.mimeType).update('\0').update(f.block.data).digest('hex');
    current = new Set(found.map(f => f.key));
    for (const [key, job] of jobs) if (job.state === 'done' && !current.has(key)) jobs.delete(key);
    if (!found.length) return undefined;
    const wanted = found.map(f => {
      let job = jobs.get(f.key);
      if (!job) jobs.set(f.key, job = start(f.key, f.block, f.size, deadline));
      job.wantedUntil = Math.max(job.wantedUntil, deadline);
      return job;
    });
    let timer;
    const late = new Promise(go => { timer = setTimeout(go, Math.max(0, deadline - Date.now())); });
    await Promise.race([Promise.all(wanted.map(job => job.done)), late]);
    clearTimeout(timer);
    // Judged by when each job finished, not by which timer fired first, so a blocked main thread cannot sneak a late
    // result into this request; the next request sends it.
    const outcomes = wanted.map((job, i) => {
      if (job.state === 'done' && job.doneAt <= deadline) return job.outcome;
      if (!job.timedOut) {
        job.timedOut = true;
        record({ event: 'image-resize', width: found[i].size[0], height: found[i].size[1], mimeType: mimeToken(found[i].block.mimeType), outcome: 'timeout', state: job.state, ms: Date.now() - began });
      }
      return { omitted: true };
    });
    const out = messages.slice();
    const swaps = new Map();
    found.forEach((f, i) => { if (!swaps.has(f.at)) swaps.set(f.at, new Map()); swaps.get(f.at).set(f.part, outcomes[i]); });
    for (const [at, parts] of swaps) {
      const content = [];
      messages[at].content.forEach((block, part) => {
        const o = parts.get(part);
        if (!o || o.keep) content.push(block);
        else if (o.omitted) content.push({ type: 'text', text: OMITTED_IMAGE });
        else { content.push({ ...o.block }); if (o.note) content.push({ type: 'text', text: o.note }); }
      });
      out[at] = { ...messages[at], content };
    }
    return { messages: out };
  };
}
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
// Claude account limit. When every Claude account has hit its 5-hour window, the router answers each request with
// 429 rate_limit_error "This request would exceed your account's rate limit". Pi retries that like any 429 (2 to 30 s
// apart, retry.maxRetries times), so a turn dies within minutes of a wall that lasts up to an hour, and every quick
// retry is one more upstream 429. Pi 1.0 has no retry hook, but it runs the message_end handlers before it reads the
// finalized message for its retry check (core/agent-session.js _handleAgentEvent, then _handlePostAgentRun), and a
// provider limit phrase in the error text makes the error non-retryable (pi-ai utils/retry.js). So this extension
// matches only that account-level text and, in message_end:
// - for an unattended agent (accountAttendance) waits, then asks agent_before_settle for one more request, with the
//   failed answer omitted from the context; Pi's own retry never runs. The wait is one try per accountNextTry: a
//   reset the 429 response named (Retry-After, retry-after-ms or an anthropic-ratelimit-*-reset header, read by
//   observeRateLimitHeaders), taken as at least 2 minutes away, plus 30 to 210 s of jitter, else every 2 to 5 minutes
//   at random. A Paseo interrupt, a compaction (Pi aborts the run first) or a session shutdown ends the wait at once, and
//   so does a queued message, which then runs. A try later than ACCOUNT_LIMIT.capMs (90 minutes) after the first 429
//   of the run is not made: the turn fails as before. New inputs within the run keep that deadline; only a successful
//   answer or the end of the run clears it;
// - for an attended agent fails at once.
// A role=pm agent's Claude turn that the router (CPA) refuses with 503 api_error `auth_not_found: no auth candidates
// (providers=claude` or `auth_unavailable: no auth available (providers=claude` (isCpaClaudeUnavailable) fails the same
// way at once for every input, outside a headless run: the usage-limit resume plugin moves such a PM to its fallback
// after two of them in a row. Every other agent, and every other error, is as above.
// A turn that fails this way leads its error with "Claude 5h limit; retry after HH:MM <zone>" when the response's reset
// header or Paceline's pq gives the time, else "Claude account limit; retry time unknown", and keeps the original error
// after it, so the usage-limit resume plugin and log readers classify it as before. Every other error (529, per-minute
// 429s, 5xx, stream drops) keeps Pi's retry.
export const ACCOUNT_LIMIT = {
  capMs: 90 * 60_000, gapMinMs: 120_000, gapMaxMs: 300_000, resetJitterMinMs: 30_000, resetJitterMaxMs: 210_000,
  // A reset header counts only for the error that follows its response.
  hintMaxAgeMs: 60_000, pqTimeoutMs: 5_000, pqCacheMs: 60_000,
  // Pi's own non-retryable phrase (pi-ai NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN): the marked error is final.
  tag: 'account quota exceeded',
};
const ACCOUNT_LIMIT_TEXT = /would exceed your account(?:'|\u2019)s rate limit/i;
/** A Claude account-level 429 that this extension has not marked yet. */
export const isAccountLimit = message => message?.role === 'assistant' && message.stopReason === 'error'
  && typeof message.errorMessage === 'string' && message.errorMessage.includes('rate_limit_error')
  && ACCOUNT_LIMIT_TEXT.test(message.errorMessage) && !message.errorMessage.includes(`(${ACCOUNT_LIMIT.tag}`);
// CPA's own response: a 503 whose api_error message starts with the refusal for providers=claude exactly. Only this
// extension's account-limit lead may come before it; text that merely quotes the refusal does not match. The usage-limit
// resume plugin matches the same shape (server/fallback.ts, CPA_UNAVAILABLE).
const CPA_CLAUDE_UNAVAILABLE = /^\s*(?:Claude [\w ]*limit; [^\n]*?\(account quota exceeded[^)\n]*\)\.\s+)?503\s+\{\s*"type"\s*:\s*"error"\s*,\s*"error"\s*:\s*\{\s*"type"\s*:\s*"api_error"\s*,\s*"message"\s*:\s*"(?:auth_not_found: no auth candidates|auth_unavailable: no auth available) \(providers=claude[,;]/;
/** CPA's 503 for a Claude request with no usable account, not marked yet (as isAccountLimit, a marked error is final). */
export const isCpaClaudeUnavailable = message => message?.role === 'assistant' && message.stopReason === 'error'
  && typeof message.errorMessage === 'string' && CPA_CLAUDE_UNAVAILABLE.test(message.errorMessage)
  && !message.errorMessage.includes(`(${ACCOUNT_LIMIT.tag}`);
// The scratch proof shortens the cap; anything else keeps 90 minutes.
export function accountCapMs(env = process.env) {
  const value = Number(env.LOADOUT_PI_ACCOUNT_WAIT_CAP_MS);
  return Number.isSafeInteger(value) && value >= 60_000 && value <= ACCOUNT_LIMIT.capMs ? value : ACCOUNT_LIMIT.capMs;
}
// A header time: epoch seconds or milliseconds, else an HTTP or ISO date.
function headerTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) { const n = Number(text); return n > 1e12 ? n : n > 1e9 ? n * 1000 : null; }
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}
/**
 * The reset a 429 response names, as epoch ms, or null: retry-after-ms, Retry-After (seconds or a date), then the
 * unified 5-hour and unified resets, then the latest other anthropic-ratelimit-*-reset. Only a time ahead counts.
 */
export function resetFromHeaders(headers, now = Date.now()) {
  const get = name => typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  const ahead = at => Number.isFinite(at) && at > now ? at : null;
  const ms = Number(get('retry-after-ms'));
  if (get('retry-after-ms') != null && Number.isFinite(ms) && ms > 0) return now + ms;
  const after = get('retry-after');
  if (after != null && String(after).trim()) {
    const seconds = Number(String(after).trim());
    const at = Number.isFinite(seconds) ? (seconds > 0 ? now + seconds * 1000 : null) : ahead(Date.parse(after));
    if (at) return at;
  }
  for (const name of ['anthropic-ratelimit-unified-5h-reset', 'anthropic-ratelimit-unified-reset']) {
    const at = ahead(headerTime(get(name)));
    if (at) return at;
  }
  let latest = null;
  try {
    const names = typeof headers?.keys === 'function' ? [...headers.keys()] : Object.keys(headers ?? {});
    for (const name of names) if (/^anthropic-ratelimit-.+-reset$/i.test(name)) {
      const at = ahead(headerTime(get(name)));
      if (at && (!latest || at > latest)) latest = at;
    }
  } catch {}
  return latest;
}
const SINK = Symbol.for('loadout.fleet-routing.rateLimitSink');
/**
 * Pi passes no 429 headers to extensions: the Anthropic SDK throws on a 429 before Pi's after_provider_response, and
 * the error text has none. The SDK builds its client per request with the global fetch, so this wraps that fetch to read
 * the reset of each 429 from a /v1/messages response whose URL matches(url), for onHint(resetAt or null). It changes no
 * request or response. The wrapper is made once per process; a later call (an extension instance after /reload or a
 * session replacement) only points its sink at the new instance.
 */
export function observeRateLimitHeaders(onHint, target = globalThis, matches = () => true) {
  const original = target.fetch;
  if (typeof original !== 'function') return false;
  if (original[SINK]) { original[SINK].onHint = onHint; original[SINK].matches = matches; return true; }
  const sink = { onHint, matches };
  const wrapped = async function (input, init) {
    const response = await original.call(this, input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input?.href ?? '');
      if (response?.status === 429 && /\/v1\/messages(?:\?|$)/.test(url) && sink.matches(url)) sink.onHint(resetFromHeaders(response.headers));
    } catch {}
    return response;
  };
  wrapped[SINK] = sink;
  target.fetch = wrapped;
  return true;
}
// The pq argv, as the usage-limit resume plugin reads it (plugins/usage-limit-auto-resume/server/quota.ts pqArgv).
function pqArgv(home = process.env.HOME || '') {
  let argv = ['~/.local/bin/pq', '--json'];
  try {
    const value = JSON.parse(readFileSync(join(home, '.config', 'opc', 'routing.json'), 'utf8'))?.pq;
    if (Array.isArray(value) && value.length && value.every(arg => typeof arg === 'string' && arg)) argv = value;
  } catch {}
  const [command, ...args] = argv;
  return [command === '~' || command.startsWith('~/') ? join(home, command.slice(1)) : command, ...args];
}
function runPq(argv, timeoutMs) {
  return new Promise(done => {
    let out = '', settled = false, child;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); try { child?.kill(); } catch {} done(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { finish(null); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 16 << 20) finish(null); else try { finish(JSON.parse(out)); } catch {} });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
  });
}
/**
 * When the Claude pool frees, from a pq document (schemaVersion 1), as the usage-limit resume plugin reads it after a
 * quota refusal (quota.ts poolQuota and poolOut with refused): only when no Claude account shows quota left, the
 * earliest time an out account's out windows (five_hour, seven_day) have all reset. Null when unknown.
 */
export function pqClaudeReset(document, now = Date.now()) {
  const num = value => typeof value === 'number' && Number.isFinite(value);
  if (!document || document.schemaVersion !== 1 || document.snapshotStale !== false || !Array.isArray(document.accounts)) return null;
  const accounts = document.accounts.filter(account => account?.provider === 'claude');
  let available = 0;
  const frees = [];
  for (const account of accounts) {
    const windows = (Array.isArray(account.windows) ? account.windows : []).filter(w => w && ['five_hour', 'seven_day'].includes(w.id));
    const out = windows.filter(w => ((num(w.leftPct) && w.leftPct <= 0) || w.state === 'blocking') && num(w.resetAt) && w.resetAt * 1000 > now);
    if (out.length) frees.push(Math.max(...out.map(w => w.resetAt * 1000)));
    else if (account.fresh === true && windows.length && windows.every(w => w.fresh !== false && num(w.leftPct) && w.leftPct > 0)) available++;
  }
  return available === 0 && frees.length ? Math.min(...frees) : null;
}
/** A time as the host's local HH:MM with its zone, with the date when it is not within the next 20 hours. */
export function localClock(at, now = Date.now()) {
  const date = new Date(at);
  const clock = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  return at - now > 20 * 3_600_000 ? `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock}` : clock;
}
// Paseo's envelope grammar (agent-messages/envelope.js parseAgentMessage, parseAgentMessages, SYSTEM_ENVELOPE_PATTERN).
// Paseo wraps a human message that looks like an envelope in a kind="user-message" one, so only Paseo makes these.
const AGENT_ENVELOPE = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/;
const SYSTEM_ENVELOPE = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;
// Paseo's unescapeXml check: a raw < or >, or an & that starts no known entity, makes the envelope invalid.
const badXml = value => /[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value);
const NOTIFICATION_EVENTS = ['finished', 'errored', 'permission-required', 'closed'];
/** The kind of one envelope as Paseo's parseAgentMessage accepts it, else null. */
function envelopeKind(part) {
  const match = AGENT_ENVELOPE.exec(part);
  if (!match || badXml(match[2])) return null;
  const attributes = new Map();
  for (const [, name, value] of match[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    if (badXml(value) || attributes.has(name)) return null;
    attributes.set(name, value);
  }
  if (attributes.get('version') !== '1' || !attributes.get('message-id')) return null;
  const kind = attributes.get('kind');
  if (kind === 'user-message') return attributes.has('source-agent-id') || attributes.has('event') ? null : kind;
  if (kind !== 'agent-message' && kind !== 'agent-notification') return null;
  if (!attributes.get('source-agent-id')) return null;
  // Optional attributes Paseo accepts only when non-empty.
  if (['source-server-id', 'source-agent-title'].some(name => attributes.get(name) === '')) return null;
  if (kind === 'agent-notification' && !NOTIFICATION_EVENTS.includes(attributes.get('event'))) return null;
  return kind;
}
/** The kind of input that started or steered a run: Paseo's schedule, agent-message or agent-notification, else user. */
export function inputKind(text) {
  if (typeof text !== 'string') return 'unknown';
  if (SYSTEM_ENVELOPE.test(text)) return 'schedule';
  const kinds = text.split(/(?<=<\/paseo-system>)\n+(?=<paseo-system )/).map(envelopeKind);
  if (kinds.some(kind => kind === null)) return 'user';
  const kind = kinds.at(-1);
  return kind === 'agent-message' || kind === 'agent-notification' ? kind : 'user';
}
/**
 * Attended or unattended, and why. Unattended: a headless run (print or json mode); a run whose newest input is a
 * Paseo agent message, agent notification, heartbeat or schedule; or a user message to an agent with a parent label
 * (paseo.parent-agent-id or parent) and no role=pm label, which is how a worker started without a Paseo caller gets its
 * prompt, or to an agent a new-agent schedule made (paseo.schedule-id label), which gets each run as a user message.
 * Attended: a user message to a PM or to an agent with no parent. An unknown input is attended too: it fails at
 * once, as before, only faster. A role=pm agent on a Fable model is attended for every input: the usage-limit resume
 * plugin moves such a PM to its fallback chain (Opus, then Sol) on the failed turn, which a wait would delay by up
 * to the cap while a Fable-only limit lasts. A role=pm agent whose error is CPA's 503 (`cpa`, isCpaClaudeUnavailable)
 * is attended for every input too, on any Claude model: the plugin moves it after two such failures in a row. Every
 * other agent, and an Opus PM's plain account 429, is as above.
 */
export const isPmLabels = labels => typeof labels?.role === 'string' && labels.role.trim().toLowerCase() === 'pm';
export function accountAttendance({ mode, labels, input, model, cpa = false }) {
  if (mode === 'print' || mode === 'json') return { unattended: true, reason: 'headless' };
  const pm = isPmLabels(labels);
  if (pm && /(?:^|[/._-])fable(?:$|[/._-])/i.test(String(model ?? ''))) return { unattended: false, reason: 'pm-fable' };
  if (pm && cpa) return { unattended: false, reason: 'pm-cpa-503' };
  if (['agent-message', 'agent-notification', 'schedule'].includes(input)) return { unattended: true, reason: input };
  if (input !== 'user') return { unattended: false, reason: 'unknown' };
  const label = name => typeof labels?.[name] === 'string' && labels[name].trim() !== '';
  if (pm) return { unattended: false, reason: 'pm-user-message' };
  if (label('paseo.schedule-id')) return { unattended: true, reason: 'schedule-run' };
  if (label('paseo.parent-agent-id') || label('parent')) return { unattended: true, reason: 'worker-user-message' };
  return { unattended: false, reason: 'user-message' };
}
const between = (min, max, random) => min + Math.floor(random() * (max - min + 1));
/** When the next try goes: a known reset, but at least 2 minutes away, plus jitter, else a random 2 to 5 minute gap. */
export function accountNextTry({ now = Date.now(), resetAt = null, deadline, random = Math.random }) {
  const at = resetAt && resetAt > now
    ? Math.max(resetAt, now + ACCOUNT_LIMIT.gapMinMs) + between(ACCOUNT_LIMIT.resetJitterMinMs, ACCOUNT_LIMIT.resetJitterMaxMs, random)
    : now + between(ACCOUNT_LIMIT.gapMinMs, ACCOUNT_LIMIT.gapMaxMs, random);
  return { at, source: resetAt && resetAt > now ? 'reset-header' : 'poll', late: at > deadline };
}
const withError = (message, errorMessage) => ({ ...message, errorMessage });
/**
 * One more request: at the next settle, agent_before_settle omits the failed answer, when its error text holds `marker`,
 * and continues. The handler is on only for that settle, because Pi builds a boundary context for every settle once any
 * handler is on. The account limit and the advisor rejection share it.
 */
function settleRetry(pi) {
  let off = null;
  const stop = () => { off?.(); off = null; };
  return {
    stop,
    once(marker) {
      stop();
      off = pi.on('agent_before_settle', event => {
        stop();
        const entry = [...(event?.context?.contextEntries ?? [])].reverse().find(item => item?.sourceEntry?.type === 'message'
          && item.sourceEntry.message?.role === 'assistant');
        const failed = entry?.sourceEntry?.message;
        if (!failed || failed.stopReason !== 'error' || !String(failed.errorMessage ?? '').includes(marker)) return undefined;
        return { entries: [...(event.entries ?? []), { type: 'context_edit', targetId: entry.sourceEntry.id, replacement: null }], continue: true };
      });
    },
  };
}
function accountLimit(pi, record, retry = settleRetry(pi)) {
  let hint = null, labels = null, input = 'unknown', wait = null, stopped = false, pq = null;
  const controllers = new Set();
  const freshHint = () => hint && Date.now() - hint.at <= ACCOUNT_LIMIT.hintMaxAgeMs ? hint.resetAt : null;
  const pqReset = async () => {
    if (!pq || Date.now() - pq.at > ACCOUNT_LIMIT.pqCacheMs) pq = { at: Date.now(), result: runPq(pqArgv(), ACCOUNT_LIMIT.pqTimeoutMs).catch(() => null) };
    return pqClaudeReset(await pq.result);
  };
  // The final error: the retry time and the original text after it.
  const fail = async (message, note = '') => {
    let at = freshHint(), source = at ? 'reset-header' : null;
    if (!at) { at = await pqReset(); source = at ? 'pq' : null; }
    const lead = at ? `Claude 5h limit; retry after ${localClock(at)}` : 'Claude account limit; retry time unknown';
    return { message: withError(message, `${lead} (${ACCOUNT_LIMIT.tag}${note}). ${message.errorMessage}`), retryAt: at, source };
  };
  const sessionId = ctx => { let id = null; try { id = ctx?.sessionManager?.getSessionId() ?? null; } catch {} return id; };
  // Paseo shows a notification on the timeline; a headless run gets one stderr line instead.
  const notify = (ctx, text) => {
    try {
      if (ctx?.hasUI) ctx.ui.notify(text, 'warning');
      else if (ctx?.mode === 'print' || ctx?.mode === 'json') { try { writeSync(2, text + '\n'); } catch {} }
    } catch {}
  };
  // Waits until `at`; ends early on an abort, a session shutdown or a queued message.
  const sleepUntil = async (at, ctx) => {
    const controller = new AbortController();
    controllers.add(controller);
    const signal = ctx?.signal;
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) return 'aborted';
        if (stopped || controller.signal.aborted) return 'shutdown';
        if (ctx?.hasPendingMessages?.()) return 'message';
        const left = at - Date.now();
        if (left <= 0) return 'elapsed';
        await pause(Math.min(1_000, left), controller.signal);
      }
    } finally { signal?.removeEventListener('abort', stop); controllers.delete(controller); }
  };
  // One more request after a wait.
  const continueOnce = () => retry.once(`(${ACCOUNT_LIMIT.tag}; waiting`);
  return {
    hint: resetAt => { hint = { at: Date.now(), resetAt }; },
    labels: value => { labels = value; },
    input: text => { input = inputKind(text); },
    // The end of a run ends its wait episode.
    settled: () => { wait = null; },
    shutdown: () => { stopped = true; for (const controller of controllers) controller.abort(); retry.stop(); },
    async messageEnd(event, ctx) {
      const message = event?.message;
      if (message?.role !== 'assistant') return undefined;
      if (message.stopReason !== 'error') {
        if (wait && message.stopReason !== 'aborted') {
          record({ event: 'account-limit', action: 'cleared', sessionId: sessionId(ctx), tries: wait.tries, waitedMs: Date.now() - wait.startedAt });
          notify(ctx, `Claude account limit cleared after ${wait.tries} ${wait.tries === 1 ? 'try' : 'tries'}.`);
          wait = null;
        }
        return undefined;
      }
      const account = isAccountLimit(message);
      const cpa = isPmLabels(labels) && isCpaClaudeUnavailable(message);
      if (!account && !cpa) return undefined;
      const model = message.model ?? ctx?.model?.id ?? null;
      const who = accountAttendance({ mode: ctx?.mode, labels, input, model, cpa });
      // CPA's auth_not_found carries no account-limit text: it keeps Pi's own retry unless the PM rule fails it at once.
      if (!account && who.unattended) return undefined;
      const row = { event: 'account-limit', sessionId: sessionId(ctx), model, attendance: who.unattended ? 'unattended' : 'attended', reason: who.reason };
      if (!who.unattended) {
        const done = await fail(message);
        record({ ...row, action: 'failed', retryAt: done.retryAt, retrySource: done.source });
        return { message: done.message };
      }
      const now = Date.now();
      const current = wait ??= { startedAt: now, deadline: now + accountCapMs(), tries: 0 };
      const next = accountNextTry({ now, resetAt: freshHint(), deadline: current.deadline });
      if (next.late) {
        const done = await fail(message, `; waited ${Math.round((now - current.startedAt) / 60_000)} min`);
        record({ ...row, action: 'failed', tries: current.tries, waitedMs: now - current.startedAt, retryAt: done.retryAt, retrySource: done.source, cap: true });
        if (wait === current) wait = null;
        return { message: done.message };
      }
      current.tries++;
      record({ ...row, action: 'wait', try: current.tries, nextTryAt: new Date(next.at).toISOString(), source: next.source });
      notify(ctx, `Claude account limit; waiting, next try about ${localClock(next.at)} (try ${current.tries}; gives up after ${localClock(current.deadline)}).`);
      const outcome = await sleepUntil(next.at, ctx);
      if (outcome !== 'elapsed') {
        record({ ...row, action: 'stopped', why: outcome, tries: current.tries });
        return { message: withError(message, `Claude account limit; wait ended (${ACCOUNT_LIMIT.tag}; ${outcome}). ${message.errorMessage}`) };
      }
      continueOnce();
      return { message: withError(message, `Claude account limit; trying again (${ACCOUNT_LIMIT.tag}; waiting, try ${current.tries}). ${message.errorMessage}`) };
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
  const retry = settleRetry(pi);
  const limit = accountLimit(pi, record, retry);
  // The last request's advisor state, and the runtime.json key at the advisor's rejection (null: not rejected).
  let sent = null, rejectedAt = null;
  pi.on('input', event => { limit.input(event?.text); });
  pi.on('context_with_system', imageContextHandler(pi, record));
  pi.on('message_end', (event, ctx) => limit.messageEnd(event, ctx));
  // Advisor results in the response now streaming (Pi drops those blocks). A call the model starts after a client
  // tool call gets no result in that response, so results are counted, not calls.
  const advised = advisorResults();
  const executor = executorSteps();
  pi.on('message_end', (event, ctx) => {
    const message = event?.message;
    if (message?.role !== 'assistant') return undefined;
    const request = sent; sent = null;
    let steps = [];
    try { steps = executor.take(message, sessionOf(ctx)); } catch {}
    const reason = request?.advisor ? advisorRejection(message) : null;
    if (reason) {
      rejectedAt = request.key;
      let sessionId = null; try { sessionId = ctx?.sessionManager?.getSessionId() ?? null; } catch {}
      record({ event: 'advisor', outcome: 'rejected', reason, status: 400, requestId: request.requestId, turnId: request.turnId,
        sessionId, model: message.model ?? null });
      retry.once(ADVISOR_RETRY);
      // No upstream text: a tag list in it can hold Pi's retryable status digits (text_editor_20250429 holds 504), and
      // Pi's own retry must not run on top of this one. The failed answer is left out of the context anyway.
      return { message: withError(message, `${ADVISOR_RETRY} (${reason}; 400 invalid_request_error).`) };
    }
    // Pi maps pause_turn to an ordinary stop, so a turn the API paused on a pending advisor call just ends.
    if (message.rawStopReason === 'pause_turn') record({ event: 'advisor', model: message.model ?? null, outcome: 'pause_turn' });
    let next = message;
    try { next = withContextUsage(message, steps); } catch {}
    if (advised.take() && message.stopReason !== 'error') next = withAdvisorNote(next);
    return next !== message ? { message: next } : undefined;
  });
  pi.on('agent_settled', () => { limit.settled(); });
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
  pi.on('session_shutdown', () => { credential.shutdown(); limit.shutdown(); });
  pi.on('session_start',(_event,ctx)=>{
    privacy.start(ctx);
    const check = enforceCodemode(pi);
    const evidence = { event: 'codemode-check', ...check, sessionId: ctx.sessionManager.getSessionId(), extensionSha256: EXTENSION_SHA256, guardSha256: GUARD_SHA256 };
    record(evidence);
    pi.appendEntry('loadout-codemode-check', evidence);
    // Only 429s from a configured anthropic-messages base URL, read at each 429 so a registered provider counts.
    observeRateLimitHeaders(limit.hint, globalThis, url => (ctx.modelRegistry?.getAll?.() ?? [])
      .some(model => model?.api === 'anthropic-messages' && typeof model.baseUrl === 'string' && model.baseUrl
        && url.startsWith(model.baseUrl.replace(/\/+$/, '') + '/')));
  });
  pi.on('before_agent_start',async(_event,ctx)=>{
    enforceCodemode(pi);turnId=randomUUID();
    // Fail closed for this turn until its own lookup succeeds; never keep the previous turn's tier.
    intent={tier:null,source:'opc labels',lookupFailed:true,error:'agent label lookup did not complete'};tiers=null;
    try{const labels=await agentLabels();limit.labels(labels);intent=resolveTierIntent(labels);}
    catch(error){limit.labels(null);intent={tier:null,source:'opc labels',lookupFailed:true,error:`agent label lookup failed: ${String(error?.message??error).slice(0,80)}`};}
    try{tiers=ctx?.model?await catalogTiers(ctx):null;}catch{tiers=null;}
  });
  pi.on('before_provider_request',(event,ctx)=>{
    enforceCodemode(pi);
    // Pi swallows handler exceptions and would send the original payload, which then inherits
    // the fleet default: a silent mapping. Every refusal or failure below returns a model id the
    // proxy rejects, so the turn errors visibly and nothing reaches the provider.
    let id=null;sent=null;
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
      let prepared=preparePayload(event.payload,{model:ctx.model,sessionId:ctx.sessionManager.getSessionId(),turnId,cwd:ctx.cwd,tier,requestId:id});
      if(advisorRoute(ctx.model)){
        const on=advisorEnabled(),key=advisorRuntimeKey();
        if(rejectedAt!==null&&rejectedAt!==key) rejectedAt=null;
        const advised=on&&rejectedAt===null?withAdvisor(prepared,ctx.model):prepared;
        row.advisor=advised!==prepared;prepared=advised;
        if(on&&rejectedAt!==null) row.advisorRejected=true;
        sent={advisor:row.advisor,key,requestId:id,turnId};
      }
      prepared=withAdvisorHistory(prepared);
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
  pi.on('provider_stream_event',(event,ctx)=>{
    const response=event.data?.response;
    if(event.data?.type==='response.completed') record({event:'response',model:event.model,service_tier:response?.service_tier,responseId:response?.id});
    advised.event(event.data);
    executor.event(event.data,event.api,sessionOf(ctx));
    // Each advisor call that brought no advice (an error code such as too_many_requests, or refusal).
    const block=event.data?.type==='content_block_start'&&event.data.content_block?.type==='advisor_tool_result'?event.data.content_block:null;
    const outcome=block?advisorOutcome(block):'advice';
    if(outcome!=='advice') record({event:'advisor',model:event.model,outcome});
    // Each advisor call in an Anthropic response: its model and tokens, for quota tracking.
    const steps=event.data?.type==='message_delta'&&Array.isArray(event.data.usage?.iterations)?event.data.usage.iterations.filter(step=>step?.type==='advisor_message'):[];
    for(const step of steps) record({event:'advisor',model:event.model,advisorModel:step.model??null,inputTokens:step.input_tokens??null,outputTokens:step.output_tokens??null,cacheReadTokens:step.cache_read_input_tokens??null});
  });
}

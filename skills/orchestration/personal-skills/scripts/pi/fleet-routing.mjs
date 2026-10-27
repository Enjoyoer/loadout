// Router protocol metadata and an explicit, catalog-checked service tier (Fast/Standard/Ultrafast).
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
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
    // A resolved tier (explicit or the Fast default) is sent as-is; an inherited preference sends no
    // tier so the fleet default applies upstream. A stray client tier never survives an inherit.
    if (tier?.wire) result.service_tier = tier.wire;
    else delete result.service_tier;
  }
  return result;
}

// Tier semantics. opc.service-tier (fast|standard|ultrafast|inherit, with priority/default
// aliases) wins; legacy opc.fast-requested 'true'/'false' (written by OPC) means fast/standard;
// absent means inherit the fleet default rather than "off". On a GPT route whose catalog lists
// the priority tier the default is Fast (tierDecision); only an explicit Standard turns it off.
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
  const zenFree = model?.provider === 'opencode' && ['space-bunny-free', 'muse-spark-1.3-contributor-free'].includes(model.id);
  const codexRoute = !zenFree && model?.api === 'openai-responses' && !model.id.startsWith('chatgpt-web/');
  // A failed or unfinished label lookup must never fall back to a stale or inherited tier.
  // Known Zen free IDs also fail closed: a missing lookup could hide explicit Fast.
  if (intent?.lookupFailed) return codexRoute || zenFree ? { status: 'lookup-failed', error: intent.error } : { status: 'lookup-failed-untiered' };
  if (intent?.error) return { status: 'invalid', error: intent.error };
  // No choice (absent or inherit) is Fast where the catalog offers it, and inherits elsewhere.
  if (!intent || intent.tier === 'inherit') return codexRoute && catalogTiers?.includes(CATALOG_TIER.fast)
    ? { status: 'fleet-default-fast', wire: TIER_WIRE.fast, header: 'fast' }
    : { status: 'inherited', header: codexRoute ? 'inherit' : undefined };
  // A tier label left over from a GPT route must not break a later swap to an untiered route
  // (Claude, web, free Zen IDs): send no tier and record it.
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
// credential is fine. Instead, before each model request of a run (turn_start), this extension runs that same helper
// itself, without a shell, with up to two retries (CREDENTIAL), and lends the value to Pi as an in-memory provider
// override (registerProvider with the value as an escaped literal), so Pi spawns nothing for it. If every try fails, it
// lends the value of the last successful read, but only up to CREDENTIAL.maxAgeMs after that read. Without such a
// value, after agent_end, and once a lent value reaches that age, the override is withdrawn and Pi runs its own command
// again: a process that never read a value fails closed as before. A successful read always replaces the held value, so
// a rotation applies to the next request. The value stays in this process's memory: it is never written to a file, a
// log, argv or the environment, and evidence rows carry only the outcome.
export const CREDENTIAL = { timeoutMs: 15_000, retryDelaysMs: [1_000, 2_000], maxAgeMs: 15 * 60_000 };
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
/** One run of the helper: its one stdout line, or null on any failure (a nonzero exit, a timeout, an abort, no line). */
export function readCredential(argv, { timeoutMs = CREDENTIAL.timeoutMs, signal } = {}) {
  return new Promise(done => {
    let out = '', settled = false, child, guard;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(guard); child?.stdout?.destroy(); done(value);
    };
    try { child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: timeoutMs, signal }); }
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
  const refresh = async ctx => {
    if (!target() || ctx?.model?.provider !== found.provider) return;
    const signal = ctx?.signal;
    let value = null, tries = 0;
    for (const delay of [0, ...CREDENTIAL.retryDelaysMs]) {
      if (delay) await pause(delay, signal);
      if (signal?.aborted) return;
      tries++;
      if ((value = await readCredential(found.argv, { timeoutMs: CREDENTIAL.timeoutMs, signal }))) break;
    }
    if (signal?.aborted) return;
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
  return { refresh, withdraw };
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
  pi.on('turn_start', (_event, ctx) => credential.refresh(ctx));
  pi.on('agent_end', () => credential.withdraw());
  pi.on('session_shutdown', () => credential.withdraw());
  pi.on('session_start',(_event,ctx)=>{
    const check = enforceCodemode(pi);
    const evidence = { event: 'codemode-check', ...check, sessionId: ctx.sessionManager.getSessionId(), extensionSha256: EXTENSION_SHA256 };
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

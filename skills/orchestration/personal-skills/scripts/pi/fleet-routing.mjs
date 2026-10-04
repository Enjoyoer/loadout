// Router protocol metadata and an explicit, catalog-checked service tier (Fast/Standard/Ultrafast).
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
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
  if (model?.api === 'openai-responses') {
    const metadata = { thread_id: sessionId, turn_id: turnId, sandbox: 'none', workspaces: { [cwd]: {} } };
    result.client_metadata = { ...result.client_metadata, 'x-codex-turn-metadata': JSON.stringify(metadata),
      ...(requestId ? { 'x-fleet-request-id': requestId } : {}) };
    if (model.id.startsWith('chatgpt-web/')) {
      const xml = cwd.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      const environment = { type:'message', role:'developer', content:[{type:'input_text',text:
        `<environment_context>\n<cwd>${xml}</cwd>\n<filesystem><workspace_roots><root>${xml}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`}] };
      result.input = [environment, ...(Array.isArray(result.input) ? result.input : [])];
      // The Web backend binds replay to the latest real user instruction's turn.
      const latest = result.input.findLast(item => item.role === 'user');
      if (latest) { latest.type='message';latest.internal_chat_message_metadata_passthrough={turn_id:turnId}; }
    }
    // Explicit choice is sent as-is; an inherited preference sends no tier so the
    // fleet default applies upstream. A stray client tier never survives an inherit.
    if (tier?.wire) result.service_tier = tier.wire;
    else delete result.service_tier;
  }
  return result;
}

// Tier semantics. opc.service-tier (fast|standard|ultrafast|inherit, with priority/default
// aliases) wins; legacy opc.fast-requested 'true'/'false' (written by OPC) means fast/standard;
// absent means inherit the fleet default rather than "off".
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
  // Routes without a service tier send none either way, so they are not refused for it.
  if (intent?.lookupFailed) return codexRoute ? { status: 'lookup-failed', error: intent.error } : { status: 'lookup-failed-untiered' };
  if (intent?.error) return { status: 'invalid', error: intent.error };
  if (!intent || intent.tier === 'inherit') return { status: 'inherited', header: codexRoute ? 'inherit' : undefined };
  if (!codexRoute) return { status: 'unsupported', error: `service tier "${intent.tier}" is not supported for ${model?.id}: this route has no service tier` };
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
    if(ctx?.model?.api==='openai-responses') event.headers['X-Client-Request-Id']=requestId();
    settle('headers');
  });
  pi.on('provider_stream_event',event=>{
    const response=event.data?.response;
    if(event.data?.type==='response.completed') record({event:'response',model:event.model,service_tier:response?.service_tier,responseId:response?.id});
  });
}

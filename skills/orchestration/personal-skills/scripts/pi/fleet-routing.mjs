// Router protocol metadata and an optional priority request, without a Fast UI toggle.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export function preparePayload(payload, { model, sessionId, turnId, cwd, fastRequested }) {
  if (!payload || typeof payload !== 'object') return payload;
  const result = structuredClone(payload);
  if (model?.api === 'openai-responses') {
    const metadata = { thread_id: sessionId, turn_id: turnId, sandbox: 'none', workspaces: { [cwd]: {} } };
    result.client_metadata = { ...result.client_metadata, 'x-codex-turn-metadata': JSON.stringify(metadata) };
    if (model.id.startsWith('chatgpt-web/')) {
      const xml = cwd.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      const environment = { type:'message', role:'developer', content:[{type:'input_text',text:
        `<environment_context>\n<cwd>${xml}</cwd>\n<filesystem><workspace_roots><root>${xml}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`}] };
      result.input = [environment, ...(Array.isArray(result.input) ? result.input : [])];
      // The Web backend binds replay to the latest real user instruction's turn.
      const latest = result.input.findLast(item => item.role === 'user');
      if (latest) { latest.type='message';latest.internal_chat_message_metadata_passthrough={turn_id:turnId}; }
    }
    if (fastRequested && model.id === 'gpt-6.1-sol') result.service_tier = 'priority';
  }
  return result;
}
async function requestedFast() {
  const url=process.env.LOADOUT_PI_MCP_URL;const id=process.env.PASEO_AGENT_ID;
  if (!url || !id) return false;
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'route-status',method:'tools/call',params:{name:'get_agent_status',arguments:{agentId:id}}}),signal:AbortSignal.timeout(10000)});
  const text=await response.text();const value=response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(line=>line.startsWith('data:')).slice(5)) : JSON.parse(text);
  if (!response.ok || value.error || value.result?.isError) throw Error('route snapshot unavailable');
  return value.result?.structuredContent?.snapshot?.labels?.['opc.fast-requested'] === 'true';
}
export default function(pi) {
  let turnId=randomUUID();let fastRequested=false;
  const record = row => {
    if(process.env.PI_CODING_AGENT_DIR) appendFileSync(join(process.env.PI_CODING_AGENT_DIR,'route-evidence.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});
  };
  pi.on('before_agent_start',async()=>{turnId=randomUUID();fastRequested=await requestedFast();});
  pi.on('before_provider_request',(event,ctx)=>{
    const result=preparePayload(event.payload,{model:ctx.model,sessionId:ctx.sessionManager.getSessionId(),turnId,cwd:ctx.cwd,fastRequested});
    record({event:'request',model:ctx.model?.id,thinking:ctx.thinkingLevel,fastRequested,service_tier:result?.service_tier,turnId});
    return result;
  });
  pi.on('provider_stream_event',event=>{
    const response=event.data?.response;
    if(event.data?.type==='response.completed') record({event:'response',model:event.model,service_tier:response?.service_tier,responseId:response?.id});
  });
}

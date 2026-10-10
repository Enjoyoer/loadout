import test from 'node:test';import assert from 'node:assert/strict';import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';import { join } from 'node:path';import { tmpdir } from 'node:os';import http from 'node:http';
import contribute from '../index.server';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'fast-fixture-'));await mkdir(join(root,'agent'));
 let rows:any[]=[{slug:'example-sol',service_tiers:[{id:'priority'}]}];let writes=0;let fail=false;
 let agent:any={id:'a',provider:'pi',model:'fleet/example-sol',runtimeInfo:{model:'fleet/example-sol'},labels:{unrelated:'keep'}};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');if(req.url?.startsWith('/models')){res.statusCode=fail?503:200;res.end(JSON.stringify({models:rows}));return;}
  let body='';for await(const c of req)body+=c;const value=JSON.parse(body);writes++;assert.equal(value.params.name,'update_agent');assert.deepEqual(Object.keys(value.params.arguments),['agentId','labels']);assert.deepEqual(Object.keys(value.params.arguments.labels),['opc.service-tier']);
  agent.labels={...agent.labels,...value.params.arguments.labels};res.end(JSON.stringify({jsonrpc:'2.0',id:value.id,result:{structuredContent:{}}}));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(server.address() as any).port;
 // The fixture server stands in for the plugin's own daemon.
 const host=process.env.PASEO_HOST;process.env.PASEO_HOST=new URL(base).host;
 const setMcp=(url:string)=>writeFile(join(root,'runtime.json'),JSON.stringify({paseoMcp:{url},python:process.env.PYTHON??(process.platform==='win32'?'python':'python3')}));
 await setMcp(base+'/mcp');await writeFile(join(root,'credential.py'),'print("fixture-key")\n');
 await writeFile(join(root,'agent/models.json'),JSON.stringify({providers:{fleet:{api:'openai-responses',baseUrl:base,models:[{id:'example-sol'}]}}}));
 const handlers=new Map<string,any>();let configured=true;
 contribute({registerSettings(){return {read:async()=>({status:'ready',values:{runtimeRoot:configured?root:''}})}},handle(contract:any,fn:any){handlers.set(contract.name,fn)}} as any);
 const context={paseo:{agents:{ref(){return {refresh:async()=>({agent})}}}}};
 return {call:(method:string,input:any)=>handlers.get(method)(input,context),get agent(){return agent},setAgent(v:any){agent=v},setRows(v:any[]){rows=v},fail(){fail=true},unconfigure(){configured=false},setMcp,get writes(){return writes},async cleanup(){if(host===undefined)delete process.env.PASEO_HOST;else process.env.PASEO_HOST=host;await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}};
}
test('backend validates catalog and writes only requested label with readback',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.call('fast.inspect',{agentId:'a'}),{capable:true,fast:false,tier:'standard'});
  assert.deepEqual(await f.call('fast.toggle',{agentId:'a',fast:true}),{capable:true,fast:true,tier:'fast'});
  assert.equal(f.agent.labels.unrelated,'keep');assert.equal(f.agent.model,'fleet/example-sol');
  assert.deepEqual(await f.call('fast.toggle',{agentId:'a',fast:false}),{capable:true,fast:false,tier:'standard'});assert.equal(f.writes,2);
 }finally{await f.cleanup()}
});
for(const mode of ['native','archived','unsupported','outage','unconfigured'])test('fails closed: '+mode,async()=>{
 const f=await fixture();try{
  if(mode==='native')f.agent.provider='codex';if(mode==='archived')f.agent.archivedAt='now';if(mode==='unsupported')f.setRows([]);if(mode==='outage')f.fail();if(mode==='unconfigured')f.unconfigure();
  assert.equal((await f.call('fast.inspect',{agentId:'a'})).capable,false);
  await assert.rejects(f.call('fast.toggle',{agentId:'a',fast:true}));assert.equal(f.writes,0);
 }finally{await f.cleanup()}
});
test('writes only to its own daemon\'s MCP endpoint and never follows a redirect',async()=>{
 const f=await fixture();let elsewhere=0;
 const other=http.createServer((req,res)=>{elsewhere++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:'fast-toggle',result:{}}))});
 await new Promise<void>(r=>other.listen(0,'127.0.0.1',r));const otherUrl='http://127.0.0.1:'+(other.address() as any).port+'/mcp';
 const redirector=http.createServer((req,res)=>{res.statusCode=307;res.setHeader('Location',otherUrl);res.end()});
 await new Promise<void>(r=>redirector.listen(0,'127.0.0.1',r));const redirectHost='127.0.0.1:'+(redirector.address() as any).port;
 try{
  await f.setMcp(otherUrl);
  await assert.rejects(f.call('fast.toggle',{agentId:'a',fast:true}),/not this plugin's daemon/);
  await f.setMcp('http://'+redirectHost+'/mcp');process.env.PASEO_HOST=redirectHost;
  await assert.rejects(f.call('fast.toggle',{agentId:'a',fast:true}));
  assert.equal(elsewhere,0);assert.equal(f.writes,0);assert.equal(f.agent.labels['opc.service-tier'],undefined);
 }finally{await f.cleanup();await new Promise<void>(r=>other.close(()=>r()));await new Promise<void>(r=>redirector.close(()=>r()))}
});

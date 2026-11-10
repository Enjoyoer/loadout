import test from 'node:test';import assert from 'node:assert/strict';import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';import { join } from 'node:path';import { tmpdir } from 'node:os';import http from 'node:http';
import contribute from '../index.server';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'fast-fixture-'));await mkdir(join(root,'agent'));
 let rows:any[]=[{slug:'example-sol',service_tiers:[{id:'priority'}]}];let writes=0;let fail=false;
 let agent:any={id:'a',provider:'pi',model:'fleet/example-sol',runtimeInfo:{model:'fleet/example-sol'},labels:{unrelated:'keep'}};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');if(req.url?.startsWith('/models')){res.statusCode=fail?503:200;res.end(JSON.stringify({models:rows}));return;}
  writes++;res.end('{}');
 });server.on('upgrade',(_req,socket)=>{writes++;socket.destroy()});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(server.address() as any).port;
 // The fixture server stands in for the plugin's own daemon, recorded in its home's paseo.pid, so any write attempt reaches it.
 const env={home:process.env.PASEO_HOME,host:process.env.PASEO_HOST};const home=join(root,'home');await mkdir(home);process.env.PASEO_HOME=home;delete process.env.PASEO_HOST;
 await writeFile(join(home,'paseo.pid'),JSON.stringify({listen:new URL(base).host}));
 await writeFile(join(root,'runtime.json'),JSON.stringify({python:process.env.PYTHON??(process.platform==='win32'?'python':'python3')}));await writeFile(join(root,'credential.py'),'print("fixture-key")\n');
 await writeFile(join(root,'agent/models.json'),JSON.stringify({providers:{fleet:{api:'openai-responses',baseUrl:base,models:[{id:'example-sol'}]}}}));
 const handlers=new Map<string,any>();let configured=true;
 contribute({registerSettings(){return {read:async()=>({status:'ready',values:{runtimeRoot:configured?root:''}})}},handle(contract:any,fn:any){handlers.set(contract.name,fn)}} as any);
 const context={paseo:{agents:{ref(){return {refresh:async()=>({agent})}}}}};
 return {call:(method:string,input:any)=>handlers.get(method)(input,context),get agent(){return agent},setAgent(v:any){agent=v},setRows(v:any[]){rows=v},fail(){fail=true},unconfigure(){configured=false},get writes(){return writes},async cleanup(){for(const [name,value] of [['PASEO_HOME',env.home],['PASEO_HOST',env.host]]as const)if(value===undefined)delete process.env[name];else process.env[name]=value;await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}};
}
test('backend validates catalog',async()=>{
 const f=await fixture();try{
  // No label on a priority route is the fleet default, Standard.
  assert.deepEqual(await f.call('fast.inspect',{agentId:'a'}),{capable:true,fast:false,tier:'inherit'});
 }finally{await f.cleanup()}
});
for(const mode of ['native','archived','unsupported','outage','unconfigured'])test('fails closed: '+mode,async()=>{
 const f=await fixture();try{
  if(mode==='native')f.agent.provider='codex';if(mode==='archived')f.agent.archivedAt='now';if(mode==='unsupported')f.setRows([]);if(mode==='outage')f.fail();if(mode==='unconfigured')f.unconfigure();
  assert.equal((await f.call('fast.inspect',{agentId:'a'})).capable,false);
  await assert.rejects(f.call('fast.toggle',{agentId:'a',fast:true}));assert.equal(f.writes,0);
 }finally{await f.cleanup()}
});

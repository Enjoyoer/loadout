import test from 'node:test';import assert from 'node:assert/strict';
import { contributePills } from '../client/pills';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const pills=new Map<string,any>();const calls:any[]=[];let observer:any;let releases=0;
 let state={capable:true,fast:false,tier:'standard'};
 const a={id:'a',provider:'pi',workspaceId:'w'};
 const client={paseo:{agents:{list:async()=>({subscription:{subscribe(o:any){observer=o;o.snapshot({entries:[{agent:a},{agent:{...a,id:'native',provider:'codex'}}]})},async release(){releases++}}})}},
 rpc:async(contract:any,input:any)=>{calls.push({name:contract.name,input});if(contract.name==='fast.toggle')state={...state,fast:input.fast,tier:input.fast?'fast':'standard'};return state;},
 addComposerPill(p:any){pills.set(p.agentId,p);return {remove(){if(pills.get(p.agentId)===p)pills.delete(p.agentId)},update(){}}}};
 return {client,pills,calls,a,setState(v:any){state=v},get observer(){return observer},get releases(){return releases}};
}
test('bootstraps existing Pi agent, hides native agents, toggles from fresh state, cleans up',async()=>{
 const f=fixture();const cleanup=contributePills(f.client as any);await tick();await tick();
 assert.equal(f.pills.size,1);assert.equal(f.pills.get('a').button.label,'Fast: Off');
 const pill=f.pills.get('a');f.setState({capable:true,fast:true,tier:'fast'});
 await pill.button.behavior.onPress();
 assert.deepEqual(f.calls.find(c=>c.name==='fast.toggle').input,{agentId:'a',fast:false});
 assert.equal(f.pills.get('a').button.label,'Fast: Off');
 f.observer.update({type:'agent_update',payload:{kind:'remove',agentId:'a'}});assert.equal(f.pills.size,0);
 await cleanup();assert.equal(f.releases,1);
});
test('changed model is rechecked and hidden when catalog denies capability',async()=>{
 const f=fixture();const cleanup=contributePills(f.client as any);await tick();await tick();
 f.setState({capable:false,fast:false,tier:'standard'});
 f.observer.update({type:'agent_update',payload:{kind:'upsert',agent:f.a}});await tick();assert.equal(f.pills.size,0);
 await cleanup();
});
test('capability loss at click does not write a label and shows an actionable failure',async()=>{
 const f=fixture();const cleanup=contributePills(f.client as any);await tick();await tick();const pill=f.pills.get('a');
 f.setState({capable:false,fast:false,tier:'standard'});
 await assert.rejects(pill.button.behavior.onPress(),/unavailable/);assert.equal(f.calls.some(c=>c.name==='fast.toggle'),false);
 await cleanup();
});
test('late list bootstrap is released after teardown and never registers pills',async()=>{
 let resolve:any;let releases=0;
 const client={paseo:{agents:{list:()=>new Promise(r=>{resolve=r})}},addComposerPill(){throw Error('must not register')}};
 const cleanup=contributePills(client as any);const pending=cleanup();resolve({subscription:{release:async()=>{releases++}}});await pending;assert.equal(releases,1);
});
test('late inspect response cannot resurrect a removed agent',async()=>{
 const f=fixture();let resolve:any;f.client.rpc=()=>new Promise(r=>{resolve=r}) as any;
 const cleanup=contributePills(f.client as any);await tick();f.observer.update({type:'agent_update',payload:{kind:'remove',agentId:'a'}});
 resolve({capable:true,fast:false,tier:'standard'});await tick();assert.equal(f.pills.size,0);await cleanup();
});

import test from 'node:test';import assert from 'node:assert/strict';import { contributePills } from '../client/pills';
const tick=()=>new Promise(r=>setImmediate(r));
test('hydrates later directory pages and stops at the final cursor',async()=>{
 const ids:string[]=[];let release=0;const calls:any[]=[];
 const client={rpc:async()=>({capable:true,fast:false,tier:'standard'}),addComposerPill(p:any){ids.push(p.agentId);return {remove(){},update(){}}},paseo:{agents:{list:async(options:any)=>{
  calls.push(options);
  if(options.subscribe)return {subscription:{subscribe(o:any){o.snapshot({entries:[{agent:{id:'first',provider:'pi',workspaceId:'w'}}],pageInfo:{hasMore:true,nextCursor:'next'}})},async release(){release++}}};
  return {entries:[{agent:{id:'second',provider:'pi',workspaceId:'w'}}],pageInfo:{hasMore:false,nextCursor:null}};
 }}}};
 const cleanup=contributePills(client as any);await tick();await tick();assert.deepEqual(ids,['first','second']);assert.equal(calls.length,2);assert.equal(calls[1].page.cursor,'next');await cleanup();assert.equal(release,1);
});
test('replacement snapshot invalidates pending capability lookups for missing agents',async()=>{
 let observer:any;let resolve:any;let count=0;
 const client={rpc:()=>new Promise(r=>{resolve=r}),addComposerPill(){count++;return {remove(){},update(){}}},paseo:{agents:{list:async()=>({subscription:{subscribe(o:any){observer=o;o.snapshot({entries:[{agent:{id:'a',provider:'pi',workspaceId:'w'}}]})},async release(){}}})}}};
 const cleanup=contributePills(client as any);await tick();observer.snapshot({entries:[]});resolve({capable:true,fast:false,tier:'standard'});await tick();assert.equal(count,0);await cleanup();
});

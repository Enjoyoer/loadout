import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedState, tierCapable } from '../shared/model';
const sol={id:'example-sol',api:'openai-responses'};
const rows=[{slug:'example-sol',service_tiers:[{id:'priority'}]}];
test('absent and empty labels are Standard, never implicitly Fast',()=>{
 assert.deepEqual(requestedState(),{fast:false,tier:'standard'});
 assert.deepEqual(requestedState({'opc.service-tier':''}),{fast:false,tier:'standard'});
 assert.equal(requestedState({'opc.fast-requested':'true'}).fast,false);
 for(const tier of ['standard','default','inherit'])assert.equal(requestedState({'opc.service-tier':tier}).fast,false);
 for(const tier of ['fast','priority','ultrafast',' FAST '])assert.equal(requestedState({'opc.service-tier':tier}).fast,true);
});
test('capability uses exact router service_tiers and API, not names or aliases',()=>{
 assert.equal(tierCapable(sol,rows),true);
 assert.equal(tierCapable(sol,[{id:sol.id,service_tiers:[{id:'priority'}]}]),true);
 assert.equal(tierCapable(sol,[]),false);
 assert.equal(tierCapable(sol,[{id:sol.id,service_tiers:[{id:'ultrafast'}]}]),false);
 assert.equal(tierCapable({...sol,id:'other'},rows),false);
 assert.equal(tierCapable({...sol,api:'anthropic-messages'},rows),false);
 assert.equal(tierCapable({id:'chatgpt-web/example',api:sol.api},[{id:'chatgpt-web/example',service_tiers:[{id:'priority'}]}]),false);
});

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PI = ROOT / 'skills/orchestration/personal-skills/scripts/pi'


class PiSurfaceTest(unittest.TestCase):
    def test_gmail_is_optional_hidden_and_read_only(self):
        sys.path.insert(0, str(PI))
        from configure import build, GMAIL_READ_TOOLS
        spec = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'},
                'models': [{'id': 'current', 'name': 'Sol'}],
                'settings': {'defaultProvider': 'fleet', 'defaultModel': 'current', 'defaultThinkingLevel': 'high'}}
        root = Path('/tmp/example-pi')
        self.assertNotIn('gmail', build(spec, root)['agent/mcp.json']['mcpServers'])
        server = build({**spec, 'gmail': {'email': 'owner@example.test', 'home': '/tmp/example-pi/gmail-mcp'}}, root)['agent/mcp.json']['mcpServers']['gmail']
        self.assertEqual(server['exposure'], 'hidden')
        self.assertEqual(set(server['toolExposure']), set(GMAIL_READ_TOOLS))
        self.assertEqual(set(server['toolExposure'].values()), {'codemode'})
        self.assertIn('--read-only', server['args'])
        blocked = server['args'][server['args'].index('--disabled-tools') + 1:]
        for name in ('send_gmail_message', 'draft_gmail_message', 'modify_gmail_message_labels', 'start_google_auth'):
            self.assertIn(name, blocked); self.assertNotIn(name, server['toolExposure'])
        self.assertTrue(all(not any(w in t for w in ('send', 'draft', 'modify', 'manage')) for t in server['toolExposure']))
        self.assertEqual(server['env']['WORKSPACE_MCP_HOST'], '127.0.0.1')
        self.assertTrue(server['description'])
        self.assertFalse(any('secret' in v.lower() and not v.endswith('client_secret.json') for v in server['env'].values()))
        for bad in [{'email': 'owner@example.test'}, {'email': 'x', 'home': '/h'},
                    {'email': 'owner@example.test', 'home': '/h', 'scopes': ['gmail.send']},
                    {'email': 'owner@example.test', 'home': '/h', 'port': 80}]:
            with self.assertRaisesRegex(ValueError, 'gmail'):
                build({**spec, 'gmail': bad}, root)

    def test_router_base_url_requires_https_unless_loopback(self):
        sys.path.insert(0, str(PI))
        from configure import build
        spec = {'credential': {'kind': 'env', 'name': 'EXISTING_KEY'}, 'models': [{'id': 'current', 'name': 'Sol'}],
                'settings': {'defaultProvider': 'fleet', 'defaultModel': 'current', 'defaultThinkingLevel': 'high'}}
        root = Path('/tmp/example-pi')
        with self.assertRaisesRegex(ValueError, 'https unless the host is loopback'):
            build({**spec, 'baseUrl': 'http://router.example.test/v1'}, root)
        self.assertEqual(build({**spec, 'baseUrl': 'http://127.0.0.1:4000/v1'}, root)['agent/models.json']['providers']['fleet']['baseUrl'], 'http://127.0.0.1:4000/v1')

    def test_direct_provider_adds_unauthenticated_models_and_picker_rows(self):
        sys.path.insert(0, str(PI))
        from configure import build
        from catalog import derive
        levels = {'off': None, 'minimal': None, 'low': 'low', 'medium': 'medium', 'high': 'high', 'xhigh': 'xhigh', 'max': None}
        model = {'id': 'example-27b', 'name': 'Example', 'reasoning': True, 'input': ['text'], 'contextWindow': 32768,
                 'maxTokens': 8192, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'thinkingLevelMap': levels}
        direct = {'local': {'baseUrl': 'http://gate.example.test:8080/v1', 'api': 'openai-completions', 'auth': 'none', 'models': [model]}}
        spec = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'},
                'models': [{'id': 'current', 'name': 'Sol'}],
                'settings': {'defaultProvider': 'fleet', 'defaultModel': 'current', 'defaultThinkingLevel': 'high'}}
        root = Path('/tmp/example-pi')
        self.assertEqual(list(build(spec, root)['agent/models.json']['providers']), ['fleet'])
        built = build({**spec, 'directProviders': direct}, root)
        local = built['agent/models.json']['providers']['local']
        self.assertEqual(local, {'baseUrl': 'http://gate.example.test:8080/v1', 'api': 'openai-completions', 'apiKey': 'local-no-auth', 'models': [model]})
        self.assertNotIn('compat', local['models'][0])
        self.assertEqual(built['agent/settings.json']['defaultModel'], 'current')
        source = {'codex': {'models': [{'id': 'current', 'label': 'Sol', 'isDefault': True, 'thinkingOptions': [{'id': 'high', 'label': 'High', 'isDefault': True}]}]}}
        pi = {'root': str(root), 'catalogSources': ['codex'], 'runtime': {**{k: v for k, v in spec.items() if k not in ('models', 'settings')}, 'directProviders': direct}}
        rows = derive(source, pi)['provider']['models']
        self.assertEqual([r['id'] for r in rows], ['fleet/current', 'local/example-27b'])
        row = rows[1]
        self.assertEqual((row['label'], row['isDefault']), ('Example', False))
        self.assertEqual([o['id'] for o in row['thinkingOptions']], ['low', 'medium', 'high', 'xhigh'])
        self.assertEqual([o['id'] for o in row['thinkingOptions'] if o.get('isDefault')], ['medium'])
        self.assertEqual(derive(source, pi)['catalog_model_id'], 'fleet/current')
        bad_provider = [{'local': {**direct['local'], 'apiKey': 'x'}}, {'local': {**direct['local'], 'auth': 'bearer'}},
                        {'local': {**direct['local'], 'api': 'openai-responses'}}, {'llama.cpp': direct['local']}, {'fleet': direct['local']},
                        {'local': {**direct['local'], 'models': [{**model, 'compat': {'x': True}}]}},
                        {'local': {**direct['local'], 'models': [{**model, 'reasoning': False}]}},
                        {'local': {**direct['local'], 'models': [model, model]}}]
        for bad in bad_provider:
            with self.assertRaisesRegex(ValueError, 'direct'):
                build({**spec, 'directProviders': bad}, root)
        with self.assertRaisesRegex(ValueError, 'collides'):
            derive(source, {**pi, 'runtime': {**pi['runtime'], 'directProviders': {'local': {**direct['local'], 'models': [{**model, 'name': 'Sol'}]}}}})

    def test_claude_api_key_route_adds_prefixed_pi_entries_after_all_rows(self):
        sys.path.insert(0, str(PI))
        from catalog import derive
        claude = [{'id': n + '[1m]', 'apiModelId': n, 'label': l, 'description': 'Example ' + l + '.', 'thinkingOptions': [{'id': 'high', 'label': 'High', 'isDefault': True}, {'id': 'ultracode', 'label': 'U'}]}
                  for n, l in [('backend-opus', 'Opus'), ('backend-sonnet', 'Sonnet')]]
        source = {'claude': {'models': claude}, 'codex': {'models': [{'id': 'current', 'label': 'Sol', 'isDefault': True, 'thinkingOptions': [{'id': 'high', 'label': 'High', 'isDefault': True}]}]}}
        runtime = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'}}
        pi = {'root': '/tmp/example-pi', 'runtime': runtime}
        plain = derive(source, pi)
        out = derive(source, {**pi, 'claudeApiKeyRoute': {'prefix': 'api', 'labelSuffix': 'API'}})
        rows, models = out['provider']['models'], out['runtime']['models']
        self.assertEqual([r['label'] for r in rows], ['Opus', 'Opus API', 'Sonnet', 'Sonnet API', 'Sol'])
        self.assertEqual([r for r in rows if not r['label'].endswith(' API')], plain['provider']['models'])
        self.assertEqual([(r['id'], r['label']) for r in rows[1:4:2]], [('fleet/api/backend-opus', 'Opus API'), ('fleet/api/backend-sonnet', 'Sonnet API')])
        self.assertTrue(all(r['isDefault'] is False for r in rows[1:4:2]) and rows[1]['description'].endswith('Billed to API credits.'))
        self.assertEqual(rows[1]['thinkingOptions'], rows[0]['thinkingOptions'])
        self.assertEqual([m['name'] for m in models], ['Opus', 'Opus API', 'Sonnet', 'Sonnet API', 'Sol'])
        base, api = models[0], models[1]
        self.assertEqual({**api, 'id': base['id'], 'name': base['name']}, base)
        self.assertEqual((api['id'], api['name'], api['contextWindow']), ('api/backend-opus', 'Opus API', 1000000))
        self.assertEqual(out['catalog_model_id'], plain['catalog_model_id'])
        for bad in [{'prefix': 'api'}, {'prefix': 'API!', 'labelSuffix': 'API'}, {'prefix': 'api', 'labelSuffix': 'two words'}]:
            with self.assertRaisesRegex(ValueError, 'claudeApiKeyRoute'):
                derive(source, {**pi, 'claudeApiKeyRoute': bad})
        with self.assertRaisesRegex(ValueError, 'claude catalog source'):
            derive(source, {**pi, 'catalogSources': ['codex'], 'claudeApiKeyRoute': {'prefix': 'api', 'labelSuffix': 'API'}})

    def test_label_order_is_pi_only_and_keeps_api_pairs_and_direct_rows_last(self):
        sys.path.insert(0, str(PI))
        from catalog import derive
        claude = [{'id': n, 'label': l, 'thinkingOptions': [{'id': 'high', 'label': 'High', 'isDefault': True}]} for n, l in [('o', 'Opus'), ('s', 'Sonnet'), ('f', 'Fable')]]
        source = {'claude': {'models': claude}, 'codex': {'models': [{'id': 'c', 'label': 'Sol', 'isDefault': True, 'thinkingOptions': []}]}}
        runtime = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'},
                   'directProviders': {'local': {'baseUrl': 'http://gate.example.test/v1', 'api': 'openai-completions', 'auth': 'none', 'models': [{'id': 'm', 'name': 'Local', 'reasoning': False, 'input': ['text'], 'contextWindow': 8000, 'maxTokens': 1000, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'thinkingLevelMap': {k: None for k in ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']}}]}}}
        pi = {'root': '/tmp/example-pi', 'runtime': runtime, 'claudeApiKeyRoute': {'prefix': 'api', 'labelSuffix': 'API'}}
        plain = derive(source, pi)
        out = derive(source, {**pi, 'labelOrder': ['Fable', 'Opus', 'Sonnet']})
        self.assertEqual([r['label'] for r in out['provider']['models']], ['Fable', 'Fable API', 'Opus', 'Opus API', 'Sonnet', 'Sonnet API', 'Sol', 'Local'])
        self.assertEqual([m['name'] for m in out['runtime']['models']], ['Fable', 'Fable API', 'Opus', 'Opus API', 'Sonnet', 'Sonnet API', 'Sol'])
        key = lambda r: r['id']
        self.assertEqual(sorted(out['provider']['models'], key=key), sorted(plain['provider']['models'], key=key))
        self.assertEqual(out['catalog_model_id'], plain['catalog_model_id'])
        self.assertEqual([r['label'] for r in derive(source, {**pi, 'labelOrder': ['Sonnet']})['provider']['models']][:4], ['Sonnet', 'Sonnet API', 'Opus', 'Opus API'])
        for bad in [['Fable', 'Fable'], ['Local'], ['Fable API'], 'Fable']:
            with self.assertRaisesRegex(ValueError, 'labelOrder'):
                derive(source, {**pi, 'labelOrder': bad})

    def test_codemode_is_fixed_validated_and_fail_closed_at_runtime(self):
        sys.path.insert(0, str(PI))
        from configure import build, validate_settings
        spec = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'},
                'models': [{'id': 'current', 'name': 'Sol'}],
                'settings': {'defaultProvider': 'fleet', 'defaultModel': 'current', 'defaultThinkingLevel': 'high'}}
        settings = build(spec, Path('/tmp/example-pi'))['agent/settings.json']
        validate_settings(settings)
        for value in [{'codemode': {'mode': 'off'}}, {'codemode': {'mode': 'on'}}, {'defaultTools': ['read']}, {'extensions': []}]:
            with self.assertRaisesRegex(ValueError, 'Codemode'):
                build({**spec, 'settings': {**spec['settings'], **value}}, Path('/tmp/example-pi'))
        with self.assertRaisesRegex(ValueError, 'Codemode'):
            validate_settings({**settings, 'defaultTools': []})
        script = r"""
import assert from 'node:assert/strict';
const {default:extension,validateCodemode,enforceCodemode}=await import(process.argv[1]);
const handlers={};const entries=[];let tools=['read','codemode'];let mode='on';
const pi={getSettings:()=>({codemode:{mode}}),getActiveTools:()=>tools,on:(event,fn)=>handlers[event]=fn,appendEntry:(type,data)=>entries.push({type,data})};
assert.equal(validateCodemode(pi).codemode,'on');extension(pi);
handlers.session_start({}, {sessionManager:{getSessionId:()=> 'session'}});
assert.equal(entries[0].type,'loadout-codemode-check');assert(entries[0].data.activeTools.includes('codemode'));
for(const state of [{tools:['read'],mode:'on'},{tools:['codemode'],mode:'off'}]){
 tools=state.tools;mode=state.mode;let code;
 assert.throws(()=>enforceCodemode(pi,value=>code=value),/requires Codemode/);assert.equal(code,78);
}
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'agent').mkdir()
            (root/'launch.mjs').write_bytes((PI/'launch.mjs').read_bytes())
            (root/'runtime.json').write_text('{}')
            (root/'agent/settings.json').write_text(json.dumps({**settings, 'codemode': {'mode': 'off'}}))
            launch = subprocess.run(['node', str(root/'launch.mjs')], capture_output=True, text=True)
            self.assertNotEqual(launch.returncode, 0)
            self.assertIn('requires fixed Codemode', launch.stderr)

    def test_service_tier_intent_eligibility_and_wire(self):
        script=r"""
import assert from 'node:assert/strict';
const m=await import(process.argv[1]);
const sol={api:'openai-responses',id:'gpt-6.1-sol'},opus={api:'anthropic-messages',id:'claude-opus-5-5'},web={api:'openai-responses',id:'chatgpt-web/pro'};
const R=m.resolveTierIntent,D=m.tierDecision;
assert.deepEqual(R({}),{tier:'inherit',source:'fleet-default'});
assert.equal(R({'opc.fast-requested':'true'}).tier,'fast');
assert.equal(R({'opc.fast-requested':'false'}).tier,'standard');
assert.equal(R({'opc.service-tier':'Standard','opc.fast-requested':'true'}).tier,'standard');
assert.equal(R({'opc.service-tier':'priority'}).tier,'fast');
assert.equal(R({'opc.service-tier':'default'}).tier,'standard');
assert.match(R({'opc.service-tier':'turbo'}).error,/unsupported opc.service-tier/);
const cat=['priority'];
assert.deepEqual(D(R({'opc.service-tier':'fast'}),sol,cat),{status:'explicit',wire:'priority',header:'fast'});
assert.deepEqual(D(R({'opc.service-tier':'standard'}),sol,cat),{status:'explicit',wire:'default',header:'standard'});
for(const c of [[],null,['priority']])assert.deepEqual(D(R({'opc.service-tier':'standard'}),sol,c),{status:'explicit',wire:'default',header:'standard'});
assert.deepEqual(D(R({'opc.fast-requested':'false'}),sol,[]),{status:'explicit',wire:'default',header:'standard'});
assert.deepEqual(D(R({}),sol,cat),{status:'inherited',header:'inherit'});
assert.deepEqual(D(R({}),opus,null),{status:'inherited',header:undefined});
assert.equal(D(R({'opc.service-tier':'ultrafast'}),sol,cat).status,'unsupported');
assert.equal(D(R({'opc.service-tier':'fast'}),sol,[]).status,'unsupported');
assert.equal(D(R({'opc.service-tier':'fast'}),opus,null).status,'unsupported');
assert.equal(D(R({'opc.service-tier':'standard'}),web,null).status,'unsupported');
assert.equal(D(R({'opc.service-tier':'fast'}),sol,null).status,'explicit-unverified');
assert.equal(D(R({'opc.service-tier':'turbo'}),sol,cat).status,'invalid');
const base={model:'gpt-6.1-sol',input:[],reasoning:{effort:'medium'},service_tier:'priority'};
const ctx={model:sol,sessionId:'s',turnId:'t',cwd:'/w',requestId:'r1'};
const inherit=m.preparePayload(base,{...ctx,tier:D(R({}),sol,cat)});
assert.equal('service_tier' in inherit,false);assert.equal(inherit.reasoning.effort,'medium');
assert.equal(inherit.client_metadata['x-fleet-request-id'],'r1');
assert.equal(m.preparePayload(base,{...ctx,tier:D(R({'opc.service-tier':'standard'}),sol,cat)}).service_tier,'default');
const blocked=m.blockedPayload(base,'service tier "ultrafast" is not supported');
assert.ok(blocked.model.startsWith(m.BLOCKED_MODEL_PREFIX+':'));assert.equal(base.model,'gpt-6.1-sol');
assert.match(m.EXTENSION_SHA256,/^[0-9a-f]{64}$/);
// Runtime: both hook orders share one request id; refusal never sends a real model.
for(const order of ['payload-first','headers-first']){
 const h={};const entries=[];
 const pi={getSettings:()=>({codemode:{mode:'on'}}),getActiveTools:()=>['codemode'],on:(e,f)=>h[e]=f,appendEntry:(type,data)=>entries.push({type,data})};
 m.default(pi);
 const rctx={model:sol,thinkingLevel:'medium',cwd:'/w',sessionManager:{getSessionId:()=> 'sess'}};
 await h.before_agent_start({},{model:undefined});
 const hdr={headers:{}};let payload;
 if(order==='payload-first'){payload=h.before_provider_request({payload:base},rctx);h.before_provider_headers(hdr,rctx);}
 else{h.before_provider_headers(hdr,rctx);payload=h.before_provider_request({payload:base},rctx);}
 assert.equal(hdr.headers['X-Fleet-Service-Tier'],'inherit');
 assert.equal(hdr.headers['X-Client-Request-Id'],payload.client_metadata['x-fleet-request-id']);
 assert.equal('service_tier' in payload,false);
}
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_service_tier_fails_closed_on_lookup_and_diagnostic_errors(self):
        script=r"""
import assert from 'node:assert/strict';
import http from 'node:http';import {mkdtempSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
let mode={kind:'labels',labels:{}};
const server=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
 if(req.url.startsWith('/v1/models')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({models:[{slug:'gpt-6.1-sol',service_tiers:[{id:'priority'}]}]}));}
 if(mode.kind==='http500'){res.writeHead(500);return res.end('unavailable');}
 res.writeHead(200,{'content-type':'application/json'});
 if(mode.kind==='isError')return res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:true}}));
 res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:{snapshot:{labels:mode.labels}}}}));});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
process.env.LOADOUT_PI_MCP_URL=base+'/mcp';process.env.PASEO_AGENT_ID='synthetic';
const m=await import(process.argv[1]);
const sol={api:'openai-responses',id:'gpt-6.1-sol',baseUrl:base+'/v1'},opus={api:'anthropic-messages',id:'claude-opus-5-5'};
const registry={getApiKeyAndHeaders:async()=>({ok:true,headers:{}})};
function boot(){const h={};const pi={getSettings:()=>({codemode:{mode:'on'}}),getActiveTools:()=>['codemode'],on:(e,f)=>h[e]=f,appendEntry:()=>{}};m.default(pi);return h;}
const ctx=model=>({model,modelRegistry:registry,thinkingLevel:'medium',cwd:'/w',sessionManager:{getSessionId:()=> 's'}});
const base_payload={model:'gpt-6.1-sol',input:[],reasoning:{effort:'medium'}};
async function turn(h,model,kind,labels){mode={kind,labels};await h.before_agent_start({},ctx(model));const p=h.before_provider_request({payload:{...base_payload,model:model.id}},ctx(model));const hd={headers:{}};h.before_provider_headers(hd,ctx(model));return {p,hd:hd.headers};}
const refused=p=>p.model.startsWith(m.BLOCKED_MODEL_PREFIX+':');
// initial lookup failure refuses on a tiered route (never inherits)
for(const kind of ['http500','isError']){const r=await turn(boot(),sol,kind);assert.ok(refused(r.p),kind);assert.equal(r.p.service_tier,undefined);assert.equal(r.hd['X-Fleet-Service-Tier'],undefined);}
// Fast on turn 1, then a failed lookup on turn 2 refuses (never reuses stale Fast)
{const h=boot();const a=await turn(h,sol,'labels',{'opc.service-tier':'fast'});assert.equal(a.p.service_tier,'priority');assert.ok(!refused(a.p));
 const b=await turn(h,sol,'http500');assert.ok(refused(b.p));assert.equal(b.hd['X-Fleet-Service-Tier'],undefined);
 const c=await turn(h,sol,'labels',{'opc.service-tier':'standard'});assert.equal(c.p.service_tier,'default');assert.equal(c.hd['X-Fleet-Service-Tier'],'standard');}
// untiered route (Opus) is not refused for a lookup failure and gets no tier
{const r=await turn(boot(),opus,'http500');assert.ok(!refused(r.p));assert.equal(r.p.service_tier,undefined);}
// evidence write failure cannot bypass the refusal
{const dir=mkdtempSync(join(tmpdir(),'ev-'));mkdirSync(join(dir,'route-evidence.jsonl'));process.env.PI_CODING_AGENT_DIR=dir;
 const h=boot();const r=await turn(h,sol,'labels',{'opc.service-tier':'ultrafast'});assert.ok(refused(r.p));
 const ok=await turn(h,sol,'labels',{'opc.service-tier':'fast'});assert.equal(ok.p.service_tier,'priority');delete process.env.PI_CODING_AGENT_DIR;}
// any exception inside request preparation fails closed
{const h=boot();mode={kind:'labels',labels:{'opc.service-tier':'standard'}};await h.before_agent_start({},ctx(sol));
 const bad={...ctx(sol),sessionManager:{getSessionId:()=>{throw Error('boom')}}};const p=h.before_provider_request({payload:base_payload},bad);assert.ok(refused(p));}
server.close();
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_all_role_and_worker_rules_preserve_model_and_thinking(self):
        script=r"""
import assert from 'node:assert/strict';
const after=await import(process.argv[1]);
// Historical rule choices before the surface change; scout now follows catalog churn.
const baseline={scout:{model:'gpt-5.6-luna',effort:'max',fastMode:true,label:'Luna'},planner:{model:'chatgpt-web/pro',effort:null,fastMode:false,label:'Web Pro'},reviewer:{model:'chatgpt-web/pro',effort:null,fastMode:false,label:'Web Pro'},planner_fallback:{model:'claude-opus-5-5[1m]',effort:'xhigh',fastMode:false,label:'Opus'}};
const source=[['gpt-6-astra','Astra'],['gpt-6.1-sol','Sol'],['gpt-6-luna','Luna'],['chatgpt-web/extra-high','Web Extra'],['chatgpt-web/pro','Web Pro'],['claude-fable-5-1[1m]','Fable'],['claude-opus-5-5[1m]','Opus']].map(([id,label])=>({id,label,thinkingOptions:['low','medium','high','xhigh','max'].map(id=>({id}))}));
const catalog=source.map(row=>({...row,id:'route/'+row.id}));
let count=0;
for(const [role,before] of Object.entries(baseline)){
 const options=role==='planner_fallback'?{plannerFailure:{id:'failed',status:'failed'},fallbackAuthorization:{answer:'yes',after_round:'failed'}}:{};
 const mapped=after.resolveAgentSurface(role,options,catalog);
 assert.equal(mapped.model,after.resolveCatalogLabel(catalog,before.label).id);
 assert.equal(mapped.effort,before.effort);assert.equal(mapped.fastMode,before.fastMode);
 if(role!=='scout')assert(mapped.model.endsWith('/'+before.model));else assert(mapped.model.endsWith('/gpt-6-luna'));
 assert.equal(mapped.provider,'pi/'+mapped.model);
 const built=after.resolveWorkerSurface({role,route:after.FIXED_ROLE_ROUTES[role],catalog});assert.equal(built.provider,mapped.provider);
 assert.throws(()=>after.resolveAgentSurface(role,options,[]),/catalog label/);
 count++;
}
for(const model of ['gpt-6-astra','gpt-6.1-sol','gpt-6-luna','gpt-5.6-luna','chatgpt-web/extra-high','chatgpt-web/pro','claude-opus-5-5[1m]'])
 for(const effort of ['low','medium','high','xhigh','max','ultra'])for(const fastMode of [true,false]){
  const route={role:'worker',source:'owner-explicit',model,effort,fastMode};
  const before=after.resolveAgentRoute('worker',{explicitRoute:route});
  const supports=catalog.find(row=>row.id==='route/'+model&&row.thinkingOptions.some(x=>x.id===effort));
  const native={explicitRoute:route,nativeAuthorization:'owner-explicit'};
  // Workers run on Pi only: an unserved route stops unless the owner authorized a native Worker.
  if(!supports)assert.throws(()=>after.resolveAgentSurface('worker',{explicitRoute:route},catalog),/explicit owner authorization/);
  const mapped=after.resolveAgentSurface('worker',supports?{explicitRoute:route}:native,catalog);
  assert.equal(mapped.model,before.model);assert.equal(mapped.effort,before.effort);assert.equal(mapped.fastMode,before.fastMode);
  assert.equal(mapped.provider,supports?'pi/'+supports.id:'codex/'+model);
  assert.throws(()=>after.resolveAgentSurface('worker',{explicitRoute:route},catalog,'codex'),/explicit owner authorization/);
  assert.equal(after.resolveAgentSurface('worker',native,catalog,'codex').provider,'codex/'+model);count++;
 }
assert.equal(count,88);
assert.throws(()=>after.resolveCatalogLabel([{id:'a',label:'Luna'},{id:'b',label:'Luna'}],'Luna'),/exactly one/);
const next=catalog.map(row=>row.label==='Luna'?{...row,id:'route/new-catalog-id'}:row);
assert.equal(after.resolveAgentSurface('scout',{},next).model,'route/new-catalog-id');
"""
        done=subprocess.run(['node','--input-type=module','-e',script,(ROOT/'skills/orchestration/opc/scripts/agent-routing.mjs').as_uri()],capture_output=True,text=True)
        self.assertEqual(done.returncode,0,done.stderr)

    def test_worker_task_defaults_owner_precedence_and_native_gate(self):
        script=r"""
import assert from 'node:assert/strict';
const r=await import(process.argv[1]);const w=await import(process.argv[2]);
const levels=ids=>ids.map(id=>({id}));
const catalog=[['claude-opus-5-5','Opus'],['claude-fable-5-1','Fable'],['gpt-6.1-sol','Sol'],['gpt-6-luna','Luna'],['chatgpt-web/pro','Web Pro']]
 .map(([id,label])=>({id:'fleet/'+id,label,thinkingOptions:levels(['low','medium','high','xhigh','max'])}));
const piCaps={enabled:true,status:'available',modes:[],models:catalog};
const nativeCaps={enabled:true,status:'available',modes:[{id:'full-access',isUnattended:true}],models:catalog};
const workspace={workspaceId:'wks-example',cwd:'/tmp/example-worktree'};
const build=extra=>w.buildManagedWorkerRequest({taskId:'task-0001-example',lane:'lane',title:'Worker',initialPrompt:'Do it',workspace,capabilities:piCaps,...extra});
const plain=value=>JSON.parse(JSON.stringify(value));
// Fixed role routes are unchanged; Worker defaults are frozen catalog labels.
assert.deepEqual(plain(r.FIXED_ROLE_ROUTES),{scout:{label:'Luna',fallbackProvider:'codex',effort:'max',fastMode:true},planner:{label:'Web Pro',fallbackProvider:'codex',effort:null,fastMode:false},planner_fallback:{label:'Opus',fallbackProvider:'claude',effort:'xhigh',fastMode:false},reviewer:{label:'Web Pro',fallbackProvider:'codex',effort:null,fastMode:false}});
const cls=(label,effort,range,fastMode=false)=>({label,effort,range,fastMode});
assert.deepEqual(plain(r.WORKER_DEFAULT_ROUTES),{code:cls('Opus','xhigh',['high','xhigh']),'code-bounded':cls('Opus','high',['medium','xhigh']),'test-fix':cls('Opus','high',['medium','xhigh']),'review-critical':cls('Opus','xhigh',['high','xhigh']),'review-general':cls('Opus','high',['medium','xhigh']),automation:cls('Opus','xhigh',['high','xhigh']),browser:cls('Sol','medium',['medium','high'],true),research:cls('Luna','xhigh',['medium','xhigh'],true),mechanical:cls('Opus','medium',null),smoke:cls('Sonnet','low',null),watcher:cls('Luna','xhigh',null,true)});
const unread=pool=>({pool,step:0,weekly:null,stale:'no quota reading supplied',gapPct:null,fiveHourUsedPct:null,resetSoon:null,accounts:null,staleAccounts:null,ageSeconds:null});
assert(Object.isFrozen(r.WORKER_DEFAULT_ROUTES)&&Object.isFrozen(r.WORKER_DEFAULT_ROUTES.code)&&Object.isFrozen(r.WORKER_DEFAULT_ROUTES.browser));
// Code default: Opus at xhigh, Fast off, on Pi, recorded as a task default.
const code=r.selectWorkerRoute({taskKind:'code',catalog});
assert.deepEqual(plain(code),{role:'worker',source:'task-default',kind:'code',model:'fleet/claude-opus-5-5',effort:'xhigh',fastMode:false,pace:unread('claude'),reason:'code default xhigh, no adjustment, no quota reading supplied'});
const codeReq=build({route:code});
assert.equal(codeReq.request.provider,'pi/fleet/claude-opus-5-5');assert.deepEqual(codeReq.request.settings,{thinkingOptionId:'xhigh'});
assert.equal(codeReq.request.labels['opc.route-source'],'task-default');
for(const key of ['opc.service-tier','opc.fast-requested'])assert.equal(key in codeReq.request.labels,false);
assert.equal(r.resolveAgentSurface('worker',{taskKind:'code'},catalog).provider,'pi/fleet/claude-opus-5-5');
assert.match(r.buildDelegatedBrief({role:'worker',route:code,brief:'x'}),/model=fleet\/claude-opus-5-5; effort=xhigh; Fast=off/);
// Browser default: Sol at medium, Fast on.
const browser=r.selectWorkerRoute({taskKind:'browser',catalog:{pi:catalog}});
assert.deepEqual(plain(browser),{role:'worker',source:'task-default',kind:'browser',model:'fleet/gpt-6.1-sol',effort:'medium',fastMode:true,pace:unread('codex'),reason:'browser default medium, no adjustment, no quota reading supplied'});
const browserReq=build({route:browser});
assert.equal(browserReq.request.provider,'pi/fleet/gpt-6.1-sol');assert.deepEqual(browserReq.request.settings,{thinkingOptionId:'medium'});
assert.equal(r.resolveAgentSurface('worker',{taskKind:'browser'},catalog).effort,'medium');
// An owner-named route wins; its Fast is the Pi Fast toggle label, never native fast_mode.
const owner={role:'worker',source:'owner-explicit',model:'gpt-6.1-sol',effort:'high',fastMode:true};
assert.deepEqual(plain(r.selectWorkerRoute({ownerRoute:owner,taskKind:'code',catalog})),owner);
const ownerSurface=r.resolveAgentSurface('worker',{explicitRoute:owner,taskKind:'code'},catalog);
assert.equal(ownerSurface.provider,'pi/fleet/gpt-6.1-sol');assert.equal(ownerSurface.effort,'high');
const ownerReq=build({route:owner});
assert.equal(ownerReq.request.provider,'pi/fleet/gpt-6.1-sol');assert.deepEqual(ownerReq.request.settings,{thinkingOptionId:'high'});
assert.equal(ownerReq.request.labels['opc.service-tier'],'fast');assert.equal(ownerReq.request.labels['opc.route-source'],'owner-explicit');
// Other kinds ask the owner; a missing label or thinking level stops the lane.
assert.throws(()=>r.selectWorkerRoute({catalog}),/ask the owner/);
assert.throws(()=>r.selectWorkerRoute({taskKind:'docs',catalog}),/ask the owner/);
assert.throws(()=>r.resolveAgentRoute('worker'),/ask the owner/);
assert.throws(()=>r.selectWorkerRoute({taskKind:'code',catalog:catalog.filter(row=>row.label!=='Opus')}),/catalog label Opus/);
assert.throws(()=>r.selectWorkerRoute({taskKind:'browser',catalog:catalog.map(row=>row.label==='Sol'?{...row,thinkingOptions:levels(['high'])}:row)}),/does not serve required thinking medium/);
assert.throws(()=>r.selectWorkerRoute({ownerRoute:code,catalog}),/source owner-explicit/);
// A recorded default cannot be edited or replayed against another catalog row.
assert.throws(()=>build({route:{...code,effort:'high'}}),/task-default route/);
assert.throws(()=>build({route:{...code,fastMode:true}}),/task-default route/);
assert.throws(()=>build({route:{...code,kind:'docs'}}),/task-default route/);
assert.throws(()=>build({route:{...code,model:'fleet/gpt-6.1-sol'}}),/match its Pi catalog label/);
// Native Workers fail without the owner's authorization and are allowed with it.
const unserved={role:'worker',source:'owner-explicit',model:'gpt-6.2-nova',effort:'high',fastMode:true};
assert.throws(()=>build({route:unserved}),/Pi catalog does not serve gpt-6.2-nova at high thinking; Workers run on Pi only/);
assert.throws(()=>build({route:owner,surface:'codex',capabilities:nativeCaps}),/explicit owner authorization/);
for(const provider of ['codex/gpt-6.1-sol','claude/claude-opus-5-5[1m]']){
 assert.throws(()=>build({provider,route:owner,capabilities:nativeCaps}),/explicit owner authorization/);
 for(const value of [true,'yes',{answer:'yes'}])assert.throws(()=>r.resolveWorkerSurface({provider,nativeAuthorization:value}),/explicit owner authorization/);
 const allowed=build({provider,route:owner,capabilities:nativeCaps,nativeAuthorization:'owner-explicit'});
 assert.equal(allowed.request.provider,provider);assert.equal(allowed.modeId,'full-access');
}
const nativeReq=build({route:owner,surface:'codex',capabilities:nativeCaps,nativeAuthorization:'owner-explicit'});
assert.equal(nativeReq.request.provider,'codex/gpt-6.1-sol');
assert.deepEqual(nativeReq.request.settings,{thinkingOptionId:'high',features:{fast_mode:true},modeId:'full-access'});
assert.equal(build({route:unserved,capabilities:nativeCaps,nativeAuthorization:'owner-explicit'}).request.provider,'codex/gpt-6.2-nova');
// Explicit Pi providers and fixed roles are not gated.
assert.equal(r.resolveWorkerSurface({provider:'pi/fleet/gpt-6.1-sol'}).provider,'pi/fleet/gpt-6.1-sol');
assert.equal(r.resolveWorkerSurface({provider:'codex/gpt-6-luna',role:'scout'}).provider,'codex/gpt-6-luna');
"""
        opc=ROOT/'skills/orchestration/opc/scripts'
        done=subprocess.run(['node','--input-type=module','-e',script,(opc/'agent-routing.mjs').as_uri(),(opc/'paseo-worker.mjs').as_uri()],capture_output=True,text=True)
        self.assertEqual(done.returncode,0,done.stderr)

    def test_native_cli_worker_requires_owner_authorization(self):
        script=r"""
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opc-native-')));const repo=path.join(base,'repo');const run=path.join(base,'run');fs.mkdirSync(repo);fs.mkdirSync(run);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
delete process.env.OPC_WORKER_CONTEXT;process.env.OPC_CODEX_BIN=path.join(base,'missing-codex');
try{
 git('init','-q','-b','main');git('config','user.name','Test');git('config','user.email','test@example.test');git('remote','add','origin','https://github.com/example/project.git');fs.writeFileSync(path.join(repo,'seed'),'seed');git('add','.');git('commit','-qm','seed');
 const state=await import(process.argv[1]);const worker=await import(process.argv[2]);const {taskPath,task}=state.createTask({workingDirectory:repo,runDirectory:run,owner:'test'});
 const route={role:'worker',source:'owner-explicit',model:'gpt-6.1-sol',effort:'high',fastMode:false};
 await assert.rejects(worker.launchWorker(taskPath,{prompt:'do it',route}),/explicit owner authorization/);
 await assert.rejects(worker.launchWorker(taskPath,{prompt:'do it',route,nativeAuthorization:'yes'}),/explicit owner authorization/);
 await assert.rejects(worker.launchWorker(taskPath,{prompt:'do it',route:{...route,source:'task-default',kind:'browser',effort:'medium'},nativeAuthorization:'owner-explicit'}),/owner-named route/);
 // Authorized launch passes the gate and stops only at the missing native executable.
 await assert.rejects(worker.launchWorker(taskPath,{prompt:'do it',route,nativeAuthorization:'owner-explicit'}),/native Codex executable unavailable/);
 assert.equal(state.readTask(taskPath).worker,null);
 const record={run_id:task.id,owner:'test',status:'finished',thread_id:'00000000-0000-4000-8000-000000000000',model:'gpt-6.1-sol',effort:'high',fast_mode:false,route_source:'owner-explicit',turns:[],error:null,cancel_requested:false,process:null};
 assert.throws(()=>state.updateTask(taskPath,current=>{current.worker={...record,native_authorization:'yes'};}),/invalid Worker record/);
 state.updateTask(taskPath,current=>{current.worker={...record};});
 await assert.rejects(worker.resumeWorker(taskPath,{prompt:'again'}),/explicit owner authorization/);
 state.updateTask(taskPath,current=>{current.worker.native_authorization='owner-explicit';});
 await assert.rejects(worker.resumeWorker(taskPath,{prompt:'again'}),/native Codex executable unavailable/);
 assert.throws(()=>state.updateTask(taskPath,current=>{delete current.worker.native_authorization;}),/immutable Worker native_authorization/);
}finally{fs.rmSync(base,{recursive:true,force:true});}
"""
        opc=ROOT/'skills/orchestration/opc/scripts'
        done=subprocess.run(['node','--input-type=module','-e',script,(opc/'task-state.mjs').as_uri(),(opc/'worker.mjs').as_uri()],capture_output=True,text=True)
        self.assertEqual(done.returncode,0,done.stderr)

    def test_shared_catalog_generates_models_and_picker_in_one_sync(self):
        import gzip,base64,os
        sys.path.insert(0,str(PI));sys.path.insert(0,str(PI.parent))
        from catalog import derive
        import paseo_providers
        source={'codex':{'models':[{'id':'backend-current','label':'Luna','isDefault':True,'thinkingOptions':[{'id':'max','label':'Max','isDefault':True}]}]},'claude':{'models':[{'id':'native[1m]','apiModelId':'backend-fable','label':'Fable','thinkingOptions':[{'id':'high','label':'High'}]}]}}
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);root=base/'pi';config=base/'config.json';config.write_text('{"agents":{"providers":{"codex":{"enabled":true}}},"daemon":{"agentProfiles":[{"id":"native","provider":"codex"}]}}')
            package=root/'app/node_modules/@earendil-works/pi-coding-agent/package.json';package.parent.mkdir(parents=True);package.write_text('{"version":"1.0.0"}')
            bin_dir=base/"bin";bin_dir.mkdir();paseo=bin_dir/"paseo";paseo.write_text("#!/bin/sh\necho '{\"daemonVersion\":\"0.10.3\",\"connectedDaemon\":\"reachable\"}'\n");paseo.chmod(0o755)
            pi={'root':str(root),'runtime':{'baseUrl':'https://router.example.test/v1','credential':{'kind':'env','name':'EXISTING_KEY'},'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'}}}
            cfg={'providers':source,'pi':pi}
            data=paseo_providers.payload(cfg,'example', 'test',False);data['config_path']=str(config)
            packed=base64.b64encode(gzip.compress(json.dumps(data).encode())).decode()
            env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH']}
            result=subprocess.run(['node',str(PI.parent/'paseo_providers_merge.js'),packed],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            picker=json.loads(config.read_text())['agents']['providers']['pi']['models'];models=json.loads((root/'agent/models.json').read_text())['providers']['fleet']['models']
            self.assertEqual([row['label'] for row in picker],[row['name'] for row in models])
            self.assertEqual([row['id'] for row in picker],['fleet/backend-fable','fleet/backend-current'])
            self.assertEqual(json.loads((root/'agent/settings.json').read_text())['defaultThinkingLevel'],'max')
            self.assertEqual(json.loads((root/'agent/settings.json').read_text())['defaultTools'],['+codemode'])
            self.assertEqual(json.loads(config.read_text())['daemon']['agentProfiles'],[{'id':'native','provider':'codex'}])
            source['codex']['models'][0]['id']='backend-next'
            churn=derive(source,pi);self.assertEqual(churn['catalog_model_id'],'fleet/backend-next')
            self.assertEqual(churn['runtime']['settings']['defaultModel'],'backend-next')

    def test_real_planner_builder_persists_pi_route_and_authorized_fallback(self):
        script=r"""
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-planner-')));const repo=path.join(base,'repo');const run=path.join(base,'run');fs.mkdirSync(repo);fs.mkdirSync(run);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
try{
 git('init','-q','-b','main');git('config','user.name','Test');git('config','user.email','test@example.test');git('remote','add','origin','https://github.com/example/project.git');fs.writeFileSync(path.join(repo,'seed'),'seed');git('add','.');git('commit','-qm','seed');
 const state=await import(process.argv[1]);const planner=await import(process.argv[2]);const {taskPath}=state.createTask({workingDirectory:repo,runDirectory:run,owner:'test'});
 const contextPack=Object.fromEntries(['outcome','scope','constraints','exploration','ambiguities','checks'].map(k=>[k,'test '+k]));
 const capabilities={enabled:true,status:'available',modes:[],models:[{id:'fleet/web-current',label:'Web Pro'},{id:'fleet/opus-current',label:'Opus',thinkingOptions:[{id:'xhigh'}]}]};
 const prepared=planner.preparePlannerLaunch(taskPath,{contextPack,capabilities});assert.equal(prepared.request.provider,'pi/fleet/web-current');assert.equal(prepared.request.settings.modeId,undefined);
 assert.equal(state.readTask(taskPath).planner.rounds[0].catalog_label,'Web Pro');
 planner.recordPlannerLaunchFailure(taskPath,{roundId:prepared.round.id,error:'controlled failure',terminal:true});
 assert.throws(()=>planner.preparePlannerLaunch(taskPath,{contextPack,capabilities}),/explicit owner yes/);
 planner.authorizePlannerFallback(taskPath,{answer:'yes'});
 const fallback=planner.preparePlannerLaunch(taskPath,{contextPack,capabilities});assert.equal(fallback.request.provider,'pi/fleet/opus-current');assert.equal(fallback.request.settings.thinkingOptionId,'xhigh');
 assert.equal(state.readTask(taskPath).planner.rounds[1].role,'planner_fallback');
}finally{fs.rmSync(base,{recursive:true,force:true});}
"""
        done=subprocess.run(['node','--input-type=module','-e',script,(ROOT/'skills/orchestration/opc/scripts/task-state.mjs').as_uri(),(ROOT/'skills/orchestration/opc/scripts/planner.mjs').as_uri()],capture_output=True,text=True)
        self.assertEqual(done.returncode,0,done.stderr)

    def test_runtime_uses_references_and_inherited_settings(self):
        sys.path.insert(0,str(PI))
        from configure import configure
        from credential import read_value
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)/'pi'
            key = Path(tmp)/'existing-key'; key.write_text('first-key')
            spec = {'baseUrl':'https://router.example.test/v1','credential':{'kind':'text','path':str(key)},
                    'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'},
                    'models':[{'id':'example-model','name':'Astra','reasoning':True,'input':['text'],'contextWindow':100000,'maxTokens':4096,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0}}],
                    'settings':{'defaultProvider':'fleet','defaultModel':'example-model','defaultThinkingLevel':'high'}}
            plan=configure(spec,root,True);self.assertTrue(plan['changed']);self.assertFalse(root.exists())
            configure(spec,root)
            self.assertEqual(json.loads((root/'agent/settings.json').read_text())['defaultThinkingLevel'],'high')
            self.assertEqual(json.loads((root/'agent/settings.json').read_text())['codemode'],{'mode':'on'})
            self.assertNotIn('first-key',''.join(p.read_text() for p in root.rglob('*') if p.is_file()))
            self.assertEqual(read_value(spec['credential']),'first-key');key.write_text('rotated-key')
            self.assertEqual(read_value(spec['credential']),'rotated-key')
            self.assertEqual(configure(spec,root)['changed'],[])
            spec['settings']['defaultThinkingLevel']='low';configure(spec,root)
            self.assertTrue(list((root/'agent').glob('settings.json.bak-*')))

    def test_mcp_inheritance_preserves_overrides_and_request(self):
        sys.path.insert(0,str(PI))
        from mcp_bridge import inherit,transform_list
        request={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'create_agent','arguments':{'title':'child','initialPrompt':'task'}}}
        got=inherit(request,'route/example-model','high')
        self.assertEqual(got['params']['arguments']['provider'],'pi/route/example-model')
        self.assertEqual(got['params']['arguments']['settings']['thinkingOptionId'],'high')
        self.assertNotIn('provider',request['params']['arguments'])
        request['params']['arguments']['provider']='codex/example-model'
        self.assertEqual(inherit(request,'route/other','low'),request)
        response={'result':{'tools':[{'name':'create_agent','inputSchema':{'required':['provider','title'],'properties':{'provider':{}}}}]}}
        self.assertEqual(transform_list(response)['result']['tools'][0]['inputSchema']['required'],['title'])

    def test_app_defaults_keep_other_preferences_and_roll_back(self):
        script=r'''
import assert from 'node:assert/strict';import vm from 'node:vm';
const {appDefaultsScript}=await import(process.argv[1]);
const key='@paseo:create-agent-preferences';const original=JSON.stringify({provider:'codex',isolation:'worktree',providerPreferences:{codex:{model:'example',thinkingByModel:{example:'high'},featureValues:{fast_mode:true}}}});
const data=new Map([[key,original]]);const localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
vm.runInNewContext(appDefaultsScript('route/example','high'),{localStorage});
const got=JSON.parse(data.get(key));assert.equal(got.provider,'pi');assert.equal(got.isolation,'worktree');assert.equal(got.providerPreferences.pi.thinkingByModel['route/example'],'high');assert.equal(got.providerPreferences.codex.model,'example');
vm.runInNewContext(appDefaultsScript('route/example','high',true),{localStorage});assert.equal(data.get(key),original);
'''
        done=subprocess.run(['node','--input-type=module','-e',script,(PI/'app-defaults.mjs').as_uri()],capture_output=True,text=True)
        self.assertEqual(done.returncode,0,done.stderr)

    def test_runtime_rejects_ancestor_symlink(self):
        sys.path.insert(0,str(PI))
        from configure import safe_target
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'root';root.mkdir()
            elsewhere=Path(tmp)/'elsewhere';elsewhere.mkdir()
            (root/'agent').symlink_to(elsewhere,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'symlink'):
                safe_target(root,root/'agent/settings.json')

    def test_windows_runtime_grants_the_user_sid_after_acl_backup(self):
        sys.path.insert(0,str(PI))
        import configure
        root=Path('/tmp/example-runtime')
        identity=subprocess.CompletedProcess([],0,stdout='"HOST\\person","S-1-5-21-100-200-300-1000"\n')
        with patch.object(configure.os,'name','nt'), patch.object(configure.subprocess,'run',return_value=identity) as run:
            configure.secure_windows_user(root)
            calls=run.call_args_list
            self.assertEqual(calls[0].args[0],['whoami','/user','/fo','csv','/nh'])
            self.assertIn('/save',calls[1].args[0])
            self.assertIn('*S-1-5-21-100-200-300-1000:(OI)(CI)F',calls[2].args[0])
            self.assertNotIn('Everyone',str(calls))
        with patch.object(configure.os,'name','nt'), patch.object(configure.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='"host","bad"')) as run:
            with self.assertRaisesRegex(ValueError,'SID unavailable'): configure.secure_windows_user(root)
            self.assertEqual(run.call_count,1)

    def test_catalog_only_emits_models_without_runtime_or_activation(self):
        import sys
        sys.path.insert(0, str(PI.parent))
        import paseo_providers as pp
        config={'providers': {'codex': {'models': [{'id':'example-sol','label':'Sol','isDefault':True}]}},
                'hosts': {'tablet': {'pi': {'catalogOnly':True, 'catalogSources':['codex']}}}}
        pp._pi(config['hosts']['tablet']['pi'], 'test')
        output=pp.payload(config,'tablet','stamp',True)
        self.assertIsNone(output['pi'])
        self.assertEqual(output['pi_files'],{})
        self.assertEqual(output['providers']['pi']['models'][0]['id'],'fleet/example-sol')
        self.assertEqual(set(output['providers']['pi']),{'models'})
        self.assertNotIn('pi',output['env'])
        with self.assertRaisesRegex(Exception,'cannot configure'):
            pp._pi({'catalogOnly':True,'root':'example'},'test')

    def test_windows_deployment_resolves_the_cmd_launcher(self):
        sys.path.insert(0,str(PI))
        import deploy
        with patch.object(deploy.os, 'name', 'nt'), patch.object(deploy.shutil, 'which', return_value='launcher.cmd') as find:
            self.assertEqual(deploy.paseo_command(), 'launcher.cmd')
            find.assert_called_once_with('paseo.cmd')
        with patch.object(deploy.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'CLI is unavailable'): deploy.paseo_command()

    def test_deploy_gate_apply_and_exact_rollback(self):
        sys.path.insert(0,str(PI))
        import deploy
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);home=base/'daemon';home.mkdir();root=base/'pi'
            original=b'{"agents":{"providers":{"codex":{"enabled":true}}}}\n'
            (home/'config.json').write_bytes(original)
            pkg=root/'app/node_modules/@earendil-works/pi-coding-agent/package.json'
            pkg.parent.mkdir(parents=True);pkg.write_text('{"version":"1.0.0"}')
            runtime={'baseUrl':'https://router.example.test/v1','credential':{'kind':'env','name':'ROUTE_KEY'},'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'},'models':[{'id':'example','name':'Astra'}],'settings':{'defaultProvider':'fleet','defaultModel':'example','defaultThinkingLevel':'high'}}
            spec=base/'proposal.json';spec.write_text(json.dumps({'root':str(root),'runtime':runtime,'provider':{'models':[{'id':'fleet/example','label':'Astra'}]},'catalog_model_id':'fleet/example'}))
            state=base/'state.json'
            with patch.object(deploy,'paseo_command',return_value='paseo'), patch.object(deploy.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='{"daemonVersion":"0.10.2","connectedDaemon":"reachable"}')):
                with self.assertRaisesRegex(ValueError,'0.10.3'):deploy.version_gate(home)
            status={'daemonVersion':'0.10.3','connectedDaemon':'reachable','home':str(home)}
            with patch.object(deploy,'version_gate',return_value=status),patch.object(sys,'argv',['deploy','apply','--spec',str(spec),'--state',str(state)]):deploy.main()
            self.assertTrue(json.loads((home/'config.json').read_text())['agents']['providers']['codex']['enabled'])
            record=json.loads(state.read_text())
            (home/'config.json').write_bytes(b'{}')
            with self.assertRaisesRegex(ValueError,'changed since apply'):deploy.restore(record,home,False)
            (home/'config.json').write_bytes(Path(record['backup']).read_bytes())
            deploy.restore(record,home,False)
            self.assertEqual((home/'config.json').read_bytes(),original)
            self.assertFalse((root/'agent/settings.json').exists())

    def test_app_default_carries_saved_or_catalog_route_and_refuses_unsupported(self):
        script=r"""
import assert from 'node:assert/strict';
const {carryPreferences}=await import(process.argv[1]);
const catalogs={codex:[{id:'example',isDefault:true,defaultThinkingOptionId:'high'}],pi:[{id:'route/example',thinkingOptions:[{id:'high'},{id:'medium'}]}]};
assert.deepEqual(carryPreferences({},catalogs),{modelId:'route/example',thinking:'high'});
assert.deepEqual(carryPreferences({provider:'codex',providerPreferences:{codex:{model:'example',thinkingByModel:{example:'medium'}}}},catalogs),{modelId:'route/example',thinking:'medium'});
assert.throws(()=>carryPreferences({provider:'claude'},catalogs));
assert.deepEqual(carryPreferences({provider:'claude'},{claude:[{id:'native[1m]',label:'Opus',defaultThinkingOptionId:'high'}],pi:[{id:'route/backend',label:'Opus',thinkingOptions:[{id:'high'}]}]}),{modelId:'route/backend',thinking:'high'});
"""
        done=subprocess.run(['node','--input-type=module','-e',script,(PI/'app-defaults.mjs').as_uri()],capture_output=True,text=True)
        self.assertEqual(done.returncode,0,done.stderr)

if __name__=='__main__':unittest.main()

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

    def test_all_role_and_worker_rules_preserve_model_and_thinking(self):
        script=r"""
import assert from 'node:assert/strict';
const after=await import(process.argv[1]);
// Historical rule choices before the surface change; scout now follows catalog churn.
const baseline={scout:{model:'gpt-5.6-luna',effort:'max',fastMode:true,label:'Luna'},planner:{model:'chatgpt-web/pro',effort:null,fastMode:false,label:'Web Pro'},reviewer:{model:'chatgpt-web/pro',effort:null,fastMode:false,label:'Web Pro'},planner_fallback:{model:'claude-fable-5-1[1m]',effort:'high',fastMode:false,label:'Fable'}};
const source=[['gpt-6-astra','Astra'],['gpt-6.1-sol','Sol'],['gpt-6-luna','Luna'],['chatgpt-web/extra-high','Web Extra'],['chatgpt-web/pro','Web Pro'],['claude-fable-5-1[1m]','Fable']].map(([id,label])=>({id,label,thinkingOptions:['low','medium','high','xhigh','max'].map(id=>({id}))}));
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
  const mapped=after.resolveAgentSurface('worker',{explicitRoute:route},catalog);
  assert.equal(mapped.model,before.model);assert.equal(mapped.effort,before.effort);assert.equal(mapped.fastMode,before.fastMode);
  const supports=catalog.find(row=>row.id==='route/'+model&&row.thinkingOptions.some(x=>x.id===effort));
  assert.equal(mapped.provider,supports?'pi/'+supports.id:'codex/'+model);
  assert.equal(after.resolveAgentSurface('worker',{explicitRoute:route},catalog,'codex').provider,'codex/'+model);count++;
 }
assert.equal(count,88);
assert.throws(()=>after.resolveCatalogLabel([{id:'a',label:'Luna'},{id:'b',label:'Luna'}],'Luna'),/exactly one/);
const next=catalog.map(row=>row.label==='Luna'?{...row,id:'route/new-catalog-id'}:row);
assert.equal(after.resolveAgentSurface('scout',{},next).model,'route/new-catalog-id');
"""
        done=subprocess.run(['node','--input-type=module','-e',script,(ROOT/'skills/orchestration/opc/scripts/agent-routing.mjs').as_uri()],capture_output=True,text=True)
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
 const capabilities={enabled:true,status:'available',modes:[],models:[{id:'fleet/web-current',label:'Web Pro'},{id:'fleet/fable-current',label:'Fable',thinkingOptions:[{id:'high'}]}]};
 const prepared=planner.preparePlannerLaunch(taskPath,{contextPack,capabilities});assert.equal(prepared.request.provider,'pi/fleet/web-current');assert.equal(prepared.request.settings.modeId,undefined);
 assert.equal(state.readTask(taskPath).planner.rounds[0].catalog_label,'Web Pro');
 planner.recordPlannerLaunchFailure(taskPath,{roundId:prepared.round.id,error:'controlled failure',terminal:true});
 assert.throws(()=>planner.preparePlannerLaunch(taskPath,{contextPack,capabilities}),/explicit owner yes/);
 planner.authorizePlannerFallback(taskPath,{answer:'yes'});
 const fallback=planner.preparePlannerLaunch(taskPath,{contextPack,capabilities});assert.equal(fallback.request.provider,'pi/fleet/fable-current');assert.equal(fallback.request.settings.thinkingOptionId,'high');
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

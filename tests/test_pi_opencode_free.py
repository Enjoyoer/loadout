import base64
import gzip
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'skills/orchestration/personal-skills/scripts'
PI = SCRIPTS / 'pi'
sys.path.insert(0, str(SCRIPTS))
import paseo_providers as providers


class NativeZenFreeTest(unittest.TestCase):
    def overlay(self):
        return json.loads((SCRIPTS.parent / 'fleet/example/opencode-free-overlay.json').read_text())

    def test_pinned_native_rows_do_not_enter_pi_catalog_or_change_existing_routes(self):
        overlay = self.overlay()
        providers._providers(overlay['providers'], 'fixture')
        self.assertEqual([(r['id'], r['label']) for r in overlay['providers']['opencode']['models']], [
            ('opencode/space-bunny-free', 'SBF'), ('opencode/muse-spark-1.3-contributor-free', 'MS')])
        source = {'codex': {'models': [{'id': 'existing-sol', 'label': 'Sol', 'isDefault': True}]},
                  'claude': {'models': [{'id': 'existing-opus', 'label': 'Opus'}]}}
        config = {'providers': source, 'hosts': {'approved': {
            'providers': overlay['providers'], 'pi': {'catalogOnly': True}}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'config.json'
            original = {'agents': {'providers': {'opencode': {
                'enabled': True, 'command': ['existing-opencode'], 'env': {'EXISTING_SETTING': 'unchanged'}},
                **source}}, 'daemon': {'agentProfiles': [{'id': 'existing', 'provider': 'codex'}]}}
            path.write_text(json.dumps(original))
            data = providers.payload(config, 'approved', 'fixture', False)
            self.assertNotIn('opencode', providers.payload(config, 'excluded', 'fixture', True)['providers'])
            self.assertIsNone(data['pi'])
            self.assertEqual(data['pi_files'], {})
            self.assertEqual([r['label'] for r in data['providers']['pi']['models']], ['Opus', 'Sol'])
            data['config_path'] = str(path)
            packed = base64.b64encode(gzip.compress(json.dumps(data).encode())).decode()
            done = subprocess.run(['node', str(SCRIPTS / 'paseo_providers_merge.js'), packed], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            merged = json.loads(path.read_text())
            native = merged['agents']['providers']['opencode']
            self.assertEqual(native['models'], overlay['providers']['opencode']['models'])
            for key in ['enabled', 'command', 'env']:
                self.assertEqual(native[key], original['agents']['providers']['opencode'][key])
            self.assertEqual(merged['agents']['providers']['codex'], source['codex'])
            self.assertEqual(merged['agents']['providers']['claude'], source['claude'])
            self.assertEqual(merged['daemon'], original['daemon'])

    def test_native_free_rows_reject_tiers_and_pi_catalog_opt_in(self):
        for tiers in [[], [{'id': 'priority'}]]:
            overlay = self.overlay()
            overlay['providers']['opencode']['models'][0]['service_tiers'] = tiers
            with self.assertRaisesRegex(ValueError, 'untiered'):
                providers._providers(overlay['providers'], 'fixture')
        for descriptor in [{'catalogOnly': True, 'catalogSources': ['opencode']},
                           {'root': 'fixture', 'runtime': {}, 'catalogSources': ['codex', 'opencode']}]:
            with self.assertRaisesRegex(ValueError, 'native opencode picker'):
                providers._pi(descriptor, 'fixture')

    def test_defensive_pi_hooks_refuse_fast_allow_standard_without_router_metadata(self):
        script = r'''
import assert from 'node:assert/strict';
const m=await import(process.argv[1]);
process.env.LOADOUT_PI_MCP_URL='http://fixture.invalid/mcp/agents';process.env.PASEO_AGENT_ID='fixture-agent';
for (const [id,api] of [['space-bunny-free','openai-completions'],['muse-spark-1.3-contributor-free','openai-responses']]) {
 const model={provider:'opencode',id,api,baseUrl:'https://opencode.ai/zen/v1'};
 const handlers={};m.default({on:(name,fn)=>handlers[name]=fn,getActiveTools:()=>['codemode'],getSettings:()=>({codemode:{mode:'on'}}),appendEntry:()=>{}});
 const ctx={model,cwd:'/fixture',sessionManager:{getSessionId:()=> 's'}};
 const payload={model:id,input:[],service_tier:'priority'};
 for (const tier of ['standard','fast','ultrafast']) {
  globalThis.fetch=async()=>({ok:true,headers:new Headers(),text:async()=>JSON.stringify({result:{structuredContent:{snapshot:{labels:{'opc.service-tier':tier}}}}})});
  await handlers.before_agent_start({},ctx);
  const prepared=handlers.before_provider_request({payload},ctx);
  if (tier==='standard') {
   assert.equal(prepared.model,id);assert.equal(prepared.service_tier,undefined);assert.equal(prepared.client_metadata,undefined);
   const event={headers:{}};handlers.before_provider_headers(event,ctx);assert.deepEqual(event.headers,{});
  } else assert(prepared.model.startsWith(m.BLOCKED_MODEL_PREFIX));
 }
 globalThis.fetch=async()=>{throw Error('fixture lookup failed')};
 await handlers.before_agent_start({},ctx);
 assert(handlers.before_provider_request({payload},ctx).model.startsWith(m.BLOCKED_MODEL_PREFIX));
 assert.equal(payload.service_tier,'priority');
}
'''
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI / 'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
import re
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path, PureWindowsPath

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
        keychain = {'kind': 'command', 'argv': ['/usr/bin/security', 'find-generic-password', '-s', 'example-gate', '-w']}
        authed = build({**spec, 'directProviders': {'local': {**direct['local'], 'auth': {'credential': keychain}}}}, root)
        key = authed['agent/models.json']['providers']['local']['apiKey']
        self.assertTrue(key.startswith('!') and key.endswith(' "' + str(root / 'runtime.json') + '" "directProviders" "local" "auth" "credential"'), key)
        self.assertEqual(authed['runtime.json']['directProviders']['local']['auth'], {'credential': keychain})
        secret = 'f' * 64
        bad_auth = [secret, 'Bearer ' + secret, {'credential': secret}, {'value': secret}, {'apiKey': secret},
                    {'credential': {'kind': 'env', 'name': 'GATE_TOKEN', 'value': secret}},
                    {'credential': {'kind': 'command', 'argv': ['/bin/echo', secret]}},
                    {'credential': {'kind': 'command', 'argv': ['/usr/bin/security', 'add-generic-password', '-w', secret]}},
                    {'credential': {'kind': 'command', 'argv': ['/usr/bin/python3', '-c', 'print(1)']}},
                    {'credential': {'kind': 'command', 'argv': ['security', 'find-generic-password', '-w']}},
                    {'credential': keychain, 'header': 'X-Api-Key'}, {'credential': {**keychain, 'prefix': 'Bearer '}},
                    {'credential': {'kind': 'keyring', 'name': 'GATE_TOKEN'}}]
        for bad in bad_auth:
            with self.assertRaisesRegex(ValueError, 'direct provider'):
                build({**spec, 'directProviders': {'local': {**direct['local'], 'auth': bad}}}, root)
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

    def test_max_tokens_sets_the_output_cap_per_label_including_api_entries(self):
        sys.path.insert(0, str(PI))
        from catalog import derive
        claude = [{'id': n, 'label': l, 'thinkingOptions': [{'id': 'high', 'label': 'High', 'isDefault': True}]} for n, l in [('o', 'Opus'), ('s', 'Sonnet')]]
        source = {'claude': {'models': claude}, 'codex': {'models': [{'id': 'c', 'label': 'Sol', 'isDefault': True, 'thinkingOptions': []}]}}
        runtime = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'}}
        pi = {'root': '/tmp/example-pi', 'runtime': runtime, 'claudeApiKeyRoute': {'prefix': 'api', 'labelSuffix': 'API'}}
        plain = derive(source, pi)
        self.assertEqual({m['maxTokens'] for m in plain['runtime']['models']}, {32768})
        self.assertEqual(derive(source, {**pi, 'maxTokens': {}}), plain)
        out = derive(source, {**pi, 'maxTokens': {'Opus': 65536}})
        self.assertEqual({m['name']: m['maxTokens'] for m in out['runtime']['models']}, {'Opus': 65536, 'Opus API': 65536, 'Sonnet': 32768, 'Sonnet API': 32768, 'Sol': 32768})
        self.assertEqual([{**m, 'maxTokens': 32768} for m in out['runtime']['models']], plain['runtime']['models'])
        for bad in [{'Local': 65536}, {'Opus API': 65536}, {'Opus': 0}, {'Opus': -1}, {'Opus': 65536.0}, {'Opus': '65536'}, {'Opus': True}, [65536]]:
            with self.assertRaisesRegex(ValueError, 'maxTokens'):
                derive(source, {**pi, 'maxTokens': bad})

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

    def launcher_root(self, tmp):
        """A configured launcher root with a stub Pi 1.0.0 CLI that prints its agent dir."""
        sys.path.insert(0, str(PI))
        from configure import build
        spec = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'},
                'models': [{'id': 'current', 'name': 'Sol', 'contextWindow': 272000}, {'id': 'other', 'name': 'Luna', 'contextWindow': 272000}],
                'paseoMcp': {'url': 'http://127.0.0.1:1/mcp/agents'},
                'settings': {'defaultProvider': 'fleet', 'defaultModel': 'current', 'defaultThinkingLevel': 'high'}}
        root = Path(tmp).resolve()  # the launcher checks settings against its own resolved path
        for name, data in build(spec, root).items():
            (root/name).parent.mkdir(parents=True, exist_ok=True); (root/name).write_text(json.dumps(data))
        for name in ['launch.mjs', 'fleet-routing.mjs', 'credential.py']:
            (root/name).write_bytes((PI/name).read_bytes())
        app = root/'app/node_modules/@earendil-works/pi-coding-agent'
        (app/'dist/bundle').mkdir(parents=True)
        (app/'package.json').write_text('{"version": "1.0.0"}')
        (app/'dist/bundle/cli.js').write_text('console.log(process.env.PI_CODING_AGENT_DIR)')
        return root

    def test_launcher_runs_a_paseo_probe_without_an_agent_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.launcher_root(tmp)
            # A daemon restarted from an agent shell hands that agent's id to its catalog probe.
            env = {**os.environ, 'PASEO_AGENT_ID': 'borrowed-agent-0001'}
            run = lambda *args: subprocess.run(['node', str(root/'launch.mjs'), *args], capture_output=True, text=True, env=env)
            probe = run('--mode', 'rpc')
            self.assertEqual(probe.returncode, 0, probe.stderr)
            self.assertTrue(os.path.samefile(probe.stdout.strip(), root/'agent'))
            self.assertFalse((root/'agents').exists())
            unresolved = run('--mode', 'rpc', '--extension', str(root/'x.mjs'))
            self.assertNotEqual(unresolved.returncode, 0)
            self.assertIn('concrete catalog model', unresolved.stderr)

    def test_launcher_merges_per_agent_overlays_over_the_shared_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.launcher_root(tmp)
            home = root/'agents/overlay-agent-0001'; home.mkdir(parents=True)
            user = root/'user'  # HOME, whose .agents/skills Pi also loads
            env = {**os.environ, 'PASEO_AGENT_ID': 'overlay-agent-0001', 'HOME': str(user)}
            run = lambda: subprocess.run(['node', str(root/'launch.mjs'), '--mode', 'rpc', '--model', 'fleet/current'], capture_output=True, text=True, env=env)
            shared = {name: (root/'agent'/name).read_bytes() for name in ('settings.json', 'models.json')}
            compaction = {'modelOverrides': {'fleet/current': {'reserveTokens': 40960}}}
            for skills, skill in [('agent/skills', 'kept'), ('agent/skills', 'dropped'), ('user/.agents/skills', 'user-dropped'),
                                  ('agent/skills', 'both'), ('user/.agents/skills', 'both')]:
                (root/skills/skill).mkdir(parents=True); (root/skills/skill/'SKILL.md').write_text(f'---\nname: {skill}\n---\n')
            (home/'settings.overlay.json').write_text(json.dumps({'compaction': compaction, 'skillsExclude': ['dropped', 'user-dropped']}))
            (home/'models.overlay.json').write_text(json.dumps({'providers': {'fleet': {'models': [{'id': 'current', 'contextWindow': 1000000}]}}}))
            done = run()
            self.assertEqual(done.returncode, 0, done.stderr)
            settings = json.loads((home/'settings.json').read_text())
            base = json.loads(shared['settings.json'])
            self.assertEqual(settings, {**base, 'compaction': compaction, 'skills': [
                *base['skills'], '-' + str(root/'agent/skills/dropped'), '-' + str(user/'.agents/skills/user-dropped')]})
            rows = json.loads((home/'models.json').read_text())['providers']['fleet']['models']
            self.assertEqual([(row['id'], row['contextWindow']) for row in rows], [('current', 1000000), ('other', 272000)])
            # A model not in the shared models.json, such as one retired from the catalog, is skipped with one warning line
            # in either overlay; that model keeps the shared values and a present model is still applied.
            warning = 'Pi launch: model override "fleet/retired" not in models.json, using default\n'
            (home/'settings.overlay.json').unlink()
            (home/'models.overlay.json').write_text(json.dumps({'providers': {'fleet': {'models': [
                {'id': 'retired', 'contextWindow': 5}, {'id': 'current', 'contextWindow': 1000000}]}}}))
            done = run()
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stderr, warning)
            models = json.loads(shared['models.json']); models['providers']['fleet']['models'][0]['contextWindow'] = 1000000
            self.assertEqual(json.loads((home/'models.json').read_text()), models)
            self.assertEqual((home/'settings.json').read_bytes(), shared['settings.json'])
            (home/'models.overlay.json').unlink()
            (home/'settings.overlay.json').write_text(json.dumps({'compaction': {'modelOverrides': {
                'fleet/retired': {'reserveTokens': 5}, 'fleet/current': {'reserveTokens': 40960}}}}))
            done = run()
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stderr, warning)
            self.assertEqual(json.loads((home/'settings.json').read_text()), {**base, 'compaction': compaction})
            self.assertEqual((home/'models.json').read_bytes(), shared['models.json'])
            (home/'settings.overlay.json').write_text(json.dumps({'compaction': {'modelOverrides': {'fleet/retired': {'reserveTokens': 5}}}}))
            done = run()
            self.assertEqual((done.returncode, done.stderr), (0, warning))
            self.assertEqual(json.loads((home/'settings.json').read_text()), base)
            # A name no root holds, such as a retired skill, is skipped with one warning line and the launch continues.
            (home/'settings.overlay.json').write_text(json.dumps({'skillsExclude': ['retired', 'dropped']}))
            done = run()
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stderr, 'Pi launch: skillsExclude skips "retired": no such skill is installed\n')
            self.assertEqual(json.loads((home/'settings.json').read_text())['skills'],
                             [*base['skills'], '-' + str(root/'agent/skills/dropped')])
            (home/'settings.overlay.json').write_text(json.dumps({'skillsExclude': ['retired']}))
            done = run()
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn('skips "retired"', done.stderr)
            self.assertEqual(json.loads((home/'settings.json').read_text()), base)
            (home/'settings.overlay.json').unlink()
            done = run()
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual({name: (home/name).read_bytes() for name in shared}, shared)
            # Only the allowlisted shape is accepted; a refused launch leaves the agent's files as they were.
            for name, overlay, error in [
                    ('settings', {'codemode': {'mode': 'off'}}, 'does not allow "codemode"'),
                    ('settings', {'packages': [{'source': str(root/'package'), 'extensions': ['index.ts']}]}, 'does not allow "packages"'),
                    ('settings', {'httpProxy': 'http://127.0.0.1:9'}, 'does not allow "httpProxy"'),
                    ('settings', {'skillsExclude': ['both']}, '"both" is ambiguous'),
                    ('settings', {'skillsExclude': ['../skills/kept']}, 'must be a skill directory name'),
                    ('settings', {'skillsExclude': []}, 'skillsExclude must be a non-empty list'),
                    ('models', {'providers': []}, 'providers must be a non-empty object'),
                    ('models', {'providers': {'fleet': {'models': [{'id': 'retired', 'contextWindow': 0}]}}}, 'must be a positive integer'),
                    ('models', {'providers': {'fleet': {'models': [{'id': 7, 'contextWindow': 5}]}}}, 'id must be a non-empty string'),
                    ('settings', {'compaction': {'modelOverrides': {'fleet/retired': {'window': 5}}}}, 'does not allow "window"'),
                    ('settings', {'compaction': {'modelOverrides': {'retired': {'reserveTokens': 5}}}}, 'must be "<provider>/<model id>"')]:
                for stale in home.glob('*.overlay.json'): stale.unlink()
                (home/f'{name}.overlay.json').write_text(json.dumps(overlay))
                refused = run()
                self.assertNotEqual(refused.returncode, 0)
                self.assertIn(error, refused.stderr)
                self.assertEqual({name: (home/name).read_bytes() for name in shared}, shared)

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
// No choice (absent or inherit) is an explicit Standard on a route whose catalog lists priority; Fast needs a label.
for(const labels of [{},{'opc.service-tier':'inherit'}])assert.deepEqual(D(R(labels),sol,cat),{status:'fleet-default-standard',wire:'default',header:'standard'});
for(const c of [[],null])assert.deepEqual(D(R({}),sol,c),{status:'inherited',header:'inherit'});
assert.deepEqual(D(R({}),opus,null),{status:'inherited',header:undefined});
assert.deepEqual(D(R({}),web,null),{status:'inherited',header:undefined});
assert.equal(D(R({'opc.service-tier':'ultrafast'}),sol,cat).status,'unsupported');
assert.equal(D(R({'opc.service-tier':'fast'}),sol,[]).status,'unsupported');
for(const t of ['standard','fast'])assert.deepEqual(D(R({'opc.service-tier':t}),opus,null),{status:'ignored-untiered'});
assert.deepEqual(D(R({'opc.service-tier':'standard'}),web,null),{status:'ignored-untiered'});
assert.equal(D(R({'opc.service-tier':'fast'}),sol,null).status,'explicit-unverified');
assert.equal(D(R({'opc.service-tier':'turbo'}),sol,cat).status,'invalid');
const base={model:'gpt-6.1-sol',input:[],reasoning:{effort:'medium'},service_tier:'priority'};
const ctx={model:sol,sessionId:'s',turnId:'t',cwd:'/w',requestId:'r1'};
assert.equal(m.preparePayload(base,{...ctx,tier:D(R({}),sol,cat)}).service_tier,'default');
const inherit=m.preparePayload(base,{...ctx,tier:D(R({}),sol,null)});
assert.equal('service_tier' in inherit,false);assert.equal(inherit.reasoning.effort,'medium');
assert.equal(inherit.client_metadata['x-fleet-request-id'],'r1');
assert.equal(m.preparePayload(base,{...ctx,tier:D(R({'opc.service-tier':'standard'}),sol,cat)}).service_tier,'default');
const webOut=m.preparePayload({model:'chatgpt-web/pro',input:[{role:'user',content:[]}]},{...ctx,model:web,cwd:'/home/someone/project'});
assert.deepEqual(Object.keys(JSON.parse(webOut.client_metadata['x-codex-turn-metadata']).workspaces),['/workspace/project']);
assert.equal(webOut.input[0].role,'user');assert.equal(webOut.input[0].internal_chat_message_metadata_passthrough.turn_id,'t');assert.equal(webOut.input[1].internal_chat_message_metadata_passthrough.turn_id,'t');
assert.match(webOut.input[0].content[0].text,/<cwd>\/workspace\/project<\/cwd>[\s\S]*<root>\/workspace\/project<\/root>/);assert.ok(!JSON.stringify(webOut).includes('someone'));
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

    @unittest.skipIf(os.name == "nt", "fake credential helper is a POSIX shell script")
    def test_credential_lend_covers_compaction_outside_and_across_runs(self):
        script=r"""
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(process.argv[1]));const dir=mkdtempSync(join(tmpdir(),'lend-'));
const helper=join(dir,'helper');const fail=join(dir,'fail');const calls=join(dir,'calls');
writeFileSync(helper,`#!/bin/sh\necho x >> "${calls}"\n[ -f "${fail}" ] && exit 1\necho synthetic-value\n`);chmodSync(helper,0o755);
const command=`!"${helper}" "${join(root,'credential.py')}" "${join(root,'runtime.json')}"`;
writeFileSync(join(dir,'models.json'),JSON.stringify({providers:{fleet:{apiKey:command,models:[]}}}));
process.env.PI_CODING_AGENT_DIR=dir;
const m=await import(process.argv[1]);m.CREDENTIAL.retryDelaysMs=[1,1];
const ctx={model:{provider:'fleet'}};
function boot(){const h={};const s={lent:false,registers:0};
 const pi={on:(e,f)=>h[e]=f,registerProvider:(name,cfg)=>{assert.equal(name,'fleet');assert.equal(cfg.apiKey,'synthetic-value');s.lent=true;s.registers++;},unregisterProvider:()=>{s.lent=false;}};
 m.default(pi);return {h,s};}
const compaction=reason=>({reason,signal:new AbortController().signal});
// Manual compaction outside a run: lent before it starts, withdrawn after it ends, on success and on failure.
for(const end of ['session_compact','session_compact_failed']){const {h,s}=boot();
 assert.equal(await h.session_before_compact(compaction('manual'),ctx),undefined);assert.equal(s.lent,true,end);
 await h[end]({reason:'manual'});assert.equal(s.lent,false,end);}
// A compaction during a run: its end leaves the run's lend in place.
{const {h,s}=boot();await h.turn_start({},ctx);assert.equal(s.lent,true);
 await h.session_before_compact(compaction('threshold'),ctx);await h.session_compact({reason:'threshold'});assert.equal(s.lent,true);
 await h.agent_end({});assert.equal(s.lent,false);}
// A run that ends during a compaction: the compaction keeps the lend until it ends.
{const {h,s}=boot();await h.turn_start({},ctx);await h.session_before_compact(compaction('overflow'),ctx);
 await h.agent_end({});assert.equal(s.lent,true);await h.session_compact_failed({reason:'overflow'});assert.equal(s.lent,false);}
// The helper failing every try: nothing is lent and the compaction goes ahead, so Pi runs its own command as today.
{writeFileSync(fail,'');rmSync(calls,{force:true});rmSync(join(dir,'route-evidence.jsonl'),{force:true});const {h,s}=boot();
 assert.equal(await h.session_before_compact(compaction('manual'),ctx),undefined);
 assert.equal(s.registers,0);assert.equal(s.lent,false);assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,3);
 const rows=readFileSync(join(dir,'route-evidence.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.at(-1),{event:'credential',provider:'fleet',status:'unavailable',tries:3});
 await h.session_compact_failed({reason:'manual'});assert.equal(s.lent,false);}
rmSync(dir,{recursive:true,force:true});
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipIf(os.name == "nt", "fake credential helper is a POSIX shell script")
    def test_credential_summary_lease_and_compact_failed_rows(self):
        script=r"""
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(process.argv[1]));const dir=mkdtempSync(join(tmpdir(),'lease-'));
const helper=join(dir,'helper');const slow=join(dir,'slow');const fail=join(dir,'fail');
writeFileSync(helper,`#!/bin/sh\n[ -f "${slow}" ] && sleep 1.5\n[ -f "${fail}" ] && exit 1\necho synthetic-value\n`);chmodSync(helper,0o755);
const command=`!"${helper}" "${join(root,'credential.py')}" "${join(root,'runtime.json')}"`;
writeFileSync(join(dir,'models.json'),JSON.stringify({providers:{fleet:{apiKey:command,models:[]}}}));
process.env.PI_CODING_AGENT_DIR=dir;
const m=await import(process.argv[1]);m.CREDENTIAL.retryDelaysMs=[1,1];m.CREDENTIAL.summaryLeaseMs=50;
const ctx={model:{provider:'fleet',id:'example'},thinkingLevel:'high',sessionManager:{getSessionId:()=> 'sess'}};
function boot(){const h={};const s={lent:false};
 const pi={on:(e,f)=>h[e]=f,registerProvider:()=>{s.lent=true;},unregisterProvider:()=>{s.lent=false;}};m.default(pi);return {h,s};}
const tree=controller=>({preparation:{userWantsSummary:true,entriesToSummarize:[{}]},signal:controller.signal});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// A branch summary that fails (no end event) does not leave the credential lent past its lease.
{const {h,s}=boot();await h.session_before_tree(tree(new AbortController()),ctx);assert.equal(s.lent,true);
 await wait(150);assert.equal(s.lent,false);}
// A cancelled branch summary withdraws at once.
{const {h,s}=boot();const c=new AbortController();await h.session_before_tree(tree(c),ctx);assert.equal(s.lent,true);
 c.abort();assert.equal(s.lent,false);}
// A prompt that starts and ends while the summary's refresh runs does not leave the summary unlent.
// Only the summary's read is slow: the run starts once that read is under way and ends before it returns.
{writeFileSync(slow,'');const {h,s}=boot();let read=false;const pending=h.session_before_tree(tree(new AbortController()),ctx).then(()=>{read=true;});
 await wait(300);rmSync(slow);await h.turn_start({},ctx);await h.agent_end({});assert.equal(read,false);
 await pending;assert.equal(s.lent,true);
 await wait(150);assert.equal(s.lent,false);}
const failedRows=()=>readFileSync(join(dir,'route-evidence.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.event==='compact_failed');
const row=(reason,extra)=>({event:'compact_failed',reason,aborted:false,errorKind:'upstream',httpStatus:null,sessionId:'sess',model:'example',thinking:'high',...extra});
const start=(h,reason,c=ctx)=>h.session_before_compact({reason,signal:new AbortController().signal},c);
// A summary that hit its token cap: errorKind token-cap and no text.
{rmSync(join(dir,'route-evidence.jsonl'),{force:true});const {h}=boot();await start(h,'manual');
 await h.session_compact_failed({reason:'manual',errorMessage:'Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete',aborted:false},ctx);
 assert.deepEqual(failedRows(),[row('manual',{errorKind:'token-cap'})]);}
// A 500 body echoing the key (as Bearer, raw and X-Api-Key style): upstream with its status, and no key in the file.
{rmSync(join(dir,'route-evidence.jsonl'),{force:true});const {h,s}=boot();await start(h,'manual');assert.equal(s.lent,true);
 const echo='Compaction failed: Summarization failed: 500: {"message":"router echo: auth=Bearer synthetic-value raw=synthetic-value key=synthetic-value"}';
 await h.session_compact_failed({reason:'manual',errorMessage:echo,aborted:false},ctx);assert.equal(s.lent,false);
 assert.deepEqual(failedRows(),[row('manual',{httpStatus:500})]);
 const text=readFileSync(join(dir,'route-evidence.jsonl'),'utf8');assert.ok(!text.includes('synth')&&!text.includes('echo'),text);}
// An aborted compaction: errorKind aborted.
{rmSync(join(dir,'route-evidence.jsonl'),{force:true});const {h}=boot();await start(h,'manual');
 await h.session_compact_failed({reason:'manual',errorMessage:undefined,aborted:true},ctx);
 assert.deepEqual(failedRows(),[row('manual',{aborted:true,errorKind:'aborted'})]);}
// Overlapping compactions on two providers, ending in either order: neither row carries any upstream text.
{rmSync(join(dir,'route-evidence.jsonl'),{force:true});const {h}=boot();await h.turn_start({},ctx);await h.agent_end({});
 const direct={...ctx,model:{provider:'direct',id:'other'}};
 await start(h,'threshold',direct);await start(h,'threshold',ctx);
 await h.session_compact_failed({reason:'threshold',errorMessage:'Auto-compaction failed: Summarization failed: 502: token=direct-key',aborted:false},ctx);
 await h.session_compact_failed({reason:'threshold',errorMessage:'Auto-compaction failed: Summarization failed: 500: key=synthetic-value',aborted:false},direct);
 assert.deepEqual(failedRows(),[row('threshold',{httpStatus:502}),row('threshold',{httpStatus:500,model:'other'})]);
 const text=readFileSync(join(dir,'route-evidence.jsonl'),'utf8');assert.ok(!text.includes('direct-key')&&!text.includes('synth'),text);}
rmSync(dir,{recursive:true,force:true});
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipIf(os.name == "nt", "fake credential helper is a POSIX shell script")
    def test_router_compaction_lowers_thinking_bounds_length_and_falls_back(self):
        script=r"""
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(process.argv[1]));const dir=mkdtempSync(join(tmpdir(),'fleet-compact-'));
const helper=join(dir,'helper');writeFileSync(helper,'#!/bin/sh\necho synthetic-value\n');chmodSync(helper,0o755);
const command=`!"${helper}" "${join(root,'credential.py')}" "${join(root,'runtime.json')}"`;
writeFileSync(join(dir,'models.json'),JSON.stringify({providers:{fleet:{apiKey:command,models:[]}}}));
process.env.PI_CODING_AGENT_DIR=dir;
const m=await import(process.argv[1]);m.CREDENTIAL.retryDelaysMs=[1,1];
let calls=[];let outcome;
m.COMPACTION.load=async()=>({VERSION:'1.0.0',compact:async(a,b,c,d,e,f,g,h,i,j,k,l)=>{calls.push([a,b,c,d,e,f,g,h,i,j,k,l]);return outcome();}});
const registry={getApiKeyAndHeaders:async()=>({ok:true,apiKey:'synthetic-value',headers:{}}),streamSimple:()=>{}};
const ctx=provider=>({model:{provider,id:'example',reasoning:true},thinkingLevel:'xhigh',modelRegistry:registry,sessionManager:{getSessionId:()=> 'sess'}});
const prep={firstKeptEntryId:'k',tokensBefore:9,messagesToSummarize:[],turnPrefixMessages:[],isSplitTurn:false,fileOps:{read:new Set(),written:new Set(),edited:new Set()},settings:{reserveTokens:16384}};
const event=extra=>({reason:'manual',preparation:prep,branchEntries:[],signal:new AbortController().signal,...extra});
function boot(){const h={};m.default({on:(e,f)=>h[e]=f,registerProvider:()=>{},unregisterProvider:()=>{}});return h;}
const rows=()=>{try{return readFileSync(join(dir,'route-evidence.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.event==='compact_failed');}catch{return [];}};
// A router model at xhigh: Pi's compact runs at the lower catalog level, with the bound after the user's /compact text.
{const h=boot();calls=[];const result={summary:'s',firstKeptEntryId:'k',tokensBefore:9,usage:{output:5}};outcome=()=>result;
 assert.deepEqual(await h.session_before_compact(event({customInstructions:'focus on X'}),ctx('fleet')),{compaction:result});
 assert.equal(calls.length,1);assert.equal(calls[0][6],'medium');
 assert.equal(calls[0][4],'focus on X\n\n'+m.COMPACTION.lengthBound);
 await h.session_compact({reason:'manual',fromExtension:true,compactionEntry:{summary:'s',usage:{output:5},tokensBefore:9}},ctx('fleet'));
 const done=readFileSync(join(dir,'route-evidence.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.event==='compact');
 assert.deepEqual(done,[{event:'compact',reason:'manual',fromExtension:true,sessionId:'sess',model:'example',thinking:'medium',outputTokens:5,summaryChars:1,tokensBefore:9}]);}
// Any failure returns nothing, so Pi's default compaction runs, and leaves a compact_failed row with no upstream text.
{rmSync(join(dir,'route-evidence.jsonl'),{force:true});const h=boot();calls=[];outcome=()=>{throw Error('Summarization failed: 502: key=synthetic-value');};
 assert.equal(await h.session_before_compact(event(),ctx('fleet')),undefined);assert.equal(calls.length,1);
 assert.deepEqual(rows(),[{event:'compact_failed',reason:'manual',aborted:false,errorKind:'upstream',httpStatus:502,sessionId:'sess',model:'example',thinking:'medium',fallback:'pi-default'}]);
 assert.ok(!readFileSync(join(dir,'route-evidence.jsonl'),'utf8').includes('synth'));}
// After a fleet summary, a fleet attempt that fails and falls back, and a switch to a direct provider, both hand Pi's
// default compaction the previous fleet summary's file lists, in Pi's own preparation.
for(const provider of ['fleet','direct']){const h=boot();outcome=()=>{throw Error('Summarization failed: 500: x');};
 const fileOps={read:new Set(['new.txt']),written:new Set(),edited:new Set()};const preparation={...prep,fileOps};
 const branchEntries=[{type:'compaction',fromHook:true,details:{readFiles:['a.txt'],modifiedFiles:['b.txt']}}];
 assert.equal(await h.session_before_compact(event({preparation,branchEntries}),ctx(provider)),undefined,provider);
 assert.equal(preparation.fileOps,fileOps,provider);
 assert.deepEqual([[...fileOps.read].sort(),[...fileOps.edited]],[['a.txt','new.txt'],['b.txt']],provider);}
// A non-router provider: Pi's own compaction, untouched.
{rmSync(join(dir,'route-evidence.jsonl'),{force:true});const h=boot();calls=[];
 assert.equal(await h.session_before_compact(event(),ctx('direct')),undefined);assert.equal(calls.length,0);assert.deepEqual(rows(),[]);}
rmSync(dir,{recursive:true,force:true});
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipIf(os.name == "nt", "fake credential helper is a POSIX shell script")
    def test_compaction_file_lists_keep_the_most_recent_paths(self):
        script=r"""
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(process.argv[1]));const dir=mkdtempSync(join(tmpdir(),'fleet-files-'));
const helper=join(dir,'helper');writeFileSync(helper,'#!/bin/sh\necho synthetic-value\n');chmodSync(helper,0o755);
writeFileSync(join(dir,'models.json'),JSON.stringify({providers:{fleet:{apiKey:`!"${helper}" "${join(root,'credential.py')}" "${join(root,'runtime.json')}"`,models:[]}}}));
process.env.PI_CODING_AGENT_DIR=dir;
const m=await import(process.argv[1]);m.CREDENTIAL.retryDelaysMs=[1,1];
const pad=n=>String(n).padStart(3,'0');
const old=Array.from({length:300},(_,i)=>`old/${pad(i)}.txt`), fresh=Array.from({length:20},(_,i)=>`new/${pad(i)}.txt`);
// The span reads the new paths, half by a direct tool call and half from a Codemode script; Pi's preparation holds them.
const span=()=>[{role:'assistant',content:fresh.slice(0,10).map(path=>({type:'toolCall',name:'read',arguments:{path}}))},
  {role:'toolResult',nestedCalls:{calls:fresh.slice(10).map(path=>({name:'read',arguments:{path}}))}}];
const prep=()=>({firstKeptEntryId:'k',tokensBefore:9,messagesToSummarize:span(),turnPrefixMessages:[],isSplitTurn:false,
  fileOps:{read:new Set(fresh),written:new Set(),edited:new Set()},settings:{reserveTokens:16384}});
const entries=fromHook=>[{type:'compaction',fromHook,details:{readFiles:old,modifiedFiles:[]}}];
const kept=[...old.slice(-80),...fresh];
// 300 previous and 20 new paths keep the 20 new and the newest 80 previous; maxFiles 0 keeps all.
for(const fromHook of [true,false]){const p=prep();const lists=m.mergeFileLists(p,entries(fromHook),100);
 assert.deepEqual(lists.readFiles,kept);assert.equal(lists.dropped,220);assert.deepEqual([...p.fileOps.read].sort(),[...kept].sort());}
{const p=prep();const lists=m.mergeFileLists(p,entries(true),0);assert.equal(lists.readFiles.length,320);assert.equal(lists.dropped,0);assert.equal(p.fileOps.read.size,320);}
// A fake compact() that appends Pi's own list block from the preparation, as Pi's does.
const block=ops=>{const read=[...ops.read].sort(),mod=[...new Set([...ops.edited,...ops.written])].sort(),parts=[];
 if(read.length)parts.push(`<read-files>\n${read.join('\n')}\n</read-files>`);if(mod.length)parts.push(`<modified-files>\n${mod.join('\n')}\n</modified-files>`);
 return parts.length?'\n\n'+parts.join('\n\n'):'';};
let fail=false;
// A split turn with nothing before it takes the previous summary verbatim as its history, as Pi's does.
m.COMPACTION.load=async()=>({VERSION:'1.0.0',compact:async(p,b,c,d,e,f,g,h,i,j,k,l)=>{if(fail)throw Error('Summarization failed: 500: x');
 const history=p.isSplitTurn&&!p.messagesToSummarize.length?p.previousSummary+'\n\n---\n\nTURN':'S';
 return {summary:history+block(p.fileOps),firstKeptEntryId:'k',tokensBefore:9,details:{readFiles:[],modifiedFiles:[]}};}});
const registry={getApiKeyAndHeaders:async()=>({ok:true,apiKey:'synthetic-value',headers:{}}),streamSimple:()=>{}};
const ctx=provider=>({model:{provider,id:'example',reasoning:true},thinkingLevel:'high',modelRegistry:registry,sessionManager:{getSessionId:()=> 'sess'}});
const h={};m.default({on:(e,f)=>h[e]=f,registerProvider:()=>{},unregisterProvider:()=>{}});
const run=(preparation,branchEntries,provider='fleet')=>h.session_before_compact({reason:'manual',preparation,branchEntries,signal:new AbortController().signal},ctx(provider));
const note=/\n\n\(220 older file paths were dropped; each list keeps the 100 most recent\.\)$/;
// The fleet summary keeps Pi's sorted block, says once how many were dropped, and stores the lists newest last.
{const p=prep();const {compaction}=await run(p,entries(true));
 assert.match(compaction.summary,note);assert.equal(compaction.summary.split('were dropped').length,2);
 assert.ok(compaction.summary.startsWith('S\n\n<read-files>\n'+[...kept].sort().join('\n')+'\n</read-files>'));
 assert.deepEqual(compaction.details,{readFiles:kept,modifiedFiles:[],filesOrder:'oldest-first'});}
// Nothing dropped: no line, and the summary is Pi's own.
{const p=prep();const {compaction}=await run(p,[]);assert.equal(compaction.summary,'S'+block({read:new Set(fresh),edited:new Set(),written:new Set()}));
 assert.ok(!compaction.summary.includes('dropped'));}
// A modified path counts once, in the modified list; a read of a modified path never fills the read list.
{const p=prep();p.messagesToSummarize.push({role:'assistant',content:[{type:'toolCall',name:'edit',arguments:{path:'old/299.txt'}}]});p.fileOps.edited.add('old/299.txt');
 const lists=m.mergeFileLists(p,entries(true),100);assert.deepEqual(lists.modifiedFiles,['old/299.txt']);assert.ok(!lists.readFiles.includes('old/299.txt'));
 assert.equal(lists.readFiles.length,100);assert.deepEqual(lists.readFiles.slice(-20),fresh);}
// A path modified long ago and read in this span stays, in exactly one list, the read list.
{const mods=['x/target.txt',...Array.from({length:99},(_,i)=>`m/${pad(i)}.txt`)],reads=Array.from({length:50},(_,i)=>`r-old/${pad(i)}.txt`);
 const p={...prep(),messagesToSummarize:[{role:'assistant',content:[{type:'toolCall',name:'read',arguments:{path:'x/target.txt'}},
  ...Array.from({length:5},(_,i)=>({type:'toolCall',name:'edit',arguments:{path:`n/${pad(i)}.txt`}}))]}],
  fileOps:{read:new Set(['x/target.txt']),written:new Set(),edited:new Set(Array.from({length:5},(_,i)=>`n/${pad(i)}.txt`))}};
 const lists=m.mergeFileLists(p,[{type:'compaction',fromHook:true,details:{readFiles:reads,modifiedFiles:mods,filesOrder:'oldest-first'}}],100);
 const both=[...lists.readFiles,...lists.modifiedFiles];assert.equal(both.filter(x=>x==='x/target.txt').length,1);
 assert.equal(lists.readFiles.at(-1),'x/target.txt');assert.equal(lists.modifiedFiles.length,100);assert.equal(lists.readFiles.length,51);
 assert.equal(new Set(both).size,both.length);assert.equal(lists.dropped,4);}
// Previous lists from a Pi default summary are sorted, so their order is not recency: the branch's calls decide. The
// 20 paths its span read (alphabetically first) and the 20 this span reads all stay.
{const zold=Array.from({length:300},(_,i)=>`z-old/${pad(i)}.txt`),anew=Array.from({length:20},(_,i)=>`a-new/${pad(i)}.txt`),
  mnew=Array.from({length:20},(_,i)=>`m-newer/${pad(i)}.txt`);
 const msg=paths=>({type:'message',message:{role:'assistant',content:paths.map(path=>({type:'toolCall',name:'read',arguments:{path}}))}});
 const saved=[...anew,...zold.slice(-80)].sort();
 const reads=paths=>({...prep(),messagesToSummarize:[msg(paths).message],fileOps:{read:new Set(paths),written:new Set(),edited:new Set()}});
 const branch=[msg(zold),msg(anew),{type:'compaction',fromHook:false,details:{readFiles:saved,modifiedFiles:[]}},msg(mnew)];
 const lists=m.mergeFileLists(reads(mnew),branch,100);
 const count=prefix=>lists.readFiles.filter(x=>x.startsWith(prefix)).length;
 assert.deepEqual([count('a-new/'),count('z-old/'),count('m-newer/')],[20,60,20]);assert.deepEqual(lists.readFiles.slice(-20),mnew);
 // Without the earlier calls in the branch, the 20 new paths still all stay.
 const bare=m.mergeFileLists(reads(fresh),[{type:'compaction',fromHook:false,details:{readFiles:old,modifiedFiles:[]}}],100);
 assert.deepEqual(bare.readFiles.slice(-20),fresh);}
// A split turn with nothing before it: one file block and one count line, at the end, with this compaction's count.
{const prevNote='\n\n(37 older file paths were dropped; each list keeps the 300 most recent.)';
 const prevSummary='PREV'+block({read:new Set(old),edited:new Set(),written:new Set()})+prevNote;
 const split=()=>({...prep(),isSplitTurn:true,messagesToSummarize:[],turnPrefixMessages:span(),previousSummary:prevSummary});
 const p=split();const {compaction}=await run(p,[{type:'compaction',fromHook:true,summary:prevSummary,details:{readFiles:old,modifiedFiles:[],filesOrder:'oldest-first'}}]);
 assert.equal(compaction.summary.split('older file path').length,2);assert.equal(compaction.summary.split('<read-files>').length,2);
 assert.match(compaction.summary,note);assert.ok(compaction.summary.startsWith('PREV\n\n---\n\nTURN\n\n<read-files>\n'));
 assert.equal(p.previousSummary,'PREV');}
// Pi's default compaction, after a failed fleet attempt or on a direct provider, gets the same bounded preparation.
fail=true;
for(const provider of ['fleet','direct']){const p=prep();assert.equal(await run(p,entries(true),provider),undefined,provider);
 assert.deepEqual([...p.fileOps.read].sort(),[...kept].sort(),provider);}
rmSync(dir,{recursive:true,force:true});
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_failed_compaction_writes_one_evidence_row(self):
        script=r"""
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'compact-'));process.env.PI_CODING_AGENT_DIR=dir;
const m=await import(process.argv[1]);const h={};m.default({on:(e,f)=>h[e]=f});
const ctx={model:{provider:'fleet',id:'example'},thinkingLevel:'high',sessionManager:{getSessionId:()=> 'sess'}};
await h.session_compact_failed({reason:'manual',errorMessage:'Compaction failed: '+'x'.repeat(400),aborted:false,willRetry:false,fromExtension:false},ctx);
const rows=readFileSync(join(dir,'route-evidence.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
assert.deepEqual(rows,[{event:'compact_failed',reason:'manual',aborted:false,errorKind:'upstream',httpStatus:null,sessionId:'sess',model:'example',thinking:'high'}]);
rmSync(dir,{recursive:true,force:true});
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_service_guard_refuses_shared_service_stops_and_allows_the_rest(self):
        # PM-specified cases (brief pi-service-guard): a forged instruction must not stop a shared fleet service.
        script=r"""
import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const g=await import(process.argv[1]);const f=await import(process.argv[2]);
const dir=mkdtempSync(join(tmpdir(),'guard-'));
writeFileSync(join(dir,'s.sh'),'#!/bin/sh\nlaunchctl bootout gui/501/com.example.model-bridge\n');
writeFileSync(join(dir,'fix.sh'),'#!/bin/sh\ncp new.plist old.plist\nlaunchctl bootout gui/501/com.example.model-bridge\nlaunchctl bootstrap gui/501 old.plist\nlaunchctl kickstart -k gui/501/com.example.model-bridge\ncurl -fsS http://127.0.0.1:1/health || cp backup.plist old.plist\n');
const lines={'12345':'node /tmp/unrelated-server.js','23456':'/opt/example-bridge/bin/example-bridge --serve'};
const opts={protectedServices:['com.example.model-bridge','example-router.service','example-bridge'],cwd:dir,
 resolvePid:async pid=>lines[pid]??'',listProcesses:async()=>[{pid:'1',command:'node /tmp/some-unrelated-test-server.js'}]};
const refused=['launchctl bootout gui/501/com.example.model-bridge','sudo launchctl unload ~/Library/LaunchAgents/com.example.model-bridge.plist',
 'bash -c "launchctl bootout gui/501/com.example.model-bridge"','pkill -f example-bridge','killall paseo','paseo daemon stop',
 'paseo --host ssh://x daemon restart','tailscale serve reset','systemctl --user stop example-router.service','bash s.sh','kill -9 -1',
 'kill 23456','echo "launchctl bootout com.example.model-bridge"'];
for(const c of refused){const v=await g.check(c,opts);assert.equal(v.block,true,c);assert.match(v.reason,/shared fleet service: use one detached nohup script/,c);}
const allowed=['launchctl list','launchctl print gui/501/com.example.model-bridge','kill 12345','pkill -f some-unrelated-test-server',
 'nohup bash fix.sh >log 2>&1 &','grep bootout notes.md','echo "launchctl bootout x"'];
for(const c of allowed)assert.equal((await g.check(c,opts)).block,false,c);
// The same repair script run in the foreground is refused.
assert.equal((await g.check('bash fix.sh',opts)).block,true);
// Config: a missing or invalid list keeps the defaults and warns; a valid one adds to them.
assert.ok(g.guardConfig({}).warning);assert.ok(g.guardConfig({guard:{protectedServices:'x'}}).warning);
assert.deepEqual(g.guardConfig({guard:{protectedServices:['com.example.model-bridge']}}).protectedServices,[...g.DEFAULT_PROTECTED,'com.example.model-bridge']);
// Pi handler: blocks with the reason and records evidence without env values.
const rows=[];const h=f.serviceGuardHandler(r=>rows.push(r),{guard:g.serviceGuard(opts)});
const out=await h({toolName:'bash',input:{command:'TOKEN=secret-value launchctl bootout gui/501/com.example.model-bridge'}},{cwd:dir});
assert.equal(out.block,true);assert.equal(rows[0].event,'service-guard');assert.ok(!JSON.stringify(rows).includes('secret-value'));
assert.equal(await h({toolName:'bash',input:{command:'launchctl list'}},{cwd:dir}),undefined);
"""
        done = subprocess.run(['node', '--input-type=module', '-e', script, (PI/'service-guard.mjs').as_uri(), (PI/'fleet-routing.mjs').as_uri()], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        hook = lambda payload: subprocess.run(['node', str(PI/'service-guard.mjs')], input=json.dumps(payload), capture_output=True, text=True)
        blocked = hook({'tool_name': 'Bash', 'tool_input': {'command': 'paseo daemon stop'}})
        self.assertEqual(blocked.returncode, 2, blocked.stderr); self.assertIn('fleet service guard', blocked.stderr)
        self.assertEqual(hook({'command': 'launchctl list'}).returncode, 0)

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
// explicit Standard or Fast left on a Claude route is ignored: no refusal, no tier sent
for(const t of ['standard','fast']){const r=await turn(boot(),opus,'labels',{'opc.service-tier':t});assert.ok(!refused(r.p),t);assert.equal(r.p.service_tier,undefined);assert.equal(r.hd['X-Fleet-Service-Tier'],undefined);}
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
// Owner-approved fixed roles follow catalog labels.
const baseline={scout:{model:'gpt-6.1-sol',effort:'xhigh',fastMode:true,label:'Sol'},reviewer:{model:'chatgpt-web/pro',effort:null,fastMode:false,label:'Web Pro'}};
const source=[['gpt-6-astra','Astra'],['gpt-6.1-sol','Sol'],['gpt-6-luna','Luna'],['chatgpt-web/extra-high','Web Extra'],['chatgpt-web/pro','Web Pro'],['claude-fable-5-1[1m]','Fable'],['claude-opus-5-5[1m]','Opus']].map(([id,label])=>({id,label,thinkingOptions:['low','medium','high','xhigh','max'].map(id=>({id}))}));
const catalog=source.map(row=>({...row,id:'route/'+row.id}));
let count=0;
for(const [role,before] of Object.entries(baseline)){
 const options={};
 const mapped=after.resolveAgentSurface(role,options,catalog);
 assert.equal(mapped.model,after.resolveCatalogLabel(catalog,before.label).id);
 assert.equal(mapped.effort,before.effort);assert.equal(mapped.fastMode,before.fastMode);
 assert(mapped.model.endsWith('/'+before.model));
 assert.equal(mapped.provider,'pi/'+mapped.model);
 const built=after.resolveWorkerSurface({role,route:after.FIXED_ROLE_ROUTES[role],catalog});assert.equal(built.provider,mapped.provider);
 assert.throws(()=>after.resolveAgentSurface(role,options,[]),/catalog label/);
 count++;
}
for(const model of ['gpt-6-astra','gpt-6.1-sol','gpt-6-luna','gpt-5.6-luna','chatgpt-web/extra-high','chatgpt-web/pro','claude-opus-5-5[1m]'])
 for(const effort of ['low','medium','high','xhigh','max','ultra'])for(const fastMode of [true,false]){
  const route={role:'worker',source:'owner-explicit',model,effort,fastMode};
  if(model.startsWith('chatgpt-web/')){
   assert.throws(()=>after.resolveAgentRoute('worker',{explicitRoute:route}),/reviewer-only/);continue;
  }
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
assert.equal(count,62);
assert.throws(()=>after.resolveCatalogLabel([{id:'a',label:'Sol'},{id:'b',label:'Sol'}],'Sol'),/exactly one/);
const next=catalog.map(row=>row.label==='Sol'?{...row,id:'route/new-catalog-id'}:row);
assert.equal(after.resolveAgentSurface('scout',{},next).model,'route/new-catalog-id');
"""
        done=subprocess.run(['node','--input-type=module','-e',script,(ROOT/'skills/orchestration/opc/scripts/agent-routing.mjs').as_uri()],capture_output=True,text=True)
        self.assertEqual(done.returncode,0,done.stderr)

    def test_worker_task_defaults_owner_precedence_and_native_gate(self):
        script=r"""
import assert from 'node:assert/strict';
const r=await import(process.argv[1]);const w=await import(process.argv[2]);
const levels=ids=>ids.map(id=>({id}));
const catalog=[['claude-opus-5-5','Opus'],['claude-fable-5-1','Fable'],['gpt-6.1-sol','Sol'],['gpt-6-luna','Luna'],['gpt-6-astra','Astra'],['chatgpt-web/pro','Web Pro']]
 .map(([id,label])=>({id:'fleet/'+id,label,thinkingOptions:levels(['low','medium','high','xhigh','max'])}));
const piCaps={enabled:true,status:'available',modes:[],models:catalog};
const nativeCaps={enabled:true,status:'available',modes:[{id:'full-access',isUnattended:true}],models:catalog};
const workspace={workspaceId:'wks-example',cwd:'/tmp/example-worktree'};
const build=extra=>w.buildManagedWorkerRequest({taskId:'task-0001-example',lane:'lane',title:'Worker',initialPrompt:'Do it',workspace,capabilities:piCaps,...extra});
const plain=value=>JSON.parse(JSON.stringify(value));
const unread=pool=>({pool,step:0,weekly:null,stale:'no quota reading supplied',gapPct:null,fiveHourUsedPct:null,resetSoon:null,accounts:null,staleAccounts:null,ageSeconds:null});
// Owner-approved task routes, including all GPT lanes with Fast on.
assert.deepEqual([...Object.keys(r.WORKER_DEFAULT_ROUTES),...Object.keys(r.OWNER_RULE_ROUTES)].sort(),['browser','browser-hard','code','plan','review','review-security','smoke','ui-check','ui-design','watcher']);
for(const [kind,label,effort,fastMode] of [['code','Opus','medium',false],['plan','Sol','xhigh',true],['review','Sol','xhigh',true],['review-security','Opus','xhigh',false],['smoke','Luna','low',true],['browser','Sol','medium',true],['browser-hard','Astra','medium',true],['ui-design','Fable','high',false],['ui-check','Fable','high',false],['watcher','Luna','xhigh',true]]){
 const route=r.selectWorkerRoute({taskKind:kind,catalog});
 assert.equal(route.model,['browser','browser-hard'].includes(kind)?r.resolveCatalogLabel(catalog,label).id.slice(6):r.resolveCatalogLabel(catalog,label).id);assert.equal(route.effort,effort);assert.equal(route.fastMode,fastMode);
}
for(const [alias,kind] of Object.entries(r.WORKER_CLASS_ALIASES)){
 const route=r.selectWorkerRoute({taskKind:alias,catalog});
 assert.deepEqual(route,r.selectWorkerRoute({taskKind:kind,catalog}));assert.match(route.reason,new RegExp('^'+kind+' '));
 const recorded={...route,kind:alias};
 r.validateLaneClass(recorded,kind,catalog);
 const task={routes:{lane:{route:recorded}}};
 assert.equal(r.resolveWorkerSurface({route:recorded,task,lane:'lane',taskClass:alias,catalog}).provider,'pi/'+route.model);
 assert.match(r.buildDelegatedBrief({role:'worker',route:recorded,task,lane:'lane',taskClass:alias,catalog,brief:'x'}),new RegExp('route: '+kind));
}
// Worker defaults are frozen.
assert(Object.isFrozen(r.WORKER_DEFAULT_ROUTES)&&Object.isFrozen(r.WORKER_DEFAULT_ROUTES.code)&&Object.isFrozen(r.WORKER_DEFAULT_ROUTES.browser));
// Code default: Opus at medium (owner rule for local lanes), Fast off, on Pi, recorded as a task default.
const code=r.selectWorkerRoute({taskKind:'code',catalog});
assert.deepEqual(plain(code),{role:'worker',source:'task-default',kind:'code',model:'fleet/claude-opus-5-5',effort:'medium',fastMode:false,pace:unread('claude'),reason:'code default medium, no adjustment, no quota reading supplied'});
const codeReq=build({route:code});
assert.equal(codeReq.request.provider,'pi/fleet/claude-opus-5-5');assert.deepEqual(codeReq.request.settings,{thinkingOptionId:'medium'});
assert.equal(codeReq.request.labels['opc.route-source'],'task-default');
for(const key of ['opc.service-tier','opc.fast-requested'])assert.equal(key in codeReq.request.labels,false);
assert.equal(r.resolveAgentSurface('worker',{taskKind:'code'},catalog).provider,'pi/fleet/claude-opus-5-5');
assert.match(r.buildDelegatedBrief({role:'worker',route:code,brief:'x'}),/model=fleet\/claude-opus-5-5; effort=medium; Fast=off/);
// Browser default: Sol at medium, Fast on.
const browser=r.selectWorkerRoute({taskKind:'browser',catalog:{pi:catalog}});
assert.deepEqual(plain(browser),{role:'worker',source:'task-default',kind:'browser',model:'gpt-6.1-sol',effort:'medium',fastMode:true,pace:unread('codex'),reason:'browser default medium, no adjustment, no quota reading supplied, native Codex authorized by owner 2026-10-14'});
const browserReq=build({route:browser,capabilities:nativeCaps});
assert.equal(browserReq.request.provider,'codex/gpt-6.1-sol');assert.deepEqual(browserReq.request.settings,{thinkingOptionId:'medium',features:{fast_mode:true},modeId:'full-access'});
assert.equal(r.resolveAgentSurface('worker',{taskKind:'browser'},catalog).effort,'medium');
// An owner-named route wins; its Fast is the Pi Fast toggle label, never native fast_mode.
const owner={role:'worker',source:'owner-explicit',model:'gpt-6.1-sol',effort:'high',fastMode:true};
assert.deepEqual(plain(r.selectWorkerRoute({ownerRoute:owner,taskKind:'code',catalog})),owner);
const ownerSurface=r.resolveAgentSurface('worker',{explicitRoute:owner,taskKind:'code'},catalog);
assert.equal(ownerSurface.provider,'pi/fleet/gpt-6.1-sol');assert.equal(ownerSurface.effort,'high');
const ownerReq=build({route:owner});
assert.equal(ownerReq.request.provider,'pi/fleet/gpt-6.1-sol');assert.deepEqual(ownerReq.request.settings,{thinkingOptionId:'high'});
assert.equal(ownerReq.request.labels['opc.service-tier'],'fast');assert.equal(ownerReq.request.labels['opc.route-source'],'owner-explicit');
// Fast off on a GPT route is an explicit Standard, independent of the fleet default.
assert.equal(build({route:{...owner,fastMode:false}}).request.labels['opc.service-tier'],'standard');
// Other kinds ask the owner; a missing label or thinking level stops the lane.
assert.throws(()=>r.selectWorkerRoute({catalog}),/ask the owner/);
assert.throws(()=>r.selectWorkerRoute({taskKind:'docs',catalog}),/ask the owner/);
assert.throws(()=>r.resolveAgentRoute('worker'),/ask the owner/);
assert.throws(()=>r.selectWorkerRoute({taskKind:'code',catalog:catalog.filter(row=>row.label!=='Opus')}),/catalog label Opus/);
assert.throws(()=>r.selectWorkerRoute({taskKind:'browser',catalog:catalog.map(row=>row.label==='Sol'?{...row,thinkingOptions:levels(['high'])}:row)}),/does not serve required thinking medium/);
assert.throws(()=>r.selectWorkerRoute({ownerRoute:code,catalog}),/source owner-explicit/);
// A recorded default cannot be edited or replayed against another catalog row.
assert.throws(()=>build({route:{...code,effort:'xhigh'}}),/task-default route/);
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

    @unittest.skipIf(os.name == "nt", "fake paseo is a POSIX shell script")
    def test_shared_catalog_generates_models_and_picker_in_one_sync(self):
        import gzip,base64,os
        sys.path.insert(0,str(PI));sys.path.insert(0,str(PI.parent))
        from catalog import derive
        import paseo_providers
        source={'codex':{'models':[{'id':'backend-current','label':'Luna','isDefault':True,'thinkingOptions':[{'id':'max','label':'Max','isDefault':True}]}]},'claude':{'models':[{'id':'native[1m]','apiModelId':'backend-fable','label':'Fable','thinkingOptions':[{'id':'high','label':'High'}]}]}}
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);root=base/'pi';config=base/'config.json';config.write_text('{"agents":{"providers":{"codex":{"enabled":true}}},"daemon":{"agentProfiles":[{"id":"native","provider":"codex"}]}}')
            package=root/'app/node_modules/@earendil-works/pi-coding-agent/package.json';package.parent.mkdir(parents=True);package.write_text('{"version":"1.0.0"}')
            bin_dir=base/"bin";bin_dir.mkdir();paseo=bin_dir/"paseo";paseo.write_text("#!/bin/sh\necho '{\"daemonVersion\":\"0.15.3\",\"connectedDaemon\":\"reachable\"}'\n");paseo.chmod(0o755)
            pi={'root':str(root),'runtime':{'baseUrl':'https://router.example.test/v1','credential':{'kind':'env','name':'EXISTING_KEY'},'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'}}}
            cfg={'providers':source,'pi':pi}
            data=paseo_providers.payload(cfg,'example', 'test',False);data['config_path']=str(config)
            packed=base64.b64encode(gzip.compress(json.dumps(data).encode())).decode()
            env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH']}
            # As shipped: remote_common.js ahead of the merge program.
            program=base/'merge.js';program.write_text((PI.parent/'remote_common.js').read_text()+'\n'+(PI.parent/'paseo_providers_merge.js').read_text())
            result=subprocess.run(['node',str(program),packed],env=env,capture_output=True,text=True)
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

    def pi_merge_fixture(self, base):
        """A Pi provider catalog, an installed Pi package and a stock daemon on PATH; returns (catalog, run)."""
        sys.path.insert(0,str(PI));sys.path.insert(0,str(PI.parent))
        import gzip,base64,paseo_providers
        package=base/'pi/app/node_modules/@earendil-works/pi-coding-agent/package.json';package.parent.mkdir(parents=True);package.write_text('{"version":"1.0.0"}')
        bin_dir=base/'bin';bin_dir.mkdir();paseo=bin_dir/'paseo';paseo.write_text("#!/bin/sh\necho '{\"daemonVersion\":\"0.15.3\",\"connectedDaemon\":\"reachable\"}'\n");paseo.chmod(0o755)
        source={'codex':{'models':[{'id':'backend-current','label':'Luna','isDefault':True,'thinkingOptions':[{'id':'max','label':'Max','isDefault':True}]}]}}
        pi={'root':str(base/'pi'),'runtime':{'baseUrl':'https://router.example.test/v1','credential':{'kind':'env','name':'EXISTING_KEY'},'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'}}}
        env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH']}
        # As shipped: remote_common.js ahead of the merge program.
        program=base/'merge.js';program.write_text((PI.parent/'remote_common.js').read_text()+'\n'+(PI.parent/'paseo_providers_merge.js').read_text())
        def run(catalog,platform=None):
            data=paseo_providers.payload(catalog,'example','test',False);data['config_path']=str(base/'config.json')
            packed=base64.b64encode(gzip.compress(json.dumps(data).encode())).decode()
            # A platform stand-in, for a merge step that runs only on one OS.
            fake=['--require',str(base/'platform.js')] if platform else []
            if platform: (base/'platform.js').write_text(f"Object.defineProperty(process,'platform',{{value:{json.dumps(platform)}}});")
            done=subprocess.run(['node',*fake,str(program),packed],env=env,capture_output=True,text=True)
            return paseo_providers.parse_result(done.stdout) or {'error':done.stdout+done.stderr}
        return {'providers':source,'pi':pi}, run

    @unittest.skipIf(os.name == "nt", "fake paseo is a POSIX shell script")
    def test_pi_runtime_waits_for_a_valid_config_and_every_runtime_write_owes_a_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);config=base/'config.json';config.write_text('{"agents":{"providers":{}}}')
            catalog,run=self.pi_merge_fixture(base)
            runtime=base/'pi/runtime.json'
            # A required provider env is missing: the host fails before anything on it changes.
            catalog['hosts']={'example':{'required_env':{'codex':['EXAMPLE_BASE_URL']}}}
            got=run(catalog)
            self.assertEqual(got['error'],'required env missing: codex.EXAMPLE_BASE_URL')
            self.assertFalse(got['wrote'])
            self.assertFalse(runtime.exists())
            self.assertEqual(config.read_text(),'{"agents":{"providers":{}}}')
            catalog['env']={'codex':{'EXAMPLE_BASE_URL':'https://router.example.test'}}
            got=run(catalog)
            self.assertEqual((got['error'],got['wrote']),(None,True))
            self.assertTrue(runtime.exists())
            # A runtime-only change leaves config.json alone but still counts as a write, so a reload is owed.
            catalog['pi']['runtime']['paseoMcp']['url']='http://127.0.0.1:6768/mcp/agents'
            got=run(catalog)
            self.assertEqual((got['error'],got['changed'],got['wrote'],got['backup']),(None,True,True,None))
            self.assertEqual(got['pi']['changed'],['runtime.json'])
            # A configure run that fails may have written some files: it counts as a write too.
            fail=base/'fail-python';fail.write_text('#!/bin/sh\nexit 1\n');fail.chmod(0o755)
            catalog['pi']['runtime']['python']=str(fail)
            got=run(catalog)
            self.assertEqual(got['error'],'Pi runtime configuration failed; runtime files may have changed')
            self.assertTrue(got['wrote'])

    @unittest.skipIf(os.name == "nt", "fake paseo is a POSIX shell script")
    def test_a_config_change_during_the_pi_runtime_step_is_merged_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);config=base/'config.json';config.write_text('{"agents":{"providers":{}}}')
            catalog,run=self.pi_merge_fixture(base)
            # The daemon saves a host-local setting while the Pi runtime is being configured.
            python=base/'python-and-daemon-write'
            python.write_text(f'#!/bin/sh\n"{sys.executable}" -c "import json,sys; c=json.load(open(sys.argv[1])); '
                              f'c[\'daemon\']={{\'port\':4321}}; json.dump(c,open(sys.argv[1],\'w\'))" "{config}"\n'
                              f'exec "{sys.executable}" "$@"\n')
            python.chmod(0o755)
            catalog['pi']['runtime']['python']=str(python)
            got=run(catalog)
            self.assertEqual((got['error'],got['wrote']),(None,True))
            after=json.loads(config.read_text())
            self.assertEqual(after['daemon'],{'port':4321})
            self.assertEqual([row['label'] for row in after['agents']['providers']['pi']['models']],['Luna'])
            # The backup is the revision the write replaced, the daemon's change included.
            self.assertEqual(json.loads((base/got['backup']).read_text())['daemon'],{'port':4321})

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
            helper = Path(tmp)/'token-helper.py'; helper.write_text('import pathlib,sys\nprint(pathlib.Path(sys.argv[2]).read_text())\n')
            command = {'kind':'command','argv':[sys.executable,str(helper),'print',str(key)]}
            self.assertEqual(read_value(command),'rotated-key')
            for broken in ['', 'two\nlines']:
                key.write_text(broken)
                with self.assertRaisesRegex(ValueError,'invalid host credential'): read_value(command)
            with self.assertRaisesRegex(ValueError,'credential helper failed'): read_value({**command,'argv':[*command['argv'][:3],str(Path(tmp)/'missing')]})
            key.write_text('rotated-key')
            self.assertEqual(configure(spec,root)['changed'],[])
            spec['settings']['defaultThinkingLevel']='low';configure(spec,root)
            self.assertTrue(list((root/'agent').glob('settings.json.bak-*')))

    def pruned_runtime(self, tmp, level='low', dry_run=False, extra=(), link=None, others=()):
        """Configure a runtime, seed seven settings.json backups (2026-01-01 to 01-07, the oldest stamp with the newest
        mtime), extra hand-made files, an optional symlink, and other files' backups, then change one setting."""
        sys.path.insert(0,str(PI))
        from configure import configure
        root = Path(tmp)/'pi'; key = Path(tmp)/'key'; key.write_text('k')
        spec = {'baseUrl':'https://router.example.test/v1','credential':{'kind':'text','path':str(key)},
                'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'},
                'models':[{'id':'example-model','name':'Astra','reasoning':True,'input':['text'],'contextWindow':100000,'maxTokens':4096,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0}}],
                'settings':{'defaultProvider':'fleet','defaultModel':'example-model','defaultThinkingLevel':'high'}}
        configure(spec,root)
        agent = root/'agent'
        seeded = [f'settings.json.bak-2026010{d}T000000000000Z' for d in range(1,8)]
        for age,name in enumerate(seeded + [f'{o}.bak-2026010{d}T000000000000Z' for o in others for d in range(1,8)]):
            (agent/name).write_text(name); os.utime(agent/name,(1e9+1000*(20-age),)*2)
        for name in extra: (agent/name).write_text('hand-made')
        if link: (agent/link[0]).symlink_to(link[1])
        spec['settings']['defaultThinkingLevel']=level
        report = configure(spec,root,dry_run)
        return report, agent, seeded, sorted(p.name for p in agent.glob('settings.json.bak-*'))

    def test_runtime_keeps_the_newest_five_backups_by_stamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, agent, seeded, backups = self.pruned_runtime(tmp)
            self.assertEqual(report['prune_errors'],[])
            new = [n for n in backups if n not in seeded]
            self.assertEqual(len(new),1)
            self.assertEqual(backups, sorted(seeded[3:]+new))

    def test_runtime_prune_ignores_hand_made_backups_other_suffixes_and_symlinks(self):
        extra = ['settings.json.before-edit','settings.json.bak-pr12','settings.json.bak-20250101T000000Z',
                 'settings.json.bak-20250101T000000000000Z.old','settings.json.bak-20251399T000000000000Z',
                 'settings.json.bak-loadout-20250101-000000-abcdef12']
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)/'linked-target'; target.write_text('keep me')
            link = 'settings.json.bak-20250101T000000000000Z'
            report, agent, seeded, backups = self.pruned_runtime(tmp, extra=extra, link=(link,target))
            self.assertEqual(report['prune_errors'],[])
            for name in extra: self.assertEqual((agent/name).read_text(),'hand-made')
            self.assertTrue((agent/link).is_symlink()); self.assertEqual(target.read_text(),'keep me')
            self.assertEqual([n for n in backups if n in seeded], seeded[3:])

    def test_runtime_prune_ignores_another_files_backups_in_the_same_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, agent, seeded, backups = self.pruned_runtime(tmp, others=('notes.json','settings.jsonx'))
            for other in ('notes.json','settings.jsonx'):
                self.assertEqual(len(list(agent.glob(other+'.bak-2026*'))),7)

    def test_runtime_prune_failure_still_completes_the_write(self):
        unlink = Path.unlink
        def refuse(path, *a, **k):
            if '.bak-' in path.name: raise PermissionError('test refusal')
            return unlink(path, *a, **k)
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path,'unlink',refuse):
            report, agent, seeded, backups = self.pruned_runtime(tmp)
            self.assertEqual(json.loads((agent/'settings.json').read_text())['defaultThinkingLevel'],'low')
            self.assertEqual(len(report['prune_errors']),3)
            self.assertTrue(all(e.startswith('backup prune failed, kept: ') for e in report['prune_errors']))
            self.assertEqual(len(backups),8)

    def test_runtime_prune_ignores_a_name_with_non_ascii_digits(self):
        # Arabic-Indic digits in the year and in the second digit of hour, minute and second: strptime alone reads it as 2020.
        mixed = 'settings.json.bak-\u0662\u0660\u0662\u06600101T0\u06600\u06600\u0660000000Z'
        with tempfile.TemporaryDirectory() as tmp:
            report, agent, seeded, backups = self.pruned_runtime(tmp, extra=[mixed])
            self.assertEqual((agent/mixed).read_text(),'hand-made')
            self.assertEqual([n for n in backups if n in seeded], seeded[3:])
            from backups import prune_backups
            self.assertEqual(prune_backups(agent/'settings.json', 'none', r'\.bak-(?P<stamp>\d{8}T\d{12}Z)', '%Y%m%dT%H%M%S%fZ', keep=1), [])
            self.assertEqual((agent/mixed).read_text(),'hand-made')
            self.assertEqual(list(agent.glob('settings.json.bak-[0-9]*')), [])

    def test_runtime_dry_run_prunes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, agent, seeded, backups = self.pruned_runtime(tmp, dry_run=True)
            self.assertIn('agent/settings.json', report['changed'])
            self.assertEqual(backups, seeded)

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
        # Apply keeps the mcp-env.cjs launcher the providers step wrapped Pi in. The command after `--` stays byte for
        # byte while it runs this root's launch.mjs with node, and otherwise becomes the providers step's own command.
        node, launcher = r'C:\Node\node.exe', r'C:\Users\example\AppData\Roaming\loadout\mcp-env.cjs'
        pi_row = lambda command: json.dumps({'agents': {'providers': {'pi': {'command': command, 'env': {'KEEP': '1'}}}}})
        applied = lambda before: json.loads(deploy.merged(before, PureWindowsPath(r'C:\Pi'), {'models': []}, r'C:\Pi'))['agents']['providers']['pi']
        with patch.object(deploy.shutil, 'which', return_value=node):
            for wrapper in ([node, launcher, '--'], [node, launcher, '--provider', 'pi', '--']):
                for current in (['node', r'C:\Pi/launch.mjs'], [node, r'C:\Pi\launch.mjs'], ['NODE', r'c:\pi\.\Launch.mjs']):
                    self.assertEqual(applied(pi_row([*wrapper, *current])), {'command': [*wrapper, *current], 'env': {'KEEP': '1'}, 'models': []})
                for stale in (['node', r'C:\Old\launch.mjs'], [node, r'C:\Pi\launch.mjs', '--extra'], ['bun', r'C:\Pi\launch.mjs']):
                    self.assertEqual(applied(pi_row([*wrapper, *stale]))['command'], [*wrapper, 'node', r'C:\Pi/launch.mjs'])
            # A command that is not that wrapper is replaced whole, as before.
            for other in (['node', r'C:\Old\launch.mjs'], [node, r'C:\Old\mcp-env.cjs', '--provider', 'pi'], 'pi'):
                self.assertEqual(applied(pi_row(other))['command'], [node, r'C:\Pi\launch.mjs'])

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
            with patch.object(deploy,'paseo_command',return_value='paseo'), patch.object(deploy.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='{"daemonVersion":"0.14.9","connectedDaemon":"reachable"}')):
                with self.assertRaisesRegex(ValueError,'0.15.0'):deploy.version_gate(home)
            status={'daemonVersion':'0.15.3','connectedDaemon':'reachable','home':str(home)}
            with patch.object(deploy,'version_gate',return_value=status),patch.object(sys,'argv',['deploy','apply','--spec',str(spec),'--state',str(state)]):deploy.main()
            self.assertTrue(json.loads((home/'config.json').read_text())['agents']['providers']['codex']['enabled'])
            record=json.loads(state.read_text())
            (home/'config.json').write_bytes(b'{}')
            with self.assertRaisesRegex(ValueError,'changed since apply'):deploy.restore(record,home,False)
            (home/'config.json').write_bytes(Path(record['backup']).read_bytes())
            deploy.restore(record,home,False)
            self.assertEqual((home/'config.json').read_bytes(),original)
            self.assertFalse((root/'agent/settings.json').exists())

    def test_deploy_rollback_refuses_runtime_edits_before_changing_anything(self):
        sys.path.insert(0,str(PI))
        import deploy
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);home=base/'daemon';home.mkdir();root=base/'pi'
            (home/'config.json').write_bytes(b'{"agents":{"providers":{}}}\n')
            pkg=root/'app/node_modules/@earendil-works/pi-coding-agent/package.json'
            pkg.parent.mkdir(parents=True);pkg.write_text('{"version":"1.0.0"}')
            settings=root/'agent/settings.json';settings.parent.mkdir();settings.write_text('{"owner":"before apply"}')
            runtime={'baseUrl':'https://router.example.test/v1','credential':{'kind':'env','name':'ROUTE_KEY'},'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'},'models':[{'id':'example','name':'Astra'}],'settings':{'defaultProvider':'fleet','defaultModel':'example','defaultThinkingLevel':'high'}}
            spec=base/'proposal.json';spec.write_text(json.dumps({'root':str(root),'runtime':runtime,'provider':{'models':[{'id':'fleet/example','label':'Astra'}]},'catalog_model_id':'fleet/example'}))
            state=base/'state.json'
            status={'daemonVersion':'0.15.3','connectedDaemon':'reachable','home':str(home)}
            with patch.object(deploy,'version_gate',return_value=status),patch.object(sys,'argv',['deploy','apply','--spec',str(spec),'--state',str(state)]):deploy.main()
            record=json.loads(state.read_text());applied=(home/'config.json').read_bytes();written=settings.read_bytes()
            # The owner edits a runtime file apply wrote, leaving the daemon config alone.
            settings.write_text('{"owner":"edited after apply"}')
            with self.assertRaisesRegex(ValueError,'runtime agent/settings.json changed since apply'):deploy.restore(record,home,False)
            self.assertEqual(settings.read_text(),'{"owner":"edited after apply"}')
            self.assertEqual((home/'config.json').read_bytes(),applied)
            self.assertTrue((root/'runtime.json').exists())
            if os.name!='nt':  # creating a symlink needs privileges on Windows
                outside=base/'outside.json';outside.write_bytes(written)
                settings.unlink();settings.symlink_to(outside)
                with self.assertRaisesRegex(ValueError,'symlink'):deploy.restore(record,home,False)
                self.assertEqual(outside.read_bytes(),written)
                settings.unlink()
            settings.write_bytes(written)
            deploy.restore(record,home,False)
            self.assertEqual(settings.read_text(),'{"owner":"before apply"}')
            self.assertFalse((root/'runtime.json').exists())
            self.assertEqual((home/'config.json').read_bytes(),b'{"agents":{"providers":{}}}\n')

    def test_deploy_refuses_a_symlink_at_the_config_temp_path(self):
        sys.path.insert(0,str(PI))
        import deploy
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);home=base/'daemon';home.mkdir();root=base/'pi'
            original=b'{"agents":{"providers":{}}}\n';(home/'config.json').write_bytes(original)
            pkg=root/'app/node_modules/@earendil-works/pi-coding-agent/package.json';pkg.parent.mkdir(parents=True);pkg.write_text('{"version":"1.0.0"}')
            runtime={'baseUrl':'https://router.example.test/v1','credential':{'kind':'env','name':'ROUTE_KEY'},'paseoMcp':{'url':'http://127.0.0.1:6767/mcp/agents'},'models':[{'id':'example','name':'Astra'}],'settings':{'defaultProvider':'fleet','defaultModel':'example','defaultThinkingLevel':'high'}}
            spec=base/'proposal.json';spec.write_text(json.dumps({'root':str(root),'runtime':runtime,'provider':{'models':[{'id':'fleet/example','label':'Astra'}]},'catalog_model_id':'fleet/example'}))
            # Someone who could guess the temp name plants a link there; the staging must not write through it.
            outside=base/'outside.json';outside.write_bytes(b'not the daemon config\n')
            (home/('config.json.loadout-'+'0'*32)).symlink_to(outside)
            status={'daemonVersion':'0.15.3','connectedDaemon':'reachable','home':str(home)}
            with patch.object(deploy,'version_gate',return_value=status),patch.object(deploy.secrets,'token_hex',return_value='0'*32), \
                    patch.object(sys,'argv',['deploy','apply','--spec',str(spec),'--state',str(base/'state.json')]):
                with self.assertRaisesRegex(ValueError,'already exists; refusing to stage through it'):deploy.main()
            self.assertEqual(outside.read_bytes(),b'not the daemon config\n')
            self.assertEqual((home/'config.json').read_bytes(),original)

    @unittest.skipUnless(os.name == 'nt', 'a junction is a Windows reparse point')
    def test_runtime_refuses_a_junction_before_any_write(self):
        sys.path.insert(0,str(PI))
        from configure import configure
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'pi';root.mkdir();elsewhere=Path(tmp)/'elsewhere';elsewhere.mkdir()
            subprocess.run(['cmd','/c','mklink','/J',str(root/'agent'),str(elsewhere)],check=True,capture_output=True)
            spec={'baseUrl':'https://router.example.test/v1','credential':{'kind':'env','name':'EXISTING_KEY'},
                  'models':[{'id':'example','name':'Astra'}],
                  'settings':{'defaultProvider':'fleet','defaultModel':'example','defaultThinkingLevel':'high'}}
            with self.assertRaisesRegex(ValueError,'junction'):configure(spec,root)
            self.assertEqual(list(elsewhere.iterdir()),[])
            self.assertFalse((root/'runtime.json').exists())

    def launcher_fixture(self, base):
        """A configured Pi root whose fake cli.js records its argv and agent dir; returns (root, run, record)."""
        sys.path.insert(0, str(PI))
        from configure import build
        spec = {'baseUrl': 'https://router.example.test/v1', 'credential': {'kind': 'env', 'name': 'EXISTING_KEY'},
                'models': [{'id': 'current', 'name': 'Sol'}], 'paseoMcp': {'url': 'http://127.0.0.1:1/mcp/agents'},
                'settings': {'defaultProvider': 'fleet', 'defaultModel': 'current', 'defaultThinkingLevel': 'high'}}
        root = base/'pi'
        for name, data in build(spec, root).items():
            (root/name).parent.mkdir(parents=True, exist_ok=True); (root/name).write_text(json.dumps(data))
        for name in ['launch.mjs', 'fleet-routing.mjs', 'credential.py']:
            (root/name).write_bytes((PI/name).read_bytes())
        app = root/'app/node_modules/@earendil-works/pi-coding-agent'
        (app/'dist/bundle').mkdir(parents=True)
        (app/'package.json').write_text('{"version": "1.0.0"}')
        record = base/'pi-ran.json'
        (app/'dist/bundle/cli.js').write_text(
            "require('fs').writeFileSync(process.env.RECORD, JSON.stringify({argv: process.argv.slice(2), "
            "dir: process.env.PI_CODING_AGENT_DIR, mcpUrl: process.env.LOADOUT_PI_MCP_URL ?? null}))")
        def run(*args, command=('node',), cwd=None, timeout=None, **extra):
            sys.path.insert(0, str(PI.parent))
            import paseo_providers as pp
            ambient = {k: v for k, v in os.environ.items()
                       if not re.match(r'(LOADOUT_PI_|JITI_|LD_|DYLD_|OPENSSL_)', k) and k not in pp.ISOLATED_SCRUBBED_ENV}
            env = {**ambient, 'PASEO_AGENT_ID': 'agent-0001', 'RECORD': str(record), 'EXISTING_KEY': 'fixture-key', **extra}
            for key in [k for k, v in extra.items() if v is None]: env.pop(key)
            return subprocess.run([*command, str(root/'launch.mjs'), *args], capture_output=True, text=True, env=env,
                                  cwd=cwd or base, timeout=timeout)
        return root, run, record

    # The isolated marker, plus the test-platform marker off macOS (isolation is macOS only; a real macOS launch
    # refuses the test markers).
    ISO = ('--loadout-isolated',) + (() if sys.platform == 'darwin' else ('--loadout-test-platform', 'darwin'))

    def isolated_row_command(self):
        """The isolated row's command up to launch.mjs: the env scrub, then this host's absolute node."""
        sys.path.insert(0, str(PI.parent))
        import paseo_providers as pp
        node = subprocess.run(['node', '-p', 'process.execPath'], capture_output=True, text=True).stdout.strip()
        return [*pp.ISOLATED_ENV_SCRUB, node]

    def test_isolated_launch_writes_no_mcp_config_and_removes_a_stale_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            home = root/'agents/agent-0001'
            # The main Pi provider writes the agent's mcp.json, as before; an isolation env never changes that.
            done = run('--mode', 'rpc', '--model', 'fleet/current', LOADOUT_PI_ISOLATED='1')
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn('paseo', json.loads((home/'mcp.json').read_text())['mcpServers'])
            # The isolated row removes that stale file before Pi starts and writes none.
            record.unlink()
            done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current')
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertFalse((home/'mcp.json').exists())
            ran = json.loads(record.read_text())
            self.assertEqual(ran['dir'], str(home))
            self.assertEqual(ran['argv'], ['--no-approve', '--mode', 'rpc', '--model', 'fleet/current'])
            self.assertIsNone(ran['mcpUrl'])
            self.assertEqual(json.loads((home/'settings.json').read_text())['extensions'][-1], '-builtin:mcp')
            # A per-agent env on the isolated row refuses, whatever its value (empty included).
            record.unlink()
            for key in ['LOADOUT_PI_ISOLATED', 'LOADOUT_PI_SANDBOX_PROFILE']:
                done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current', **{key: ''})
                self.assertNotEqual(done.returncode, 0, key)
                self.assertIn('isolation comes from the provider command', done.stderr)
                self.assertFalse(record.exists(), key)
            # Without a caller there is no agent home, so an isolated launch refuses.
            done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current', PASEO_AGENT_ID=None)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn('needs a Paseo caller', done.stderr)
            self.assertFalse(record.exists())
            # The isolated probe loads every extension but built-in MCP, so Paseo sees no MCP support.
            done = run(*self.ISO, '--mode', 'rpc', PASEO_AGENT_ID=None)
            self.assertEqual(done.returncode, 0, done.stderr)
            ran = json.loads(record.read_text())
            self.assertEqual(ran['dir'], str(root/'agent'))
            self.assertEqual(ran['argv'], ['--no-approve', '--no-extensions', '-e', 'builtin:codemode', '-e',
                                           'builtin:tool-search', '-e', 'builtin:llama.cpp', '-e',
                                           str(root/'fleet-routing.mjs'), '--mode', 'rpc'])
            # Markers anywhere but the start of the command, or a profile without the isolated marker, refuse.
            record.unlink()
            for args in [('--mode', 'rpc', '--loadout-isolated'), ('--loadout-sandbox-profile', '/x.sb', '--mode', 'rpc')]:
                done = run(*args)
                self.assertNotEqual(done.returncode, 0, args)
                self.assertFalse(record.exists(), args)
            # Isolation is macOS only: off macOS an isolated launch, agent or probe, refuses.
            if sys.platform != 'darwin':
                for args in [('--mode', 'rpc', '--model', 'fleet/current'), ('--mode', 'rpc')]:
                    done = run('--loadout-isolated', *args)
                    self.assertNotEqual(done.returncode, 0, args)
                    self.assertIn('needs macOS', done.stderr)
                    self.assertFalse(record.exists(), args)

    @unittest.skipIf(sys.platform == "darwin", "the test markers refuse a real macOS launch")
    def test_sandbox_refusals_never_start_pi(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            profile = base/'pi.sb'; profile.write_text('(version 1)\n')
            fake = base/'sandbox-exec'; fake.write_text('#!/bin/sh\nexit 0\n'); fake.chmod(0o755)
            cases = [
                (['--loadout-test-platform', 'linux', '--loadout-test-sandbox-exec', str(fake),
                  '--loadout-sandbox-profile', str(profile)], 'needs macOS'),
                (['--loadout-test-platform', 'darwin', '--loadout-test-sandbox-exec', str(base/'missing-sandbox-exec'),
                  '--loadout-sandbox-profile', str(profile)], 'missing or not executable'),
                (['--loadout-test-platform', 'darwin', '--loadout-test-sandbox-exec', str(fake),
                  '--loadout-sandbox-profile', str(base/'missing.sb')], 'missing or unreadable'),
                (['--loadout-test-platform', 'darwin', '--loadout-test-sandbox-exec', str(fake),
                  '--loadout-sandbox-profile', str(base)], 'not a regular file'),
            ]
            for markers, message in cases:
                for args in [('--mode', 'rpc', '--model', 'fleet/current'), ('--mode', 'rpc')]:
                    done = run('--loadout-isolated', *markers, *args)
                    self.assertNotEqual(done.returncode, 0, message)
                    self.assertEqual(done.stderr.count('\n'), 1, done.stderr)
                    self.assertIn(message, done.stderr)
                    self.assertFalse(record.exists(), message)

    @unittest.skipIf(os.name == "nt" or sys.platform == "darwin",
                     "the fake sandbox-exec is a POSIX shell script, and the test markers refuse a real macOS launch")
    def test_sandbox_spawn_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            profile = base/'pi.sb'; profile.write_text('(version 1)\n')
            argv_log = base/'sandbox-argv'
            fake = base/'sandbox-exec'; fake.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{argv_log}"\nexit 7\n'); fake.chmod(0o755)
            # A per-agent env naming another sandbox-exec (one that runs Pi unsandboxed) is ignored.
            bypass = base/'bypass'; bypass.write_text('#!/bin/sh\nshift 8\nexec "$@"\n'); bypass.chmod(0o755)
            done = run('--loadout-isolated', '--loadout-sandbox-profile', str(profile), '--loadout-test-platform', 'darwin',
                       '--loadout-test-sandbox-exec', str(fake), '--mode', 'rpc', '--model', 'fleet/current',
                       LOADOUT_PI_TEST_SANDBOX_EXEC=str(bypass), LOADOUT_PI_TEST_PLATFORM='darwin')
            self.assertEqual(done.returncode, 7, done.stderr)
            node = subprocess.run(['node', '-p', 'process.execPath'], capture_output=True, text=True).stdout.strip()
            cli = root/'app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
            self.assertEqual(argv_log.read_text().splitlines(), [
                '-f', str(profile), '-D', f'CWD={base}', '-D', f'PI_HOME={root/"agents/agent-0001"}',
                '-D', f'PI_ROOT={root}', node, str(cli), '--no-approve', '--mode', 'rpc', '--model', 'fleet/current'])
            self.assertFalse(record.exists())

    @unittest.skipIf(os.name == "nt" or sys.platform == "darwin",
                     "the row command needs /usr/bin/env and POSIX shell fakes, and the test markers refuse a real macOS launch")
    def test_a_per_agent_env_cannot_take_over_the_isolated_launcher(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            home = root/'agents/agent-0001'
            row = self.isolated_row_command()
            # R6 and R7: a NODE_OPTIONS preload that strips the isolated or the profile marker never runs under the
            # row's env scrub, so the launch stays isolated and sandboxed.
            preloaded = base/'preload-ran'
            preload = base/'preload.js'
            preload.write_text(f"require('fs').writeFileSync({json.dumps(str(preloaded))}, 'ran');"
                               "process.argv = process.argv.filter(a => !a.startsWith('--loadout-'));")
            done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current', command=row,
                       NODE_OPTIONS=f'--require={preload}')
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertFalse(preloaded.exists())
            self.assertFalse((home/'mcp.json').exists())
            self.assertEqual(json.loads(record.read_text())['argv'][0], '--no-approve')
            record.unlink()
            profile = base/'pi.sb'; profile.write_text('(version 1)\n')
            argv_log = base/'sandbox-argv'
            fake = base/'sandbox-exec'; fake.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{argv_log}"\nexit 7\n'); fake.chmod(0o755)
            done = run('--loadout-isolated', '--loadout-sandbox-profile', str(profile), '--loadout-test-platform', 'darwin',
                       '--loadout-test-sandbox-exec', str(fake), '--mode', 'rpc', '--model', 'fleet/current',
                       command=row, NODE_OPTIONS=f'--require={preload}')
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertFalse(preloaded.exists())
            self.assertEqual(argv_log.read_text().splitlines()[:2], ['-f', str(profile)])
            self.assertFalse(record.exists())
            # R8: an OPENSSL_CONF whose provider module node would load before any JavaScript (this one names a
            # missing module, so node aborts if it reads the file) is cleared by the row's scrub; the launch stays isolated.
            bad_conf = base/'openssl.cnf'
            bad_conf.write_text(f'nodejs_conf = nc\n[nc]\nproviders = prov\n[prov]\nevil = evil_sect\n[evil_sect]\n'
                                f'module = {base}/missing-provider.so\nactivate = 1\n')
            done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current', command=row,
                       OPENSSL_CONF=str(bad_conf))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertFalse((home/'mcp.json').exists())
            self.assertEqual(json.loads(record.read_text())['argv'][0], '--no-approve')
            record.unlink()
            # Without the scrub, the launcher itself refuses a preload or loader variable; Pi never starts.
            benign = base/'benign.js'; benign.write_text('')
            empty_conf = base/'empty.cnf'; empty_conf.write_text('')
            for key, value in [('NODE_OPTIONS', f'--require={benign}'), ('JITI_ALIAS', '{}'), ('LD_PRELOAD', ''),
                               ('DYLD_LIBRARY_PATH', str(base)), ('OPENSSL_CONF', str(empty_conf))]:
                done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current', **{key: value})
                self.assertNotEqual(done.returncode, 0, key)
                self.assertEqual(done.stderr.count('\n'), 1, done.stderr)
                self.assertIn(f'remove {key}', done.stderr)
                self.assertFalse(record.exists(), key)
            # A per-agent PATH with a fake node never runs it: the row names this host's node by absolute path.
            fakebin = base/'fakebin'; fakebin.mkdir()
            faked = base/'fake-node-ran'
            (fakebin/'node').write_text(f'#!/bin/sh\ntouch "{faked}"\nexit 0\n'); (fakebin/'node').chmod(0o755)
            done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current', command=row,
                       PATH=f'{fakebin}{os.pathsep}{os.environ["PATH"]}')
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertFalse(faked.exists())
            self.assertEqual(json.loads(record.read_text())['argv'][0], '--no-approve')

    def sandbox_fixture(self, base):
        """A fake sandbox-exec that records its argv and Pi's TMPDIR and router key variable, then exits 7."""
        log = base/'sandbox-run'
        fake = base/'sandbox-exec'
        fake.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{log}"\n'
                        f'printf "TMPDIR=%s\\nKEY=%s\\n" "$TMPDIR" "$LOADOUT_PI_ROUTER_KEY" >> "{log}"\nexit 7\n')
        fake.chmod(0o755)
        return fake, log

    @unittest.skipIf(os.name == "nt" or sys.platform == "darwin",
                     "the fake sandbox-exec is a POSIX shell script, and the test markers refuse a real macOS launch")
    def test_per_agent_sandbox_profile_under_the_profile_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            fake, log = self.sandbox_fixture(base)
            runs = base/'runs'; unit = runs/'unit'; work = unit/'work'; work.mkdir(parents=True)
            profile = unit/'agent.sb'; profile.write_text('(version 1)\n')
            (base/'outside.sb').write_text('(version 1)\n')
            (work/'agent.sb').write_text('(version 1)\n')
            (unit/'link.sb').symlink_to(profile)
            (runs/'linkdir').symlink_to(unit)
            markers = ('--loadout-isolated', '--loadout-sandbox-root', str(runs), '--loadout-test-platform', 'darwin',
                       '--loadout-test-sandbox-exec', str(fake))
            launch = lambda **extra: run(*markers, '--mode', 'rpc', '--model', 'fleet/current', cwd=work, **extra)
            # Accepted: a regular file under the root, outside the agent's working directory; only its path reaches
            # sandbox-exec.
            done = launch(LOADOUT_PI_SANDBOX_PROFILE=str(profile))
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertEqual(log.read_text().splitlines()[:2], ['-f', str(profile)])
            log.unlink()
            # A case variant of a path inside the cwd: on a case-insensitive volume it is the same file, and its real
            # path differs; on a case-sensitive one it does not exist. Either way it refuses.
            (work/'inwork.sb').write_text('(version 1)\n')
            cases = [(str(unit/'link.sb'), 'symbolic link'), (str(runs/'linkdir/agent.sb'), 'symbolic link'),
                     (str(unit/'WORK/inwork.sb'), 'sandbox profile'),
                     (f'{runs}/../outside.sb', 'without . or .. parts'), (str(base/'outside.sb'), 'not under the sandbox'),
                     (str(work/'agent.sb'), "agent's working directory"), (None, 'needs LOADOUT_PI_SANDBOX_PROFILE'),
                     ('', 'needs LOADOUT_PI_SANDBOX_PROFILE')]
            for value, message in cases:
                done = launch(LOADOUT_PI_SANDBOX_PROFILE=value)
                self.assertNotEqual(done.returncode, 0, value)
                self.assertEqual(done.stderr.count('\n'), 1, done.stderr)
                self.assertIn(message, done.stderr)
                self.assertFalse(log.exists(), value)
                self.assertFalse(record.exists(), value)
            # The root mode and a fixed sandboxProfile together refuse at sync.
            sys.path.insert(0, str(PI.parent))
            import paseo_providers as pp
            sync = base/'sync'; sync.mkdir()
            catalog, _ = self.pi_merge_fixture(sync)
            with self.assertRaisesRegex(Exception, 'not both'):
                pp._pi({**catalog['pi'], 'isolated': {'sandboxProfile': '/x.sb', 'sandboxProfileRoot': str(runs)}}, 'pi')

    @unittest.skipIf(os.name == "nt" or sys.platform == "darwin",
                     "the fake sandbox-exec is a POSIX shell script, and the test markers refuse a real macOS launch")
    def test_sandboxed_launch_reads_the_key_and_sets_tmpdir(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            fake, log = self.sandbox_fixture(base)
            home = root/'agents/agent-0001'
            profile = base/'pi.sb'; profile.write_text('(version 1)\n')
            markers = ('--loadout-isolated', '--loadout-sandbox-profile', str(profile), '--loadout-test-platform', 'darwin',
                       '--loadout-test-sandbox-exec', str(fake))
            launch = lambda **extra: run(*markers, '--mode', 'rpc', '--model', 'fleet/current', **extra)
            # The launcher reads the key; Pi gets it only in its env, and the agent's models.json names that variable.
            done = launch(EXISTING_KEY='key-from-helper')
            self.assertEqual(done.returncode, 7, done.stderr)
            lines = log.read_text().splitlines()
            self.assertIn('KEY=key-from-helper', lines)
            self.assertFalse(any('key-from-helper' in line for line in lines if not line.startswith('KEY=')))
            models = (home/'models.json').read_text()
            self.assertNotIn('key-from-helper', models)
            self.assertEqual(json.loads(models)['providers']['fleet']['apiKey'], '$LOADOUT_PI_ROUTER_KEY')
            # Pi's temp files go under the agent home, owner-only.
            self.assertIn(f'TMPDIR={home/"tmp"}', lines)
            self.assertEqual((home/'tmp').stat().st_mode & 0o777, 0o700)
            log.unlink()
            # A failed helper refuses the launch; Pi never starts.
            done = launch(EXISTING_KEY=None)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn('credential helper failed', done.stderr)
            self.assertFalse(log.exists())
            # An extension the profile would not let Pi read refuses.
            settings = root/'agent/settings.json'
            other = base/'other.mjs'; other.write_text('export default () => {}\n')
            settings.write_text(json.dumps({**json.loads(settings.read_text()),
                                            'extensions': [str(root/'fleet-routing.mjs'), str(other)]}))
            for args in [('--mode', 'rpc', '--model', 'fleet/current'), ('--mode', 'rpc')]:
                done = run(*markers, *args)
                self.assertNotEqual(done.returncode, 0, args)
                self.assertIn('outside what a sandbox profile lets Pi read', done.stderr)
                self.assertFalse(log.exists(), args)
            self.assertFalse(record.exists())

    @unittest.skipIf(os.name == "nt" or sys.platform == "darwin",
                     "the fake sandbox-exec is a POSIX shell script, and the test markers refuse a real macOS launch")
    def test_sandboxed_launch_copies_paseos_extension_into_the_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            fake, log = self.sandbox_fixture(base)
            home = root/'agents/agent-0001'
            profile = base/'pi.sb'; profile.write_text('(version 1)\n')
            # The daemon's temp folder; with the test-platform marker the launcher trusts os.tmpdir().
            temp = base/'daemon-tmp'; temp.mkdir()
            ext_dir = temp/'paseo-pi-extension-Ab12Cd'; ext_dir.mkdir(mode=0o700)
            source = ext_dir/'paseo-integration.mjs'; source.write_text('export default () => {} // paseo\n')
            markers = ('--loadout-isolated', '--loadout-sandbox-profile', str(profile), '--loadout-test-platform', 'darwin',
                       '--loadout-test-sandbox-exec', str(fake))
            launch = lambda path: run(*markers, '--mode', 'rpc', '--model', 'fleet/current', '--extension', str(path),
                                      TMPDIR=str(temp))
            # Paseo's extension under the temp folder: copied into the home, and Pi gets the copy.
            done = launch(source)
            self.assertEqual(done.returncode, 7, done.stderr)
            copy = home/'paseo-integration.mjs'
            self.assertEqual(copy.read_bytes(), source.read_bytes())
            self.assertEqual(copy.stat().st_mode & 0o777, 0o600)
            argv = log.read_text().splitlines()
            self.assertEqual(argv[argv.index('--extension') + 1], str(copy))
            self.assertNotIn(str(source), argv)
            log.unlink()
            # A symbolic link (the file or its folder) or a non-regular source refuses; so does an extension elsewhere
            # outside what the profile lets Pi read, a Paseo-named one outside the temp folder included.
            secret = base/'secret.mjs'; secret.write_text('secret\n')
            (temp/'paseo-pi-extension-Link01').mkdir()
            (temp/'paseo-pi-extension-Link01/paseo-integration.mjs').symlink_to(secret)
            (temp/'paseo-pi-extension-Dir001').mkdir()
            (temp/'paseo-pi-extension-Dir001/paseo-integration.mjs').mkdir()
            (temp/'paseo-pi-extension-Fifo01').mkdir()
            os.mkfifo(temp/'paseo-pi-extension-Fifo01/paseo-integration.mjs')
            (temp/'paseo-pi-extension-Folder').symlink_to(ext_dir)
            outside = base/'paseo-pi-extension-Out001'; outside.mkdir()
            (outside/'paseo-integration.mjs').write_text('export default () => {}\n')
            cases = [(temp/'paseo-pi-extension-Link01/paseo-integration.mjs', 'symbolic link'),
                     (temp/'paseo-pi-extension-Folder/paseo-integration.mjs', 'symbolic link'),
                     (temp/'paseo-pi-extension-Dir001/paseo-integration.mjs', 'not a regular file'),
                     (temp/'paseo-pi-extension-Fifo01/paseo-integration.mjs', 'not a regular file'),
                     (secret, 'outside what a sandbox profile lets Pi read'),
                     (outside/'paseo-integration.mjs', 'outside what a sandbox profile lets Pi read')]
            for path, message in cases:
                copy.unlink(missing_ok=True)
                done = launch(path)
                self.assertNotEqual(done.returncode, 0, path)
                self.assertEqual(done.stderr.count('\n'), 1, done.stderr)
                self.assertIn(message, done.stderr)
                self.assertFalse(log.exists(), path)
                self.assertFalse(copy.exists(), path)
            # A hard-linked source refuses: Paseo's own file always has one link.
            (temp/'paseo-pi-extension-Hard01').mkdir()
            os.link(secret, temp/'paseo-pi-extension-Hard01/paseo-integration.mjs')
            # The file swapped after the open (a preload renames another file over it right after the launcher opens
            # it): the name no longer matches the descriptor, so the launch refuses.
            swap = base/'swap.cjs'
            swap.write_text("const fs = require('fs'), m = require('module'), open = fs.openSync;\n"
                            "fs.openSync = (p, f, ...rest) => { const fd = open(p, f, ...rest);\n"
                            "  if (String(p).endsWith('/paseo-integration.mjs') && (f & fs.constants.O_NONBLOCK)) {\n"
                            "    fs.writeFileSync(p + '.new', 'other\\n'); fs.renameSync(p + '.new', p); }\n"
                            "  return fd; };\nm.syncBuiltinESMExports();\n")
            (temp/'paseo-pi-extension-Swap01').mkdir()
            swapped = temp/'paseo-pi-extension-Swap01/paseo-integration.mjs'; swapped.write_text('export default () => {}\n')
            for path, message, command in [
                    (temp/'paseo-pi-extension-Hard01/paseo-integration.mjs', 'more than one link', ('node',)),
                    (swapped, 'changed while it was opened', ('node', '--require', str(swap)))]:
                done = run(*markers, '--mode', 'rpc', '--model', 'fleet/current', '--extension', str(path),
                           TMPDIR=str(temp), command=command)
                self.assertNotEqual(done.returncode, 0, path)
                self.assertEqual(done.stderr.count('\n'), 1, done.stderr)
                self.assertIn(message, done.stderr)
                self.assertFalse(log.exists(), path)
                self.assertFalse(copy.exists(), path)
            # A directory where the copy goes refuses with one line.
            copy.mkdir()
            done = launch(source)
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(done.stderr.count('\n'), 1, done.stderr)
            self.assertIn(f'{copy} is a directory', done.stderr)
            self.assertFalse(log.exists())
            copy.rmdir()
            self.assertFalse(record.exists())
            # A non-isolated row, and an isolated row without a profile, pass the argument unchanged.
            for markers in [(), self.ISO]:
                done = run(*markers, '--mode', 'rpc', '--model', 'fleet/current', '--extension', str(source),
                           TMPDIR=str(temp))
                self.assertEqual(done.returncode, 0, done.stderr)
                ran = json.loads(record.read_text())['argv']
                self.assertEqual(ran[ran.index('--extension') + 1], str(source))
                record.unlink()

    @unittest.skipIf(os.name == "nt" or sys.platform == "darwin",
                     "the fake sandbox-exec is a POSIX shell script, and the test markers refuse a real macOS launch")
    def test_credential_helper_never_sees_the_per_agent_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            fake, log = self.sandbox_fixture(base)
            profile = base/'pi.sb'; profile.write_text('(version 1)\n')
            # A stand-in helper at the pinned path records what it ran with.
            seen = base/'helper-seen.json'
            (root/'credential.py').write_text(
                f"import json, os, sys\njson.dump({{'env': dict(os.environ), 'isolated': sys.flags.isolated}}, "
                f"open({str(seen)!r}, 'w'))\nprint('fixture-key')\n")
            # A per-agent HOME whose user site dir holds a .pth with an import line.
            evil = base/'evil-home'; marker = base/'pth-ran'
            site_dir = subprocess.run([sys.executable, '-c', 'import site; print(site.getusersitepackages())'],
                                      capture_output=True, text=True, env={**os.environ, 'HOME': str(evil)}).stdout.strip()
            Path(site_dir).mkdir(parents=True)
            (Path(site_dir)/'zz.pth').write_text(f"import os; open({str(marker)!r}, 'a').write('ran')\n")
            # Control: Python run with that HOME does execute the line.
            subprocess.run([sys.executable, '-c', 'pass'], env={**os.environ, 'HOME': str(evil)})
            import site
            if site.ENABLE_USER_SITE: self.assertTrue(marker.exists())
            marker.unlink(missing_ok=True)
            done = run('--loadout-isolated', '--loadout-sandbox-profile', str(profile), '--loadout-test-platform', 'darwin',
                       '--loadout-test-sandbox-exec', str(fake), '--mode', 'rpc', '--model', 'fleet/current',
                       HOME=str(evil), DEVELOPER_DIR=str(base/'devdir'), PYTHONPATH=str(base))
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertFalse(marker.exists())
            helper = json.loads(seen.read_text())
            self.assertEqual(helper['isolated'], 1)
            self.assertNotIn('DEVELOPER_DIR', helper['env'])
            self.assertNotIn('PYTHONPATH', helper['env'])
            self.assertNotEqual(helper['env']['HOME'], str(evil))
            # Only the fixed PATH and HOME, and the env credential source's own variable.
            self.assertLessEqual(set(helper['env']) - {'LC_CTYPE'}, {'PATH', 'HOME', 'EXISTING_KEY'})
            self.assertEqual(helper['env']['PATH'], '/usr/bin:/bin:/usr/sbin:/sbin')

    @unittest.skipIf(os.name == "nt", "symbolic links need privileges on Windows")
    def test_a_symlink_in_the_agent_home_is_replaced_not_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            home = root/'agents/agent-0001'; home.mkdir(parents=True)
            victim = base/'victim.txt'; victim.write_text('original')
            (home/'models.json').symlink_to(victim)
            done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current')
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(victim.read_text(), 'original')
            self.assertFalse((home/'models.json').is_symlink())
            self.assertIn('providers', json.loads((home/'models.json').read_text()))

    @unittest.skipIf(os.name == "nt", "FIFOs are POSIX only")
    def test_a_fifo_overlay_refuses_promptly(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            home = root/'agents/agent-0001'; home.mkdir(parents=True)
            for name in ['models.overlay.json', 'settings.overlay.json']:
                os.mkfifo(home/name)
                for args in [self.ISO, ()]:
                    try:
                        done = run(*args, '--mode', 'rpc', '--model', 'fleet/current', timeout=20)
                    except subprocess.TimeoutExpired:
                        self.fail(f'{name}: a FIFO overlay hung the launch')
                    self.assertNotEqual(done.returncode, 0, name)
                    self.assertIn('is not a regular file', done.stderr)
                    self.assertFalse(record.exists())
                (home/name).unlink()

    @unittest.skipIf(os.name == "nt", "symbolic links need privileges on Windows")
    def test_a_symlinked_overlay_refuses_without_echoing_its_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            home = root/'agents/agent-0001'; home.mkdir(parents=True)
            token = base/'token.txt'; token.write_text('fake-token-0123456789\n')
            for name in ['models.overlay.json', 'settings.overlay.json']:
                (home/name).symlink_to(token)
                for args in [self.ISO, ()]:
                    done = run(*args, '--mode', 'rpc', '--model', 'fleet/current')
                    self.assertNotEqual(done.returncode, 0, name)
                    self.assertIn('is a symlink', done.stderr)
                    self.assertNotIn('fake-token', done.stderr + done.stdout)
                    self.assertFalse(record.exists())
                (home/name).unlink()
                # A regular overlay holding that text refuses as invalid JSON, without quoting it.
                (home/name).write_text(token.read_text())
                done = run(*self.ISO, '--mode', 'rpc', '--model', 'fleet/current')
                self.assertNotEqual(done.returncode, 0, name)
                self.assertIn('invalid JSON', done.stderr)
                self.assertNotIn('fake-token', done.stderr + done.stdout)
                (home/name).unlink()

    @unittest.skipIf(os.name == "nt" or sys.platform == "darwin",
                     "the fake sandbox-exec is a POSIX shell script, and the test markers refuse a real macOS launch")
    def test_probe_profile_refuses_a_node_prefix_that_contains_the_pi_root(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root, run, record = self.launcher_fixture(base)
            fake, log = self.sandbox_fixture(base)
            # A node at <prefix>/bin/node whose prefix holds the Pi root, as with ~/.local/bin/node and a Pi root
            # under ~/.local/share.
            node = shutil.which('node'); local = base/'bin/node'; local.parent.mkdir()
            try: os.link(os.path.realpath(node), local)
            except OSError: shutil.copy2(os.path.realpath(node), local)
            runs = base/'runs'; runs.mkdir()
            markers = ('--loadout-isolated', '--loadout-sandbox-root', str(runs), '--loadout-test-platform', 'darwin',
                       '--loadout-test-sandbox-exec', str(fake))
            done = run(*markers, '--mode', 'rpc', command=(str(local),))
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(done.stderr.count('\n'), 1, done.stderr)
            self.assertIn('contains the Pi root', done.stderr)
            self.assertFalse(log.exists())
            # The same probe with a node outside it runs under the probe profile.
            done = run(*markers, '--mode', 'rpc')
            self.assertEqual(done.returncode, 7, done.stderr)
            self.assertEqual(log.read_text().splitlines()[0], '-p')

    @unittest.skipUnless(sys.platform == "darwin" and os.path.exists('/usr/bin/sandbox-exec'), "macOS sandbox-exec")
    def test_probe_profile_denies_reading_an_unlisted_file_under_the_home(self):
        launcher = (PI/'launch.mjs').read_text()
        profile = re.search(r"const PROBE_PROFILE = `(.*?)`;", launcher, re.S).group(1)
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            base = Path(tmp).resolve()
            pi_home = base/'pi/agent'; pi_home.mkdir(parents=True)
            (pi_home/'settings.json').write_text('{}')
            secret = base/'token.txt'; secret.write_text('fake-token')
            sandbox = ['/usr/bin/sandbox-exec', '-p', profile, '-D', f'HOME={Path.home().resolve()}', '-D', f'PI_HOME={pi_home}',
                       '-D', f'PI_ROOT={base/"pi"}', '-D', f'CWD={base}', '-D', 'NODE_PREFIX=/nonexistent', '/bin/cat']
            self.assertEqual(subprocess.run([*sandbox, str(pi_home/'settings.json')], capture_output=True).returncode, 0)
            self.assertNotEqual(subprocess.run([*sandbox, str(secret)], capture_output=True).returncode, 0)

    @unittest.skipIf(os.name == "nt", "the merge payload exceeds the Windows command line")
    def test_isolated_provider_row_mirrors_pi_and_goes_when_dropped(self):
        sys.path.insert(0, str(PI.parent))
        import paseo_providers as pp
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);config=base/'config.json';config.write_text('{"agents":{"providers":{}}}')
            catalog,run=self.pi_merge_fixture(base)
            plain=pp.payload(catalog,'example','stamp',False)
            self.assertEqual((set(plain['providers']),set(plain['env'])),({'codex','pi'},{'pi'}))
            self.assertEqual(run(catalog)['error'],None)
            before=config.read_text()
            catalog['pi']['isolated']={'sandboxProfile':'~/.config/example/pi.sb'}
            pp._pi(catalog['pi'],'pi')
            got=run(catalog,'darwin')
            self.assertEqual(got['error'],None)
            rows=json.loads(config.read_text())['agents']['providers']
            self.assertEqual(rows['pi-isolated']['extends'],'pi')
            for key in ['models','enabled']:
                self.assertEqual(rows['pi-isolated'][key],rows['pi'][key])
            # The env scrub, then this host's absolute node (never a bare node a per-agent PATH could pick).
            node=subprocess.run(['node','-p','process.execPath'],capture_output=True,text=True,
                                env={**os.environ,'PATH':str(base/'bin')+os.pathsep+os.environ['PATH']}).stdout.strip()
            self.assertEqual(rows['pi-isolated']['command'],[*pp.ISOLATED_ENV_SCRUB,node,*rows['pi']['command'][1:],
                             '--loadout-isolated','--loadout-sandbox-profile',str(Path.home()/'.config/example/pi.sb')])
            self.assertEqual(rows['pi-isolated']['paseoTools'],{'enabled':False})
            # The row's scrub and the launcher's refusal are the same set.
            launcher=(PI/'launch.mjs').read_text()
            block=launcher[launcher.index('const ISOLATED_SCRUBBED_ENV = ['):]
            self.assertEqual(re.findall(r"'([A-Z0-9_]+)'",block[:block.index('];')]),list(pp.ISOLATED_SCRUBBED_ENV))
            self.assertNotIn('env',rows['pi-isolated'])
            # Dropping the profile drops it from the row.
            catalog['pi']['isolated']={}
            self.assertEqual(run(catalog,'darwin')['error'],None)
            rows=json.loads(config.read_text())['agents']['providers']
            self.assertEqual(rows['pi-isolated']['command'],[*pp.ISOLATED_ENV_SCRUB,node,*rows['pi']['command'][1:],
                             '--loadout-isolated'])
            # Dropping the key removes the row, leaving the config byte-identical to a run that never had it.
            del catalog['pi']['isolated']
            got=run(catalog,'darwin')
            self.assertEqual((got['error'],got['removed']),(None,['pi-isolated']))
            self.assertEqual(config.read_text(),before)
            for bad in [{'providerId':'pi'},{'providerId':'codex'},{'other':1},{'sandboxProfile':'relative.sb'}]:
                with self.assertRaises(Exception):
                    pp._pi({**catalog['pi'],'isolated':bad},'pi')
            # A providerId that is already a pinned provider refuses at load.
            import fleet as fleet_module
            doc={'schema_version':2,'source_host':'example','transport':'ssh',
                 'hosts':[{'name':'example','os':'macos','sync':['providers']}]}
            path=base/'paseo-providers.json'
            path.write_text(json.dumps({**catalog,'pi':{**catalog['pi'],'isolated':{'providerId':'codex-two'}},
                                        'providers':{**catalog['providers'],'codex-two':catalog['providers']['codex']}}))
            with self.assertRaisesRegex(fleet_module.FleetError,'already a provider'):
                pp.load_config(path,doc)
            # Isolation is macOS only: a linux or windows host refuses pi.isolated at load, and the merge refuses
            # off macOS.
            path.write_text(json.dumps({**catalog,'pi':{**catalog['pi'],'isolated':{}}}))
            for os_name in ['linux','windows']:
                doc['hosts'][0]['os']=os_name
                with self.assertRaisesRegex(fleet_module.FleetError,'needs a macos host'):
                    pp.load_config(path,doc)
            self.assertEqual(run({**catalog,'pi':{**catalog['pi'],'isolated':{}}},'linux')['error'],
                             'the isolated Pi provider needs a macos host')

if __name__=='__main__':unittest.main()

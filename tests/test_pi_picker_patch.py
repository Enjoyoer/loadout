import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / 'skills/orchestration/personal-skills/scripts/pi/picker-patch.py'
spec = importlib.util.spec_from_file_location('picker_patch', SOURCE)
picker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(picker)

BUNDLE = '''const c=()=>null,u=()=>null,e={};
e.buildProviderSelectorProviders=function(o){return o.providerDefinitions.map(n=>({id:n.id,label:n.label,modelSelection:c(n.id,n.label,o.modelsByProvider.has(n.id)?o.modelsByProvider.get(n.id)??[]:null)}))};
e.buildSelectableProviderSelectorProviders=function(o){return(o??[]).filter(o=>o.enabled).map(o=>{const n=o.label??o.provider;return{id:o.provider,label:n,modelSelection:u(o,n)}})};
'''
PROFILE_BROWSER = '''const I={isWeb:true};
e.useModelBrowser=function(t){const {autoFocusSearch:h,profiles:v,serverId:b}=t,y=void 0===h?I.isWeb:h,P=void 0===v?null:v,S=void 0===b?null:b,{t:x}={t:()=>""};return P};
'''

class PickerPatchTests(unittest.TestCase):
    def test_free_opencode_models_remain_first_class_in_both_picker_builders(self):
        fixture = BUNDLE.replace('c=()=>null,u=()=>null', 'c=(id,label,models)=>models,u=row=>row.models')
        script = picker.patch_text(fixture) + '''
const models=[{id:'opencode/space-bunny-free',label:'SBF'},{id:'opencode/muse-spark-1.3-contributor-free',label:'MS'}];
const definitions=['pi','codex','claude','opencode'].map(id=>({id,label:id}));
const snapshots=definitions.map(row=>({provider:row.id,enabled:true,models:row.id==='opencode'?models:[]}));
const a=e.buildProviderSelectorProviders({providerDefinitions:definitions,modelsByProvider:new Map([['opencode',models]])});
const b=e.buildSelectableProviderSelectorProviders(snapshots);
for(const rows of [a,b]) {
 if(JSON.stringify(rows.map(row=>row.id))!=='["pi","opencode"]')throw Error('OpenCode hidden');
 if(JSON.stringify(rows.find(row=>row.id==='opencode').modelSelection)!==JSON.stringify(models))throw Error('free rows altered');
}
'''
        result = subprocess.run(['node', '--input-type=module', '-e', script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_profiles_cannot_bypass_picker_filter(self):
        script = picker.patch_text(BUNDLE + PROFILE_BROWSER) + '''
const profiles=['pi','codex','claude','opencode'].map(provider=>({provider}));
const applyProfile=()=>{};const input={rows:profiles,applyProfile};
const before=JSON.stringify(profiles);const rows=e.useModelBrowser({profiles:input});
if(JSON.stringify(rows.rows.map(x=>x.provider))!=='["pi","opencode"]')throw Error('native profile bypass');
if(rows.applyProfile!==applyProfile)throw Error('profile callback changed');
if(JSON.stringify(profiles)!==before)throw Error('daemon profiles mutated');
if(e.useModelBrowser({})!==null)throw Error('absent profiles changed');
if(e.useModelBrowser({profiles:null})!==null)throw Error('loading profiles changed');
'''
        r=subprocess.run(['node','--input-type=module','-e',script],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)

    def test_unknown_profile_browser_layout_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'profile browser'):
            picker.patch_text(BUNDLE+'e.useModelBrowser=function(t){return t.profiles};')

    def test_entry_busts_renderer_cache_and_rolls_back_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'index-original.js';p.write_text(BUNDLE+PROFILE_BROWSER)
            entry=root/'index.html';before='<script src="/index-original.js" defer></script>';entry.write_text(before)
            picker.run(root,'apply');self.assertIn('?loadout-picker=',entry.read_text())
            self.assertFalse(picker.run(root,'reapply')['changed'])
            entry.write_text(before)
            with self.assertRaisesRegex(ValueError,'removed the patch'):picker.run(root,'check')
            picker.run(root,'reapply');picker.run(root,'rollback')
            self.assertEqual(entry.read_text(),before);self.assertEqual(p.read_text(),BUNDLE+PROFILE_BROWSER)

    def test_client_filters_only_native_rows_without_changing_inputs(self):
        script = picker.patch_text(BUNDLE) + '''
const ids=['pi','codex','claude','opencode'];const definitions=ids.map(id=>({id,label:id}));
const snapshots=ids.map(provider=>({provider,enabled:true}));const before=JSON.stringify([definitions,snapshots]);
const a=e.buildProviderSelectorProviders({providerDefinitions:definitions,modelsByProvider:new Map()});
const b=e.buildSelectableProviderSelectorProviders(snapshots);
if(JSON.stringify(a.map(x=>x.id))!=='["pi","opencode"]'||JSON.stringify(b.map(x=>x.id))!=='["pi","opencode"]')throw Error('visibility');
if(JSON.stringify([definitions,snapshots])!==before)throw Error('provider input mutation');
'''
        r=subprocess.run(['node','--input-type=module','-e',script],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)

    def test_update_reapply_and_guarded_byte_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'index-original.js';p.write_text(BUNDLE);before=p.read_bytes()
            self.assertTrue(picker.run(root,'apply')['changed'])
            self.assertFalse(picker.run(root,'reapply')['changed'])
            self.assertEqual(picker.run(root,'check')['picker'],'verified')
            picker.run(root,'rollback');self.assertEqual(p.read_bytes(),before)
            picker.run(root,'apply');p.write_text(BUNDLE+'// app update\n')
            with self.assertRaisesRegex(ValueError,'obsolete bundle'):picker.run(root,'rollback')
            picker.run(root,'reapply');picker.run(root,'rollback')
            self.assertEqual(p.read_text(),BUNDLE+'// app update\n')

    def test_preference_bootstrap_upgrade_preserves_original_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'index-original.js';p.write_text(BUNDLE)
            picker.run(root,'apply')
            migration="localStorage.setItem('example', 'pi')"
            picker.run(root,'apply',migration)
            self.assertIn(migration,p.read_text())
            self.assertFalse(picker.run(root,'reapply',migration)['changed'])
            picker.run(root,'rollback')
            self.assertEqual(p.read_text(),BUNDLE)

    def test_changed_preference_script_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'index-original.js';p.write_text(BUNDLE)
            picker.run(root,'apply',"localStorage.setItem('example', 'pi')")
            patched=p.read_bytes()
            with self.assertRaisesRegex(ValueError,'differs from the pinned'):
                picker.run(root,'apply',"localStorage.setItem('example', 'swapped')")
            self.assertEqual(p.read_bytes(),patched)

    def test_unsupported_client_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'index-unsupported.js';p.write_text('buildSelectableProviderSelectorProviders=function unsupported')
            before=p.read_bytes()
            with self.assertRaisesRegex(ValueError,'Unsupported'):picker.run(root,'apply')
            self.assertEqual(p.read_bytes(),before)
            self.assertFalse((root/'.loadout-picker-patch.json').exists())

if __name__=='__main__':unittest.main()

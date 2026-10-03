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

class PickerPatchTests(unittest.TestCase):
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

    def test_unsupported_client_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'index-unsupported.js';p.write_text('buildSelectableProviderSelectorProviders=function unsupported')
            before=p.read_bytes()
            with self.assertRaisesRegex(ValueError,'Unsupported'):picker.run(root,'apply')
            self.assertEqual(p.read_bytes(),before)
            self.assertFalse((root/'.loadout-picker-patch.json').exists())

if __name__=='__main__':unittest.main()

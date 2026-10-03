"""Hide native coding providers only in the client picker, preserving daemon routes."""
import argparse, hashlib, json, re, shutil
from pathlib import Path

def digest(data): return hashlib.sha256(data).hexdigest()

def patch_text(text):
    patterns = [
        (r'(buildSelectableProviderSelectorProviders=function\((\w+)\)\{return\(\2\?\?\[\]\)\.filter\((\w+)=>\3\.enabled)(\)\.map)',
         lambda m: m[1]+'&&!['+'"codex","claude"'+'].includes('+m[3]+'.provider)'+m[4]),
        (r'(buildProviderSelectorProviders=function\((\w+)\)\{return \2\.providerDefinitions)(\.map)',
         lambda m: m[1]+'.filter(p=>!["codex","claude"].includes(p.id))'+m[3]),
    ]
    result=text
    for pattern, replacement in patterns:
        result,count=re.subn(pattern,replacement,result)
        if count != 1: raise ValueError('Unsupported client bundle: expected exactly one picker builder')
    return result

def run(root, action, preferences_script=None):
    root=Path(root).resolve();state=root/'.loadout-picker-patch.json'
    if action=='rollback':
        info=json.loads(state.read_text())
        for row in info['files']:
            p=root/row['path'];b=root/row['backup']
            if digest(p.read_bytes()) not in {row['before'],row['after']}: raise ValueError('Client updated; do not restore an obsolete bundle')
            if digest(b.read_bytes())!=row['before']: raise ValueError('Backup digest differs')
        for row in info['files']:shutil.copy2(root/row['backup'],root/row['path'])
        state.unlink();return {'rollback':'verified'}
    candidates=[]
    for p in root.rglob('index-*.js'):
        text=p.read_text()
        if 'buildSelectableProviderSelectorProviders=function' in text:candidates.append(p)
    if len(candidates)!=1:raise ValueError('Expected exactly one supported web client bundle')
    p=candidates[0];data=p.read_bytes()
    if state.exists():
        info=json.loads(state.read_text());row=next((r for r in info['files'] if root/r['path']==p),None)
        if row and digest(data)==row['after']:
            if preferences_script is None or info.get('preferences_script') == preferences_script:
                return {'picker':'verified','changed':False,'bundle':str(p), 'preferences': bool(info.get('preferences_script'))}
            backup=root/row['backup']
            if digest(backup.read_bytes()) != row['before']: raise ValueError('Backup digest differs')
            data=backup.read_bytes()
        if action=='check':raise ValueError('App update removed the patch; run reapply')
        # New content must pass the same exact structural check before any write.
    after=patch_text(data.decode()).encode()
    if preferences_script:
        after=('try { '+preferences_script+'; } catch (error) { console.error("Loadout Pi preference migration failed", error); }\n').encode()+after
    if action=='check':return {'picker':'unpatched','supported':True,'bundle':str(p)}
    backup=p.with_name(p.name+'.loadout-before-'+digest(data)[:12])
    if backup.exists() and digest(backup.read_bytes()) != digest(data): raise ValueError('Backup digest differs')
    backup.write_bytes(data)
    info={'preferences_script':preferences_script, 'files':[{'path':str(p.relative_to(root)),'backup':str(backup.relative_to(root)),
        'before':digest(data),'after':digest(after)}]}
    state.write_text(json.dumps(info,indent=2)+'\n');p.write_bytes(after)
    if digest(p.read_bytes())!=info['files'][0]['after']:raise ValueError('Readback differs')
    return {'picker':'verified','changed':True,'bundle':str(p),'rollback':'picker-patch.py ROOT rollback'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root');p.add_argument('action',choices=['check','apply','reapply','rollback']);p.add_argument('--preferences-script',type=Path);a=p.parse_args()
    print(json.dumps(run(a.root,a.action,a.preferences_script.read_text() if a.preferences_script else None)))

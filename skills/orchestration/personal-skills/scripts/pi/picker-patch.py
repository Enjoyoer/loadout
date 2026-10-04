"""Hide native coding providers only in the client picker, preserving daemon routes."""
import argparse, hashlib, json, re, shutil
from pathlib import Path
PATCH_REVISION = 4

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
    # Filter launch choices inside the model browser, without changing the
    # shared daemon profile store or the profile editor used by existing agents.
    if 'e.useModelBrowser=function' in text:
        pattern = r'(e\.useModelBrowser=function\([^)]*\)\{.{0,300}?profiles:(\w+),.{0,150}?\b\w+=void 0===\2\?null:\2)(,)'
        def profiles(m):
            name=m[2]
            return m[1][:-len(name)]+'('+name+'==null?null:{...'+name+',rows:'+name+'.rows.filter(p=>!["codex","claude"].includes(p.provider))})'+m[3]
        result,count=re.subn(pattern,profiles,result)
        if count != 1: raise ValueError('Unsupported client profile browser: preserve original bundle')
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
            intact=all(digest((root/r['path']).read_bytes())==r['after'] for r in info['files'])
            if intact and info.get('patch_revision') == PATCH_REVISION and (preferences_script is None or info.get('preferences_script') == preferences_script):
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
    changes=[(p,data,after)]
    entry=root/'index.html'
    if entry.exists():
        previous=entry.read_bytes()
        if state.exists():
            record=next((r for r in info['files'] if r['path']=='index.html'),None)
            if record and digest(previous)==record['after']:
                previous=(root/record['backup']).read_bytes()
                if digest(previous)!=record['before']:raise ValueError('Entry backup digest differs')
        relative=re.escape(p.relative_to(root).as_posix())
        text,count=re.subn(r'(<script\b[^>]*\bsrc=["\']/?'+relative+r')(?:\?loadout-picker=[0-9a-f]+)?(["\'])',
            lambda m:m[1]+'?loadout-picker='+digest(after)[:16]+m[2],previous.decode())
        if count!=1:raise ValueError('Unsupported client entry: expected one bundle script')
        changes.append((entry,previous,text.encode()))
    records=[]
    for target,before,updated in changes:
        backup=target.with_name(target.name+'.loadout-before-'+digest(before)[:12])
        if backup.exists() and digest(backup.read_bytes())!=digest(before):raise ValueError('Backup digest differs')
        backup.write_bytes(before)
        records.append({'path':str(target.relative_to(root)),'backup':str(backup.relative_to(root)),
            'before':digest(before),'after':digest(updated)})
    info={'patch_revision':PATCH_REVISION,'preferences_script':preferences_script,'files':records}
    state.write_text(json.dumps(info,indent=2)+'\n')
    for target,before,updated in changes:
        target.write_bytes(updated)
        if digest(target.read_bytes())!=digest(updated):raise ValueError('Readback differs')
    return {'picker':'verified','changed':True,'bundle':str(p),'rollback':'picker-patch.py ROOT rollback'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root');p.add_argument('action',choices=['check','apply','reapply','rollback']);p.add_argument('--preferences-script',type=Path);a=p.parse_args()
    print(json.dumps(run(a.root,a.action,a.preferences_script.read_text() if a.preferences_script else None)))

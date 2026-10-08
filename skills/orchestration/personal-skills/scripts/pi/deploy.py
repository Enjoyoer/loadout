"""Per-host Pi deployment with a stock Paseo >=0.10.3 <0.12.0 version gate and guarded rollback.

Default action is plan. Apply/rollback are for an explicitly approved host only.
"""
import argparse, base64, hashlib, json, os, re, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
from configure import configure, safe_target
from credential import expand


def sha(data): return hashlib.sha256(data).hexdigest()


PASEO_RANGE = ((0, 10, 3), (0, 12, 0))  # >=0.10.3 <0.12.0, release versions only


def supported_paseo(version):
    match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', version) if isinstance(version, str) else None
    return bool(match) and PASEO_RANGE[0] <= tuple(map(int, match.groups())) < PASEO_RANGE[1]


def daemon_env(home):
    env = {k:v for k,v in os.environ.items() if k not in {'PASEO_HOST','PASEO_HOME','PASEO_AGENT_ID','PASEO_AGENT_CWD'}}
    if home is not None: env['PASEO_HOME'] = str(home)
    return env


def paseo_command():
    command = shutil.which('paseo.cmd' if os.name == 'nt' else 'paseo')
    if not command: raise ValueError('Paseo CLI is unavailable on this host')
    return command


def version_gate(home):
    result = subprocess.run([paseo_command(),'daemon','status','--json'], env=daemon_env(home), capture_output=True, text=True, check=True)
    status = json.loads(result.stdout)
    if not supported_paseo(status.get('daemonVersion')) or status.get('connectedDaemon') != 'reachable':
        raise ValueError('a reachable stock Paseo >=0.10.3 <0.12.0 daemon is required')
    return status


def restore(record, home, activate):
    path = Path(record['config'])
    if sha(path.read_bytes()) not in {record['after_sha256'], record['before_sha256']}:
        raise ValueError('daemon config changed since apply; preserve it and reconcile the backup')
    backup = Path(record['backup'])
    if sha(backup.read_bytes()) != record['before_sha256']: raise ValueError('rollback backup changed')
    temp = path.with_name(path.name + '.pi-rollback-next')
    shutil.copy2(backup, temp); temp.replace(path)
    root = Path(record['root'])
    for name, previous in record['runtime_before'].items():
        target = root / name
        if previous is None: target.unlink(missing_ok=True)
        else:
            target.write_bytes(base64.b64decode(previous)); target.chmod(0o600)
    if activate: subprocess.run([paseo_command(),'reload'], env=daemon_env(home), check=True)
    if sha(path.read_bytes()) != record['before_sha256']: raise ValueError('rollback readback failed')
    print(json.dumps({'rollback':'verified', 'runtime_install_retained':True, 'config':str(path)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan','apply','rollback'])
    parser.add_argument('--spec'); parser.add_argument('--state', required=True)
    parser.add_argument('--paseo-home'); parser.add_argument('--activate', action='store_true')
    args = parser.parse_args()
    home = expand(args.paseo_home) if args.paseo_home else None
    status = version_gate(home)
    state = expand(args.state)
    if args.action == 'rollback':
        restore(json.loads(state.read_text()), home, args.activate); return
    proposal = json.loads(expand(args.spec).read_text())
    if 'agentProfiles' in proposal: raise ValueError('Pi deployment does not manage agent profiles')
    root = expand(proposal['root']); spec = proposal['runtime']
    config = (home or Path(status['home'])) / 'config.json'
    before = config.read_bytes(); cfg = json.loads(before)
    pi = proposal['provider']
    if proposal['catalog_model_id'] not in {row['id'] for row in pi.get('models', [])}:
        raise ValueError('proposal must use the catalog model ID verbatim')
    providers = cfg.setdefault('agents', {}).setdefault('providers', {})
    providers['pi'] = {**providers.get('pi', {}), **pi,
        'command':[shutil.which('node') or 'node', str(root / 'launch.mjs')]}
    daemon = cfg.setdefault('daemon', {})
    daemon['mcp'] = {**daemon.get('mcp', {}), 'enabled':True, 'injectIntoAgents':True}
    after = (json.dumps(cfg, indent=2)+'\n').encode()
    plan = configure(spec, root, dry_run=True)
    if args.action == 'plan':
        print(json.dumps({'daemonVersion':status['daemonVersion'], 'config_changed':before != after,
            'pi':plan, 'app_preferences':'apply separately in each UI client origin; see app-defaults.mjs'})); return
    if state.exists(): raise ValueError('state already exists; use a new state path')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = config.with_name(config.name + '.before-pi-' + stamp)
    shutil.copy2(config, backup)
    if backup.read_bytes() != before: raise ValueError('backup readback failed')
    names = ['runtime.json','credential.py','launch.mjs','mcp_bridge.py','fleet-routing.mjs','agent/models.json','agent/settings.json','agent/mcp.json']
    runtime_before = {}
    for name in names:
        target = root / name
        safe_target(root, target)
        runtime_before[name] = base64.b64encode(target.read_bytes()).decode() if target.exists() else None
    record = {'config':str(config), 'backup':str(backup), 'before_sha256':sha(before),
        'after_sha256':sha(after), 'root':str(root), 'runtime_before':runtime_before}
    state.parent.mkdir(parents=True, exist_ok=True); state.write_text(json.dumps(record,indent=2)+'\n'); state.chmod(0o600)
    app = root / 'app'; pkg = app / 'node_modules/@earendil-works/pi-coding-agent/package.json'
    if not pkg.exists():
        app.mkdir(parents=True, exist_ok=True)
        subprocess.run(['npm.cmd' if os.name=='nt' else 'npm','install','--prefix',str(app),
                        '--ignore-scripts','--save-exact','@earendil-works/pi-coding-agent@1.0.0'],check=True)
    if json.loads(pkg.read_text()).get('version') != '1.0.0': raise ValueError('official Pi version differs')
    configure(spec, root)
    temp = config.with_name(config.name + '.pi-next'); temp.write_bytes(after); temp.chmod(0o600); temp.replace(config)
    if config.read_bytes() != after: raise ValueError('config readback failed')
    if args.activate: subprocess.run([paseo_command(),'reload'], env=daemon_env(home),check=True)
    print(json.dumps({'apply':'verified','state':str(state),'rollback':'use rollback --state with this same file',
                      'ui_preferences':'not applied by daemon config; apply in each UI client'}))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Pi deployment stopped: '+str(error),file=sys.stderr);sys.exit(1)

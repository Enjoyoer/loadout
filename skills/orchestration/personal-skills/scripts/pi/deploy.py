"""Per-host Pi deployment with a stock Paseo >=0.10.3 <0.12.0 version gate and guarded rollback.

Default action is plan. Apply/rollback are for an explicitly approved host only.
"""
import argparse, base64, hashlib, json, os, re, secrets, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
from configure import configure, runtime_contents, safe_target
from credential import expand


def sha(data): return hashlib.sha256(data).hexdigest()


PASEO_RANGE = ((0, 10, 3), (0, 12, 0))  # >=0.10.3 <0.12.0, release versions only
# The runtime files apply writes and rollback restores, relative to the runtime root. Rollback touches no other path.
RUNTIME = ('runtime.json','credential.py','launch.mjs','mcp_bridge.py','fleet-routing.mjs','agent/models.json','agent/settings.json','agent/mcp.json')


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


def new_file(path, data):
    """Create path owner-only and exclusively, never over an existing file."""
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600), 'wb') as handle:
        handle.write(data)


def replace(path, data):
    """Replace path atomically with owner-only data, through a temp file no other run uses."""
    temp = path.with_name(path.name + '.loadout-' + secrets.token_hex(4))
    new_file(temp, data); temp.replace(path)


def merged(before, root, pi):
    """The daemon config revision `before` with the Pi provider and daemon MCP applied."""
    cfg = json.loads(before)
    providers = cfg.setdefault('agents', {}).setdefault('providers', {})
    providers['pi'] = {**providers.get('pi', {}), **pi,
        'command':[shutil.which('node') or 'node', str(root / 'launch.mjs')]}
    daemon = cfg.setdefault('daemon', {})
    daemon['mcp'] = {**daemon.get('mcp', {}), 'enabled':True, 'injectIntoAgents':True}
    return (json.dumps(cfg, indent=2)+'\n').encode()


def back_up(config, data):
    """An owner-only copy of the config revision about to be replaced, under a name no earlier backup has."""
    backup = config.with_name(config.name + '.before-pi-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    new_file(backup, data)
    if backup.read_bytes() != data: raise ValueError('backup readback failed')
    return backup


def runtime_restores(record):
    """The (path, prior bytes or None) rollback writes back, once every runtime file is checked.

    Each RUNTIME file must be a regular file (or absent) with no symlink or junction up to the root, holding what
    apply found there or what it wrote. Anything else is an edit made since apply, so rollback refuses, including
    for a file it would delete, before changing anything.
    """
    root = Path(record['root'])
    before, applied = record['runtime_before'], record.get('runtime_applied')
    if set(before) != set(RUNTIME) or not isinstance(applied, dict) or set(applied) != set(RUNTIME):
        raise ValueError('state has no per-file runtime hashes; check the runtime files and restore them by hand')
    restores = []
    for name in RUNTIME:
        target = root / name
        safe_target(root, target)
        if target.exists() and not target.is_file(): raise ValueError('runtime ' + name + ' is not a regular file')
        prior = None if before[name] is None else base64.b64decode(before[name])
        current, wanted = (sha(target.read_bytes()) if target.exists() else None), (None if prior is None else sha(prior))
        if current not in {wanted, applied[name]}:
            raise ValueError('runtime ' + name + ' changed since apply; preserve it and reconcile by hand')
        if current != wanted: restores.append((target, prior))
    return restores


def restore(record, home, activate):
    path = Path(record['config'])
    if sha(path.read_bytes()) not in {record['after_sha256'], record['before_sha256']}:
        raise ValueError('daemon config changed since apply; preserve it and reconcile the backup')
    backup = Path(record['backup'])
    if sha(backup.read_bytes()) != record['before_sha256']: raise ValueError('rollback backup changed')
    # The runtime is checked whole, then restored and verified, before the daemon config changes or reloads.
    restores = runtime_restores(record)
    for target, prior in restores:
        if prior is None: target.unlink()
        else: replace(target, prior)
    for target, prior in restores:
        if (target.read_bytes() if target.exists() else None) != prior: raise ValueError('runtime readback failed: ' + str(target))
    temp = path.with_name(path.name + '.pi-rollback-next')
    shutil.copy2(backup, temp); temp.replace(path)
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
    before = config.read_bytes()
    pi = proposal['provider']
    if proposal['catalog_model_id'] not in {row['id'] for row in pi.get('models', [])}:
        raise ValueError('proposal must use the catalog model ID verbatim')
    after = merged(before, root, pi)
    plan = configure(spec, root, dry_run=True)
    if args.action == 'plan':
        print(json.dumps({'daemonVersion':status['daemonVersion'], 'config_changed':before != after,
            'pi':plan, 'app_preferences':'apply separately in each UI client origin; see app-defaults.mjs'})); return
    if state.exists(): raise ValueError('state already exists; use a new state path')
    backup = back_up(config, before)
    contents = runtime_contents(spec, root)
    if set(contents) != set(RUNTIME): raise ValueError('runtime files differ from the rollback record')
    runtime_before = {}
    for name in RUNTIME:
        target = root / name
        safe_target(root, target)
        runtime_before[name] = base64.b64encode(target.read_bytes()).decode() if target.exists() else None
    # Each file's prior bytes and the hash apply writes, so rollback can tell apply's writes, an interrupted apply
    # included, from later edits.
    record = {'config':str(config), 'backup':str(backup), 'before_sha256':sha(before),
        'after_sha256':sha(after), 'root':str(root), 'runtime_before':runtime_before,
        'runtime_applied':{name: sha(contents[name]) for name in RUNTIME}}
    state.parent.mkdir(parents=True, exist_ok=True)
    # Owner-only from creation: the record holds base64 copies of the prior runtime files.
    new_file(state, (json.dumps(record,indent=2)+'\n').encode())
    app = root / 'app'; pkg = app / 'node_modules/@earendil-works/pi-coding-agent/package.json'
    if not pkg.exists():
        app.mkdir(parents=True, exist_ok=True)
        subprocess.run(['npm.cmd' if os.name=='nt' else 'npm','install','--prefix',str(app),
                        '--ignore-scripts','--save-exact','@earendil-works/pi-coding-agent@1.0.0'],check=True)
    if json.loads(pkg.read_text()).get('version') != '1.0.0': raise ValueError('official Pi version differs')
    configure(spec, root)
    # Another controller may have written the config during the install and configure: merge onto that revision
    # instead, back it up and record it, so its change survives and rollback restores it. Replace only while the
    # config still holds the revision merged.
    temp = config.with_name(config.name + '.pi-next')
    for _ in range(3):
        current = config.read_bytes()
        if current != before:
            before, after = current, merged(current, root, pi)
            record.update(backup=str(back_up(config, before)), before_sha256=sha(before), after_sha256=sha(after))
            replace(state, (json.dumps(record,indent=2)+'\n').encode())
        temp.write_bytes(after); temp.chmod(0o600)
        if config.read_bytes() == before:
            temp.replace(config); break
    else:
        temp.unlink(missing_ok=True)
        raise ValueError('daemon config kept changing during apply; it was not replaced')
    if config.read_bytes() != after: raise ValueError('config readback failed')
    if args.activate: subprocess.run([paseo_command(),'reload'], env=daemon_env(home),check=True)
    print(json.dumps({'apply':'verified','state':str(state),'rollback':'use rollback --state with this same file',
                      'ui_preferences':'not applied by daemon config; apply in each UI client'}))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Pi deployment stopped: '+str(error),file=sys.stderr);sys.exit(1)

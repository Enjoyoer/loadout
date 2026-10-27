import base64
import gzip
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from pathlib import Path, PureWindowsPath

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills/orchestration/personal-skills/scripts"
EXAMPLE = REPO / "skills/orchestration/personal-skills/fleet/example"
sys.path.insert(0, str(SCRIPTS))
import fleet  # noqa: E402
import paseo_providers  # noqa: E402

from fake_commands import assert_fake, install_fake_provider_paseo, install_fake_ssh, with_fakes

HOSTS = {
    "schema_version": 2,
    "source_host": "laptop",
    "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"], "sync": ["skills", "providers"]},
        {"name": "desktop", "os": "linux", "sync": ["providers"]},
        {"name": "tablet", "os": "linux", "transport": "paseo-relay", "sync": ["providers"],
         "paseo_offer": "offers/tablet.offer"},
        {"name": "devbox", "os": "linux", "clients": ["codex"]},
    ],
}

EXISTING = {
    "daemon": {"port": 1234},
    "agents": {"providers": {
        "claude": {"command": "claude", "env": {"EXTRA": "keep", "ANTHROPIC_BASE_URL": "https://tablet-own.example.test"},
                   "models": [{"id": "old", "label": "Old 1"}]},
        "opencode": {"models": [{"id": "local/x", "label": "X"}]},
    }},
}


class ProviderSyncTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = self.root / "fleet"
        (self.fleet / "offers").mkdir(parents=True)
        (self.fleet / "hosts.json").write_text(json.dumps(HOSTS))
        shutil.copy(EXAMPLE / "paseo-providers.json", self.fleet / "paseo-providers.json")
        (self.fleet / "offers/tablet.offer").write_text("offer:tablet\n")
        self.ssh = install_fake_ssh(self.root / "bin")
        self.paseo = install_fake_provider_paseo(self.root / "bin")
        for host in ("laptop", "desktop", "tablet", "devbox"):
            config = self.config_path(host)
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps(EXISTING, indent=2))
        self.env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.root / "hosts/laptop"),
            "LOADOUT_FLEET": str(self.fleet),
            "FAKE_ROOT": str(self.root),
            "FAKE_SSH_LOG": str(self.root / "calls.log"),
            # A host's paseo, run over the fake ssh.
            "LOADOUT_TEST_PASEO": json.dumps(self.paseo),
            "TMPDIR": str(self.root),
            # An agent session's variables must not reach the relay CLI.
            "PASEO_HOME": str(self.root / "agent-home"),
            "PASEO_AGENT_ID": "agent-1",
            "PASEO_AGENT_CWD": str(self.root),
            "LOADOUT_RELAY_POLL_SECONDS": "0.05",
            "LOADOUT_RELAY_WAIT_SECONDS": "3",
            "LOADOUT_RELAY_READY_SECONDS": "2",
            "LOADOUT_RELAY_SETTLE_SECONDS": "0",
            "LOADOUT_RELAY_RESEND_SECONDS": "0.5",
        }
        self.env.update({k: v for k, v in os.environ.items()
                         if k.upper() in ("SYSTEMROOT", "TEMP", "TMP")})
        self.env["USERPROFILE"] = self.env["HOME"]
        self.env["APPDATA"] = str(self.root / "hosts/laptop/.config")
        assert_fake(self.ssh, self.env)
        assert_fake(self.paseo, self.env)
        # In-process runs reach the same fakes through the module hooks.
        for module, name, fake in ((fleet, "SSH_COMMAND", self.ssh), (paseo_providers, "PASEO_COMMAND", self.paseo)):
            hook = patch.object(module, name, fake)
            hook.start()
            self.addCleanup(hook.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def config_path(self, host):
        return self.root / "hosts" / host / ".paseo/config.json"

    def config(self, host):
        return json.loads(self.config_path(host).read_text())

    def run_sync(self, *args):
        done = subprocess.run(with_fakes(SCRIPTS / "paseo_providers.py", *args, ssh=self.ssh, paseo=self.paseo),
                              env=self.env, capture_output=True, text=True, timeout=60)
        return done.returncode, done.stdout + done.stderr

    def calls(self):
        path = self.root / "calls.log"
        return path.read_text() if path.exists() else ""

    def long_payload(self):
        catalog = json.loads((self.fleet / "paseo-providers.json").read_text())
        # Incompressible metadata models the generated runtime source payload.
        catalog["providers"]["codex"]["models"][0]["description"] = os.urandom(24000).hex()
        (self.fleet / "paseo-providers.json").write_text(json.dumps(catalog))
        return catalog

    @unittest.skipIf(os.name == 'nt', 'POSIX env-file launch wiring')
    def test_mcp_env_file_wires_provider_launch_without_copying_credentials(self):
        hosts = json.loads((self.fleet / 'hosts.json').read_text())
        hosts['hosts'][0]['sync'].append('client-config')
        (self.fleet / 'hosts.json').write_text(json.dumps(hosts))
        (self.fleet / 'client-config.json').write_text(json.dumps({'mcpServers': {'ebay-analyze': {
            'url': 'http://192.0.2.40:8766/mcp', 'bearerTokenEnvVar': 'EBAY_ANALYZE_MCP_TOKEN',
            'hosts': {'laptop': True}}}}))
        home = self.root / 'hosts/laptop'
        env_file = home / '.config/ebay-analyze/mcp.env'
        env_file.parent.mkdir(parents=True)
        env_file.write_text('EBAY_ANALYZE_MCP_TOKEN=fixture-only\n')
        env_file.chmod(0o600)
        # A Pi-configured providers fleet, as on a real Pi host: the providers step generates the Pi row and runs
        # its runtime step against an installed Pi and a stock daemon.
        node, pi_root = shutil.which('node'), home / 'pi'
        package = pi_root / 'app/node_modules/@earendil-works/pi-coding-agent/package.json'
        package.parent.mkdir(parents=True)
        package.write_text('{"version":"1.0.0"}')
        daemon_bin = self.root / 'daemon-bin'
        daemon_bin.mkdir()
        (daemon_bin / 'paseo').write_text("#!/bin/sh\necho '{\"daemonVersion\":\"0.10.3\",\"connectedDaemon\":\"reachable\"}'\n")
        (daemon_bin / 'paseo').chmod(0o755)
        self.env['PATH'] = str(daemon_bin) + os.pathsep + self.env['PATH']
        catalog = json.loads((self.fleet / 'paseo-providers.json').read_text())
        catalog['pi'] = {'root': str(pi_root), 'runtime': {'baseUrl': 'https://router.example.test/v1',
                         'credential': {'kind': 'env', 'name': 'EXISTING_KEY'},
                         'paseoMcp': {'url': 'http://127.0.0.1:6767/mcp/agents'}}}
        (self.fleet / 'paseo-providers.json').write_text(json.dumps(catalog))
        code, out = self.run_sync('--host', 'laptop', '--dry-run')
        self.assertEqual(code, 0, out)
        self.assertFalse((home / '.config/loadout/mcp-env.cjs').exists())
        self.assertEqual(self.config('laptop'), EXISTING)
        code, out = self.run_sync('--host', 'laptop')
        self.assertEqual(code, 0, out)
        command = self.config('laptop')['agents']['providers']['codex']['command']
        self.assertEqual(command[2:], ['--', 'codex'])
        self.assertNotIn('fixture-only', self.config_path('laptop').read_text())
        self.assertNotIn('fixture-only', out)
        probe = subprocess.run([*command[:3], 'node', '-e', 'console.log(process.env.EBAY_ANALYZE_MCP_TOKEN.length)'],
                               env={**self.env, 'HOME': str(home)}, capture_output=True, text=True)
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertEqual(probe.stdout.strip(), '12')
        wrapped = self.config('laptop')['agents']['providers']['pi']['command']
        self.assertEqual(wrapped, [*command[:3], 'node', str(pi_root) + '/launch.mjs'])
        # Pi deploy apply after the providers step, with the proposal that step derived and node resolved to its
        # absolute path, keeps the wrapped command byte for byte, and the next providers step writes nothing.
        sys.path.insert(0, str(SCRIPTS / 'pi'))
        import deploy
        config = paseo_providers.load_for_hosts(fleet.load(self.fleet), self.fleet)
        proposal = paseo_providers.payload(config, 'laptop', 'test', False)['pi']
        apply = lambda path, root: path.write_bytes(deploy.merged(path.read_bytes(), root, proposal['provider'],
                                                                  deploy.providers_root(proposal['root'])))
        with patch.object(deploy.shutil, 'which', return_value=node):
            apply(self.config_path('laptop'), deploy.expand(proposal['root']))
        self.assertEqual(self.config('laptop')['agents']['providers']['pi']['command'], wrapped)
        code, out = self.run_sync('--host', 'laptop')
        self.assertEqual(code, 0, out)
        self.assertIn('write unchanged', out)
        self.assertEqual(self.config('laptop')['agents']['providers']['codex']['command'], command)
        self.assertEqual(self.config('laptop')['agents']['providers']['pi']['command'], wrapped)
        # The same round trip with a Windows Pi root, through the real merge program: the providers step builds
        # `<root>/launch.mjs` with a forward slash. The runtime step is left out, since that root is not on this host.
        win_root = r'C:\Users\example\AppData\Local\loadout-pi'
        config['pi']['root'] = win_root
        data = paseo_providers.payload(config, 'laptop', 'test', False)
        proposal, data['pi'] = data['pi'], None
        win_config = self.root / 'win-config.json'
        data['config_path'] = str(win_config)
        program = self.root / 'merge.js'
        program.write_text(fleet.COMMON_JS.read_text() + '\n' + (SCRIPTS / 'paseo_providers_merge.js').read_text())
        packed = base64.b64encode(gzip.compress(json.dumps(data).encode())).decode()
        merge = lambda: paseo_providers.parse_result(subprocess.run(['node', str(program), packed], env=self.env,
                                                                    capture_output=True, text=True).stdout)
        win_pi = lambda: json.loads(win_config.read_text())['agents']['providers']['pi']['command']
        win_config.write_text('{"agents":{"providers":{}}}')
        got = merge()
        self.assertEqual((got['error'], got['wrote']), (None, True))
        windows = win_pi()
        self.assertEqual(windows, [*command[:3], 'node', win_root + '/launch.mjs'])
        # Apply over the providers step's command, and over one an earlier apply left with another root: both end
        # as the providers step's bytes, so the next merge changes nothing.
        stale = json.loads(win_config.read_text())
        stale['agents']['providers']['pi']['command'] = [*command[:3], node, r'C:\Old\pi\launch.mjs']
        for before in (win_config.read_text(), json.dumps(stale)):
            win_config.write_text(before)
            with patch.object(deploy.shutil, 'which', return_value=r'C:\Node\node.exe'):
                apply(win_config, PureWindowsPath(win_root))
            self.assertEqual(win_pi(), windows)
            got = merge()
            self.assertEqual((got['error'], got['changed'], got['wrote']), (None, False, False))
            self.assertEqual(win_pi(), windows)

    @unittest.skipUnless(os.name == 'nt', 'Windows user-env launch wiring')
    def test_mcp_user_env_is_read_at_each_windows_launch(self):
        name = f'LOADOUT_TEST_MCP_TOKEN_{os.getpid()}'
        reg = lambda *args: subprocess.run(['reg.exe', *args, '/f'], check=True, capture_output=True)
        user_env = lambda value: reg('add', r'HKCU\Environment', '/v', name, '/t', 'REG_SZ', '/d', value)
        self.addCleanup(subprocess.run, ['reg.exe', 'delete', r'HKCU\Environment', '/v', name, '/f'], capture_output=True)
        user_env('first-fixture')
        hosts = json.loads((self.fleet / 'hosts.json').read_text())
        hosts['hosts'][0].update(os='windows', sync=[*hosts['hosts'][0]['sync'], 'client-config'])
        (self.fleet / 'hosts.json').write_text(json.dumps(hosts))
        (self.fleet / 'client-config.json').write_text(json.dumps({'mcpServers': {'ebay-analyze': {
            'url': 'http://192.0.2.40:8766/mcp', 'bearerTokenEnvVar': name, 'hosts': {'laptop': True}}}}))
        code, out = self.run_sync('--host', 'laptop')
        self.assertEqual(code, 0, out)
        self.assertIn(name + ' user env length=13; read at each launch', out)
        command = self.config('laptop')['agents']['providers']['codex']['command']
        self.assertEqual(command[2:], ['--', 'codex'])
        self.assertNotIn('first-fixture', self.config_path('laptop').read_text() + out)
        # The codex slot launched with node in place of codex, under a daemon that inherited a stale value.
        probe = lambda: subprocess.run([*command[:3], 'node', '-e', f'console.log(process.env.{name}.length)'],
                                       env={**self.env, name: 'stale'}, capture_output=True, text=True, timeout=60)
        self.assertEqual(probe().stdout.strip(), '13')
        # A rotation reaches the next launch with no daemon restart.
        user_env('rotated-fixture-value')
        self.assertEqual(probe().stdout.strip(), '21')
        # A deleted value keeps the inherited one and names only the variable.
        reg('delete', r'HKCU\Environment', '/v', name)
        done = probe()
        self.assertEqual((done.returncode, done.stdout.strip()), (0, '5'), done.stderr)
        self.assertIn('no usable ' + name, done.stderr)

    def test_launch_settings_route_paseo_harnesses_with_an_owner_only_token_file(self):
        catalog = json.loads((self.fleet / 'paseo-providers.json').read_text())
        overlay = json.loads((EXAMPLE / 'routed-launch-overlay.json').read_text())
        catalog['hosts']['laptop'] = overlay['hosts']['tablet']
        (self.fleet / 'paseo-providers.json').write_text(json.dumps(catalog))
        home = self.root / 'hosts/laptop'
        token = home / '.config/example-router/api-key'
        token.parent.mkdir(parents=True)
        token.write_text('fixture-token\n')
        if os.name != 'nt':
            token.chmod(0o644)
        # Unsafe: group-readable on POSIX, the inherited temp-directory ACL on Windows.
        code, out = self.run_sync('--host', 'laptop')
        self.assertEqual(code, 1, out)
        self.assertIn('token file missing or unsafe for claude ANTHROPIC_AUTH_TOKEN', out)
        if os.name == 'nt':
            # The documented recipe: a new file created owner-only, the value from the environment.
            token.unlink()
            subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                            str(SCRIPTS / 'new_token_file.ps1'), '-Path', str(token), '-FromEnv', 'FIXTURE_KEY'],
                           check=True, capture_output=True, env={**os.environ, 'FIXTURE_KEY': 'fixture-token'})
        else:
            token.chmod(0o600)
        code, out = self.run_sync('--host', 'laptop')
        self.assertEqual(code, 0, out)
        self.assertIn('tokenFile ~/.config/example-router/api-key present, owner-only', out)
        providers = self.config('laptop')['agents']['providers']
        self.assertEqual(providers['codex']['command'][2:], ['--provider', 'codex', '--', 'codex'])
        self.assertEqual(providers['claude']['command'][2:], ['--provider', 'claude', '--', 'claude'])
        self.assertNotIn('fixture-token', self.config_path('laptop').read_text() + out)
        # A fake codex shim, a .cmd on Windows, that reports its argv; Paseo appends the app-server subcommand.
        bin_dir = self.root / 'harness-bin'
        bin_dir.mkdir()
        (bin_dir / 'codex.js').write_text('console.log(JSON.stringify(process.argv.slice(2)))\n')
        if os.name == 'nt':
            (bin_dir / 'codex.cmd').write_text('@node "%~dp0\\codex.js" %*\r\n')
        else:
            (bin_dir / 'codex').write_text('#!/bin/sh\nexec node "$(dirname "$0")/codex.js" "$@"\n')
            (bin_dir / 'codex').chmod(0o755)
        # Windows PATH entries may be quoted, as Paseo's resolver accepts.
        entry = f'"{bin_dir}"' if os.name == 'nt' else str(bin_dir)
        env = {**self.env, 'PATH': entry + os.pathsep + self.env['PATH']}
        # Arguments arrive literally: no shell expands or splits them.
        literal = '%ANTHROPIC_AUTH_TOKEN%&echo !x! "q"'
        done = subprocess.run([*providers['codex']['command'], 'app-server', '--listen', literal], env=env,
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), ['-c', 'model_provider="example_router"', 'app-server', '--listen', literal])
        # The claude slot launched with node in place of claude: node.exe resolves through PATH and PATHEXT.
        done = subprocess.run([*providers['claude']['command'][:5], 'node', '-e',
                               'console.log(process.env.ANTHROPIC_AUTH_TOKEN.length)'], env=env,
                              capture_output=True, text=True, timeout=60)
        self.assertEqual((done.returncode, done.stdout.strip()), (0, '13'), done.stderr)

    def test_long_payload_windows_cmd_uses_stdin_and_is_idempotent(self):
        hosts = json.loads((self.fleet / "hosts.json").read_text())
        hosts["hosts"][1]["os"] = "windows"
        (self.fleet / "hosts.json").write_text(json.dumps(hosts))
        (self.root / "cmd-limit").touch()
        catalog = self.long_payload()
        code, out = self.run_sync("--host", "desktop", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.config("desktop"), EXISTING)
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.config("desktop")["agents"]["providers"]["codex"]["models"],
                         catalog["providers"]["codex"]["models"])
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertIn("write unchanged", out)

    def test_corrupt_ssh_payload_never_merges_or_reloads(self):
        (self.root / "corrupt-stdin").touch()
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 1, out)
        self.assertIn("provider transport failed", out)
        self.assertEqual(self.config("desktop"), EXISTING)
        self.assertNotIn("reload", self.calls())

    def test_long_relay_payload_is_bounded_verified_and_idempotent(self):
        (self.root / "input-limit").touch()
        catalog = self.long_payload()
        # The first send is lost, then resent safely before the chunks run.
        (self.root / "drop-sends").write_text("1")
        with patch.dict(os.environ, self.env):
            runner = paseo_providers.Runner(HOSTS["hosts"][2], "laptop", self.fleet)
            program = fleet.pack(paseo_providers.MERGE_JS.read_bytes())
            data = fleet.pack(json.dumps(paseo_providers.payload(catalog, "tablet", "test", False)).encode())
            # Module constants were loaded before the subprocess test overrides.
            with patch.multiple(paseo_providers, RELAY_POLL_SECONDS=0.01, RELAY_WAIT_SECONDS=3,
                                RELAY_SETTLE_SECONDS=0, RELAY_RESEND_SECONDS=0.05):
                out = runner.write(program, data)
                self.assertTrue(fleet.parse_result(out)["changed"], out)
                out = runner.write(program, data)
                self.assertFalse(fleet.parse_result(out)["changed"], out)
        self.assertEqual(self.config("tablet")["agents"]["providers"]["codex"]["models"],
                         catalog["providers"]["codex"]["models"])
        self.assertEqual((self.root / "workspaces").read_text(), "")
        self.assertIn("conv=notrunc", self.calls())
        self.assertEqual(list(self.root.glob("loadout-provider-*")), [])

    def test_corrupt_long_relay_payload_is_removed_without_merge(self):
        (self.root / "input-limit").touch()
        (self.root / "corrupt-relay").touch()
        self.long_payload()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.config("tablet"), EXISTING)
        self.assertNotIn("reload", self.calls())
        self.assertEqual(list(self.root.glob("loadout-provider-*")), [])
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_dry_run_writes_nothing(self):
        code, out = self.run_sync("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn(f"fleet: env {self.fleet}", out)
        self.assertIn("skipped (no providers scope): devbox", out)
        self.assertEqual(out.count("would change (dry run)"), 3, out)
        self.assertEqual(out.count("reload skipped (dry run)"), 3, out)
        for host in ("laptop", "desktop", "tablet"):
            self.assertEqual(self.config(host), EXISTING)
        self.assertNotIn("reload", self.calls())

    def test_sync_merges_backs_up_and_reloads_each_transport(self):
        code, out = self.run_sync()
        self.assertEqual(code, 0, out)
        catalog = json.loads((self.fleet / "paseo-providers.json").read_text())["providers"]
        for host, base in (("laptop", "http://127.0.0.1:4000"), ("desktop", "https://router.example.test"),
                           ("tablet", "https://tablet-own.example.test")):
            got = self.config(host)
            self.assertEqual(got["daemon"], {"port": 1234})
            providers = got["agents"]["providers"]
            self.assertEqual(providers["opencode"], EXISTING["agents"]["providers"]["opencode"])
            self.assertEqual(providers["claude"]["command"], "claude")
            self.assertEqual(providers["claude"]["env"], {"EXTRA": "keep", "ANTHROPIC_BASE_URL": base})
            self.assertEqual(providers["claude"]["models"], catalog["claude"]["models"])
            self.assertEqual(providers["codex"]["models"], catalog["codex"]["models"])
            backups = list(self.config_path(host).parent.glob("config.json.bak-loadout-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(json.loads(backups[0].read_text()), EXISTING)
        self.assertIn("laptop (local): write CHANGED; labels verified; preserved [opencode]", out)
        self.assertIn("desktop (ssh): write CHANGED", out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        self.assertEqual(out.count("reload ok"), 3, out)
        calls = self.calls()
        self.assertIn("paseo local reload", calls)
        self.assertIn("ssh desktop", calls)
        self.assertIn("paseo tablet workspace archive ws-1", calls)
        self.assertIn("paseo tablet reload", calls)
        self.assertEqual(self.config("devbox"), EXISTING)

        code, out = self.run_sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("write unchanged; labels verified"), 3, out)
        self.assertEqual(len(list(self.config_path("laptop").parent.glob("config.json.bak-loadout-*"))), 1)

    def test_required_env_failure_still_cleans_up_relay(self):
        self.config_path("tablet").write_text(json.dumps({"agents": {"providers": {}}}))
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("tablet (paseo-relay): write FAILED: required env missing: claude.ANTHROPIC_BASE_URL", out)
        self.assertIn("workspace archive ws-1", self.calls())
        self.assertEqual(self.config("tablet"), {"agents": {"providers": {}}})

    def test_secret_looking_host_env_is_refused(self):
        catalog = json.loads((self.fleet / "paseo-providers.json").read_text())
        catalog["hosts"]["laptop"]["env"]["claude"]["ANTHROPIC_BASE_URL"] = "%EXAMPLE_API_KEY%"
        (self.fleet / "paseo-providers.json").write_text(json.dumps(catalog))
        self.env["EXAMPLE_API_KEY"] = "not-a-real-key"
        code, out = self.run_sync("--host", "laptop")
        self.assertEqual(code, 1, out)
        self.assertIn("refusing secret-looking host env EXAMPLE_API_KEY", out)
        self.assertEqual(self.config("laptop"), EXISTING)

    def test_secret_name_part_is_refused_but_longer_word_passes(self):
        catalog = json.loads((self.fleet / "paseo-providers.json").read_text())
        env = catalog["hosts"]["laptop"]["env"]["claude"]
        env["ANTHROPIC_BASE_URL"] = "%GITHUB_PAT%"
        (self.fleet / "paseo-providers.json").write_text(json.dumps(catalog))
        self.env["GITHUB_PAT"] = "not-a-real-token"
        code, out = self.run_sync("--host", "laptop")
        self.assertEqual(code, 1, out)
        self.assertIn("refusing secret-looking host env GITHUB_PAT", out)
        self.assertEqual(self.config("laptop"), EXISTING)

        # PAT inside a longer word (LOCALAPPDATA) is not a secret name.
        env["ANTHROPIC_BASE_URL"] = "%LOCALAPPDATA%"
        (self.fleet / "paseo-providers.json").write_text(json.dumps(catalog))
        self.env["LOCALAPPDATA"] = str(self.root / "appdata")
        code, out = self.run_sync("--host", "laptop")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.config("laptop")["agents"]["providers"]["claude"]["env"]["ANTHROPIC_BASE_URL"],
                         self.env["LOCALAPPDATA"])

    def test_relay_waits_for_the_prompt_before_one_send(self):
        (self.root / "quiet-captures").write_text("4")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        # Each command is sent once, whether the payload fits inline or needs bounded chunks.
        calls = self.calls().splitlines()
        sends = [line for line in calls if "terminal send-keys" in line]
        self.assertEqual(len(sends), len(set(sends)))
        send = next(i for i, line in enumerate(calls) if "send-keys" in line)
        self.assertEqual(sum("terminal capture" in line for line in calls[:send]), 5)

    def test_relay_resends_once_when_the_command_never_echoed(self):
        (self.root / "drop-sends").write_text("1")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        sends = [line for line in self.calls().splitlines() if "terminal send-keys" in line]
        self.assertEqual(len(sends), len(set(sends)) + 1)

    def test_relay_resend_is_bounded_to_one(self):
        (self.root / "drop-sends").write_text("5")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.calls().count("terminal send-keys"), 2)
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_never_resends_an_echoed_command(self):
        (self.root / "echo-only").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.calls().count("terminal send-keys"), 1)
        self.assertIn("did not finish within 3s; last output:", out)
        self.assertIn("@@LOADOUT-EXIT-", out)

    def test_relay_never_ready_times_out_and_cleans_up(self):
        (self.root / "quiet-captures").write_text("999")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("tablet (paseo-relay): write FAILED: relay terminal showed no shell prompt within 2s (readiness "
                      "timeout); nothing was sent", out)
        self.assertNotIn("send-keys", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_timeout_explains_and_cleans_up(self):
        (self.root / "drop-sends").write_text("99")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("relay terminal did not finish within 3s; last output: $", out)
        self.assertIn("terminal kill term-1", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "")
        self.assertEqual(self.config("tablet"), EXISTING)

    def test_relay_cleans_up_when_create_fails_after_the_host_made_it(self):
        (self.root / "fail-create").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("write FAILED: paseo workspace create: request timed out", out)
        self.assertIn("workspace archive ws-1", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_cleans_up_when_terminal_create_fails(self):
        (self.root / "fail-terminal").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("write FAILED: paseo terminal create: terminal failed", out)
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_cleanup_failure_after_timeout_names_the_workspace(self):
        (self.root / "drop-sends").write_text("99")
        (self.root / "fail-archive").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("relay workspace cleanup failed: ws-1", out)

    def test_relay_sweeps_workspaces_left_by_a_killed_run(self):
        (self.root / "workspaces").write_text("ws-old loadout-provider-sync\nws-keep someone-else\n")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("workspace archive ws-old", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "ws-keep someone-else\n")

    @unittest.skipIf(os.name == "nt", "Windows has no SIGTERM to catch: send_signal(SIGTERM) is TerminateProcess")
    def test_sigterm_still_cleans_up_the_relay_workspace(self):
        (self.root / "drop-sends").write_text("99")
        self.env["LOADOUT_RELAY_WAIT_SECONDS"] = "30"
        proc = subprocess.Popen(with_fakes(SCRIPTS / "paseo_providers.py", "--host", "tablet", ssh=self.ssh,
                                           paseo=self.paseo),
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(200):
            if "send-keys" in self.calls():
                break
            time.sleep(0.05)
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=30)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("terminal kill term-1", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_an_inherited_paseo_host_never_redirects_the_source_hosts_reload(self):
        # The session that starts the sync targets another daemon; the source host's reload must stay on its own.
        self.env["PASEO_HOST"] = "offer:desktop"
        code, out = self.run_sync("--host", "laptop")
        self.assertEqual(code, 0, out)
        self.assertIn("laptop (local): reload ok", out)
        self.assertIn("paseo local reload", self.calls())
        self.assertNotIn("paseo desktop", self.calls())
        self.assertNotEqual(self.config("laptop"), EXISTING)
        self.assertEqual(self.config("desktop"), EXISTING)
        # A host program on the source host, such as the plugin step's, inherits no daemon target either.
        probe = self.root / "probe.js"
        probe.write_text('process.stdout.write("\\n@@LOADOUT-RESULT " + JSON.stringify({host: process.env.PASEO_HOST '
                         '|| null, home: process.env.PASEO_HOME || null}) + " @@END\\n");\n')
        with patch.dict(os.environ, self.env):
            self.assertEqual(fleet.run_node("laptop", True, probe, {})[0], {"host": None, "home": None})

    def test_a_hosts_paseo_home_is_applied_and_an_inherited_one_ignored(self):
        # The session's PASEO_HOME (agent-home) never counts; laptop's hosts.json entry names its home instead.
        home = self.root / "hosts/laptop/work-paseo"
        hosts = json.loads((self.fleet / "hosts.json").read_text())
        hosts["hosts"][0]["paseo_home"] = str(home)
        (self.fleet / "hosts.json").write_text(json.dumps(hosts))
        home.mkdir()
        (home / "config.json").write_text(json.dumps(EXISTING))
        code, out = self.run_sync("--host", "laptop")
        self.assertEqual(code, 0, out)
        self.assertIn("laptop (local): reload ok", out)
        self.assertNotEqual(json.loads((home / "config.json").read_text()), EXISTING)
        self.assertEqual(self.config("laptop"), EXISTING)
        self.assertFalse((self.root / "agent-home").exists())
        # A host program, such as the plugin step's, gets the same home, ~ expanded on that host, locally and over ssh.
        probe = self.root / "probe.js"
        probe.write_text('process.stdout.write("\\n@@LOADOUT-RESULT " + JSON.stringify({home: process.env.PASEO_HOME '
                         '|| null}) + " @@END\\n");\n')
        with patch.dict(os.environ, self.env):
            for host, local in (("laptop", True), ("desktop", False)):
                result, output = fleet.run_node(host, local, probe, {}, 60, "~/work-paseo")
                self.assertEqual(os.path.normpath(result["home"]),
                                 os.path.normpath(self.root / "hosts" / host / "work-paseo"), output)
            self.assertEqual(fleet.run_node("laptop", True, probe, {})[0], {"home": None})

    def test_reload_failure_is_reported_apart_from_the_write(self):
        (self.root / "fail-reload-tablet").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        self.assertIn("tablet (paseo-relay): reload FAILED: request timed out; the write above still stands", out)

    def test_reload_failure_after_an_unchanged_write_is_a_warning(self):
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        (self.root / "fail-reload-tablet").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("tablet (paseo-relay): write unchanged", out)
        self.assertIn("tablet (paseo-relay): reload warning (config unchanged, not a failure): request timed out", out)
        self.assertNotIn("FAILED", out)

    def test_rerun_retries_an_owed_reload_and_fails_if_it_fails_again(self):
        (self.root / "fail-reload-tablet").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        code, out = self.run_sync("--host", "tablet", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r"tablet \(paseo-relay\): reload \(owed since \S+\) skipped \(dry run\); the real run retries it")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("tablet (paseo-relay): write unchanged", out)
        self.assertRegex(out, r"tablet \(paseo-relay\): reload \(owed since \S+\) FAILED: request timed out")
        self.assertEqual(self.calls().count("paseo tablet reload"), 2)
        (self.root / "fail-reload-tablet").unlink()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r"tablet \(paseo-relay\): reload \(owed since \S+\) ok")
        # Nothing is owed after a reload succeeds, so a later failure with an unchanged config is a warning.
        (self.root / "fail-reload-tablet").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("reload warning (config unchanged, not a failure)", out)

    def in_process(self):
        """The step's inputs for an in-process run against the fakes, and an environment keeping its record here."""
        doc = fleet.validate(HOSTS)
        return (doc, paseo_providers.load_config(self.fleet / "paseo-providers.json", doc),
                fleet.pack(paseo_providers.MERGE_JS.read_bytes()),
                patch.dict(os.environ, {**self.env, "XDG_CONFIG_HOME": str(self.root / "hosts/laptop/.config")}))

    def test_a_clear_by_an_older_operation_leaves_newer_debt_in_place(self):
        doc, catalog, program, env = self.in_process()
        lines = []
        with env:
            runner = paseo_providers.Runner(doc["hosts"][1], "laptop", self.fleet)
            write = runner.write

            def write_while_a_newer_run_starts(*args):
                output = write(*args)
                paseo_providers.update_owed("desktop", lambda debts: debts.update(
                    {"newer": {"since": "20261010-000001", "running": time.time()}}))
                return output

            runner.write = write_while_a_newer_run_starts
            status = paseo_providers.sync_host(runner, catalog, program, "20261010-000000", False, lines.append)
            owed = paseo_providers.owed_reloads()
        self.assertEqual(status, "updated", lines)
        self.assertIn("desktop (ssh): reload ok", lines)
        # This run's reload succeeded, but the newer run's debt is not this run's to clear.
        self.assertEqual(list(owed["desktop"]), ["newer"])

    def test_a_second_operation_while_one_is_in_flight_fails_and_does_not_write(self):
        doc, catalog, program, env = self.in_process()
        lines = []
        with env:
            first, second = (paseo_providers.Runner(doc["hosts"][1], "laptop", self.fleet) for _ in range(2))
            second.write = Mock(side_effect=AssertionError("the second operation wrote"))
            write = first.write

            def second_starts_during_this_write(*args):
                self.assertEqual(paseo_providers.sync_host(second, catalog, program, "20261010-000001", False,
                                                           lines.append), "FAILED")
                return write(*args)

            first.write = second_starts_during_this_write
            status = paseo_providers.sync_host(first, catalog, program, "20261010-000000", False, lines.append)
            owed = paseo_providers.owed_reloads()
        second.write.assert_not_called()
        self.assertIn("desktop (ssh): FAILED, nothing written: another provider sync is in flight on desktop "
                      "(since 20261010-000000); an entry left by a killed run expires after 24 hours", lines)
        self.assertEqual(status, "updated", lines)
        self.assertEqual(owed, {})

    def test_an_uncertain_write_is_paid_only_by_a_reload_after_twice_the_write_timeout(self):
        doc, catalog, program, env = self.in_process()
        lines, clock = [], [1_000_000.0]
        window = 2 * paseo_providers.WRITE_TIMEOUT_SECONDS
        with env, patch.object(paseo_providers, "now", lambda: clock[0]):
            host = doc["hosts"][1]
            lost = paseo_providers.Runner(host, "laptop", self.fleet)
            lost.write = Mock(side_effect=RuntimeError(f"timed out after {paseo_providers.WRITE_TIMEOUT_SECONDS}s"))
            self.assertEqual(paseo_providers.sync_host(lost, catalog, program, "20261010-000000", False, lines.append),
                             "FAILED")
            failed_at = clock[0]
            self.assertEqual(list(paseo_providers.owed_reloads()["desktop"].values()),
                             [{"since": "20261010-000000", "uncertain": failed_at}])
            # Not more than twice the write timeout after it failed, the lost write may still land.
            clock[0] = failed_at + window
            self.assertEqual(paseo_providers.sync_host(paseo_providers.Runner(host, "laptop", self.fleet), catalog,
                                                       program, "20261010-001000", False, lines.append), "updated")
            self.assertEqual(list(paseo_providers.owed_reloads()["desktop"].values()),
                             [{"since": "20261010-000000", "uncertain": failed_at}])
            clock[0] = failed_at + window + 1
            self.assertEqual(paseo_providers.sync_host(paseo_providers.Runner(host, "laptop", self.fleet), catalog,
                                                       program, "20261010-002000", False, lines.append), "updated")
            owed = paseo_providers.owed_reloads()
        self.assertEqual(lines.count("desktop (ssh): reload (owed since 20261010-000000) ok"), 2, lines)
        self.assertEqual(owed, {})

    def test_a_second_operation_during_the_first_ones_reload_fails_and_is_never_paid_by_it(self):
        doc, catalog, program, env = self.in_process()
        lines = []
        with env:
            host = doc["hosts"][1]
            self.assertEqual(paseo_providers.sync_host(paseo_providers.Runner(host, "laptop", self.fleet), catalog,
                                                       program, "20261010-000000", False, lines.append), "updated")
            # The first operation's write now changes nothing, and its id must stay running through its reload.
            first, second = (paseo_providers.Runner(host, "laptop", self.fleet) for _ in range(2))
            second.write = Mock(side_effect=AssertionError("the second operation wrote"))
            reload = first.reload

            def second_starts_during_this_reload():
                self.assertEqual(paseo_providers.sync_host(second, catalog, program, "20261010-000002", False,
                                                           lines.append), "FAILED")
                # A debt whose write ended after this reload started is not this reload's to pay.
                paseo_providers.update_owed("desktop", lambda debts: debts.update(
                    {"later": {"since": "20261010-000003", "ended": paseo_providers.now()}}))
                return reload()

            first.reload = second_starts_during_this_reload
            status = paseo_providers.sync_host(first, catalog, program, "20261010-000001", False, lines.append)
            owed = paseo_providers.owed_reloads()
        second.write.assert_not_called()
        self.assertTrue(any(line.startswith("desktop (ssh): write unchanged") for line in lines), lines)
        self.assertIn("desktop (ssh): FAILED, nothing written: another provider sync is in flight on desktop "
                      "(since 20261010-000001); an entry left by a killed run expires after 24 hours", lines)
        self.assertEqual(status, "same", lines)
        self.assertEqual(list(owed["desktop"]), ["later"])

    def hold_lock(self):
        """Hold the record's OS lock as another provider sync would; returns its release."""
        lock = paseo_providers.reloads_path().with_name(paseo_providers.RELOADS_LOCK)
        lock.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        paseo_providers.lock_file(fd)
        return lambda: os.close(fd)

    def test_a_record_lock_timeout_after_a_write_fails_that_host_and_the_next_host_syncs(self):
        doc, _, _, env = self.in_process()
        hosts = {host["name"]: host for host in doc["hosts"]}
        lines, held = [], []
        with env:
            write = paseo_providers.Runner.write

            def write_then_another_sync_takes_the_lock(runner, *args):
                output = write(runner, *args)
                if runner.name == "desktop":
                    held.append(self.hold_lock())
                return output

            def emit(line):  # the other sync lets go once this host has failed
                lines.append(line)
                if line.startswith("desktop (ssh): FAILED"):
                    held.pop()()

            with patch.object(paseo_providers.Runner, "write", write_then_another_sync_takes_the_lock), \
                    patch.object(paseo_providers, "RELOADS_LOCK_SECONDS", 0.3):
                statuses = paseo_providers.run(doc, self.fleet, [hosts["desktop"], hosts["laptop"]], False, emit)
            owed = paseo_providers.owed_reloads()
        self.assertEqual(statuses, {"desktop": "FAILED", "laptop": "updated"}, lines)
        failure = next(line for line in lines if line.startswith("desktop (ssh): FAILED"))
        self.assertIn("FAILED on the reload record: the reload record stayed locked for 0.3s by another provider sync",
                      failure)
        self.assertIn("; the write changed the config and the reload succeeded, so a reload may still be owed", failure)
        self.assertIn("laptop (local): reload ok", lines)
        self.assertEqual(list(owed), ["desktop"])

    def test_a_lock_release_failure_fails_that_host_and_the_next_host_syncs(self):
        doc, _, _, env = self.in_process()
        hosts = {host["name"]: host for host in doc["hosts"]}
        lines, armed = [], []
        unlock, write = paseo_providers.unlock_file, paseo_providers.Runner.write

        def unlock_failing_once(fd):
            if armed:
                armed.clear()
                raise PermissionError(13, "Permission denied")
            unlock(fd)

        def write_then_fail_the_next_release(runner, *args):
            output = write(runner, *args)
            if runner.name == "desktop":
                armed.append(True)
            return output

        # The real host loop, and nothing releases the lock out of band.
        with env, patch.object(paseo_providers.Runner, "write", write_then_fail_the_next_release), \
                patch.object(paseo_providers, "unlock_file", unlock_failing_once):
            statuses = paseo_providers.run(doc, self.fleet, [hosts["desktop"], hosts["laptop"]], False, lines.append)
        self.assertEqual(statuses, {"desktop": "FAILED", "laptop": "updated"}, lines)
        failure = next(line for line in lines if line.startswith("desktop (ssh): FAILED"))
        self.assertIn("FAILED on the reload record: cannot release the reload record lock", failure)
        self.assertIn("; the write changed the config and the reload succeeded, so a reload may still be owed", failure)
        self.assertIn("laptop (local): reload ok", lines)

    def test_relay_cleanup_failure_is_reported(self):
        (self.root / "fail-archive").touch()
        code, out = self.run_sync("--host", "tablet")
        # The merge ran, so its result stands, the leftover is a warning after it, and the reload still runs.
        self.assertEqual(code, 0, out)
        lines = out.splitlines()
        write = next(i for i, line in enumerate(lines) if "tablet (paseo-relay): write CHANGED" in line)
        self.assertIn("tablet (paseo-relay): cleanup warning: relay workspace cleanup failed: ws-1", lines[write + 1])
        self.assertIn("tablet (paseo-relay): reload ok", lines[write + 2])

    def test_host_selection(self):
        code, out = self.run_sync("--host", "nowhere")
        self.assertEqual(code, 2)
        self.assertIn("unknown host: nowhere", out)
        code, out = self.run_sync("--host", "devbox")
        self.assertEqual(code, 2)
        self.assertIn("does not have the providers sync scope", out)
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.config("laptop"), EXISTING)
        self.assertNotEqual(self.config("desktop"), EXISTING)


class ConfigValidationTest(unittest.TestCase):
    def setUp(self):
        self.fleet = fleet.validate(HOSTS)
        self.base = json.loads((EXAMPLE / "paseo-providers.json").read_text())
        self.base["hosts"] = {}

    def check(self, mutate, fragment):
        data = json.loads(json.dumps(self.base))
        mutate(data)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "paseo-providers.json"
            path.write_text(json.dumps(data))
            with self.assertRaises(fleet.FleetError) as caught:
                paseo_providers.load_config(path, self.fleet)
        self.assertIn(fragment, str(caught.exception))

    def test_example_catalog_is_valid_for_the_example_fleet(self):
        paseo_providers.load_config(EXAMPLE / "paseo-providers.json", fleet.load(EXAMPLE))

    def test_labels_are_names_only(self):
        def versioned(d): d["providers"]["claude"]["models"][0]["label"] = "Large 2"
        def with_id(d): d["providers"]["claude"]["models"][0]["label"] = d["providers"]["claude"]["models"][0]["id"]
        self.check(versioned, "must be a name only")
        self.check(with_id, "must be a name only")

    def test_duplicate_model_ids(self):
        def dup(d): d["providers"]["codex"]["models"].append(dict(d["providers"]["codex"]["models"][0], label="Other"))
        self.check(dup, "unique")

    def test_host_must_have_providers_scope(self):
        self.check(lambda d: d["hosts"].update(devbox={}), "hosts.devbox")

    def test_unknown_keys(self):
        self.check(lambda d: d.update(routers={}), "unknown keys ['routers']")
        self.check(lambda d: d["hosts"].update(tablet={"inherit": False}), "unknown keys ['inherit']")

    def test_parse_wrapped_result(self):
        wrapped = '@@LOADOUT-RESULT {"host":"t","err\nor":null} @@END'
        self.assertEqual(paseo_providers.parse_result(wrapped), {"host": "t", "error": None})


if __name__ == "__main__":
    unittest.main()

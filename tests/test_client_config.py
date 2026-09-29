import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills/orchestration/personal-skills/scripts"
EXAMPLE = REPO / "skills/orchestration/personal-skills/fleet/example"
sys.path.insert(0, str(SCRIPTS))
import client_config  # noqa: E402
import fleet  # noqa: E402

FAKE_SSH = textwrap.dedent(r"""
    #!/bin/sh
    [ "$1" = "--fake-ok" ] && { echo fake; exit 0; }
    while [ "$1" = "-o" ] || [ "$1" = "-n" ]; do [ "$1" = "-o" ] && shift; shift; done
    host="$1"; shift
    echo "ssh $host $*" >> "$FAKE_ROOT/calls.log"
    unset CODEX_HOME
    HOME="$FAKE_ROOT/hosts/$host" exec sh -c "$*"
    """).lstrip()

# Version lives in $HOME/claude-version; `claude update` installs 2.10.0.
FAKE_CLAUDE = textwrap.dedent(r"""
    #!/bin/sh
    [ "$1" = "--fake-ok" ] && { echo fake; exit 0; }
    case "$1" in
      --version) echo "$(cat "$HOME/claude-version") (Claude Code)" ;;
      update) echo 2.10.0 > "$HOME/claude-version" ;;
    esac
    """).lstrip()

HOSTS = {
    "schema_version": 2, "source_host": "laptop", "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"], "sync": ["skills", "client-config"]},
        {"name": "desktop", "os": "linux", "clients": ["codex"], "sync": ["client-config"]},
        {"name": "devbox", "os": "linux", "clients": ["codex"]},
    ],
}

CODEX_TOML = "\r\n".join([
    "# my settings",
    'model = "host-model"',
    'approval_policy = "never"',
    "",
    "",
    "[projects.alpha]",
    'trust_level = "trusted"',
    "",
    "[model_providers.example_router]",
    'base_url = "https://old.example.test"',
    "# keep this comment",
    'extra = "kept"',
    "",
])

CLAUDE_SETTINGS = {"theme": "light", "hooks": {"x": 1}, "env": {"LOCAL_ONLY": "1"}}
TOKEN = "tok-SECRET-123"


class ClientConfigTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = self.root / "fleet"
        self.fleet.mkdir()
        (self.fleet / "hosts.json").write_text(json.dumps(HOSTS))
        catalog = json.loads((EXAMPLE / "client-config.json").read_text())
        catalog["token_file"] = str(self.root / "token")
        (self.root / "token").write_text(TOKEN + "\n")
        (self.fleet / "client-config.json").write_text(json.dumps(catalog))
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in (("ssh", FAKE_SSH), ("claude", FAKE_CLAUDE)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        for host in ("laptop", "desktop", "devbox"):
            home = self.root / "hosts" / host
            (home / ".codex").mkdir(parents=True)
            (home / ".claude").mkdir()
            (home / ".codex/config.toml").write_bytes(CODEX_TOML.encode())
            (home / ".claude/settings.json").write_text(json.dumps(CLAUDE_SETTINGS))
            (home / "claude-version").write_text("2.9.5\n")
        self.env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.root / "hosts/laptop"),
                    "LOADOUT_FLEET": str(self.fleet), "FAKE_ROOT": str(self.root)}
        for name in ("ssh", "claude"):
            done = subprocess.run([name, "--fake-ok"], env=self.env, capture_output=True, text=True)
            self.assertEqual(done.stdout.strip(), "fake", f"fake {name} is not the binary on PATH")

    def tearDown(self):
        self.tmp.cleanup()

    def home(self, host):
        return self.root / "hosts" / host

    def run_sync(self, *args):
        done = subprocess.run([sys.executable, str(SCRIPTS / "client_config.py"), *args], env=self.env,
                              capture_output=True, text=True, timeout=60)
        return done.returncode, done.stdout + done.stderr

    def test_remote_codex_merge_keeps_everything_else(self):
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        text = (self.home("desktop") / ".codex/config.toml").read_bytes().decode()
        self.assertNotIn("\n", text.replace("\r\n", ""), "CRLF line endings kept")
        lines = text.split("\r\n")
        self.assertEqual(lines[:6], ["# my settings", 'model = "host-model"', 'approval_policy = "on-request"',
                                     'sandbox_mode = "workspace-write"', 'model_provider = "example_router"', ""])
        self.assertEqual(lines[6:9], ["", "[projects.alpha]", 'trust_level = "trusted"'])
        section = lines[lines.index("[model_providers.example_router]"):]
        self.assertEqual(section[:5], ["[model_providers.example_router]", 'base_url = "https://router.example.test/v1"',
                                       "# keep this comment", 'extra = "kept"', 'wire_api = "responses"'])
        self.assertIn("desktop (remote): codex CHANGED approval_policy,+sandbox_mode,+model_provider,"
                      "model_providers.example_router.base_url,+model_providers.example_router.wire_api", out)
        self.assertIn('host-local model="host-model"', out)

    def test_remote_claude_gets_token_from_stdin_only(self):
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        settings = json.loads((self.home("desktop") / ".claude/settings.json").read_text())
        self.assertEqual(settings["theme"], "light")
        self.assertEqual(settings["hooks"], {"x": 1})
        self.assertEqual(settings["permissions"], {"defaultMode": "acceptEdits"})
        self.assertEqual(settings["env"], {"LOCAL_ONLY": "1", "CLAUDE_CODE_SUBAGENT_MODEL": "example-small",
                                           "ANTHROPIC_BASE_URL": "https://router.example.test",
                                           "ANTHROPIC_AUTH_TOKEN": TOKEN})
        self.assertNotIn(TOKEN, out)
        self.assertNotIn(TOKEN, (self.root / "calls.log").read_text())
        self.assertNotIn(TOKEN, (self.fleet / "client-config.json").read_text())

    def test_local_role_has_no_token_or_remote_keys(self):
        code, out = self.run_sync("--host", "laptop")
        self.assertEqual(code, 0, out)
        settings = json.loads((self.home("laptop") / ".claude/settings.json").read_text())
        self.assertEqual(settings["theme"], "dark")
        self.assertEqual(settings["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4000")
        self.assertNotIn("ANTHROPIC_AUTH_TOKEN", settings["env"])
        self.assertNotIn("model_provider =", (self.home("laptop") / ".codex/config.toml").read_text())
        self.assertFalse((self.root / "calls.log").exists(), "the source host runs locally")

    def test_backup_then_idempotent(self):
        self.run_sync()
        backups = sorted(p.name for p in (self.home("desktop") / ".codex").glob("config.toml.bak-loadout-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((self.home("desktop") / ".codex" / backups[0]).read_bytes(), CODEX_TOML.encode())
        code, out = self.run_sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("codex unchanged"), 2, out)
        self.assertEqual(out.count("claude unchanged"), 2, out)
        self.assertEqual(len(list((self.home("desktop") / ".codex").glob("config.toml.bak-loadout-*"))), 1)
        self.assertNotIn("devbox", out)

    def test_dry_run_writes_nothing(self):
        code, out = self.run_sync("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("desktop (remote): codex CHANGED", out)
        self.assertEqual((self.home("desktop") / ".codex/config.toml").read_bytes(), CODEX_TOML.encode())
        self.assertEqual(json.loads((self.home("desktop") / ".claude/settings.json").read_text()), CLAUDE_SETTINGS)
        self.assertEqual(list((self.home("desktop") / ".codex").glob("*.bak-loadout-*")), [])

    def test_claude_min_version_and_update(self):
        code, out = self.run_sync("--host", "desktop")
        self.assertIn("desktop (remote): claude-code 2.9.5 ok", out)
        (self.home("desktop") / "claude-version").write_text("2.0.9\n")
        code, out = self.run_sync("--host", "desktop")
        self.assertIn("claude-code 2.0.9, below min 2.1.0 (run with --update-claude)", out)
        code, out = self.run_sync("--host", "desktop", "--update-claude", "--dry-run")
        self.assertIn("below min", out)
        code, out = self.run_sync("--host", "desktop", "--update-claude")
        self.assertIn("claude-code 2.0.9 -> 2.10.0 (min 2.1.0)", out)

    def test_absent_clients_are_skipped(self):
        shutil.rmtree(self.home("desktop") / ".codex")
        shutil.rmtree(self.home("desktop") / ".claude")
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertIn("desktop (remote): codex absent, skipped", out)
        self.assertIn("desktop (remote): claude absent, skipped", out)
        self.assertFalse((self.home("desktop") / ".codex").exists())

    def test_missing_token_file_fails_without_leaking(self):
        (self.root / "token").unlink()
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 1)
        self.assertIn("cannot read token_file", out)

    def test_host_selection(self):
        code, out = self.run_sync("--host", "devbox")
        self.assertEqual(code, 2)
        self.assertIn("does not have the client-config sync scope", out)


class VersionAndCatalogTest(unittest.TestCase):
    def test_version_compare_is_sort_v(self):
        js = (SCRIPTS / "client_config_merge.js").read_text()
        start = js.index("function versionAtLeast")
        fn = js[start:js.index("\n}\n", start) + 2]
        cases = [("2.10.0", "2.9.9", True), ("2.1.0", "2.1.0", True), ("2.0.9", "2.1.0", False), ("3", "2.99.1", True)]
        script = fn + "console.log(JSON.stringify(%s.map(([a,b])=>versionAtLeast(a,b))))" % json.dumps([c[:2] for c in cases])
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True).stdout
        self.assertEqual(json.loads(out), [c[2] for c in cases])

    def check(self, mutate, fragment):
        fleet_doc = fleet.validate(HOSTS)
        data = json.loads((EXAMPLE / "client-config.json").read_text())
        data["hosts"] = {}
        mutate(data)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client-config.json"
            path.write_text(json.dumps(data))
            with self.assertRaises(fleet.FleetError) as caught:
                client_config.load_catalog(path, fleet_doc)
        self.assertIn(fragment, str(caught.exception))

    def test_catalog_validation(self):
        self.check(lambda d: d.update(extra=1), "unknown keys ['extra']")
        self.check(lambda d: d["roles"].update(guest={}), "unknown keys ['guest']")
        self.check(lambda d: d["hosts"].update(devbox={}), "hosts.devbox")
        self.check(lambda d: d["hosts"].update(desktop={"role": "admin"}), "role")
        self.check(lambda d: d["codex"]["top"].update(bad=[1]), "codex.top.bad")
        self.check(lambda d: d["roles"]["remote"]["claude"].update(minVersion="1"), "unknown keys ['minVersion']")

    def test_example_is_valid_and_layers(self):
        fleet_doc = fleet.load(EXAMPLE)
        catalog = client_config.load_catalog(EXAMPLE / "client-config.json", fleet_doc)
        desktop = client_config.settings_for(catalog, fleet_doc, "desktop")
        self.assertEqual(desktop["role"], "remote")
        self.assertEqual(desktop["claude"]["settings"]["theme"], "light")
        self.assertEqual(desktop["claude"]["token_env"], "ANTHROPIC_AUTH_TOKEN")
        laptop = client_config.settings_for(catalog, fleet_doc, "laptop")
        self.assertEqual((laptop["role"], laptop["claude"]["token_env"]), ("local", None))


if __name__ == "__main__":
    unittest.main()

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills/orchestration/personal-skills/scripts"
EXAMPLE = REPO / "skills/orchestration/personal-skills/fleet/example"
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(SCRIPTS))
import fleet  # noqa: E402
import paseo_providers  # noqa: E402

from fake_commands import (assert_fake, install_fake_claude, install_fake_npm, install_fake_provider_paseo,
                           install_fake_ssh, with_fakes)

HOSTS = {
    "schema_version": 2, "source_host": "laptop", "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"], "sync": ["skills", "providers", "client-config"],
         "exclude_skills": ["sample"]},
        {"name": "desktop", "os": "linux", "clients": ["codex", "claude"],
         "sync": ["skills", "plugins", "providers", "client-config"],
         "paseo": {"plugin_root": "~/plugins", "stage": ["orphan-project-sweeper"], "install": []}},
        {"name": "devbox", "os": "linux", "clients": ["codex"], "sync": ["skills", "client-config"]},
        {"name": "tablet", "os": "linux", "transport": "paseo-relay", "sync": ["providers"],
         "paseo_offer": "offers/tablet.offer"},
    ],
}


class SyncTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = self.root / "hosts/laptop/.config/loadout/fleet"
        (self.fleet / "offers").mkdir(parents=True)
        (self.fleet / "hosts.json").write_text(json.dumps(HOSTS, indent=2))
        (self.fleet / "offers/tablet.offer").write_text("offer:tablet\n")
        shutil.copy(EXAMPLE / "paseo-providers.json", self.fleet / "paseo-providers.json")
        providers = json.loads((self.fleet / "paseo-providers.json").read_text())
        providers["hosts"] = {"tablet": {"inherit_env": False}}
        (self.fleet / "paseo-providers.json").write_text(json.dumps(providers))
        catalog = json.loads((EXAMPLE / "client-config.json").read_text())
        catalog["token_file"] = str(self.root / "token")
        catalog["hosts"] = {}
        (self.root / "token").write_text("tok")
        (self.fleet / "client-config.json").write_text(json.dumps(catalog))
        self.ssh = install_fake_ssh(self.root / "bin")
        self.paseo = install_fake_provider_paseo(self.root / "bin")
        npm = install_fake_npm(self.root / "bin")
        claude = install_fake_claude(self.root / "bin")
        for host in ("laptop", "desktop", "devbox", "tablet"):
            home = self.root / "hosts" / host
            for d in (".paseo", ".claude", ".codex"):
                (home / d).mkdir(parents=True, exist_ok=True)
            (home / ".paseo/config.json").write_text("{}")
            (home / ".codex/config.toml").write_text('model = "m"\n')
            (home / "claude-version").write_text("2.5.0\n")
        # The host programs run these fakes through their test-only hooks, as argv: never a command on PATH.
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.root / "hosts/laptop"),
                    "FAKE_ROOT": str(self.root), "LOADOUT_RELAY_POLL_SECONDS": "0.05",
                    "LOADOUT_RELAY_WAIT_SECONDS": "5", "LOADOUT_TEST_PASEO": json.dumps(self.paseo),
                    "LOADOUT_TEST_NPM": json.dumps(npm), "LOADOUT_TEST_CLAUDE": json.dumps(claude)}
        self.env.update({k: v for k, v in os.environ.items()
                         if k.upper() in ("SYSTEMROOT", "TEMP", "TMP")})
        self.env["USERPROFILE"] = self.env["HOME"]
        self.env["APPDATA"] = str(self.root / "hosts/laptop/.config")
        for fake in (self.ssh, self.paseo, npm, claude):
            assert_fake(fake, self.env)
        # In-process runs reach the same fakes through the module hooks.
        for module, name, fake in ((fleet, "SSH_COMMAND", self.ssh), (paseo_providers, "PASEO_COMMAND", self.paseo)):
            hook = mock.patch.object(module, name, fake)
            hook.start()
            self.addCleanup(hook.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def sync(self, *args):
        done = subprocess.run(with_fakes(SCRIPTS / "sync.py", *args, ssh=self.ssh, paseo=self.paseo), env=self.env,
                              capture_output=True, text=True, timeout=300)
        return done.returncode, done.stdout + done.stderr

    def row(self, out, host):
        """Parse the summary table by column position, since cells can hold spaces."""
        lines = out.splitlines()
        start = max(i for i, line in enumerate(lines) if line.startswith("host "))
        header = lines[start]
        cols = [(m.group(), m.start()) for m in re.finditer(r"\S+", header)]
        line = next(l for l in lines[start + 1:] if l.split()[:1] == [host])
        bounds = [c[1] for c in cols] + [None]
        return {name: line[bounds[i]:bounds[i + 1]].strip() for i, (name, _) in enumerate(cols) if i > 0}

    def test_dry_run_then_sync_then_same(self):
        code, out = self.sync("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.row(out, "laptop"), {"fleet": "source", "skills": "would update", "plugins": "skipped",
                                                   "providers": "would update", "client-config": "would update"})
        self.assertEqual(self.row(out, "tablet"), {"fleet": "not needed", "skills": "skipped", "plugins": "skipped",
                                                   "providers": "would update", "client-config": "skipped"})
        self.assertIn("fleet valid: schema_version 2, 4 hosts (dry run)", out)
        self.assertFalse((self.root / "hosts/desktop/.config/loadout/fleet").exists())
        self.assertFalse((self.root / "hosts/desktop/.claude/skills").exists())

        code, out = self.sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.row(out, "desktop"), {"fleet": "updated", "skills": "updated", "plugins": "updated",
                                                    "providers": "updated", "client-config": "updated"})
        self.assertEqual(self.row(out, "tablet"), {"fleet": "not needed", "skills": "skipped", "plugins": "skipped",
                                                   "providers": "updated", "client-config": "skipped"})
        self.assertTrue((self.root / "hosts/desktop/.config/loadout/fleet/hosts.json").exists())
        self.assertTrue((self.root / "hosts/desktop/plugins/orphan-project-sweeper/node_modules").exists())
        self.assertFalse((self.root / "hosts/laptop/.claude/skills/sample").exists())

        code, out = self.sync()
        self.assertEqual(code, 0, out)
        for host in ("desktop", "devbox"):
            self.assertEqual(set(self.row(out, host).values()) - {"skipped"}, {"same"}, out)

    def test_conflict_stops_later_scopes_for_that_host_only(self):
        self.sync("--only", "fleet")
        (self.root / "hosts/devbox/.config/loadout/fleet/hosts.json").write_text("{}")
        code, out = self.sync()
        self.assertEqual(code, 1, out)
        self.assertEqual(self.row(out, "devbox"), {"fleet": "conflict", "skills": "stopped", "plugins": "skipped",
                                                   "providers": "skipped", "client-config": "stopped"})
        self.assertEqual(self.row(out, "desktop")["client-config"], "updated")
        self.assertIn("stopped after a conflict, a fleet failure, or a failed shared preflight: devbox", out)
        self.assertFalse((self.root / "hosts/devbox/.codex/skills").exists())

    def test_only_and_host(self):
        code, out = self.sync("--only", "skills,client-config", "--host", "desktop")
        self.assertEqual(code, 0, out)
        header = next(line for line in out.splitlines() if line.startswith("host "))
        self.assertEqual(header.split(), ["host", "skills", "client-config"])
        self.assertEqual(self.row(out, "desktop"), {"skills": "updated", "client-config": "updated"})
        self.assertNotIn("\nlaptop ", out)
        code, out = self.sync("--host", "nowhere")
        self.assertEqual(code, 2)
        done = subprocess.run(with_fakes(SCRIPTS / "sync.py", "--only", "secrets", ssh=self.ssh, paseo=self.paseo),
                              env=self.env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)

    def test_missing_catalog_fails_that_scope_only(self):
        (self.fleet / "client-config.json").unlink()
        code, out = self.sync("--only", "skills,client-config", "--host", "devbox")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.row(out, "devbox"), {"skills": "updated", "client-config": "FAILED"})
        self.assertIn("FAILED: cannot read", out)

    def test_non_fleet_error_on_one_host_fails_that_host_only(self):
        # desktop answers with a cut-off result, so parsing it raises a JSON error, not a FleetError.
        cut = self.root / "bin/cut_ssh.py"
        cut.write_text("import subprocess, sys\n"
                       "if ' desktop ' in ' %s ' % ' '.join(sys.argv[1:]):\n"
                       "    print('@@LOADOUT-RESULT {cut @@END')\n"
                       "    sys.exit(0)\n"
                       f"sys.exit(subprocess.run([*{list(self.ssh)!r}, *sys.argv[1:]]).returncode)\n")
        self.ssh = (sys.executable, str(cut))
        assert_fake(self.ssh, self.env)
        code, out = self.sync("--only", "skills")
        self.assertEqual(code, 1, out)
        self.assertIn("desktop: skills FAILED: JSONDecodeError:", out)
        self.assertEqual(self.row(out, "desktop"), {"skills": "FAILED"})
        self.assertEqual(self.row(out, "devbox"), {"skills": "updated"})
        self.assertTrue((self.root / "hosts/devbox/.codex/skills").is_dir())

    def test_skills_sync_builds_the_publication_once(self):
        sys.path.insert(0, str(SCRIPTS))
        import publication
        import sync
        (self.fleet / "hosts.json").write_text(json.dumps({**HOSTS, "hosts": HOSTS["hosts"][:2]}))
        out = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(sync.signal, "signal"), \
                mock.patch("publication.Publication", side_effect=publication.Publication) as built, \
                contextlib.redirect_stdout(out):
            code = sync.main(["--only", "skills"])
        self.assertEqual(code, 0, out.getvalue())
        self.assertEqual(self.row(out.getvalue(), "laptop"), {"skills": "updated"})
        self.assertEqual(self.row(out.getvalue(), "desktop"), {"skills": "updated"})
        self.assertEqual(built.call_count, 1)


class SyncFlagsTest(unittest.TestCase):
    def test_migrate_path_reaches_the_plugins_step(self):
        sys.path.insert(0, str(SCRIPTS))
        import plugins_sync
        import sync
        seen = []
        original = plugins_sync.preflight
        plugins_sync.preflight = lambda *args: seen.append(args[-1]) or {}
        try:
            for flag in ([], ["--migrate-path"]):
                args = sync.argparse.Namespace(dry_run=True, migrate_path=bool(flag), update_claude=False)
                sync.preflight("plugins", {}, None, [], args, print)
        finally:
            plugins_sync.preflight = original
        self.assertEqual(seen, [False, True])


if __name__ == "__main__":
    unittest.main()

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills/orchestration/personal-skills/scripts"
sys.path.insert(0, str(SCRIPTS))
import fleet  # noqa: E402
import plugins_sync  # noqa: E402

from fake_commands import (assert_fake, install_fake_npm, install_fake_plugin_paseo, install_fake_ssh,
                           with_fake_ssh)


def blob(data, prior=()):
    return {"sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode(), "prior": list(prior)}


PLUGIN_FILES = {
    "package.json": b'{"name":"demo","scripts":{"check":"tsc && node --test"}}',
    "paseo-plugin.json": b'{"id":"demo","requirements":{"paseo":">=0.9.2 <0.11.0"}}',
    "server/index.ts": b"export {}\n",
}


class Fixture(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.ssh = install_fake_ssh(self.root / "bin")
        npm = install_fake_npm(self.root / "bin")
        paseo = install_fake_plugin_paseo(self.root / "bin")
        (self.root / "paseo-version").write_text("0.10.1\n")
        (self.root / "daemon-version").write_text("0.10.1\n")
        # The host program runs these fakes through its test-only hooks, as argv: never an npm or paseo on PATH.
        self.env = {"PATH": os.environ["PATH"], "FAKE_ROOT": str(self.root),
                    "LOADOUT_TEST_NPM": json.dumps(npm), "LOADOUT_TEST_PASEO": json.dumps(paseo)}
        self.env.update({k: v for k, v in os.environ.items()
                         if k.upper() in ("SYSTEMROOT", "TEMP", "TMP")})
        for fake in (self.ssh, npm, paseo):
            assert_fake(fake, self.env)

    def tearDown(self):
        self.tmp.cleanup()

    def calls(self):
        path = self.root / "calls.log"
        return path.read_text() if path.exists() else ""


class RemotePluginTest(Fixture):
    def setUp(self):
        super().setUp()
        self.home = self.root / "home"
        (self.home / ".paseo").mkdir(parents=True)
        self.set_enabled(True)

    def set_enabled(self, value):
        (self.home / ".paseo/config.json").write_text(json.dumps({"pluginsEnabled": value, "daemon": {"listen": "x"}}))

    def config(self):
        return json.loads((self.home / ".paseo/config.json").read_text())

    def staged(self, rel=""):
        return self.home / "plugins/demo" / rel

    def run_remote(self, files=None, stage=("demo",), install=("demo",), root="~/plugins", dry_run=False, pin=">=0.9.2 <0.11.0",
                   migrate=False):
        files = files or {rel: blob(data) for rel, data in PLUGIN_FILES.items()}
        payload = {"dry_run": dry_run, "migrate_path": migrate, "plugin_root": root, "stage": list(stage), "install": list(install),
                   "plugins": {"demo": {"pin": pin, "files": files}}}
        env = {**self.env, "HOME": str(self.home), "USERPROFILE": str(self.home)}
        raw, digest = fleet.envelope(plugins_sync.REMOTE_JS, payload)
        done = subprocess.run(["node", "-e", fleet.BOOT, "--", digest], input=raw, capture_output=True, text=True, env=env)
        return fleet.parse_result(done.stdout)

    def test_stage_check_install_confirm_then_same(self):
        got = self.run_remote()
        self.assertEqual(got["status"], "updated", got)
        self.assertEqual(got["plugins"]["demo"], {"staged": "changed", "checked": "check", "installed": "installed", "running": True})
        self.assertEqual(self.staged("server/index.ts").read_bytes(), b"export {}\n")
        self.assertIn(f"npm ci --ignore-scripts in {self.staged().resolve()}", self.calls())
        self.assertIn(f'paseo plugin install {self.staged()}', self.calls().replace('"', ""))
        got = self.run_remote()
        self.assertEqual(got["status"], "same", got)
        self.assertEqual(got["plugins"]["demo"]["checked"], "skipped (unchanged)")
        self.assertEqual(got["plugins"]["demo"]["installed"], "already installed")

    def test_prior_version_is_replaced_and_reloaded(self):
        self.run_remote()
        files = {rel: blob(data) for rel, data in PLUGIN_FILES.items()}
        files["server/index.ts"] = blob(b"export const v = 2\n", [hashlib.sha256(b"export {}\n").hexdigest()])
        got = self.run_remote(files)
        self.assertEqual((got["status"], got["plugins"]["demo"]["installed"]), ("updated", "reloaded"))
        self.assertIn("paseo plugin reload demo", self.calls())

    def test_local_edit_is_a_conflict(self):
        self.run_remote()
        self.staged("server/index.ts").write_text("hotfix\n")
        (self.root / "calls.log").unlink()
        got = self.run_remote({**{r: blob(d) for r, d in PLUGIN_FILES.items()}, "server/new.ts": blob(b"n")})
        self.assertEqual((got["status"], got["conflicts"]), ("conflict", ["demo/server/index.ts"]))
        self.assertFalse(self.staged("server/new.ts").exists())
        self.assertEqual(self.calls(), "")

    def test_symlinked_ancestor_is_refused(self):
        elsewhere = self.home / "elsewhere"
        elsewhere.mkdir()
        self.staged().parent.mkdir()
        self.staged().symlink_to(elsewhere)
        got = self.run_remote()
        self.assertEqual(got["status"], "failed")
        self.assertIn("not a real directory", got["error"])
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertEqual(self.calls(), "")

    def test_path_leaving_plugin_root_is_refused(self):
        for rel in ("../escape", "a/../../escape"):
            with self.subTest(rel=rel):
                before = sorted(self.root.rglob("*"))
                got = self.run_remote({**{r: blob(d) for r, d in PLUGIN_FILES.items()}, rel: blob(b"escaped")})
                self.assertEqual(got["status"], "failed", got)
                self.assertIn("invalid path from source: " + rel, got["error"])
                self.assertEqual(sorted(self.root.rglob("*")), before, "a file was written")
                self.assertFalse((self.home / "plugins").exists())
                self.assertEqual(self.calls(), "")
        # A Windows host also splits on backslashes, so this name leaves its root there.
        probe = ('const p = require("path").win32, [common, root, rel] = process.argv.slice(1);'
                 'try { require(common).checkAncestors(require("fs"), p, root, p.join(root, rel)); console.log("allowed"); }'
                 'catch (e) { console.log(e.message); }')
        done = subprocess.run(["node", "-e", probe, "--", str(SCRIPTS / "remote_common.js"), r"C:\loadout\plugins", r"a\..\..\x"],
                              capture_output=True, text=True)
        self.assertEqual(done.stdout.strip(), r"path escapes its root: C:\loadout\x", done.stderr)

    def test_plugins_enabled_false_blocks_install_and_is_not_changed(self):
        self.set_enabled(False)
        got = self.run_remote()
        self.assertEqual(got["status"], "blocked", got)
        self.assertEqual(got["plugins"]["demo"]["checked"], "check")
        self.assertIn("pluginsEnabled is not true", got["plugins"]["demo"]["installed"])
        self.assertEqual(self.config(), {"pluginsEnabled": False, "daemon": {"listen": "x"}})
        self.assertNotIn("plugin install", self.calls())

    def test_version_outside_pin_blocks(self):
        (self.root / "daemon-version").write_text("0.11.0-beta.1\n")
        self.assertIn("outside demo's pin", self.run_remote()["plugins"]["demo"]["installed"])
        (self.root / "daemon-version").write_text("0.9.1\n")
        self.assertEqual(self.run_remote()["status"], "blocked")

    def test_pin_checks_the_running_daemon_not_the_cli(self):
        (self.root / "paseo-version").write_text("0.9.2\n")
        got = self.run_remote(pin=">=0.10.0 <0.11.0")
        self.assertEqual(got["status"], "updated", got)
        self.assertEqual(got["daemon"], {"version": "0.10.1", "cli": "0.9.2", "pluginsEnabled": True})
        self.assertIn("daemon 0.10.1 (CLI 0.9.2), pluginsEnabled true", plugins_sync.describe(got)[0])
        (self.root / "paseo-version").write_text("0.10.1\n")
        (self.root / "daemon-version").write_text("0.9.2\n")
        self.assertEqual(self.run_remote(pin=">=0.10.0 <0.11.0")["status"], "blocked")

    def test_unreachable_daemon_blocks_install(self):
        (self.root / "daemon-down").touch()
        got = self.run_remote()
        self.assertEqual(got["status"], "blocked")
        self.assertIn("did not report its version", got["plugins"]["demo"]["installed"])

    def test_failed_check_skips_install(self):
        (self.root / "fail-check").touch()
        got = self.run_remote()
        self.assertEqual(got["status"], "failed")
        self.assertIn("FAILED: check failed: type error", got["plugins"]["demo"]["checked"])
        self.assertEqual(got["plugins"]["demo"]["installed"], "skipped (check failed)")

    def test_rerun_after_a_failed_check_checks_again(self):
        self.run_remote()
        files = {rel: blob(data) for rel, data in PLUGIN_FILES.items()}
        files["server/index.ts"] = blob(b"export const v = 2\n", [hashlib.sha256(b"export {}\n").hexdigest()])
        (self.root / "fail-check").touch()
        self.assertEqual(self.run_remote(files)["plugins"]["demo"]["installed"], "skipped (check failed)")
        got = self.run_remote(files)
        self.assertEqual(got["status"], "failed", got)
        self.assertEqual(got["plugins"]["demo"]["staged"], "same")
        self.assertIn("FAILED: check failed: type error", got["plugins"]["demo"]["checked"])
        self.assertEqual(got["plugins"]["demo"]["installed"], "skipped (check failed)")
        self.assertEqual(self.calls().count("npm run check"), 3)
        self.assertNotIn("plugin reload", self.calls())
        (self.root / "fail-check").unlink()
        got = self.run_remote(files)
        self.assertEqual(got["status"], "updated", got)
        self.assertEqual(got["plugins"]["demo"]["checked"], "check (rerun: last check failed)")
        # The failed runs staged v2 without reloading, so the daemon still ran v1.
        self.assertEqual(got["plugins"]["demo"]["installed"], "reloaded")
        got = self.run_remote(files)
        self.assertEqual((got["status"], got["plugins"]["demo"]["checked"]), ("same", "skipped (unchanged)"))

    def test_failed_reload_after_a_passed_check_is_owed_and_the_next_run_reloads(self):
        self.run_remote()
        files = {rel: blob(data) for rel, data in PLUGIN_FILES.items()}
        files["server/index.ts"] = blob(b"export const v = 2\n", [hashlib.sha256(b"export {}\n").hexdigest()])
        (self.root / "fail-reload").touch()
        got = self.run_remote(files)
        self.assertEqual(got["status"], "failed", got)
        self.assertEqual(got["plugins"]["demo"]["checked"], "check")
        self.assertIn("FAILED: paseo plugin reload demo: reload failed", got["plugins"]["demo"]["installed"])
        (self.root / "fail-reload").unlink()
        # Same files and a passed check, but the daemon never confirmed v2: the reload is still owed.
        self.assertEqual(self.run_remote(files, dry_run=True)["status"], "would update")
        got = self.run_remote(files)
        self.assertEqual(got["status"], "updated", got)
        info = got["plugins"]["demo"]
        self.assertEqual((info["staged"], info["checked"], info["installed"], info["running"]),
                         ("same", "skipped (unchanged)", "reloaded", True))
        self.assertEqual(plugins_sync.describe(got)[1], "  demo: staged same; check skipped (unchanged); reloaded "
                         "(reload owed: an earlier reload or install was not confirmed); running")
        self.assertEqual(self.calls().count("paseo plugin reload demo"), 2)
        got = self.run_remote(files)
        self.assertEqual((got["status"], got["plugins"]["demo"]["installed"]), ("same", "already installed"))
        self.assertEqual(self.calls().count("paseo plugin reload demo"), 2)

    def test_not_running_after_install_fails(self):
        (self.root / "not-running").touch()
        got = self.run_remote()
        self.assertEqual(got["status"], "failed")
        self.assertIn("not running: load failed", got["plugins"]["demo"]["installed"])

    def test_stage_only_host_never_touches_the_daemon(self):
        got = self.run_remote(install=())
        self.assertEqual(got["status"], "updated")
        self.assertNotIn("paseo", self.calls())

    def test_dry_run_writes_nothing(self):
        got = self.run_remote(dry_run=True)
        self.assertEqual(got["status"], "would update")
        self.assertFalse(self.staged().exists())
        self.assertNotIn("npm", self.calls())

    def test_installed_from_elsewhere_is_blocked(self):
        cfg = self.config()
        cfg["plugins"] = {"demo": {"source": "local", "path": "/somewhere/else", "enabled": True}}
        (self.home / ".paseo/config.json").write_text(json.dumps(cfg))
        got = self.run_remote()
        self.assertIn("blocked: installed from /somewhere/else (use --migrate-path)", got["plugins"]["demo"]["installed"])
        self.assertEqual(self.run_remote(dry_run=True)["status"], "blocked")
        self.assertNotIn("plugin remove", self.calls())

    def install_elsewhere(self, settings=True, enabled=True):
        cfg = self.config()
        cfg["plugins"] = {"demo": {"source": "local", "path": "/somewhere/else", "enabled": enabled}}
        (self.home / ".paseo/config.json").write_text(json.dumps(cfg))
        armed = self.home / ".paseo/plugin-settings/demo"
        if settings:
            (armed / "rules").mkdir(parents=True)
            (armed / "config.json").write_text('{"armed":true,"owner":"tuned"}')
            (armed / "rules/a.json").write_text("[1,2]")
        return armed

    def tree(self, path):
        return {str(f.relative_to(path)): f.read_bytes() for f in sorted(path.rglob("*")) if f.is_file()}

    def test_migrate_path_keeps_the_hosts_settings(self):
        armed = self.install_elsewhere()
        before = self.tree(armed)
        got = self.run_remote(dry_run=True, migrate=True)
        self.assertEqual(got["status"], "would update", got)
        self.assertEqual(got["plugins"]["demo"]["installed"], "would migrate from /somewhere/else (settings backed up and restored)")
        self.assertNotIn("plugin remove", self.calls())
        got = self.run_remote(migrate=True)
        self.assertEqual(got["status"], "updated", got)
        info = got["plugins"]["demo"]
        self.assertTrue(info["installed"].startswith("migrated from /somewhere/else; settings restored (2 files, hashes verified)"), info)
        self.assertTrue(info["running"])
        self.assertEqual(self.tree(armed), before)
        self.assertEqual(self.config()["plugins"]["demo"]["path"], str(self.staged()))
        backups = list((self.home / ".paseo").glob("plugin-settings.bak-loadout-*/demo"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(self.tree(backups[0]), before)
        calls = [c for c in self.calls().splitlines() if c.startswith("paseo plugin")]
        self.assertEqual([c.split()[2] for c in calls], ["remove", "install", "reload", "ls"])
        self.assertEqual(self.run_remote(migrate=True)["status"], "same")

    def test_migrate_path_without_settings(self):
        self.install_elsewhere(settings=False)
        got = self.run_remote(migrate=True)
        self.assertEqual(got["plugins"]["demo"]["installed"], "migrated from /somewhere/else; no settings to carry")
        self.assertEqual(got["status"], "updated")

    def test_migrate_path_restores_settings_when_install_fails(self):
        armed = self.install_elsewhere()
        before = self.tree(armed)
        (self.root / "fail-install").touch()
        got = self.run_remote(migrate=True)
        self.assertEqual(got["status"], "failed", got)
        self.assertIn("install failed", got["plugins"]["demo"]["installed"])
        self.assertIn("settings backup kept at", got["plugins"]["demo"]["installed"])
        self.assertEqual(self.tree(armed), before)

    def test_migrate_path_leaves_a_disabled_plugin_alone(self):
        armed = self.install_elsewhere(enabled=False)
        got = self.run_remote(migrate=True)
        self.assertEqual(got["status"], "blocked")
        self.assertIn("blocked: disabled plugin installed from /somewhere/else", got["plugins"]["demo"]["installed"])
        self.assertNotIn("plugin remove", self.calls())
        self.assertTrue((armed / "config.json").exists())

    def test_managed_elsewhere_reports_drift(self):
        src = self.root / "managed/demo"
        (src / "server").mkdir(parents=True)
        for rel, data in PLUGIN_FILES.items():
            (src / rel).write_bytes(data)
        (src / "node_modules").mkdir()
        (src / "node_modules/x.js").write_text("ignored")
        cfg = self.config()
        cfg["plugins"] = {"demo": {"path": str(src), "enabled": True}}
        (self.home / ".paseo/config.json").write_text(json.dumps(cfg))
        self.assertEqual(self.run_remote(root=None)["status"], "same")
        (src / "README.md").write_text("private notes")
        (src / "server/index.ts").write_text("changed")
        got = self.run_remote(root=None)
        self.assertEqual(got["status"], "drift")
        self.assertEqual(got["plugins"]["demo"], {"state": "differs", "differ": ["server/index.ts"]})
        self.assertEqual(self.calls(), "")

    def test_semver_ranges(self):
        js = (SCRIPTS / "plugins_sync_remote.js").read_text()
        start = js.index("function satisfies")
        fn = js[start:js.index("\n}\n", start) + 2]
        cases = [("0.9.2", True), ("0.10.0", True), ("0.10.5", True), ("0.9.1", False), ("0.11.0", False),
                 ("0.11.0-beta.1", False), ("0.10.1-rc.1", False)]
        script = fn + "console.log(JSON.stringify(%s.map(v=>satisfies(v,'>=0.9.2 <0.11.0'))))" % json.dumps([c[0] for c in cases])
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True).stdout
        self.assertEqual(json.loads(out), [c[1] for c in cases])


class PluginsSyncDriverTest(Fixture):
    def setUp(self):
        super().setUp()
        self.fleet = self.root / "fleet"
        self.fleet.mkdir()
        hosts = {"schema_version": 2, "source_host": "laptop", "transport": "ssh", "hosts": [
            {"name": "laptop", "os": "macos", "clients": ["claude"], "sync": ["skills"]},
            {"name": "desktop", "os": "linux", "clients": ["codex"],
             "paseo": {"plugin_root": "~/.local/share/loadout/plugins", "stage": ["orphan-project-sweeper"], "install": []}},
        ]}
        (self.fleet / "hosts.json").write_text(json.dumps(hosts))
        (self.root / "hosts/desktop").mkdir(parents=True)
        self.env.update({"HOME": str(self.root / "hosts/laptop"), "LOADOUT_FLEET": str(self.fleet)})
        self.env["USERPROFILE"] = self.env["HOME"]
        self.env["APPDATA"] = str(self.root / "hosts/laptop/.config")

    def test_stages_the_manifest_bytes_over_ssh(self):
        done = subprocess.run(with_fake_ssh(SCRIPTS / "plugins_sync.py", self.ssh), env=self.env,
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("desktop: plugins updated", done.stdout)
        self.assertIn("orphan-project-sweeper: staged changed; check check", done.stdout)
        self.assertNotIn("laptop", done.stdout.split("source_commit")[1])
        manifest = json.loads((REPO / "MANIFEST.json").read_text())
        staged = self.root / "hosts/desktop/.local/share/loadout/plugins/orphan-project-sweeper"
        for entry in manifest["plugin_files"]:
            if entry["plugin"] == "orphan-project-sweeper":
                data = (staged / "/".join(entry["path"].split("/")[2:])).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
        self.assertNotIn("paseo", self.calls())


if __name__ == "__main__":
    unittest.main()

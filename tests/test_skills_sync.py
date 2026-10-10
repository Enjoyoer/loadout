import base64
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills/orchestration/personal-skills/scripts"
sys.path.insert(0, str(SCRIPTS))
import fleet  # noqa: E402
import skills_sync  # noqa: E402

from fake_commands import assert_fake, install_fake_ssh, with_fake_ssh

# Runs skills_sync.main() like with_fake_ssh, with extra paths in the publication history: a skill this
# repository once published, which a test checkout's history does not hold.
WITH_HISTORY = (
    "import json, sys; scripts, prefix, extra = sys.argv[1:4]; sys.path.insert(0, scripts); import fleet, publication; "
    "fleet.SSH_COMMAND = tuple(json.loads(prefix)); prior = publication.Publication.prior; "
    "publication.Publication.prior = lambda self: {**prior(self), **json.loads(extra)}; "
    "sys.argv = ['skills_sync', *sys.argv[4:]]; import skills_sync; sys.exit(skills_sync.main())")


def entry(data, prior=()):
    digest = hashlib.sha256(data).hexdigest()
    return {"sha256": digest, "data": base64.b64encode(data).decode(), "prior": list(prior)}


def sha(data):
    return hashlib.sha256(data).hexdigest()


class RemotePreflightTest(unittest.TestCase):
    """The host-side program, run locally against a temp home."""

    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / ".claude").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_remote(self, files, clients=("claude",), glob=None, dry_run=False, keep=None, preload=None, extra_env=None):
        payload = {"dry_run": dry_run, "clients": list(clients), "files": files, "global": glob, "keep": keep}
        env = {k: v for k, v in os.environ.items() if k not in ("CODEX_HOME", "XDG_CONFIG_HOME")}
        env["HOME"] = str(self.home)
        # Windows reads the home from USERPROFILE and keeps the sync record under APPDATA, not ~/.config.
        env["USERPROFILE"] = str(self.home)
        env["APPDATA"] = str(self.home / ".config")
        env.update(extra_env or {})
        raw, digest = fleet.envelope(skills_sync.REMOTE_JS, payload)
        node = ["node", "-r", str(preload)] if preload else ["node"]
        done = subprocess.run([*node, "-e", fleet.BOOT, "--", digest], input=raw, capture_output=True, text=True, env=env)
        return fleet.parse_result(done.stdout)

    def skill(self, rel):
        return self.home / ".claude/skills" / rel

    def test_install_then_same_and_codex_absent(self):
        files = {"demo/SKILL.md": entry(b"v2"), "demo/agents/openai.yaml": entry(b"y")}
        got = self.run_remote(files, clients=("codex", "claude"))
        self.assertEqual((got["status"], sorted(got["added"])), ("updated", ["claude:demo/SKILL.md", "claude:demo/agents/openai.yaml"]))
        self.assertEqual(got["clients"], {"codex": "absent", "claude": "present"})
        self.assertEqual(self.skill("demo/SKILL.md").read_bytes(), b"v2")
        self.assertEqual(self.run_remote(files)["status"], "same")

    def test_configured_pi_receives_same_skills_globals_and_conflict_protection(self):
        root = self.home/'pi-runtime'; agent = root/'agent'; agent.mkdir(parents=True)
        pkg = root/'app/node_modules/@earendil-works/pi-coding-agent/package.json'
        pkg.parent.mkdir(parents=True); pkg.write_text('{"version":"1.0.0"}')
        cfg = self.home/'.paseo/config.json';cfg.parent.mkdir()
        cfg.write_text(json.dumps({'agents':{'providers':{'pi':{'command':['node',str(root/'launch.mjs')]}}}}))
        files = {'demo/SKILL.md': entry(b'same verified skill')}
        glob = {**entry(b'same global'), 'targets': {'claude': '~/.claude/CLAUDE.md'}}
        self.assertEqual(self.run_remote(files,glob=glob,dry_run=True)['status'],'would update')
        self.assertFalse((agent/'skills').exists())
        got = self.run_remote(files,glob=glob)
        self.assertEqual(got['clients']['pi'],'present')
        self.assertEqual((agent/'skills/demo/SKILL.md').read_bytes(),self.skill('demo/SKILL.md').read_bytes())
        self.assertEqual((agent/'AGENTS.md').read_bytes(),b'same global')
        (agent/'skills/demo/SKILL.md').write_bytes(b'private edit')
        changed = {'demo/SKILL.md': entry(b'next',[sha(b'same verified skill')])}
        got = self.run_remote(changed)
        self.assertEqual(got['status'],'conflict')
        self.assertEqual(self.skill('demo/SKILL.md').read_bytes(),b'same verified skill')

    def test_prior_publication_is_replaced(self):
        self.skill("demo").mkdir(parents=True)
        self.skill("demo/SKILL.md").write_bytes(b"v1")
        got = self.run_remote({"demo/SKILL.md": entry(b"v2", [sha(b"v1")])})
        self.assertEqual((got["status"], got["changed"]), ("updated", ["claude:demo/SKILL.md"]))
        self.assertEqual(self.skill("demo/SKILL.md").read_bytes(), b"v2")

    def test_local_edit_is_a_conflict_and_nothing_is_written(self):
        self.skill("demo").mkdir(parents=True)
        self.skill("demo/SKILL.md").write_bytes(b"my edit")
        files = {"demo/SKILL.md": entry(b"v2", [sha(b"v1")]), "other/SKILL.md": entry(b"o")}
        got = self.run_remote(files)
        self.assertEqual((got["status"], got["conflicts"]), ("conflict", ["claude:demo/SKILL.md"]))
        self.assertEqual(self.skill("demo/SKILL.md").read_bytes(), b"my edit")
        self.assertFalse(self.skill("other").exists())

    def test_unselected_files_are_left_alone(self):
        self.skill("demo").mkdir(parents=True)
        self.skill("demo/notes.md").write_bytes(b"mine")
        self.run_remote({"demo/SKILL.md": entry(b"v2")})
        self.assertEqual(self.skill("demo/notes.md").read_bytes(), b"mine")

    def test_symlinked_ancestor_is_refused(self):
        elsewhere = self.home / "elsewhere"
        elsewhere.mkdir()
        (self.home / ".claude/skills").symlink_to(elsewhere)
        got = self.run_remote({"demo/SKILL.md": entry(b"v2")})
        self.assertEqual(got["status"], "failed")
        self.assertIn("not a real directory", got["error"])
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_linked_client_home_is_refused(self):
        elsewhere = self.home / "elsewhere"
        (elsewhere / "skills").mkdir(parents=True)
        (self.home / ".claude").rmdir()
        (self.home / ".claude").symlink_to(elsewhere, target_is_directory=True)
        got = self.run_remote({"demo/SKILL.md": entry(b"v2")})
        self.assertEqual(got["status"], "failed", got)
        self.assertIn("not a real directory: " + str(self.home / ".claude"), got["error"])
        self.assertEqual(list((elsewhere / "skills").iterdir()), [])

    def test_paths_that_name_one_file_on_another_host_are_refused(self):
        for files in ({"demo/SKILL.md": entry(b"d"), "Demo/SKILL.md": entry(b"D")}, {"demo\\..\\other/SKILL.md": entry(b"o")}):
            with self.subTest(files=list(files)):
                got = self.run_remote(files)
                self.assertEqual(got["status"], "failed", got)
                self.assertFalse(self.skill("").exists())

    def test_transfer_hash_mismatch(self):
        bad = entry(b"v2")
        bad["sha256"] = "0" * 64
        got = self.run_remote({"demo/SKILL.md": bad})
        self.assertIn("hash mismatch in transfer", got["error"])
        self.assertFalse(self.skill("demo").exists())

    def test_global_instructions_follow_the_sync_record(self):
        target = self.home / ".claude/CLAUDE.md"
        glob = lambda data: {**entry(data), "targets": {"claude": "~/.claude/CLAUDE.md", "codex": "$CODEX_HOME/AGENTS.md"}}
        target.write_bytes(b"hand written")
        got = self.run_remote({}, glob=glob(b"g1"))
        self.assertEqual((got["status"], got["conflicts"]), ("conflict", ["claude:global"]))
        target.write_bytes(b"g1")
        self.assertEqual(self.run_remote({}, glob=glob(b"g1"))["status"], "same")
        got = self.run_remote({}, glob=glob(b"g2"))
        self.assertEqual((got["status"], got["changed"]), ("updated", ["claude:global"]))
        self.assertEqual(target.read_bytes(), b"g2")
        self.assertFalse((self.home / ".codex").exists(), "absent client gets no global file")
        record = json.loads((self.home / ".config/loadout/global-sync.json").read_text())
        self.assertEqual(record, {str(target): sha(b"g2")})

    def test_retires_a_recorded_skill_and_keeps_unrecorded_or_edited_ones(self):
        files = {"demo/SKILL.md": entry(b"d"), "old/SKILL.md": entry(b"o"), "old/refs/a.md": entry(b"a"),
                 "edited/SKILL.md": entry(b"e")}
        self.assertEqual(self.run_remote(files, keep=["demo", "edited", "old"])["status"], "updated")
        self.skill("edited/SKILL.md").write_bytes(b"my edit")
        self.skill("mine").mkdir()
        self.skill("mine/SKILL.md").write_bytes(b"never synced")
        published = {"demo/SKILL.md": entry(b"d")}
        got = self.run_remote(published, keep=["demo"], dry_run=True)
        self.assertEqual((got["status"], got["retired"], got["kept"]), ("would update", ["claude:old"], ["claude:edited"]))
        self.assertIn("would retire unpublished: claude:old", skills_sync.describe(got))
        self.assertTrue(self.skill("old/refs/a.md").exists())
        got = self.run_remote(published, keep=["demo"])
        self.assertEqual((got["status"], got["retired"], got["kept"]), ("updated", ["claude:old"], ["claude:edited"]))
        self.assertFalse(self.skill("old").exists())
        self.assertEqual(self.skill("edited/SKILL.md").read_bytes(), b"my edit")
        self.assertEqual(self.skill("mine/SKILL.md").read_bytes(), b"never synced")
        record = json.loads((self.home / ".config/loadout/global-sync.json").read_text())
        self.assertEqual([sorted(owned) for owned in record["skills"].values()], [["demo/SKILL.md"]])
        got = self.run_remote(published, keep=["demo"])
        self.assertEqual((got["status"], got["retired"], got["kept"]), ("same", [], []))
        self.assertTrue(self.skill("edited").exists() and self.skill("mine").exists())

    def test_skill_edited_between_preflight_and_removal_is_kept(self):
        self.run_remote({"demo/SKILL.md": entry(b"d1"), "old/SKILL.md": entry(b"o")}, keep=["demo", "old"])
        # Preloaded into the host program: its first write (demo's update, after preflight) also edits old.
        hook = self.home / "edit-on-first-write.js"
        hook.write_text('const fs = require("fs"), rename = fs.renameSync;\n'
                        'fs.renameSync = (...args) => { fs.renameSync = rename;\n'
                        '  fs.writeFileSync(process.env.LOADOUT_TEST_EDIT, "edited during the sync"); return rename(...args); };\n')
        got = self.run_remote({"demo/SKILL.md": entry(b"d2", [sha(b"d1")])}, keep=["demo"], preload=hook,
                              extra_env={"LOADOUT_TEST_EDIT": str(self.skill("old/SKILL.md"))})
        self.assertEqual((got["status"], got["changed"], got["retired"], got["kept"]),
                         ("updated", ["claude:demo/SKILL.md"], [], ["claude:old (changed since preflight)"]))
        self.assertIn("kept and stop managing: claude:old (changed since preflight)", skills_sync.describe(got))
        self.assertEqual(self.skill("old/SKILL.md").read_bytes(), b"edited during the sync")
        self.assertEqual(self.skill("demo/SKILL.md").read_bytes(), b"d2")

    def test_dry_run_writes_nothing(self):
        got = self.run_remote({"demo/SKILL.md": entry(b"v2")}, dry_run=True)
        self.assertEqual(got["status"], "would update")
        self.assertFalse(self.skill("demo").exists())


HOSTS = {
    "schema_version": 2, "source_host": "laptop", "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"], "exclude_skills": ["grilling"]},
        {"name": "desktop", "os": "linux", "clients": ["codex", "claude"]},
        {"name": "tablet", "os": "linux", "transport": "paseo-relay", "sync": ["providers"], "paseo_offer": "t.offer"},
    ],
    "global": {"claude": "~/.claude/CLAUDE.md"},
}


class SkillsSyncTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = self.root / "fleet"
        (self.fleet / "global").mkdir(parents=True)
        (self.fleet / "hosts.json").write_text(json.dumps(HOSTS))
        (self.fleet / "global/AGENTS.md").write_text("# Global\n")
        self.ssh = install_fake_ssh(self.root / "bin")
        for host in ("laptop", "desktop"):
            (self.root / "hosts" / host / ".claude").mkdir(parents=True)
        (self.root / "hosts/desktop/.codex").mkdir()
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.root / "hosts/laptop"),
                    "LOADOUT_FLEET": str(self.fleet), "FAKE_ROOT": str(self.root)}
        self.env.update({k: v for k, v in os.environ.items()
                         if k.upper() in ("SYSTEMROOT", "TEMP", "TMP")})
        self.env["USERPROFILE"] = self.env["HOME"]
        self.env["APPDATA"] = str(self.root / "hosts/laptop/.config")
        assert_fake(self.ssh, self.env)

    def tearDown(self):
        self.tmp.cleanup()

    def run_sync(self, *args):
        done = subprocess.run(with_fake_ssh(SCRIPTS / "skills_sync.py", self.ssh, "--skills", "handoff,grilling", *args),
                              env=self.env, capture_output=True, text=True, timeout=120)
        return done.returncode, done.stdout + done.stderr

    def installed(self, host, rel):
        return self.root / "hosts" / host / rel

    def test_install_from_the_verified_manifest(self):
        code, out = self.run_sync()
        self.assertEqual(code, 0, out)
        manifest = json.loads((REPO / "MANIFEST.json").read_text())
        handoff = [e for e in manifest["files"] if e["skill"] == "handoff"]
        for e in handoff:
            rel = "/".join(e["path"].split("/")[3:])
            for root in ("hosts/desktop/.codex/skills", "hosts/desktop/.claude/skills", "hosts/laptop/.claude/skills"):
                data = (self.root / root / "handoff" / rel).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), e["sha256"])
        self.assertTrue(self.installed("desktop", ".claude/skills/grilling/SKILL.md").exists())
        self.assertFalse(self.installed("laptop", ".claude/skills/grilling").exists(), "excluded on laptop")
        self.assertEqual(self.installed("desktop", ".claude/CLAUDE.md").read_text(), "# Global\n")
        self.assertIn("laptop: skills updated", out)
        self.assertIn("excluded grilling", out)
        self.assertIn("desktop: skills updated", out)
        self.assertNotIn("tablet", out)
        code, out = self.run_sync()
        self.assertEqual(out.count("skills same"), 2, out)

    def test_conflict_exit_code_and_dry_run(self):
        code, out = self.run_sync("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("skills would update"), 2, out)
        self.assertFalse(self.installed("desktop", ".claude/skills").exists())
        target = self.installed("desktop", ".claude/skills/handoff/SKILL.md")
        target.parent.mkdir(parents=True)
        target.write_text("edited")
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 1)
        self.assertIn("desktop: skills conflict: local edits, nothing written: claude:handoff/SKILL.md", out)

    def overlay(self, rel, data):
        path = self.fleet / "skills" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data)

    def test_private_overlay_installs_updates_and_keeps_hand_edits(self):
        self.overlay("mine/SKILL.md", "v1")
        self.overlay("mine/__pycache__/x.pyc", "junk")
        code, out = self.run_sync("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.fleet / "skills/.loadout-overlay.json").exists(), "dry run records nothing")
        done = subprocess.run(with_fake_ssh(SCRIPTS / "skills_sync.py", self.ssh, "--skills", "handoff,mine"),
                              env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("2 skills selected (1 from the private overlay)", done.stdout)
        target = self.installed("desktop", ".claude/skills/mine/SKILL.md")
        self.assertEqual(target.read_text(), "v1")
        self.assertFalse(self.installed("desktop", ".claude/skills/mine/__pycache__").exists())
        self.overlay("mine/SKILL.md", "v2")
        code, out = self.run_sync("--skills", "mine")
        self.assertEqual(code, 0, out)
        self.assertEqual(target.read_text(), "v2")
        history = json.loads((self.fleet / "skills/.loadout-overlay.json").read_text())
        self.assertEqual(history["mine/SKILL.md"], sorted([sha(b"v1"), sha(b"v2")]))
        target.write_text("hand edit")
        self.overlay("mine/SKILL.md", "v3")
        code, out = self.run_sync("--skills", "mine", "--host", "desktop")
        self.assertEqual(code, 1, out)
        self.assertIn("conflict: local edits, nothing written: claude:mine/SKILL.md", out)
        self.assertEqual(target.read_text(), "hand edit")

    @unittest.skipIf(os.name == "nt", "POSIX permissions; Windows hosts rely on the profile's owner-only ACL")
    def test_private_overlay_is_owner_only_on_the_host(self):
        old = os.umask(0o022)
        self.addCleanup(os.umask, old)
        self.overlay("creds/SKILL.md", "v1")
        self.overlay("creds/refs/token.md", "secret")
        code, out = self.run_sync("--skills", "creds", "--host", "desktop")
        self.assertEqual(code, 0, out)
        for root in (".claude/skills", ".codex/skills"):
            skill = self.installed("desktop", f"{root}/creds")
            for path, mode in ((skill, 0o700), (skill / "refs", 0o700), (skill / "SKILL.md", 0o600),
                               (skill / "refs/token.md", 0o600)):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode, path)
        self.overlay("creds/refs/token.md", "secret v2")
        code, out = self.run_sync("--skills", "creds", "--host", "desktop")
        self.assertEqual(code, 0, out)
        token = self.installed("desktop", ".claude/skills/creds/refs/token.md")
        self.assertEqual((token.read_text(), stat.S_IMODE(token.stat().st_mode)), ("secret v2", 0o600))

    def test_overlay_history_is_one_locked_transaction(self):
        self.overlay("mine/SKILL.md", "v1")
        history = self.fleet / "skills/.loadout-overlay.json"
        with mock.patch.object(skills_sync, "OVERLAY_LOCK_SECONDS", 0.2), skills_sync.overlay_lock(self.fleet):
            with self.assertRaisesRegex(fleet.FleetError, "overlay history stayed locked"):
                skills_sync.record_overlay(self.fleet, {"mine/SKILL.md": {"sha256": sha(b"v1")}})
        self.assertFalse(history.exists())
        skills_sync.record_overlay(self.fleet, {"mine/SKILL.md": {"sha256": sha(b"v1")}})
        self.assertEqual(json.loads(history.read_text()), {"mine/SKILL.md": [sha(b"v1")]})
        self.assertEqual(sorted(p.name for p in history.parent.iterdir()),
                         [".loadout-overlay.json", ".loadout-overlay.json.lock", "mine"])

    def full_sync(self, history):
        """An unnarrowed sync, so retirement is on, whose publication history also holds history's paths."""
        command = [sys.executable, "-c", WITH_HISTORY, str(SCRIPTS), json.dumps(list(self.ssh)), json.dumps(history)]
        done = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=120)
        return done.returncode, done.stdout + done.stderr

    def legacy_install(self, host, roots, skill, data):
        """Install a skill as an earlier sync did: its files, and the host's record of them, with no provenance."""
        path = self.installed(host, ".config/loadout/global-sync.json")
        record = json.loads(path.read_text()) if path.exists() else {}
        for root in roots:
            base = self.installed(host, root)
            (base / skill).mkdir(parents=True, exist_ok=True)
            (base / skill / "SKILL.md").write_bytes(data)
            record.setdefault("skills", {}).setdefault(str(base), {})[f"{skill}/SKILL.md"] = sha(data)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record))

    def test_missing_overlay_keeps_a_formerly_public_skill_from_a_legacy_record(self):
        # moved was published once, then moved into the overlay, which is now missing.
        (self.fleet / "hosts.json").write_text(json.dumps({**HOSTS, "skills_overlay": True}))
        self.legacy_install("desktop", (".claude/skills", ".codex/skills"), "moved", b"moved")
        code, out = self.full_sync({"skills/misc/moved/SKILL.md": [sha(b"moved")]})
        self.assertEqual(code, 1, out)
        why = ("retirement stopped: hosts.json sets skills_overlay, but the fleet overlay skills/ is missing, so no host "
               "retires anything; restore it, or leave an empty skills/ to retire its skills")
        self.assertIn("desktop: skills blocked (+", out)
        self.assertIn(f"; codex present, claude present; {why}", out)
        self.assertIn(f"; claude present; {why}; excluded grilling", out)
        for root in (".claude/skills", ".codex/skills"):
            self.assertEqual(self.installed("desktop", f"{root}/moved/SKILL.md").read_bytes(), b"moved")

    def test_missing_overlay_also_keeps_an_unrelated_retired_public_skill(self):
        (self.fleet / "hosts.json").write_text(json.dumps({**HOSTS, "skills_overlay": True}))
        self.legacy_install("desktop", (".claude/skills",), "old", b"old")
        history = {"skills/misc/old/SKILL.md": [sha(b"old")]}
        # No overlay skill is recorded anywhere, and old is a plain unpublished package: still every host stops.
        code, out = self.full_sync(history)
        self.assertEqual(code, 1, out)
        self.assertEqual(out.count("skills blocked"), 2, out)
        self.assertNotIn("retired unpublished", out)
        self.assertEqual(self.installed("desktop", ".claude/skills/old/SKILL.md").read_bytes(), b"old")
        # A present, empty overlay retires as before.
        (self.fleet / "skills").mkdir()
        code, out = self.full_sync(history)
        self.assertEqual(code, 0, out)
        self.assertIn("desktop: skills updated (-1); codex present, claude present; retired unpublished: claude:old", out)
        self.assertFalse(self.installed("desktop", ".claude/skills/old").exists())

    def test_overlay_is_not_pushed_with_the_fleet(self):
        self.overlay("mine/SKILL.md", "v1")
        self.assertNotIn("skills/mine/SKILL.md", fleet.fleet_files(self.fleet))
        self.assertIn("hosts.json", fleet.fleet_files(self.fleet))

    def test_overlay_name_clash_and_missing_skill_md(self):
        self.overlay("handoff/SKILL.md", "shadow")
        code, out = self.run_sync()
        self.assertEqual(code, 1)
        self.assertIn("overlay skill handoff has the same name as a published skill", out)
        shutil.rmtree(self.fleet / "skills/handoff")
        self.overlay("bare/notes.md", "x")
        code, out = self.run_sync()
        self.assertEqual(code, 1)
        self.assertIn("overlay skill bare has no SKILL.md", out)

    def test_moved_skill_replaces_its_last_published_copy(self):
        class Pub:
            def prior(self):
                return {"skills/misc/moved/SKILL.md": [sha(b"published")], "plugins/p/x.js": [sha(b"p")]}
        by_dest = skills_sync.published_prior_by_dest(Pub())
        self.assertEqual(by_dest, {"moved/SKILL.md": {sha(b"published")}})
        self.overlay("moved/SKILL.md", "private")
        files = skills_sync.overlay_files(self.fleet, {"handoff"}, by_dest)
        self.assertEqual(files["moved/SKILL.md"]["prior"], [sha(b"published")])

    def test_unknown_skill_and_host(self):
        done = subprocess.run(with_fake_ssh(SCRIPTS / "skills_sync.py", self.ssh, "--skills", "nope"), env=self.env,
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn("unknown skills: ['nope']", done.stderr)
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()

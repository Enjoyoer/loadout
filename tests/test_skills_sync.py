import base64
import hashlib
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
sys.path.insert(0, str(SCRIPTS))
import fleet  # noqa: E402
import skills_sync  # noqa: E402

FAKE_SSH = textwrap.dedent(r"""
    #!/bin/sh
    [ "$1" = "--fake-ok" ] && { echo fake; exit 0; }
    while [ "$1" = "-o" ] || [ "$1" = "-n" ]; do [ "$1" = "-o" ] && shift; shift; done
    host="$1"; shift
    unset CODEX_HOME XDG_CONFIG_HOME
    HOME="$FAKE_ROOT/hosts/$host" exec sh -c "$*"
    """).lstrip()


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

    def run_remote(self, files, clients=("claude",), glob=None, dry_run=False):
        payload = {"dry_run": dry_run, "clients": list(clients), "files": files, "global": glob}
        env = {k: v for k, v in os.environ.items() if k not in ("CODEX_HOME", "XDG_CONFIG_HOME")}
        env["HOME"] = str(self.home)
        done = subprocess.run(["node", "-e", fleet.BOOT, "--", fleet.pack(skills_sync.REMOTE_JS.read_bytes())],
                              input=fleet.pack(json.dumps(payload).encode()), capture_output=True, text=True, env=env)
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
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        (bin_dir / "ssh").write_text(FAKE_SSH)
        (bin_dir / "ssh").chmod(0o755)
        for host in ("laptop", "desktop"):
            (self.root / "hosts" / host / ".claude").mkdir(parents=True)
        (self.root / "hosts/desktop/.codex").mkdir()
        self.env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.root / "hosts/laptop"),
                    "LOADOUT_FLEET": str(self.fleet), "FAKE_ROOT": str(self.root)}
        done = subprocess.run(["ssh", "--fake-ok"], env=self.env, capture_output=True, text=True)
        self.assertEqual(done.stdout.strip(), "fake", "fake ssh is not the binary on PATH")

    def tearDown(self):
        self.tmp.cleanup()

    def run_sync(self, *args):
        done = subprocess.run([sys.executable, str(SCRIPTS / "skills_sync.py"), "--skills", "handoff,grilling", *args],
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
        done = subprocess.run([sys.executable, str(SCRIPTS / "skills_sync.py"), "--skills", "handoff,mine"],
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
        files = skills_sync.overlay_files(self.fleet, {"handoff"}, by_dest, record=False)
        self.assertEqual(files["moved/SKILL.md"]["prior"], [sha(b"published")])

    def test_unknown_skill_and_host(self):
        done = subprocess.run([sys.executable, str(SCRIPTS / "skills_sync.py"), "--skills", "nope"], env=self.env,
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn("unknown skills: ['nope']", done.stderr)
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()

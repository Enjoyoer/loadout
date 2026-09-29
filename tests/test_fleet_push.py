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

# Runs the remote command in a per-host home, with stdin passed through.
FAKE_SSH = textwrap.dedent("""\
    #!/bin/sh
    while [ "$1" = "-o" ] || [ "$1" = "-n" ]; do [ "$1" = "-o" ] && shift; shift; done
    host="$1"; shift
    [ -e "$FAKE_ROOT/down-$host" ] && { echo "ssh: connect to host $host: timed out" >&2; exit 255; }
    unset XDG_CONFIG_HOME LOADOUT_FLEET
    HOME="$FAKE_ROOT/hosts/$host" exec sh -c "$*"
    """)

HOSTS = {
    "schema_version": 2,
    "source_host": "laptop",
    "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"]},
        {"name": "desktop", "os": "linux", "clients": ["codex"]},
        {"name": "devbox", "os": "linux", "sync": ["providers"]},
        {"name": "tablet", "os": "linux", "transport": "paseo-relay", "sync": ["providers"],
         "paseo_offer": "tablet.offer"},
    ],
}


class FleetPushTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "hosts/laptop/.config/loadout/fleet"
        (self.source / "global").mkdir(parents=True)
        (self.source / "hosts.json").write_text(json.dumps(HOSTS, indent=2))
        (self.source / "global/AGENTS.md").write_text("# Global\n")
        for host in ("desktop", "devbox", "tablet"):
            (self.root / "hosts" / host).mkdir(parents=True)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        (bin_dir / "ssh").write_text(FAKE_SSH)
        (bin_dir / "ssh").chmod(0o755)
        self.env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.root / "hosts/laptop"),
                    "FAKE_ROOT": str(self.root)}

    def tearDown(self):
        self.tmp.cleanup()

    def target(self, host):
        return self.root / "hosts" / host / ".config/loadout/fleet"

    def push(self, *args):
        done = subprocess.run([sys.executable, str(SCRIPTS / "fleet.py"), "push", *args], env=self.env,
                              capture_output=True, text=True, timeout=60)
        return done.returncode, done.stdout + done.stderr

    def snapshot(self, directory):
        return {p.relative_to(directory).as_posix(): p.read_bytes() for p in directory.rglob("*")
                if p.is_file() and p.name != fleet.SYNC_RECORD}

    def test_first_push_copies_to_ssh_hosts_only(self):
        code, out = self.push()
        self.assertEqual(code, 0, out)
        self.assertIn(f"fleet: config {self.source}", out)
        self.assertIn("desktop: fleet updated (+2)", out)
        self.assertIn("devbox: fleet updated (+2)", out)
        self.assertIn("tablet: fleet not needed (paseo-relay)", out)
        self.assertNotIn("laptop:", out)
        for host in ("desktop", "devbox"):
            self.assertEqual(self.snapshot(self.target(host)), self.snapshot(self.source))
            record = json.loads((self.target(host) / fleet.SYNC_RECORD).read_text())
            self.assertEqual(set(record["files"]), {"hosts.json", "global/AGENTS.md"})
        self.assertFalse((self.root / "hosts/tablet/.config").exists())

        code, out = self.push()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("fleet same"), 2, out)

    def test_source_edits_and_removals_flow_to_unedited_copies(self):
        self.push()
        (self.source / "global/AGENTS.md").write_text("# Global v2\n")
        (self.source / "paseo-providers.json").write_text("{}")
        code, out = self.push("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertIn("desktop: fleet updated (+1 ~1)", out)
        (self.source / "paseo-providers.json").unlink()
        code, out = self.push("--host", "desktop")
        self.assertIn("desktop: fleet updated (-1)", out)
        self.assertEqual(self.snapshot(self.target("desktop")), self.snapshot(self.source))
        self.assertNotIn("devbox", out)

    def test_hand_edit_on_host_is_a_conflict_and_nothing_is_written(self):
        self.push()
        (self.target("desktop") / "hosts.json").write_text("{}")
        (self.source / "global/AGENTS.md").write_text("# Global v2\n")
        code, out = self.push()
        self.assertEqual(code, 1, out)
        self.assertIn("desktop: fleet conflict: hand-edited on the host, nothing written: hosts.json", out)
        self.assertEqual((self.target("desktop") / "global/AGENTS.md").read_text(), "# Global\n")
        self.assertIn("devbox: fleet updated (~1)", out)

    def test_file_added_on_host_is_a_conflict(self):
        self.push()
        (self.target("devbox") / "notes.txt").write_text("local")
        code, out = self.push("--host", "devbox")
        self.assertEqual(code, 1)
        self.assertIn("conflict: hand-edited on the host, nothing written: notes.txt", out)

    def test_existing_copy_without_record(self):
        shutil.copytree(self.source, self.target("desktop"))
        code, out = self.push("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertIn("desktop: fleet same", out)
        self.assertTrue((self.target("desktop") / fleet.SYNC_RECORD).exists())
        (self.target("devbox")).mkdir(parents=True)
        (self.target("devbox") / "hosts.json").write_text("{}")
        code, out = self.push("--host", "devbox")
        self.assertEqual(code, 1)
        self.assertIn("conflict", out)

    def test_dry_run_writes_nothing(self):
        code, out = self.push("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("fleet would update (+2)"), 2, out)
        self.assertFalse(self.target("desktop").exists())

    def test_symlinked_target_is_refused(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.target("desktop").parent.mkdir(parents=True)
        self.target("desktop").symlink_to(elsewhere)
        code, out = self.push("--host", "desktop")
        self.assertEqual(code, 1)
        self.assertIn("desktop: fleet FAILED: not a real directory", out)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_unreachable_host_fails_only_that_host(self):
        (self.root / "down-desktop").touch()
        code, out = self.push()
        self.assertEqual(code, 1)
        self.assertIn("desktop: fleet FAILED: no result from host (exit 255)", out)
        self.assertIn("devbox: fleet updated", out)

    def test_source_host_and_unknown_host(self):
        self.assertEqual(self.push("--host", "laptop"), (0, f"fleet: config {self.source}\nlaptop: fleet source (not pushed)\n"))
        code, out = self.push("--host", "nowhere")
        self.assertEqual(code, 2)

    def test_transfer_hash_is_checked_before_writing(self):
        files = fleet.fleet_files(self.source)
        files["hosts.json"]["sha256"] = "0" * 64
        body = fleet.pack(json.dumps({"dry_run": False, "target": str(self.target("desktop")), "files": files}).encode())
        done = subprocess.run(["node", "-e", fleet.BOOT, "--", fleet.pack(fleet.PUSH_JS.read_bytes())],
                              input=body, capture_output=True, text=True)
        result = fleet.parse_result(done.stdout)
        self.assertEqual(result["status"], "failed")
        self.assertIn("hash mismatch in transfer: hosts.json", result["error"])
        self.assertFalse(self.target("desktop").exists())


if __name__ == "__main__":
    unittest.main()

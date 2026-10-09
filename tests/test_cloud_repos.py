import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "skills/orchestration/opc/scripts/cloud-lane.mjs"


def node(code):
    done = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, timeout=60)
    if done.returncode:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


class CloudReposTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "cloud-repos")

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, allow, repos):
        return node(f"""
            import {{ setCloudRepo, isCloudRepo }} from {json.dumps(SCRIPT.as_uri())};
            const path = {json.dumps(self.path)};
            for (const repo of {json.dumps(allow)}) setCloudRepo(repo, true, {{ path }});
            console.log(JSON.stringify({json.dumps(repos)}.map(repo => isCloudRepo(repo, {{ path }}))));
        """)

    def test_missing_list_confirms_nothing(self):
        self.assertEqual(self.check([], ["Acme/app"]), [False])

    def test_exact_repo(self):
        self.assertEqual(self.check(["Acme/app"], ["Acme/app", "acme/APP", "Acme/other", "Other/app"]),
                         [True, True, False, False])

    def test_owner_wildcard_covers_every_repo_of_that_owner_only(self):
        self.assertEqual(self.check(["Acme/*"], ["Acme/app", "acme/tools", "Other/app", "Acme/*", "Acme"]),
                         [True, True, False, False, False])

    def test_invalid_entries_are_rejected(self):
        for bad in ("*/*", "Acme", "Acme/a*", "a/b/c", "Acme/app;id"):
            with self.subTest(bad=bad), self.assertRaises(AssertionError):
                self.check([bad], [])

    def test_fleet_host_starting_with_dash_is_refused_before_ssh(self):
        home, bin_dir = Path(self.tmp.name) / "home", Path(self.tmp.name) / "bin"
        bin_dir.mkdir()
        calls = Path(self.tmp.name) / "ssh-calls"
        ssh = bin_dir / "ssh"
        ssh.write_text(f"#!/bin/sh\necho \"$@\" >> {calls}\n")
        ssh.chmod(0o755)
        env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
        done = subprocess.run(["node", str(SCRIPT), "allow", "Acme/app", "--fleet", "-oProxyCommand=x"],
                              capture_output=True, text=True, timeout=60, env=env)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("invalid fleet host name", done.stderr)
        self.assertFalse(calls.exists())
        self.assertFalse((home / ".config/opc/cloud-repos").exists())


if __name__ == "__main__":
    unittest.main()

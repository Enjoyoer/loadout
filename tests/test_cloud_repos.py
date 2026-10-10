import json
import os
import shlex
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

    def test_dangling_cloud_toggle_link_fails_closed(self):
        toggle, target = Path(self.tmp.name) / "cloud", Path(self.tmp.name) / "toggle-target"
        try:
            os.symlink(target, toggle)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable")
        read = f"""
            import {{ readCloudToggle }} from {json.dumps(SCRIPT.as_uri())};
            const read = path => {{ try {{ return readCloudToggle({{ path }}); }} catch (error) {{ return error.code ?? error.message; }} }};
            console.log(JSON.stringify([read({json.dumps(str(toggle))}), read({json.dumps(str(target))})]));
        """
        # The owner's toggle points at a target that is gone: not the default, which would offload code lanes.
        self.assertEqual(node(read), ["ENOENT", "default"])
        target.write_text("off\n")
        self.assertEqual(node(read), ["off", "off"])

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

    def test_fleet_command_survives_cmd_exe_parsing(self):
        built = node(f"""
            import {{ buildFleetCommand }} from {json.dumps(SCRIPT.as_uri())};
            console.log(JSON.stringify(buildFleetCommand(['allow', 'Acme/*'])));
        """)
        command = built["command"]
        # cmd.exe passes the line through, acting only on quotes and its metacharacters; sh has its own set.
        self.assertFalse(set(command) & set("\"'^%&|<>()!*?$`\\;~"), command)
        self.assertEqual(command.split(), shlex.split(command))
        home = Path(self.tmp.name) / "home"
        scripts = home / ".claude/skills/opc/scripts"
        scripts.mkdir(parents=True)
        (scripts / "cloud-lane.mjs").write_text("console.log(JSON.stringify(process.argv.slice(2)))\n")
        done = subprocess.run(command.split(), input=built["input"], capture_output=True, text=True, timeout=60,
                              env={**os.environ, "HOME": str(home), "USERPROFILE": str(home)})
        self.assertEqual(json.loads(done.stdout), ["allow", "Acme/*"], done.stderr)


if __name__ == "__main__":
    unittest.main()

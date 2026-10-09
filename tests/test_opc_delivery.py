import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "skills/orchestration/opc/scripts"


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=60)


class OpcDeliveryTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node") or not shutil.which("git"):
            self.skipTest("node and git are required")
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(os.path.realpath(self.tmp.name))
        self.repo, runs = root / "repo", root / "run"
        self.repo.mkdir()
        runs.mkdir()
        for args in (["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://github.com/example/app.git"],
                     ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)
        done = run("node", "--input-type=module", "-e", f"""
            import {{ createTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            console.log(createTask({{ workingDirectory: {json.dumps(str(self.repo))}, runDirectory: {json.dumps(str(runs))}, owner: 'test' }}).taskPath);
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.task = done.stdout.strip()

    def tearDown(self):
        self.tmp.cleanup()

    def test_stale_running_tests_with_dead_pid_recover(self):
        dead = subprocess.Popen([sys.executable, "-c", ""])
        dead.wait()
        task = json.loads(Path(self.task).read_text())
        task["tests"] = {"status": "running", "pid": dead.pid, "started_at": "2026-01-01T00:00:00.000Z"}
        Path(self.task).write_text(json.dumps(task))
        delivery = str(SCRIPTS / "delivery.mjs")
        recovered = run("node", delivery, "reconcile", self.task)
        self.assertEqual(json.loads(recovered.stdout)["reason"], "interrupted", recovered.stderr)
        rerun = run("node", delivery, "test", self.task, sys.executable, "-c", "")
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertEqual(json.loads(rerun.stdout.strip().splitlines()[-1])["status"], "passed")

    def test_live_lock_replacing_stale_lock_before_reclaim_survives(self):
        dead = subprocess.Popen([sys.executable, "-c", ""])
        dead.wait()
        lock = Path(self.task + ".lock")
        lock.write_text(str(dead.pid))
        done = run("node", "--input-type=module", "-e", f"""
            import {{ unlinkSync, writeFileSync }} from 'node:fs';
            import {{ updateTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            const beforeReclaim = lock => {{ unlinkSync(lock); writeFileSync(lock, String({os.getpid()}), {{ flag: 'wx' }}); }};
            try {{ updateTask({json.dumps(self.task)}, () => {{}}, {{ beforeReclaim }}); }}
            catch (error) {{ console.log(error.message); }}
        """)
        self.assertIn("task lock busy", done.stdout, done.stderr)
        self.assertEqual(lock.read_text(), str(os.getpid()))
        self.assertEqual(sorted(p.name for p in lock.parent.iterdir() if ".lock" in p.name), [lock.name])


if __name__ == "__main__":
    unittest.main()

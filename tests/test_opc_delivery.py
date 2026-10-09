import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "skills/orchestration/opc/scripts"


def run(*args, cwd=None, env=None):
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=60)


CATALOG = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptionIds": ["medium", "high", "xhigh"]}]


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

    def test_reused_live_pid_does_not_keep_tests_running(self):
        task = json.loads(Path(self.task).read_text())
        task['tests'] = {'status': 'running', 'pid': os.getpid(), 'started_at': '2020-01-01T00:00:00.000Z'}
        Path(self.task).write_text(json.dumps(task))
        done = run('node', str(SCRIPTS / 'delivery.mjs'), 'reconcile', self.task)
        self.assertEqual(json.loads(done.stdout)['reason'], 'interrupted', done.stderr)

    @unittest.skipIf(sys.platform == 'win32', 'POSIX process groups only')
    def test_recovery_kills_test_grandchild_group(self):
        pidfile = Path(self.task).parent / 'grandchild.pid'
        command = ('import subprocess,time; p=subprocess.Popen([' + repr(sys.executable) +
                   ',"-c","import time; time.sleep(120)"]); open(' + repr(str(pidfile)) +
                   ',"w").write(str(p.pid)); time.sleep(120)')
        runner = subprocess.Popen(['node', str(SCRIPTS / 'delivery.mjs'), 'test', self.task,
                                   sys.executable, '-c', command], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                if pidfile.exists() and json.loads(Path(self.task).read_text()).get('tests', {}).get('child_pid'):
                    break
                time.sleep(.05)
            self.assertTrue(pidfile.exists())
            grandchild = int(pidfile.read_text())
            runner.kill()
            runner.wait(timeout=5)
            done = run('node', str(SCRIPTS / 'delivery.mjs'), 'reconcile', self.task)
            self.assertEqual(json.loads(done.stdout)['reason'], 'interrupted', done.stderr)
            for _ in range(30):
                state = subprocess.run(['ps', '-p', str(grandchild), '-o', 'stat='], capture_output=True, text=True)
                if not state.stdout.strip() or state.stdout.lstrip().startswith('Z'):
                    break
                time.sleep(.05)
            else:
                self.fail('grandchild still running after recovery')
        finally:
            if runner.poll() is None:
                runner.kill()
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), 9)
                except ProcessLookupError:
                    pass

    def test_cloud_intent_precedes_command_and_failed_launch_refuses_retry(self):
        done = run('node', '--input-type=module', '-e', f'''
            import {{ beginCloudLaunch, recordCloudLaunchFailure }} from {json.dumps((SCRIPTS / 'cloud-lane.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            const task = {json.dumps(self.task)}, lane = {{branch:'opc/example',repo:'example/app'}};
            beginCloudLaunch(task,lane);
            if (readTask(task).cloud.status !== 'launching') throw Error('intent missing before command');
            recordCloudLaunchFailure(task,'capture interrupted');
            try {{ beginCloudLaunch(task,lane); throw Error('second launch allowed'); }}
            catch (error) {{ if (!error.message.includes('already recorded')) throw error; }}
            console.log('refused');
        ''')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('refused', done.stdout)
        listed = run('node', str(SCRIPTS / 'cloud-lane.mjs'), 'reconcile', self.task)
        self.assertEqual(json.loads(listed.stdout)['status'], 'uncertain', listed.stderr)

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
        self.assertIn("task lock contention", done.stdout, done.stderr)
        self.assertEqual(lock.read_text(), str(os.getpid()))
        self.assertEqual(sorted(p.name for p in lock.parent.iterdir() if ".lock" in p.name), [lock.name])

    def test_recorded_route_reads_and_updates_after_class_table_change(self):
        root = Path(self.task).parent.parent
        (root / "catalog.json").write_text(json.dumps(CATALOG))
        recorded = run("node", str(SCRIPTS / "route.mjs"), "--class", "code", "--catalog", str(root / "catalog.json"),
                       "--pq-file", str(root / "no-pq.json"), "--task", self.task, "--lane", "code-lane")
        self.assertEqual(recorded.returncode, 0, recorded.stderr)
        # An alternate table: the same scripts with the code class fixed at a level the record does not carry.
        changed = root / "changed"
        shutil.copytree(SCRIPTS, changed)
        routing = changed / "agent-routing.mjs"
        effort = json.loads(recorded.stdout)["route"]["effort"]
        level = "medium" if effort != "medium" else "high"
        text, count = re.subn(r"^  code: workerClass\(.*$", f"  code: workerClass('Opus', '{level}', null),", routing.read_text(), flags=re.M)
        self.assertEqual(count, 1)
        routing.write_text(text)
        done = run("node", "--input-type=module", "-e", f"""
            import {{ readTask, updateTask }} from {json.dumps((changed / 'task-state.mjs').as_uri())};
            const path = {json.dumps(self.task)};
            const read = readTask(path).routes['code-lane'].route.effort;
            const updated = updateTask(path, task => {{ task.tests = null; }}).routes['code-lane'].route.effort;
            console.log(JSON.stringify([read, updated]));
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), [effort, effort])

    def test_cloud_fallback_on_cloud_lane_records_local_route_atomically(self):
        root = Path(self.task).parent.parent
        home = root / "home"
        home.mkdir()
        env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
        (root / "catalog.json").write_text(json.dumps(CATALOG))
        (root / "facts.json").write_text(json.dumps({"githubRemote": True, "claudeAppInstalled": True, "selfContained": True,
                                                     "authStatus": {"authMethod": "claude.ai"}}))
        route = ("node", str(SCRIPTS / "route.mjs"), "--catalog", str(root / "catalog.json"), "--pq-file", str(root / "no-pq.json"),
                 "--task", self.task)
        cloud = run(*route, "--class", "code", "--cloud-facts", str(root / "facts.json"), "--lane", "fix-auth", env=env)
        self.assertEqual(cloud.returncode, 0, cloud.stderr)
        cloud_route = json.loads(cloud.stdout)["route"]
        self.assertEqual(cloud_route["model"], "claude-opus-5-5[1m]")
        # A taken fallback lane makes the route write fail, which must leave cloud.fallback unwritten too.
        done = run("node", "--input-type=module", "-e", f"""
            import {{ recordCloudLaunch }} from {json.dumps((SCRIPTS / 'cloud-lane.mjs').as_uri())};
            import {{ recordWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ updateTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            const path = {json.dumps(self.task)};
            recordWorkerRoute(path, {{ lane: 'taken-fallback', reason: 'owner-named, never adjusted',
              route: {{ role: 'worker', source: 'owner-explicit', model: 'fleet/claude-opus-5-5', effort: 'high', fastMode: false }} }});
            recordCloudLaunch(path, {{ sessionId: 'session_example', url: 'https://example.invalid/session', branch: 'opc/fix-auth',
              repo: 'example/app', launchedAt: '2026-01-01T00:00:00.000Z' }});
            updateTask(path, task => {{ task.cloud.status = 'dead'; task.cloud.reason = 'session page shows failure'; }});
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        clash = run(*route, "--cloud-fallback", "--lane", "taken", env=env)
        self.assertIn("lane taken-fallback already has a recorded route", clash.stderr)
        self.assertIsNone(json.loads(Path(self.task).read_text())["cloud"]["fallback"])
        fallback = run(*route, "--cloud-fallback", "--lane", "fix-auth", env=env)
        self.assertEqual(fallback.returncode, 0, fallback.stderr)
        result = json.loads(fallback.stdout)
        self.assertEqual((result["lane"], result["route"]["source"], result["route"]["model"]),
                         ("fix-auth-fallback", "task-default", "fleet/claude-opus-5-5"))
        task = json.loads(Path(self.task).read_text())
        self.assertEqual(task["cloud"]["fallback"]["route"], result["route"])
        self.assertEqual(task["routes"]["fix-auth-fallback"]["route"], result["route"])
        self.assertEqual(task["routes"]["fix-auth"]["route"], cloud_route)

    def test_empty_lock_is_stale_only_after_ten_seconds(self):
        lock = Path(self.task + ".lock")
        update = f"""
            import {{ updateTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            try {{ updateTask({json.dumps(self.task)}, () => {{}}); console.log('updated'); }}
            catch (error) {{ console.log(error.message); }}
        """
        for age, expected in ((11, "updated"), (2, "task lock busy")):
            with self.subTest(age=age):
                lock.write_text("")
                os.utime(lock, (time.time() - age,) * 2)
                done = run("node", "--input-type=module", "-e", update)
                self.assertIn(expected, done.stdout, done.stderr)
                self.assertEqual(lock.exists(), age == 2)


if __name__ == "__main__":
    unittest.main()

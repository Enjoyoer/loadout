import json
import os
import re
import shlex
import shutil
import signal
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
# A start time in the fixed format task-state.mjs records, which no live process has.
OLD_START = "1970-01-01T00:00:00.0000000Z" if sys.platform == "win32" else "Thu Jan 1 00:00:00 1970"
# The code route as recorded before OPC 7.30: Opus xhigh at pace step 0, a level today's class table no longer selects.
PRE_730_CODE_ROUTE = {
    "role": "worker", "source": "task-default", "kind": "code", "model": "fleet/claude-opus-5-5", "effort": "xhigh",
    "fastMode": False, "reason": "code default xhigh, no adjustment, no quota reading supplied",
    "pace": {"pool": "claude", "step": 0, "weekly": None, "stale": "no quota reading supplied", "gapPct": None,
             "fiveHourUsedPct": None, "resetSoon": None, "accounts": None, "staleAccounts": None, "ageSeconds": None},
}


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
        lookup = f"import {{ processStartTime }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())}; console.log(processStartTime({os.getpid()}));"
        if sys.platform != 'win32':
            # The lookup runs ps under LC_ALL=C and TZ=UTC whatever the caller's locale and zone: a fake ps records both.
            fake = Path(self.task).parent / 'fake-bin'
            fake.mkdir()
            seen = fake / 'seen'
            (fake / 'ps').write_text(f'#!/bin/sh\nprintf "%s|%s|%s" "$LC_ALL" "$TZ" "$*" > {shlex.quote(str(seen))}\n'
                                     'echo "Thu Jan  1 00:00:00 1970"\n')
            (fake / 'ps').chmod(0o755)
            env = {**os.environ, 'PATH': f'{fake}{os.pathsep}{os.environ.get("PATH", "")}', 'LC_ALL': 'de_DE.UTF-8', 'TZ': 'Asia/Tokyo'}
            looked = run('node', '--input-type=module', '-e', lookup, env=env)
            self.assertEqual(looked.stdout.strip(), 'Thu Jan 1 00:00:00 1970', looked.stderr)
            self.assertEqual(seen.read_text(), f'C|UTC|-p {os.getpid()} -o lstart=')
        real = run('node', '--input-type=module', '-e', lookup)
        token = real.stdout.strip()
        if sys.platform == 'win32':
            # The UTC round-trip form, matching the creation time Windows reports for this process.
            import ctypes
            from ctypes import wintypes
            from datetime import datetime, timedelta, timezone
            self.assertRegex(token, r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$', real.stderr)
            kernel32 = ctypes.WinDLL('kernel32')
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
            times = [wintypes.FILETIME() for _ in range(4)]
            self.assertTrue(kernel32.GetProcessTimes(kernel32.GetCurrentProcess(), *map(ctypes.byref, times)))
            ticks = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
            created = datetime(1601, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=ticks // 10)
            recorded = datetime.strptime(token[:26], '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc)
            self.assertLess(abs((recorded - created).total_seconds()), 1)
        else:
            self.assertRegex(token, r'^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$', real.stderr)
        # The exact token is this process; one second off is another process with the same pid.
        second = re.search(r'\d\d:\d\d:(\d\d)', token)
        value = int(second.group(1))
        off = token[:second.start(1)] + f'{value + 1 if value < 59 else value - 1:02d}' + token[second.end(1):]
        recover = f"import {{ recoverTests }} from {json.dumps((SCRIPTS / 'delivery.mjs').as_uri())}; console.log(JSON.stringify(recoverTests({json.dumps(self.task)})));"
        for start, expected in ((token, None), (off, ('interrupted', 'cleanup incomplete: PID reused'))):
            with self.subTest(start=start):
                task = json.loads(Path(self.task).read_text())
                task['tests'] = {'status': 'running', 'pid': os.getpid(), 'pid_start': start, 'started_at': '2020-01-01T00:00:00.000Z',
                                 'child_pid': os.getpid(), 'child_start': start}
                Path(self.task).write_text(json.dumps(task))
                done = run('node', '--input-type=module', '-e', recover)
                self.assertEqual(done.returncode, 0, done.stderr)
                tests = json.loads(done.stdout)
                self.assertEqual(tests and (tests['reason'], tests['cleanup']), expected)

    @unittest.skipIf(sys.platform == 'win32', 'POSIX process groups only')
    def test_recovery_kills_test_grandchild_group(self):
        def terminated(pid):
            # Each member sleeps 120 s, so only the recovery signal can end it within this bounded wait.
            for _ in range(60):
                state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
                if not state.stdout.strip() or state.stdout.lstrip().startswith('Z'):
                    return True
                time.sleep(.05)
            return False

        sleeper = '[' + repr(sys.executable) + ',"-c","import time; time.sleep(120)"]'
        pidfile, orphanfile = Path(self.task).parent / 'grandchild.pid', Path(self.task).parent / 'orphan.pid'
        command = ('import subprocess,time; p=subprocess.Popen(' + sleeper + '); open(' + repr(str(pidfile)) +
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
            self.assertEqual((json.loads(done.stdout)['reason'], json.loads(done.stdout)['cleanup']),
                             ('interrupted', 'group signalled'), done.stderr)
            self.assertTrue(terminated(grandchild), 'grandchild still running after recovery')

            # A leader that exited and was reaped leaves no process with its pid, but its group id cannot be reused while
            # a member lives, so recovery still signals the group.
            leader = subprocess.Popen([sys.executable, '-c', 'import subprocess; p=subprocess.Popen(' + sleeper + '); open(' +
                                       repr(str(orphanfile)) + ',"w").write(str(p.pid))'], start_new_session=True)
            leader.wait(timeout=10)
            orphan = int(orphanfile.read_text())
            self.assertEqual(os.getpgid(orphan), leader.pid)
            dead = subprocess.Popen([sys.executable, '-c', ''])
            dead.wait()
            task = json.loads(Path(self.task).read_text())
            task['tests'] = {'status': 'running', 'pid': dead.pid, 'child_pid': leader.pid, 'child_start': OLD_START}
            Path(self.task).write_text(json.dumps(task))
            done = run('node', str(SCRIPTS / 'delivery.mjs'), 'reconcile', self.task)
            self.assertEqual((json.loads(done.stdout)['reason'], json.loads(done.stdout)['cleanup']),
                             ('interrupted', 'group signalled'), done.stderr)
            self.assertTrue(terminated(orphan), 'orphaned group member still running after recovery')
        finally:
            if runner.poll() is None:
                runner.kill()
            for path in (pidfile, orphanfile):
                if path.exists():
                    try:
                        os.kill(int(path.read_text()), 9)
                    except ProcessLookupError:
                        pass

    @unittest.skipIf(sys.platform == 'win32', 'POSIX signals only')
    def test_signal_cancellation_kills_a_test_command_that_ignores_it(self):
        ready = Path(self.task).parent / 'ready'
        command = ('import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.signal(signal.SIGINT, signal.SIG_IGN); '
                   'open(' + repr(str(ready)) + ',"w").close(); time.sleep(120)')
        runner = subprocess.Popen(['node', '--input-type=module', '-e', f"""
            import {{ runTests }} from {json.dumps((SCRIPTS / 'delivery.mjs').as_uri())};
            const argv = {json.dumps([sys.executable, '-c', command])};
            console.log(JSON.stringify(await runTests({json.dumps(self.task)}, {{ argv, graceMs: 300 }})));
        """], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child = None
        try:
            for _ in range(200):
                child = (json.loads(Path(self.task).read_text())['tests'] or {}).get('child_pid')
                if ready.exists() and child:
                    break
                time.sleep(.05)
            self.assertTrue(ready.exists() and child)
            runner.send_signal(signal.SIGTERM)
            out, err = runner.communicate(timeout=20)
            tests = json.loads(out.strip().splitlines()[-1])
            self.assertEqual((tests['status'], tests['reason'], tests['signal'], tests['cleanup']),
                             ('blocked', 'interrupted', 'SIGTERM', 'group signalled'), err)
            self.assertEqual(json.loads(Path(self.task).read_text())['tests']['status'], 'blocked')
        finally:
            if runner.poll() is None:
                runner.kill()
            if child:
                try:
                    os.killpg(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    @unittest.skipIf(sys.platform == 'win32', 'POSIX signals only')
    def test_test_command_still_open_after_the_kill_settles_as_cleanup_incomplete(self):
        ready, output = Path(self.task).parent / 'ready', Path(self.task).parent / 'runner.out'
        command = ('import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                   'open(' + repr(str(ready)) + ',"w").close(); time.sleep(120)')
        # The controller's group kill is swallowed, as for a command that cannot exit (uninterruptible sleep).
        script = f"""
            import {{ runTests }} from {json.dumps((SCRIPTS / 'delivery.mjs').as_uri())};
            const kill = process.kill.bind(process);
            process.kill = (pid, signal) => pid < 0 && signal === 'SIGKILL' ? true : kill(pid, signal);
            const argv = {json.dumps([sys.executable, '-c', command])};
            console.log(JSON.stringify(await runTests({json.dumps(self.task)}, {{ argv, graceMs: 300 }})));
        """
        child = None
        with output.open('w') as out:
            # A file, not a pipe: the command that never exits keeps the runner's output open.
            runner = subprocess.Popen(['node', '--input-type=module', '-e', script], stdout=out, stderr=subprocess.STDOUT)
        try:
            for _ in range(200):
                tests = json.loads(Path(self.task).read_text())['tests'] or {}
                child = tests.get('child_pid')
                if ready.exists() and child:
                    break
                time.sleep(.05)
            self.assertTrue(ready.exists() and child)
            started = time.monotonic()
            runner.send_signal(signal.SIGTERM)
            runner.wait(timeout=20)
            self.assertLess(time.monotonic() - started, 10)
            settled = json.loads(output.read_text().strip().splitlines()[-1])
            self.assertEqual((settled['status'], settled['reason'], settled['cleanup'], settled['child_pid'], settled['child_start']),
                             ('blocked', 'interrupted', 'cleanup incomplete: did not exit', child, tests['child_start']))
            self.assertEqual(json.loads(Path(self.task).read_text())['tests'], settled)
        finally:
            if runner.poll() is None:
                runner.kill()
            if child:
                try:
                    os.killpg(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_crashed_lock_blocks_both_writers_and_unlock_needs_its_holder_gone(self):
        dead = subprocess.Popen([sys.executable, "-c", ""])
        dead.wait()
        lock, task = Path(self.task + ".lock"), Path(self.task)
        crashed, before = f"{dead.pid}\n{OLD_START}\ncrashed-writer", task.read_bytes()
        lock.write_text(crashed)
        update = f"""
            import {{ updateTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            try {{ updateTask({json.dumps(self.task)}, task => {{ task.status = 'cancelled'; }}); console.log('updated'); }}
            catch (error) {{ console.log(error.message); }}
        """
        # Nothing reclaims a lock implicitly: both writers wait out the crashed writer's lock and fail naming its holder.
        writers = [subprocess.Popen(["node", "--input-type=module", "-e", update], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True) for _ in range(2)]
        for writer in writers:
            out, err = writer.communicate(timeout=60)
            self.assertIn(f"task lock busy: held by pid {dead.pid} started {OLD_START} (gone)", out, err)
            self.assertIn(f"unlock {self.task}", out)
        self.assertEqual((lock.read_text(), task.read_bytes()), (crashed, before))
        unlock = ("node", str(SCRIPTS / "task-state.mjs"), "unlock", self.task)
        removed = run(*unlock)
        self.assertEqual((removed.returncode, removed.stdout.strip()),
                         (0, f"task lock removed: held by pid {dead.pid} started {OLD_START} (gone)"), removed.stderr)
        self.assertFalse(lock.exists())
        # A running holder, identified by its exact start time, is refused and keeps its lock.
        lookup = f"import {{ processStartTime }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())}; console.log(processStartTime({os.getpid()}));"
        live = f"{os.getpid()}\n{run('node', '--input-type=module', '-e', lookup).stdout.strip()}\nlive-writer"
        lock.write_text(live)
        kept = run(*unlock)
        self.assertEqual(kept.returncode, 1)
        self.assertIn(f"task lock kept: held by pid {os.getpid()}", kept.stderr)
        self.assertIn("(running)", kept.stderr)
        self.assertEqual((lock.read_text(), task.read_bytes()), (live, before))

    def test_unlock_refuses_an_unknown_holder_and_removes_a_reused_pid(self):
        lock = Path(self.task + ".lock")
        unlock = (shutil.which("node"), str(SCRIPTS / "task-state.mjs"), "unlock", self.task)
        # An empty PATH hides ps (powershell.exe on Windows), so a live holder's start time cannot be read.
        empty = Path(self.task).parent / "empty-path"
        empty.mkdir()
        for content, path, code, text in ((f"{os.getpid()}\n{OLD_START}", str(empty), 1, "(unknown)"),
                                          ("", os.environ.get("PATH", ""), 1, "(no recorded pid)"),
                                          (f"{os.getpid()}\n{OLD_START}", os.environ.get("PATH", ""), 0, "(reused)")):
            with self.subTest(text=text):
                lock.write_text(content)
                done = run(*unlock, env={**os.environ, "PATH": path})
                self.assertEqual(done.returncode, code, done.stderr)
                self.assertIn(text, done.stdout + done.stderr)
                self.assertEqual(lock.exists(), code != 0)

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

    def write_routes(self, task, routes):
        """Write `routes` ({lane: route}) as the task's recorded lanes directly, as an old or tampered record would be."""
        record = json.loads(Path(task).read_text())
        record["routes"] = {lane: {"route": route, "reason": route.get("reason", "owner-named, never adjusted"),
                                   "recorded_at": "2026-10-01T00:00:00.000Z"} for lane, route in routes.items()}
        Path(task).write_text(json.dumps(record))

    def ui_task(self):
        root = Path(self.task).parent.parent
        (root / "run-ui").mkdir()
        done = run("node", "--input-type=module", "-e", f"""
            import {{ createTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            console.log(createTask({{ workingDirectory: {json.dumps(str(self.repo))}, runDirectory: {json.dumps(str(root / 'run-ui'))},
              owner: 'test', ui: true }}).taskPath);
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def launch(self, task, lane, route, catalog, source=None, record_lane=None, task_class=None, task_id=None, provider=None,
               extra="{}"):
        """Build the Worker request and brief for `lane` of `task`, bound to that task record, lane, and `task_class`, from
        `route`: a JS expression that may use `recorded`, the routes readTask returns for `source` (default `task`). The
        request uses the record's id unless `task_id` is given, an explicit `provider` when given, and no catalog when
        `catalog` is None; `extra`, a JS object expression that may use `models`, adds or overrides request builder
        arguments. With record_lane, also try recording `route` there for `task_class`. Returns each result or its
        error."""
        done = run("node", "--input-type=module", "-e", f"""
            import {{ buildDelegatedBrief }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ buildManagedWorkerRequest }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ recordWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            const path = {json.dumps(task)}, lane = {json.dumps(lane)}, recordLane = {json.dumps(record_lane)};
            const taskClass = {json.dumps(task_class)}, models = {json.dumps(catalog)} ?? undefined;
            const task = readTask(path), recorded = readTask({json.dumps(source or task)}).routes;
            const route = {route};
            const attempt = make => {{ try {{ return make(); }} catch (error) {{ return {{ error: error.message }}; }} }};
            console.log(JSON.stringify({{
              request: attempt(() => buildManagedWorkerRequest({{ taskId: {json.dumps(task_id)} ?? task.id, lane, title: 'Worker',
                initialPrompt: 'Repair the lane', route, task, taskClass, provider: {json.dumps(provider)} ?? undefined,
                workspace: {{ workspaceId: 'wks-example', cwd: '/tmp/example-worktree' }},
                capabilities: {{ enabled: true, status: 'available', modes: [], models }}, ...({extra}) }}).request),
              brief: attempt(() => buildDelegatedBrief({{ role: 'worker', route, reason: 'route reason', brief: 'Repair the lane',
                task, lane, taskClass }})),
              record: recordLane && attempt(() => recordWorkerRoute(path, {{ lane: recordLane, route, reason: 'route reason', taskClass }})),
            }}));
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_recorded_pre_730_code_route_rebuilds_when_catalog_serves_it(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.write_routes(self.task, {"code-lane": PRE_730_CODE_ROUTE})
        built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code")
        self.assertEqual(built["request"].get("provider"), "pi/fleet/claude-opus-5-5", built["request"])
        self.assertEqual(built["request"]["settings"], {"thinkingOptionId": "xhigh"})
        self.assertIn("model=fleet/claude-opus-5-5; effort=xhigh; Fast=off; route: route reason", built["brief"])

    def test_recorded_route_missing_from_catalog_is_refused(self):
        catalog = [{"id": "fleet/claude-opus-5-6", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "xhigh"}]}]
        self.write_routes(self.task, {"code-lane": PRE_730_CODE_ROUTE})
        built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code")
        self.assertEqual(built["request"], {"error": "recorded code Worker route is no longer served: the Pi catalog has no "
                                                     "fleet/claude-opus-5-5; this lane cannot relaunch on its recorded route, "
                                                     "so resolve a route for a new lane"})

    def test_new_xhigh_code_route_is_allowed(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.write_routes(self.task, {"code-lane": PRE_730_CODE_ROUTE})
        raised = {"role": "worker", "source": "owner-explicit", "model": "fleet/claude-opus-5-5",
                  "effort": "xhigh", "fastMode": False}
        built = self.launch(self.task, "new-lane", json.dumps(raised), catalog, record_lane="new-lane",
                             task_class="code")
        self.assertEqual(built["request"].get("provider"), "pi/fleet/claude-opus-5-5")
        self.assertEqual(built["request"]["settings"], {"thinkingOptionId": "xhigh"})
        self.assertIn("model=fleet/claude-opus-5-5; effort=xhigh; Fast=off; route: route reason", built["brief"])
        self.assertNotIn("error", built["record"])

    def test_tampered_recorded_gpt_code_route_is_refused(self):
        catalog = [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "medium"}, {"id": "xhigh"}]}
                   for model, label in (("claude-opus-5-5", "Opus"), ("gpt-6.1-sol", "Sol"))]
        tampered = {**PRE_730_CODE_ROUTE, "model": "fleet/gpt-6.1-sol", "effort": "medium"}
        self.write_routes(self.task, {"code-lane": tampered})
        built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, record_lane="gpt-lane",
                             task_class="code")
        for step in ("request", "brief"):
            self.assertEqual(built[step].get("error"), "recorded code Worker route cannot rebuild: fleet/gpt-6.1-sol is a GPT "
                                                       "or web model and the code class runs Opus", step)
        self.assertIn("recorded owner or task-default route required for worker", built["record"].get("error", ""))

    def test_recorded_opus_code_route_below_current_minimum_is_refused(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "low"}, {"id": "medium"}, {"id": "xhigh"}]}]
        self.write_routes(self.task, {"code-lane": {**PRE_730_CODE_ROUTE, "effort": "low"}})
        built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, record_lane="low-lane",
                             task_class="code")
        for step in ("request", "brief"):
            self.assertEqual(built[step].get("error"), "recorded code Worker route cannot rebuild: effort low is below the code "
                                                       "minimum medium", step)
        self.assertIn("recorded owner or task-default route required for worker", built["record"].get("error", ""))

    def test_route_from_non_ui_task_cannot_launch_ui_task_lane(self):
        root = Path(self.task).parent.parent
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        catalog.append({"id": "fleet/claude-fable-5-1", "label": "Fable", "thinkingOptions": [{"id": "high"}]})
        (root / "catalog.json").write_text(json.dumps(catalog))
        ui = self.ui_task()
        for task, kind, lane in ((self.task, "code", "code-lane"), (ui, "ui", "ui-lane")):
            recorded = run("node", str(SCRIPTS / "route.mjs"), "--class", kind, "--catalog", str(root / "catalog.json"),
                           "--pq-file", str(root / "no-pq.json"), "--task", task, "--lane", lane)
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
        own = self.launch(ui, "ui-lane", "recorded['ui-lane'].route", catalog)
        self.assertEqual(own["request"].get("settings"), {"thinkingOptionId": "high"}, own["request"])
        replay = self.launch(ui, "ui-lane", "recorded['code-lane'].route", catalog, source=self.task, record_lane="ui-lane")
        for step in ("request", "brief"):
            self.assertEqual(replay[step].get("error"), "UI task: a ui-design lane launches only Fable high, Fast off (owner rule); "
                                                        "the build goes to a code task", step)
        self.assertEqual(replay["record"].get("error"), "UI task: a ui-design lane records only Fable high, Fast off (owner rule); "
                                                        "the build goes to a code task")

    def test_recorded_ui_route_not_fable_high_fast_off_is_refused(self):
        catalog = [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "high"}, {"id": "xhigh"}]}
                   for model, label in (("claude-opus-5-5", "Opus"), ("claude-fable-5-1", "Fable"))]
        ui = self.ui_task()
        for route in ({"role": "worker", "source": "owner-explicit", "model": "fleet/claude-opus-5-5", "effort": "high", "fastMode": False},
                      {"role": "worker", "source": "owner-explicit", "model": "fleet/claude-fable-5-1", "effort": "high", "fastMode": True}):
            with self.subTest(route=route):
                recorded = self.launch(ui, "ui-lane", json.dumps(route), catalog, record_lane="ui-lane")
                self.assertEqual(recorded["record"].get("error"), "UI task: a ui-design lane records only Fable high, Fast off "
                                                                  "(owner rule); the build goes to a code task")
                self.write_routes(ui, {"ui-lane": route})
                built = self.launch(ui, "ui-lane", "recorded['ui-lane'].route", catalog)
                for step in ("request", "brief"):
                    self.assertEqual(built[step].get("error"), "UI task: a ui-design lane launches only Fable high, Fast off "
                                                               "(owner rule); the build goes to a code task", step)

    def test_tampered_recorded_owner_explicit_gpt_code_route_is_refused(self):
        catalog = [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "medium"}, {"id": "xhigh"}]}
                   for model, label in (("claude-opus-5-5", "Opus"), ("gpt-6.1-sol", "Sol"))]
        tampered = {"role": "worker", "source": "owner-explicit", "model": "fleet/gpt-6.1-sol", "effort": "medium", "fastMode": False}
        self.write_routes(self.task, {"code-lane": tampered})
        built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, record_lane="gpt-lane",
                            task_class="code")
        for step in ("request", "brief"):
            self.assertEqual(built[step].get("error"), "recorded code Worker route cannot rebuild: fleet/gpt-6.1-sol is a GPT "
                                                       "or web model and the code class runs Opus", step)
        self.assertEqual(built["record"].get("error"), "code lane refuses this Worker route: fleet/gpt-6.1-sol is a GPT or web "
                                                       "model and the code class runs Opus")

    def record_code_lane(self, catalog):
        root = Path(self.task).parent.parent
        (root / "catalog.json").write_text(json.dumps(catalog))
        recorded = run("node", str(SCRIPTS / "route.mjs"), "--class", "code", "--catalog", str(root / "catalog.json"),
                       "--pq-file", str(root / "no-pq.json"), "--task", self.task, "--lane", "code-lane")
        self.assertEqual(recorded.returncode, 0, recorded.stderr)

    def test_mismatched_task_id_and_task_record_is_refused(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.record_code_lane(catalog)
        built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code",
                            task_id="task-0001-example")
        self.assertEqual(built["request"], {"error": "Worker task id must be the bound task record id"})

    def test_different_route_for_recorded_lane_is_refused(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.record_code_lane(catalog)
        other = {"role": "worker", "source": "owner-explicit", "model": "fleet/claude-opus-5-5", "effort": "xhigh", "fastMode": False}
        built = self.launch(self.task, "code-lane", json.dumps(other), catalog, record_lane="code-lane", task_class="code")
        for step in ("request", "brief", "record"):
            self.assertEqual(built[step].get("error"), "lane code-lane already has a recorded route; repairs and resumes reuse it", step)

    def test_non_fable_claude_ui_route_is_refused_without_catalog(self):
        ui = self.ui_task()
        sonnet = {"role": "worker", "source": "owner-explicit", "model": "fleet/claude-sonnet-5-5", "effort": "xhigh", "fastMode": False}
        fresh = self.launch(ui, "ui-lane", json.dumps(sonnet), None, record_lane="ui-lane")
        self.assertEqual(fresh["record"].get("error"), "UI task: a ui-design lane records only Fable high, Fast off (owner rule); "
                                                       "the build goes to a code task")
        self.write_routes(ui, {"ui-lane": sonnet})
        rebuilt = self.launch(ui, "ui-lane", "recorded['ui-lane'].route", None)
        for built in (fresh, rebuilt):
            for step in ("request", "brief"):
                self.assertEqual(built[step].get("error"), "UI task: a ui-design lane launches only Fable high, Fast off "
                                                           "(owner rule); the build goes to a code task", step)

    def test_tampered_code_route_with_gpt_provider_is_refused_by_request(self):
        catalog = [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "medium"}, {"id": "xhigh"}]}
                   for model, label in (("claude-opus-5-5", "Opus"), ("gpt-6.1-sol", "Sol"))]
        self.write_routes(self.task, {"code-lane": {**PRE_730_CODE_ROUTE, "model": "fleet/gpt-6.1-sol", "effort": "medium"}})
        tampered = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code",
                               provider="pi/fleet/gpt-6.1-sol")
        self.assertEqual(tampered["request"].get("error"), "recorded code Worker route cannot rebuild: fleet/gpt-6.1-sol is a "
                                                           "GPT or web model and the code class runs Opus")
        # A valid recorded Opus lane cannot be steered to the GPT provider either; its own mapped provider still launches.
        self.write_routes(self.task, {"code-lane": PRE_730_CODE_ROUTE})
        steered = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code",
                              provider="pi/fleet/gpt-6.1-sol")
        self.assertEqual(steered["request"].get("error"), "explicit provider pi/fleet/gpt-6.1-sol is not what this lane's "
                                                          "validated route maps to (pi/fleet/claude-opus-5-5)")
        own = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code",
                          provider="pi/fleet/claude-opus-5-5")
        self.assertEqual((own["request"].get("provider"), own["request"].get("settings")),
                         ("pi/fleet/claude-opus-5-5", {"thinkingOptionId": "xhigh"}), own["request"])

    def test_fixed_role_selector_cannot_build_a_worker_for_a_bound_lane(self):
        catalog = [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "low"}, {"id": "medium"}, {"id": "xhigh"}]}
                   for model, label in (("claude-opus-5-5", "Opus"), ("gpt-6.1-sol", "Sol"))]
        self.record_code_lane(catalog)
        native = "{ enabled: true, status: 'available', modes: [{ id: 'full-access', isUnattended: true }], models }"
        # A scout role with a GPT provider at low thinking skipped the code lane's route and class checks; with a native
        # provider it also skipped the owner authorization a native Worker needs.
        for provider, extra in (("pi/fleet/gpt-6.1-sol", "{ role: 'scout', agentSettings: { thinkingOptionId: 'low' } }"),
                                ("codex/gpt-6.1-sol", f"{{ role: 'scout', agentSettings: {{ thinkingOptionId: 'low' }}, capabilities: {native} }}")):
            with self.subTest(provider=provider):
                built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code",
                                    provider=provider, extra=extra)
                self.assertEqual(built["request"], {"error": "buildManagedWorkerRequest builds only Workers (role worker), not scout"})

    def test_caller_labels_cannot_turn_fast_on_for_a_fast_off_route(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.record_code_lane(catalog)
        for key, value in (("opc.service-tier", "fast"), ("opc.fast-requested", "true")):
            with self.subTest(label=key):
                built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code",
                                    extra=f"{{ workerLabels: {{ {json.dumps(key)}: {json.dumps(value)} }} }}")
                self.assertEqual(built["request"], {"error": f"Worker labels cannot set {key}; the Worker's validated route decides it"})
        described = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, task_class="code",
                                extra="{ workerLabels: { 'opc.run': 'run-1' } }")
        self.assertEqual(described["request"]["labels"].get("opc.run"), "run-1", described["request"])
        self.assertNotIn("opc.service-tier", described["request"]["labels"])

    def test_bound_lane_launches_an_authorized_native_claude_worker(self):
        opus = {"role": "worker", "source": "owner-explicit", "model": "claude-opus-5-5[1m]", "effort": "xhigh", "fastMode": False}
        native = ("{ nativeAuthorization: 'owner-explicit', capabilities: { enabled: true, status: 'available', "
                  "modes: [{ id: 'bypassPermissions', isUnattended: true }], models }%s }")
        claude = [{"id": "claude-opus-5-5[1m]", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        for provider, surface in (("claude/claude-opus-5-5[1m]", ""), (None, ", surface: 'claude'")):
            with self.subTest(provider=provider):
                built = self.launch(self.task, "claude-lane", json.dumps(opus), claude, task_class="code", provider=provider,
                                    extra=native % surface)
                self.assertEqual((built["request"].get("provider"), built["request"].get("settings")),
                                 ("claude/claude-opus-5-5[1m]", {"thinkingOptionId": "xhigh", "modeId": "bypassPermissions"}),
                                 built["request"])
        # With no native surface named, a Claude route Pi does not serve is refused rather than rebuilt as a Codex request.
        unserved = self.launch(self.task, "claude-lane", json.dumps(opus), CATALOG, task_class="code", extra=native % "")
        self.assertEqual(unserved["request"], {"error": "claude-opus-5-5[1m] is a Claude model and never runs as a native Codex "
                                                        "Worker; an authorized native Claude Code Worker takes the claude surface"})

    def test_followup_payload_follows_the_advertised_send_schema(self):
        # send_agent_prompt input schemas as Paseo advertises them to an agent caller (descriptions dropped).
        common = {"agentId": {"type": "string"}, "prompt": {"type": "string"}, "sessionMode": {"type": "string"},
                  "notifyOnFinish": {"default": True, "type": "boolean"}}
        schemas = {
            "0.11.1": {"type": "object", "properties": {**common, "background": {"default": True, "type": "boolean"}},
                       "required": ["agentId", "prompt"]},
            "0.13.0": {"type": "object", "properties": {**common, "activeTurnBehavior": {"type": "string",
                       "enum": ["interrupt", "steer", "defer"]}, "serverId": {"type": "string", "minLength": 1}},
                       "required": ["agentId", "prompt"]},
        }
        missing_notify = {"properties": {k: v for k, v in common.items() if k != "notifyOnFinish"}}
        extra_required = {**schemas["0.13.0"], "required": ["agentId", "prompt", "serverId"]}
        sent = {
            "queued": {"content": [], "structuredContent": {"success": True, "deliveryStatus": "queued",
                                                           "messageId": "msg-1", "status": "idle"}},
            "sent": {"success": True, "status": "running", "lastMessage": None, "permission": None},
            "refused": {"content": [{"type": "text", "text": "Agent missing not found"}], "isError": True},
            "failed": {"structuredContent": {"success": False, "status": "error"}},
            "unknown": {"structuredContent": {"success": True, "deliveryStatus": "dispatched", "status": "idle"}},
        }
        done = run("node", "--input-type=module", "-e", f"""
            import {{ buildManagedWorkerFollowupRequest as build, validateManagedWorkerFollowup as validate }}
              from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            const attempt = make => {{ try {{ return make(); }} catch (error) {{ return {{ error: error.message }}; }} }};
            const schemas = {json.dumps(schemas)}, sent = {json.dumps(sent)};
            const base = {{ agentId: 'worker-1', prompt: 'Repair the lane' }};
            const built = Object.fromEntries(Object.entries(schemas).map(([v, inputSchema]) => [v, build({{ ...base, inputSchema }})]));
            console.log(JSON.stringify({{ built,
              fireAndForget: build({{ ...base, inputSchema: schemas['0.13.0'], fireAndForget: true,
                fireAndForgetAuthorization: 'owner-explicit' }}),
              noSchema: attempt(() => build(base)),
              missingNotify: attempt(() => build({{ ...base, inputSchema: {json.dumps(missing_notify)} }})),
              extraRequired: attempt(() => build({{ ...base, inputSchema: {json.dumps(extra_required)} }})),
              results: Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, attempt(() => validate(built['0.13.0'], v))])),
            }}));
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        out = json.loads(done.stdout)
        self.assertEqual(out["built"]["0.11.1"], {**out["built"]["0.13.0"], "background": True})
        self.assertEqual(out["built"]["0.13.0"], {"agentId": "worker-1", "prompt": "Repair the lane", "notifyOnFinish": True})
        for version, schema in schemas.items():
            self.assertLessEqual(set(out["built"][version]), set(schema["properties"]), version)
        self.assertIs(out["fireAndForget"]["notifyOnFinish"], False)
        self.assertEqual(out["noSchema"], {"error": "advertised send_agent_prompt inputSchema required: its tools/list inputSchema, or {properties} keyed by the argument names its declaration lists"})
        self.assertEqual(out["missingNotify"], {"error": "send_agent_prompt advertises no notifyOnFinish; a notified follow-up cannot be sent"})
        self.assertEqual(out["extraRequired"], {"error": "send_agent_prompt requires unsupported argument(s): serverId"})
        results = out["results"]
        self.assertEqual(results["queued"], {"agentId": "worker-1", "delivery": "queued", "messageId": "msg-1", "notifyOnFinish": True})
        self.assertEqual(results["sent"], {"agentId": "worker-1", "delivery": "sent", "messageId": None, "notifyOnFinish": True})
        self.assertEqual(results["refused"], {"error": "Paseo send_agent_prompt refused the follow-up"})
        self.assertEqual(results["failed"], {"error": "Paseo send_agent_prompt did not accept the follow-up"})
        self.assertEqual(results["unknown"], {"error": "Paseo send_agent_prompt returned unknown deliveryStatus dispatched"})

    def test_task_default_code_route_with_non_opus_claude_model_is_refused_without_catalog(self):
        sonnet = {**PRE_730_CODE_ROUTE, "model": "fleet/claude-sonnet-5-5", "effort": "medium"}
        fresh = self.launch(self.task, "sonnet-lane", json.dumps(sonnet), None, record_lane="sonnet-lane", task_class="code")
        for step in ("record", "brief"):
            self.assertEqual(fresh[step].get("error"), "code lane refuses this Worker route: fleet/claude-sonnet-5-5 does not "
                                                       "name the code class's Opus model", step)
        self.write_routes(self.task, {"code-lane": sonnet})
        rebuilt = self.launch(self.task, "code-lane", "recorded['code-lane'].route", None, task_class="code")
        self.assertEqual(rebuilt["brief"].get("error"), "recorded code Worker route cannot rebuild: fleet/claude-sonnet-5-5 "
                                                        "does not name the code class's Opus model")

    def test_route_cli_with_different_class_for_recorded_lane_exits_non_zero(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.record_code_lane(catalog)
        root = Path(self.task).parent.parent
        route = ("node", str(SCRIPTS / "route.mjs"), "--catalog", str(root / "catalog.json"), "--pq-file", str(root / "no-pq.json"),
                 "--task", self.task, "--lane", "code-lane")
        stored = json.loads(Path(self.task).read_text())["routes"]["code-lane"]["route"]
        other = run(*route, "--class", "research")
        self.assertNotEqual(other.returncode, 0, other.stdout)
        self.assertIn("lane code-lane already has a recorded route that --class would not select", other.stderr)
        for flags in ((), ("--class", "code")):
            resumed = run(*route, *flags)
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertEqual(json.loads(resumed.stdout)["route"], stored)

    def test_changes_request_from_another_reviewer_blocks_recorded_approval(self):
        # Reviewer alice's approval is recorded and stays her newest review; bob then requests changes on the same head.
        runs = Path(self.task).parent.parent / "review-run"
        runs.mkdir()
        created = run("node", "--input-type=module", "-e", f"""
            import {{ createTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            console.log(createTask({{ workingDirectory: {json.dumps(str(self.repo))}, runDirectory: {json.dumps(str(runs))}, owner: 'test',
              baseRef: 'main', delivery: 'pr', browserReview: true }}).taskPath);
        """)
        self.assertEqual(created.returncode, 0, created.stderr)
        task_path = created.stdout.strip()
        tested = run("node", str(SCRIPTS / "delivery.mjs"), "test", task_path, sys.executable, "-c", "")
        self.assertEqual(tested.returncode, 0, tested.stderr)
        head = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
        task = json.loads(Path(task_path).read_text())
        task["reviewer"] = {"rounds": [{
            "id": "00000000-0000-4000-8000-000000000001", "pr": 7, "head": head, "role": "reviewer", "catalog_label": "Web Pro",
            "catalog_model_id": "gpt-pro", "provider": "codex/gpt-pro", "status": "approved", "agent_id": "agent-review",
            "review_id": 1, "reviewer_login": "alice", "review_url": "https://github.com/example/app/pull/7#pullrequestreview-1"}]}
        Path(task_path).write_text(json.dumps(task))
        done = run("node", "--input-type=module", "-e", f"""
            import {{ verifyDelivery }} from {json.dumps((SCRIPTS / 'delivery.mjs').as_uri())};
            const head = {json.dumps(head)}, side = {{ sha: head, ref: 'main', repo: {{ full_name: 'example/app' }} }};
            const pr = {{ number: 7, head: side, base: side, user: {{ login: 'author' }}, state: 'open', merged: false, draft: false,
              html_url: 'https://github.com/example/app/pull/7', merge_commit_sha: null }};
            const approval = {{ id: 1, state: 'APPROVED', commit_id: head, user: {{ login: 'alice' }} }};
            const changes = {{ id: 2, state: 'CHANGES_REQUESTED', commit_id: head, user: {{ login: 'bob' }} }};
            const verify = reviews => verifyDelivery({json.dumps(task_path)}, {{ pr: 7, query: args => args[1].endsWith('/reviews?per_page=100') ? reviews : pr }});
            console.log(JSON.stringify([verify([approval]), verify([approval, changes])].map(({{ status, blockers }}) => [status, blockers])));
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        approved, requested = json.loads(done.stdout)
        self.assertEqual(approved, ["verified", []])
        self.assertEqual(requested[0], "blocked")
        self.assertIn("current exact-head non-author CHANGES_REQUESTED review blocks delivery", requested[1])

    def test_lock_of_writer_paused_in_acquisition_is_not_reclaimed(self):
        # Writer A pauses for over ten seconds at the first moment its lock exists, between an exclusive create and the
        # holder bytes where the lock is still written that way; writer B then tries its own task update.
        state = json.dumps((SCRIPTS / 'task-state.mjs').as_uri())
        task = json.dumps(self.task)
        other = (f"import {{ updateTask }} from {state};"
                 f"try {{ updateTask({task}, () => {{}}); console.log('updated'); }} catch (error) {{ console.log(error.message); }}")
        done = run("node", "--input-type=module", "-e", f"""
            import fs from 'node:fs';
            import {{ spawnSync }} from 'node:child_process';
            import {{ syncBuiltinESMExports }} from 'node:module';
            const lock = {task} + '.lock';
            let other = null;
            const pause = () => {{
              if (other !== null || !fs.existsSync(lock)) return;
              const old = new Date(Date.now() - 11000);
              fs.utimesSync(lock, old, old);
              other = spawnSync(process.execPath, ['--input-type=module', '-e', {json.dumps(other)}], {{ encoding: 'utf8' }}).stdout.trim();
            }};
            const {{ writeFileSync, linkSync }} = fs;
            fs.writeFileSync = (path, data, options) => {{
              if (options?.flag !== 'wx') return writeFileSync(path, data, options);
              const fd = fs.openSync(path, 'wx', options.mode);
              try {{ pause(); fs.writeSync(fd, data); }} finally {{ fs.closeSync(fd); }}
            }};
            fs.linkSync = (from, to) => {{ linkSync(from, to); pause(); }};
            syncBuiltinESMExports();
            const {{ updateTask }} = await import({state});
            let mine;
            try {{ mine = updateTask({task}, () => {{}}).status; }} catch (error) {{ mine = error.message; }}
            console.log(JSON.stringify({{ other, mine }}));
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertIn("task lock busy", result["other"])
        self.assertEqual(result["mine"], "ready")
        self.assertEqual(sorted(p.name for p in Path(self.task).parent.iterdir()), ["task.json"])

    def test_source_fingerprint_covers_submodule_working_tree_bytes(self):
        # The superproject sees a dirty submodule as one gitlink and one "-dirty" diff line, whatever its dirty bytes.
        def git(cwd, *args):
            subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                           check=True, capture_output=True)
        sub = self.repo / "sub"
        sub.mkdir()
        git(sub, "init", "-q")
        (sub / "file.txt").write_text("committed\n")
        git(sub, "add", "file.txt")
        git(sub, "commit", "-q", "-m", "sub")
        git(self.repo, "add", "sub")
        git(self.repo, "commit", "-q", "-m", "gitlink")
        fingerprint = f"""
            import {{ sourceIdentity }} from {json.dumps((SCRIPTS / 'delivery.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            console.log(sourceIdentity(readTask({json.dumps(self.task)})).fingerprint);
        """
        prints = []
        for content in ("dirty A\n", "dirty B\n"):
            (sub / "file.txt").write_text(content)
            done = run("node", "--input-type=module", "-e", fingerprint)
            self.assertEqual(done.returncode, 0, done.stderr)
            prints.append(done.stdout.strip())
        self.assertNotEqual(prints[0], prints[1])


    def test_symlinked_gitlink_fails_the_receipt(self):
        def git(cwd, *args):
            subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                           check=True, capture_output=True)
        sub = self.repo / "sub"
        sub.mkdir()
        git(sub, "init", "-q")
        (sub / "file.txt").write_text("committed\n")
        git(sub, "add", "file.txt")
        git(sub, "commit", "-q", "-m", "sub")
        git(self.repo, "add", "sub")
        git(self.repo, "commit", "-q", "-m", "gitlink")
        # The gitlink's working tree moves outside the repository and a symlink takes its place.
        moved = Path(self.task).parent / "sub-elsewhere"
        sub.rename(moved)
        try:
            sub.symlink_to(moved, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks unavailable")
        done = run("node", str(SCRIPTS / "delivery.mjs"), "test", self.task, sys.executable, "-c", "")
        self.assertNotEqual(done.returncode, 0)
        tests = json.loads(done.stdout.strip().splitlines()[-1])
        self.assertEqual((tests["status"], tests["reason"]),
                         ("failed", "submodule sub is not a checked-out directory with its own .git; its bytes cannot be fingerprinted"))


if __name__ == "__main__":
    unittest.main()

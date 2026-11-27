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
# The code route as recorded before OPC 7.30, with the key OPC 7.66 retired: Opus xhigh, a level today's class table
# no longer selects.
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
                       "--task", self.task, "--lane", "code-lane")
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

    def test_recorded_review_security_xhigh_route_rebuilds(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.write_routes(self.task, {"sec-lane": {**PRE_730_CODE_ROUTE, "kind": "review-security",
                                                   "reason": "review-security default Opus xhigh, Fast off"}})
        built = self.launch(self.task, "sec-lane", "recorded['sec-lane'].route", catalog, task_class="review-security")
        self.assertEqual(built["request"].get("provider"), "pi/fleet/claude-opus-5-5", built["request"])
        self.assertEqual(built["request"]["settings"], {"thinkingOptionId": "xhigh"})
        self.assertIn("model=fleet/claude-opus-5-5; effort=xhigh; Fast=off", built["brief"])

    def security_catalog(self):
        return [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}
                for model, label in (("claude-opus-5-5", "Opus"), ("claude-sonnet-5-5", "Sonnet"), ("claude-fable-5-2", "Fable"),
                                     ("gpt-6.2-sol", "Sol"))]

    def test_review_security_lanes_recorded_before_decision_332_rebuild(self):
        # PM-specified (decision 332 repair): the former Opus high default and owner-named non-GPT high routes rebuild; a
        # Sol default recorded Fast off never existed and is refused; an owner-named Sol Fast off route stays valid.
        owner = {"role": "worker", "source": "owner-explicit", "effort": "high", "fastMode": False}
        lanes = {"opus-default": {**PRE_730_CODE_ROUTE, "kind": "review-security", "effort": "high",
                                  "reason": "review-security default Opus high, Fast off"},
                 "opus-owner": {**owner, "model": "fleet/claude-opus-5-5"},
                 "sonnet-owner": {**owner, "model": "fleet/claude-sonnet-5-5"},
                 "fable-owner": {**owner, "model": "fleet/claude-fable-5-2"},
                 "sol-owner-off": {**owner, "model": "fleet/gpt-6.2-sol", "effort": "xhigh"},
                 "sol-default-off": {"role": "worker", "source": "task-default", "kind": "review-security",
                                     "model": "fleet/gpt-6.2-sol", "effort": "xhigh", "fastMode": False,
                                     "reason": "review-security default Sol xhigh, Fast off"}}
        self.write_routes(self.task, lanes)
        for lane, route in lanes.items():
            built = self.launch(self.task, lane, f"recorded[{json.dumps(lane)}].route", self.security_catalog(),
                                task_class="security")
            if lane == "sol-default-off":
                for step in ("request", "brief"):
                    self.assertEqual(built[step].get("error"), "recorded review-security Worker route cannot rebuild: Fast off "
                                                               "does not match the review-security class", step)
                continue
            self.assertEqual(built["request"].get("provider"), f"pi/{route['model']}", (lane, built))
            self.assertEqual(built["request"]["settings"], {"thinkingOptionId": route["effort"]}, lane)
        # A fresh owner-named route below xhigh is refused when recorded, as when resolved alone.
        fresh = self.launch(self.task, "new-lane", json.dumps({**owner, "model": "fleet/claude-sonnet-5-5"}),
                            self.security_catalog(), record_lane="new-lane", task_class="review-security")
        self.assertIn("effort high is below the review-security minimum xhigh", fresh["record"].get("error", ""))

    def test_route_cli_replays_recorded_review_security_lanes_with_their_exact_flags(self):
        # PM-specified (decision 332 repair): exact original flags, class or alias, replay a recorded lane; mutated flags
        # or another class are refused; a fresh standalone owner-named route below xhigh is refused.
        root = Path(self.task).parent.parent
        (root / "catalog.json").write_text(json.dumps(self.security_catalog()))
        owner = {"role": "worker", "source": "owner-explicit", "model": "fleet/claude-opus-5-5", "effort": "high", "fastMode": False}
        sol = {**owner, "model": "fleet/gpt-6.2-sol", "effort": "xhigh", "fastMode": True}
        self.write_routes(self.task, {"opus-owner": owner, "sol-owner": sol})
        cli = ("node", str(SCRIPTS / "route.mjs"), "--catalog", str(root / "catalog.json"), "--task", self.task)
        original = ("--owner-model", "fleet/claude-opus-5-5", "--owner-effort", "high", "--owner-fast", "off")
        for flags in ((), ("--class", "review-security", *original), ("--class", "security", *original)):
            replayed = run(*cli, "--lane", "opus-owner", *flags)
            self.assertEqual(replayed.returncode, 0, (flags, replayed.stderr))
            self.assertEqual(json.loads(replayed.stdout)["route"], owner)
        sol_flags = ("--owner-model", "fleet/gpt-6.2-sol", "--owner-effort", "xhigh", "--owner-fast", "on")
        replayed = run(*cli, "--lane", "sol-owner", "--class", "security", *sol_flags)
        self.assertEqual(json.loads(replayed.stdout or "{}").get("route"), sol, replayed.stderr)
        for lane, flags, named in (("sol-owner", ("--class", "code", *sol_flags), "class"),
                                   ("opus-owner", ("--class", "ui-design", *original), "class"),
                                   ("opus-owner", ("--class", "review-security", *original[:3], "xhigh", *original[4:]), "owner-effort"),
                                   ("opus-owner", ("--class", "review-security", "--owner-model", "fleet/claude-sonnet-5-5", *original[2:]), "owner-model")):
            mutated = run(*cli, "--lane", lane, *flags)
            self.assertNotEqual(mutated.returncode, 0, (flags, mutated.stdout))
            self.assertIn(f"--{named}", mutated.stderr)
        escalated = run(*cli, "--lane", "security-escalation", "--class", "review-security", *original[:3], "xhigh", *original[4:])
        self.assertEqual(escalated.returncode, 0, escalated.stderr)
        self.assertEqual(json.loads(escalated.stdout)["route"], {**owner, "effort": "xhigh"})
        alone = run("node", str(SCRIPTS / "route.mjs"), "--class", "review-security", *original)
        self.assertNotEqual(alone.returncode, 0, alone.stdout)
        self.assertIn("effort high is below the review-security minimum xhigh", alone.stderr)

    def watcher_catalog(self):
        return [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "low"}, {"id": "high"}, {"id": "xhigh"}]}
                for model, label in (("gpt-6.2-sol", "Sol"), ("gpt-6-luna", "Luna"))]

    def test_recorded_luna_watcher_route_rebuilds(self):
        luna = {"role": "worker", "source": "task-default", "kind": "watcher", "model": "fleet/gpt-6-luna", "effort": "xhigh",
                "fastMode": True, "reason": "watcher default Luna xhigh, Fast on"}
        self.write_routes(self.task, {"watch-lane": luna})
        built = self.launch(self.task, "watch-lane", "recorded['watch-lane'].route", self.watcher_catalog(), task_class="watcher")
        self.assertEqual(built["request"].get("provider"), "pi/fleet/gpt-6-luna", built["request"])
        self.assertEqual(built["request"]["settings"], {"thinkingOptionId": "xhigh"})
        self.assertIn("model=fleet/gpt-6-luna; effort=xhigh; Fast=on", built["brief"])

    def test_fresh_luna_watcher_needs_fast_on(self):
        # An owner-named model always wins (Config ruling): an owner-named Luna watcher runs Fast on, as on main; Fast off is refused.
        luna = {"role": "worker", "source": "owner-explicit", "model": "fleet/gpt-6-luna", "effort": "xhigh", "fastMode": True}
        on = self.launch(self.task, "on-lane", json.dumps(luna), self.watcher_catalog(), record_lane="on-lane", task_class="watcher")
        self.assertEqual(on["request"].get("provider"), "pi/fleet/gpt-6-luna", on["request"])
        self.assertNotIn("error", on["record"])
        off = self.launch(self.task, "off-lane", json.dumps({**luna, "fastMode": False}), self.watcher_catalog(),
                          record_lane="off-lane", task_class="watcher")
        for step in ("request", "brief"):
            self.assertEqual(off[step].get("error"), "watcher lane refuses this Worker route: a watcher route on Luna runs Fast "
                                                     "on (owner 2026-11-17)", step)
        self.assertIn("a watcher route on Luna runs Fast on", off["record"].get("error", ""))

    def test_recorded_sol_fast_on_plan_route_rebuilds(self):
        sol = {"role": "worker", "source": "task-default", "kind": "plan", "model": "fleet/gpt-6.2-sol", "effort": "high",
               "fastMode": True, "reason": "plan default Sol high, Fast on"}
        self.write_routes(self.task, {"plan-lane": sol})
        built = self.launch(self.task, "plan-lane", "recorded['plan-lane'].route", self.watcher_catalog(), task_class="plan")
        self.assertEqual(built["request"].get("provider"), "pi/fleet/gpt-6.2-sol", built["request"])
        self.assertEqual(built["request"]["settings"], {"thinkingOptionId": "high"})
        self.assertIn("model=fleet/gpt-6.2-sol; effort=high; Fast=on", built["brief"])

    def test_fresh_sol_plan_default_is_refused(self):
        sol = {"role": "worker", "source": "task-default", "kind": "plan", "model": "fleet/gpt-6.2-sol", "effort": "high",
               "fastMode": False, "reason": "plan default Sol high, Fast off"}
        catalog = [*self.watcher_catalog(), {"id": "fleet/claude-fable-5-2", "label": "Fable", "thinkingOptions": [{"id": "high"}]}]
        fresh = self.launch(self.task, "plan-lane", json.dumps(sol), catalog, record_lane="plan-lane",
                            task_class="plan")
        self.assertEqual(fresh["record"].get("error"), "recorded owner or task-default route required for worker; a Claude "
                                                    "class never runs a GPT or web model")
        self.assertEqual(fresh["request"].get("error"), "plan lane refuses this Worker route: fleet/gpt-6.2-sol is not the "
                                                     "plan class's Fable model")
        self.assertEqual(fresh["brief"].get("error"), "plan lane refuses this Worker route: fleet/gpt-6.2-sol does not name the "
                                                   "plan class's Fable model")

    def test_owner_named_route_with_object_prototype_class_matches_main(self):
        catalog = self.watcher_catalog()
        root = Path(self.task).parent.parent
        (root / "catalog.json").write_text(json.dumps(catalog))
        done = run("node", str(SCRIPTS / "route.mjs"), "--class", "constructor", "--owner-model", "fleet/gpt-6.2-sol",
                   "--owner-effort", "high", "--catalog", str(root / "catalog.json"))
        self.assertEqual(done.returncode, 0, done.stderr)
        parsed = json.loads(done.stdout)
        self.assertEqual(parsed["route"], {"role": "worker", "source": "owner-explicit",
                                           "model": "fleet/gpt-6.2-sol", "effort": "high", "fastMode": False})
        self.assertEqual(parsed["reason"], "owner-named, never adjusted")
        self.assertEqual((parsed["provider"], parsed["model"], parsed["effort"], parsed["fast"], parsed["proofRequired"]),
                         ("pi/fleet/gpt-6.2-sol", "fleet/gpt-6.2-sol", "high", False, False))
        self.assertIn("route constructor: pi/fleet/gpt-6.2-sol effort=high fast=off", done.stderr)

    def test_watcher_task_kind_without_recorded_lane_never_maps_luna(self):
        done = run("node", "--input-type=module", "-e", f"""
            import {{ resolveAgentSurface }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            const catalog = {json.dumps(self.watcher_catalog())};
            const luna = kind => ({{ role: 'worker', source: 'task-default', kind, model: 'fleet/gpt-6-luna', effort: 'high',
              fastMode: true, reason: 'x' }});
            const attempt = make => {{ try {{ return make().provider; }} catch (error) {{ return error.message; }} }};
            console.log(JSON.stringify([attempt(() => resolveAgentSurface('worker', {{ explicitRoute: luna('review'),
              taskKind: 'watcher' }}, catalog)), attempt(() => resolveAgentSurface('worker', {{ taskKind: 'watcher' }}, catalog))]));
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), ["task-default Worker route must match its Pi catalog label",
                                                   "pi/fleet/gpt-6.2-sol"])

    def test_route_cli_research_resolves_to_terra_high(self):
        root = Path(self.task).parent.parent
        catalog = [{"id": "fleet/claude-fable-5-2", "label": "Fable", "thinkingOptions": [{"id": "high"}]},
                   {"id": "fleet/gpt-6.2-sol", "label": "Sol", "thinkingOptions": [{"id": "high"}, {"id": "xhigh"}]},
                   {"id": "fleet/gpt-6.1-terra", "label": "Terra", "thinkingOptions": [{"id": "high"}]}]
        (root / "catalog.json").write_text(json.dumps(catalog))
        done = run("node", str(SCRIPTS / "route.mjs"), "--class", "research", "--catalog", str(root / "catalog.json"))
        self.assertEqual(done.returncode, 0, done.stderr)
        parsed = json.loads(done.stdout)
        self.assertEqual(parsed["route"], {"role": "worker", "source": "task-default", "kind": "research",
                                           "model": "fleet/gpt-6.1-terra", "effort": "high",
                                           "fastMode": False, "reason": "research default Terra high, Fast off"})
        self.assertEqual(parsed["reason"], "research default Terra high, Fast off")
        self.assertEqual((parsed["provider"], parsed["model"], parsed["effort"], parsed["fast"], parsed["proofRequired"]),
                         ("pi/fleet/gpt-6.1-terra", "fleet/gpt-6.1-terra", "high", False, False))
        self.assertIn("route research: pi/fleet/gpt-6.1-terra effort=high fast=off", done.stderr)

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
        self.write_routes(self.task, {"code-lane": {**PRE_730_CODE_ROUTE, "effort": "medium"}})
        built = self.launch(self.task, "code-lane", "recorded['code-lane'].route", catalog, record_lane="medium-lane",
                             task_class="code")
        for step in ("request", "brief"):
            self.assertEqual(built[step].get("error"), "recorded code Worker route cannot rebuild: effort medium is below the code "
                                                       "minimum high", step)
        self.assertIn("recorded owner or task-default route required for worker", built["record"].get("error", ""))

    def test_route_from_non_ui_task_cannot_launch_ui_task_lane(self):
        root = Path(self.task).parent.parent
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        catalog.append({"id": "fleet/claude-fable-5-1", "label": "Fable", "thinkingOptions": [{"id": "high"}]})
        (root / "catalog.json").write_text(json.dumps(catalog))
        ui = self.ui_task()
        for task, kind, lane in ((self.task, "code", "code-lane"), (ui, "ui", "ui-lane")):
            recorded = run("node", str(SCRIPTS / "route.mjs"), "--class", kind, "--catalog", str(root / "catalog.json"),
                           "--task", task, "--lane", lane)
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
                       "--task", self.task, "--lane", "code-lane")
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
        catalog = [{"id": f"fleet/{model}", "label": label, "thinkingOptions": [{"id": "low"}, {"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}
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
        sonnet = {**{key: value for key, value in PRE_730_CODE_ROUTE.items() if key != "pace"},
                  "model": "fleet/claude-sonnet-5-5", "effort": "high"}
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
        route = ("node", str(SCRIPTS / "route.mjs"), "--catalog", str(root / "catalog.json"),
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

    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch is macOS-only")
    def test_decision_366a_forced_off_pace_default_claude_classes_and_invariants(self):
        root = Path(self.task).parent.parent
        scratch_home = root / "scratch-home"
        opc_dir = scratch_home / ".config" / "opc"
        opc_dir.mkdir(parents=True, mode=0o700)
        fake_bin = root / "fake-bin"
        fake_bin.mkdir()
        paseo_shim = fake_bin / "paseo"
        paseo_shim.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = daemon ] && [ \"$2\" = status ]; then\n"
            "  printf '{\"localDaemon\":\"running\",\"serverId\":\"srv-local-example\"}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "if [ \"$1\" = inspect ]; then\n"
            "  case \"$2\" in\n"
            "    allowed-pm-0001) printf '{\"Id\":\"allowed-pm-0001\",\"ParentAgentId\":null}\\n' ;;\n"
            "    excluded-pm-0001) printf '{\"Id\":\"excluded-pm-0001\",\"ParentAgentId\":null}\\n' ;;\n"
            "    child-of-excl-01) printf '{\"Id\":\"child-of-excl-01\",\"ParentAgentId\":\"excluded-pm-0001\"}\\n' ;;\n"
            "    *) exit 1 ;;\n"
            "  esac\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n"
        )
        paseo_shim.chmod(0o755)
        ui_task = self.ui_task()
        env = {
            **os.environ,
            "HOME": str(scratch_home),
            "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "PASEO_AGENT_ID": "allowed-pm-0001",
        }
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ chmodSync, existsSync, writeFileSync }} from 'node:fs';
            import {{ execFileSync }} from 'node:child_process';
            import {{ join }} from 'node:path';
            import {{ buildDelegatedBrief, PACE_BACKUP_RUNTIME, paceBackupReason, REPLACEMENT_RUNTIME, replacementReason }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ buildManagedWorkerRequest, managedWorkerNames }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const routingPath = join(opcDir, 'routing.json');
            const remoteMapPath = join(opcDir, 'neon-remote-targets.json');
            const altPath = join(opcDir, 'code-alternation.json');
            const taskPath = {json.dumps(self.task)};
            const uiTaskPath = {json.dumps(ui_task)};
            const routeCli = {json.dumps(str(SCRIPTS / 'route.mjs'))};

            const writeOwner = (path, obj) => {{
              writeFileSync(path, JSON.stringify(obj, null, 2) + '\\n', {{ mode: 0o600 }});
              chmodSync(path, 0o600);
            }};
            const setSwitch = (forced) => {{
              const now = Date.now();
              writeOwner(routingPath, {{
                replacementExcludedLaunchers: ['excluded-'],
                antigravityFallback: {{
                  enabled: forced,
                  state: {{
                    off_pace: forced,
                    as_of: new Date(now - 60_000).toISOString(),
                    expires_at: new Date(now + 3_600_000).toISOString(),
                  }},
                }},
              }});
            }};
            writeOwner(remoteMapPath, {{
              targets: {{ 'srv-remote-example': {{ endpoint: 'ssh://remote-example', platform: 'linux', state: 'held' }} }},
            }});

            const levels = ids => ids.map(id => ({{ id }}));
            const catalog = [
              ['claude-opus-5-5', 'Opus'],
              ['claude-fable-5-1', 'Fable'],
              ['gpt-6.2-sol', 'Sol'],
              ['gpt-6.1-terra', 'Terra'],
              ['gpt-6-luna', 'Luna'],
            ].map(([id, label]) => ({{ id: 'fleet/' + id, label, thinkingOptions: levels(['low', 'medium', 'high', 'xhigh']) }}));
            const piCaps = {{ enabled: true, status: 'available', modes: [], models: catalog }};
            const target = {{ daemon: 'srv-local-example', local: true, platform: 'darwin' }};
            const nowIso = new Date().toISOString();
            const olderIso = new Date(Date.now() - 120_000).toISOString();
            const staleIso = new Date(Date.now() - 2 * 3_600_000).toISOString();
            const proofFor = (t = target, at = olderIso) => ({{
              provider: 'agy-opc', extends: 'acp', model: 'gemini-4-neon-high', thinking: 'high',
              mode: 'auto', sandboxed: true, write: true, target: t, verified_at: at,
            }});
            const unavailableFor = (t = target, at = nowIso) => ({{
              provider: 'agy-opc', target: t, checked_at: at, finding: 'not-available',
            }});
            const fableDownFor = (t = target, at = nowIso) => ({{
              provider: 'pi', model: 'fleet/claude-fable-5-1', target: t, checked_at: at, finding: 'not-serving',
            }});
            const neonCaps = {{
              provider: 'agy-opc', enabled: true, status: 'available',
              models: [{{ id: 'gemini-4-neon-high', thinkingOptions: [{{ id: 'high' }}] }}],
              modes: [{{ id: 'auto' }}],
              selectedModel: 'gemini-4-neon-high',
              features: [{{ id: 'auto_accept', type: 'toggle', value: true }}],
              checked_at: new Date().toISOString(),
            }};

            // 1. Decision 390a: forced off pace keeps default plan, ui-design (and alias ui), ui-check on Fable high;
            // ONLY positive fresh Fable cannot-serve evidence enters the agy ladder.
            setSwitch(true);
            for (const [tPath, cls, replayCls, lane] of [
              [taskPath, 'plan', 'plan', 'plan-fable-default'],
              [uiTaskPath, 'ui', 'ui-design', 'ui-design-fable-default'],
              [uiTaskPath, 'ui-check', 'ui-check', 'ui-check-fable-default'],
            ]) {{
              const task = readTask(tPath);
              const stayFable = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{ task, lane, target, proof: proofFor(target, nowIso) }},
              }});
              assert.equal(stayFable.route.model, 'fleet/claude-fable-5-1', 'decision 390a keeps plan/ui Fable high when Fable is not unavailable');
            }}
            for (const [tPath, cls, replayCls, lane] of [
              [taskPath, 'plan', 'plan', 'plan-neon'],
              [uiTaskPath, 'ui', 'ui-design', 'ui-design-neon'],
              [uiTaskPath, 'ui-check', 'ui-check', 'ui-check-neon'],
            ]) {{
              const task = readTask(tPath);
              const replacement = {{ task, lane, target, proof: proofFor(target, nowIso), fableUnavailable: fableDownFor(target, nowIso) }};
              const resolved = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement }});
              assert.equal(resolved.route.source, 'replacement');
              assert.equal(resolved.route.kind, replayCls);
              assert.equal(resolved.route.model, REPLACEMENT_RUNTIME.model);
              assert.equal(resolved.route.effort, 'high');
              assert.equal(resolved.route.fastMode, false);
              assert.equal(resolved.reason, replacementReason(replayCls));
              assert.equal(resolved.route.receipt.placement, managedWorkerNames({{ taskId: task.id, lane }}).branchName);

              recordWorkerRoute(tPath, {{ lane, ...resolved, taskClass: cls, catalog, replacement }});
              assert.equal(existsSync(altPath), false, 'forced 366a lane must not touch code-alternation.json');

              const updated = readTask(tPath);
              const req = buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Worker', initialPrompt: 'Check',
                workspace: {{ workspaceId: 'wks-1', cwd: '/tmp/wt-1', serverId: target.daemon }},
                capabilities: neonCaps, route: resolved.route, task: updated, taskClass: cls, target,
              }});
              assert.equal(req.request.provider, 'agy-opc/gemini-4-neon-high');
              assert.deepEqual(req.request.settings, {{ thinkingOptionId: 'high', features: {{ auto_accept: true }}, modeId: 'auto' }});
              assert.equal(req.request.labels['opc.route-source'], 'replacement');

              const brief = buildDelegatedBrief({{
                role: 'worker', route: resolved.route, reason: resolved.reason, brief: 'Inspect',
                task: updated, lane, taskClass: cls, catalog,
              }});
              assert.match(brief, /^Fixed route for this worker lane: model=gemini-4-neon-high; effort=high; Fast=off;/);
              assert.match(brief, /Read-only lane: do not edit, implement, or publish\\./);

              // CLI replay with no route flags or matching class succeeds; mismatched class fails.
              const replayed = JSON.parse(execFileSync(process.execPath, [routeCli, '--task', tPath, '--lane', lane], {{ encoding: 'utf8' }}));
              assert.deepEqual(replayed.route, resolved.route);
              const replayedCls = JSON.parse(execFileSync(process.execPath, [routeCli, '--task', tPath, '--lane', lane, '--class', cls], {{ encoding: 'utf8' }}));
              assert.deepEqual(replayedCls.route, resolved.route);
              const wrongCls = replayCls === 'plan' ? 'code' : replayCls === 'ui-design' ? 'ui-check' : 'ui-design';
              assert.throws(() => execFileSync(process.execPath, [routeCli, '--task', tPath, '--lane', lane, '--class', wrongCls], {{ stdio: 'pipe' }}));
            }}

            // 2. Positive fresh Fable cannot-serve + positive fresh agy unavailable evidence: Sol medium backup.
            for (const [tPath, cls, canon, lane] of [
              [taskPath, 'plan', 'plan', 'plan-sol'],
              [uiTaskPath, 'ui-design', 'ui-design', 'ui-design-sol'],
              [uiTaskPath, 'ui-check', 'ui-check', 'ui-check-sol'],
            ]) {{
              const task = readTask(tPath);
              const replacement = {{ task, lane, target, proof: proofFor(target, olderIso), unavailable: unavailableFor(target, nowIso), fableUnavailable: fableDownFor(target, nowIso) }};
              const resolved = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement }});
              assert.equal(resolved.route.source, 'pace-backup');
              assert.equal(resolved.route.kind, canon);
              assert.equal(resolved.route.model, PACE_BACKUP_RUNTIME.model);
              assert.equal(resolved.route.effort, 'medium');
              assert.equal(resolved.route.fastMode, false);
              assert.equal(resolved.reason, paceBackupReason(canon));
              assert.equal(resolved.route.receipt.target, target.daemon);

              recordWorkerRoute(tPath, {{ lane, ...resolved, taskClass: cls, catalog, replacement }});
              const updated = readTask(tPath);
              const req = buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Worker', initialPrompt: 'Check',
                workspace: {{ workspaceId: 'wks-2', cwd: '/tmp/wt-2', serverId: target.daemon }},
                capabilities: piCaps, route: resolved.route, task: updated, taskClass: cls, target,
              }});
              assert.equal(req.request.provider, 'pi/fleet/gpt-6.2-sol');
              assert.deepEqual(req.request.settings, {{ thinkingOptionId: 'medium' }});
              assert.equal(req.request.labels['opc.service-tier'], 'standard');
              assert.equal(req.request.labels['opc.route-source'], 'pace-backup');

              const brief = buildDelegatedBrief({{
                role: 'worker', route: resolved.route, reason: resolved.reason, brief: 'Inspect',
                task: updated, lane, taskClass: cls, catalog,
              }});
              assert.match(brief, /Read-only lane: do not edit, implement, or publish\\./);
            }}

            // 3. Missing proof and stale unavailable evidence stay Fable high (never Sol backup).
            for (const [tPath, cls, lane] of [[taskPath, 'plan', 'plan-none'], [uiTaskPath, 'ui-design', 'ui-none']]) {{
              const task = readTask(tPath);
              const none = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement: {{ task, lane, target }} }});
              assert.equal(none.route.model, 'fleet/claude-fable-5-1');
              const stale = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{ task, lane, target, unavailable: unavailableFor(target, staleIso) }},
              }});
              assert.equal(stale.route.model, 'fleet/claude-fable-5-1');
            }}

            // 4. Local daemon binding on new paths (no caller-only shortcut) and mapped remote never local.
            const wrongTarget = {{ daemon: 'srv-other-local', local: true, platform: 'darwin' }};
            const mappedAsLocal = {{ daemon: 'srv-remote-example', local: true, platform: 'darwin' }};
            for (const badTarget of [wrongTarget, mappedAsLocal]) {{
              for (const [tPath, cls, lane] of [[taskPath, 'plan', 'plan-bad'], [uiTaskPath, 'ui-design', 'ui-bad']]) {{
                const task = readTask(tPath);
                const rProof = await resolveWorkerRoute({{
                  taskClass: cls, catalog, replacement: {{ task, lane, target: badTarget, proof: proofFor(badTarget, nowIso) }},
                }});
                assert.equal(rProof.route.model, 'fleet/claude-fable-5-1');
                const rDown = await resolveWorkerRoute({{
                  taskClass: cls, catalog, replacement: {{ task, lane, target: badTarget, unavailable: unavailableFor(badTarget, nowIso) }},
                }});
                assert.equal(rDown.route.model, 'fleet/claude-fable-5-1');
              }}
            }}
            // A hand-crafted local replacement record with a non-local daemon fails at launch.
            const fakePlanTask = readTask(taskPath);
            const forgedPlanRoute = {{
              role: 'worker', source: 'replacement', kind: 'plan', model: 'gemini-4-neon-high', effort: 'high',
              fastMode: false, reason: replacementReason('plan'),
              receipt: {{
                provider: 'agy-opc', mode: 'auto', target: 'srv-other-local', task: fakePlanTask.id,
                lane: 'forged-plan', placement: managedWorkerNames({{ taskId: fakePlanTask.id, lane: 'forged-plan' }}).branchName,
              }},
            }};
            const forgedTask = {{ ...fakePlanTask, routes: {{ ...fakePlanTask.routes, 'forged-plan': {{ route: forgedPlanRoute, reason: forgedPlanRoute.reason, recorded_at: nowIso }} }} }};
            assert.throws(() => buildDelegatedBrief({{
              role: 'worker', route: forgedPlanRoute, reason: forgedPlanRoute.reason, brief: 'Inspect',
              task: forgedTask, lane: 'forged-plan', taskClass: 'plan', catalog,
            }}), /local daemon is not the Neon receipt target/);

            // 5. Non-Claude classes stay unchanged while forced on.
            const nonTask = readTask(taskPath);
            for (const [cls, model, effort, fastMode] of [
              ['review', 'fleet/gpt-6.2-sol', 'high', true],
              ['review-security', 'fleet/gpt-6.2-sol', 'xhigh', true],
              ['research', 'fleet/gpt-6.1-terra', 'high', false],
              ['watcher', 'fleet/gpt-6.2-sol', 'low', false],
              ['smoke', 'fleet/gpt-6-luna', 'low', true],
            ]) {{
              const res = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{ task: nonTask, lane: cls + '-lane', target, proof: proofFor(target, nowIso) }},
              }});
              assert.equal(res.route.source, 'task-default');
              assert.equal(res.route.model, model);
              assert.equal(res.route.effort, effort);
              assert.equal(res.route.fastMode, fastMode);
            }}

            // 6. Owner-named routes stay unchanged while forced on, and old UI guard stays strict for owner-explicit routes.
            const ownerFable = {{ role: 'worker', source: 'owner-explicit', model: 'fleet/claude-fable-5-1', effort: 'high', fastMode: false }};
            const ownerSec = {{ role: 'worker', source: 'owner-explicit', model: 'fleet/claude-opus-5-5', effort: 'xhigh', fastMode: false }};
            for (const [tPath, cls, ownerRoute] of [
              [taskPath, 'plan', ownerFable],
              [uiTaskPath, 'ui-design', ownerFable],
              [uiTaskPath, 'ui-check', ownerFable],
              [taskPath, 'review-security', ownerSec],
            ]) {{
              const t = readTask(tPath);
              const res = await resolveWorkerRoute({{
                taskClass: cls, ownerRoute, catalog, replacement: {{ task: t, lane: 'owner-lane', target, proof: proofFor(target, nowIso) }},
              }});
              assert.equal(res.route.source, 'owner-explicit');
              assert.equal(res.route.model, ownerRoute.model);
            }}
            for (const badOwner of [
              {{ role: 'worker', source: 'owner-explicit', model: 'fleet/claude-opus-5-5', effort: 'high', fastMode: false }},
              {{ role: 'worker', source: 'owner-explicit', model: 'fleet/gpt-6.2-sol', effort: 'medium', fastMode: false }},
              {{ role: 'worker', source: 'owner-explicit', model: 'gemini-4-neon-high', effort: 'high', fastMode: false }},
            ]) {{
              assert.throws(() => recordWorkerRoute(uiTaskPath, {{
                lane: 'bad-owner-ui', route: badOwner, reason: 'owner-named, never adjusted', taskClass: 'ui-design', catalog,
              }}), /UI task: a ui-design lane records only Fable high, Fast off/);
            }}
            // Cross-class off-pace replay is refused.
            const planNeonRec = readTask(taskPath).routes['plan-neon'];
            assert.throws(() => buildDelegatedBrief({{
              role: 'worker', route: planNeonRec.route, reason: planNeonRec.reason, brief: 'x',
              task: readTask(taskPath), lane: 'plan-neon', taskClass: 'code', catalog,
            }}), /launches only from its own recorded plan lane/);

            // 7. Excluded launcher and excluded parent chain stay Fable high and refuse launch.
            for (const launcher of ['excluded-pm-0001', 'child-of-excl-01']) {{
              process.env.PASEO_AGENT_ID = launcher;
              const t = readTask(uiTaskPath);
              const res = await resolveWorkerRoute({{
                taskClass: 'ui-design', catalog, replacement: {{ task: t, lane: 'excl-lane', target, proof: proofFor(target, nowIso) }},
              }});
              assert.equal(res.route.model, 'fleet/claude-fable-5-1');
              const rec = t.routes['ui-design-neon'];
              assert.throws(() => buildDelegatedBrief({{
                role: 'worker', route: rec.route, reason: rec.reason, brief: 'x',
                task: t, lane: 'ui-design-neon', taskClass: 'ui-design', catalog,
              }}), /launcher is excluded/);
            }}
            process.env.PASEO_AGENT_ID = 'allowed-pm-0001';

            // 8. When pace recovers (switch false/false, 359 parity): plan/ui-design/ui-check stay Fable high (no alternation),
            // already-recorded 366a lanes still rebuild, and code parity (359) still alternates Opus then Neon.
            setSwitch(false);
            for (const [tPath, cls, lane] of [
              [taskPath, 'plan', 'plan-on-pace'],
              [uiTaskPath, 'ui-design', 'ui-design-on-pace'],
              [uiTaskPath, 'ui-check', 'ui-check-on-pace'],
            ]) {{
              const t = readTask(tPath);
              const res = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{ task: t, lane, target, proof: proofFor(target, nowIso) }},
              }});
              assert.equal(res.route.model, 'fleet/claude-fable-5-1');
              recordWorkerRoute(tPath, {{ lane, ...res, taskClass: cls, catalog, replacement: {{ task: t, lane, target, proof: proofFor(target, nowIso) }} }});
            }}
            assert.equal(existsSync(altPath), false, 'on-pace plan/ui lanes must not touch code-alternation.json');
            // Recorded 366a lane still rebuilds after switch turns off.
            const uiRec = readTask(uiTaskPath).routes['ui-design-neon'];
            const rebuilt = buildManagedWorkerRequest({{
              taskId: readTask(uiTaskPath).id, lane: 'ui-design-neon', title: 'Worker', initialPrompt: 'Check',
              workspace: {{ workspaceId: 'wks-3', cwd: '/tmp/wt-3', serverId: target.daemon }},
              capabilities: neonCaps, route: uiRec.route, task: readTask(uiTaskPath), taskClass: 'ui-design', target,
            }});
            assert.equal(rebuilt.request.provider, 'agy-opc/gemini-4-neon-high');
            // Decision 359 code parity still works (Opus first, then Neon).
            const c1Task = readTask(taskPath);
            const c1Ctx = {{ task: c1Task, lane: 'code-p1', target, proof: proofFor(target, nowIso) }};
            const c1 = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: c1Ctx }});
            assert.equal(c1.route.source, 'task-default');
            assert.equal(c1.route.model, 'fleet/claude-opus-5-5');
            recordWorkerRoute(taskPath, {{ lane: 'code-p1', ...c1, taskClass: 'code', catalog, replacement: c1Ctx }});
            const c2Task = readTask(taskPath);
            const c2Ctx = {{ task: c2Task, lane: 'code-p2', target, proof: proofFor(target, nowIso) }};
            const c2 = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: c2Ctx }});
            assert.equal(c2.route.source, 'replacement');
            assert.equal(c2.route.kind, 'code');
            assert.match(c2.reason, /alternation/);
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch is macOS-only")
    def test_decision_366a_remote_attestation_armed_and_held(self):
        root = Path(self.task).parent.parent
        scratch_home = root / "scratch-home-remote"
        opc_dir = scratch_home / ".config" / "opc"
        opc_dir.mkdir(parents=True, mode=0o700)
        # Fake @getpaseo/cli 0.15.3 package with bin/paseo symlink on PATH.
        pkg_root = root / "fake-cli-pkg"
        (pkg_root / "bin").mkdir(parents=True)
        (pkg_root / "dist" / "utils").mkdir(parents=True)
        (pkg_root / "package.json").write_text(json.dumps({"name": "@getpaseo/cli", "version": "0.15.3"}))
        (pkg_root / "dist" / "utils" / "client.js").write_text(
            "export async function connectToDaemon({ target }) {\n"
            "  const host = target?.host;\n"
            "  const serverId = host === 'ssh://armed-example' ? 'srv-armed-example' : 'srv-other-example';\n"
            "  return {\n"
            "    getLastServerInfoMessage: () => ({ serverId, version: '0.15.3' }),\n"
            "    fetchWorkspaces: async () => ({\n"
            "      entries: JSON.parse(process.env.FAKE_REMOTE_WORKSPACES || '[]'),\n"
            "      pageInfo: { hasMore: false },\n"
            "    }),\n"
            "    getProvidersSnapshot: async () => ({\n"
            "      entries: [{ provider: 'agy-opc', enabled: true, status: 'ready' }],\n"
            "    }),\n"
            "    listProviderModels: async () => ({\n"
            "      models: [{ id: 'gemini-4-neon-high', thinkingOptions: [{ id: 'high' }] }],\n"
            "    }),\n"
            "    listProviderModes: async () => ({ modes: [{ id: 'auto' }] }),\n"
            "    listProviderFeatures: async () => ({ features: [{ id: 'auto_accept', type: 'toggle', value: true }] }),\n"
            "    close: async () => {},\n"
            "  };\n"
            "}\n"
        )
        paseo_real = pkg_root / "bin" / "paseo"
        paseo_real.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = inspect ] && [ \"$2\" = allowed-pm-0001 ]; then\n"
            "  printf '{\"Id\":\"allowed-pm-0001\",\"ParentAgentId\":null}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n"
        )
        paseo_real.chmod(0o755)
        fake_bin = root / "fake-remote-bin"
        fake_bin.mkdir()
        (fake_bin / "paseo").symlink_to(paseo_real)
        ui_task = self.ui_task()
        env = {
            **os.environ,
            "HOME": str(scratch_home),
            "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "PASEO_AGENT_ID": "allowed-pm-0001",
        }
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ chmodSync, writeFileSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ replacementReason }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ buildManagedWorkerRequest, managedWorkerNames, validateManagedWorkerLaunch }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ readRemoteNeonTarget }} from {json.dumps((SCRIPTS / 'remote-target.mjs').as_uri())};
            import {{ recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const writeOwner = (path, obj) => {{
              writeFileSync(path, JSON.stringify(obj, null, 2) + '\\n', {{ mode: 0o600 }});
              chmodSync(path, 0o600);
            }};
            const now = Date.now();
            writeOwner(join(opcDir, 'routing.json'), {{
              replacementExcludedLaunchers: ['excluded-'],
              antigravityFallback: {{
                enabled: true,
                state: {{
                  off_pace: true,
                  as_of: new Date(now - 60_000).toISOString(),
                  expires_at: new Date(now + 3_600_000).toISOString(),
                }},
              }},
            }});
            writeOwner(join(opcDir, 'neon-remote-targets.json'), {{
              targets: {{
                'srv-armed-example': {{ endpoint: 'ssh://armed-example', platform: 'linux', state: 'armed' }},
                'srv-held-example': {{ endpoint: 'ssh://held-example', platform: 'linux', state: 'held' }},
              }},
            }});

            const catalog = [
              ['claude-opus-5-5', 'Opus'],
              ['claude-fable-5-1', 'Fable'],
              ['gpt-6.2-sol', 'Sol'],
            ].map(([id, label]) => ({{ id: 'fleet/' + id, label, thinkingOptions: [{{ id: 'medium' }}, {{ id: 'high' }}] }}));
            const armedTarget = {{ daemon: 'srv-armed-example', local: false, platform: 'linux' }};
            const heldTarget = {{ daemon: 'srv-held-example', local: false, platform: 'linux' }};
            const nowIso = new Date().toISOString();
            const proofFor = t => ({{
              provider: 'agy-opc', extends: 'acp', model: 'gemini-4-neon-high', thinking: 'high',
              mode: 'auto', sandboxed: true, write: true, target: t, verified_at: nowIso,
            }});

            // Held and unlisted remote hosts are refused.
            await assert.rejects(() => readRemoteNeonTarget({{ serverId: 'srv-held-example' }}), /not an armed entry/);
            await assert.rejects(() => readRemoteNeonTarget({{ serverId: 'srv-unlisted' }}), /not an armed entry/);

            // Armed remote host admits forced plan and ui-design with fresh attestation, never caller capabilities or Sol backup.
            const resolveAttestation = await readRemoteNeonTarget({{ serverId: 'srv-armed-example' }});
            for (const [tPath, cls, lane] of [[{json.dumps(self.task)}, 'plan', 'remote-plan'], [{json.dumps(ui_task)}, 'ui-design', 'remote-ui']]) {{
              const task = readTask(tPath);
              // Without attestation (caller-only remote) stays Fable high.
              const noAtt = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{ task, lane, target: armedTarget, proof: proofFor(armedTarget) }},
              }});
              assert.equal(noAtt.route.model, 'fleet/claude-fable-5-1');
              // Remote unavailable evidence admits nothing (no Sol backup on remote).
              const withUnavailable = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{
                  task, lane, target: armedTarget, remote: resolveAttestation,
                  unavailable: {{ provider: 'agy-opc', target: armedTarget, checked_at: nowIso, finding: 'not-available' }},
                }},
              }});
              assert.equal(withUnavailable.route.model, 'fleet/claude-fable-5-1');
              // Held target stays Fable high even with another host's attestation.
              const heldRes = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{ task, lane, target: heldTarget, proof: proofFor(heldTarget), remote: resolveAttestation }},
              }});
              assert.equal(heldRes.route.model, 'fleet/claude-fable-5-1');

              // Genuine armed attestation admits when positive fresh Fable cannot-serve evidence is present.
              const fableDown = {{ provider: 'pi', model: 'fleet/claude-fable-5-1', target: armedTarget, checked_at: nowIso, finding: 'not-serving' }};
              const stayFable = await resolveWorkerRoute({{
                taskClass: cls, catalog, replacement: {{ task, lane, target: armedTarget, proof: proofFor(armedTarget), remote: resolveAttestation }},
              }});
              assert.equal(stayFable.route.model, 'fleet/claude-fable-5-1');
              const ctx = {{ task, lane, target: armedTarget, proof: proofFor(armedTarget), remote: resolveAttestation, fableUnavailable: fableDown }};
              const resolved = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement: ctx }});
              assert.equal(resolved.route.source, 'replacement');
              assert.equal(resolved.route.kind, cls);
              assert.equal(resolved.reason, replacementReason(cls));
              recordWorkerRoute(tPath, {{ lane, ...resolved, taskClass: cls, catalog, replacement: ctx }});

              const names = managedWorkerNames({{ taskId: task.id, lane }});
              process.env.FAKE_REMOTE_WORKSPACES = JSON.stringify([{{
                id: 'wks-remote-1', workspaceKind: 'worktree', worktreeSlug: names.worktreeSlug,
                workspaceDirectory: '/tmp/remote-wt', gitRuntime: {{ currentBranch: names.branchName }}, archivingAt: null,
              }}]);
              const launchAttestation = await readRemoteNeonTarget({{
                serverId: 'srv-armed-example',
                workspace: {{ workspaceId: 'wks-remote-1', worktreeSlug: names.worktreeSlug, branchName: names.branchName }},
              }});
              const updated = readTask(tPath);
              const ws = {{ workspaceId: 'wks-remote-1', cwd: '/tmp/remote-wt', serverId: 'srv-armed-example' }};
              // Caller capabilities are refused on remote launches.
              assert.throws(() => buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Worker', initialPrompt: 'Check',
                workspace: ws, capabilities: launchAttestation.capabilities, route: resolved.route,
                task: updated, taskClass: cls, target: armedTarget, remote: launchAttestation,
              }}), /takes no caller capabilities/);
              const req = buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Worker', initialPrompt: 'Check',
                workspace: ws, route: resolved.route, task: updated, taskClass: cls, target: armedTarget, remote: launchAttestation,
              }});
              assert.equal(req.request.serverId, 'srv-armed-example');
              assert.equal(req.request.provider, 'agy-opc/gemini-4-neon-high');
              assert.deepEqual(req.request.settings, {{ thinkingOptionId: 'high', features: {{ auto_accept: true }}, modeId: 'auto' }});
              const launched = validateManagedWorkerLaunch(req, {{ agentId: 'agt-remote-1', workspaceId: 'wks-remote-1', serverId: 'srv-armed-example' }});
              assert.equal(launched.agentId, 'agt-remote-1');
              assert.throws(() => validateManagedWorkerLaunch(req, {{ agentId: 'agt-remote-1', workspaceId: 'wks-remote-1', serverId: 'srv-wrong' }}),
                /verified remote server/);
            }}
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch is macOS-only")
    def test_decision_366a_opn_managed_handoff_and_sol_backup_daemon_binding(self):
        root = Path(self.task).parent.parent
        scratch_home = root / "scratch-home-handoff"
        opc_dir = scratch_home / ".config" / "opc"
        opc_dir.mkdir(parents=True, mode=0o700)
        daemon_id_file = root / "current-daemon-id"
        daemon_id_file.write_text("srv-daemon-a\n")
        fake_bin = root / "fake-bin-handoff"
        fake_bin.mkdir()
        paseo_shim = fake_bin / "paseo"
        paseo_shim.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = daemon ] && [ \"$2\" = status ]; then\n"
            f"  id=$(tr -d '\\r\\n' < {shlex.quote(str(daemon_id_file))})\n"
            "  printf '{\"localDaemon\":\"running\",\"serverId\":\"%s\"}\\n' \"$id\"\n"
            "  exit 0\n"
            "fi\n"
            "if [ \"$1\" = inspect ] && [ \"$2\" = opn-pm-0001 ]; then\n"
            "  printf '{\"Id\":\"opn-pm-0001\",\"ParentAgentId\":null}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n"
        )
        paseo_shim.chmod(0o755)
        opn_repo = root / "opn-repo"
        opn_run = root / "opn-run"
        opn_repo.mkdir()
        opn_run.mkdir()
        for args in (["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://github.com/example/opn-work.git"],
                     ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]):
            subprocess.run(["git", "-C", str(opn_repo), *args], check=True, capture_output=True)
        ui_task = self.ui_task()
        env = {
            **os.environ,
            "HOME": str(scratch_home),
            "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "PASEO_AGENT_ID": "opn-pm-0001",
        }
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ execFileSync }} from 'node:child_process';
            import {{ chmodSync, writeFileSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ buildDelegatedBrief, paceBackupReason }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ buildManagedWorkerRequest, managedWorkerNames }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ createTask, readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const daemonIdFile = {json.dumps(str(daemon_id_file))};
            const routeCli = {json.dumps(str(SCRIPTS / 'route.mjs'))};
            const catalogPath = {json.dumps(str(root / 'handoff-catalog.json'))};
            const uiTaskPath = {json.dumps(ui_task)};

            const writeOwner = (path, obj) => {{
              writeFileSync(path, JSON.stringify(obj, null, 2) + '\\n', {{ mode: 0o600 }});
              chmodSync(path, 0o600);
            }};
            const now = Date.now();
            writeOwner(join(opcDir, 'routing.json'), {{
              replacementExcludedLaunchers: ['excluded-'],
              antigravityFallback: {{
                enabled: true,
                state: {{
                  off_pace: true,
                  as_of: new Date(now - 60_000).toISOString(),
                  expires_at: new Date(now + 3_600_000).toISOString(),
                }},
              }},
            }});
            writeOwner(join(opcDir, 'neon-remote-targets.json'), {{
              targets: {{ 'srv-remote-example': {{ endpoint: 'ssh://remote-example', platform: 'linux', state: 'held' }} }},
            }});

            const levels = ids => ids.map(id => ({{ id }}));
            const catalog = [
              ['claude-opus-5-5', 'Opus'],
              ['claude-fable-5-1', 'Fable'],
              ['gpt-6.2-sol', 'Sol'],
              ['gpt-6.1-terra', 'Terra'],
              ['gpt-6-luna', 'Luna'],
            ].map(([id, label]) => ({{ id: 'fleet/' + id, label, thinkingOptions: levels(['low', 'medium', 'high', 'xhigh']) }}));
            writeFileSync(catalogPath, JSON.stringify(catalog));
            const piCaps = {{ enabled: true, status: 'available', modes: [], models: catalog }};
            const neonCaps = {{
              provider: 'agy-opc', enabled: true, status: 'available',
              models: [{{ id: 'gemini-4-neon-high', thinkingOptions: [{{ id: 'high' }}] }}],
              modes: [{{ id: 'auto' }}],
              selectedModel: 'gemini-4-neon-high',
              features: [{{ id: 'auto_accept', type: 'toggle', value: true }}],
              checked_at: new Date().toISOString(),
            }};
            const targetA = {{ daemon: 'srv-daemon-a', local: true, platform: 'darwin' }};
            const targetB = {{ daemon: 'srv-daemon-b', local: true, platform: 'darwin' }};
            const targetMapped = {{ daemon: 'srv-remote-example', local: true, platform: 'darwin' }};
            const nowIso = new Date().toISOString();
            const proofA = {{
              provider: 'agy-opc', extends: 'acp', model: 'gemini-4-neon-high', thinking: 'high',
              mode: 'auto', sandboxed: true, write: true, target: targetA, verified_at: nowIso,
            }};
            const unavailableFor = t => ({{ provider: 'agy-opc', target: t, checked_at: nowIso, finding: 'not-available' }});

            // Part A: Actual documented OPN managed handoff on a git checkout.
            const {{ taskPath: opnTaskPath }} = createTask({{
              workingDirectory: {json.dumps(str(opn_repo))}, runDirectory: {json.dumps(str(opn_run))}, owner: 'opn-pm',
            }});
            // Bare CLI --class code reflects live forced Neon High with proofRequired (no writes, no turn);
            // --class plan stays Fable high under decision 390a even when forced off pace.
            const cliCode = JSON.parse(execFileSync(process.execPath,
              [routeCli, '--class', 'code', '--catalog', catalogPath], {{ encoding: 'utf8' }}));
            assert.equal(cliCode.provider, 'agy-opc/gemini-4-neon-high');
            assert.equal(cliCode.proofRequired, true);
            assert.equal(cliCode.nextFallback, 'agy-opc/claude-opus-5-5-high');
            const cliPlanBound = JSON.parse(execFileSync(process.execPath,
              [routeCli, '--class', 'plan', '--catalog', catalogPath, '--task', opnTaskPath, '--lane', 'cli-plan-raw'], {{ encoding: 'utf8' }}));
            assert.equal(cliPlanBound.route.source, 'task-default');
            assert.equal(cliPlanBound.route.model, 'fleet/claude-fable-5-1');
            // Normal non-Claude OPN classes keep working through raw CLI unchanged.
            for (const [cls, model] of [['research', 'fleet/gpt-6.1-terra'], ['review', 'fleet/gpt-6.2-sol'],
              ['watcher', 'fleet/gpt-6.2-sol'], ['smoke', 'fleet/gpt-6-luna']]) {{
              const res = JSON.parse(execFileSync(process.execPath,
                [routeCli, '--class', cls, '--catalog', catalogPath], {{ encoding: 'utf8' }}));
              assert.equal(res.route.model, model);
            }}
            const fableDownA = {{ provider: 'pi', model: 'fleet/claude-fable-5-1', target: targetA, checked_at: nowIso, finding: 'not-serving' }};
            // Genuine OPN managed handoff via resolveWorkerRoute + recordWorkerRoute + buildManagedWorkerRequest.
            for (const [cls, lane, extra] of [['code', 'opn-code-neon', {{}}], ['plan', 'opn-plan-neon', {{ fableUnavailable: fableDownA }}]]) {{
              const t = readTask(opnTaskPath);
              const ctx = {{ task: t, lane, target: targetA, proof: proofA, ...extra }};
              const res = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement: ctx }});
              assert.equal(res.route.source, 'replacement');
              assert.equal(res.route.kind, cls);
              recordWorkerRoute(opnTaskPath, {{ lane, ...res, taskClass: cls, catalog, replacement: ctx }});
              const updated = readTask(opnTaskPath);
              const req = buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'OPN Worker', initialPrompt: 'Do OPN task',
                workspace: {{ workspaceId: 'wks-opn-1', cwd: '/tmp/opn-wt-1', serverId: 'srv-daemon-a' }},
                capabilities: neonCaps, route: res.route, task: updated, taskClass: cls, target: targetA,
              }});
              assert.equal(req.request.provider, 'agy-opc/gemini-4-neon-high');
              assert.deepEqual(req.request.settings, {{ thinkingOptionId: 'high', features: {{ auto_accept: true }}, modeId: 'auto' }});
              assert.equal(req.request.labels['opc.route-source'], 'replacement');
            }}

            // Part B: Bound Sol backup receipts bind admitted local daemon A; launch/rebuild rejects B and mapped-as-local.
            const admittedBackups = [];
            for (const [tPath, cls, lane] of [
              [opnTaskPath, 'plan', 'opn-plan-sol'],
              [uiTaskPath, 'ui-design', 'ui-design-sol-ab'],
              [uiTaskPath, 'ui-check', 'ui-check-sol-ab'],
            ]) {{
              const t = readTask(tPath);
              const ctx = {{ task: t, lane, target: targetA, unavailable: unavailableFor(targetA), fableUnavailable: fableDownA }};
              const res = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement: ctx }});
              assert.equal(res.route.source, 'pace-backup');
              assert.equal(res.route.kind, cls);
              assert.equal(res.route.receipt.target, 'srv-daemon-a');
              assert.deepEqual(Object.keys(res.route.receipt).sort(), ['lane', 'placement', 'target', 'task']);
              recordWorkerRoute(tPath, {{ lane, ...res, taskClass: cls, catalog, replacement: ctx }});
              admittedBackups.push([tPath, cls, lane, res]);

              // Matching daemon A + workspace A + target A succeeds.
              const updated = readTask(tPath);
              const okReq = buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Sol Backup', initialPrompt: 'Check',
                workspace: {{ workspaceId: 'wks-a', cwd: '/tmp/wt-a', serverId: 'srv-daemon-a' }},
                capabilities: piCaps, route: res.route, task: updated, taskClass: cls, target: targetA,
              }});
              assert.equal(okReq.request.provider, 'pi/fleet/gpt-6.2-sol');
              assert.equal(okReq.request.labels['opc.service-tier'], 'standard');
              assert.equal(okReq.request.labels['opc.route-source'], 'pace-backup');

              // Workspace on B (while daemon is A) is refused.
              assert.throws(() => buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Sol Backup', initialPrompt: 'Check',
                workspace: {{ workspaceId: 'wks-b', cwd: '/tmp/wt-b', serverId: 'srv-daemon-b' }},
                capabilities: piCaps, route: res.route, task: updated, taskClass: cls, target: targetA,
              }}), /managed workspace is not on the recorded target server/);

              // Target B or omitted target is refused.
              for (const badTarget of [targetB, undefined]) {{
                assert.throws(() => buildManagedWorkerRequest({{
                  taskId: updated.id, lane, title: 'Sol Backup', initialPrompt: 'Check',
                  workspace: {{ workspaceId: 'wks-a', cwd: '/tmp/wt-a', serverId: 'srv-daemon-a' }},
                  capabilities: piCaps, route: res.route, task: updated, taskClass: cls, target: badTarget,
                }}), /backup launch target is not the recorded local Mac target/);
              }}
            }}

            // Legacy code Sol backup receipt has no target key and stays unchanged and rebuildable across daemons.
            const codeTask = readTask(opnTaskPath);
            const codeCtx = {{ task: codeTask, lane: 'opn-code-sol', target: targetA, unavailable: unavailableFor(targetA) }};
            const codeSol = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: codeCtx }});
            assert.equal(codeSol.route.source, 'pace-backup');
            assert.deepEqual(Object.keys(codeSol.route.receipt).sort(), ['lane', 'placement', 'task']);
            recordWorkerRoute(opnTaskPath, {{ lane: 'opn-code-sol', ...codeSol, taskClass: 'code', catalog, replacement: codeCtx }});

            // Switch local daemon from A to B (A-admit / B-launch): every new-class Sol backup stops on request AND brief.
            writeFileSync(daemonIdFile, 'srv-daemon-b\\n');
            for (const [tPath, cls, lane, res] of admittedBackups) {{
              const updated = readTask(tPath);
              assert.throws(() => buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Sol Backup', initialPrompt: 'Check',
                workspace: {{ workspaceId: 'wks-a', cwd: '/tmp/wt-a', serverId: 'srv-daemon-a' }},
                capabilities: piCaps, route: res.route, task: updated, taskClass: cls, target: targetA,
              }}), /local daemon is not the backup receipt target/);
              assert.throws(() => buildDelegatedBrief({{
                role: 'worker', route: res.route, reason: res.reason, brief: 'Check',
                task: updated, lane, taskClass: cls, catalog,
              }}), /local daemon is not the backup receipt target/);
            }}
            // Legacy code Sol backup still launches without target or workspace.serverId even on daemon B.
            const legacyTask = readTask(opnTaskPath);
            const legacyReq = buildManagedWorkerRequest({{
              taskId: legacyTask.id, lane: 'opn-code-sol', title: 'Legacy Code Backup', initialPrompt: 'Build',
              workspace: {{ workspaceId: 'wks-legacy', cwd: '/tmp/wt-legacy' }},
              capabilities: piCaps, route: codeSol.route, task: legacyTask, taskClass: 'code',
            }});
            assert.equal(legacyReq.request.provider, 'pi/fleet/gpt-6.2-sol');

            // Mapped remote server claimed as local is refused at admission and at launch/brief.
            writeFileSync(daemonIdFile, 'srv-remote-example\\n');
            const mappedAdmit = await resolveWorkerRoute({{
              taskClass: 'plan', catalog,
              replacement: {{ task: readTask(opnTaskPath), lane: 'mapped-sol', target: targetMapped, unavailable: unavailableFor(targetMapped) }},
            }});
            assert.equal(mappedAdmit.route.model, 'fleet/claude-fable-5-1');
            const forgedMappedRoute = {{
              role: 'worker', source: 'pace-backup', kind: 'plan', model: 'fleet/gpt-6.2-sol', effort: 'medium',
              fastMode: false, reason: paceBackupReason('plan'),
              receipt: {{
                target: 'srv-remote-example', task: legacyTask.id, lane: 'forged-mapped',
                placement: managedWorkerNames({{ taskId: legacyTask.id, lane: 'forged-mapped' }}).branchName,
              }},
            }};
            const forgedTask = {{
              ...legacyTask,
              routes: {{ ...legacyTask.routes, 'forged-mapped': {{ route: forgedMappedRoute, reason: forgedMappedRoute.reason, recorded_at: nowIso }} }},
            }};
            assert.throws(() => buildManagedWorkerRequest({{
              taskId: forgedTask.id, lane: 'forged-mapped', title: 'Mapped Backup', initialPrompt: 'Check',
              workspace: {{ workspaceId: 'wks-m', cwd: '/tmp/wt-m', serverId: 'srv-remote-example' }},
              capabilities: piCaps, route: forgedMappedRoute, task: forgedTask, taskClass: 'plan', target: targetMapped,
            }}), /local daemon is not the backup receipt target/);
            assert.throws(() => buildDelegatedBrief({{
              role: 'worker', route: forgedMappedRoute, reason: forgedMappedRoute.reason, brief: 'Check',
              task: forgedTask, lane: 'forged-mapped', taskClass: 'plan', catalog,
            }}), /local daemon is not the backup receipt target/);
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch and holds are macOS-only")
    def test_decision_393a_390a_devin_first_ladder_holds_expiry_probes_and_unknown_fail_closed(self):
        root = Path(self.task).parent.parent
        scratch_home = root / "scratch-home-393a"
        opc_dir = scratch_home / ".config" / "opc"
        opc_dir.mkdir(parents=True, mode=0o700)
        fake_bin = root / "fake-bin-393a"
        fake_bin.mkdir()
        paseo_shim = fake_bin / "paseo"
        paseo_shim.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = daemon ] && [ \"$2\" = status ]; then\n"
            "  printf '{\"localDaemon\":\"running\",\"serverId\":\"srv-local-393a\"}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "if [ \"$1\" = inspect ] && [ \"$2\" = allowed-pm-393a ]; then\n"
            "  printf '{\"Id\":\"allowed-pm-393a\",\"ParentAgentId\":null}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n"
        )
        paseo_shim.chmod(0o755)
        ui_task = self.ui_task()
        env = {
            **os.environ,
            "HOME": str(scratch_home),
            "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "PASEO_AGENT_ID": "allowed-pm-393a",
        }
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ chmodSync, existsSync, readFileSync, statSync, writeFileSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{
              buildDelegatedBrief, DEVIN_FIRST_SOURCE, OPUS_REPLACEMENT_RUNTIME, PACE_BACKUP_RUNTIME,
              REPLACEMENT_RUNTIME, replacementReason,
            }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{
              agyHoldsPath, agyQuotaPath, beginOppositeModelProbe, devinReadyPath, evaluateAgyQuotaProjection,
              readAgyQuotaProjectionHolds, readDevinReady, readModelHolds, readOppositeModelProbe,
              recordAgyQuotaHold, settleOppositeModelProbe,
            }} from {json.dumps((SCRIPTS / 'agy-holds.mjs').as_uri())};
            import {{ buildManagedWorkerRequest }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ isDevinFirstReady, recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const taskPath = {json.dumps(self.task)};
            const uiTaskPath = {json.dumps(ui_task)};
            const writeOwner = (path, obj, mode = 0o600) => {{
              writeFileSync(path, JSON.stringify(obj, null, 2) + '\\n', {{ mode }});
              chmodSync(path, mode);
            }};
            const now = Date.now();
            writeOwner(join(opcDir, 'routing.json'), {{
              replacementExcludedLaunchers: ['excluded-'],
              antigravityFallback: {{
                enabled: true,
                state: {{
                  off_pace: true,
                  as_of: new Date(now - 60_000).toISOString(),
                  expires_at: new Date(now + 3_600_000).toISOString(),
                }},
              }},
            }});

            const catalog = [
              ['claude-opus-5-5', 'Opus'],
              ['claude-fable-5-1', 'Fable'],
              ['gpt-6.2-sol', 'Sol'],
            ].map(([id, label]) => ({{ id: 'fleet/' + id, label, thinkingOptions: [{{ id: 'medium' }}, {{ id: 'high' }}] }}));
            const piCaps = {{ enabled: true, status: 'available', modes: [], models: catalog }};
            const target = {{ daemon: 'srv-local-393a', local: true, platform: 'darwin' }};
            const nowIso = new Date(now).toISOString();
            const proofFor = (model, at = nowIso) => ({{
              provider: 'agy-opc', extends: 'acp', model, thinking: 'high',
              mode: 'auto', sandboxed: true, write: true, target, verified_at: at,
            }});
            const agyCaps = model => ({{
              provider: 'agy-opc', enabled: true, status: 'available',
              models: [{{ id: model, thinkingOptions: [{{ id: 'high' }}] }}],
              modes: [{{ id: 'auto' }}],
              selectedModel: model,
              features: [{{ id: 'auto_accept', type: 'toggle', value: true }}],
              checked_at: new Date().toISOString(),
            }});

            // 1. Decision 399a/397c: Config-owned 0644 devin-ready.json (exact 180s window; never emits retry_at).
            const devinAsOf = new Date(now - 10_000).toISOString();
            const devinExpires = new Date(now - 10_000 + 180_000).toISOString();
            const secretRetryAt = new Date(now + 90_000).toISOString();
            const devinReady = {{ ready: true, as_of: devinAsOf, expires_at: devinExpires, retry_at: secretRetryAt }};
            assert.equal(isDevinFirstReady(devinReady, now), true);
            for (const bad of [
              null,
              {{ ...devinReady, ready: false }},
              {{ ...devinReady, expires_at: new Date(now - 10_000 + 120_000).toISOString() }}, // wrong window (!= 180s)
              {{ ready: true, as_of: new Date(now - 200_000).toISOString(), expires_at: new Date(now - 20_000).toISOString(), retry_at: null }}, // expired
              {{ ...devinReady, retry_at: 'not-a-date' }},
              {{ ...devinReady, extra: true }},
            ]) {{
              assert.equal(isDevinFirstReady(bad, now), false);
            }}
            // Real 0644 file read path (group-writable fails closed).
            writeOwner(devinReadyPath(), devinReady, 0o664);
            assert.equal(readDevinReady(now), false);
            writeOwner(devinReadyPath(), devinReady, 0o644);
            assert.equal(readDevinReady(now), true);
            for (const [tPath, cls, lane] of [[taskPath, 'code', 'devin-code'], [taskPath, 'plan', 'devin-plan'], [uiTaskPath, 'ui-design', 'devin-ui']]) {{
              const task = readTask(tPath);
              const res = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement: {{ task, lane, target }} }});
              assert.equal(res.route.source, DEVIN_FIRST_SOURCE);
              assert.equal(res.route.model, 'fleet/claude-opus-5-5');
              assert.equal(res.provider, 'pi/fleet/claude-opus-5-5');
              assert.equal(JSON.stringify(res).includes(secretRetryAt), false, 'must never emit retry_at');
              recordWorkerRoute(tPath, {{ lane, ...res, taskClass: cls, catalog, replacement: {{ task, lane, target }} }});
              const updated = readTask(tPath);
              const req = buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Devin', initialPrompt: 'Work',
                workspace: {{ workspaceId: 'wks-d', cwd: '/tmp/wt-d', serverId: target.daemon }},
                capabilities: piCaps, route: res.route, task: updated, taskClass: cls,
              }});
              assert.equal(req.request.provider, 'pi/fleet/claude-opus-5-5');
              assert.equal(req.request.labels['opc.route-source'], 'devin-first');
              const brief = buildDelegatedBrief({{ role: 'worker', route: res.route, reason: res.reason, brief: 'Go', task: updated, lane, taskClass: cls, catalog }});
              assert.equal(brief.includes(secretRetryAt), false);
              if (cls !== 'code') assert.match(brief, /Read-only lane:/);
            }}
            // Unready devin-ready.json fails closed to normal 393a / 390a precedence.
            writeOwner(devinReadyPath(), {{ ...devinReady, ready: false }}, 0o644);
            assert.equal(readDevinReady(now), false);

            // 1b. Decision 399a: Config-owned 0644 agy-quota.json projection (distinct 'Gemini Models' vs 'Claude and GPT models' groups, left <= 0.02 & now < reset;
            // past reset cannot hold; unreadable/stale/invalid/ok:false ignored cleanly).
            const futureReset = new Date(now + 1_800_000).toISOString();
            const pastReset = new Date(now - 5_000).toISOString();
            const quotaBase = {{
              ok: true, as_of: new Date(now - 15_000).toISOString(), expires_at: new Date(now + 180_000).toISOString(),
              reason: 'synthetic-secret-reason-do-not-leak',
              buckets: {{
                'gemini-5h': {{ group: 'Gemini Models', left: 0.02, reset: futureReset }},
                'gemini-weekly': {{ group: 'Gemini Models', left: 0.5, reset: futureReset }},
                '3p-5h': {{ group: 'Claude and GPT models', left: 0.8, reset: futureReset }},
                '3p-weekly': {{ group: 'Claude and GPT models', left: 0.01, reset: pastReset }}, // past reset cannot hold 3p!
              }},
            }};
            writeOwner(agyQuotaPath(), quotaBase, 0o644);
            assert.deepEqual(readAgyQuotaProjectionHolds(now), {{
              [REPLACEMENT_RUNTIME.model]: true,
              [OPUS_REPLACEMENT_RUNTIME.model]: false,
            }});
            // While gemini-5h <= 0.02 holds NH only, forced code advances to OH (distinct groups!) without leaking quota values/reason!
            const projOhRes = await resolveWorkerRoute({{
              taskClass: 'code', catalog,
              replacement: {{ task: readTask(taskPath), lane: 'proj-oh', target, proof: [proofFor(REPLACEMENT_RUNTIME.model), proofFor(OPUS_REPLACEMENT_RUNTIME.model)] }},
            }});
            assert.equal(projOhRes.route.model, OPUS_REPLACEMENT_RUNTIME.model);
            assert.equal(JSON.stringify(projOhRes).includes('synthetic-secret-reason'), false);
            assert.equal(JSON.stringify(projOhRes).includes(futureReset), false);
            // Invalid / ok:false / mismatched group / stale / group-writable agy-quota.json is ignored (both unheld).
            assert.deepEqual(evaluateAgyQuotaProjection({{ ...quotaBase, ok: false }}, now), {{ [REPLACEMENT_RUNTIME.model]: false, [OPUS_REPLACEMENT_RUNTIME.model]: false }});
            assert.deepEqual(evaluateAgyQuotaProjection({{ ...quotaBase, expires_at: new Date(now - 1_000).toISOString() }}, now), {{ [REPLACEMENT_RUNTIME.model]: false, [OPUS_REPLACEMENT_RUNTIME.model]: false }});
            assert.deepEqual(evaluateAgyQuotaProjection({{ ...quotaBase, buckets: {{ ...quotaBase.buckets, 'gemini-5h': {{ group: 'wrong', left: 0, reset: futureReset }} }} }}, now), {{ [REPLACEMENT_RUNTIME.model]: false, [OPUS_REPLACEMENT_RUNTIME.model]: false }});
            // Legacy short labels ('gemini' / '3p') are not the Config producer's exact strings and are ignored.
            assert.deepEqual(evaluateAgyQuotaProjection({{ ...quotaBase, buckets: {{ ...quotaBase.buckets, 'gemini-5h': {{ group: 'gemini', left: 0, reset: futureReset }} }} }}, now), {{ [REPLACEMENT_RUNTIME.model]: false, [OPUS_REPLACEMENT_RUNTIME.model]: false }});
            writeOwner(agyQuotaPath(), {{ ...quotaBase, ok: false }}, 0o644);

            // 2. When Devin is NOT ready: Decision 390a keeps plan/ui on Fable High even while forced off pace.
            for (const [tPath, cls, lane] of [[taskPath, 'plan', 'plan-stay'], [uiTaskPath, 'ui-design', 'ui-stay']]) {{
              const task = readTask(tPath);
              const res = await resolveWorkerRoute({{
                taskClass: cls, catalog,
                replacement: {{ task, lane, target, proof: [proofFor(REPLACEMENT_RUNTIME.model), proofFor(OPUS_REPLACEMENT_RUNTIME.model)] }},
              }});
              assert.equal(res.route.model, 'fleet/claude-fable-5-1');
            }}

            // 3. Decision 393a forced code ladder: NH first; missing/stale proof fails closed (no OH, no Sol, no silent Opus).
            const baseTask = readTask(taskPath);
            await assert.rejects(() => resolveWorkerRoute({{
              taskClass: 'code', catalog, replacement: {{ task: baseTask, lane: 'code-no-proof', target }},
            }}), /fresh verified proof is missing or stale; refusing to fall back or invent Sol/);
            // OH-only proof without NH hold/unavailable fails closed (never skips NH on unknown availability).
            await assert.rejects(() => resolveWorkerRoute({{
              taskClass: 'code', catalog,
              replacement: {{ task: baseTask, lane: 'code-oh-only', target, proof: proofFor(OPUS_REPLACEMENT_RUNTIME.model) }},
            }}), /gemini-4-neon-high.*missing or stale/);
            // Both proofs ready -> picks NH first!
            const nhCtx = {{
              task: baseTask, lane: 'code-nh', target,
              proof: [proofFor(REPLACEMENT_RUNTIME.model), proofFor(OPUS_REPLACEMENT_RUNTIME.model)],
            }};
            const nhRes = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: nhCtx }});
            assert.equal(nhRes.route.source, 'replacement');
            assert.equal(nhRes.route.model, REPLACEMENT_RUNTIME.model);
            assert.equal(nhRes.nextFallback, 'agy-opc/claude-opus-5-5-high');

            // 4. Unsafe quota evidence fails closed and writes no hold.
            const validResetOffset = new Date(now + 3_600_000).toISOString().replace('Z', '+00:00');
            for (const badEvent of [
              {{ provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target, source: 'assistant', terminal: true, kind: 'individual_quota_reached', reset_at: validResetOffset }},
              {{ provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target, source: 'provider-terminal', terminal: false, kind: 'individual_quota_reached', reset_at: validResetOffset }},
              {{ provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target, source: 'provider-terminal', terminal: true, message: 'Temporary 503 overload at ' + validResetOffset }},
              {{ provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target, source: 'provider-terminal', terminal: true, kind: 'individual_quota_reached', reset_at: '2026-11-25 10:00:00' }},
              {{ provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target, source: 'provider-terminal', terminal: true, kind: 'individual_quota_reached', reset_at: new Date(now - 5_000).toISOString() }},
              {{ provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target, source: 'provider-terminal', terminal: true, kind: 'individual_quota_reached', reset_at: new Date(now + 10 * 24 * 3_600_000).toISOString() }},
            ]) {{
              assert.throws(() => recordAgyQuotaHold(badEvent, {{ now }}), /self-labelled caller objects are refused/);
            }}
            assert.equal(existsSync(agyHoldsPath()), false);

            // 5. Even a well-formed self-labelled 'Individual quota reached' object is refused (only an authenticated daemon
            // fetchAgent snapshot of the exact recorded lane Worker records; covered in the remote test). Seed the normalized
            // hold a prior authentic event would have written.
            const rawSecretMsg = 'Individual quota reached for acct-secret-label resets ' + validResetOffset + ' (used 100%)';
            assert.throws(() => recordAgyQuotaHold({{
              provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target,
              source: 'provider-terminal', terminal: true, message: rawSecretMsg,
            }}, {{ now }}), /self-labelled caller objects are refused/);
            assert.equal(existsSync(agyHoldsPath()), false);
            writeOwner(agyHoldsPath(), {{ schema: 1, probes: {{}}, holds: {{ [target.daemon]: {{
              [REPLACEMENT_RUNTIME.model]: {{ recorded_at: new Date(now).toISOString(), until: new Date(now + 3_600_000).toISOString() }},
            }} }} }});
            const holdsRaw = readFileSync(agyHoldsPath(), 'utf8');
            assert.equal(statSync(agyHoldsPath()).mode & 0o777, 0o600);
            assert.equal(holdsRaw.includes('acct-secret-label'), false);
            assert.equal(holdsRaw.includes('used 100%'), false);
            assert.equal(holdsRaw.includes('Individual quota reached'), false);

            // Bounded first-occurrence opposite-model probe: allowed once, no retry loops, records only booleans/timestamps.
            const started = beginOppositeModelProbe({{ target, fromModel: REPLACEMENT_RUNTIME.model }}, {{ now }});
            assert.equal(started.allowed, true);
            const retryInFlight = beginOppositeModelProbe({{ target, fromModel: REPLACEMENT_RUNTIME.model }}, {{ now }});
            assert.equal(retryInFlight.allowed, false);
            assert.equal(retryInFlight.reason, 'already-probed');
            const settled = settleOppositeModelProbe({{ target, fromModel: REPLACEMENT_RUNTIME.model, outcome: 'succeeded' }}, {{ now: now + 5_000 }});
            assert.equal(settled.relation, 'separate');
            assert.equal(readOppositeModelProbe(target.daemon, 'nh_to_oh'), 'separate');
            const retryAfter = beginOppositeModelProbe({{ target, fromModel: REPLACEMENT_RUNTIME.model }}, {{ now: now + 10_000 }});
            assert.equal(retryAfter.allowed, false);
            // Unheld opposite model cannot start a probe (only on actual quota event).
            const noHoldProbe = beginOppositeModelProbe({{ target, fromModel: OPUS_REPLACEMENT_RUNTIME.model }}, {{ now: now + 10_000 }});
            assert.equal(noHoldProbe.allowed, false);
            assert.equal(noHoldProbe.reason, 'no-active-source-hold');

            // 6. While NH hold is active: NH is deterministically skipped even with NH proof; OH is selected!
            // Missing OH proof still fails closed (never invents Sol).
            await assert.rejects(() => resolveWorkerRoute({{
              taskClass: 'code', catalog, replacement: {{ task: baseTask, lane: 'code-oh-missing', target, proof: proofFor(REPLACEMENT_RUNTIME.model) }},
            }}), /claude-opus-5-5-high.*missing or stale/);
            const ohCtx = {{
              task: baseTask, lane: 'code-oh', target,
              proof: [proofFor(REPLACEMENT_RUNTIME.model), proofFor(OPUS_REPLACEMENT_RUNTIME.model)],
            }};
            const ohRes = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: ohCtx }});
            assert.equal(ohRes.route.source, 'replacement');
            assert.equal(ohRes.route.model, OPUS_REPLACEMENT_RUNTIME.model);
            assert.equal(ohRes.reason, replacementReason('code', OPUS_REPLACEMENT_RUNTIME.model));
            recordWorkerRoute(taskPath, {{ lane: 'code-oh', ...ohRes, taskClass: 'code', catalog, replacement: ohCtx }});
            const ohTask = readTask(taskPath);
            const ohReq = buildManagedWorkerRequest({{
              taskId: ohTask.id, lane: 'code-oh', title: 'OH Worker', initialPrompt: 'Build',
              workspace: {{ workspaceId: 'wks-oh', cwd: '/tmp/wt-oh', serverId: target.daemon }},
              capabilities: agyCaps(OPUS_REPLACEMENT_RUNTIME.model), route: ohRes.route, task: ohTask, taskClass: 'code', target,
            }});
            assert.equal(ohReq.request.provider, 'agy-opc/claude-opus-5-5-high');
            assert.deepEqual(ohReq.request.settings, {{ thinkingOptionId: 'high', features: {{ auto_accept: true }}, modeId: 'auto' }});

            // 7. When BOTH NH and OH are held (or NH held + OH positively not-serving): Sol Medium Fast off admits!
            const solCtx = {{
              task: readTask(taskPath), lane: 'code-sol-after-both', target,
              unavailable: {{ provider: 'agy-opc', target, checked_at: nowIso, finding: 'not-serving', model: OPUS_REPLACEMENT_RUNTIME.model }},
            }};
            const solRes = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: solCtx }});
            assert.equal(solRes.route.source, 'pace-backup');
            assert.equal(solRes.route.model, PACE_BACKUP_RUNTIME.model);
            assert.equal(solRes.route.effort, 'medium');
            assert.equal(solRes.route.fastMode, false);

            // 8. Hold expiry: once until <= now, NH is preferred again immediately!
            const expiredDoc = readModelHolds();
            expiredDoc.holds[target.daemon][REPLACEMENT_RUNTIME.model] = {{
              recorded_at: new Date(now - 7_200_000).toISOString(),
              until: new Date(now - 1_000).toISOString(),
            }};
            writeOwner(agyHoldsPath(), expiredDoc);
            const afterExpiry = await resolveWorkerRoute({{
              taskClass: 'code', catalog,
              replacement: {{
                task: readTask(taskPath), lane: 'code-after-expiry', target,
                proof: [proofFor(REPLACEMENT_RUNTIME.model), proofFor(OPUS_REPLACEMENT_RUNTIME.model)],
              }},
            }});
            assert.equal(afterExpiry.route.model, REPLACEMENT_RUNTIME.model);

            // 9. Corrupt/unsafe hold file fails closed!
            chmodSync(agyHoldsPath(), 0o644);
            assert.equal(readModelHolds(), null);
            await assert.rejects(() => resolveWorkerRoute({{
              taskClass: 'code', catalog,
              replacement: {{ task: readTask(taskPath), lane: 'code-bad-holds', target, proof: proofFor(REPLACEMENT_RUNTIME.model) }},
            }}), /unsafe or malformed/);
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch and holds are macOS-only")
    def test_live_cli_main_pm_opn_browser_parity_and_launch_boundary_guard(self):
        root = Path(self.task).parent.parent
        scratch_home = root / "scratch-home-live"
        opc_dir = scratch_home / ".config" / "opc"
        opc_dir.mkdir(parents=True, mode=0o700)
        fake_bin = root / "fake-bin-live"
        fake_bin.mkdir()
        paseo_shim = fake_bin / "paseo"
        paseo_shim.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = daemon ] && [ \"$2\" = status ]; then\n"
            "  printf '{\"localDaemon\":\"running\",\"serverId\":\"srv-live-local\"}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "if [ \"$1\" = inspect ] && [ \"$2\" = live-pm-0001 ]; then\n"
            "  printf '{\"Id\":\"live-pm-0001\",\"ParentAgentId\":null}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n"
        )
        paseo_shim.chmod(0o755)
        ui_task = self.ui_task()
        env = {
            **os.environ,
            "HOME": str(scratch_home),
            "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "PASEO_AGENT_ID": "live-pm-0001",
        }
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ spawnSync }} from 'node:child_process';
            import {{ chmodSync, existsSync, writeFileSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ OPUS_REPLACEMENT_RUNTIME, REPLACEMENT_RUNTIME, selectWorkerRoute }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ recordAgyQuotaHold }} from {json.dumps((SCRIPTS / 'agy-holds.mjs').as_uri())};
            import {{ buildInPlaceWorkerRequest, buildManagedWorkerRequest }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const taskPath = {json.dumps(self.task)};
            const uiTaskPath = {json.dumps(ui_task)};
            const routeCli = {json.dumps(str(SCRIPTS / 'route.mjs'))};
            const catalogPath = {json.dumps(str(root / 'live-catalog.json'))};
            const writeOwner = (path, obj) => {{
              writeFileSync(path, JSON.stringify(obj, null, 2) + '\\n', {{ mode: 0o600 }});
              chmodSync(path, 0o600);
            }};
            const catalog = [
              ['claude-opus-5-5', 'Opus'],
              ['claude-fable-5-1', 'Fable'],
              ['gpt-6.2-sol', 'Sol'],
              ['gpt-6.1-terra', 'Terra'],
              ['gpt-6-luna', 'Luna'],
            ].map(([id, label]) => ({{ id: 'fleet/' + id, label, thinkingOptions: [{{ id: 'low' }}, {{ id: 'medium' }}, {{ id: 'high' }}, {{ id: 'xhigh' }}] }}));
            writeFileSync(catalogPath, JSON.stringify(catalog));
            const piCaps = {{ enabled: true, status: 'available', modes: [], models: catalog }};
            const target = {{ daemon: 'srv-live-local', local: true, platform: 'darwin' }};
            const now = Date.now();
            const runCli = args => spawnSync(process.execPath, [routeCli, ...args], {{ encoding: 'utf8' }});

            // 1. Bare CLI under forced switch: 1 human line on stderr + JSON on stdout; creates no files, consumes no turns.
            writeOwner(join(opcDir, 'routing.json'), {{
              replacementExcludedLaunchers: [],
              antigravityFallback: {{
                enabled: true,
                state: {{ off_pace: true, as_of: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() }},
              }},
            }});
            const forcedCode = runCli(['--class', 'code', '--catalog', catalogPath]);
            assert.equal(forcedCode.status, 0, forcedCode.stderr);
            assert.equal(forcedCode.stderr.trim().split('\\n').length, 1);
            assert.match(forcedCode.stderr, /route code: agy-opc\\/gemini-4-neon-high effort=high fast=off host=srv-live-local next=agy-opc\\/claude-opus-5-5-high \\(proof required\\)/);
            const forcedJson = JSON.parse(forcedCode.stdout);
            assert.equal(forcedJson.provider, 'agy-opc/gemini-4-neon-high');
            assert.equal(forcedJson.proofRequired, true);
            assert.equal(existsSync(join(opcDir, 'code-alternation.json')), false);
            assert.equal(existsSync(join(opcDir, 'agy-model-holds.json')), false);

            // Recording bare forced code via CLI fails closed (no silent Opus, no invented Sol).
            const forcedRec = runCli(['--class', 'code', '--catalog', catalogPath, '--task', taskPath, '--lane', 'bad-forced-cli']);
            assert.notEqual(forcedRec.status, 0);
            assert.match(forcedRec.stderr, /requires exact bound target\\/workspace admission/);

            // 2. main-pm resolver-only policy: default Claude Opus High even off pace, exact ladder, honors NH hold.
            const mainPm1 = runCli(['--class', 'main-pm']);
            assert.equal(mainPm1.status, 0, mainPm1.stderr);
            const mainPm1Json = JSON.parse(mainPm1.stdout);
            assert.equal(mainPm1Json.provider, 'pi/fleet/claude-opus-5-5');
            assert.equal(mainPm1Json.effort, 'high');
            assert.equal(mainPm1Json.fast, false);
            assert.equal(mainPm1Json.nextFallback, 'agy-opc/gemini-4-neon-high');
            // Owner 404b correction: main PMs fall back only to Neon High or Opus High (agy NH, Cursor NH, agy OH); never Sol.
            assert.deepEqual(mainPm1Json.fallbackChain.map(s => s.step), ['agy-neon', 'cursor-neon', 'agy-opus']);
            assert.deepEqual(mainPm1Json.fallbackChain.map(s => s.provider),
              ['agy-opc/gemini-4-neon-high', 'cursor/gemini-4-neon', 'agy-opc/claude-opus-5-5-high']);
            assert.equal(JSON.stringify(mainPm1Json).includes('gpt-6.2-sol'), false);
            // main-pm cannot be recorded as a Worker lane.
            assert.notEqual(runCli(['--class', 'main-pm', '--task', taskPath, '--lane', 'bad-pm']).status, 0);

            // Record NH hold -> bare code advances to agy OH and main-pm nextFallback skips NH to agy OH!
            assert.throws(() => recordAgyQuotaHold({{
              provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target,
              source: 'provider-terminal', terminal: true, kind: 'individual_quota_reached',
              reset_at: new Date(now + 3_600_000).toISOString(),
            }}, {{ now }}), /self-labelled caller objects are refused/);
            writeOwner(join(opcDir, 'agy-model-holds.json'), {{ schema: 1, probes: {{}}, holds: {{ [target.daemon]: {{
              [REPLACEMENT_RUNTIME.model]: {{ recorded_at: new Date(now).toISOString(), until: new Date(now + 3_600_000).toISOString() }},
            }} }} }});
            const forcedAfterNH = JSON.parse(runCli(['--class', 'code', '--catalog', catalogPath]).stdout);
            assert.equal(forcedAfterNH.provider, 'agy-opc/claude-opus-5-5-high');
            assert.equal(forcedAfterNH.nextFallback, 'pi/fleet/gpt-6.2-sol');
            const mainPm2 = JSON.parse(runCli(['--class', 'main-pm']).stdout);
            assert.equal(mainPm2.provider, 'pi/fleet/claude-opus-5-5');
            assert.equal(mainPm2.nextFallback, 'cursor/gemini-4-neon');

            // 3. opn-browser resolves deterministically to native Codex gpt-6.2-sol low Fast on (owner 412a); browser stays
            // native Codex Sol low Fast on.
            const opnBr = runCli(['--class', 'opn-browser', '--catalog', catalogPath]);
            assert.equal(opnBr.status, 0, opnBr.stderr);
            assert.match(opnBr.stderr, /route opn-browser: codex\\/gpt-6.2-sol effort=low fast=on host=srv-live-local next=none/);
            const opnBrJson = JSON.parse(opnBr.stdout);
            assert.equal(opnBrJson.provider, 'codex/gpt-6.2-sol');
            assert.equal(opnBrJson.model, 'gpt-6.2-sol');
            assert.equal(opnBrJson.effort, 'low');
            assert.equal(opnBrJson.fast, true);
            assert.deepEqual(opnBrJson.route, {{ role: 'worker', source: 'owner-explicit', model: 'gpt-6.2-sol', effort: 'low', fastMode: true }});
            const codexBr = JSON.parse(runCli(['--class', 'browser', '--catalog', catalogPath]).stdout);
            assert.equal(codexBr.provider, 'codex/gpt-6.2-sol');
            assert.equal(codexBr.effort, 'low');
            assert.equal(codexBr.fast, true);
            // opn-browser cannot be recorded as a managed Worker lane.
            assert.notEqual(runCli(['--class', 'opn-browser', '--catalog', catalogPath, '--task', taskPath, '--lane', 'bad-opn-br']).status, 0);
            assert.equal(readTask(taskPath).routes?.['bad-opn-br'], undefined);
            // No caller override changes the opn-browser model, thinking, or Fast.
            for (const owner of [['--owner-model', 'fleet/claude-opus-5-5', '--owner-effort', 'high'],
              ['--owner-model', 'gpt-6.2-sol', '--owner-effort', 'high', '--owner-fast', 'off'], ['--owner-fast', 'off']]) {{
              const refused = runCli(['--class', 'opn-browser', '--catalog', catalogPath, ...owner]);
              assert.notEqual(refused.status, 0);
              assert.match(refused.stderr, /opn-browser takes no --owner-model, --owner-effort, or --owner-fast/);
            }}
            // A catalog that does not serve exactly one gpt-6.2-sol at low thinking stops the lane.
            const noLowPath = {json.dumps(str(root / 'live-catalog-nolow.json'))};
            writeFileSync(noLowPath, JSON.stringify(catalog.map(row => ({{ ...row, thinkingOptions: [{{ id: 'high' }}] }}))));
            const noLow = runCli(['--class', 'opn-browser', '--catalog', noLowPath]);
            assert.notEqual(noLow.status, 0);
            assert.match(noLow.stderr, /exactly one native Codex gpt-6.2-sol at low thinking/);
            // A recorded lane keeps its recorded route: a recorded browser lane replays unchanged and is never relabeled.
            const recBr = runCli(['--class', 'browser', '--catalog', catalogPath, '--task', taskPath, '--lane', 'rec-br']);
            assert.equal(recBr.status, 0, recBr.stderr);
            const recBrRoute = readTask(taskPath).routes['rec-br'];
            assert.equal(runCli(['--class', 'opn-browser', '--catalog', catalogPath, '--task', taskPath, '--lane', 'rec-br']).status === 0, false);
            const recReplay = runCli(['--task', taskPath, '--lane', 'rec-br']);
            assert.equal(recReplay.status, 0, recReplay.stderr);
            assert.deepEqual(JSON.parse(recReplay.stdout).route, recBrRoute.route);
            assert.equal(JSON.parse(recReplay.stdout).provider, 'codex/gpt-6.2-sol');
            assert.deepEqual(readTask(taskPath).routes['rec-br'], recBrRoute);

            // In-process launch boundary: the validated in-place builder makes exactly the native Codex request in the PM's
            // workspace and refuses every caller override of model, thinking, Fast, or workspace.
            await assert.rejects(resolveWorkerRoute({{ taskClass: 'opn-browser', catalog, lane: 'opn-br',
              ownerRoute: {{ role: 'worker', source: 'owner-explicit', model: 'fleet/gpt-6.2-sol', effort: 'high', fastMode: false }} }}),
              /opn-browser takes no owner-named route/);
            const opnLive = await resolveWorkerRoute({{ taskClass: 'opn-browser', catalog, lane: 'opn-br' }});
            assert.equal(opnLive.provider, 'codex/gpt-6.2-sol');
            const codexCaps = {{ enabled: true, status: 'available',
              modes: [{{ id: 'read-only' }}, {{ id: 'full-access', isUnattended: true }}],
              models: [{{ id: 'gpt-6.2-sol', thinkingOptions: [{{ id: 'low' }}, {{ id: 'high' }}] }}, {{ id: 'gpt-6.1-terra', thinkingOptions: [{{ id: 'low' }}] }}] }};
            const opnBuild = (extra, route = opnLive.route) => buildInPlaceWorkerRequest({{ title: 'Browse', initialPrompt: 'Go', route,
              taskClass: 'opn-browser', capabilities: codexCaps, lane: 'opn-br', ...extra }});
            const opnReq = opnBuild({{}});
            assert.equal(opnReq.modeId, 'full-access');
            assert.deepEqual(opnReq.request, {{
              title: 'Browse', provider: 'codex/gpt-6.2-sol', initialPrompt: 'Go', notifyOnFinish: true,
              settings: {{ thinkingOptionId: 'low', features: {{ fast_mode: true }}, modeId: 'full-access' }},
              labels: {{ role: 'worker', 'opc.worker-lane': 'opn-br', 'opc.route-source': 'opn-browser' }},
            }});
            assert.equal(Object.hasOwn(opnReq.request, 'workspaceId'), false);
            assert.equal(Object.hasOwn(opnReq.request, 'serverId'), false);
            assert.equal(opnBuild({{ provider: 'codex/gpt-6.2-sol', agentSettings: {{ thinkingOptionId: 'low', features: {{ fast_mode: true }} }} }})
              .request.provider, 'codex/gpt-6.2-sol');
            for (const [extra, pattern] of [
              [{{ provider: 'pi/fleet/gpt-6.2-sol' }}, /not what this lane's validated route maps to \\(codex\\/gpt-6.2-sol\\)/],
              [{{ provider: 'codex/gpt-6.1-terra' }}, /not what this lane's validated route maps to/],
              [{{ agentSettings: {{ thinkingOptionId: 'high', features: {{ fast_mode: true }} }} }}, /no caller override changes them/],
              [{{ agentSettings: {{ thinkingOptionId: 'low', features: {{ fast_mode: false }} }} }}, /no caller override changes them/],
              [{{ agentSettings: {{ thinkingOptionId: 'low' }} }}, /no caller override changes them/],
              [{{ workspaceId: 'wks-other' }}, /opn-browser Worker takes no workspaceId/],
              [{{ workspace: {{ workspaceId: 'wks-other', cwd: '/tmp/x' }} }}, /opn-browser Worker takes no workspace/],
              [{{ cwd: '/tmp/x' }}, /opn-browser Worker takes no cwd/],
              [{{ serverId: 'srv-remote' }}, /opn-browser Worker takes no serverId/],
              [{{ target: {{ daemon: 'srv-remote', local: false, platform: 'linux' }} }}, /stay in the local PM workspace/],
              [{{ surface: 'codex' }}, /takes no surface or nativeAuthorization/],
              [{{ nativeAuthorization: 'owner-explicit' }}, /takes no surface or nativeAuthorization/],
              [{{ workerLabels: {{ 'opc.service-tier': 'standard' }} }}, /cannot set opc.service-tier/],
              [{{ capabilities: piCaps }}, /exactly one unattended full-permission mode/],
              [{{ capabilities: {{ ...codexCaps, models: [{{ id: 'gpt-6.2-sol', thinkingOptions: [{{ id: 'high' }}] }}] }} }},
                /exactly one native Codex gpt-6.2-sol at low thinking/],
            ]) assert.throws(() => opnBuild(extra), pattern);
            // Pasted, other-lane, or other-class routes never launch as opn-browser.
            assert.throws(() => opnBuild({{}}, structuredClone(opnLive.route)), /pasted, remembered, or stale routes are refused/);
            assert.throws(() => opnBuild({{ lane: 'opn-other' }}), /bound to lane opn-br/);
            const brLive = await resolveWorkerRoute({{ taskClass: 'browser', catalog, lane: 'opn-br' }});
            assert.throws(() => opnBuild({{}}, brLive.route), /live resolved route is for browser, not opn-browser/);

            // 4. Launch boundary guard: pasted remembered default objects (code/plan/research/ui-design) are refused on
            // fresh bound launches & records, while live-resolved and recorded/replayed lanes succeed.
            const task = readTask(taskPath);
            for (const [cls, pasted] of [
              ['code', selectWorkerRoute({{ taskKind: 'code', catalog }})],
              ['plan', selectWorkerRoute({{ taskKind: 'plan', catalog }})],
              ['research', selectWorkerRoute({{ taskKind: 'research', catalog }})],
            ]) {{
              assert.throws(() => buildManagedWorkerRequest({{
                taskId: task.id, lane: 'pasted-' + cls, title: 'Pasted', initialPrompt: 'Go',
                workspace: {{ workspaceId: 'wks-p', cwd: '/tmp/wt-p' }}, capabilities: piCaps,
                route: pasted, task, taskClass: cls,
              }}), /live route from resolveWorkerRoute; pasted, remembered, or stale routes are refused/);
              assert.throws(() => recordWorkerRoute(taskPath, {{
                lane: 'pasted-' + cls, route: pasted, reason: pasted.reason, taskClass: cls, catalog,
              }}), /live route from resolveWorkerRoute; pasted, remembered, or stale routes are refused/);
            }}
            const uiTask = readTask(uiTaskPath);
            const pastedUi = selectWorkerRoute({{ taskKind: 'ui-design', catalog }});
            assert.throws(() => buildManagedWorkerRequest({{
              taskId: uiTask.id, lane: 'pasted-ui', title: 'Pasted UI', initialPrompt: 'Design',
              workspace: {{ workspaceId: 'wks-u', cwd: '/tmp/wt-u' }}, capabilities: piCaps,
              route: pastedUi, task: uiTask, taskClass: 'ui-design',
            }}), /live route from resolveWorkerRoute/);
            // Exact launch binding: a taskless/laneless or other-lane live resolution never launches a bound lane.
            for (const cls of ['plan', 'research']) {{
              for (const unbound of [
                await resolveWorkerRoute({{ taskClass: cls, catalog }}),
                await resolveWorkerRoute({{ taskClass: cls, catalog, task, lane: 'other-' + cls }}),
              ]) {{
                assert.throws(() => buildManagedWorkerRequest({{
                  taskId: task.id, lane: 'live-' + cls, title: 'Live', initialPrompt: 'Go',
                  workspace: {{ workspaceId: 'wks-l', cwd: '/tmp/wt-l' }}, capabilities: piCaps,
                  route: unbound.route, task, taskClass: cls,
                }}), /bound to (this exact task and lane|lane other-)/);
              }}
            }}
            // Live-resolved fresh plan and research bound to this exact task and lane succeed at launch boundary!
            for (const cls of ['plan', 'research']) {{
              const live = await resolveWorkerRoute({{ taskClass: cls, catalog, task, lane: 'live-' + cls }});
              const req = buildManagedWorkerRequest({{
                taskId: task.id, lane: 'live-' + cls, title: 'Live', initialPrompt: 'Go',
                workspace: {{ workspaceId: 'wks-l', cwd: '/tmp/wt-l' }}, capabilities: piCaps,
                route: live.route, task, taskClass: cls,
              }});
              assert.equal(req.request.provider, live.provider);
            }}

            // 5. 359 parity: subscription Opus (even) -> agy side NH-held so OH (odd); missing proof fails closed without consuming turn!
            writeOwner(join(opcDir, 'routing.json'), {{
              replacementExcludedLaunchers: [],
              antigravityFallback: {{
                enabled: false,
                state: {{ off_pace: false, as_of: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() }},
              }},
            }});
            // Bare parity CLI peeks without creating code-alternation.json.
            const parityPeek0 = JSON.parse(runCli(['--class', 'code', '--catalog', catalogPath]).stdout);
            assert.equal(parityPeek0.provider, 'pi/fleet/claude-opus-5-5');
            assert.equal(existsSync(join(opcDir, 'code-alternation.json')), false);
            // Turn 0: subscription Opus.
            const nowIso = new Date(now).toISOString();
            const ohProof = {{ provider: 'agy-opc', extends: 'acp', model: OPUS_REPLACEMENT_RUNTIME.model, thinking: 'high', mode: 'auto', sandboxed: true, write: true, target, verified_at: nowIso }};
            const p0Ctx = {{ task: readTask(taskPath), lane: 'parity-0', target, proof: ohProof }};
            const p0 = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: p0Ctx }});
            assert.equal(p0.route.source, 'task-default');
            recordWorkerRoute(taskPath, {{ lane: 'parity-0', ...p0, taskClass: 'code', catalog, replacement: p0Ctx }});
            // Turn 1: agy turn — bare CLI peek shows agy OH (since NH is held) without consuming.
            const parityPeek1 = JSON.parse(runCli(['--class', 'code', '--catalog', catalogPath]).stdout);
            assert.equal(parityPeek1.provider, 'agy-opc/claude-opus-5-5-high');
            assert.equal(parityPeek1.proofRequired, true);
            // Missing OH proof fails closed without consuming turn 1!
            await assert.rejects(() => resolveWorkerRoute({{
              taskClass: 'code', catalog, replacement: {{ task: readTask(taskPath), lane: 'parity-1-no-proof', target }},
            }}), /turn not consumed/);
            // With OH proof -> admits agy OH on turn 1!
            const p1Ctx = {{ task: readTask(taskPath), lane: 'parity-1', target, proof: ohProof }};
            const p1 = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: p1Ctx }});
            assert.equal(p1.route.source, 'replacement');
            assert.equal(p1.route.model, OPUS_REPLACEMENT_RUNTIME.model);
            assert.match(p1.reason, /alternation/);
            recordWorkerRoute(taskPath, {{ lane: 'parity-1', ...p1, taskClass: 'code', catalog, replacement: p1Ctx }});
            // Turn 2: back to subscription Opus.
            const p2Ctx = {{ task: readTask(taskPath), lane: 'parity-2', target, proof: ohProof }};
            const p2 = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: p2Ctx }});
            assert.equal(p2.route.source, 'task-default');
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch and remote reader are macOS-only")
    def test_remote_agy_ladder_and_bound_remote_sol_backup(self):
        root = Path(self.task).parent.parent
        scratch_home = root / "scratch-home-remote-393a"
        opc_dir = scratch_home / ".config" / "opc"
        opc_dir.mkdir(parents=True, mode=0o700)
        pkg_root = root / "fake-cli-393a"
        (pkg_root / "bin").mkdir(parents=True)
        (pkg_root / "dist" / "utils").mkdir(parents=True)
        (pkg_root / "package.json").write_text(json.dumps({"name": "@getpaseo/cli", "version": "0.15.3"}))
        (pkg_root / "dist" / "utils" / "client.js").write_text(
            "export async function connectToDaemon({ target }) {\n"
            "  const host = target?.host;\n"
            "  const serverId = host === 'ssh://armed-393a' ? 'srv-armed-393a' : 'srv-other';\n"
            "  const agyReady = process.env.FAKE_REMOTE_AGY_READY !== '0';\n"
            "  return {\n"
            "    getLastServerInfoMessage: () => ({ serverId, version: '0.15.3' }),\n"
            "    fetchWorkspaces: async () => ({\n"
            "      entries: JSON.parse(process.env.FAKE_REMOTE_WORKSPACES || '[]'),\n"
            "      pageInfo: { hasMore: false },\n"
            "    }),\n"
            "    getProvidersSnapshot: async () => ({\n"
            "      entries: [\n"
            "        ...(agyReady ? [{ provider: 'agy-opc', enabled: true, status: 'ready' }] : []),\n"
            "        { provider: 'pi', enabled: true, status: 'ready' },\n"
            "      ],\n"
            "    }),\n"
            "    listProviderModels: async (provider) => ({\n"
            "      models: provider === 'pi'\n"
            "        ? [{ id: 'fleet/gpt-6.2-sol', label: 'Sol', thinkingOptions: [{ id: 'medium' }, { id: 'high' }] }]\n"
            "        : [\n"
            "            { id: 'gemini-4-neon-high', thinkingOptions: [{ id: 'high' }] },\n"
            "            { id: 'claude-opus-5-5-high', thinkingOptions: [{ id: 'high' }] },\n"
            "          ],\n"
            "    }),\n"
            "    listProviderModes: async (provider) => ({ modes: provider === 'pi' ? [] : [{ id: 'auto' }] }),\n"
            "    listProviderFeatures: async ({ model }) => ({ features: [{ id: 'auto_accept', type: 'toggle', value: true }], model }),\n"
            "    fetchAgent: async ({ agentId }) => {\n"
            "      const agents = JSON.parse(process.env.FAKE_REMOTE_AGENTS || '{}');\n"
            "      return Object.hasOwn(agents, agentId) ? { agent: agents[agentId], project: null } : null;\n"
            "    },\n"
            "    close: async () => {},\n"
            "  };\n"
            "}\n"
        )
        paseo_real = pkg_root / "bin" / "paseo"
        paseo_real.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = inspect ] && [ \"$2\" = allowed-pm-rem ]; then\n"
            "  printf '{\"Id\":\"allowed-pm-rem\",\"ParentAgentId\":null}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n"
        )
        paseo_real.chmod(0o755)
        fake_bin = root / "fake-remote-bin-393a"
        fake_bin.mkdir()
        (fake_bin / "paseo").symlink_to(paseo_real)
        env = {
            **os.environ,
            "HOME": str(scratch_home),
            "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "PASEO_AGENT_ID": "allowed-pm-rem",
        }
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ chmodSync, writeFileSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ OPUS_REPLACEMENT_RUNTIME, REPLACEMENT_RUNTIME }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ recordAgyQuotaHold }} from {json.dumps((SCRIPTS / 'agy-holds.mjs').as_uri())};
            import {{ buildManagedWorkerRequest, managedWorkerNames, validateManagedWorkerLaunch }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ readAuthenticatedAgentTerminal, readRemoteAgyTarget }} from {json.dumps((SCRIPTS / 'remote-target.mjs').as_uri())};
            import {{ recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ readTask, recordWorkerLaunch }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const taskPath = {json.dumps(self.task)};
            const writeOwner = (path, obj) => {{
              writeFileSync(path, JSON.stringify(obj, null, 2) + '\\n', {{ mode: 0o600 }});
              chmodSync(path, 0o600);
            }};
            const now = Date.now(), nowIso = new Date(now).toISOString();
            writeOwner(join(opcDir, 'routing.json'), {{
              replacementExcludedLaunchers: [],
              antigravityFallback: {{
                enabled: true,
                state: {{ off_pace: true, as_of: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() }},
              }},
            }});
            writeOwner(join(opcDir, 'neon-remote-targets.json'), {{
              targets: {{ 'srv-armed-393a': {{ endpoint: 'ssh://armed-393a', platform: 'linux', state: 'armed' }} }},
            }});
            const catalog = [
              {{ id: 'fleet/claude-opus-5-5', label: 'Opus', thinkingOptions: [{{ id: 'high' }}] }},
              {{ id: 'fleet/gpt-6.2-sol', label: 'Sol', thinkingOptions: [{{ id: 'medium' }}] }},
            ];
            const remoteTarget = {{ daemon: 'srv-armed-393a', local: false, platform: 'linux' }};
            const proofFor = model => ({{
              provider: 'agy-opc', extends: 'acp', model, thinking: 'high',
              mode: 'auto', sandboxed: true, write: true, target: remoteTarget, verified_at: nowIso,
            }});

            // 1. Remote serving both NH & OH prefers NH first.
            const att1 = await readRemoteAgyTarget({{ serverId: 'srv-armed-393a' }});
            const r1 = await resolveWorkerRoute({{
              taskClass: 'code', catalog,
              replacement: {{ task: readTask(taskPath), lane: 'rem-nh', target: remoteTarget, remote: att1, proof: [proofFor(REPLACEMENT_RUNTIME.model), proofFor(OPUS_REPLACEMENT_RUNTIME.model)] }},
            }});
            assert.equal(r1.route.model, REPLACEMENT_RUNTIME.model);

            // 2. Record Mac hold for remote NH only from an authenticated daemon fetchAgent snapshot of the exact
            // recorded lane Worker -> advances to remote agy OH! Self-labelled caller objects are always refused.
            const nhCtx = {{ task: readTask(taskPath), lane: 'rem-nh', target: remoteTarget, remote: att1, proof: [proofFor(REPLACEMENT_RUNTIME.model), proofFor(OPUS_REPLACEMENT_RUNTIME.model)] }};
            const r1b = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: nhCtx }});
            recordWorkerRoute(taskPath, {{ lane: 'rem-nh', ...r1b, taskClass: 'code', catalog, replacement: nhCtx }});
            for (const forged of [
              {{ provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, target: remoteTarget, source: 'provider-terminal', terminal: true, kind: 'individual_quota_reached', reset_at: new Date(now + 3_600_000).toISOString() }},
              {{ target: remoteTarget, terminal: {{ serverId: 'srv-armed-393a', local: false, platform: 'linux', agentId: 'agt-rem-nh-1', provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model, labels: {{}}, readAt: Date.now() }} }},
            ]) {{
              assert.throws(() => recordAgyQuotaHold(forged, {{ now }}), /self-labelled caller objects are refused/);
            }}
            const resetIso = new Date(now + 3_600_000).toISOString().replace('Z', '+00:00');
            const nhLabels = {{ role: 'worker', 'opc.worker-task': readTask(taskPath).id, 'opc.worker-lane': 'rem-nh', 'opc.route-source': 'replacement' }};
            process.env.FAKE_REMOTE_AGENTS = JSON.stringify({{
              'agt-rem-nh-1': {{ id: 'agt-rem-nh-1', status: 'error', provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model,
                lastError: 'Individual quota reached for acct-secret-label; resets ' + resetIso, labels: nhLabels, workspaceId: 'wks-rem-nh' }},
              'agt-rem-other': {{ id: 'agt-rem-other', status: 'error', provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model,
                lastError: 'Individual quota reached; resets ' + resetIso, labels: {{ ...nhLabels, 'opc.worker-lane': 'someone-else' }} }},
            }});
            const otherTerm = await readAuthenticatedAgentTerminal({{ target: remoteTarget, agentId: 'agt-rem-other' }});
            assert.equal(JSON.stringify(otherTerm).includes('Individual quota'), false);
            assert.throws(() => recordAgyQuotaHold({{ target: remoteTarget, terminal: otherTerm, task: readTask(taskPath), lane: 'rem-nh' }}, {{ now: Date.now() }}), /do not match recorded task lane/);
            const nhTerm = await readAuthenticatedAgentTerminal({{ target: remoteTarget, agentId: 'agt-rem-nh-1' }});
            assert.throws(() => recordAgyQuotaHold({{ target: remoteTarget, terminal: nhTerm }}, {{ now: Date.now() }}), /both task record and lane required/);
            assert.throws(() => recordAgyQuotaHold({{ target: {{ ...remoteTarget, platform: 'win32' }}, terminal: nhTerm, task: readTask(taskPath), lane: 'rem-nh' }}, {{ now: Date.now() }}), /self-labelled caller objects are refused/);
            assert.throws(() => recordAgyQuotaHold({{ target: remoteTarget, terminal: nhTerm, task: readTask(taskPath), lane: 'rem-nh' }}, {{ now: Date.now() }}), /not a Worker launch recorded on this lane/);
            recordWorkerLaunch(taskPath, {{ lane: 'rem-nh', agentId: 'agt-rem-nh-1', workspaceId: 'wks-rem-nh' }});
            const recNH = recordAgyQuotaHold({{ target: remoteTarget, terminal: nhTerm, task: readTask(taskPath), lane: 'rem-nh' }}, {{ now: Date.now() }});
            assert.equal(recNH.recorded, true);
            assert.equal(recNH.target, 'srv-armed-393a');
            assert.equal(recNH.model, REPLACEMENT_RUNTIME.model);
            const ohCtx = {{
              task: readTask(taskPath), lane: 'rem-oh', target: remoteTarget, remote: att1,
              proof: proofFor(OPUS_REPLACEMENT_RUNTIME.model),
            }};
            const r2 = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: ohCtx }});
            assert.equal(r2.route.model, OPUS_REPLACEMENT_RUNTIME.model);
            recordWorkerRoute(taskPath, {{ lane: 'rem-oh', ...r2, taskClass: 'code', catalog, replacement: ohCtx }});
            const ohNames = managedWorkerNames({{ taskId: readTask(taskPath).id, lane: 'rem-oh' }});
            process.env.FAKE_REMOTE_WORKSPACES = JSON.stringify([{{
              id: 'wks-rem-oh', workspaceKind: 'worktree', worktreeSlug: ohNames.worktreeSlug,
              workspaceDirectory: '/tmp/rem-oh', gitRuntime: {{ currentBranch: ohNames.branchName }}, archivingAt: null,
            }}]);
            const ohLaunchAtt = await readRemoteAgyTarget({{
              serverId: 'srv-armed-393a',
              workspace: {{ workspaceId: 'wks-rem-oh', worktreeSlug: ohNames.worktreeSlug, branchName: ohNames.branchName }},
              model: OPUS_REPLACEMENT_RUNTIME.model,
            }});
            const ohReq = buildManagedWorkerRequest({{
              taskId: readTask(taskPath).id, lane: 'rem-oh', title: 'Remote OH', initialPrompt: 'Build',
              workspace: {{ workspaceId: 'wks-rem-oh', cwd: '/tmp/rem-oh', serverId: 'srv-armed-393a' }},
              route: r2.route, task: readTask(taskPath), taskClass: 'code', target: remoteTarget, remote: ohLaunchAtt,
            }});
            assert.equal(ohReq.request.provider, 'agy-opc/claude-opus-5-5-high');
            assert.equal(ohReq.request.serverId, 'srv-armed-393a');

            // 3. Remote agy-opc unavailable (authenticated SDK with allowBackup: true) -> securely bound remote Pi Sol medium!
            process.env.FAKE_REMOTE_AGY_READY = '0';
            const downAtt = await readRemoteAgyTarget({{ serverId: 'srv-armed-393a', allowBackup: true }});
            const solCtx = {{ task: readTask(taskPath), lane: 'rem-sol', target: remoteTarget, remote: downAtt }};
            const r3 = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: solCtx }});
            assert.equal(r3.route.source, 'pace-backup');
            assert.equal(r3.route.model, 'fleet/gpt-6.2-sol');
            assert.equal(r3.route.effort, 'medium');
            assert.equal(r3.route.receipt.target, 'srv-armed-393a');
            recordWorkerRoute(taskPath, {{ lane: 'rem-sol', ...r3, taskClass: 'code', catalog, replacement: solCtx }});
            const solNames = managedWorkerNames({{ taskId: readTask(taskPath).id, lane: 'rem-sol' }});
            process.env.FAKE_REMOTE_WORKSPACES = JSON.stringify([{{
              id: 'wks-rem-sol', workspaceKind: 'worktree', worktreeSlug: solNames.worktreeSlug,
              workspaceDirectory: '/tmp/rem-sol', gitRuntime: {{ currentBranch: solNames.branchName }}, archivingAt: null,
            }}]);
            const solLaunchAtt = await readRemoteAgyTarget({{
              serverId: 'srv-armed-393a',
              workspace: {{ workspaceId: 'wks-rem-sol', worktreeSlug: solNames.worktreeSlug, branchName: solNames.branchName }},
              allowBackup: true,
            }});
            // Caller capabilities refused on remote backup!
            assert.throws(() => buildManagedWorkerRequest({{
              taskId: readTask(taskPath).id, lane: 'rem-sol', title: 'Remote Sol', initialPrompt: 'Build',
              workspace: {{ workspaceId: 'wks-rem-sol', cwd: '/tmp/rem-sol', serverId: 'srv-armed-393a' }},
              capabilities: solLaunchAtt.piCapabilities,
              route: r3.route, task: readTask(taskPath), taskClass: 'code', target: remoteTarget, remote: solLaunchAtt,
            }}), /takes no caller capabilities/);
            const solReq = buildManagedWorkerRequest({{
              taskId: readTask(taskPath).id, lane: 'rem-sol', title: 'Remote Sol', initialPrompt: 'Build',
              workspace: {{ workspaceId: 'wks-rem-sol', cwd: '/tmp/rem-sol', serverId: 'srv-armed-393a' }},
              route: r3.route, task: readTask(taskPath), taskClass: 'code', target: remoteTarget, remote: solLaunchAtt,
            }});
            assert.equal(solReq.request.provider, 'pi/fleet/gpt-6.2-sol');
            assert.deepEqual(solReq.request.settings, {{ thinkingOptionId: 'medium' }});
            assert.equal(solReq.request.labels['opc.service-tier'], 'standard');
            assert.equal(solReq.request.serverId, 'srv-armed-393a');
            const launched = validateManagedWorkerLaunch(solReq, {{ agentId: 'agt-rem-sol', workspaceId: 'wks-rem-sol', serverId: 'srv-armed-393a' }});
            assert.equal(launched.agentId, 'agt-rem-sol');
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

    def fake_remote_sdk(self, name, agent_id, agy_ready_default="1"):
        """A stock-shaped fake @getpaseo/cli 0.15.3 SDK on PATH (connectToDaemon by ssh alias), with a fake `paseo inspect`
        for the launcher chain (Cwd from FAKE_PM_CWD) and a fake usage report (FAKE_CURSOR_USED_PCT, FAKE_CURSOR_USAGE_AGE_S).
        Returns (scratch_home opc dir, env)."""
        root = Path(self.task).parent.parent
        scratch_home = root / f"scratch-home-{name}"
        opc_dir = scratch_home / ".config" / "opc"
        opc_dir.mkdir(parents=True, mode=0o700)
        pkg_root = root / f"fake-cli-{name}"
        (pkg_root / "bin").mkdir(parents=True)
        (pkg_root / "dist" / "utils").mkdir(parents=True)
        (pkg_root / "package.json").write_text(json.dumps({"name": "@getpaseo/cli", "version": "0.15.3"}))
        (pkg_root / "dist" / "utils" / "client.js").write_text(
            "const ids = { 'ssh://example-linux': 'srv-cursor-linux', 'ssh://example-win': 'srv-example-win', 'ssh://example-other-linux': 'srv-linux' };\n"
            "export async function connectToDaemon({ target }) {\n"
            "  const env = process.env;\n"
            "  const serverId = target?.kind === 'instance' && target.home === env.HOME + '/.paseo' ? 'srv-mac-local' : ids[target?.host] ?? 'srv-other';\n"
            f"  const agyReady = (env.FAKE_REMOTE_AGY_READY ?? '{agy_ready_default}') !== '0';\n"
            "  const cursorReady = env.FAKE_REMOTE_CURSOR_READY !== '0';\n"
            "  return {\n"
            "    getLastServerInfoMessage: () => ({ serverId, version: '0.15.3', features: { usageSources: true } }),\n"
            "    fetchWorkspaces: async () => ({ entries: JSON.parse(env.FAKE_REMOTE_WORKSPACES || '[]'), pageInfo: { hasMore: false } }),\n"
            "    getProvidersSnapshot: async () => ({ entries: [\n"
            "      ...(agyReady ? [{ provider: 'agy-opc', enabled: true, status: 'ready' }] : []),\n"
            "      ...(cursorReady ? [{ provider: 'cursor', enabled: true, status: 'ready' }] : []),\n"
            "      { provider: 'pi', enabled: true, status: 'ready' },\n"
            "    ] }),\n"
            "    listProviderModels: async (provider) => ({ models: provider === 'pi'\n"
            "      ? [{ id: 'fleet/gpt-6.2-sol', label: 'Sol', thinkingOptions: [{ id: 'medium' }, { id: 'high' }] }]\n"
            "      : provider === 'cursor' ? [{ id: 'gemini-4-neon', label: 'Neon' }]\n"
            "      : [{ id: 'gemini-4-neon-high', thinkingOptions: [{ id: 'high' }] }, { id: 'claude-opus-5-5-high', thinkingOptions: [{ id: 'high' }] }] }),\n"
            "    listProviderModes: async (provider) => ({ modes: provider === 'pi' ? []\n"
            "      : provider === 'cursor' ? [{ id: 'force', isUnattended: true }] : [{ id: 'auto' }] }),\n"
            "    listProviderFeatures: async ({ model }) => ({ features: [{ id: 'auto_accept', type: 'toggle', value: true }], model }),\n"
            "    listUsageReports: async () => env.FAKE_CURSOR_USED_PCT === undefined ? { reports: [] } : { reports: [{\n"
            "      id: 'rep-1', account: { label: 'acct-secret-label' }, sourceId: 'cursor', sourceLabel: 'Cursor',\n"
            "      fetchedAt: new Date().toISOString(),\n"
            "      successfulAt: new Date(Date.now() - 1000 * Number(env.FAKE_CURSOR_USAGE_AGE_S ?? 5)).toISOString(),\n"
            "      report: { status: 'available', windows: [{ id: 'plan_usage', label: 'Total', usedPct: Number(env.FAKE_CURSOR_USED_PCT),\n"
            "        resetsAt: '2026-12-01T00:00:00Z' }] } }] },\n"
            "    fetchAgent: async ({ agentId }) => {\n"
            "      const agents = JSON.parse(env.FAKE_REMOTE_AGENTS || '{}');\n"
            "      return Object.hasOwn(agents, agentId) ? { agent: agents[agentId], project: null } : null;\n"
            "    },\n"
            "    close: async () => {},\n"
            "  };\n"
            "}\n"
        )
        paseo_real = pkg_root / "bin" / "paseo"
        paseo_real.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = daemon ] && [ \"$2\" = status ]; then\n"
            "  printf '{\"localDaemon\":\"running\",\"serverId\":\"srv-mac-local\"}\\n'\n"
            "  exit 0\n"
            "fi\n"
            f"if [ \"$1\" = inspect ] && [ \"$2\" = {agent_id} ]; then\n"
            "  if [ -n \"$FAKE_PM_CWD\" ]; then\n"
            f"    printf '{{\"Id\":\"{agent_id}\",\"ParentAgentId\":null,\"Cwd\":\"%s\"}}\\n' \"$FAKE_PM_CWD\"\n"
            "  else\n"
            f"    printf '{{\"Id\":\"{agent_id}\",\"ParentAgentId\":null}}\\n'\n"
            "  fi\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n"
        )
        paseo_real.chmod(0o755)
        fake_bin = root / f"fake-bin-{name}"
        fake_bin.mkdir()
        (fake_bin / "paseo").symlink_to(paseo_real)
        env = {**os.environ, "HOME": str(scratch_home), "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
               "PASEO_AGENT_ID": agent_id}
        for key in ("FAKE_CURSOR_USED_PCT", "FAKE_PM_CWD", "FAKE_REMOTE_AGY_READY", "FAKE_REMOTE_CURSOR_READY", "PASEO_HOME", "PASEO_HOST"):
            env.pop(key, None)
        return opc_dir, env

    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch and remote reader are macOS-only")
    def test_decision_398a_bounded_cursor_host_overflow_and_exclusions(self):
        opc_dir, env = self.fake_remote_sdk("398a", "allowed-pm-398a", agy_ready_default="0")
        root = Path(self.task).parent.parent
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ chmodSync, mkdirSync, writeFileSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ buildDelegatedBrief, CURSOR_OVERFLOW_SOURCE }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ buildManagedWorkerRequest, managedWorkerNames, validateManagedWorkerLaunch }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ cursorHostServerId, readRemoteAgyTarget }} from {json.dumps((SCRIPTS / 'remote-target.mjs').as_uri())};
            import {{ recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ createTask, readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const repoDir = {json.dumps(str(self.repo))};
            const rootDir = {json.dumps(str(root))};
            const writeOwner = (path, obj) => {{
              writeFileSync(path, JSON.stringify(obj, null, 2) + '\\n', {{ mode: 0o600 }});
              chmodSync(path, 0o600);
            }};
            const now = Date.now(), nowIso = new Date(now).toISOString();
            const setRouting = (excluded = ['synthetic-pay-proj']) => writeOwner(join(opcDir, 'routing.json'), {{
              replacementExcludedLaunchers: [],
              cursorExcludedProjects: excluded,
              antigravityFallback: {{
                enabled: true,
                state: {{ off_pace: true, as_of: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString() }},
              }},
            }});
            setRouting();
            // The Cursor host is named only by the private mapping: the one entry carrying "cursorOverflow": true.
            const setTargets = (flags = {{ 'srv-cursor-linux': true }}, states = {{}}) => writeOwner(join(opcDir, 'neon-remote-targets.json'), {{ targets: Object.fromEntries([
              ['srv-cursor-linux', 'ssh://example-linux', 'linux'], ['srv-example-win', 'ssh://example-win', 'win32'],
              ['srv-linux', 'ssh://example-other-linux', 'linux'],
            ].map(([id, endpoint, platform]) => [id, {{ endpoint, platform, state: states[id] ?? 'armed',
              ...(Object.hasOwn(flags, id) ? {{ cursorOverflow: flags[id] }} : {{}}) }}])) }});
            setTargets();
            assert.equal(cursorHostServerId(), 'srv-cursor-linux');
            const catalog = [
              {{ id: 'fleet/claude-opus-5-5', label: 'Opus', thinkingOptions: [{{ id: 'high' }}] }},
              {{ id: 'fleet/claude-fable-5-1', label: 'Fable', thinkingOptions: [{{ id: 'high' }}] }},
              {{ id: 'fleet/gpt-6.2-sol', label: 'Sol', thinkingOptions: [{{ id: 'medium' }}] }},
            ];
            const cursorHost = {{ daemon: 'srv-cursor-linux', local: false, platform: 'linux' }};
            process.env.FAKE_PM_CWD = '/Users/example/Projects/app-pm';
            const mkTask = (name, extra = {{}}) => {{
              const dir = join(rootDir, 'run-' + name);
              mkdirSync(dir);
              return createTask({{ workingDirectory: repoDir, runDirectory: dir, owner: 'test', ...extra }}).taskPath;
            }};
            const cleanTaskPath = mkTask('clean', {{ paymentData: false }});
            const payTaskPath = mkTask('pay', {{ paymentData: true }});
            const unsetTaskPath = mkTask('unset');
            const uiTaskPath = mkTask('ui-398a', {{ ui: true, paymentData: false }});
            const resolveOn = async (taskPath, lane, target, remote, extra = {{}}, taskClass = 'code') => resolveWorkerRoute({{
              taskClass, catalog, replacement: {{ task: readTask(taskPath), lane, target, remote, ...extra }},
            }});

            // 1. No authenticated quota preflight on the Cursor host: the eligible lane fails closed (never jumps to unauthorized Sol).
            const noUsage = await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux' }});
            assert.equal(JSON.stringify(noUsage).includes('acct-secret-label'), false);
            await assert.rejects(() => resolveOn(cleanTaskPath, 'bounded-no-proof', cursorHost, noUsage), /cursor\\/gemini-4-neon.*missing or stale/);
            // A stale successful reading is no preflight either.
            process.env.FAKE_CURSOR_USED_PCT = '40';
            process.env.FAKE_CURSOR_USAGE_AGE_S = '3600';
            await assert.rejects(async () => resolveOn(cleanTaskPath, 'bounded-stale', cursorHost, await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux' }})),
              /cursor\\/gemini-4-neon.*missing or stale/);
            process.env.FAKE_CURSOR_USAGE_AGE_S = '5';

            // 2. Fresh authenticated plan_usage below the policy max -> cursor/gemini-4-neon on the configured Cursor host BEFORE Sol.
            const att = await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux' }});
            // Only the usage code and its last-success time leave the reader; no figure, window, or account label.
            assert.equal(att.cursorUsage, 'ok');
            assert.equal(Number.isFinite(att.cursorUsageAt), true);
            assert.equal(/usedPct|plan_usage|acct-secret-label|:40[,}}]/.test(JSON.stringify(att)), false);
            const curCtx = {{ task: readTask(cleanTaskPath), lane: 'bounded-fix', target: cursorHost, remote: att }};
            const curRes = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: curCtx }});
            assert.equal(curRes.route.source, CURSOR_OVERFLOW_SOURCE);
            assert.equal(curRes.provider, 'cursor/gemini-4-neon');
            assert.equal(curRes.effort, null);
            assert.equal(curRes.fast, false);
            assert.equal(curRes.nextFallback, 'pi/fleet/gpt-6.2-sol');
            recordWorkerRoute(cleanTaskPath, {{ lane: 'bounded-fix', ...curRes, taskClass: 'code', catalog, replacement: curCtx }});
            const names = managedWorkerNames({{ taskId: readTask(cleanTaskPath).id, lane: 'bounded-fix' }});
            const taskRemote = readTask(cleanTaskPath).repository.remote;
            const hostWorktree = (extra = {{}}, git = {{ remoteUrl: taskRemote }}) => {{
              process.env.FAKE_REMOTE_WORKSPACES = JSON.stringify([{{
                id: 'wks-cur-1', workspaceKind: 'worktree', worktreeSlug: names.worktreeSlug, projectRootPath: '/home/user/Projects/app',
                workspaceDirectory: '/tmp/rem-cur', gitRuntime: {{ currentBranch: names.branchName, ...git }}, archivingAt: null, ...extra,
              }}]);
            }};
            hostWorktree();
            const workspace = {{ workspaceId: 'wks-cur-1', worktreeSlug: names.worktreeSlug, branchName: names.branchName }};
            const curLaunchAtt = await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux', workspace, cursorLaunch: true }});
            const launchReq = (route, remote, extra = {{}}) => buildManagedWorkerRequest({{
              taskId: readTask(cleanTaskPath).id, lane: 'bounded-fix', title: 'Cursor Overflow', initialPrompt: 'Fix bug',
              workspace: {{ workspaceId: 'wks-cur-1', cwd: '/tmp/rem-cur', serverId: 'srv-cursor-linux' }},
              route, task: readTask(cleanTaskPath), taskClass: 'code', target: cursorHost, remote, ...extra,
            }});
            const curReq = launchReq(curRes.route, curLaunchAtt);
            assert.equal(curReq.request.provider, 'cursor/gemini-4-neon');
            assert.deepEqual(curReq.request.settings, {{ modeId: 'force' }});
            assert.equal(curReq.request.labels.lane, 'cursor-overflow');
            assert.equal(curReq.request.labels['opc.route-source'], 'cursor-overflow');
            assert.equal(curReq.request.serverId, 'srv-cursor-linux');
            assert.equal(validateManagedWorkerLaunch(curReq, {{ agentId: 'agt-cur-1', workspaceId: 'wks-cur-1', serverId: 'srv-cursor-linux' }}).agentId, 'agt-cur-1');
            assert.match(buildDelegatedBrief({{ role: 'worker', route: curRes.route, reason: curRes.reason, brief: 'Fix bug',
              task: readTask(cleanTaskPath), lane: 'bounded-fix', taskClass: 'code', catalog }}), /300k context, Fast off, no Max or Auto/);
            // Caller capabilities never stand in for the authenticated Cursor launch read.
            assert.throws(() => launchReq(curRes.route, curLaunchAtt, {{ capabilities: curLaunchAtt.cursorCapabilities }}), /takes no caller capabilities/);

            // 3. Blocker 5: caller-provided preflight is refused, and Cursor never runs off the configured Cursor host.
            const callerPreflight = {{ bounded: true, preflight: 'available', target: cursorHost, checked_at: nowIso,
              context: '300k', fastMode: false, maxMode: false, autoMode: false }};
            const withCaller = await resolveOn(cleanTaskPath, 'caller-preflight', cursorHost, att, {{ cursor: callerPreflight }});
            assert.notEqual(withCaller.route.source, CURSOR_OVERFLOW_SOURCE);
            for (const [serverId, target] of [['srv-example-win', {{ daemon: 'srv-example-win', local: false, platform: 'win32' }}],
                                              ['srv-linux', {{ daemon: 'srv-linux', local: false, platform: 'linux' }}]]) {{
              await assert.rejects(() => readRemoteAgyTarget({{ serverId, workspace, cursorLaunch: true }}), /configured Cursor host entry/);
              const offHost = await resolveOn(cleanTaskPath, 'off-host-' + serverId, target, await readRemoteAgyTarget({{ serverId, allowBackup: true }}));
              assert.equal(offHost.route.source, 'pace-backup', serverId);
            }}
            // A flag on a win32 or held entry, two flagged entries, or a flag that is not true: no Cursor host (fails closed).
            for (const [flags, states] of [
              [{{ 'srv-example-win': true }}, {{}}],
              [{{ 'srv-cursor-linux': true }}, {{ 'srv-cursor-linux': 'held' }}],
              [{{ 'srv-cursor-linux': true, 'srv-linux': true }}, {{}}],
              [{{ 'srv-cursor-linux': false }}, {{}}],
            ]) {{
              setTargets(flags, states);
              assert.equal(cursorHostServerId(), null, JSON.stringify(flags));
              for (const serverId of ['srv-cursor-linux', 'srv-example-win', 'srv-linux']) {{
                await assert.rejects(() => readRemoteAgyTarget({{ serverId, workspace, cursorLaunch: true }}), /configured Cursor host entry|not an armed entry/);
              }}
              if (states['srv-cursor-linux'] == null && flags['srv-cursor-linux'] !== false) {{
                // An earlier reading made while it was the Cursor host admits no Cursor now; a fresh read has no Cursor step.
                const noHost = await resolveOn(cleanTaskPath, 'no-host-' + Object.keys(flags).length, cursorHost, att);
                assert.equal(noHost.route.source, 'pace-backup');
                await assert.rejects(() => readRemoteAgyTarget({{ serverId: 'srv-cursor-linux' }}), /agy-opc enabled and ready/);
              }}
            }}
            setTargets();

            // 4. Ineligible lanes (payment_data true or unset, main lane, plan/UI) never use Cursor; they pass to Sol.
            for (const [tPath, cls, lane, extra] of [
              [payTaskPath, 'code', 'pay-lane', {{}}],
              [unsetTaskPath, 'code', 'unset-lane', {{}}],
              [cleanTaskPath, 'code', 'main', {{}}],
              [cleanTaskPath, 'plan', 'plan-no-cur', {{ fableUnavailable: {{ provider: 'pi', model: 'fleet/claude-fable-5-1', target: cursorHost, checked_at: nowIso, finding: 'not-serving' }} }}],
              [uiTaskPath, 'ui-design', 'ui-no-cur', {{ fableUnavailable: {{ provider: 'pi', model: 'fleet/claude-fable-5-1', target: cursorHost, checked_at: nowIso, finding: 'not-serving' }} }}],
            ]) {{
              const res = await resolveOn(tPath, lane, cursorHost, att, extra, cls);
              assert.equal(res.route.source, 'pace-backup', `expected Sol backup (skipping Cursor) for ${{cls}}/${{lane}}`);
            }}

            // 5. Project exclusion: matched against the authenticated ancestry (live git origin, real checkout, and every
            // launcher's daemon-reported Cwd); an unreadable ancestry fails closed; a recorded lane stops at rebuild.
            setRouting(['example/app']);
            assert.equal((await resolveOn(cleanTaskPath, 'excl-slug', cursorHost, att)).route.source, 'pace-backup');
            assert.throws(() => launchReq(curRes.route, curLaunchAtt), /payment-data sensitivity or project exclusion blocks Cursor/);
            setRouting(['synthetic-pay-proj']);
            process.env.FAKE_PM_CWD = '/Users/example/Projects/synthetic-pay-proj';
            assert.equal((await resolveOn(cleanTaskPath, 'excl-ancestry', cursorHost, att)).route.source, 'pace-backup');
            delete process.env.FAKE_PM_CWD;
            assert.equal((await resolveOn(cleanTaskPath, 'no-ancestry', cursorHost, att)).route.source, 'pace-backup');
            process.env.FAKE_PM_CWD = '/Users/example/Projects/app-pm';
            assert.equal(launchReq(curRes.route, curLaunchAtt).request.provider, 'cursor/gemini-4-neon');

            // 6. A fresh authenticated reading at or above the policy max is positive unavailability -> Sol.
            process.env.FAKE_CURSOR_USED_PCT = '99';
            const spent = await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux' }});
            const spentRes = await resolveOn(cleanTaskPath, 'spent-lane', cursorHost, spent);
            assert.equal(spentRes.route.source, 'pace-backup');
            assert.equal(spentRes.provider, 'pi/fleet/gpt-6.2-sol');
            const spentLaunch = await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux', workspace, cursorLaunch: true }});
            assert.throws(() => launchReq(curRes.route, spentLaunch), /passing quota preflight/);

            // 7. 44255e3 fix 4: the exclusion is also checked on the Cursor host worktree Cursor runs in, read on the authenticated
            // launch connection: its origin must be the task's, and its origin, path, and project root carry no excluded
            // token. A worktree with no readable origin or path stops; an empty exclusion list admits no Cursor.
            process.env.FAKE_CURSOR_USED_PCT = '40';
            const hostLaunch = () => readRemoteAgyTarget({{ serverId: 'srv-cursor-linux', workspace, cursorLaunch: true }});
            for (const [extra, git] of [
              [{{ projectRootPath: '/home/user/Projects/synthetic-pay-proj' }}, undefined],
              [{{ workspaceDirectory: '/home/user/Projects/synthetic-pay-proj/wt' }}, undefined],
              [{{}}, {{ remoteUrl: 'git@github.com:example/other.git' }}],
            ]) {{
              hostWorktree(extra, git);
              const remoteRead = await hostLaunch();
              assert.throws(() => buildManagedWorkerRequest({{ taskId: readTask(cleanTaskPath).id, lane: 'bounded-fix', title: 'C', initialPrompt: 'Go',
                workspace: {{ workspaceId: 'wks-cur-1', cwd: remoteRead.workspace.cwd, serverId: 'srv-cursor-linux' }}, route: curRes.route,
                task: readTask(cleanTaskPath), taskClass: 'code', target: cursorHost, remote: remoteRead }}), /Cursor host worktree is not the task's project/);
            }}
            for (const git of [{{}}, {{ remoteUrl: '' }}]) {{
              hostWorktree({{}}, git);
              await assert.rejects(hostLaunch, /no origin or project path/);
            }}
            hostWorktree();
            assert.equal(launchReq(curRes.route, await hostLaunch()).request.provider, 'cursor/gemini-4-neon');
            setRouting([]);
            assert.equal((await resolveOn(cleanTaskPath, 'empty-exclusions', cursorHost, await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux' }}))).route.source, 'pace-backup');
            assert.throws(() => launchReq(curRes.route, curLaunchAtt), /payment-data sensitivity or project exclusion blocks Cursor/);
            setRouting();

            // 8. 44255e3 fix 5: the preflight's age is re-checked where it is used. A reading that passes the max age after
            // it was read never authorizes Cursor at launch, and a stale spent reading never unlocks Sol at resolve.
            process.env.FAKE_CURSOR_USAGE_AGE_S = '599';
            const agingOk = await hostLaunch();
            assert.equal(agingOk.cursorUsage, 'ok');
            process.env.FAKE_CURSOR_USED_PCT = '99';
            const agingSpent = await readRemoteAgyTarget({{ serverId: 'srv-cursor-linux' }});
            assert.equal(agingSpent.cursorUsage, 'spent');
            const realNow = Date.now;
            try {{
              const base = realNow();
              Date.now = () => base + 3000;
              assert.throws(() => launchReq(curRes.route, agingOk), /passing quota preflight/);
              await assert.rejects(() => resolveOn(cleanTaskPath, 'aged-spent', cursorHost, agingSpent), /cursor\/gemini-4-neon.*missing or stale/);
            }} finally {{ Date.now = realNow; }}
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
    @unittest.skipUnless(sys.platform == "darwin", "OPC local routing switch and remote reader are macOS-only")
    def test_review_38d34a0_blocker_repros(self):
        opc_dir, env = self.fake_remote_sdk("repro", "allowed-pm-repro")
        done = run("node", "--input-type=module", "-e", f"""
            import assert from 'node:assert/strict';
            import {{ execFileSync, spawnSync }} from 'node:child_process';
            import {{ chmodSync, existsSync, readFileSync, writeFileSync }} from 'node:fs';
            import {{ join }} from 'node:path';
            import {{ buildDelegatedBrief, OPUS_REPLACEMENT_RUNTIME, REPLACEMENT_RUNTIME }} from {json.dumps((SCRIPTS / 'agent-routing.mjs').as_uri())};
            import {{ evaluateAgyQuotaProjection }} from {json.dumps((SCRIPTS / 'agy-holds.mjs').as_uri())};
            import {{ buildInPlaceWorkerRequest, buildManagedWorkerRequest, managedWorkerNames, validateManagedWorkerLaunch }} from {json.dumps((SCRIPTS / 'paseo-worker.mjs').as_uri())};
            import {{ readRemoteAgyTarget }} from {json.dumps((SCRIPTS / 'remote-target.mjs').as_uri())};
            import {{ recordWorkerRoute, resolveWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};

            const opcDir = {json.dumps(str(opc_dir))};
            const taskPath = {json.dumps(self.task)};
            const routeCli = {json.dumps(str(SCRIPTS / 'route.mjs'))};
            const holdsCli = {json.dumps(str(SCRIPTS / 'agy-holds.mjs'))};
            const write = (name, obj, mode = 0o600) => {{
              writeFileSync(join(opcDir, name), JSON.stringify(obj, null, 2) + '\\n', {{ mode }});
              chmodSync(join(opcDir, name), mode);
            }};
            const now = Date.now(), nowIso = new Date(now).toISOString(), soon = new Date(now + 1_800_000).toISOString();
            write('routing.json', {{
              replacementExcludedLaunchers: [],
              antigravityFallback: {{ enabled: true, state: {{ off_pace: true, as_of: new Date(now - 60_000).toISOString(),
                expires_at: new Date(now + 3_600_000).toISOString() }} }},
            }});
            write('neon-remote-targets.json', {{ targets: {{ 'srv-linux': {{ endpoint: 'ssh://example-other-linux', platform: 'linux', state: 'armed' }} }} }});
            const catalog = [
              {{ id: 'fleet/claude-opus-5-5', label: 'Opus', thinkingOptions: [{{ id: 'high' }}] }},
              {{ id: 'fleet/claude-fable-5-1', label: 'Fable', thinkingOptions: [{{ id: 'high' }}] }},
              {{ id: 'fleet/gpt-6.2-sol', label: 'Sol', thinkingOptions: [{{ id: 'medium' }}] }},
              {{ id: 'fleet/gpt-6.1-terra', label: 'Terra', thinkingOptions: [{{ id: 'high' }}] }},
            ];
            const catalogPath = join(opcDir, 'catalog.json');
            writeFileSync(catalogPath, JSON.stringify(catalog));
            const cli = (...args) => JSON.parse(execFileSync(process.execPath, [routeCli, ...args], {{ encoding: 'utf8' }}));
            const local = {{ daemon: 'srv-mac-local', local: true, platform: 'darwin' }};
            const remote = {{ daemon: 'srv-linux', local: false, platform: 'linux' }};
            const proofFor = (model, target = local) => ({{ provider: 'agy-opc', extends: 'acp', model, thinking: 'high',
              mode: 'auto', sandboxed: true, write: true, target, verified_at: nowIso }});
            const bothProofs = t => [proofFor(REPLACEMENT_RUNTIME.model, t), proofFor(OPUS_REPLACEMENT_RUNTIME.model, t)];

            // Blocker 1: the producer's real group labels hold Neon; invented short labels hold nothing.
            const quota = group => ({{ ok: true, as_of: new Date(now - 10_000).toISOString(), expires_at: new Date(now + 120_000).toISOString(),
              buckets: {{ 'gemini-5h': {{ group, left: 0.01, reset: soon }}, 'gemini-weekly': {{ group, left: 0.6, reset: soon }},
                '3p-5h': {{ group: 'Claude and GPT models', left: 0.7, reset: soon }}, '3p-weekly': {{ group: 'Claude and GPT models', left: 0.7, reset: soon }} }} }});
            assert.deepEqual(evaluateAgyQuotaProjection(quota('Gemini Models'), now),
              {{ [REPLACEMENT_RUNTIME.model]: true, [OPUS_REPLACEMENT_RUNTIME.model]: false }});
            assert.deepEqual(evaluateAgyQuotaProjection(quota('gemini'), now),
              {{ [REPLACEMENT_RUNTIME.model]: false, [OPUS_REPLACEMENT_RUNTIME.model]: false }});
            write('agy-quota.json', quota('Gemini Models'), 0o644);
            assert.equal(cli('--class', 'code', '--catalog', catalogPath).provider, 'agy-opc/claude-opus-5-5-high');
            assert.equal(cli('--class', 'main-pm').nextFallback, 'cursor/gemini-4-neon');
            write('agy-quota.json', quota('gemini'), 0o644);
            assert.equal(cli('--class', 'code', '--catalog', catalogPath).provider, 'agy-opc/gemini-4-neon-high');
            assert.equal(cli('--class', 'main-pm').nextFallback, 'agy-opc/gemini-4-neon-high');

            // Blocker 2: the documented error backstop (agy-holds.mjs record-terminal) holds only on the launched lane
            // Worker's own authenticated terminal quota error, read from its recorded target's daemon.
            const att = await readRemoteAgyTarget({{ serverId: 'srv-linux' }});
            const nhCtx = {{ task: readTask(taskPath), lane: 'rem-nh', target: remote, remote: att, proof: bothProofs(remote) }};
            const nh = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: nhCtx }});
            assert.equal(nh.route.model, REPLACEMENT_RUNTIME.model);
            recordWorkerRoute(taskPath, {{ lane: 'rem-nh', ...nh, taskClass: 'code', catalog, replacement: nhCtx }});
            const labels = {{ role: 'worker', 'opc.worker-task': readTask(taskPath).id, 'opc.worker-lane': 'rem-nh', 'opc.route-source': 'replacement' }};
            const resetIso = new Date(now + 3_600_000).toISOString();
            const agent = (id, extra) => ({{ id, status: 'error', provider: 'agy-opc', model: REPLACEMENT_RUNTIME.model,
              lastError: 'Individual quota reached for acct-secret-label; resets ' + resetIso, labels, workspaceId: 'wks-' + id, ...extra }});
            process.env.FAKE_REMOTE_AGENTS = JSON.stringify({{
              'agt-nh-quota': agent('agt-nh-quota', {{}}),
              // 44255e3 fix 2: another agent carrying the lane's copied labels, and the launched agent reported in another workspace.
              'agt-copied': agent('agt-copied', {{}}),
              'agt-moved': agent('agt-moved', {{ workspaceId: 'wks-elsewhere' }}),
              'agt-nh-crash': agent('agt-nh-crash', {{ lastError: 'process exited 1' }}),
              'agt-other-lane': agent('agt-other-lane', {{ labels: {{ ...labels, 'opc.worker-lane': 'elsewhere' }} }}),
            }});
            const backstop = agentId => spawnSync(process.execPath, [holdsCli, 'record-terminal', '--task', taskPath, '--lane', 'rem-nh', '--agent', agentId],
              {{ encoding: 'utf8' }});
            // The launch workflow records each created Worker on its lane (validateManagedWorkerLaunch with taskPath).
            const launched = (agentId, lane, workspaceId, serverId) => validateManagedWorkerLaunch(
              {{ workspaceId, request: {{ notifyOnFinish: true, serverId, labels: {{ 'opc.worker-task': readTask(taskPath).id, 'opc.worker-lane': lane }} }} }},
              {{ agentId, workspaceId, serverId }}, taskPath);
            assert.notEqual(backstop('agt-nh-quota').status, 0);
            launched('agt-nh-quota', 'rem-nh', 'wks-agt-nh-quota', 'srv-linux');
            launched('agt-moved', 'rem-nh', 'wks-agt-moved', 'srv-linux');
            assert.deepEqual(readTask(taskPath).launches['rem-nh'].map(entry => entry.agent_id), ['agt-nh-quota', 'agt-moved']);
            for (const id of ['agt-nh-crash', 'agt-other-lane', 'agt-missing', 'agt-copied', 'agt-moved']) {{
              const refused = backstop(id);
              assert.notEqual(refused.status, 0, id);
              assert.equal(existsSync(join(opcDir, 'agy-model-holds.json')), false, id);
            }}
            const held = backstop('agt-nh-quota');
            assert.equal(held.status, 0, held.stderr);
            assert.deepEqual(JSON.parse(held.stdout), {{ recorded: true, model: REPLACEMENT_RUNTIME.model, probeEligible: true, probeDirection: 'nh_to_oh' }});
            assert.equal(readFileSync(join(opcDir, 'agy-model-holds.json'), 'utf8').includes('acct-secret-label'), false);
            const afterHold = await resolveWorkerRoute({{ taskClass: 'code', catalog,
              replacement: {{ task: readTask(taskPath), lane: 'rem-after', target: remote, remote: att, proof: bothProofs(remote) }} }});
            assert.equal(afterHold.route.model, OPUS_REPLACEMENT_RUNTIME.model);

            // Blocker 3: a Pi-only (allowBackup launch read) or Cursor-only attestation never counts as agy unavailability.
            const names = managedWorkerNames({{ taskId: readTask(taskPath).id, lane: 'rem-sol' }});
            process.env.FAKE_REMOTE_WORKSPACES = JSON.stringify([{{ id: 'wks-x', workspaceKind: 'worktree', worktreeSlug: names.worktreeSlug,
              workspaceDirectory: '/tmp/x', gitRuntime: {{ currentBranch: names.branchName }}, archivingAt: null }}]);
            const piOnly = await readRemoteAgyTarget({{ serverId: 'srv-linux', allowBackup: true,
              workspace: {{ workspaceId: 'wks-x', worktreeSlug: names.worktreeSlug, branchName: names.branchName }} }});
            await assert.rejects(() => resolveWorkerRoute({{ taskClass: 'code', catalog,
              replacement: {{ task: readTask(taskPath), lane: 'rem-sol', target: remote, remote: piOnly }} }}), /requires a verified local Mac or armed remote target/);
            // A partial hold is no unavailability either: with NH held and OH served, OH stays next; Sol needs both held or
            // the provider positively missing or disabled on a resolve read of this target.
            const ohOnly = await resolveWorkerRoute({{ taskClass: 'code', catalog,
              replacement: {{ task: readTask(taskPath), lane: 'rem-oh2', target: remote, remote: att, proof: proofFor(OPUS_REPLACEMENT_RUNTIME.model, remote) }} }});
            assert.equal(ohOnly.route.model, OPUS_REPLACEMENT_RUNTIME.model);

            // Blocker 4a: the resolve stamp binds task, lane, and current policy.
            const plan = await resolveWorkerRoute({{ taskClass: 'plan', catalog, task: readTask(taskPath), lane: 'plan-a' }});
            const ws = {{ workspaceId: 'wks-p', cwd: '/tmp/wks-p' }};
            const piCaps = {{ enabled: true, status: 'available', modes: [], models: catalog }};
            const build = (route, lane) => buildManagedWorkerRequest({{ taskId: readTask(taskPath).id, lane, title: 'Plan', initialPrompt: 'Plan',
              workspace: ws, capabilities: piCaps, route, task: readTask(taskPath), taskClass: 'plan' }});
            assert.throws(() => build(plan.route, 'plan-b'), /bound to lane plan-a/);
            assert.throws(() => build(structuredClone(plan.route), 'plan-a'), /pasted, remembered, or stale routes are refused/);
            const devinReady = {{ ready: true, as_of: new Date(Date.now() - 5_000).toISOString(),
              expires_at: new Date(Date.now() + 175_000).toISOString(), retry_at: null }};
            write('devin-ready.json', devinReady, 0o644);
            assert.throws(() => build(plan.route, 'plan-a'), /live routing policy or local daemon state changed/);
            // The unbound brief refuses a cloned or stale class default too.
            assert.throws(() => buildDelegatedBrief({{ role: 'worker', route: structuredClone(plan.route), brief: 'x', taskClass: 'plan', catalog }}),
              /pasted, remembered, or stale routes are refused/);

            // Blocker 4b: devinSignal: null cannot suppress a valid owner projection.
            const dv = await resolveWorkerRoute({{ taskClass: 'code', catalog, devinSignal: null,
              replacement: {{ task: readTask(taskPath), lane: 'dv-code', target: local, proof: bothProofs() }} }});
            assert.equal(dv.route.source, 'devin-first');

            // Blocker 6: plan with no Fable catalog row reaches Devin-first, or the fresh fableUnavailable override.
            const noFable = catalog.filter(row => row.label !== 'Fable');
            const dvPlan = await resolveWorkerRoute({{ taskClass: 'plan', catalog: noFable,
              replacement: {{ task: readTask(taskPath), lane: 'dv-plan', target: local }} }});
            assert.equal(dvPlan.route.source, 'devin-first');
            recordWorkerRoute(taskPath, {{ lane: 'dv-plan', ...dvPlan, taskClass: 'plan', catalog: noFable,
              replacement: {{ target: local }} }});
            write('devin-ready.json', {{ ...devinReady, ready: false }}, 0o644);
            const fableDown = {{ provider: 'pi', model: 'fleet/claude-fable-5-1', target: local, checked_at: nowIso, finding: 'not-serving' }};
            const fbCtx = {{ task: readTask(taskPath), lane: 'fb-plan', target: local, proof: bothProofs(), fableUnavailable: fableDown }};
            const fbPlan = await resolveWorkerRoute({{ taskClass: 'plan', catalog: noFable, replacement: fbCtx }});
            assert.equal(fbPlan.route.source, 'replacement');
            assert.equal(fbPlan.route.kind, 'plan');
            recordWorkerRoute(taskPath, {{ lane: 'fb-plan', ...fbPlan, taskClass: 'plan', catalog: noFable, replacement: fbCtx }});

            // Blocker 4c: local agy capabilities need a fresh checked_at at launch.
            const codeCtx = {{ task: readTask(taskPath), lane: 'loc-code', target: local, proof: bothProofs() }};
            write('agy-quota.json', {{ ...quota('Gemini Models'), ok: false }}, 0o644);
            const locCode = await resolveWorkerRoute({{ taskClass: 'code', catalog, replacement: codeCtx }});
            assert.equal(locCode.route.model, REPLACEMENT_RUNTIME.model);
            recordWorkerRoute(taskPath, {{ lane: 'loc-code', ...locCode, taskClass: 'code', catalog, replacement: codeCtx }});
            const locNames = managedWorkerNames({{ taskId: readTask(taskPath).id, lane: 'loc-code' }});
            const agyCaps = checked_at => ({{ provider: 'agy-opc', enabled: true, status: 'available',
              models: [{{ id: REPLACEMENT_RUNTIME.model, thinkingOptions: [{{ id: 'high' }}] }}], modes: [{{ id: 'auto' }}],
              selectedModel: REPLACEMENT_RUNTIME.model, features: [{{ id: 'auto_accept', type: 'toggle', value: true }}], checked_at }});
            const locBuild = caps => buildManagedWorkerRequest({{ taskId: readTask(taskPath).id, lane: 'loc-code', title: 'Neon', initialPrompt: 'Go',
              workspace: {{ workspaceId: 'wks-l', cwd: '/tmp/wks-l', serverId: 'srv-mac-local' }}, capabilities: caps,
              route: locCode.route, task: readTask(taskPath), taskClass: 'code', target: local }});
            for (const stale of [undefined, new Date(Date.now() - 10 * 60_000).toISOString()]) {{
              assert.throws(() => locBuild(agyCaps(stale)), /fresh checked_at/);
            }}
            assert.equal(locBuild(agyCaps(new Date().toISOString())).request.provider, 'agy-opc/gemini-4-neon-high');
            assert.equal(locNames.branchName.length > 0, true);
            // Blocker 2 (local): the backstop reads a local lane's failure from this Mac's own Paseo home instance.
            process.env.FAKE_REMOTE_AGENTS = JSON.stringify({{ 'agt-loc-quota': agent('agt-loc-quota', {{
              labels: {{ ...labels, 'opc.worker-lane': 'loc-code' }} }}) }});
            launched('agt-loc-quota', 'loc-code', 'wks-agt-loc-quota', undefined);
            const locHeld = spawnSync(process.execPath, [holdsCli, 'record-terminal', '--task', taskPath, '--lane', 'loc-code', '--agent', 'agt-loc-quota'],
              {{ encoding: 'utf8' }});
            assert.equal(locHeld.status, 0, locHeld.stderr);
            assert.equal(JSON.parse(locHeld.stdout).recorded, true);
            assert.equal(JSON.parse(readFileSync(join(opcDir, 'agy-model-holds.json'), 'utf8')).holds['srv-mac-local'] != null, true);

            // Blocker 4d: the OPN in-place path requires the resolver handoff for its exact lane.
            const research = await resolveWorkerRoute({{ taskClass: 'research', catalog, lane: 'opn-research' }});
            const inPlace = (route, lane) => buildInPlaceWorkerRequest({{ title: 'Research', initialPrompt: 'Look', route,
              taskClass: 'research', capabilities: piCaps, lane }});
            assert.equal(inPlace(research.route, 'opn-research').request.provider, 'pi/fleet/gpt-6.1-terra');
            assert.throws(() => inPlace(research.route, 'opn-other'), /bound to lane opn-research/);
            assert.throws(() => inPlace(structuredClone(research.route), 'opn-research'), /pasted, remembered, or stale routes are refused/);

            // 44255e3 fix 1: the in-place builder never passes a caller's provider or thinking through; each must equal the
            // validated route's mapping. A research or code route never builds Sol, and a code route never builds Opus medium.
            const sol = 'pi/fleet/gpt-6.2-sol';
            const inPlaceWith = (route, taskClass, lane, extra) => buildInPlaceWorkerRequest({{ title: 'W', initialPrompt: 'Go', route,
              taskClass, capabilities: piCaps, lane, ...extra }});
            assert.throws(() => inPlaceWith(research.route, 'research', 'opn-research', {{ provider: sol, agentSettings: {{ thinkingOptionId: 'low' }} }}),
              /not what this lane's validated route maps to/);
            assert.throws(() => inPlaceWith(research.route, 'research', 'opn-research', {{ agentSettings: {{ thinkingOptionId: 'low' }} }}),
              /materialize settings/);
            assert.equal(inPlaceWith(research.route, 'research', 'opn-research',
              {{ provider: 'pi/fleet/gpt-6.1-terra', agentSettings: {{ thinkingOptionId: 'high' }} }}).request.provider, 'pi/fleet/gpt-6.1-terra');
            const offPaceRouting = exclusions => write('routing.json', {{
              replacementExcludedLaunchers: exclusions,
              antigravityFallback: {{ enabled: true, state: {{ off_pace: true, as_of: new Date(now - 60_000).toISOString(),
                expires_at: new Date(now + 3_600_000).toISOString() }} }},
            }});
            offPaceRouting([process.env.PASEO_AGENT_ID]);
            const opnCode = await resolveWorkerRoute({{ taskClass: 'code', catalog, lane: 'opn-code' }});
            assert.equal(opnCode.route.source, 'task-default');
            for (const extra of [{{ provider: sol, agentSettings: {{ thinkingOptionId: 'medium' }} }},
              {{ provider: 'pi/fleet/claude-opus-5-5', agentSettings: {{ thinkingOptionId: 'medium' }} }}]) {{
              assert.throws(() => inPlaceWith(opnCode.route, 'code', 'opn-code', extra), /not what this lane's validated route maps to/);
            }}
            assert.deepEqual(inPlaceWith(opnCode.route, 'code', 'opn-code', {{ provider: 'pi/fleet/claude-opus-5-5',
              agentSettings: {{ thinkingOptionId: 'high' }} }}).request.settings, {{ thinkingOptionId: 'high' }});

            // 44255e3 fix 3: a managed launch takes its task record (a stamp for task A never builds for task B), and the
            // stamp is bound to the launcher exclusions, so lifting an exclusion makes the remembered Opus default stale.
            const exCode = await resolveWorkerRoute({{ task: readTask(taskPath), taskClass: 'code', catalog, lane: 'ex-code' }});
            assert.equal(exCode.route.source, 'task-default');
            const exBuild = extra => buildManagedWorkerRequest({{ taskId: readTask(taskPath).id, task: readTask(taskPath), lane: 'ex-code',
              title: 'W', initialPrompt: 'Go', workspace: {{ workspaceId: 'wks-ex', cwd: '/tmp/wks-ex' }}, capabilities: piCaps,
              route: exCode.route, taskClass: 'code', ...extra }});
            assert.throws(() => exBuild({{ task: null, taskId: 'another-task-0001' }}), /takes task: readTask/);
            assert.throws(() => exBuild({{ taskId: 'another-task-0001' }}), /bound task record id/);
            assert.equal(exBuild({{}}).request.provider, 'pi/fleet/claude-opus-5-5');
            offPaceRouting([]);
            assert.throws(() => exBuild({{}}), /changed since this route was resolved/);
            assert.throws(() => recordWorkerRoute(taskPath, {{ lane: 'ex-code', ...exCode, taskClass: 'code', catalog }}), /changed since this route was resolved/);
            assert.equal(readTask(taskPath).routes['ex-code'], undefined);
            // No caller surface or native authorization moves an in-place route off its own Pi mapping.
            const terra = await resolveWorkerRoute({{ taskClass: 'research', catalog, lane: 'opn-terra' }});
            const nativeCaps = {{ ...piCaps, modes: [{{ id: 'full-access', isUnattended: true }}] }};
            for (const extra of [{{ surface: 'codex', nativeAuthorization: 'owner-explicit', capabilities: nativeCaps }},
              {{ surface: 'claude', nativeAuthorization: 'owner-explicit', capabilities: nativeCaps }},
              {{ provider: 'codex/fleet/gpt-6.1-terra', nativeAuthorization: 'owner-explicit', capabilities: nativeCaps }}]) {{
              assert.throws(() => inPlaceWith(terra.route, 'research', 'opn-terra', extra), /takes no surface or nativeAuthorization/);
            }}
            // A non-replacement lane's launch records nothing; only the agy error backstop needs the launch record.
            validateManagedWorkerLaunch({{ workspaceId: 'wks-ex', request: {{ notifyOnFinish: true, labels: {{ 'opc.worker-task': readTask(taskPath).id,
              'opc.worker-lane': 'loc-none' }} }} }}, {{ agentId: 'agt-plain', workspaceId: 'wks-ex' }}, taskPath);
            assert.equal(readTask(taskPath).launches['loc-none'], undefined);
        """, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)

if __name__ == "__main__":
    unittest.main()

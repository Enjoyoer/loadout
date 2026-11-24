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
        self.assertEqual(json.loads(done.stdout), {"route": {"role": "worker", "source": "owner-explicit",
                                                             "model": "fleet/gpt-6.2-sol", "effort": "high", "fastMode": False},
                                                   "reason": "owner-named, never adjusted"})

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
        self.assertEqual(json.loads(done.stdout), {"route": {"role": "worker", "source": "task-default", "kind": "research",
                                                             "model": "fleet/gpt-6.1-terra", "effort": "high",
                                                             "fastMode": False, "reason": "research default Terra high, Fast off"},
                                                   "reason": "research default Terra high, Fast off"})

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
            const neonCaps = {{
              provider: 'agy-opc', enabled: true, status: 'available',
              models: [{{ id: 'gemini-4-neon-high', thinkingOptions: [{{ id: 'high' }}] }}],
              modes: [{{ id: 'auto' }}],
              selectedModel: 'gemini-4-neon-high',
              features: [{{ id: 'auto_accept', type: 'toggle', value: true }}],
            }};

            // 1. Forced off pace: default plan, ui-design (and alias ui), ui-check take Neon replacement.
            setSwitch(true);
            for (const [tPath, cls, replayCls, lane] of [
              [taskPath, 'plan', 'plan', 'plan-neon'],
              [uiTaskPath, 'ui', 'ui-design', 'ui-design-neon'],
              [uiTaskPath, 'ui-check', 'ui-check', 'ui-check-neon'],
            ]) {{
              const task = readTask(tPath);
              const replacement = {{ task, lane, target, proof: proofFor(target, nowIso) }};
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

            // 2. Forced off pace with positive fresh unavailable evidence (newer than fresh proof): Sol medium backup.
            for (const [tPath, cls, canon, lane] of [
              [taskPath, 'plan', 'plan', 'plan-sol'],
              [uiTaskPath, 'ui-design', 'ui-design', 'ui-design-sol'],
              [uiTaskPath, 'ui-check', 'ui-check', 'ui-check-sol'],
            ]) {{
              const task = readTask(tPath);
              const replacement = {{ task, lane, target, proof: proofFor(target, olderIso), unavailable: unavailableFor(target, nowIso) }};
              const resolved = await resolveWorkerRoute({{ taskClass: cls, catalog, replacement }});
              assert.equal(resolved.route.source, 'pace-backup');
              assert.equal(resolved.route.kind, canon);
              assert.equal(resolved.route.model, PACE_BACKUP_RUNTIME.model);
              assert.equal(resolved.route.effort, 'medium');
              assert.equal(resolved.route.fastMode, false);
              assert.equal(resolved.reason, paceBackupReason(canon));

              recordWorkerRoute(tPath, {{ lane, ...resolved, taskClass: cls, catalog, replacement }});
              const updated = readTask(tPath);
              const req = buildManagedWorkerRequest({{
                taskId: updated.id, lane, title: 'Worker', initialPrompt: 'Check',
                workspace: {{ workspaceId: 'wks-2', cwd: '/tmp/wt-2', serverId: target.daemon }},
                capabilities: piCaps, route: resolved.route, task: updated, taskClass: cls,
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

              // Genuine armed attestation admits, records, and builds remote request.
              const ctx = {{ task, lane, target: armedTarget, proof: proofFor(armedTarget), remote: resolveAttestation }};
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


if __name__ == "__main__":
    unittest.main()

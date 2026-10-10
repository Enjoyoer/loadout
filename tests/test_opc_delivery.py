import json
import os
import re
import shlex
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

    def test_cloud_intent_precedes_command_and_failed_launch_refuses_retry(self):
        done = run('node', '--input-type=module', '-e', f'''
            import {{ beginCloudLaunch, recordCloudLaunch, recordCloudLaunchFailure }} from {json.dumps((SCRIPTS / 'cloud-lane.mjs').as_uri())};
            import {{ readTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            const task = {json.dumps(self.task)}, lane = {{branch:'opc/example',repo:'example/app'}};
            try {{ recordCloudLaunch(task, {{...lane, sessionId:'session_early', url:'https://example.invalid/session'}}); throw Error('launch recorded without intent'); }}
            catch (error) {{ if (!error.message.includes('call beginCloudLaunch before')) throw error; }}
            if (readTask(task).cloud !== null) throw Error('cloud record written without intent');
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

    def test_uncertain_cloud_launch_reconciles_to_found_session(self):
        done = run('node', '--input-type=module', '-e', f'''
            import {{ beginCloudLaunch, recordCloudLaunchFailure }} from {json.dumps((SCRIPTS / 'cloud-lane.mjs').as_uri())};
            beginCloudLaunch({json.dumps(self.task)}, {{branch:'opc/example',repo:'example/app'}});
            recordCloudLaunchFailure({json.dumps(self.task)}, 'capture interrupted');
        ''')
        self.assertEqual(done.returncode, 0, done.stderr)
        settled = run('node', str(SCRIPTS / 'cloud-lane.mjs'), 'reconcile', self.task,
                      '--session', 'session_found', '--url', 'https://example.invalid/session')
        self.assertEqual(settled.returncode, 0, settled.stderr)
        cloud = json.loads(Path(self.task).read_text())['cloud']
        self.assertEqual((cloud['status'], cloud['session_id'], cloud['reason']), ('running', 'session_found', None))
        listed = run('node', str(SCRIPTS / 'cloud-lane.mjs'), 'reconcile', self.task)
        self.assertEqual(json.loads(listed.stdout)['status'], 'running', listed.stderr)
        # A settled session refuses a second launch and a contradictory no_session, and the record stays byte for byte.
        settled_bytes = Path(self.task).read_bytes()
        refused = run('node', '--input-type=module', '-e', f'''
            import {{ beginCloudLaunch, reconcileCloudLaunch }} from {json.dumps((SCRIPTS / 'cloud-lane.mjs').as_uri())};
            const task = {json.dumps(self.task)};
            for (const [call, text] of [[() => beginCloudLaunch(task, {{branch:'opc/example',repo:'example/app'}}), 'already recorded'],
                [() => reconcileCloudLaunch(task, {{noSession:true, reason:'no session found'}}), 'no launching or uncertain']]) {{
              try {{ call(); }} catch (error) {{ if (error.message.includes(text)) continue; throw error; }}
              throw Error('allowed: ' + text);
            }}
            console.log('refused');
        ''')
        self.assertEqual((refused.returncode, refused.stdout.strip()), (0, 'refused'), refused.stderr)
        contradiction = run('node', str(SCRIPTS / 'cloud-lane.mjs'), 'reconcile', self.task, '--no-session', '--reason', 'no session found')
        self.assertNotEqual(contradiction.returncode, 0)
        self.assertIn('no launching or uncertain', contradiction.stderr)
        self.assertEqual(Path(self.task).read_bytes(), settled_bytes)

    def test_uncertain_cloud_launch_reconciles_to_no_session_and_one_relaunch(self):
        done = run('node', '--input-type=module', '-e', f'''
            import {{ beginCloudLaunch, recordCloudLaunch, recordCloudLaunchFailure, reconcileCloudLaunch }} from {json.dumps((SCRIPTS / 'cloud-lane.mjs').as_uri())};
            const task = {json.dumps(self.task)}, lane = {{branch:'opc/example',repo:'example/app'}};
            const refused = (call, text) => {{
              try {{ call(); }} catch (error) {{ if (error.message.includes(text)) return; throw error; }}
              throw Error('allowed: ' + text);
            }};
            beginCloudLaunch(task, lane);
            recordCloudLaunchFailure(task, 'capture interrupted');
            if (reconcileCloudLaunch(task, {{noSession:true, reason:'no session with the marker'}}).status !== 'no_session') throw Error('not settled');
            const relaunch = beginCloudLaunch(task, lane);
            if (relaunch.status !== 'launching' || relaunch.attempt !== 2) throw Error('relaunch not recorded');
            refused(() => beginCloudLaunch(task, lane), 'already recorded');
            recordCloudLaunchFailure(task, 'capture interrupted again');
            reconcileCloudLaunch(task, {{noSession:true, reason:'still no session'}});
            refused(() => beginCloudLaunch(task, lane), 'relaunched once');
            console.log('one relaunch');
        ''')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('one relaunch', done.stdout)

    def test_live_lock_replacing_stale_lock_before_reclaim_survives(self):
        dead = subprocess.Popen([sys.executable, "-c", ""])
        dead.wait()
        lock = Path(self.task + ".lock")
        lock.write_text(str(dead.pid))
        done = run("node", "--input-type=module", "-e", f"""
            import {{ readFileSync, unlinkSync, writeFileSync }} from 'node:fs';
            import {{ processStartTime, updateTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            const holder = `{os.getpid()}\\n${{processStartTime({os.getpid()})}}`;
            const beforeReclaim = lock => {{ unlinkSync(lock); writeFileSync(lock, holder, {{ flag: 'wx' }}); }};
            try {{ updateTask({json.dumps(self.task)}, () => {{}}, {{ beforeReclaim }}); }}
            catch (error) {{ console.log(error.message); }}
            console.log(readFileSync({json.dumps(self.task + ".lock")}, 'utf8') === holder ? 'kept' : 'replaced');
        """)
        self.assertIn("task lock contention", done.stdout, done.stderr)
        self.assertIn("kept", done.stdout)
        self.assertEqual(lock.read_text().splitlines()[0], str(os.getpid()))
        self.assertEqual(sorted(p.name for p in lock.parent.iterdir() if ".lock" in p.name), [lock.name])

    def test_live_lock_holder_with_unreadable_start_keeps_lock(self):
        lock = Path(self.task + ".lock")
        update = f"""
            import {{ updateTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            try {{ updateTask({json.dumps(self.task)}, () => {{}}); console.log('updated'); }}
            catch (error) {{ console.log(error.message); }}
        """
        # An empty PATH hides ps (powershell.exe on Windows), so no start time can be read.
        empty = Path(self.task).parent / "empty-path"
        empty.mkdir()
        node = shutil.which("node")
        for path, expected in ((str(empty), "task lock busy"), (os.environ.get("PATH", ""), "updated")):
            with self.subTest(readable=expected == "updated"):
                lock.write_text(f"{os.getpid()}\n{OLD_START}")
                done = run(node, "--input-type=module", "-e", update, env={**os.environ, "PATH": path})
                self.assertIn(expected, done.stdout, done.stderr)
                self.assertEqual(lock.exists(), expected != "updated")

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

    def test_new_xhigh_code_route_without_task_record_is_refused(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "medium"}, {"id": "high"}, {"id": "xhigh"}]}]
        self.write_routes(self.task, {"code-lane": PRE_730_CODE_ROUTE})
        built = self.launch(self.task, "new-lane", json.dumps(PRE_730_CODE_ROUTE), catalog, record_lane="new-lane",
                             task_class="code")
        for step in ("request", "brief", "record"):
            self.assertIn("recorded owner or task-default route required for worker", built[step].get("error", ""), step)
        self.assertNotIn("new-lane", json.loads(Path(self.task).read_text())["routes"])

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
        (root / "catalog.json").write_text(json.dumps(catalog))
        ui = self.ui_task()
        for task, kind, lane in ((self.task, "code", "code-lane"), (ui, "ui", "ui-lane")):
            recorded = run("node", str(SCRIPTS / "route.mjs"), "--class", kind, "--catalog", str(root / "catalog.json"),
                           "--pq-file", str(root / "no-pq.json"), "--task", task, "--lane", lane)
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
        own = self.launch(ui, "ui-lane", "recorded['ui-lane'].route", catalog)
        self.assertEqual(own["request"].get("settings"), {"thinkingOptionId": "xhigh"}, own["request"])
        replay = self.launch(ui, "ui-lane", "recorded['code-lane'].route", catalog, source=self.task, record_lane="ui-lane")
        for step in ("request", "brief"):
            self.assertEqual(replay[step].get("error"), "UI task: only the ui route (Opus xhigh, Fast off) can launch (owner rule); "
                                                        "use the ui class", step)
        self.assertEqual(replay["record"].get("error"), "UI task: only the ui route (Opus xhigh, Fast off) is recorded (owner rule); "
                                                        "use the ui class")

    def test_recorded_ui_route_not_opus_xhigh_fast_off_is_refused(self):
        catalog = [{"id": "fleet/claude-opus-5-5", "label": "Opus", "thinkingOptions": [{"id": "high"}, {"id": "xhigh"}]}]
        ui = self.ui_task()
        for route in ({"role": "worker", "source": "owner-explicit", "model": "fleet/claude-opus-5-5", "effort": "high", "fastMode": False},
                      {"role": "worker", "source": "owner-explicit", "model": "fleet/claude-opus-5-5", "effort": "xhigh", "fastMode": True}):
            with self.subTest(route=route):
                recorded = self.launch(ui, "ui-lane", json.dumps(route), catalog, record_lane="ui-lane")
                self.assertEqual(recorded["record"].get("error"), "UI task: only the ui route (Opus xhigh, Fast off) is recorded "
                                                                  "(owner rule); use the ui class")
                self.write_routes(ui, {"ui-lane": route})
                built = self.launch(ui, "ui-lane", "recorded['ui-lane'].route", catalog)
                for step in ("request", "brief"):
                    self.assertEqual(built[step].get("error"), "UI task: only the ui route (Opus xhigh, Fast off) can launch "
                                                               "(owner rule); use the ui class", step)

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

    def test_non_opus_claude_ui_route_is_refused_without_catalog(self):
        ui = self.ui_task()
        sonnet = {"role": "worker", "source": "owner-explicit", "model": "fleet/claude-sonnet-5-5", "effort": "xhigh", "fastMode": False}
        fresh = self.launch(ui, "ui-lane", json.dumps(sonnet), None, record_lane="ui-lane")
        self.assertEqual(fresh["record"].get("error"), "UI task: only the ui route (Opus xhigh, Fast off) is recorded (owner rule); "
                                                       "use the ui class")
        self.write_routes(ui, {"ui-lane": sonnet})
        rebuilt = self.launch(ui, "ui-lane", "recorded['ui-lane'].route", None)
        for built in (fresh, rebuilt):
            for step in ("request", "brief"):
                self.assertEqual(built[step].get("error"), "UI task: only the ui route (Opus xhigh, Fast off) can launch "
                                                           "(owner rule); use the ui class", step)

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
            import {{ beginCloudLaunch, recordCloudLaunch }} from {json.dumps((SCRIPTS / 'cloud-lane.mjs').as_uri())};
            import {{ recordWorkerRoute }} from {json.dumps((SCRIPTS / 'route.mjs').as_uri())};
            import {{ updateTask }} from {json.dumps((SCRIPTS / 'task-state.mjs').as_uri())};
            const path = {json.dumps(self.task)};
            recordWorkerRoute(path, {{ lane: 'taken-fallback', reason: 'owner-named, never adjusted',
              route: {{ role: 'worker', source: 'owner-explicit', model: 'fleet/claude-opus-5-5', effort: 'high', fastMode: false }} }});
            beginCloudLaunch(path, {{ branch: 'opc/fix-auth', repo: 'example/app', launchedAt: '2026-01-01T00:00:00.000Z' }});
            recordCloudLaunch(path, {{ sessionId: 'session_example', url: 'https://example.invalid/session', branch: 'opc/fix-auth',
              repo: 'example/app' }});
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

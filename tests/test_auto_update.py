"""Fixture runs of the auto-update runner: kill switch, bad and stale feed, canary, bounds,
unsupported hosts, one persisted attempt, interrupted apply, rollback timer, exclusivity, plan vs run, and the
daily-use Windows PC gates (window, blackout, idle probe). Synthetic HOME and fake adapters; nothing real runs."""

from __future__ import annotations

import copy
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "skills/orchestration/personal-skills/scripts/auto-update/auto-update.mjs"
EXAMPLE = ROOT / "skills/orchestration/personal-skills/fleet/example/auto-update"
FAKE = Path(__file__).resolve().parent / "auto_update_fake.mjs"
NODE = shutil.which("node")
OS = {"darwin": "macos", "linux": "linux", "win32": "windows"}[sys.platform]
WINDOWS = sys.platform == "win32"

# Tuesday 2026-11-24 03:00 America/New_York.
NOW = "2026-11-24T08:00:00Z"
ALL_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
ALWAYS = {"tz": "America/New_York", "days": ALL_DAYS, "start": "00:00", "end": "23:59"}


@unittest.skipUnless(NODE, "node is required")
class AutoUpdate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="auto-update-"))
        self.home = self.tmp / "home"
        self.fleet = self.tmp / "fleet"
        self.fx = self.tmp / "fx"
        for d in (self.home, self.fleet / "auto-update", self.fx):
            d.mkdir(parents=True)
        self.state = (self.home / "AppData" / "Local" / "loadout" / "auto-update") if WINDOWS else (self.home / ".local/state/loadout/auto-update")
        self.feed_path = self.tmp / "available.json"
        self.receipt = self.tmp / "receipt.json"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("XDG_", "LOADOUT_"))}
        self.env.update({"HOME": str(self.home), "USERPROFILE": str(self.home), "LOADOUT_FLEET": str(self.fleet),
                         "LOCALAPPDATA": str(self.home / "AppData" / "Local"), "APPDATA": str(self.home / "AppData" / "Roaming")})
        self.behavior = {"components": {}, "probe": {"ok": True, "observed_at": NOW}}
        self.installed("tool-a", "1.2.0")
        self.installed("tool-b", "3.0.0")
        self.registry = {
            "schema": "loadout.auto-update.registry/1",
            "feed": {"path": str(self.feed_path), "max_age_hours": 36},
            "notify": {"command": [NODE, str(FAKE), str(self.fx), "paseo"], "labels": ["role=pm", "project=config"]},
            "blackouts": [{"tz": "America/New_York", "days": ["sun"], "start": "05:00", "end": "07:00"}],
            "hosts": {
                "h1": {"os": OS, "tz": "America/New_York", "allow": ["tool-a", "tool-b"]},
                "pc": {"os": OS, "tz": "America/New_York", "allow": ["tool-a"], "deny_tiers": [2],
                       "preconditions": [{"name": "interactive-idle", "max_age_seconds": 120,
                                          "argv": [NODE, str(FAKE), str(self.fx), "probe"]}]},
            },
            "components": [self.row("tool-a", 1), self.row("tool-b", 1)],
        }
        self.feed = {"schema": "loadout.auto-update.available/1", "generated_at": NOW, "publisher": "version-watch",
                     "components": {"tool-a": self.entry("1.3.0"), "tool-b": self.entry("3.0.1")}}
        self.switch("allowed")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ----- fixture builders -----

    def row(self, name, tier, **extra):
        fake = [NODE, str(FAKE), str(self.fx), name]
        r = {"component": name, "tier": tier, "mode": "apply", "hosts": ["h1"],
             "version_pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$", "bounds": {"max_bump": "minor"},
             "window": ALWAYS, "soak_hours": 24,
             "adapters": {OS: {"check": {"argv": fake + ["version"], "regex": f"^{name} ([0-9.]+)$"},
                               "stage": [fake + ["stage", "{version}"]], "precheck": [fake + ["precheck", "{version}"]],
                               "apply": fake + ["apply", "{version}"], "health": [fake + ["health"]],
                               "rollback": fake + ["rollback", "{installed}"]}}}
        if tier == 2:
            r.update(exclusive_group="access", watchdog_seconds=600)
        r.update(extra)
        return r

    def entry(self, version, seen="2026-11-20T00:00:00Z", security=False):
        return {"version": version, "first_seen_at": seen, "security": security}

    def installed(self, name, version):
        (self.fx / f"{name}.installed").write_text(version)

    def version_of(self, name):
        return (self.fx / f"{name}.installed").read_text().strip()

    def switch(self, value):
        self.write(self.fleet / "auto-update" / "switch.json", {"schema": "loadout.auto-update.switch/1", "apply": value})

    def write(self, path, doc):
        path.write_text(json.dumps(doc))
        if not WINDOWS:
            path.chmod(0o600)

    def sync(self):
        self.write(self.fleet / "auto-update" / "registry.json", self.registry)
        self.write(self.feed_path, self.feed)
        (self.fx / "behavior.json").write_text(json.dumps(self.behavior))

    # ----- running -----

    def cli(self, *args, now=NOW, host="h1"):
        self.sync()
        cmd = [NODE, str(RUNNER), *args, "--host", host]
        if now:
            cmd += ["--now", now]
        return subprocess.run(cmd, env=self.env, capture_output=True, text=True, timeout=60)

    def plan(self, **kw):
        done = self.cli("plan", **kw)
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = [json.loads(line) for line in done.stdout.splitlines()]
        return lines[0], {l["component"]: l for l in lines[1:]}

    def run_and_wait(self, **kw):
        done = self.cli("run", **kw)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, "", "a run is silent")
        self.wait_idle()
        return done

    def wait_idle(self, timeout=60):
        until = time.time() + timeout
        while (self.state / "lock").exists():
            if time.time() > until:
                self.fail("transaction did not finish")
            time.sleep(0.2)

    def attempts(self):
        p = self.state / "state.json"
        return json.loads(p.read_text())["attempts"] if p.exists() else {}

    def sent(self):
        p = self.fx / "sent.log"
        return p.read_text().splitlines() if p.exists() else []

    # ----- cases -----

    def test_plan_reports_would_apply_and_writes_nothing(self):
        head, rows = self.plan()
        self.assertEqual((head["switch"], head["feed"]), ("allowed", "ok"))
        self.assertEqual(rows["tool-a"]["decision"], "would-apply")
        self.assertTrue(rows["tool-a"]["next"])
        self.assertFalse(rows["tool-b"]["next"])
        self.assertFalse(self.state.exists(), "plan must not create state")
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        calls = (self.fx / "calls.log").read_text()
        self.assertNotIn(" apply ", calls)
        self.assertNotIn(" stage ", calls)

    def test_run_applies_one_component_then_the_next(self):
        self.run_and_wait()
        self.assertEqual((self.version_of("tool-a"), self.version_of("tool-b")), ("1.3.0", "3.0.0"))
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "applied")
        self.run_and_wait()
        self.assertEqual(self.version_of("tool-b"), "3.0.1")
        self.assertEqual(self.sent(), [], "success is silent")
        _, rows = self.plan()
        self.assertEqual(rows["tool-a"]["decision"], "current")

    def test_kill_switch_fails_closed(self):
        for setup in ("stopped", "missing", "garbage", "stopfile"):
            with self.subTest(setup):
                self.switch("allowed")
                (self.state / "STOP").unlink(missing_ok=True)
                if setup == "stopped":
                    self.switch("stopped")
                elif setup == "missing":
                    (self.fleet / "auto-update" / "switch.json").unlink()
                elif setup == "garbage":
                    (self.fleet / "auto-update" / "switch.json").write_text("{not json")
                else:
                    self.state.mkdir(parents=True, exist_ok=True)
                    (self.state / "STOP").write_text("")
                _, rows = self.plan()
                self.assertIn("kill switch", rows["tool-a"]["reason"])
                self.run_and_wait()
                self.assertEqual(self.version_of("tool-a"), "1.2.0")
                self.assertEqual(self.sent(), [])
                self.assertEqual(self.attempts(), {})

    def test_bad_and_stale_feed_apply_nothing(self):
        bad = {
            "stale": lambda f: f.update(generated_at="2026-11-22T00:00:00Z"),
            "future": lambda f: f.update(generated_at="2026-11-24T09:00:00Z"),
            "unknown key": lambda f: f.update(url="https://example.test/x"),
            "shell in version": lambda f: f["components"]["tool-a"].update(version="1.3.0;touch /tmp/x"),
            "command field": lambda f: f["components"]["tool-a"].update(command="sh -c id"),
            "bad time": lambda f: f.update(generated_at="2026-11-24 08:00:00"),
            "seen after generated": lambda f: f["components"]["tool-a"].update(first_seen_at="2026-11-25T00:00:00Z"),
        }
        good = copy.deepcopy(self.feed)
        for name, mutate in bad.items():
            with self.subTest(name):
                self.feed = copy.deepcopy(good)
                mutate(self.feed)
                head, rows = self.plan()
                self.assertNotEqual(head["feed"], "ok")
                self.assertEqual(rows["tool-a"]["decision"], "skip")
        self.feed = copy.deepcopy(good)
        self.feed["generated_at"] = "2026-11-22T00:00:00Z"
        self.run_and_wait()
        self.run_and_wait()
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.assertEqual(len(self.sent()), 1, "one line per distinct feed failure")
        self.assertIn("feed stale", self.sent()[0])

    @unittest.skipIf(WINDOWS, "POSIX ownership and links")
    def test_feed_file_must_be_private_regular_file(self):
        self.sync()
        self.feed_path.chmod(0o666)
        done = subprocess.run([NODE, str(RUNNER), "plan", "--host", "h1", "--now", NOW], env=self.env, capture_output=True, text=True)
        self.assertIn("writable by group or other", done.stdout)
        real = self.tmp / "real.json"
        self.write(real, self.feed)
        self.feed_path.unlink()
        self.feed_path.symlink_to(real)
        done = subprocess.run([NODE, str(RUNNER), "plan", "--host", "h1", "--now", NOW], env=self.env, capture_output=True, text=True)
        self.assertIn("not a regular file", done.stdout)

    def test_canary_must_prove_the_exact_version(self):
        self.registry["hosts"]["canary"] = {"os": OS, "tz": "America/New_York", "allow": ["tool-a"]}
        self.registry["components"][0].update(hosts=["h1", "canary"],
                                              canary={"host": "canary", "receipt": str(self.receipt), "max_age_hours": 48})
        base = {"schema": "loadout.auto-update.canary/1", "component": "tool-a", "version": "1.3.0", "host": "canary",
                "result": "pass", "finished_at": "2026-11-23T08:00:00Z"}
        cases = {
            "missing": None,
            "other version": {**base, "version": "1.2.9"},
            "failed": {**base, "result": "fail"},
            "other host": {**base, "host": "h1"},
            "too old": {**base, "finished_at": "2026-11-20T00:00:00Z"},
            "extra key": {**base, "note": "trust me"},
        }
        for name, receipt in cases.items():
            with self.subTest(name):
                self.receipt.unlink(missing_ok=True)
                if receipt:
                    self.write(self.receipt, receipt)
                _, rows = self.plan()
                self.assertEqual(rows["tool-a"]["decision"], "skip")
                self.assertIn("canary", rows["tool-a"]["reason"])
        self.write(self.receipt, base)
        _, rows = self.plan()
        self.assertEqual(rows["tool-a"]["decision"], "would-apply")

    def test_canary_host_writes_receipt_for_the_exact_version(self):
        self.registry["components"][0]["canary"] = {"host": "h1", "receipt": str(self.receipt), "max_age_hours": 48}
        self.run_and_wait()
        r = json.loads(self.receipt.read_text())
        self.assertEqual((r["component"], r["version"], r["host"], r["result"]), ("tool-a", "1.3.0", "h1", "pass"))

    def test_bounds(self):
        cases = {
            "downgrade": ("1.1.0", None, "older than installed"),
            "major bump": ("2.0.0", None, "bump beyond minor"),
            "pattern": ("1.3.0-beta", None, "version_pattern"),
            "denied": ("1.3.0", ["^1\\.3\\..*$"], "denied version"),
            "soak": ("1.3.0", None, "soaking until"),
        }
        for name, (version, deny, reason) in cases.items():
            with self.subTest(name):
                self.feed["components"]["tool-a"] = self.entry(version, seen=NOW if name == "soak" else "2026-11-20T00:00:00Z")
                self.registry["components"][0]["bounds"] = {"max_bump": "minor", **({"deny": deny} if deny else {})}
                _, rows = self.plan()
                self.assertIn(reason, rows["tool-a"]["reason"])
        self.feed["components"]["tool-a"] = self.entry("1.3.0", seen=NOW, security=True)
        self.registry["components"][0].update(bounds={"max_bump": "minor"}, security_soak_hours=0)
        _, rows = self.plan()
        self.assertEqual(rows["tool-a"]["decision"], "would-apply", "a security release uses the shorter soak")

    def test_unsupported_and_rejected_hosts(self):
        done = self.cli("plan", host="nobody")
        self.assertEqual(done.returncode, 2)
        self.assertIn("not in the registry", done.stderr)
        other = "linux" if OS != "linux" else "macos"
        self.registry["hosts"]["h1"]["os"] = other
        self.registry["components"] = [dict(self.row("tool-a", 1), mode="hold", adapters={other: self.row("tool-a", 1)["adapters"][OS]})]
        done = self.cli("plan")
        self.assertEqual(done.returncode, 2)
        self.assertIn("this is", done.stderr)
        self.registry["hosts"]["h1"]["os"] = OS
        # A daily-use PC that allows only leaf CLIs and denies tier 2 rejects an access-path row outright.
        for row, why in ((dict(self.row("tool-b", 1), hosts=["pc"]), "does not allow"),
                         (dict(self.row("tool-a", 2), hosts=["pc"]), "denies tier 2")):
            with self.subTest(why):
                self.registry["components"] = [row]
                done = self.cli("plan")
                self.assertEqual(done.returncode, 2)
                self.assertIn(why, done.stderr)
        self.registry["components"] = [dict(self.row("tool-a", 1), adapters={other: self.row("tool-a", 1)["adapters"][OS]}, mode="observe")]
        _, rows = self.plan()
        self.assertIn("unsupported on", rows["tool-a"]["reason"])

    def test_failed_attempt_is_held_and_reported_once(self):
        self.behavior["components"]["tool-a"] = {"health_exit": 1}
        self.registry["components"] = [self.row("tool-a", 1)]
        self.run_and_wait()
        a = self.attempts()["h1/tool-a@1.3.0"]
        self.assertEqual(a["status"], "rolled-back")
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.run_and_wait()
        self.run_and_wait()
        self.assertEqual(len(self.sent()), 1)
        self.assertIn("auto-update HOLD h1/tool-a@1.3.0", self.sent()[0])
        calls = (self.fx / "calls.log").read_text()
        self.assertEqual(calls.count("tool-a apply"), 1, "no retry")
        _, rows = self.plan()
        self.assertIn("held: earlier attempt rolled-back", rows["tool-a"]["reason"])
        self.feed["components"]["tool-a"] = self.entry("1.3.1")
        _, rows = self.plan()
        self.assertEqual(rows["tool-a"]["decision"], "would-apply", "a newer version is a new attempt")

    def test_stage_failure_holds_without_rollback(self):
        self.behavior["components"]["tool-a"] = {"stage_exit": 1}
        self.registry["components"] = [self.row("tool-a", 1)]
        self.run_and_wait()
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "failed")
        self.assertNotIn("rollback", (self.fx / "calls.log").read_text())

    def test_not_now_drops_the_attempt_silently(self):
        self.behavior["components"]["tool-a"] = {"apply_exit": 75}
        self.registry["components"] = [self.row("tool-a", 1)]
        self.run_and_wait()
        self.assertEqual(self.attempts(), {})
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.version_of("tool-a"), "1.2.0")

    def test_interrupted_apply_is_held_not_retried(self):
        self.behavior["components"]["tool-a"] = {"apply_sleep": 120}
        self.registry["components"] = [self.row("tool-a", 1)]
        done = self.cli("run")
        self.assertEqual(done.returncode, 0, done.stderr)
        until = time.time() + 30
        while True:
            a = self.attempts().get("h1/tool-a@1.3.0", {})
            if a.get("status") == "applying":
                break
            self.assertLess(time.time(), until, a)
            time.sleep(0.2)
        # A second run while the transaction lives does nothing.
        self.assertEqual(self.cli("run").returncode, 0)
        self.assertEqual(len([l for l in (self.fx / "calls.log").read_text().splitlines() if "tool-a stage" in l]), 1)
        os.kill(a["txn_pid"], signal.SIGKILL if not WINDOWS else signal.SIGTERM)
        time.sleep(1)
        self.run_and_wait()
        self.run_and_wait()
        a = self.attempts()["h1/tool-a@1.3.0"]
        self.assertEqual((a["status"], a["interrupted_in"]), ("interrupted", "applying"))
        self.assertEqual(len(self.sent()), 1)
        self.assertIn("interrupted during applying", self.sent()[0])
        self.assertEqual(len([l for l in (self.fx / "calls.log").read_text().splitlines() if "tool-a stage" in l]), 1)

    def test_rollback_timer_fires_when_not_confirmed(self):
        self.behavior["components"]["tool-a"] = {"health_sleep": 20}
        self.registry["components"] = [self.row("tool-a", 2, watchdog_seconds=10)]
        self.assertEqual(self.cli("run").returncode, 0)
        self.wait_idle(timeout=90)
        a = self.attempts()["h1/tool-a@1.3.0"]
        self.assertEqual(a["status"], "rolled-back-by-watchdog")
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.assertEqual(len(self.sent()), 1)
        self.assertIn("watchdog rolled back", self.sent()[0])
        calls = (self.fx / "calls.log").read_text()
        self.assertEqual(calls.count("tool-a rollback"), 1, "only the watchdog rolls back")

    def test_confirmed_change_disarms_the_watchdog(self):
        self.registry["components"] = [self.row("tool-a", 2, watchdog_seconds=10)]
        self.cli("run")
        self.wait_idle(timeout=90)
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "applied")
        self.assertEqual(self.version_of("tool-a"), "1.3.0")
        self.assertNotIn("rollback", (self.fx / "calls.log").read_text())

    def test_tier2_exclusive_per_host_and_day(self):
        self.registry["components"] = [self.row("tool-a", 2), self.row("tool-b", 2)]
        self.run_and_wait()
        self.assertEqual(self.version_of("tool-a"), "1.3.0")
        _, rows = self.plan(now="2026-11-24T09:00:00Z")
        self.assertIn("exclusive: tool-a already applied", rows["tool-b"]["reason"])
        self.run_and_wait(now="2026-11-24T09:00:00Z")
        self.assertEqual(self.version_of("tool-b"), "3.0.0")
        self.feed["generated_at"] = "2026-11-25T08:00:00Z"
        _, rows = self.plan(now="2026-11-25T08:00:00Z")
        self.assertEqual(rows["tool-b"]["decision"], "would-apply")

    def test_tier2_failed_attempt_also_blocks_the_other_access_path_today(self):
        self.behavior["components"]["tool-a"] = {"health_exit": 1}
        self.registry["components"] = [self.row("tool-a", 2), self.row("tool-b", 2)]
        self.run_and_wait()
        _, rows = self.plan()
        self.assertIn("exclusive", rows["tool-b"]["reason"])

    def test_windows_pc_window_blackout_and_idle(self):
        self.registry["components"] = [dict(self.row("tool-a", 1), hosts=["pc"], window={**ALWAYS, "days": ["sat"]},
                                            host_windows={"pc": {"tz": "America/New_York", "days": ["sun"], "start": "03:00", "end": "05:00"}})]
        cases = {
            "2026-11-29T08:00:00Z": ("would-apply", ""),          # Sun 03:00 EST
            "2026-11-29T09:59:00Z": ("would-apply", ""),          # Sun 04:59 EST
            "2026-11-29T10:30:00Z": ("skip", "blackout"),         # Sun 05:30 EST
            "2026-11-29T07:30:00Z": ("skip", "outside window"),   # Sun 02:30 EST
            "2026-11-28T08:00:00Z": ("skip", "outside window"),   # Sat 03:00 EST: the default window is not the PC's
            "2026-07-05T07:30:00Z": ("would-apply", ""),          # Sun 03:30 EDT
            "2026-07-05T09:30:00Z": ("skip", "blackout"),         # Sun 05:30 EDT
        }
        for now, (decision, reason) in cases.items():
            with self.subTest(now):
                self.feed.update(generated_at=now, components={"tool-a": self.entry("1.3.0", seen="2026-06-01T00:00:00Z")})
                self.behavior["probe"] = {"ok": True, "observed_at": now}
                _, rows = self.plan(now=now, host="pc")
                self.assertEqual(rows["tool-a"]["decision"], decision, rows["tool-a"])
                self.assertIn(reason, rows["tool-a"]["reason"])
        now = "2026-11-29T08:30:00Z"
        self.feed.update(generated_at=now)
        probes = {
            "busy": ({"ok": False, "observed_at": now, "detail": "idle 3 min"}, None, "not met"),
            "full-screen": ({"ok": False, "observed_at": now, "detail": "full-screen app in front"}, None, "full-screen"),
            "stale": ({"ok": True, "observed_at": "2026-11-29T08:00:00Z"}, None, "stale"),
            "unavailable": ({"ok": True, "observed_at": now}, 1, "probe failed"),
            "no signal": ({"ok": True}, None, "observed_at"),
        }
        for name, (probe, code, reason) in probes.items():
            with self.subTest(name):
                self.behavior["probe"] = probe
                self.behavior.pop("probe_exit", None)
                if code:
                    self.behavior["probe_exit"] = code
                _, rows = self.plan(now=now, host="pc")
                self.assertIn(reason, rows["tool-a"]["reason"])
                self.run_and_wait(now=now, host="pc")
                self.assertEqual(self.attempts(), {}, "a no-go is not an attempt")
                self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.behavior.pop("probe_exit", None)
        self.behavior["probe"] = {"ok": True, "observed_at": now}
        self.run_and_wait(now=now, host="pc")
        self.assertEqual(self.version_of("tool-a"), "1.3.0")

    def test_lock_excludes_a_second_runner(self):
        self.state.mkdir(parents=True)
        (self.state / "lock").mkdir()
        (self.state / "lock" / "owner.json").write_text(json.dumps({"pids": [os.getpid()], "at": NOW}))
        self.assertEqual(self.cli("run").returncode, 0)
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        (self.state / "lock" / "owner.json").write_text(json.dumps({"pids": [99999999], "at": NOW}))
        self.run_and_wait()
        self.assertEqual(self.version_of("tool-a"), "1.3.0", "a dead owner's lock is stale")

    def test_example_registry_validates(self):
        env = dict(self.env, LOADOUT_FLEET=str(EXAMPLE.parent))
        done = subprocess.run([NODE, str(RUNNER), "validate"], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("desktop windows: claude-code(t1,hold) codex-cli(t1,hold)", done.stdout)


if __name__ == "__main__":
    unittest.main()

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
                               "stage": [fake + ["stage", "{version}", "{txn}"]], "precheck": [fake + ["precheck", "{version}"]],
                               "apply": fake + ["apply", "{version}"], "health": [fake + ["health"]],
                               "rollback": fake + ["rollback", "{installed}"]}}}
        if tier == 2:  # a watchdog budget above apply + health + check (5 s each) and the 10 s margin
            r.update(exclusive_group="access", watchdog_seconds=30, timeouts={"apply": 5, "health": 5, "check": 5})
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

    def sent_reset(self):
        (self.fx / "sent.log").unlink(missing_ok=True)

    def sent(self):
        p = self.fx / "sent.log"
        return p.read_text().splitlines() if p.exists() else []

    def relay_copy(self, name, doc, source, for_host=None, sent_at=NOW, tamper=None):
        """Write a relay copy for this test's host state, as auto_update_relay_remote.js would."""
        import base64, hashlib
        data = (json.dumps(doc) if not isinstance(doc, str) else doc).encode()
        w = {"schema": "loadout.auto-update.relay/1", "kind": "feed" if name == "feed" else "receipt",
             "source_host": source, "for_host": for_host or "h1", "sent_at": sent_at,
             "sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode()}
        if tamper:
            tamper(w)
        d = self.state / "relay" / ("" if name == "feed" else "canary")
        d.mkdir(parents=True, exist_ok=True)
        for x in (self.state, self.state / "relay", d):
            if not WINDOWS:
                x.chmod(0o700)
        self.write(d / ("available.json" if name == "feed" else name.split("/", 1)[1] + ".json"), w)

    def blackouts_off(self):
        self.registry["blackouts"] = []

    def gate(self, name, **extra):
        return {"name": name, "max_age_seconds": 120, "argv": [NODE, str(FAKE), str(self.fx), "probe", name], **extra}

    def probes(self, now, **states):
        """states: name -> True (idle), False (busy), or a dict merged into the reading."""
        self.behavior["probes"] = {}
        for name, v in states.items():
            reading = {"ok": v is not False, "observed_at": now}
            if isinstance(v, dict):
                reading.update(v)
            self.behavior["probes"][name] = reading

    def gate_days(self):
        p = self.state / "gates.json"
        return json.loads(p.read_text())["days"] if p.exists() else {}

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
                "result": "pass", "finished_at": "2026-11-23T08:00:00Z", "txn": "20261123T080000Z-tool-a-0a1b2c"}
        cases = {
            "missing": None,
            "other version": {**base, "version": "1.2.9"},
            "failed": {**base, "result": "fail"},
            "other host": {**base, "host": "h1"},
            "too old": {**base, "finished_at": "2026-11-20T00:00:00Z"},
            "extra key": {**base, "note": "trust me"},
        }
        relayed = self.state / "relay" / "canary" / "tool-a.json"
        for name, receipt in cases.items():
            with self.subTest(name):
                relayed.unlink(missing_ok=True)
                if receipt:
                    self.relay_copy("canary/tool-a", receipt, "canary")
                _, rows = self.plan()
                self.assertEqual(rows["tool-a"]["decision"], "skip")
                self.assertIn("canary", rows["tool-a"]["reason"])
        # A receipt file at the canary's own path on this host is never read: only the relay copy counts.
        self.write(self.receipt, base)
        relayed.unlink(missing_ok=True)
        _, rows = self.plan()
        self.assertIn("canary receipt missing", rows["tool-a"]["reason"])
        binding = {"made for another host": lambda w: w.update(for_host="pc"),
                   "another host than the expected source": lambda w: w.update(source_host="h1"),
                   "digest mismatch": lambda w: w.update(sha256="0" * 64)}
        for why, tamper in binding.items():
            with self.subTest(why):
                self.relay_copy("canary/tool-a", base, "canary", tamper=tamper)
                _, rows = self.plan()
                self.assertIn(why, rows["tool-a"]["reason"])
        self.relay_copy("canary/tool-a", base, "canary")
        _, rows = self.plan()
        self.assertEqual(rows["tool-a"]["decision"], "would-apply")

    def test_canary_host_writes_receipt_for_the_exact_version(self):
        self.registry["components"][0]["canary"] = {"host": "h1", "receipt": str(self.receipt), "max_age_hours": 48}
        self.run_and_wait()
        r = json.loads(self.receipt.read_text())
        self.assertEqual((r["component"], r["version"], r["host"], r["result"]), ("tool-a", "1.3.0", "h1", "pass"))
        self.assertEqual(r["txn"], self.attempts()["h1/tool-a@1.3.0"]["txn"])

    def test_receipt_write_failure_still_alerts_once(self):
        blocked = self.tmp / "blocked"
        blocked.write_text("a file where the receipt directory should be")
        self.registry["components"][0]["canary"] = {"host": "h1", "receipt": str(blocked / "receipt.json"), "max_age_hours": 48}
        self.registry["components"][0]["timeouts"] = {"apply": 2}
        for name, behavior, status in (("health failed, rolled back", {"health_exit": 1}, "rolled-back"),
                                       ("apply did not finish", {"apply_sleep": 10}, "intervention-required")):
            with self.subTest(name):
                (self.state / "state.json").unlink(missing_ok=True)
                self.sent_reset()
                self.installed("tool-a", "1.2.0")
                self.behavior["components"]["tool-a"] = behavior
                self.run_and_wait()
                a = self.attempts()["h1/tool-a@1.3.0"]
                self.assertEqual(a["status"], status)
                self.run_and_wait()
                self.assertEqual(len(self.sent()), 1, "delivered once")
                self.assertIn("auto-update HOLD h1/tool-a@1.3.0", self.sent()[0])
                self.assertIn("canary receipt not written", (self.state / "txn" / a["txn"] / "log.txt").read_text())

    def test_fix_by_hand_outcome_quarantines_the_component_on_that_host(self):
        self.registry["components"][0]["hosts"] = ["h1", "pc"]
        self.feed["components"]["tool-a"] = self.entry("1.3.1")
        for status, paused in (("intervention-required", True), ("rollback-failed", True), ("interrupted", True),
                               ("rolled-back", False), ("rolled-back-by-watchdog", False), ("failed", False)):
            with self.subTest(status):
                self.state.mkdir(parents=True, exist_ok=True)
                self.write(self.state / "state.json", {"schema": "loadout.auto-update.state/1", "applied": [], "alerts": {},
                    "attempts": {"h1/tool-a@1.3.0": {"status": status, "host": "h1", "component": "tool-a", "group": None,
                                                     "local_date": "2026-11-20", "txn": "20261120T080000Z-tool-a-0a0b0c"}}})
                _, rows = self.plan()
                if paused:
                    self.assertEqual(rows["tool-a"]["decision"], "skip")
                    self.assertIn(f"quarantined: h1/tool-a@1.3.0 {status}", rows["tool-a"]["reason"])
                else:
                    self.assertEqual(rows["tool-a"]["decision"], "would-apply", "a verified rollback or a failure before apply leaves it clean")
                self.assertEqual(rows["tool-b"]["decision"], "would-apply", "another component on the host is not affected")
                _, other = self.plan(host="pc")
                self.assertEqual(other["tool-a"]["decision"], "would-apply", "the same component on another host is not affected")

    def test_quarantine_holds_newer_versions_until_a_person_clears_it(self):
        installed = self.fx / "tool-a.installed"
        self.behavior["components"]["tool-a"] = {"apply_sleep": 10, "apply_late_write": [[str(installed), "1.3.0\n", 3]]}
        self.registry["components"][0]["timeouts"] = {"apply": 2}
        self.run_and_wait()
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "intervention-required")
        self.assertIn("tool-a paused on h1 until cleared", self.sent()[0])
        time.sleep(2)  # the child has written
        self.behavior["components"]["tool-a"] = {}
        self.feed["components"]["tool-a"] = self.entry("1.3.1")
        for _ in range(2):
            self.run_and_wait()
        self.assertNotIn("tool-a apply 1.3.1", (self.fx / "calls.log").read_text())
        self.assertEqual(self.version_of("tool-a"), "1.3.0")
        self.assertEqual(self.version_of("tool-b"), "3.0.1", "another component on the host still updates")
        self.assertEqual(len(self.sent()), 1)
        clear = lambda version, seen: self.cli("clear", "--component", "tool-a", "--version", version, "--installed", seen, now=None)
        for (version, seen), why in {("1.3.0", "1.2.0"): "the check reads 1.3.0, not 1.2.0", ("1.3.1", "1.3.0"): "no attempt h1/tool-a@1.3.1",
                                     ("1.3.0", "1.3.0"): None}.items():
            done = clear(version, seen)
            if why:
                self.assertEqual(done.returncode, 2)
                self.assertIn(why, done.stderr)
            else:
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertIn("1.3.0 itself stays held, later versions may apply", done.stdout)
        self.assertIn("already cleared", clear("1.3.0", "1.3.0").stderr)
        self.run_and_wait()
        self.assertEqual(self.version_of("tool-a"), "1.3.1", "cleared: the next version applies")
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "intervention-required", "the record stays")
        self.installed("tool-a", "1.2.0")
        self.feed["components"]["tool-a"] = self.entry("1.3.0")
        _, rows = self.plan()
        self.assertEqual(rows["tool-a"]["reason"], "held: earlier attempt intervention-required", "that exact version never again")
        self.assertEqual(len(self.sent()), 1)

    def test_feed_relay_copy_is_bound_intact_and_fresh(self):
        self.registry["hosts"]["src"] = {"os": OS, "tz": "America/New_York", "allow": ["tool-a"]}
        self.registry["feed"]["source_host"] = "src"
        head, _ = self.plan()
        self.assertEqual(head["feed"], "feed missing", "a non-source host never reads the feed file itself")
        cases = {"made for another host": dict(for_host="pc"),
                 "another host than the expected source": dict(tamper=lambda w: w.update(source_host="pc")),
                 "digest mismatch": dict(tamper=lambda w: w.update(data=w["data"][:-4] + "AAA=")),
                 "wrong schema or kind": dict(tamper=lambda w: w.update(kind="receipt")),
                 "unknown key": dict(tamper=lambda w: w.update(path="/tmp/x"))}
        for why, kw in cases.items():
            with self.subTest(why):
                self.relay_copy("feed", self.feed, "src", **kw)
                head, rows = self.plan()
                self.assertIn(why, head["feed"])
                self.assertIn(why, rows["tool-a"]["reason"])
        self.relay_copy("feed", {**self.feed, "generated_at": "2026-11-22T00:00:00Z"}, "src")
        head, _ = self.plan()
        self.assertIn("feed stale", head["feed"])
        self.relay_copy("feed", self.feed, "src")
        head, rows = self.plan()
        self.assertEqual(head["feed"], "ok")
        self.assertEqual(rows["tool-a"]["decision"], "would-apply")
        head, _ = self.plan(host="src")  # the source host still reads its own file
        self.assertEqual(head["feed"], "ok")

    def test_homebrew_rows_cannot_be_set_to_apply(self):
        self.registry["hosts"]["h1"]["allow"].append("brew.fd")
        self.registry["components"].append(self.row("brew.fd", 1))
        done = self.cli("validate", now=None)
        self.assertEqual(done.returncode, 2)
        self.assertIn("Homebrew rows stay hold or observe", done.stderr)
        rg = self.row("rg", 1)  # an id without the prefix, run through brew
        rg["adapters"][OS]["check"]["argv"] = ["/opt/homebrew/bin/brew", "list", "--versions", "ripgrep"]
        self.registry["components"] = [self.row("tool-a", 1), rg]
        done = self.cli("validate", now=None)
        self.assertIn("Homebrew rows stay hold or observe", done.stderr)
        self.registry["components"] = [self.row("tool-a", 1), self.row("paseo", 1)]
        done = self.cli("validate", now=None)
        self.assertIn("paseo is shared by every agent on the host; never automatic", done.stderr)

    def test_windows_transaction_must_fit_the_scheduler_task(self):
        row = self.registry["components"][0]
        row["adapters"]["windows"] = row["adapters"][OS]
        row["timeouts"] = {"stage": 3600, "precheck": 3600, "apply": 3600, "health": 3600}
        done = self.cli("validate", now=None)
        self.assertEqual(done.returncode, 2)
        self.assertIn("could outlast the scheduler task", done.stderr)

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

    def test_window_closing_during_stage_stops_before_apply(self):
        self.behavior["components"]["tool-a"] = {"stage_sleep": 4}
        self.registry["components"] = [self.row("tool-a", 1, window={**ALWAYS, "start": "02:00", "end": "03:00"})]
        self.run_and_wait(now="2026-11-24T07:59:58Z")  # Tue 02:59:58 EST
        self.assertEqual(self.attempts(), {})
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.assertNotIn("tool-a apply", (self.fx / "calls.log").read_text())

    def test_brew_revision_versions_compare(self):
        self.installed("tool-a", "15.2.0_1")
        self.feed["components"]["tool-a"] = self.entry("15.3.0")
        self.registry["components"] = [self.row("tool-a", 1, version_pattern="^[0-9]+\\.[0-9]+\\.[0-9]+(_[0-9]+)?$")]
        self.registry["components"][0]["adapters"][OS]["check"]["regex"] = "^tool-a ([0-9._]+)$"
        _, rows = self.plan()
        self.assertEqual(rows["tool-a"]["decision"], "would-apply", rows["tool-a"])

    def test_idle_gates_busy_or_unknown_skip_without_an_attempt(self):
        self.registry["hosts"]["h1"]["preconditions"] = [self.gate("paseo-idle"), self.gate("host-load")]
        self.registry["components"] = [self.row("tool-a", 1, window={**ALWAYS, "end": "24:00"})]
        ticks = ["2026-11-24T08:00:00Z", "2026-11-24T08:10:00Z", "2026-11-24T08:20:00Z", "2026-11-24T08:30:00Z",
                 "2026-11-24T08:40:00Z", "2026-11-24T08:50:00Z"]
        no_go = [(dict(paseo_idle=False, host_load=True), "paseo-idle: not met"),
                 (dict(paseo_idle=True, host_load=False), "host-load: not met"),
                 (dict(paseo_idle=True, host_load=True), "paseo-idle: probe failed"),     # unknown: probe errors
                 (dict(paseo_idle={"observed_at": "2026-11-24T07:00:00Z"}, host_load=True), "paseo-idle: reading stale"),
                 (dict(paseo_idle={"ok": "yes"}, host_load=True), "paseo-idle: probe output invalid")]
        for now, (states, reason) in zip(ticks, no_go):
            with self.subTest(reason):
                self.feed["generated_at"] = now
                self.probes(now, **{k.replace("_", "-"): v for k, v in states.items()})
                self.behavior["probe_exits"] = {"paseo-idle": 1} if "failed" in reason else {}
                _, rows = self.plan(now=now)
                self.assertIn(reason, rows["tool-a"]["reason"])
                self.run_and_wait(now=now)
                self.assertEqual(self.attempts(), {}, "a busy or unknown host is not an attempt")
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.assertEqual(self.sent(), [], "a skip sends nothing")
        # Five skips the same day do not cap the next tick.
        now = ticks[-1]
        self.feed["generated_at"] = now
        self.behavior["probe_exits"] = {}
        self.probes(now, **{"paseo-idle": True, "host-load": True})
        self.run_and_wait(now=now)
        self.assertEqual(self.version_of("tool-a"), "1.3.0")
        day = self.gate_days()["2026-11-24"]
        self.assertEqual((day["samples"], day["open"], day["opened"], day["closed"]), (6, 1, 1, 0))
        self.assertEqual(day["blocked"]["paseo-idle: not met"], 1)
        self.assertEqual(day["blocked"]["paseo-idle: probe failed"], 1)
        self.assertEqual(day["ticks"][-1][:3], ["03:50", 1, ""])
        self.assertEqual(day["ticks"][0][:3], ["03:00", 0, "paseo-idle"])

    def test_gate_closing_during_stage_stops_before_apply(self):
        self.registry["hosts"]["h1"]["preconditions"] = [self.gate("paseo-idle"), self.gate("host-load")]
        self.registry["components"] = [self.row("tool-a", 1, window={**ALWAYS, "end": "24:00"})]
        races = {"agent turn starts": "paseo-idle", "a build starts": "host-load"}
        for i, (name, gate) in enumerate(races.items()):
            with self.subTest(name):
                now = f"2026-11-24T08:{10 * (i + 1)}:00Z"
                self.feed["generated_at"] = now
                self.probes(now, **{"paseo-idle": True, "host-load": True})
                self.behavior["components"]["tool-a"] = {"stage_probes": {gate: {"ok": False, "observed_at": now}}}
                _, rows = self.plan(now=now)
                self.assertEqual(rows["tool-a"]["decision"], "would-apply", rows["tool-a"])
                self.run_and_wait(now=now)
                self.assertNotIn("tool-a apply", (self.fx / "calls.log").read_text())
                self.assertEqual(self.attempts(), {}, "stopped before apply: not an attempt")
                self.assertEqual(self.version_of("tool-a"), "1.2.0")
                logs = list(self.state.glob("txn/*/log.txt"))
                self.assertTrue(any("host gate closed before apply" in p.read_text() for p in logs))
        self.behavior["components"]["tool-a"] = {}
        now = "2026-11-24T08:40:00Z"
        self.feed["generated_at"] = now
        self.probes(now, **{"paseo-idle": True, "host-load": True})
        self.run_and_wait(now=now)
        self.assertEqual(self.version_of("tool-a"), "1.3.0")
        self.assertEqual(self.sent(), [])

    def test_stop_switch_or_hold_during_stage_never_applies(self):
        reg = self.fleet / "auto-update" / "registry.json"
        sw = self.fleet / "auto-update" / "switch.json"
        held = copy.deepcopy(self.registry)
        held["components"] = [self.row("tool-a", 1, mode="hold")]
        changes = {"local STOP": [[str(self.state / "STOP"), ""]],
                   "switch stopped": [[str(sw), json.dumps({"schema": "loadout.auto-update.switch/1", "apply": "stopped"})]],
                   "row now hold": [[str(reg), json.dumps(held)]],
                   "registry unreadable": [[str(reg), "{not json"]]}
        for name, writes in changes.items():
            with self.subTest(name):
                (self.state / "STOP").unlink(missing_ok=True)
                self.switch("allowed")
                self.registry["components"] = [self.row("tool-a", 1)]
                self.behavior["components"]["tool-a"] = {"stage_write": writes, "stage_artifact": True}
                self.run_and_wait()
                self.assertEqual(self.version_of("tool-a"), "1.2.0")
                self.assertNotIn("tool-a apply", (self.fx / "calls.log").read_text())
                self.assertEqual(self.attempts(), {}, "not now: no attempt, no hold")
                self.assertEqual(self.sent(), [])
                logs = " ".join(p.read_text() for p in self.state.glob("txn/*/log.txt"))
                self.assertIn("before apply: ", logs)
                self.assertEqual(list(self.state.glob("txn/*/staged.bin")), [], "the staged download is gone")
        (self.state / "STOP").unlink(missing_ok=True)
        self.switch("allowed")
        self.behavior["components"]["tool-a"] = {}
        self.run_and_wait()
        self.assertEqual(self.version_of("tool-a"), "1.3.0", "the next allowed tick applies")

    def test_live_run_rechecks_on_the_real_clock(self):
        self.registry["components"] = [self.row("tool-a", 1, window={**ALWAYS, "end": "24:00"}, soak_hours=0)]
        self.feed["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.blackouts_off()
        done = self.cli("run", now=None)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.wait_idle()
        plan = json.loads(next(self.state.glob("txn/*/plan.json")).read_text())
        self.assertEqual(plan["clock_offset_ms"], 0)

    def test_all_day_window_keeps_the_sunday_blackout(self):
        self.registry["components"] = [self.row("tool-a", 1, window={**ALWAYS, "end": "24:00"})]
        for now, decision, reason in (("2026-11-25T04:59:30Z", "would-apply", ""),   # Tue 23:59:30 EST
                                      ("2026-11-29T10:30:00Z", "skip", "blackout"),   # Sun 05:30 EST
                                      ("2026-07-05T09:30:00Z", "skip", "blackout"),   # Sun 05:30 EDT
                                      ("2026-11-29T12:00:00Z", "would-apply", "")):  # Sun 07:00 EST
            with self.subTest(now):
                self.feed.update(generated_at=now, components={"tool-a": self.entry("1.3.0", seen="2026-06-01T00:00:00Z")})
                head, rows = self.plan(now=now)
                self.assertEqual(rows["tool-a"]["decision"], decision, rows["tool-a"])
                self.assertIn(reason, rows["tool-a"]["reason"])
                self.assertEqual(head["gates"], "closed" if reason else "open")

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
        os.kill(a["txn_proc"]["pid"], signal.SIGKILL if not WINDOWS else signal.SIGTERM)
        time.sleep(1)
        self.run_and_wait()
        self.run_and_wait()
        a = self.attempts()["h1/tool-a@1.3.0"]
        self.assertEqual((a["status"], a["interrupted_in"]), ("interrupted", "applying"))
        self.assertEqual(len(self.sent()), 1)
        self.assertIn("interrupted during applying; nothing was rolled back", self.sent()[0])
        self.assertEqual(len([l for l in (self.fx / "calls.log").read_text().splitlines() if "tool-a stage" in l]), 1)

    def wait_status(self, want, timeout=30):
        until = time.time() + timeout
        while True:
            a = self.attempts().get("h1/tool-a@1.3.0", {})
            if a.get("status") == want:
                return a
            self.assertLess(time.time(), until, a)
            time.sleep(0.1)

    def test_watchdog_budget_covers_apply_health_and_check(self):
        for name, row in {"too short": self.row("tool-a", 2, watchdog_seconds=20),
                          "default timeouts": dict(self.row("tool-a", 2, watchdog_seconds=900), timeouts={}),
                          "windows": dict(self.row("tool-a", 2), adapters={"windows": self.row("tool-a", 1)["adapters"][OS]})}.items():
            with self.subTest(name):
                self.registry["components"] = [row]
                done = self.cli("validate", now=None)
                self.assertEqual(done.returncode, 2)
                self.assertIn("watchdog", done.stderr)

    @unittest.skipIf(WINDOWS, "the rollback watchdog is POSIX only")
    def test_watchdog_rolls_back_a_crashed_transaction_once(self):
        self.behavior["components"]["tool-a"] = {"health_sleep": 3}
        self.registry["components"] = [self.row("tool-a", 2)]
        self.assertEqual(self.cli("run").returncode, 0)
        a = self.wait_status("health")
        os.kill(a["txn_proc"]["pid"], signal.SIGKILL)
        self.wait_idle(timeout=90)
        a = self.attempts()["h1/tool-a@1.3.0"]
        self.assertEqual(a["status"], "rolled-back-by-watchdog")
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.run_and_wait()
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "rolled-back-by-watchdog", "an ended attempt stays ended")
        self.assertEqual(len(self.sent()), 1, "one alert")
        self.assertIn("watchdog rolled back to 1.2.0", self.sent()[0])
        self.assertEqual((self.fx / "calls.log").read_text().count("tool-a rollback"), 1)

    @unittest.skipIf(WINDOWS, "the rollback watchdog is POSIX only")
    def test_watchdog_stops_a_stuck_transaction_before_restoring(self):
        self.behavior["components"]["tool-a"] = {"apply_sleep": 2}
        self.registry["components"] = [self.row("tool-a", 2)]
        self.assertEqual(self.cli("run").returncode, 0)
        a = self.wait_status("applying")
        os.kill(a["txn_proc"]["pid"], signal.SIGSTOP)  # stuck: alive, never deciding; its apply step still finishes
        self.wait_idle(timeout=90)
        a = self.attempts()["h1/tool-a@1.3.0"]
        self.assertEqual(a["status"], "rolled-back-by-watchdog")
        self.assertEqual(self.version_of("tool-a"), "1.2.0", "restored after the late apply, not before it")
        log = next(self.state.glob("txn/*/log.txt")).read_text()
        self.assertIn("stopping the transaction's process group", log)
        self.assertLess(log.index("stopping the transaction"), log.index('"rollback"'), "stopped first, then restored")
        self.run_and_wait()
        self.assertEqual(len(self.sent()), 1, "one alert, no interrupted line after it")
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "rolled-back-by-watchdog")

    @unittest.skipIf(WINDOWS, "the rollback watchdog is POSIX only")
    def test_watchdog_restores_only_once_every_step_process_is_gone(self):
        installed = self.fx / "tool-a.installed"
        # apply leaves a child that writes the new version 40 s later, after the 30 s watchdog has fired
        self.behavior["components"]["tool-a"] = {"apply_late_write": [[str(installed), "1.3.0\n", 40]], "health_sleep": 60}
        self.registry["components"] = [self.row("tool-a", 2)]
        self.assertEqual(self.cli("run").returncode, 0)
        a = self.wait_status("health")
        os.kill(a["txn_proc"]["pid"], signal.SIGSTOP)
        self.wait_idle(timeout=90)
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "rolled-back-by-watchdog")
        time.sleep(15)  # past the child's write time
        self.assertEqual(self.version_of("tool-a"), "1.2.0", "the step's child was stopped with the group, not left to write")
        self.assertEqual(len(self.sent()), 1)

    def test_apply_that_did_not_finish_is_held_and_never_restored(self):
        installed = self.fx / "tool-a.installed"
        cases = {  # apply has a 2 s timeout; the child it started changes the tool 4 s in
            "killed at its timeout": {"apply_sleep": 10, "apply_late_write": [[str(installed), "1.3.0\n", 4]]},
            "exited, child kept its output": {"apply_exit": 1, "apply_late_write": [[str(installed), "1.3.0\n", 4, True]]},
            "said not now, child kept its output": {"apply_exit": 75, "apply_late_write": [[str(installed), "1.3.0\n", 4, True]]},
        }
        if WINDOWS:  # a child there does not hold the step's output open, so a clean exit is all the runner sees
            cases = {k: v for k, v in cases.items() if "kept its output" not in k}
        for name, behavior in cases.items():
            with self.subTest(name):
                (self.state / "state.json").unlink(missing_ok=True)
                self.sent_reset()
                (self.fx / "calls.log").unlink(missing_ok=True)
                installed.write_text("1.2.0\n")
                self.behavior["components"]["tool-a"] = behavior
                self.registry["components"] = [dict(self.row("tool-a", 1), timeouts={"apply": 2})]
                self.run_and_wait()
                a = self.attempts()["h1/tool-a@1.3.0"]
                self.assertEqual(a["status"], "intervention-required")
                self.assertNotIn("tool-a rollback", (self.fx / "calls.log").read_text(), "nothing restored while the child may run")
                self.assertEqual(len(self.sent()), 1)
                self.assertIn("nothing was restored, backups kept, fix by hand", self.sent()[0])
                self.assertTrue((self.state / "txn" / a["txn"] / "plan.json").exists())
                time.sleep(4)
                self.run_and_wait()
                self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "intervention-required", "held, not retried")
                self.assertEqual(len(self.sent()), 1)
                self.assertNotIn("tool-a rollback", (self.fx / "calls.log").read_text())

    @unittest.skipIf(WINDOWS, "the rollback watchdog is POSIX only")
    def test_apply_that_did_not_finish_is_left_to_the_watchdog(self):
        installed = self.fx / "tool-a.installed"
        # apply is killed at its 5 s timeout; its child would change the tool 40 s in, after the 30 s watchdog
        self.behavior["components"]["tool-a"] = {"apply_sleep": 20, "apply_late_write": [[str(installed), "1.3.0\n", 40]]}
        self.registry["components"] = [self.row("tool-a", 2)]
        started = time.time()
        self.run_and_wait()
        self.wait_idle(timeout=90)
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "rolled-back-by-watchdog")
        self.assertIn("leaving the decision to the watchdog", next(self.state.glob("txn/*/log.txt")).read_text())
        time.sleep(max(0, started + 45 - time.time()))
        self.assertEqual(self.version_of("tool-a"), "1.2.0", "the child was stopped with the group before the restore")
        self.assertEqual(len(self.sent()), 1)

    @unittest.skipIf(WINDOWS, "the rollback watchdog is POSIX only")
    def test_watchdog_outcome_reaches_the_pm_once_after_the_registry_is_readable_again(self):
        self.behavior["components"]["tool-a"] = {"health_sleep": 3}
        self.registry["components"] = [self.row("tool-a", 2)]
        self.assertEqual(self.cli("run").returncode, 0)
        a = self.wait_status("health")
        reg, sw = self.fleet / "auto-update" / "registry.json", self.fleet / "auto-update" / "switch.json"
        reg.write_text("{not json")
        sw.write_text("{not json")
        os.kill(a["txn_proc"]["pid"], signal.SIGSTOP)
        self.wait_idle(timeout=90)
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "rolled-back-by-watchdog")
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        self.assertEqual(self.sent(), [], "nobody to send to yet")
        pending = json.loads((self.state / "state.json").read_text())["alerts"]["attempt:h1/tool-a@1.3.0"]
        self.assertFalse(pending["delivered"])
        self.assertIn("watchdog rolled back to 1.2.0", pending["line"])
        tick = [NODE, str(RUNNER), "run", "--host", "h1", "--now", NOW]
        subprocess.run(tick, env=self.env, capture_output=True, text=True, timeout=60)  # registry still unreadable
        self.assertEqual(self.sent(), [])
        self.write(reg, self.registry)  # readable again; the switch still is not
        for _ in range(2):
            done = subprocess.run(tick, env=self.env, capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.wait_idle()
        self.assertEqual(self.sent(), [pending["line"]], "delivered once")
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "rolled-back-by-watchdog")

    @unittest.skipIf(WINDOWS, "a symbolic link to the runner")
    def test_runner_started_by_a_link_keeps_its_lock(self):
        link = self.tmp / "linked" / "auto-update.mjs"
        link.parent.mkdir()
        link.symlink_to(RUNNER)
        self.registry["hosts"]["h1"]["preconditions"] = [self.gate("slow")]
        self.probes(NOW, slow=True)
        self.behavior["probe_sleeps"] = {"slow": 4}
        self.sync()
        first = subprocess.Popen([NODE, "linked/auto-update.mjs", "run", "--host", "h1", "--now", NOW], cwd=self.tmp, env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        until = time.time() + 20
        calls = self.fx / "calls.log"
        while not (calls.exists() and "probe slow" in calls.read_text()):
            self.assertLess(time.time(), until)
            time.sleep(0.05)
        second = self.cli("run")  # while the first evaluates its gates and holds the lock alone
        self.assertEqual((second.returncode, second.stdout), (0, ""), second.stderr)
        self.assertEqual((self.fx / "calls.log").read_text().count("probe slow"), 1, "the second run found the host busy")
        out, err = first.communicate(timeout=60)
        self.assertEqual(first.returncode, 0, err)
        self.wait_idle()
        self.assertEqual((self.fx / "calls.log").read_text().count("tool-a apply"), 1, "one runner, one transaction")
        self.assertEqual(self.version_of("tool-a"), "1.3.0")
        self.assertEqual(self.sent(), [])

    @unittest.skipIf(WINDOWS, "the rollback watchdog is POSIX only")
    def test_confirmed_change_disarms_the_watchdog(self):
        self.registry["components"] = [self.row("tool-a", 2)]
        self.cli("run")
        self.wait_idle(timeout=90)
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "applied")
        self.assertEqual(self.version_of("tool-a"), "1.3.0")
        self.assertNotIn("rollback", (self.fx / "calls.log").read_text())

    def test_error_after_apply_rolls_back_without_a_watchdog(self):
        state, saved = self.state / "state.json", self.fx / "state.saved"
        # The apply step breaks the state file (an error in the runner right after apply), the rollback mends it.
        self.behavior["components"]["tool-a"] = {"apply_copy": [[str(state), str(saved)]], "apply_write": [[str(state), "{broken"]],
                                                 "rollback_copy": [[str(saved), str(state)]]}
        self.registry["components"] = [self.row("tool-a", 1)]
        self.run_and_wait()
        self.assertEqual(self.version_of("tool-a"), "1.2.0")
        a = self.attempts()["h1/tool-a@1.3.0"]
        self.assertEqual(a["status"], "rolled-back")
        self.assertEqual(len(self.sent()), 1)
        self.assertIn("transaction error after apply; rolled back to 1.2.0", self.sent()[0])

    def test_pre_apply_artifacts_go_and_recovery_files_stay(self):
        self.registry["components"] = [self.row("tool-a", 1)]
        self.behavior["components"]["tool-a"] = {"stage_artifact": True, "stage_exit": 75}  # busy: not now after the download
        self.run_and_wait()
        self.assertEqual(self.attempts(), {})
        dirs = list(self.state.glob("txn/*"))
        self.assertEqual(len(dirs), 1)
        self.assertEqual(sorted(p.name for p in dirs[0].iterdir()), ["log.txt", "plan.json", "txn.out"])
        # Interrupted while staging: the next tick holds it and removes the download.
        self.behavior["components"]["tool-a"] = {"stage_artifact": True, "stage_sleep": 60}
        self.assertEqual(self.cli("run").returncode, 0)
        a = self.wait_status("staging")
        os.kill(a["txn_proc"]["pid"], signal.SIGKILL if not WINDOWS else signal.SIGTERM)
        time.sleep(1)
        self.run_and_wait()
        self.assertEqual(self.attempts()["h1/tool-a@1.3.0"]["status"], "interrupted")
        self.assertEqual(list(self.state.glob("txn/*/staged.bin")), [])
        # A week on, the dropped attempt's directory goes; the held one's stays.
        old = time.time() - 8 * 86400
        for d in self.state.glob("txn/*"):
            os.utime(d, (old, old))
        self.run_and_wait()
        kept = [d.name for d in self.state.glob("txn/*")]
        self.assertEqual(kept, [self.attempts()["h1/tool-a@1.3.0"]["txn"]])

    def sleeper(self):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        self.addCleanup(p.kill)
        return p.pid

    def test_reused_pid_or_restart_is_interrupted_not_a_stall(self):
        dirname = "20261120T080000Z-tool-a-0a0b0c"
        txn = self.state / "txn" / dirname
        txn.mkdir(parents=True)
        for name, boot_delta, words in (("pid reused", 0, "interrupted during applying"), ("host restarted", -86400e3, "the host restarted during applying")):
            with self.subTest(name):
                (self.state / "state.json").unlink(missing_ok=True)
                self.sent_reset()
                pid = self.sleeper()  # an unrelated process that now has the transaction's PID
                rec = {"pid": pid, "marks": [str(RUNNER), "txn", str(txn)]}
                (self.state / "lock").mkdir(exist_ok=True)
                (self.state / "lock" / "owner.json").write_text(json.dumps({"procs": [rec], "at": "2026-11-20T08:00:00Z"}))
                real_boot = json.loads(subprocess.run([NODE, "-e", "const os=require('os');console.log(JSON.stringify(Math.round(Date.now()-os.uptime()*1000)))"],
                                                      capture_output=True, text=True).stdout)
                self.write(self.state / "state.json", {"schema": "loadout.auto-update.state/1", "applied": [], "alerts": {},
                    "attempts": {"h1/tool-a@1.3.0": {"status": "applying", "host": "h1", "component": "tool-a", "group": None,
                                 "local_date": "2026-11-20", "txn": dirname, "boot": real_boot + boot_delta, "txn_proc": rec, "watchdog_proc": None}}})
                self.run_and_wait()
                self.run_and_wait()
                a = self.attempts()["h1/tool-a@1.3.0"]
                self.assertEqual(a["status"], "interrupted")
                self.assertEqual(len(self.sent()), 1)
                self.assertIn(words, self.sent()[0])
                self.assertIn("nothing was rolled back", self.sent()[0])
                self.assertEqual(self.version_of("tool-a"), "1.2.0", "a held version is not retried")

    def test_lock_of_an_unidentifiable_process_alerts_once_when_it_outlives_any_transaction(self):
        self.state.mkdir(parents=True)
        (self.state / "lock").mkdir()
        owner = self.state / "lock" / "owner.json"
        ago = lambda hours: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - hours * 3600))
        pid = self.sleeper()
        owner.write_text(json.dumps({"pids": [pid], "at": ago(1)}))
        self.assertEqual(self.cli("run").returncode, 0)
        self.assertEqual(self.sent(), [], "an hour-old lock: busy, silent")
        since = ago(9)
        owner.write_text(json.dumps({"pids": [pid], "at": since}))
        for _ in range(2):
            self.assertEqual(self.cli("run").returncode, 0)
        self.assertEqual(len(self.sent()), 1)
        self.assertIn(f"host lock held since {since} by a process that cannot be identified", self.sent()[0])
        self.assertEqual(self.version_of("tool-a"), "1.2.0", "never taken over on a guess")

    def test_windows_host_notifier_is_an_executable(self):
        own = self.tmp / "own-notify"
        own.mkdir()
        (own / "behavior.json").write_text("{}")
        for h in self.registry["hosts"].values():  # each host its own notifier, the fleet-wide one a bare name (a .cmd shim on Windows)
            h["notify_command"] = ["{node}", str(FAKE), str(own), "paseo"]
        self.registry["notify"]["command"] = ["paseo"]
        self.registry["hosts"]["win"] = {"os": "windows", "tz": "America/New_York", "allow": []}
        done = self.cli("validate", now=None)
        self.assertEqual(done.returncode, 2)
        self.assertIn("registry.hosts.win.notify_command: on Windows", done.stderr)
        self.registry["hosts"]["win"]["notify_command"] = ["{node}", "~/AppData/Local/example/paseo"]
        self.assertEqual(self.cli("validate", now=None).returncode, 0)
        # One held failure reaches the PM through the host's own notifier (node and the CLI's script, no shell).
        del self.registry["hosts"]["win"]
        self.behavior["components"]["tool-a"] = {"health_exit": 1}
        self.registry["components"] = [self.row("tool-a", 1)]
        self.run_and_wait()
        self.run_and_wait()
        got = (own / "sent.log").read_text().splitlines()
        self.assertEqual(len(got), 1)
        self.assertIn("auto-update HOLD h1/tool-a@1.3.0", got[0])
        self.assertEqual(self.sent(), [], "not through the fleet-wide command")

    @unittest.skipIf(WINDOWS, "tier 2 needs the POSIX-only rollback watchdog")
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

    @unittest.skipIf(WINDOWS, "tier 2 needs the POSIX-only rollback watchdog")
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
        # A copy, private as the runner requires whatever the checkout's umask was.
        fleet = self.tmp / "example-fleet"
        shutil.copytree(EXAMPLE, fleet / "auto-update")
        for p in (fleet / "auto-update").iterdir():
            p.chmod(0o600)
        env = dict(self.env, LOADOUT_FLEET=str(fleet))
        done = subprocess.run([NODE, str(RUNNER), "validate"], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        # The CLI hold: every host's Claude Code and Codex CLI rows stay hold.
        for host in ("laptop macos", "devbox linux", "winbox windows", "desktop windows"):
            line = next(l for l in done.stdout.splitlines() if l.startswith(host + ":"))
            self.assertIn("claude-code(t1,hold) codex-cli(t1,hold)", line)


if __name__ == "__main__":
    unittest.main()

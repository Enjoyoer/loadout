"""Scratch fixtures for auto-update feed and canary receipt transport (auto_update_relay.py over the fleet's ssh
envelope to auto_update_relay_remote.js) and for the host idle probes' fail-closed contracts. Fake ssh, synthetic
homes; nothing real is read or written."""

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills/orchestration/personal-skills/scripts"
RELAY = SCRIPTS / "auto_update_relay.py"
RECEIVER = SCRIPTS / "auto_update_relay_remote.js"
RUNNER = SCRIPTS / "auto-update" / "auto-update.mjs"
PROBE = SCRIPTS / "auto-update" / "adapters" / "host-idle.mjs"
FAKE = Path(__file__).resolve().parent / "auto_update_fake.mjs"
TXN = "20261123T200000Z-tool-a-a1b2c3"
NODE = shutil.which("node")
OS = {"darwin": "macos", "linux": "linux", "win32": "windows"}[sys.platform]
WINDOWS = sys.platform == "win32"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet  # noqa: E402
from fake_commands import install_fake_ssh, with_fake_ssh  # noqa: E402


def stamp(delta_minutes=0.0):
    t = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) + dt.timedelta(minutes=delta_minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


class TransportBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="au-relay-"))
        self.fake = self.tmp / "fake"
        self.fleet = self.tmp / "fleet"
        (self.fleet / "auto-update").mkdir(parents=True)
        self.src_home = self.tmp / "src-home"
        self.src_home.mkdir()
        self.feed_path = self.tmp / "available.json"
        self.receipt_path = self.tmp / "receipt.json"
        self.ssh = install_fake_ssh(self.tmp / "bin")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("XDG_", "LOADOUT_", "PASEO_"))}
        self.env.update(FAKE_ROOT=str(self.fake), LOADOUT_FLEET=str(self.fleet), HOME=str(self.src_home),
                        USERPROFILE=str(self.src_home))
        # On Windows the receiver's state root is %LOCALAPPDATA%, which the fake ssh passes through unchanged.
        self.env["LOCALAPPDATA"] = str(self.fake / "hosts" / "h1" / "AppData" / "Local")
        self.src_state = (Path(self.env["LOCALAPPDATA"]) if WINDOWS else self.src_home / ".local" / "state") / "loadout" / "auto-update"
        self.registry = {
            "schema": "loadout.auto-update.registry/1",
            "feed": {"path": str(self.feed_path), "max_age_hours": 36, "source_host": "src"},
            "notify": {"command": ["paseo"], "labels": ["role=pm"]},
            "hosts": {"src": {"os": OS, "tz": "America/New_York", "allow": ["tool-a"]},
                      "h1": {"os": OS, "tz": "America/New_York", "allow": ["tool-a"], "ssh": "h1"},
                      "h2": {"os": OS, "tz": "America/New_York", "allow": ["tool-a"], "ssh": "h2"}},
            "components": [{"component": "tool-a", "tier": 1, "mode": "hold", "hosts": ["src", "h1", "h2"],
                            "version_pattern": "^[0-9.]+$", "bounds": {"max_bump": "minor"},
                            "window": {"tz": "America/New_York", "days": ["sun"], "start": "00:00", "end": "24:00"},
                            "soak_hours": 0, "canary": {"host": "src", "receipt": str(self.receipt_path), "max_age_hours": 48},
                            "adapters": {OS: {"check": {"argv": [NODE, "-e", "console.log('tool-a 1.2.0')"], "regex": "^tool-a (.*)$"}}}}],
        }
        self.write(self.fleet / "auto-update" / "registry.json", self.registry)
        self.publish(stamp(-5))
        self.receipt(stamp(-3))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, path, doc):
        path.write_text(json.dumps(doc))
        if not WINDOWS:
            path.chmod(0o600)

    def publish(self, generated_at, version="1.3.0"):
        self.write(self.feed_path, {"schema": "loadout.auto-update.available/1", "generated_at": generated_at,
                                    "publisher": "version-watch", "components": {
                                        "tool-a": {"version": version, "first_seen_at": generated_at, "security": False}}})

    def receipt(self, finished_at, result="pass", attempt="applied"):
        """A receipt and the source host's own record of the canary transaction that wrote it."""
        self.write(self.receipt_path, {"schema": "loadout.auto-update.canary/1", "component": "tool-a", "version": "1.3.0",
                                       "host": "src", "result": result, "finished_at": finished_at, "txn": TXN})
        self.src_state.mkdir(parents=True, exist_ok=True)
        if not WINDOWS:
            self.src_state.chmod(0o700)
        attempts = {"src/tool-a@1.3.0": {"status": attempt, "txn": TXN}} if attempt else {}
        self.write(self.src_state / "state.json", {"schema": "loadout.auto-update.state/1", "attempts": attempts,
                                                   "applied": [], "alerts": {}})

    def state(self, host):
        if WINDOWS:
            return self.fake / "hosts" / host / "AppData" / "Local" / "loadout" / "auto-update"
        return self.fake / "hosts" / host / ".local" / "state" / "loadout" / "auto-update"

    def host_env(self, host):
        return dict(self.env, HOME=str(self.fake / "hosts" / host), USERPROFILE=str(self.fake / "hosts" / host))

    def push(self, *args):
        done = subprocess.run(with_fake_ssh(RELAY, self.ssh, "push", *args), env=self.env, capture_output=True,
                              text=True, timeout=120)
        return done.returncode, done.stdout + done.stderr

    def receive(self, host, payload):
        """The receiver as a target host, with a crafted payload, through the same digest-checked envelope."""
        raw, digest = fleet.envelope(RECEIVER, payload)
        done = subprocess.run([NODE, "-e", fleet.BOOT, "--", digest], input=raw, capture_output=True, text=True,
                              env=self.host_env(host), timeout=60)
        return fleet.parse_result(done.stdout)

    def exported(self, target="h1"):
        done = subprocess.run([NODE, str(RUNNER), "export", "--host", "src", "--for", target], env=self.env,
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        return [json.loads(line) for line in done.stdout.splitlines()][1:]

    def plan_on(self, host):
        done = subprocess.run([NODE, str(RUNNER), "plan", "--host", host], env=self.host_env(host),
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = [json.loads(line) for line in done.stdout.splitlines()]
        return lines[0], {line["component"]: line for line in lines[1:]}


@unittest.skipUnless(NODE, "node is required")
class Transport(TransportBase):
    def test_push_writes_owner_only_copies_atomically_then_same(self):
        (self.fake / "hosts" / "h1").mkdir(parents=True)
        code, out = self.push("--host", "h1")
        self.assertEqual(code, 0, out)
        self.assertIn("h1: updated; written feed, canary/tool-a", out)
        relay = self.state("h1") / "relay"
        files = [relay / "available.json", relay / "canary" / "tool-a.json"]
        for f in files:
            self.assertTrue(f.is_file())
        self.assertEqual([p.name for p in relay.rglob("*") if p.name.endswith(".tmp")], [], "no temp file left")
        if not WINDOWS:
            for d in (self.state("h1"), relay, relay / "canary"):
                self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o700)
            for f in files:
                self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600)
        copy = json.loads(files[0].read_text())
        self.assertEqual(base64.b64decode(copy["data"]), self.feed_path.read_bytes(), "exact original bytes")
        self.assertEqual((copy["source_host"], copy["for_host"]), ("src", "h1"))
        head, rows = self.plan_on("h1")
        self.assertEqual(head["feed"], "ok")
        self.assertEqual(rows["tool-a"]["candidate"], "1.3.0")
        code, out = self.push("--host", "h1")
        self.assertEqual(code, 0, out)
        self.assertIn("h1: same; same feed, canary/tool-a", out)

    def test_dry_run_writes_nothing(self):
        (self.fake / "hosts" / "h1").mkdir(parents=True)
        code, out = self.push("--dry-run", "--host", "h1")
        self.assertEqual(code, 0, out)
        self.assertIn("h1: would update; written feed, canary/tool-a", out)
        self.assertFalse(self.state("h1").exists())

    def test_invalid_inputs_are_not_sent(self):
        self.publish(stamp(-40 * 60))  # 40 hours old
        self.receipt(stamp(-3), result="maybe")
        (self.fake / "hosts" / "h1").mkdir(parents=True)
        code, out = self.push("--host", "h1")
        self.assertEqual(code, 1)
        self.assertIn("not sent feed: feed stale", out)
        self.assertIn("not sent canary/tool-a: canary receipt result invalid", out)
        self.assertIn("nothing valid to send", out)
        self.assertFalse(self.state("h1").exists())

    def test_replay_stale_and_conflicting_copies_are_refused(self):
        (self.fake / "hosts" / "h1").mkdir(parents=True)
        old = self.exported()
        self.publish(stamp(-1))
        new = self.exported()
        self.assertEqual(self.receive("h1", {"dry_run": False, "for_host": "h1", "docs": new})["status"], "updated")
        r = self.receive("h1", {"dry_run": False, "for_host": "h1", "docs": old[:1]})
        self.assertIn("older than the copy here (replay)", json.dumps(r["rejected"]))
        # Same document time, other bytes.
        self.publish(json.loads(base64.b64decode(new[0]["doc"]["data"]))["generated_at"], version="1.3.1")
        r = self.receive("h1", {"dry_run": False, "for_host": "h1", "docs": self.exported()[:1]})
        self.assertIn("differs from the copy here at the same time", json.dumps(r["rejected"]))
        # A captured envelope replayed later.
        late = json.loads(json.dumps(new))
        late[0]["doc"]["sent_at"] = stamp(-20)
        r = self.receive("h1", {"dry_run": False, "for_host": "h1", "docs": late[:1]})
        self.assertIn("not sent just now", json.dumps(r["rejected"]))
        kept = json.loads((self.state("h1") / "relay" / "available.json").read_text())
        self.assertEqual(kept["sha256"], new[0]["doc"]["sha256"], "refusals leave the copy here")

    def test_malformed_and_misaddressed_copies_are_refused(self):
        (self.fake / "hosts" / "h1").mkdir(parents=True)
        good = self.exported()

        def doc(change, which=0):
            d = json.loads(json.dumps(good[which]))
            change(d)
            return d
        cases = {
            "not a relay name": doc(lambda d: d.update(name="canary/../../etc")),
            "copy is for another host": doc(lambda d: d["doc"].update(for_host="h2")),
            "digest mismatch": doc(lambda d: d["doc"].update(sha256="0" * 64)),
            "malformed copy": doc(lambda d: d["doc"].update(path="/tmp/x")),
            "document stale": doc(lambda d: d.update(max_age_hours=0.01)),
            "receipt is for another component or host": doc(lambda d: d.update(name="canary/tool-b"), 1),
        }
        r = self.receive("h1", {"dry_run": False, "for_host": "h1", "docs": list(cases.values())})
        got = {x["why"] for x in r["rejected"]}
        for why in cases:
            self.assertTrue(any(why in g for g in got), (why, got))
        self.assertEqual(r["written"], [])
        self.assertFalse(self.state("h1").exists())

    @unittest.skipIf(WINDOWS, "POSIX ownership and links")
    def test_destination_must_be_owner_only_and_not_a_link(self):
        (self.fake / "hosts" / "h1").mkdir(parents=True)
        good = self.exported()
        state = self.state("h1")
        state.mkdir(parents=True, mode=0o700)
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        (state / "relay").symlink_to(elsewhere)
        r = self.receive("h1", {"dry_run": False, "for_host": "h1", "docs": good})
        self.assertIn("not a plain directory", json.dumps(r))
        self.assertEqual(list(elsewhere.iterdir()), [])
        (state / "relay").unlink()
        (state / "relay").mkdir()
        (state / "relay").chmod(0o755)
        r = self.receive("h1", {"dry_run": False, "for_host": "h1", "docs": good})
        self.assertIn("not owner-only", json.dumps(r))

    @unittest.skipIf(WINDOWS, "one state root per test on Windows")
    def test_a_copy_for_another_host_is_not_read(self):
        (self.fake / "hosts" / "h1").mkdir(parents=True)
        self.assertEqual(self.push("--host", "h1")[0], 0)
        h2 = self.state("h2")
        h2.parent.mkdir(parents=True)
        shutil.copytree(self.state("h1"), h2)  # a misdirected or hand-copied file
        head, rows = self.plan_on("h2")
        self.assertIn("made for another host", head["feed"])
        self.assertIn("made for another host", head["feed"])


@unittest.skipIf(WINDOWS, "the publishing host is POSIX; one state root per test on Windows")
@unittest.skipUnless(NODE, "node is required")
class RelayTick(TransportBase):
    """The source host's scheduler tick: runner run, then relay tick, with real canary transactions (fake tool)."""

    def setUp(self):
        super().setUp()
        self.receipt_path.unlink()
        (self.src_state / "state.json").unlink()
        self.fx = self.tmp / "fx"
        for host in ("src", "h1", "notify"):
            (self.fx / host).mkdir(parents=True)
            self.behave(host, {})
            (self.fx / host / "tool-a.installed").write_text("1.2.0")
        fake = [NODE, str(FAKE), str(self.fx / "{host}"), "tool-a"]
        row = self.registry["components"][0]
        row.update(mode="apply", hosts=["src", "h1"], window={**row["window"], "days": ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]})
        row["canary"]["max_age_hours"] = 1
        row["adapters"] = {OS: {"check": {"argv": fake + ["version"], "regex": "^tool-a ([0-9.]+)$"},
                                "stage": [fake + ["stage", "{version}"]], "precheck": [fake + ["precheck", "{version}"]],
                                "apply": fake + ["apply", "{version}"], "health": [fake + ["health"]],
                                "rollback": fake + ["rollback", "{installed}"]}}
        self.registry["hosts"]["src"]["allow"] = self.registry["hosts"]["h1"]["allow"] = ["tool-a"]
        del self.registry["hosts"]["h2"]
        self.registry["notify"] = {"command": [NODE, str(FAKE), str(self.fx / "notify"), "paseo"], "labels": ["role=pm"]}
        self.write(self.fleet / "auto-update" / "registry.json", self.registry)
        self.write(self.fleet / "auto-update" / "switch.json", {"schema": "loadout.auto-update.switch/1", "apply": "allowed"})
        self.ssh_log = self.tmp / "ssh.log"
        self.env["FAKE_SSH_LOG"] = str(self.ssh_log)
        (self.fake / "hosts" / "h1").mkdir(parents=True)

    def behave(self, host, b):
        (self.fx / host / "behavior.json").write_text(json.dumps({"components": {"tool-a": b}, "probe": {"ok": True}}))

    def calls(self, host, step):
        log = self.fx / host / "calls.log"
        return [l for l in log.read_text().splitlines() if f"tool-a {step}" in l] if log.exists() else []

    def ssh_calls(self):
        return len(self.ssh_log.read_text().splitlines()) if self.ssh_log.exists() else 0

    def run_src(self):
        done = subprocess.run([NODE, str(RUNNER), "run", "--host", "src", "--wait"], env=self.env, capture_output=True,
                              text=True, timeout=120)
        self.assertEqual((done.returncode, done.stdout), (0, ""), done.stderr)

    def tick(self, host="src"):
        done = subprocess.run(with_fake_ssh(RELAY, self.ssh, "tick", "--self", host, "--node", NODE), env=self.env,
                              capture_output=True, text=True, timeout=120)
        return done.returncode, done.stdout + done.stderr

    def src_attempt(self):
        return json.loads((self.src_state / "state.json").read_text())["attempts"].get("src/tool-a@1.3.0")

    def test_tick_relays_a_completed_canary_once_with_its_exact_version(self):
        code, out = self.tick()
        self.assertIn("h1: not sent canary/tool-a: no receipt yet", out)
        self.assertIn("h1: updated; written feed", out)
        self.assertEqual(self.ssh_calls(), 1)
        _, rows = self.plan_on("h1")
        self.assertEqual(rows["tool-a"]["reason"], "canary receipt missing")
        self.assertEqual(self.tick(), (0, ""), "nothing changed: nothing sent")
        self.assertEqual(self.ssh_calls(), 1)
        self.run_src()  # --wait: the canary transaction has ended when run returns
        self.assertEqual(self.src_attempt()["status"], "applied")
        r = json.loads(self.receipt_path.read_text())
        self.assertEqual((r["version"], r["result"], r["txn"]), ("1.3.0", "pass", self.src_attempt()["txn"]))
        code, out = self.tick()
        self.assertEqual(code, 0, out)
        self.assertIn("h1: updated; written canary/tool-a; same feed", out)
        head, rows = self.plan_on("h1")
        self.assertEqual((rows["tool-a"]["decision"], rows["tool-a"]["candidate"]), ("would-apply", "1.3.0"))
        # A newer feed: the receipt proves 1.3.0 only.
        self.publish(stamp(-1), version="1.3.1")
        code, out = self.tick()
        self.assertIn("h1: updated; written feed; same canary/tool-a", out)
        _, rows = self.plan_on("h1")
        self.assertEqual(rows["tool-a"]["reason"], "canary proved 1.3.0, not 1.3.1")
        # The receipt goes stale on the target by its own clock (max_age_hours 1 here).
        self.publish(stamp(-1))
        self.tick()
        later = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        done = subprocess.run([NODE, str(RUNNER), "plan", "--host", "h1", "--now", later], env=self.host_env("h1"),
                              capture_output=True, text=True, timeout=60)
        self.assertIn("canary receipt too old", done.stdout)
        # The CLI hold: a hold row applies nothing whatever the feed and the receipt say.
        self.registry["components"][0]["mode"] = "hold"
        self.write(self.fleet / "auto-update" / "registry.json", self.registry)
        _, rows = self.plan_on("h1")
        self.assertEqual(rows["tool-a"]["reason"], "mode hold")
        done = subprocess.run([NODE, str(RUNNER), "run", "--host", "h1", "--wait"], env=self.host_env("h1"),
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.calls("h1", "stage"), [])

    def test_receipts_come_only_from_a_completed_canary_transaction(self):
        (self.fx / "src" / "tool-a.installed").write_text("1.3.0")  # found installed already (by hand, or discovery)
        self.run_src()
        self.assertFalse(self.receipt_path.exists(), "a version found installed yields no receipt")
        _, out = self.tick()
        self.assertIn("h1: not sent canary/tool-a: no receipt yet", out)
        cases = {"receipt not from a completed canary transaction here": ("pass", None),
                 "receipt result does not match the transaction (applied)": ("fail", "applied"),
                 "receipt result does not match the transaction (interrupted)": ("pass", "interrupted")}
        for why, (result, attempt) in cases.items():
            with self.subTest(why):
                self.receipt(stamp(-1), result=result, attempt=attempt)
                code, out = self.push("--host", "h1")
                self.assertIn(f"h1: not sent canary/tool-a: {why}", out)
        self.assertFalse((self.state("h1") / "relay" / "canary").exists())

    def test_relay_retry_resends_data_never_a_failed_apply(self):
        self.behave("src", {"health_exit": 1})
        self.run_src()
        self.assertEqual(self.src_attempt()["status"], "rolled-back")
        self.assertEqual(json.loads(self.receipt_path.read_text())["result"], "fail")
        (self.fake / "down-h1").write_text("")
        code, out = self.tick()
        self.assertEqual(code, 1)
        self.assertIn("h1: FAILED", out)
        code, out = self.tick()
        self.assertIn("h1: FAILED", out, "an unanswered send is tried again next tick")
        (self.fake / "down-h1").unlink()
        code, out = self.tick()
        self.assertEqual(code, 0, out)
        self.assertIn("written feed, canary/tool-a", out)
        self.assertEqual(self.tick(), (0, ""))
        for _ in range(2):
            self.run_src()
        self.assertEqual(self.src_attempt()["status"], "rolled-back", "the failed version stays held")
        self.assertEqual(len(self.calls("src", "stage")), 1, "never staged again")
        _, rows = self.plan_on("h1")
        self.assertEqual(rows["tool-a"]["reason"], 'canary result "fail"')
        done = subprocess.run([NODE, str(RUNNER), "run", "--host", "h1", "--wait"], env=self.host_env("h1"),
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.calls("h1", "stage"), [])

    def test_tick_is_quiet_on_any_other_host(self):
        self.assertEqual(self.tick("h1"), (0, ""))
        self.assertEqual(self.ssh_calls(), 0)


@unittest.skipUnless(NODE, "node is required")
class Probes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="au-probe-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def probe(self, *args, env=None):
        done = subprocess.run([NODE, str(PROBE), *args], capture_output=True, text=True, timeout=60,
                              env=dict(os.environ, **(env or {})))
        reading = json.loads(done.stdout) if done.returncode == 0 and done.stdout.strip() else None
        return done.returncode, reading, done.stderr

    def script(self, name, body):
        p = self.tmp / name
        p.write_text(body)
        return p

    def test_exit_gate_maps_codes_and_fails_closed(self):
        gate = self.script("gate.py", "import json, sys\ncode, state = int(sys.argv[1]), sys.argv[2]\n"
                                      "print('noise' if state == 'nojson' else json.dumps({'state': state, 'in_flight': 0, 'quiet_min': 12.5, 'note': 'x'}))\n"
                                      "sys.exit(code)\n")
        run = lambda code, state: self.probe("exit-gate", "--", sys.executable, str(gate), str(code), state)
        code, r, err = run(0, "idle")
        self.assertEqual((code, r["ok"], r["metrics"]), (0, True, {"in_flight": 0, "quiet_min": 12.5}), err)
        code, r, _ = run(1, "busy")
        self.assertEqual((code, r["ok"]), (0, False))
        for bad in ((2, "unknown"), (0, "busy"), (1, "idle"), (0, "nojson"), (3, "idle")):
            with self.subTest(bad):
                self.assertEqual(run(*bad)[0], 1, "unknown, mismatched or malformed fails closed")

    @unittest.skipIf(WINDOWS, "lsof is POSIX")
    def test_listener_clients_needs_a_visible_listener(self):
        addr = "127.0.0.1:49999"
        head = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n"
        listen = head + f"node 10 u 14u IPv4 0x1 0t0 TCP {addr} (LISTEN)\\n"
        est = head + (f"node 11 u 23u IPv4 0x2 0t0 TCP 127.0.0.1:55022->{addr} (ESTABLISHED)\\n"
                      f"node 10 u 17u IPv4 0x3 0t0 TCP {addr}->127.0.0.1:55022 (ESTABLISHED)\\n")

        def lsof(listen_out, listen_code, est_out, est_code, err=""):
            p = self.script("lsof", "#!/bin/sh\ncase \"$3\" in\n"
                            f"  -sTCP:LISTEN) printf '{listen_out}'; exit {listen_code};;\n"
                            f"  -sTCP:ESTABLISHED) printf '{est_out}'; printf '{err}' >&2; exit {est_code};;\nesac\nexit 9\n")
            p.chmod(0o755)
            return self.probe("listener-clients", "--lsof", str(p), "--addr", addr)
        code, r, err = lsof(listen, 0, "", 1)
        self.assertEqual((code, r["ok"], r["metrics"]), (0, True, {"clients": 0}), err)
        code, r, _ = lsof(listen, 0, est, 0)
        self.assertEqual((code, r["ok"], r["metrics"]), (0, False, {"clients": 1}))
        for name, args in {"listener not visible": ("", 1, "", 1),
                           "stderr": (listen, 0, "", 1, "lsof: WARNING: cannot stat"),
                           "odd exit": (listen, 0, "", 2), "exit 1 with output": (listen, 0, "garbage\\n", 1)}.items():
            with self.subTest(name):
                self.assertEqual(lsof(*args)[0], 1, "visibility errors fail closed")

    def test_paseo_enumeration_must_be_complete_and_unambiguous(self):
        home = self.tmp / "paseo-home"
        (home / "agents" / "proj").mkdir(parents=True)
        me = os.getpid()
        (home / "paseo.pid").write_text(json.dumps({"pid": me}))
        listing = self.tmp / "ps.txt"
        agents_file = self.tmp / "agents.json"
        fake = self.script("fake_paseo.py", f"import sys\nsys.stdout.write(open({str(agents_file)!r}).read())\n")
        if WINDOWS:
            cli = self.script("paseo.cmd", f'@"{sys.executable}" "{fake}" %*\n')
        else:
            cli = self.script("paseo", f"#!/bin/sh\nexec '{sys.executable}' '{fake}' \"$@\"\n")
            cli.chmod(0o755)

        def check(agents, ps, stored=()):
            agents_file.write_text(agents if isinstance(agents, str) else json.dumps(agents))
            listing.write_text(ps)
            for f in (home / "agents" / "proj").iterdir():
                f.unlink()
            for i, rec in enumerate(stored):
                (home / "agents" / "proj" / f"r{i}.json").write_text(rec if isinstance(rec, str) else json.dumps(rec))
            return self.probe("paseo", "--paseo", str(cli), "--home", str(home), env={"AUTO_UPDATE_TEST_PS": str(listing)})
        one = f"{me} Paseo Supervisor\n123 something else\n"
        idle = [{"id": "a", "status": "idle"}, {"id": "b", "status": "closed"}, {"id": "c", "status": "error"}]
        code, r, err = check(idle, one, [{"id": "z", "lastStatus": "closed"}])
        self.assertEqual((code, r and r["ok"]), (0, True), err)
        code, r, _ = check(idle + [{"id": "d", "status": "running"}], one)
        self.assertEqual((r["ok"], r["metrics"]["active"]), (False, 1))
        code, r, _ = check(idle + [{"id": "d", "status": "weird"}], one)
        self.assertFalse(r["ok"], "an unknown status counts as a turn")
        ambiguous = {
            "second daemon": (idle, one + f"{me + 1} Paseo Supervisor\n", ()),
            "not the home's daemon": (idle, f"{me + 1} Paseo Supervisor\n", ()),
            "windows supervisor too": (idle, one + "77 node C:\\x\\supervisor-entrypoint.js\n", ()),
            "repeated agent": (idle + [{"id": "a", "status": "idle"}], one, ()),
            "stored running not listed": (idle, one, [{"id": "q", "lastStatus": "running"}]),
            "stored unreadable": (idle, one, ["{not json"]),
        }
        for name, args in ambiguous.items():
            with self.subTest(name):
                code, r, err = check(*args)
                self.assertEqual(code, 0, err)
                self.assertFalse(r["ok"])
                self.assertIn("ambiguous", r["detail"])
        for name, args in {"no statuses": ([{"id": "a"}], one, ()), "not JSON": ("oops", one, ())}.items():
            with self.subTest(name):
                self.assertEqual(check(*args)[0], 1)
        (home / "paseo.pid").unlink()
        self.assertEqual(check(idle, one)[0], 1, "no pid file: unknown")


if __name__ == "__main__":
    unittest.main()

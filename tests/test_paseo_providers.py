import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills/orchestration/personal-skills/scripts"
EXAMPLE = REPO / "skills/orchestration/personal-skills/fleet/example"
sys.path.insert(0, str(SCRIPTS))
import fleet  # noqa: E402
import paseo_providers  # noqa: E402

FAKE_SSH = textwrap.dedent("""\
    #!/bin/sh
    while [ "$1" = "-o" ] || [ "$1" = "-n" ]; do [ "$1" = "-o" ] && shift; shift; done
    [ "$1" = "--fake-ok" ] && { echo fake; exit 0; }
    host="$1"; shift
    echo "ssh $host" >> "$FAKE_ROOT/calls.log"
    [ -e "$FAKE_ROOT/cmd-limit" ] && [ "${#*}" -gt 8191 ] && { echo 'The command line is too long' >&2; exit 1; }
    [ -e "$FAKE_ROOT/corrupt-stdin" ] && { printf corrupt | HOME="$FAKE_ROOT/hosts/$host" sh -c "$*"; exit $?; }
    HOME="$FAKE_ROOT/hosts/$host" exec sh -c "$*"
    """)

# PASEO_HOST holds "offer:<host>"; without it the call targets the local daemon.
# Like the real CLI, it refuses PASEO_HOME together with PASEO_HOST. Files in
# FAKE_ROOT shape relay faults: drop-sends (count of send-keys to lose),
# quiet-captures (captures that return nothing), fail-create (the host makes
# the workspace but the call fails), fail-terminal, fail-archive.
FAKE_PASEO = textwrap.dedent(r"""
    #!/bin/sh
    host="${PASEO_HOST#offer:}"; [ -n "$PASEO_HOST" ] || host=local
    echo "paseo $host $*" >> "$FAKE_ROOT/calls.log"
    [ -n "$PASEO_HOME" ] && [ -n "$PASEO_HOST" ] && { echo "TARGET_AMBIGUOUS" >&2; exit 1; }
    ws="$FAKE_ROOT/workspaces"; touch "$ws"
    counter() { n=$(cat "$FAKE_ROOT/$1" 2>/dev/null || echo 0); [ "$n" -gt 0 ] && { echo $((n - 1)) > "$FAKE_ROOT/$1"; return 0; }; return 1; }
    case "$1 $2" in
      "--fake-ok "*) echo fake ;;
      "reload "*) [ -e "$FAKE_ROOT/fail-reload-$host" ] && { echo "request timed out" >&2; exit 1; }; echo reloaded ;;
      "workspace create") id="ws-$(($(wc -l < "$ws") + 1))"; echo "$id loadout-provider-sync" >> "$ws"
        [ -e "$FAKE_ROOT/fail-create" ] && { echo "request timed out" >&2; exit 1; }; echo "{\"workspaceId\":\"$id\"}" ;;
      "workspace ls") awk 'BEGIN{printf "["} {printf "%s{\"workspaceId\":\"%s\",\"name\":\"%s\"}", (NR>1?",":""), $1, $2} END{print "]"}' "$ws" ;;
      "workspace archive") [ -e "$FAKE_ROOT/fail-archive" ] && exit 1; grep -v "^$3 " "$ws" > "$ws.tmp"; mv "$ws.tmp" "$ws"; echo archived ;;
      "terminal create") [ -e "$FAKE_ROOT/fail-terminal" ] && { echo "terminal failed" >&2; exit 1; }
        : > "$FAKE_ROOT/term.out"; echo '{"id":"term-1"}' ;;
      "terminal send-keys")
        [ -e "$FAKE_ROOT/input-limit" ] && [ "${#4}" -gt 3000 ] && { echo 'relay input timeout' >&2; exit 1; }
        counter drop-sends && exit 0
        [ -e "$FAKE_ROOT/echo-only" ] && { printf '$ %s\n' "$4" | fold -w 50 >> "$FAKE_ROOT/term.out"; exit 0; }
        # Input sent while the shell is still starting is lost, as on a slow relay host.
        n=$(cat "$FAKE_ROOT/quiet-captures" 2>/dev/null || echo 0); [ "$n" -gt 0 ] && exit 0
        case "$4" in *'exec 3<'*)
          [ -e "$FAKE_ROOT/corrupt-relay" ] && for file in "$TMPDIR"/loadout-provider-*; do printf corrupt > "$file"; done ;;
        esac
        { printf '$ %s\n' "$4"; HOME="$FAKE_ROOT/hosts/$host" sh -c "$4" 2>&1; } | fold -w 50 >> "$FAKE_ROOT/term.out" ;;
      "terminal capture") counter quiet-captures && exit 0; [ -s "$FAKE_ROOT/term.out" ] && cat "$FAKE_ROOT/term.out" || echo '$ ' ;;
      "terminal kill") ;;
      *) echo "unexpected: $*" >&2; exit 9 ;;
    esac
    """).lstrip()

HOSTS = {
    "schema_version": 2,
    "source_host": "laptop",
    "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"], "sync": ["skills", "providers"]},
        {"name": "desktop", "os": "linux", "sync": ["providers"]},
        {"name": "tablet", "os": "linux", "transport": "paseo-relay", "sync": ["providers"],
         "paseo_offer": "offers/tablet.offer"},
        {"name": "devbox", "os": "linux", "clients": ["codex"]},
    ],
}

EXISTING = {
    "daemon": {"port": 1234},
    "agents": {"providers": {
        "claude": {"command": "claude", "env": {"EXTRA": "keep", "ANTHROPIC_BASE_URL": "https://tablet-own.example.test"},
                   "models": [{"id": "old", "label": "Old 1"}]},
        "opencode": {"models": [{"id": "local/x", "label": "X"}]},
    }},
}


def assert_fakes_run(env, names=("ssh", "paseo")):
    """A broken fake would let the real binary run, so refuse to continue."""
    for name in names:
        done = subprocess.run([name, "--fake-ok"], env=env, capture_output=True, text=True)
        if done.stdout.strip() != "fake":
            raise AssertionError(f"fake {name} is not the binary on PATH")


class ProviderSyncTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = self.root / "fleet"
        (self.fleet / "offers").mkdir(parents=True)
        (self.fleet / "hosts.json").write_text(json.dumps(HOSTS))
        shutil.copy(EXAMPLE / "paseo-providers.json", self.fleet / "paseo-providers.json")
        (self.fleet / "offers/tablet.offer").write_text("offer:tablet\n")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in (("ssh", FAKE_SSH), ("paseo", FAKE_PASEO)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        for host in ("laptop", "desktop", "tablet", "devbox"):
            config = self.config_path(host)
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps(EXISTING, indent=2))
        self.env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(self.root / "hosts/laptop"),
            "LOADOUT_FLEET": str(self.fleet),
            "FAKE_ROOT": str(self.root),
            "TMPDIR": str(self.root),
            # An agent session's variables must not reach the relay CLI.
            "PASEO_HOME": str(self.root / "agent-home"),
            "PASEO_AGENT_ID": "agent-1",
            "PASEO_AGENT_CWD": str(self.root),
            "LOADOUT_RELAY_POLL_SECONDS": "0.05",
            "LOADOUT_RELAY_WAIT_SECONDS": "3",
            "LOADOUT_RELAY_READY_SECONDS": "2",
            "LOADOUT_RELAY_SETTLE_SECONDS": "0",
            "LOADOUT_RELAY_RESEND_SECONDS": "0.5",
        }
        assert_fakes_run(self.env)

    def tearDown(self):
        self.tmp.cleanup()

    def config_path(self, host):
        return self.root / "hosts" / host / ".paseo/config.json"

    def config(self, host):
        return json.loads(self.config_path(host).read_text())

    def run_sync(self, *args):
        done = subprocess.run([sys.executable, str(SCRIPTS / "paseo_providers.py"), *args],
                              env=self.env, capture_output=True, text=True, timeout=60)
        return done.returncode, done.stdout + done.stderr

    def calls(self):
        path = self.root / "calls.log"
        return path.read_text() if path.exists() else ""

    def long_payload(self):
        catalog = json.loads((self.fleet / "paseo-providers.json").read_text())
        # Incompressible metadata models the generated runtime source payload.
        catalog["providers"]["codex"]["models"][0]["description"] = os.urandom(24000).hex()
        (self.fleet / "paseo-providers.json").write_text(json.dumps(catalog))
        return catalog

    def test_long_payload_windows_cmd_uses_stdin_and_is_idempotent(self):
        hosts = json.loads((self.fleet / "hosts.json").read_text())
        hosts["hosts"][1]["os"] = "windows"
        (self.fleet / "hosts.json").write_text(json.dumps(hosts))
        (self.root / "cmd-limit").touch()
        catalog = self.long_payload()
        code, out = self.run_sync("--host", "desktop", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.config("desktop"), EXISTING)
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.config("desktop")["agents"]["providers"]["codex"]["models"],
                         catalog["providers"]["codex"]["models"])
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertIn("write unchanged", out)

    def test_corrupt_ssh_payload_never_merges_or_reloads(self):
        (self.root / "corrupt-stdin").touch()
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 1, out)
        self.assertIn("provider transport failed", out)
        self.assertEqual(self.config("desktop"), EXISTING)
        self.assertNotIn("reload", self.calls())

    def test_long_relay_payload_is_bounded_verified_and_idempotent(self):
        (self.root / "input-limit").touch()
        catalog = self.long_payload()
        # First chunk is lost, then resent safely before later chunks run.
        (self.root / "drop-sends").write_text("1")
        with patch.dict(os.environ, self.env):
            runner = paseo_providers.Runner(HOSTS["hosts"][2], "laptop", self.fleet)
            program = fleet.pack(paseo_providers.MERGE_JS.read_bytes())
            data = fleet.pack(json.dumps(paseo_providers.payload(catalog, "tablet", "test", False)).encode())
            # Module constants were loaded before the subprocess test overrides.
            with patch.multiple(paseo_providers, RELAY_POLL_SECONDS=0.01, RELAY_WAIT_SECONDS=3,
                                RELAY_SETTLE_SECONDS=0, RELAY_RESEND_SECONDS=0.05):
                out = runner.write(program, data)
                self.assertTrue(fleet.parse_result(out)["changed"], out)
                out = runner.write(program, data)
                self.assertFalse(fleet.parse_result(out)["changed"], out)
        self.assertEqual(self.config("tablet")["agents"]["providers"]["codex"]["models"],
                         catalog["providers"]["codex"]["models"])
        self.assertEqual((self.root / "workspaces").read_text(), "")
        self.assertIn("conv=notrunc", self.calls())
        self.assertEqual(list(self.root.glob("loadout-provider-*")), [])

    def test_corrupt_long_relay_payload_is_removed_without_merge(self):
        (self.root / "input-limit").touch()
        (self.root / "corrupt-relay").touch()
        self.long_payload()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.config("tablet"), EXISTING)
        self.assertNotIn("reload", self.calls())
        self.assertEqual(list(self.root.glob("loadout-provider-*")), [])
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_dry_run_writes_nothing(self):
        code, out = self.run_sync("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn(f"fleet: env {self.fleet}", out)
        self.assertIn("skipped (no providers scope): devbox", out)
        self.assertEqual(out.count("would change (dry run)"), 3, out)
        self.assertEqual(out.count("reload skipped (dry run)"), 3, out)
        for host in ("laptop", "desktop", "tablet"):
            self.assertEqual(self.config(host), EXISTING)
        self.assertNotIn("reload", self.calls())

    def test_sync_merges_backs_up_and_reloads_each_transport(self):
        code, out = self.run_sync()
        self.assertEqual(code, 0, out)
        catalog = json.loads((self.fleet / "paseo-providers.json").read_text())["providers"]
        for host, base in (("laptop", "http://127.0.0.1:4000"), ("desktop", "https://router.example.test"),
                           ("tablet", "https://tablet-own.example.test")):
            got = self.config(host)
            self.assertEqual(got["daemon"], {"port": 1234})
            providers = got["agents"]["providers"]
            self.assertEqual(providers["opencode"], EXISTING["agents"]["providers"]["opencode"])
            self.assertEqual(providers["claude"]["command"], "claude")
            self.assertEqual(providers["claude"]["env"], {"EXTRA": "keep", "ANTHROPIC_BASE_URL": base})
            self.assertEqual(providers["claude"]["models"], catalog["claude"]["models"])
            self.assertEqual(providers["codex"]["models"], catalog["codex"]["models"])
            backups = list(self.config_path(host).parent.glob("config.json.bak-loadout-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(json.loads(backups[0].read_text()), EXISTING)
        self.assertIn("laptop (local): write CHANGED; labels verified; preserved [opencode]", out)
        self.assertIn("desktop (ssh): write CHANGED", out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        self.assertEqual(out.count("reload ok"), 3, out)
        calls = self.calls()
        self.assertIn("paseo local reload", calls)
        self.assertIn("ssh desktop", calls)
        self.assertIn("paseo tablet workspace archive ws-1", calls)
        self.assertIn("paseo tablet reload", calls)
        self.assertEqual(self.config("devbox"), EXISTING)

        code, out = self.run_sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("write unchanged; labels verified"), 3, out)
        self.assertEqual(len(list(self.config_path("laptop").parent.glob("config.json.bak-loadout-*"))), 1)

    def test_required_env_failure_still_cleans_up_relay(self):
        self.config_path("tablet").write_text(json.dumps({"agents": {"providers": {}}}))
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("tablet (paseo-relay): write FAILED: required env missing: claude.ANTHROPIC_BASE_URL", out)
        self.assertIn("workspace archive ws-1", self.calls())
        self.assertEqual(self.config("tablet"), {"agents": {"providers": {}}})

    def test_relay_waits_for_the_prompt_before_one_send(self):
        (self.root / "quiet-captures").write_text("4")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        self.assertEqual(self.calls().count("terminal send-keys"), 1)
        calls = self.calls().splitlines()
        send = next(i for i, line in enumerate(calls) if "send-keys" in line)
        self.assertEqual(sum("terminal capture" in line for line in calls[:send]), 5)

    def test_relay_resends_once_when_the_command_never_echoed(self):
        (self.root / "drop-sends").write_text("1")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        self.assertEqual(self.calls().count("terminal send-keys"), 2)

    def test_relay_resend_is_bounded_to_one(self):
        (self.root / "drop-sends").write_text("5")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.calls().count("terminal send-keys"), 2)
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_never_resends_an_echoed_command(self):
        (self.root / "echo-only").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.calls().count("terminal send-keys"), 1)
        self.assertIn("did not finish within 3s; last output:", out)
        self.assertIn("@@LOADOUT-EXIT-", out)

    def test_relay_never_ready_times_out_and_cleans_up(self):
        (self.root / "quiet-captures").write_text("999")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("relay terminal did not finish within 3s; last output: (terminal output empty)", out)
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_timeout_explains_and_cleans_up(self):
        (self.root / "drop-sends").write_text("99")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("relay terminal did not finish within 3s; last output: $", out)
        self.assertIn("terminal kill term-1", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "")
        self.assertEqual(self.config("tablet"), EXISTING)

    def test_relay_cleans_up_when_create_fails_after_the_host_made_it(self):
        (self.root / "fail-create").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("write FAILED: paseo workspace create: request timed out", out)
        self.assertIn("workspace archive ws-1", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_cleans_up_when_terminal_create_fails(self):
        (self.root / "fail-terminal").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("write FAILED: paseo terminal create: terminal failed", out)
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_relay_cleanup_failure_after_timeout_names_the_workspace(self):
        (self.root / "drop-sends").write_text("99")
        (self.root / "fail-archive").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("relay workspace cleanup failed: ws-1", out)

    def test_relay_sweeps_workspaces_left_by_a_killed_run(self):
        (self.root / "workspaces").write_text("ws-old loadout-provider-sync\nws-keep someone-else\n")
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("workspace archive ws-old", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "ws-keep someone-else\n")

    def test_sigterm_still_cleans_up_the_relay_workspace(self):
        (self.root / "drop-sends").write_text("99")
        self.env["LOADOUT_RELAY_WAIT_SECONDS"] = "30"
        proc = subprocess.Popen([sys.executable, str(SCRIPTS / "paseo_providers.py"), "--host", "tablet"],
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(200):
            if "send-keys" in self.calls():
                break
            time.sleep(0.05)
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=30)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("terminal kill term-1", self.calls())
        self.assertEqual((self.root / "workspaces").read_text(), "")

    def test_reload_failure_is_reported_apart_from_the_write(self):
        (self.root / "fail-reload-tablet").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("tablet (paseo-relay): write CHANGED", out)
        self.assertIn("tablet (paseo-relay): reload FAILED: request timed out; the write above still stands", out)

    def test_reload_failure_after_an_unchanged_write_is_a_warning(self):
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        (self.root / "fail-reload-tablet").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 0, out)
        self.assertIn("tablet (paseo-relay): write unchanged", out)
        self.assertIn("tablet (paseo-relay): reload warning (config unchanged, not a failure): request timed out", out)
        self.assertNotIn("FAILED", out)

    def test_relay_cleanup_failure_is_reported(self):
        (self.root / "fail-archive").touch()
        code, out = self.run_sync("--host", "tablet")
        self.assertEqual(code, 1, out)
        self.assertIn("relay workspace cleanup failed: ws-1", out)

    def test_host_selection(self):
        code, out = self.run_sync("--host", "nowhere")
        self.assertEqual(code, 2)
        self.assertIn("unknown host: nowhere", out)
        code, out = self.run_sync("--host", "devbox")
        self.assertEqual(code, 2)
        self.assertIn("does not have the providers sync scope", out)
        code, out = self.run_sync("--host", "desktop")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.config("laptop"), EXISTING)
        self.assertNotEqual(self.config("desktop"), EXISTING)


class ConfigValidationTest(unittest.TestCase):
    def setUp(self):
        self.fleet = fleet.validate(HOSTS)
        self.base = json.loads((EXAMPLE / "paseo-providers.json").read_text())
        self.base["hosts"] = {}

    def check(self, mutate, fragment):
        data = json.loads(json.dumps(self.base))
        mutate(data)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "paseo-providers.json"
            path.write_text(json.dumps(data))
            with self.assertRaises(fleet.FleetError) as caught:
                paseo_providers.load_config(path, self.fleet)
        self.assertIn(fragment, str(caught.exception))

    def test_example_catalog_is_valid_for_the_example_fleet(self):
        paseo_providers.load_config(EXAMPLE / "paseo-providers.json", fleet.load(EXAMPLE))

    def test_labels_are_names_only(self):
        def versioned(d): d["providers"]["claude"]["models"][0]["label"] = "Large 2"
        def with_id(d): d["providers"]["claude"]["models"][0]["label"] = d["providers"]["claude"]["models"][0]["id"]
        self.check(versioned, "must be a name only")
        self.check(with_id, "must be a name only")

    def test_duplicate_model_ids(self):
        def dup(d): d["providers"]["codex"]["models"].append(dict(d["providers"]["codex"]["models"][0], label="Other"))
        self.check(dup, "unique")

    def test_host_must_have_providers_scope(self):
        self.check(lambda d: d["hosts"].update(devbox={}), "hosts.devbox")

    def test_unknown_keys(self):
        self.check(lambda d: d.update(routers={}), "unknown keys ['routers']")
        self.check(lambda d: d["hosts"].update(tablet={"inherit": False}), "unknown keys ['inherit']")

    def test_payload_env_layers(self):
        data = json.loads((EXAMPLE / "paseo-providers.json").read_text())
        self.assertEqual(paseo_providers.payload(data, "tablet", "s", False)["env"], {})
        self.assertEqual(paseo_providers.payload(data, "desktop", "s", False)["env"],
                         {"claude": {"ANTHROPIC_BASE_URL": "https://router.example.test"}})

    def test_parse_wrapped_result(self):
        wrapped = '@@LOADOUT-RESULT {"host":"t","err\nor":null} @@END'
        self.assertEqual(paseo_providers.parse_result(wrapped), {"host": "t", "error": None})


if __name__ == "__main__":
    unittest.main()

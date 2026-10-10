import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "skills/orchestration/personal-skills/scripts"
EXAMPLE = REPO / "skills/orchestration/personal-skills/fleet/example"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_plugins_sync import FAKE_NPM  # noqa: E402

FAKE_SSH = textwrap.dedent("""\
    #!/bin/sh
    while [ "$1" = "-o" ] || [ "$1" = "-n" ]; do [ "$1" = "-o" ] && shift; shift; done
    [ "$1" = "--" ] && shift
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


def assert_fakes_run(env, names=("ssh", "paseo")):
    """A broken fake would let the real binary run, so refuse to continue."""
    for name in names:
        done = subprocess.run([name, "--fake-ok"], env=env, capture_output=True, text=True)
        if done.stdout.strip() != "fake":
            raise AssertionError(f"fake {name} is not the binary on PATH")


# Version lives in $HOME/claude-version; `claude update` installs 2.10.0.
FAKE_CLAUDE = textwrap.dedent(r"""
    #!/bin/sh
    [ "$1" = "--fake-ok" ] && { echo fake; exit 0; }
    case "$1" in
      --version) echo "$(cat "$HOME/claude-version") (Claude Code)" ;;
      update) echo 2.10.0 > "$HOME/claude-version" ;;
    esac
    """).lstrip()

HOSTS = {
    "schema_version": 2, "source_host": "laptop", "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"], "sync": ["skills", "providers", "client-config"],
         "exclude_skills": ["sample"]},
        {"name": "desktop", "os": "linux", "clients": ["codex", "claude"],
         "sync": ["skills", "plugins", "providers", "client-config"],
         "paseo": {"plugin_root": "~/plugins", "stage": ["orphan-project-sweeper"], "install": []}},
        {"name": "devbox", "os": "linux", "clients": ["codex"], "sync": ["skills", "client-config"]},
        {"name": "tablet", "os": "linux", "transport": "paseo-relay", "sync": ["providers"],
         "paseo_offer": "offers/tablet.offer"},
    ],
}


@unittest.skipIf(os.name == "nt", "fake ssh, paseo, npm and claude are POSIX shell scripts")
class SyncTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = self.root / "hosts/laptop/.config/loadout/fleet"
        (self.fleet / "offers").mkdir(parents=True)
        (self.fleet / "hosts.json").write_text(json.dumps(HOSTS, indent=2))
        (self.fleet / "offers/tablet.offer").write_text("offer:tablet\n")
        shutil.copy(EXAMPLE / "paseo-providers.json", self.fleet / "paseo-providers.json")
        providers = json.loads((self.fleet / "paseo-providers.json").read_text())
        providers["hosts"] = {"tablet": {"inherit_env": False}}
        (self.fleet / "paseo-providers.json").write_text(json.dumps(providers))
        catalog = json.loads((EXAMPLE / "client-config.json").read_text())
        catalog["token_file"] = str(self.root / "token")
        catalog["hosts"] = {}
        (self.root / "token").write_text("tok")
        (self.fleet / "client-config.json").write_text(json.dumps(catalog))
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in (("ssh", FAKE_SSH), ("paseo", FAKE_PASEO), ("npm", FAKE_NPM), ("claude", FAKE_CLAUDE)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        for host in ("laptop", "desktop", "devbox", "tablet"):
            home = self.root / "hosts" / host
            for d in (".paseo", ".claude", ".codex"):
                (home / d).mkdir(parents=True, exist_ok=True)
            (home / ".paseo/config.json").write_text("{}")
            (home / ".codex/config.toml").write_text('model = "m"\n')
            (home / "claude-version").write_text("2.5.0\n")
        self.env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.root / "hosts/laptop"),
                    "FAKE_ROOT": str(self.root), "LOADOUT_RELAY_POLL_SECONDS": "0.05",
                    "LOADOUT_RELAY_WAIT_SECONDS": "5"}
        assert_fakes_run(self.env, ("ssh", "paseo", "npm", "claude"))

    def tearDown(self):
        self.tmp.cleanup()

    def sync(self, *args):
        done = subprocess.run([sys.executable, str(SCRIPTS / "sync.py"), *args], env=self.env,
                              capture_output=True, text=True, timeout=300)
        return done.returncode, done.stdout + done.stderr

    def row(self, out, host):
        """Parse the summary table by column position, since cells can hold spaces."""
        lines = out.splitlines()
        start = max(i for i, line in enumerate(lines) if line.startswith("host "))
        header = lines[start]
        cols = [(m.group(), m.start()) for m in re.finditer(r"\S+", header)]
        line = next(l for l in lines[start + 1:] if l.split()[:1] == [host])
        bounds = [c[1] for c in cols] + [None]
        return {name: line[bounds[i]:bounds[i + 1]].strip() for i, (name, _) in enumerate(cols) if i > 0}

    def test_dry_run_then_sync_then_same(self):
        code, out = self.sync("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.row(out, "laptop"), {"fleet": "source", "skills": "would update", "plugins": "skipped",
                                                   "providers": "would update", "client-config": "would update"})
        self.assertEqual(self.row(out, "tablet"), {"fleet": "not needed", "skills": "skipped", "plugins": "skipped",
                                                   "providers": "would update", "client-config": "skipped"})
        self.assertIn("fleet valid: schema_version 2, 4 hosts (dry run)", out)
        self.assertFalse((self.root / "hosts/desktop/.config/loadout/fleet").exists())
        self.assertFalse((self.root / "hosts/desktop/.claude/skills").exists())

        code, out = self.sync()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.row(out, "desktop"), {"fleet": "updated", "skills": "updated", "plugins": "updated",
                                                    "providers": "updated", "client-config": "updated"})
        self.assertEqual(self.row(out, "tablet"), {"fleet": "not needed", "skills": "skipped", "plugins": "skipped",
                                                   "providers": "updated", "client-config": "skipped"})
        self.assertTrue((self.root / "hosts/desktop/.config/loadout/fleet/hosts.json").exists())
        self.assertTrue((self.root / "hosts/desktop/plugins/orphan-project-sweeper/node_modules").exists())
        self.assertFalse((self.root / "hosts/laptop/.claude/skills/sample").exists())

        code, out = self.sync()
        self.assertEqual(code, 0, out)
        for host in ("desktop", "devbox"):
            self.assertEqual(set(self.row(out, host).values()) - {"skipped"}, {"same"}, out)

    def test_conflict_stops_later_scopes_for_that_host_only(self):
        self.sync("--only", "fleet")
        (self.root / "hosts/devbox/.config/loadout/fleet/hosts.json").write_text("{}")
        code, out = self.sync()
        self.assertEqual(code, 1, out)
        self.assertEqual(self.row(out, "devbox"), {"fleet": "conflict", "skills": "stopped", "plugins": "skipped",
                                                   "providers": "skipped", "client-config": "stopped"})
        self.assertEqual(self.row(out, "desktop")["client-config"], "updated")
        self.assertIn("stopped after a conflict, a fleet failure, or a failed shared preflight: devbox", out)
        self.assertFalse((self.root / "hosts/devbox/.codex/skills").exists())

    def test_only_and_host(self):
        code, out = self.sync("--only", "skills,client-config", "--host", "desktop")
        self.assertEqual(code, 0, out)
        header = next(line for line in out.splitlines() if line.startswith("host "))
        self.assertEqual(header.split(), ["host", "skills", "client-config"])
        self.assertEqual(self.row(out, "desktop"), {"skills": "updated", "client-config": "updated"})
        self.assertNotIn("\nlaptop ", out)
        code, out = self.sync("--host", "nowhere")
        self.assertEqual(code, 2)
        done = subprocess.run([sys.executable, str(SCRIPTS / "sync.py"), "--only", "secrets"], env=self.env,
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)

    def test_missing_catalog_fails_that_scope_only(self):
        (self.fleet / "client-config.json").unlink()
        code, out = self.sync("--only", "skills,client-config", "--host", "devbox")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.row(out, "devbox"), {"skills": "updated", "client-config": "FAILED"})
        self.assertIn("FAILED: cannot read", out)

    def test_non_fleet_error_on_one_host_fails_that_host_only(self):
        # desktop answers with a cut-off result, so parsing it raises a JSON error, not a FleetError.
        bin_dir = self.root / "bin"
        (bin_dir / "ssh").rename(bin_dir / "fake-ssh")
        (bin_dir / "ssh").write_text('#!/bin/sh\ncase " $* " in *" desktop "*) echo "@@LOADOUT-RESULT {cut @@END"; exit 0 ;; esac\n'
                                     'exec "$(dirname "$0")/fake-ssh" "$@"\n')
        (bin_dir / "ssh").chmod(0o755)
        assert_fakes_run(self.env, ("ssh",))
        code, out = self.sync("--only", "skills")
        self.assertEqual(code, 1, out)
        self.assertIn("desktop: skills FAILED: JSONDecodeError:", out)
        self.assertEqual(self.row(out, "desktop"), {"skills": "FAILED"})
        self.assertEqual(self.row(out, "devbox"), {"skills": "updated"})
        self.assertTrue((self.root / "hosts/devbox/.codex/skills").is_dir())

    def test_skills_sync_builds_the_publication_once(self):
        sys.path.insert(0, str(SCRIPTS))
        import publication
        import sync
        (self.fleet / "hosts.json").write_text(json.dumps({**HOSTS, "hosts": HOSTS["hosts"][:2]}))
        out = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(sync.signal, "signal"), \
                mock.patch("publication.Publication", side_effect=publication.Publication) as built, \
                contextlib.redirect_stdout(out):
            code = sync.main(["--only", "skills"])
        self.assertEqual(code, 0, out.getvalue())
        self.assertEqual(self.row(out.getvalue(), "laptop"), {"skills": "updated"})
        self.assertEqual(self.row(out.getvalue(), "desktop"), {"skills": "updated"})
        self.assertEqual(built.call_count, 1)


class SyncFlagsTest(unittest.TestCase):
    def test_migrate_path_reaches_the_plugins_step(self):
        sys.path.insert(0, str(SCRIPTS))
        import plugins_sync
        import sync
        seen = []
        original = plugins_sync.preflight
        plugins_sync.preflight = lambda *args: seen.append(args[-1]) or {}
        try:
            for flag in ([], ["--migrate-path"]):
                args = sync.argparse.Namespace(dry_run=True, migrate_path=bool(flag), update_claude=False)
                sync.preflight("plugins", {}, None, [], args, print)
        finally:
            plugins_sync.preflight = original
        self.assertEqual(seen, [False, True])


if __name__ == "__main__":
    unittest.main()

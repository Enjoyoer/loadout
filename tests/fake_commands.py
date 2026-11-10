"""Guarded cross-platform command fakes for end-to-end tests."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


# Files in FAKE_ROOT shape faults: down-<host> (unreachable), cmd-limit (a command line over cmd.exe's 8191
# characters fails), corrupt-stdin (the payload is damaged in transit). A remote `paseo` command runs the test's
# fake paseo from LOADOUT_TEST_PASEO, never a paseo found on PATH.
_FAKE_SSH = r'''
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


def main():
    args = sys.argv[1:]
    if args == ["--fake-ok"]:
        print("fake")
        return 0
    while args and args[0] in ("-o", "-n"):
        if args[0] == "-o":
            args = args[2:]
        else:
            args = args[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("fake ssh: missing host", file=sys.stderr)
        return 2
    host, command = args[0], args[1:]
    if os.environ.get("FAKE_SSH_LOG"):
        with open(os.environ["FAKE_SSH_LOG"], "a") as log:
            log.write(" ".join(["ssh", host, *command]) + "\n")
    root = Path(os.environ.get("FAKE_ROOT") or os.environ["DEMO_ROOT"])
    if (root / ("down-" + host)).exists():
        print(f"ssh: connect to host {host}: timed out", file=sys.stderr)
        return 255
    if (root / "cmd-limit").exists() and len(" ".join(command)) > 8191:
        print("The command line is too long", file=sys.stderr)
        return 1
    try:
        command = shlex.split(" ".join(command), posix=True)
    except ValueError as error:
        print(f"fake ssh: invalid command: {error}", file=sys.stderr)
        return 2
    env = os.environ.copy()
    for name in ("CODEX_HOME", "XDG_CONFIG_HOME", "LOADOUT_FLEET", "PASEO_HOME"):
        env.pop(name, None)
    env["HOME"] = str(root / "hosts" / host)
    env["USERPROFILE"] = env["HOME"]
    env["APPDATA"] = str(root / "hosts" / host / ".config")
    stdin = None
    if (root / "corrupt-stdin").exists():
        sys.stdin.buffer.read()
        stdin = b"corrupt"
    if command[:1] == ["paseo"]:
        if not os.environ.get("LOADOUT_TEST_PASEO"):
            print("fake ssh: no fake paseo in LOADOUT_TEST_PASEO", file=sys.stderr)
            return 127
        return subprocess.run([*json.loads(os.environ["LOADOUT_TEST_PASEO"]), *command[1:]], env=env,
                              input=stdin).returncode
    if len(command) < 3 or command[:2] != ["node", "-e"]:
        print("fake ssh: expected a node -e payload or a paseo command", file=sys.stderr)
        return 2
    done = subprocess.run(command, env=env, input=stdin)
    return done.returncode


raise SystemExit(main())
'''.lstrip()


# Version lives in $HOME/claude-version; `update` installs 2.10.0.
_FAKE_CLAUDE = r'''
import os
import sys
from pathlib import Path

version = Path(os.environ["HOME"]) / "claude-version"
arg = sys.argv[1] if len(sys.argv) > 1 else ""
if arg == "--fake-ok":
    print("fake")
elif arg == "--version":
    print(version.read_text().strip() + " (Claude Code)")
elif arg == "update":
    version.write_text("2.10.0\n")
'''.lstrip()


# The provider sync's paseo: only `reload`, logged to FAKE_ROOT/calls.log. PASEO_HOST holds "offer:<host>";
# without it the call targets the local daemon. Like the real CLI, it refuses PASEO_HOME together with
# PASEO_HOST. FAKE_ROOT/fail-reload-<host> makes that host's reload fail.
_FAKE_PROVIDER_PASEO = r'''
import os
import sys
from pathlib import Path

ROOT = Path(os.environ["FAKE_ROOT"])


def out(stream, data):
    stream.buffer.write(data if isinstance(data, bytes) else data.encode())
    stream.flush()


def main():
    args = sys.argv[1:]
    target = os.environ.get("PASEO_HOST", "")
    host = (target[len("offer:"):] if target.startswith("offer:") else target) if target else "local"
    with open(ROOT / "calls.log", "a", encoding="utf-8", newline="\n") as log:
        log.write(f"paseo {host} {' '.join(args)}\n")
    if os.environ.get("PASEO_HOME") and target:
        out(sys.stderr, "TARGET_AMBIGUOUS\n")
        return 1
    first = (args + [""])[0]
    if first == "--fake-ok":
        out(sys.stdout, "fake\n")
    elif first == "reload":
        if (ROOT / f"fail-reload-{host}").exists():
            out(sys.stderr, "request timed out\n")
            return 1
        out(sys.stdout, "reloaded\n")
    else:
        out(sys.stderr, f"unexpected: {' '.join(args)}\n")
        return 9
    return 0


raise SystemExit(main())
'''.lstrip()


# Logs each call with its physical working directory; `ci` makes node_modules, and FAKE_ROOT/fail-check fails `run`.
_FAKE_NPM = r'''
import os
import sys
from pathlib import Path

args = sys.argv[1:]
if args[:1] == ["--fake-ok"]:
    print("fake")
    raise SystemExit(0)
root = Path(os.environ["FAKE_ROOT"])
with open(root / "calls.log", "a", encoding="utf-8", newline="\n") as log:
    log.write(f"npm {' '.join(args)} in {os.path.realpath(os.getcwd())}\n")
if args[:1] == ["ci"]:
    os.makedirs("node_modules", exist_ok=True)
elif args[:1] == ["run"] and (root / "fail-check").exists():
    sys.stderr.write("check failed: type error\n")
    raise SystemExit(2)
'''.lstrip()


# The plugin sync's paseo. Installs record the plugin in $HOME/.paseo/config.json the way the daemon does. The
# versions live in FAKE_ROOT/paseo-version and daemon-version; files there shape faults: daemon-down,
# fail-install, fail-reload, not-running (plugin ls reports a load error).
_FAKE_PLUGIN_PASEO = r'''
import json
import os
import shutil
import sys
from pathlib import Path


def out(stream, text):
    stream.buffer.write(text.encode())
    stream.flush()


def main():
    args = sys.argv[1:]
    if args[:1] == ["--fake-ok"]:
        out(sys.stdout, "fake\n")
        return 0
    root = Path(os.environ["FAKE_ROOT"])
    with open(root / "calls.log", "a", encoding="utf-8", newline="\n") as log:
        log.write(f"paseo {' '.join(args)}\n")
    cfg = Path(os.environ["HOME"]) / ".paseo" / "config.json"
    first, second, third = (args + ["", "", ""])[:3]
    key = f"{first} {second}"
    if key == "--version ":
        out(sys.stdout, (root / "paseo-version").read_text())
    elif key == "daemon status":
        if (root / "daemon-down").exists():
            out(sys.stdout, '{"error":{"code":"DAEMON_NOT_RUNNING"}}\n')
            return 1
        version = (root / "daemon-version").read_text().rstrip("\n")
        out(sys.stdout, '{"localDaemon":"running","daemonVersion":"%s"}\n' % version)
    elif key == "plugin install":
        if (root / "fail-install").exists():
            out(sys.stderr, "install failed\n")
            return 1
        config = json.loads(cfg.read_text(encoding="utf-8"))
        plugin = json.loads((Path(third) / "paseo-plugin.json").read_text(encoding="utf-8"))["id"]
        config["plugins"] = config.get("plugins") or {}
        config["plugins"][plugin] = {"source": "local", "path": third, "enabled": True}
        cfg.write_text(json.dumps(config, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        settings = cfg.parent / "plugin-settings" / plugin
        if not settings.exists():
            settings.mkdir(parents=True)
            (settings / "config.json").write_text('{"armed":false}')
    elif key == "plugin remove":
        config = json.loads(cfg.read_text(encoding="utf-8"))
        config["plugins"].pop(third, None)
        cfg.write_text(json.dumps(config, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        settings = cfg.parent / "plugin-settings" / third
        if settings.exists():
            shutil.rmtree(settings)
    elif key == "plugin reload":
        if (root / "fail-reload").exists():
            out(sys.stderr, "reload failed\n")
            return 1
    elif key == "plugin ls":
        config = json.loads(cfg.read_text(encoding="utf-8"))
        down = (root / "not-running").exists()
        listed = [{"id": plugin, **{k: entry[k] for k in ("path", "enabled") if k in entry},
                   "status": "error" if down else "running", "error": "load failed" if down else None}
                  for plugin, entry in (config.get("plugins") or {}).items()]
        out(sys.stdout, json.dumps(listed, separators=(",", ":"), ensure_ascii=False) + "\n")
    else:
        out(sys.stderr, f"unexpected: {' '.join(args)}\n")
        return 9
    return 0


raise SystemExit(main())
'''.lstrip()


# Runs a Loadout script's main() with test-only module hooks set to the fakes (fleet.SSH_COMMAND, and
# paseo_providers.PASEO_COMMAND when given), so ssh and paseo are never looked up.
_WITH_FAKES = (
    "import json, sys; scripts, module, hooks = sys.argv[1:4]; sys.path.insert(0, scripts); "
    "[setattr(__import__(owner), name, tuple(prefix)) for owner, name, prefix in json.loads(hooks)]; "
    "sys.argv = [module, *sys.argv[4:]]; sys.exit(__import__(module).main())")


def _install(bin_dir: Path, name: str, source: str) -> tuple[str, str]:
    bin_dir = bin_dir.resolve()
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / name
    script.write_text(source)
    return (sys.executable, str(script))


def install_fake_ssh(bin_dir: Path) -> tuple[str, str]:
    """Write the Python fake and return the exact ssh command prefix that runs it."""
    return _install(bin_dir, "fake_ssh.py", _FAKE_SSH)


def install_fake_claude(bin_dir: Path) -> tuple[str, str]:
    """Write the Python fake claude and return the [interpreter, script] for LOADOUT_TEST_CLAUDE."""
    return _install(bin_dir, "fake_claude.py", _FAKE_CLAUDE)


def install_fake_provider_paseo(bin_dir: Path) -> tuple[str, str]:
    """Write the provider sync's fake paseo and return the prefix for paseo_providers.PASEO_COMMAND and
    LOADOUT_TEST_PASEO."""
    return _install(bin_dir, "fake_provider_paseo.py", _FAKE_PROVIDER_PASEO)


def install_fake_npm(bin_dir: Path) -> tuple[str, str]:
    """Write the Python fake npm and return the [interpreter, script] for LOADOUT_TEST_NPM."""
    return _install(bin_dir, "fake_npm.py", _FAKE_NPM)


def install_fake_plugin_paseo(bin_dir: Path) -> tuple[str, str]:
    """Write the plugin sync's fake paseo and return the [interpreter, script] for LOADOUT_TEST_PASEO."""
    return _install(bin_dir, "fake_plugin_paseo.py", _FAKE_PLUGIN_PASEO)


def with_fakes(script: Path, *args: str, ssh: tuple[str, str], paseo: tuple[str, str] | None = None) -> list[str]:
    """Return an argv that runs a Loadout script with the fakes as fleet.SSH_COMMAND and, when given,
    paseo_providers.PASEO_COMMAND."""
    hooks = [["fleet", "SSH_COMMAND", list(ssh)]]
    if paseo is not None:
        hooks.append(["paseo_providers", "PASEO_COMMAND", list(paseo)])
    return [sys.executable, "-c", _WITH_FAKES, str(script.parent), script.stem, json.dumps(hooks), *args]


def with_fake_ssh(script: Path, ssh_command: tuple[str, str], *args: str) -> list[str]:
    """Return an argv that runs a Loadout script with the fake as fleet.SSH_COMMAND."""
    return with_fakes(script, *args, ssh=ssh_command)


def assert_fake(command: tuple[str, str], env: dict[str, str]) -> None:
    """Fail closed unless the exact injected command is the working fake."""
    if not Path(command[1]).is_file():
        raise AssertionError(f"missing fake: {command[1]}")
    done = subprocess.run([*command, "--fake-ok"], env=env, capture_output=True, text=True)
    if done.returncode != 0 or done.stdout.strip() != "fake":
        raise AssertionError(f"fake {Path(command[1]).name} failed probe: {done.returncode}: {done.stdout}{done.stderr}")

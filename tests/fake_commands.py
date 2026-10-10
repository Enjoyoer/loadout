"""Guarded cross-platform command fakes for end-to-end tests."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


_FAKE_SSH = r'''
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
    try:
        command = shlex.split(" ".join(command), posix=True)
    except ValueError as error:
        print(f"fake ssh: invalid command: {error}", file=sys.stderr)
        return 2
    if len(command) < 3 or command[:2] != ["node", "-e"]:
        print("fake ssh: expected a node -e payload", file=sys.stderr)
        return 2
    env = os.environ.copy()
    for name in ("CODEX_HOME", "XDG_CONFIG_HOME", "LOADOUT_FLEET"):
        env.pop(name, None)
    env["HOME"] = str(root / "hosts" / host)
    env["USERPROFILE"] = env["HOME"]
    env["APPDATA"] = str(root / "hosts" / host / ".config")
    done = subprocess.run(command, env=env)
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


# Runs a Loadout script's main() with fleet.SSH_COMMAND replaced by the fake, so ssh is never looked up.
_WITH_FAKE_SSH = (
    "import json, sys; scripts, module, prefix = sys.argv[1:4]; sys.path.insert(0, scripts); import fleet; "
    "fleet.SSH_COMMAND = tuple(json.loads(prefix)); sys.argv = [module, *sys.argv[4:]]; "
    "sys.exit(__import__(module).main())")


def install_fake_ssh(bin_dir: Path) -> tuple[str, str]:
    """Write the Python fake and return the exact ssh command prefix that runs it."""
    bin_dir = bin_dir.resolve()
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / "fake_ssh.py"
    script.write_text(_FAKE_SSH)
    return (sys.executable, str(script))


def install_fake_claude(bin_dir: Path) -> tuple[str, str]:
    """Write the Python fake claude and return the [interpreter, script] for LOADOUT_TEST_CLAUDE."""
    bin_dir = bin_dir.resolve()
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / "fake_claude.py"
    script.write_text(_FAKE_CLAUDE)
    return (sys.executable, str(script))


def with_fake_ssh(script: Path, ssh_command: tuple[str, str], *args: str) -> list[str]:
    """Return an argv that runs a Loadout script with the fake as fleet.SSH_COMMAND."""
    return [sys.executable, "-c", _WITH_FAKE_SSH, str(script.parent), script.stem, json.dumps(list(ssh_command)), *args]


def assert_fake(ssh_command: tuple[str, str], env: dict[str, str]) -> None:
    """Fail closed unless the exact injected command is the working fake."""
    if not Path(ssh_command[1]).is_file():
        raise AssertionError(f"missing fake ssh: {ssh_command[1]}")
    done = subprocess.run([*ssh_command, "--fake-ok"], env=env, capture_output=True, text=True)
    if done.returncode != 0 or done.stdout.strip() != "fake":
        raise AssertionError(f"fake ssh failed probe: {done.returncode}: {done.stdout}{done.stderr}")

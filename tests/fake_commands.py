"""Guarded cross-platform command fakes for end-to-end tests."""

from __future__ import annotations

import os
import shlex
import shutil
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


def _write_launchers(bin_dir: Path, name: str, script: Path) -> None:
    launcher = bin_dir / name
    launcher.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} \"$@\"\n")
    launcher.chmod(0o755)
    shim = bin_dir / f"{name}.cmd"
    shim.write_text(f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n')


def install_fake_ssh(bin_dir: Path) -> None:
    """Install both launchers for the Python fake."""
    bin_dir = bin_dir.resolve()
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / "fake_ssh.py"
    script.write_text(_FAKE_SSH)
    _write_launchers(bin_dir, "ssh", script)


def launcher_argv(name: str, env: dict[str, str], *args: str):
    """Return an argv that invokes the exact PATH-resolved launcher."""
    hit = shutil.which(name, path=env.get("PATH"))
    if not hit:
        raise AssertionError(f"missing fake {name} on PATH")
    path = Path(hit)
    if os.name == "nt" and path.suffix.lower() == ".cmd":
        interpreter = env.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
        command = subprocess.list2cmdline([str(path), *args])
        return f'{subprocess.list2cmdline([interpreter])} /d /s /c "{command}"'
    return [str(path), *args]


def assert_fake(name: str, bin_dir: Path, env: dict[str, str]) -> None:
    """Fail closed if PATH would select anything other than this fake."""
    hit = shutil.which(name, path=env.get("PATH"))
    if not hit or Path(hit).parent.resolve() != bin_dir.resolve():
        raise AssertionError(f"PATH does not resolve fake {name} in {bin_dir}: {hit}")
    done = subprocess.run(launcher_argv(name, env, "--fake-ok"), env=env,
                          capture_output=True, text=True)
    if done.returncode != 0 or done.stdout.strip() != "fake":
        raise AssertionError(f"fake {name} failed probe: {done.returncode}: {done.stdout}{done.stderr}")

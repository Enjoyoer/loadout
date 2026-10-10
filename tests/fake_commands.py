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
    for name in ("CODEX_HOME", "XDG_CONFIG_HOME", "LOADOUT_FLEET"):
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


# The provider sync's paseo: relay workspaces and one terminal, kept in FAKE_ROOT. PASEO_HOST holds
# "offer:<host>"; without it the call targets the local daemon. Like the real CLI, it refuses PASEO_HOME
# together with PASEO_HOST. The terminal is the relay host's POSIX shell, for exactly the command shapes
# paseo_providers.py sends; anything else fails. Files in FAKE_ROOT shape relay faults: drop-sends (count of
# send-keys to lose), quiet-captures (captures that return nothing), fail-create (the host makes the workspace
# but the call fails), fail-terminal, fail-archive, fail-reload-<host>, echo-only (the shell echoes and never
# runs), input-limit (send-keys over 3000 characters fails), corrupt-relay (staged payloads are damaged).
_FAKE_PROVIDER_PASEO = r'''
import glob
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ["FAKE_ROOT"])
WORKSPACES = ROOT / "workspaces"
TERMINAL = ROOT / "term.out"
STAGED = r'"\$\{TMPDIR:-/tmp\}/(loadout-provider-[0-9a-f]+)"'
EXIT = re.compile(r"(.*); printf '\\n@@LOADOUT-EXIT-([0-9a-f]+):%s\\n' \"\$\?\"", re.S)
INLINE = re.compile(r"node -e \"([^\"]*)\" -- '([^']*)' '([^']*)'")
CHUNK = re.compile(r"umask 077; printf %s '([^']*)' \| dd of=" + STAGED + r" bs=1 seek=(\d+) conv=notrunc 2>/dev/null")
RUN_STAGED = re.compile(r"\(exec 3<" + STAGED + "; rm -f " + STAGED + r"; node -e \"([^\"]*)\" <&3\)")
REMOVE = re.compile("rm -f " + STAGED)


def out(stream, data):
    stream.buffer.write(data if isinstance(data, bytes) else data.encode())
    stream.flush()


def count(name):
    path = ROOT / name
    return int(path.read_text().strip() or 0) if path.exists() else 0


def counter(name):
    """Take one from the count in FAKE_ROOT/name; whether there was one to take."""
    n = count(name)
    if n > 0:
        (ROOT / name).write_text(f"{n - 1}\n")
    return n > 0


def records():
    """The workspace lines, as awk and grep read them."""
    text = WORKSPACES.read_text(encoding="utf-8")
    return text[:-1].split("\n") if text.endswith("\n") else text.split("\n") if text else []


def fold(data, width=50):
    """fold -w 50: a line longer than 50 columns continues on the next."""
    folded, column = bytearray(), 0
    for byte in data:
        if byte == 10:
            folded.append(byte)
            column = 0
            continue
        advance = lambda c: c + 8 - c % 8 if byte == 9 else max(c - 1, 0) if byte == 8 else 0 if byte == 13 else c + 1
        if advance(column) > width:
            folded.append(10)
            column = 0
        folded.append(byte)
        column = advance(column)
    return bytes(folded)


def terminal(data):
    with open(TERMINAL, "ab") as screen:
        screen.write(fold(data))


def shell(command, env):
    """Run one command line the provider sync sends; returns (output, exit status)."""
    tmp = env.get("TMPDIR") or "/tmp"
    if command == "unset HISTFILE":
        return b"", 0
    match = INLINE.fullmatch(command)
    if match:
        done = subprocess.run(["node", "-e", match[1], "--", match[2], match[3]], env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return done.stdout, done.returncode
    match = CHUNK.fullmatch(command)
    if match:
        fd = os.open(os.path.join(tmp, match[2]), os.O_WRONLY | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
        try:
            os.lseek(fd, int(match[3]), os.SEEK_SET)
            os.write(fd, match[1].encode())
        finally:
            os.close(fd)
        return b"", 0
    match = RUN_STAGED.fullmatch(command)
    if match and match[1] == match[2]:
        path = os.path.join(tmp, match[1])
        try:
            with open(path, "rb") as staged:
                data = staged.read()
        except OSError as error:
            return f"sh: cannot open {path}: {error.strerror}\n".encode(), 2
        os.remove(path)
        done = subprocess.run(["node", "-e", match[3]], input=data, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT)
        return done.stdout, done.returncode
    match = REMOVE.fullmatch(command)
    if match:
        try:
            os.remove(os.path.join(tmp, match[1]))
        except FileNotFoundError:
            pass
        return b"", 0
    return f"fake relay shell: unsupported command: {command[:120]}\n".encode(), 127


def send(line, host):
    """The line echoed after the prompt, then its output with 2>&1, as `sh -c` runs it on the relay host."""
    env = {**os.environ, "HOME": str(ROOT / "hosts" / host)}
    env["USERPROFILE"] = env["HOME"]
    match = EXIT.fullmatch(line)
    if match:
        output, status = shell(match[1], env)
        output += f"\n@@LOADOUT-EXIT-{match[2]}:{status}\n".encode()
    else:
        output = f"fake relay shell: no exit marker: {line[:120]}\n".encode()
    terminal(f"$ {line}\n".encode() + output)


def main():
    args = sys.argv[1:]
    target = os.environ.get("PASEO_HOST", "")
    host = (target[len("offer:"):] if target.startswith("offer:") else target) if target else "local"
    with open(ROOT / "calls.log", "a", encoding="utf-8", newline="\n") as log:
        log.write(f"paseo {host} {' '.join(args)}\n")
    if os.environ.get("PASEO_HOME") and target:
        out(sys.stderr, "TARGET_AMBIGUOUS\n")
        return 1
    WORKSPACES.touch()
    first, second = (args + ["", ""])[:2]
    key = f"{first} {second}"
    if key.startswith("--fake-ok "):
        out(sys.stdout, "fake\n")
    elif key.startswith("reload "):
        if (ROOT / f"fail-reload-{host}").exists():
            out(sys.stderr, "request timed out\n")
            return 1
        out(sys.stdout, "reloaded\n")
    elif key == "workspace create":
        workspace = "ws-%d" % (WORKSPACES.read_bytes().count(b"\n") + 1)
        with open(WORKSPACES, "a", encoding="utf-8", newline="\n") as listing:
            listing.write(f"{workspace} loadout-provider-sync\n")
        if (ROOT / "fail-create").exists():
            out(sys.stderr, "request timed out\n")
            return 1
        out(sys.stdout, '{"workspaceId":"%s"}\n' % workspace)
    elif key == "workspace ls":
        fields = [(line.split() + ["", ""])[:2] for line in records()]
        out(sys.stdout, "[" + ",".join('{"workspaceId":"%s","name":"%s"}' % tuple(f) for f in fields) + "]\n")
    elif key == "workspace archive":
        if (ROOT / "fail-archive").exists():
            return 1
        workspace = args[2] if len(args) > 2 else ""
        kept = [line for line in records() if not line.startswith(workspace + " ")]
        WORKSPACES.write_bytes("".join(line + "\n" for line in kept).encode())
        out(sys.stdout, "archived\n")
    elif key == "terminal create":
        if (ROOT / "fail-terminal").exists():
            out(sys.stderr, "terminal failed\n")
            return 1
        TERMINAL.write_bytes(b"")
        out(sys.stdout, '{"id":"term-1"}\n')
    elif key == "terminal send-keys":
        line = args[3] if len(args) > 3 else ""
        if (ROOT / "input-limit").exists() and len(line) > 3000:
            out(sys.stderr, "relay input timeout\n")
            return 1
        if counter("drop-sends"):
            return 0
        if (ROOT / "echo-only").exists():
            terminal(f"$ {line}\n".encode())
            return 0
        # Input sent while the shell is still starting is lost, as on a slow relay host.
        if count("quiet-captures") > 0:
            return 0
        if "exec 3<" in line and (ROOT / "corrupt-relay").exists():
            for staged in glob.glob(os.path.join(os.environ.get("TMPDIR", ""), "loadout-provider-*")):
                Path(staged).write_bytes(b"corrupt")
        send(line, host)
    elif key == "terminal capture":
        if counter("quiet-captures"):
            return 0
        screen = TERMINAL.read_bytes() if TERMINAL.exists() else b""
        out(sys.stdout, screen or b"$ \n")
    elif key == "terminal kill":
        pass
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

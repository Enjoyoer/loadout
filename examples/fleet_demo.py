#!/usr/bin/env python3
"""Run the Loadout fleet sync end to end against two simulated hosts, offline.

Everything happens in a temporary directory: each "host" is a folder used as
HOME, and a stand-in `ssh` runs commands in that folder instead of connecting.
Nothing touches your real home directory, clients, or network. Needs python3,
node, and git (this script must run from a clone of the repository).

    python3 examples/fleet_demo.py
"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SYNC = REPO / "skills/orchestration/personal-skills/scripts/sync.py"

FAKE_SSH = textwrap.dedent(r"""
    #!/bin/sh
    # Stand-in for ssh: run the command with HOME set to the simulated host's folder.
    while [ "$1" = "-o" ] || [ "$1" = "-n" ]; do [ "$1" = "-o" ] && shift; shift; done
    host="$1"; shift
    unset CODEX_HOME XDG_CONFIG_HOME
    HOME="$DEMO_ROOT/hosts/$host" exec sh -c "$*"
    """).lstrip()

HOSTS = {
    "schema_version": 2,
    "source_host": "laptop",
    "transport": "ssh",
    "hosts": [
        {"name": "laptop", "os": "macos", "clients": ["claude"], "sync": ["skills"]},
        {"name": "desktop", "os": "linux", "clients": ["claude", "codex"], "sync": ["skills"],
         "exclude_skills": ["pake"]},
    ],
}


def step(title: str, env: dict, *args: str) -> None:
    print(f"\n=== {title}\n$ sync.py {' '.join(args)}", flush=True)
    done = subprocess.run([sys.executable, str(SYNC), *args], env=env, capture_output=True, text=True)
    print((done.stdout + done.stderr).rstrip())
    print(f"(exit {done.returncode})")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="loadout-demo-") as tmp:
        root = Path(tmp)
        fleet = root / "hosts/laptop/.config/loadout/fleet"
        fleet.mkdir(parents=True)
        (fleet / "hosts.json").write_text(json.dumps(HOSTS, indent=2))
        for host, clients in (("laptop", [".claude"]), ("desktop", [".claude", ".codex"])):
            for client in clients:
                (root / "hosts" / host / client).mkdir(parents=True, exist_ok=True)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (bin_dir / "ssh").write_text(FAKE_SSH)
        (bin_dir / "ssh").chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
               "HOME": str(root / "hosts/laptop"), "DEMO_ROOT": str(root)}
        env.pop("LOADOUT_FLEET", None)
        env.pop("XDG_CONFIG_HOME", None)

        step("1. Preview: nothing is written", env, "--dry-run")
        step("2. Sync: copy the fleet to desktop, install verified skills on both hosts", env)
        step("3. Run again: everything is already current", env)

        edited = root / "hosts/desktop/.claude/skills/grilling/SKILL.md"
        edited.write_text(edited.read_text() + "\nMy local tweak.\n")
        step("4. A hand edit on desktop is a conflict: nothing is written there", env)

        edited.write_text(edited.read_text().replace("\nMy local tweak.\n", ""))
        step("5. Undo the edit: the host syncs cleanly again", env)
        print(f"\nInstalled on desktop: {sorted(p.name for p in (root / 'hosts/desktop/.claude/skills').iterdir())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Fail when plugin code resolves the Paseo home or daemon address outside its single owner.

Rule daemon-env: plugins/_shared/daemon-target.ts (vendored into each plugin as
server/vendor/daemon-target.ts) is the only plugin code that reads PASEO_HOME or
PASEO_HOST, names the ".paseo" directory, or falls back to 127.0.0.1:6767. A plugin
that derives either on its own can drift from the daemon it runs in: a scratch
daemon's plugin then writes state to, or calls, the real daemon. Tests and
scripts/dry-run.ts are exempt.

An exception goes on the offending line itself, with a reason and an expiry date:
    // daemon-env-ok: <reason>; expires YYYY-MM-DD
An expired exception fails the check.
"""

from __future__ import annotations

import datetime
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
EXEMPT = re.compile(r"(^plugins/_shared/|/vendor/|/test/|\.test\.tsx?$|/scripts/dry-run\.ts$)")
GENERATED_BUNDLES = frozenset({"plugins/usage-limit-auto-resume/dist/pace-read.mjs"})
PATTERN = re.compile(r"env\.PASEO_HOME|env\.PASEO_HOST|['\"`]\.paseo['\"`]|127\.0\.0\.1:6767")
ALLOW = re.compile(r"daemon-env-ok:(?:\s*(?P<reason>[^;]*\S)\s*;\s*expires\s+(?P<date>\d{4}-\d{2}-\d{2}))?")
MESSAGE = ("resolves the Paseo home or daemon address itself. Import paseoHome() or resolveDaemonTarget() "
           "from ./vendor/daemon-target.ts so state and calls follow the daemon this plugin runs in.")


def is_ignored_untracked_bundle(rel: str, root: Path = ROOT) -> bool:
    """True only for an exact generated bundle path that Git proves is explicitly ignored and untracked."""
    if rel not in GENERATED_BUNDLES or (root / rel).is_symlink():
        return False
    try:
        toplevel = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=False,
        )
        if toplevel.returncode != 0 or Path(toplevel.stdout.strip()).resolve() != root.resolve():
            return False
        tracked = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", rel],
            capture_output=True, check=False,
        )
        if tracked.returncode != 0 or tracked.stdout != b"":
            return False
        ignored = subprocess.run(
            ["git", "-C", str(root), "check-ignore", "-q", "--", rel],
            capture_output=True, check=False,
        )
        if ignored.returncode != 0:
            return False
        status = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain=v1", "--ignored=traditional", "-uall", "-z", "--", rel],
            capture_output=True, check=False,
        )
        return status.returncode == 0 and status.stdout == f"!! {rel}\0".encode("utf-8")
    except OSError:
        return False


def plugin_sources(root: Path = ROOT) -> list[Path]:
    found = []
    for directory, subdirs, files in os.walk(root / "plugins"):
        subdirs[:] = sorted(name for name in subdirs if name != "node_modules")
        found += [Path(directory, name) for name in sorted(files) if name.endswith((".ts", ".tsx", ".js", ".mjs"))]
    return found


def problems(today: datetime.date, root: Path = ROOT) -> list[str]:
    found = []
    for path in plugin_sources(root):
        rel = path.relative_to(root).as_posix()
        if EXEMPT.search(rel) or is_ignored_untracked_bundle(rel, root):
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.lstrip().startswith(("//", "*", "/*")) or not PATTERN.search(line):
                continue
            allow = ALLOW.search(line)
            if not allow:
                found.append(f"{rel}:{number}: {MESSAGE}")
            elif not allow.group("date"):
                found.append(f"{rel}:{number}: the exception needs the form 'daemon-env-ok: <reason>; expires YYYY-MM-DD'.")
            elif datetime.date.fromisoformat(allow.group("date")) < today:
                found.append(f"{rel}:{number}: the daemon-env-ok exception expired on {allow.group('date')}. {MESSAGE}")
    return found


def main() -> int:
    found = problems(datetime.date.today())
    for line in found:
        print(line, file=sys.stderr)
    if found:
        return 1
    print("daemon-env: no plugin resolves the Paseo home or daemon address outside daemon-target.ts")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Fail when a plugin's vendored copy of a shared helper is missing, differs, or is not expected.

Each plugin is staged and installed on its own, so it cannot import plugins/_shared
at runtime. Every plugin that CONSUMERS names for a shared file carries a
byte-identical copy in plugins/<plugin>/server/vendor/ instead. Edit the file in
plugins/_shared, then copy it over every vendored copy; a plugin that starts or stops
vendoring a shared file must be added to or removed from CONSUMERS.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
SHARED = PLUGINS / "_shared"
# The plugins that must carry each plugins/_shared file, byte-identical, in server/vendor/.
CONSUMERS = {
    "daemon-target.ts": (
        "cache-aware-autocompact",
        "merged-worker-archiver",
        "orphan-project-sweeper",
        "usage-limit-auto-resume",
    ),
}


def vendored_files(names: set[str]) -> set[Path]:
    """Every plugin file in a vendor directory or named like a shared file, outside node_modules."""
    found = set()
    for plugin in PLUGINS.iterdir():
        if not plugin.is_dir() or plugin == SHARED:
            continue
        for directory, subdirs, files in os.walk(plugin):
            subdirs[:] = [name for name in subdirs if name != "node_modules"]
            in_vendor = "vendor" in Path(directory).relative_to(plugin).parts
            found.update(Path(directory, name) for name in files if in_vendor or name in names)
    return found


def problems() -> tuple[list[str], int]:
    """Every missing, differing, or unexpected vendored copy, and every shared file without a consumer list."""
    canonical = {path.name: path.read_bytes() for path in SHARED.iterdir() if path.is_file()}
    found = [f"plugins/_shared/{name} has no entry in CONSUMERS" for name in sorted(set(canonical) - set(CONSUMERS))]
    found += [f"CONSUMERS names plugins/_shared/{name}, which does not exist" for name in sorted(set(CONSUMERS) - set(canonical))]
    expected = {PLUGINS / plugin / "server" / "vendor" / name: name
                for name, plugins in CONSUMERS.items() for plugin in plugins}
    for path, name in sorted(expected.items()):
        rel = path.relative_to(ROOT).as_posix()
        if not path.is_file():
            found.append(f"{rel} is missing")
        elif name in canonical and path.read_bytes() != canonical[name]:
            found.append(f"{rel} differs from plugins/_shared/{name}")
    for path in sorted(vendored_files(set(canonical) | set(CONSUMERS)) - set(expected)):
        found.append(f"{path.relative_to(ROOT).as_posix()} is a vendored copy that CONSUMERS does not name")
    return found, len(expected)


def main() -> int:
    found, count = problems()
    if found:
        for line in found:
            print(line, file=sys.stderr)
        print("Copy each plugins/_shared file over the copies CONSUMERS names in scripts/check_vendored.py, byte for byte.",
              file=sys.stderr)
        return 1
    print(f"Verified {count} vendored copies against plugins/_shared")
    return 0


if __name__ == "__main__":
    sys.exit(main())

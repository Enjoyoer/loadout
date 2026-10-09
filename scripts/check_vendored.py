#!/usr/bin/env python3
"""Fail when a plugin's vendored copy of a shared helper differs from plugins/_shared.

Each plugin is staged and installed on its own, so it cannot import plugins/_shared
at runtime. It carries a byte-identical copy in plugins/<plugin>/server/vendor/
instead. Edit the file in plugins/_shared, then copy it over every vendored copy.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "plugins" / "_shared"


def problems() -> tuple[list[str], int]:
    """Every vendored copy that differs from its canonical file, and every canonical file no plugin vendors."""
    canonical = {path.name: path.read_bytes() for path in SHARED.iterdir() if path.is_file()}
    found = []
    copies = [path for path in sorted((ROOT / "plugins").glob("*/server/vendor/*")) if path.is_file()]
    for copy in copies:
        rel = copy.relative_to(ROOT).as_posix()
        if copy.name not in canonical:
            found.append(f"{rel} has no canonical source in plugins/_shared")
        elif copy.read_bytes() != canonical[copy.name]:
            found.append(f"{rel} differs from plugins/_shared/{copy.name}")
    for name in sorted(set(canonical) - {copy.name for copy in copies}):
        found.append(f"plugins/_shared/{name} is not vendored into any plugin")
    return found, len(copies)


def main() -> int:
    found, count = problems()
    if found:
        for line in found:
            print(line, file=sys.stderr)
        print("Copy each plugins/_shared file over its vendored copies byte for byte.", file=sys.stderr)
        return 1
    print(f"Verified {count} vendored copies against plugins/_shared")
    return 0


if __name__ == "__main__":
    sys.exit(main())

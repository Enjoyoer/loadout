#!/usr/bin/env python3
"""Resolve the private fleet directory for personal-skills.

Order: $LOADOUT_FLEET, then the per-user config directory
(${XDG_CONFIG_HOME:-~/.config}/loadout/fleet, or %APPDATA%\\loadout\\fleet on
Windows), then the legacy fleet/local/ beside the installed SKILL.md.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Mapping, NamedTuple, Optional

SKILL_DIR = Path(__file__).resolve().parent.parent


class FleetSource(NamedTuple):
    kind: str  # "env", "config", "legacy", or "none"
    path: Optional[Path]


def config_fleet_dir(env: Mapping[str, str], windows: bool) -> Optional[Path]:
    if windows:
        appdata = env.get("APPDATA")
        return Path(appdata) / "loadout" / "fleet" if appdata else None
    base = env.get("XDG_CONFIG_HOME") or str(Path(env.get("HOME", "~")).expanduser() / ".config")
    return Path(base) / "loadout" / "fleet"


def resolve(
    env: Mapping[str, str] = os.environ,
    skill_dir: Path = SKILL_DIR,
    windows: bool = os.name == "nt",
) -> FleetSource:
    explicit = env.get("LOADOUT_FLEET")
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_dir():
            raise SystemExit(f"LOADOUT_FLEET is not a directory: {path}")
        return FleetSource("env", path)
    config = config_fleet_dir(env, windows)
    if config is not None and config.is_dir():
        return FleetSource("config", config)
    legacy = skill_dir / "fleet" / "local"
    if legacy.is_dir():
        return FleetSource("legacy", legacy)
    return FleetSource("none", None)


def describe(source: FleetSource) -> str:
    if source.path is None:
        return "fleet: none (current host only)"
    return f"fleet: {source.kind} {source.path}"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["resolve"])
    parser.parse_args(argv)
    print(describe(resolve()))
    return 0


if __name__ == "__main__":
    sys.exit(main())

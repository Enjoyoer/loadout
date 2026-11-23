#!/usr/bin/env python3
"""Relay the auto-update feed and canary receipts from the publishing host to the other registry hosts.

Run on the host the registry names as feed.source_host (and as the canary host for canary rows). For each other
registry host with an `ssh` alias, `auto-update.mjs export` produces the copies that validate now (the feed, and
the receipts of canary rows that host runs), and fleet.run_node ships them in the fleet's digest-checked stdin
envelope to auto_update_relay_remote.js, which writes them only to the runner's fixed owner-only relay files.
Nothing here builds a path, a command or a value from the feed. --dry-run checks everything and writes nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet  # noqa: E402

HERE = Path(__file__).resolve().parent
RECEIVER = HERE / "auto_update_relay_remote.js"
RUNNER = HERE / "auto-update" / "auto-update.mjs"
TIMEOUT_SECONDS = 120


def export(fleet_dir: Path, source: str, target: str) -> tuple:
    """The header and relay docs `export` prints for one target host."""
    env = dict(os.environ, LOADOUT_FLEET=str(fleet_dir))
    done = subprocess.run(["node", str(RUNNER), "export", "--host", source, "--for", target],
                          capture_output=True, text=True, env=env, timeout=60)
    if done.returncode != 0:
        raise fleet.FleetError(f"export for {target} failed: {done.stderr.strip()[-200:]}")
    lines = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    return lines[0], lines[1:]


def describe(result: dict) -> str:
    if result.get("status") == "failed":
        return f"FAILED: {result.get('error')}"
    parts = [result["status"]]
    for key in ("written", "same"):
        if result.get(key):
            parts.append(f"{key} {', '.join(result[key])}")
    for r in result.get("rejected", []):
        parts.append(f"rejected {r.get('name')}: {r.get('why')}")
    return "; ".join(parts)


def relay(fleet_dir: Path, dry_run: bool, only: Optional[str], emit) -> bool:
    registry = json.loads((fleet_dir / "auto-update" / "registry.json").read_text(encoding="utf-8"))
    source = registry.get("feed", {}).get("source_host")
    if not source:
        raise fleet.FleetError("registry.feed.source_host is not set; nothing to relay")
    targets = [name for name, host in registry["hosts"].items() if name != source and host.get("ssh")]
    if only is not None:
        if only not in targets:
            raise fleet.FleetError(f"{only} is not a relay target (another registry host with ssh)")
        targets = [only]
    ok = True
    for target in targets:
        header, docs = export(fleet_dir, source, target)
        for s in header["skipped"]:
            emit(f"{target}: not sent {s['name']}: {s['why']}")
        if not docs:
            emit(f"{target}: nothing valid to send")
            ok = False
            continue
        payload = {"dry_run": dry_run, "for_host": target, "docs": docs}
        result, output = fleet.run_node(header["ssh"], False, RECEIVER, payload, TIMEOUT_SECONDS)
        if result is None:
            result = {"status": "failed", "error": output}
        emit(f"{target}: {describe(result)}")
        ok = ok and result["status"] in ("updated", "same", "would update")
    return ok


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["push"])
    parser.add_argument("--dry-run", action="store_true", help="check and report, write nothing")
    parser.add_argument("--host", help="only this registry host")
    args = parser.parse_args(argv)
    source = fleet.resolve()
    if source.path is None:
        print("no fleet directory", file=sys.stderr)
        return 1
    try:
        return 0 if relay(source.path, args.dry_run, args.host, lambda line: print(line, flush=True)) else 1
    except (fleet.FleetError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"relay: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

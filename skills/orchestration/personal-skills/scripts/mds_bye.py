#!/usr/bin/env python3
"""Verify, never install, the vendored mds-bye indexer-disable pair on macOS hosts in the mds-bye scope.

The four files mds-bye's install.sh puts on a Mac are compared with the
committed blobs in hosts/macos/mds-bye/ at the manifest's source_commit: bytes,
mode, and owner (root:wheel for the two system files, the user for the other
two). The LaunchAgent is compared with its template rendered as install.sh
does, __HOME__ replaced by the host's home directory. The step only reads: it
never writes, never runs install.sh, and never uses sudo. A host reports `same`
or `drift`, with one `DRIFT <file>: <reason>` line per differing file; drift
does not fail the sync.
"""

from __future__ import annotations

import argparse
import base64
import sys
from pathlib import Path
from typing import Callable, Optional

import fleet
import publication

REMOTE_JS = Path(__file__).resolve().parent / "mds_bye_remote.js"
TIMEOUT_SECONDS = 120
COMPONENT = "macos/mds-bye"
LABEL = "com.rayhanadev.disable-indexers"
# Where install.sh puts each committed file, the mode it gives it, whether root:wheel owns it, and whether it is the
# template install.sh renders with sed "s|__HOME__|${HOME}|g".
TARGETS = (
    {"path": "~/.local/sbin/disable-indexers.sh", "source": "scripts/disable-indexers.sh",
     "mode": 0o755, "root": False, "template": False},
    {"path": "/usr/local/libexec/disable-indexers-system.sh", "source": "scripts/disable-indexers-system.sh",
     "mode": 0o755, "root": True, "template": False},
    {"path": f"~/Library/LaunchAgents/{LABEL}.plist", "source": f"launchd/{LABEL}.agent.plist",
     "mode": 0o644, "root": False, "template": True},
    {"path": f"/Library/LaunchDaemons/{LABEL}.plist", "source": f"launchd/{LABEL}.daemon.plist",
     "mode": 0o644, "root": True, "template": False},
)


def payload(pub: publication.Publication) -> list:
    """Each target with its verified committed bytes."""
    entries = {entry["path"]: entry for entry in pub.manifest.get("host_files", [])
               if entry.get("component") == COMPONENT}
    out = []
    for target in TARGETS:
        path = f"hosts/{COMPONENT}/{target['source']}"
        if path not in entries:
            raise fleet.FleetError(f"the manifest at {pub.source[:12]} has no {path}")
        out.append({**target, "data": base64.b64encode(pub.blob(entries[path])).decode()})
    return out


def preflight(fleet_doc: dict, fleet_dir: Path, dry_run: bool, emit: Callable[[str], None]) -> dict:
    """Read the committed files once per sync, so every host is checked against the same source commit."""
    pub = publication.Publication(publication.find_checkout(fleet_doc))
    emit(f"source_commit {pub.source[:12]} (verify only{', dry run' if dry_run else ''}: nothing is written)")
    return {"fleet_doc": fleet_doc, "files": payload(pub)}


def run_host(state: dict, host: dict, emit: Callable[[str], None]) -> str:
    name = host["name"]
    if host["os"] != "macos":  # validation already refuses this; never run the check elsewhere
        emit(f"{name}: mds-bye skipped (not macos)")
        return "skipped"
    result, output = fleet.run_node(name, name == state["fleet_doc"]["source_host"], REMOTE_JS,
                                    {"files": state["files"]}, TIMEOUT_SECONDS)
    if result is None or result.get("error"):
        emit(f"{name}: mds-bye FAILED: {result['error'] if result else output}")
        return "FAILED"
    drift = [item for item in result["files"] if item["reasons"]]
    for item in result["files"]:
        emit(f"{name}: " + (f"DRIFT {item['path']}: {', '.join(item['reasons'])}" if item["reasons"]
                            else f"same {item['path']}"))
    return "drift" if drift else "same"


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="the same read-only check; accepted for symmetry")
    parser.add_argument("--host", help="check only this fleet host")
    args = parser.parse_args(argv)
    source = fleet.resolve()
    print(fleet.describe(source))
    emit = lambda line: print("  " + line, flush=True)
    try:
        if source.path is None:
            raise fleet.FleetError("no fleet directory")
        fleet_doc = fleet.load(source.path)
        targets = fleet.select(fleet_doc, "mds-bye", args.host)
        state = preflight(fleet_doc, source.path, args.dry_run, emit)
        statuses = {host["name"]: run_host(state, host, emit) for host in targets}
    except fleet.FleetError as error:
        print(f"invalid: {error}", file=sys.stderr)
        return 2 if isinstance(error, fleet.HostSelectionError) else 1
    return 0 if all(s in ("same", "drift") for s in statuses.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

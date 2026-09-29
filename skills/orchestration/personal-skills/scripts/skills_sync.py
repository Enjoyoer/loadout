#!/usr/bin/env python3
"""Install verified Loadout skills and global instructions on fleet hosts in the skills scope.

Files come from the manifest's source_commit, verified by size and SHA256, and
install flat as <client skills directory>/<skill>/<file> for Codex and Claude
Code. Each host is preflighted before any write; a changed file that matches
no published version is a conflict and stops that host.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import sys
from pathlib import Path
from typing import Callable, Optional

import fleet
import publication

REMOTE_JS = Path(__file__).resolve().parent / "skills_sync_remote.js"
MAX_LISTED = 8


def payload_files(pub: publication.Publication, only: Optional[set], exclude: set = frozenset()) -> dict:
    files = {}
    prior = pub.prior()
    for entry in pub.manifest["files"]:
        if (only is not None and entry["skill"] not in only) or entry["skill"] in exclude:
            continue
        data = pub.blob(entry)
        dest = "/".join([entry["skill"], *entry["path"].split("/")[3:]])
        files[dest] = {"sha256": entry["sha256"], "data": base64.b64encode(data).decode(),
                       "prior": prior.get(entry["path"], [])}
    return files


def global_payload(fleet_doc: dict, fleet_dir: Path) -> Optional[dict]:
    path = fleet_dir / "global" / "AGENTS.md"
    if not fleet_doc.get("global") or not path.is_file():
        return None
    data = path.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode(),
            "targets": fleet_doc["global"]}


def listed(labels: list) -> str:
    more = f" (+{len(labels) - MAX_LISTED} more)" if len(labels) > MAX_LISTED else ""
    return ", ".join(labels[:MAX_LISTED]) + more


def describe(result: dict) -> str:
    status = result["status"]
    if status == "failed":
        return f"FAILED: {result['error']}"
    if status == "conflict":
        return f"conflict: local edits, nothing written: {listed(result['conflicts'])}"
    counts = [f"+{len(result['added'])}" if result["added"] else "", f"~{len(result['changed'])}" if result["changed"] else ""]
    counts = " ".join(c for c in counts if c)
    clients = ", ".join(f"{k} {v}" for k, v in result["clients"].items())
    return f"{status}" + (f" ({counts})" if counts else "") + (f"; {clients}" if clients else "")


def run(fleet_doc: dict, fleet_dir: Path, targets: list, dry_run: bool, emit: Callable[[str], None],
        only: Optional[set] = None) -> dict:
    pub = publication.Publication(publication.find_checkout(fleet_doc))
    if only is not None:
        unknown = sorted(only - {entry["skill"] for entry in pub.manifest["files"]})
        if unknown:
            raise fleet.FleetError(f"unknown skills: {unknown}")
    names = {entry["skill"] for entry in pub.manifest["files"]}
    glob = global_payload(fleet_doc, fleet_dir)
    emit(f"source_commit {pub.source[:12]}: {len(only or names)} skills selected"
         + ("; global instructions" if glob else ""))
    statuses = {}
    for host in targets:
        name = host["name"]
        exclude = set(host.get("exclude_skills", []))
        files = payload_files(pub, only, exclude)
        payload = {"dry_run": dry_run, "clients": host.get("clients", []), "files": files, "global": glob}
        result, output = fleet.run_node(name, name == fleet_doc["source_host"], REMOTE_JS, payload)
        if result is None:
            result = {"status": "failed", "error": output}
        note = f"; excluded {', '.join(sorted(exclude))}" if exclude else ""
        emit(f"{name}: skills {describe(result)}{note}")
        statuses[name] = "FAILED" if result["status"] == "failed" else result["status"]
    return statuses


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="preflight and report without writing")
    parser.add_argument("--host", help="sync only this fleet host")
    parser.add_argument("--skills", help="comma-separated skill names (default: every published skill)")
    args = parser.parse_args(argv)
    source = fleet.resolve()
    print(fleet.describe(source))
    try:
        if source.path is None:
            raise fleet.FleetError("no fleet directory")
        fleet_doc = fleet.load(source.path)
        targets = fleet.select(fleet_doc, "skills", args.host)
        only = set(args.skills.split(",")) if args.skills else None
        statuses = run(fleet_doc, source.path, targets, args.dry_run, lambda line: print("  " + line, flush=True), only)
    except fleet.FleetError as error:
        print(f"invalid: {error}", file=sys.stderr)
        return 2 if isinstance(error, fleet.HostSelectionError) else 1
    return 0 if all(s in ("same", "updated", "would update") for s in statuses.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

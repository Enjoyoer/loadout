#!/usr/bin/env python3
"""Install verified Loadout skills and global instructions on fleet hosts in the skills scope.

Files come from the manifest's source_commit, verified by size and SHA256, and
install flat as <client skills directory>/<skill>/<file> for Codex and Claude
Code. Private skills come from the fleet directory's skills/<skill>/ overlay,
which is never published. Each host is preflighted before any write; a changed
file that matches no published or recorded overlay version is a conflict and
stops that host.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path
from typing import Callable, Optional

import fleet
import publication

REMOTE_JS = Path(__file__).resolve().parent / "skills_sync_remote.js"
MAX_LISTED = 8
OVERLAY = "skills"
OVERLAY_HISTORY = ".loadout-overlay.json"
OVERLAY_SKIP = {".DS_Store", "__pycache__", OVERLAY_HISTORY}


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


def published_prior_by_dest(pub: publication.Publication) -> dict:
    """Prior published hashes keyed by install path, so a skill moved to the overlay replaces its old copy."""
    by_dest: dict = {}
    for path, hashes in pub.prior().items():
        parts = path.split("/")
        if parts[0] == "skills" and len(parts) > 3:
            by_dest.setdefault("/".join(parts[2:]), set()).update(hashes)
    return by_dest


def overlay_files(fleet_dir: Path, published: set, prior_by_dest: dict, record: bool) -> dict:
    """Private skills from <fleet>/skills/<skill>/, keyed like payload_files.

    Every hash sync has sent is kept in skills/.loadout-overlay.json, so a later
    version replaces an installed earlier one while hand edits stay conflicts.
    """
    root = fleet_dir / OVERLAY
    if not root.is_dir():
        return {}
    history_path = root / OVERLAY_HISTORY
    try:
        history = json.loads(history_path.read_text()) if history_path.is_file() else {}
    except ValueError as error:
        raise fleet.FleetError(f"unreadable overlay history {history_path}: {error}") from error
    files = {}
    for skill in sorted(root.iterdir()):
        if skill.name.startswith(".") or skill.name in OVERLAY_SKIP:
            continue
        if skill.is_symlink() or not skill.is_dir():
            raise fleet.FleetError(f"overlay entry is not a skill directory: {skill.name}")
        if skill.name in published:
            raise fleet.FleetError(f"overlay skill {skill.name} has the same name as a published skill")
        if not (skill / "SKILL.md").is_file():
            raise fleet.FleetError(f"overlay skill {skill.name} has no SKILL.md")
        for path in sorted(skill.rglob("*")):
            rel = path.relative_to(root)
            if any(part in OVERLAY_SKIP for part in rel.parts) or path.suffix == ".pyc":
                continue
            if path.is_symlink():
                raise fleet.FleetError(f"symlink in the overlay: {rel.as_posix()}")
            if not path.is_file():
                continue
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            dest = rel.as_posix()
            prior = set(history.get(dest, [])) | prior_by_dest.get(dest, set())
            files[dest] = {"sha256": digest, "data": base64.b64encode(data).decode(), "prior": sorted(prior)}
    if record:
        updated = {dest: sorted(set(history.get(dest, [])) | {f["sha256"]}) for dest, f in files.items()}
        merged = {**history, **updated}
        if merged != history:
            history_path.write_text(json.dumps(merged, indent=2, sort_keys=True) + "\n")
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
    elevation = f"; elevation: {listed(result['elevation'])}" if result.get("elevation") else ""
    return f"{status}" + (f" ({counts})" if counts else "") + (f"; {clients}" if clients else "") + elevation


def run(fleet_doc: dict, fleet_dir: Path, targets: list, dry_run: bool, emit: Callable[[str], None],
        only: Optional[set] = None) -> dict:
    pub = publication.Publication(publication.find_checkout(fleet_doc))
    published = {entry["skill"] for entry in pub.manifest["files"]}
    overlay = overlay_files(fleet_dir, published, published_prior_by_dest(pub), record=not dry_run)
    overlay_names = {dest.split("/")[0] for dest in overlay}
    names = published | overlay_names
    if only is not None:
        unknown = sorted(only - names)
        if unknown:
            raise fleet.FleetError(f"unknown skills: {unknown}")
    glob = global_payload(fleet_doc, fleet_dir)
    selected = names if only is None else only
    emit(f"source_commit {pub.source[:12]}: {len(selected)} skills selected"
         + (f" ({len(selected & overlay_names)} from the private overlay)" if selected & overlay_names else "")
         + ("; global instructions" if glob else ""))
    statuses = {}
    for host in targets:
        name = host["name"]
        exclude = set(host.get("exclude_skills", []))
        files = payload_files(pub, only, exclude)
        files.update({dest: f for dest, f in overlay.items()
                      if dest.split("/")[0] not in exclude and (only is None or dest.split("/")[0] in only)})
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

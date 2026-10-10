#!/usr/bin/env python3
"""Install verified Loadout skills and global instructions on fleet hosts in the skills scope.

Files come from the manifest's source_commit, verified by size and SHA256, and
install flat as <client skills directory>/<skill>/<file> for Codex and Claude
Code. Private skills come from the fleet directory's skills/<skill>/ overlay,
which is never published. Each host is preflighted before any write; a changed
file that matches no published or recorded overlay version is a conflict and
stops that host. A skill the host's sync record shows the sync installed, and
that is no longer published, is removed unless it was edited there. When
hosts.json sets skills_overlay and the overlay is missing or not a directory, no
host retires anything, and each reports `blocked` with the reason.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

if os.name == "nt":
    import msvcrt
else:
    import fcntl

import fleet
import publication

REMOTE_JS = Path(__file__).resolve().parent / "skills_sync_remote.js"
TIMEOUT_SECONDS = 300
MAX_LISTED = 8
OVERLAY = "skills"
OVERLAY_HISTORY = ".loadout-overlay.json"
OVERLAY_SKIP = {".DS_Store", "__pycache__", OVERLAY_HISTORY}
# Every read-modify-write of the overlay history holds an OS lock on this file beside it, waiting at most
# this long for another sync. The file is never deleted, and the OS drops the lock when its holder exits.
OVERLAY_LOCK = OVERLAY_HISTORY + ".lock"
OVERLAY_LOCK_SECONDS = 15


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


def overlay_history(fleet_dir: Path) -> dict:
    path = fleet_dir / OVERLAY / OVERLAY_HISTORY
    try:
        return json.loads(path.read_text()) if path.is_file() else {}
    except ValueError as error:
        raise fleet.FleetError(f"unreadable overlay history {path}: {error}") from error


def overlay_problem(fleet_doc: dict, fleet_dir: Path) -> Optional[str]:
    """Why retirement stops: hosts.json sets skills_overlay, and <fleet>/skills/ is missing or not a directory."""
    root = fleet_dir / OVERLAY
    if not fleet_doc.get("skills_overlay") or root.is_dir():
        return None
    return (f"hosts.json sets skills_overlay, but the fleet overlay skills/ "
            f"{'is not a directory' if os.path.lexists(root) else 'is missing'}, so no host retires anything; "
            "restore it, or leave an empty skills/ to retire its skills")


def overlay_files(fleet_dir: Path, published: set, prior_by_dest: dict) -> dict:
    """Private skills from <fleet>/skills/<skill>/, keyed like payload_files.

    Every hash a host has accepted is kept in skills/.loadout-overlay.json, so a
    later version replaces an installed earlier one while hand edits stay conflicts.
    Each file is marked private, so a host writes it owner-only.
    """
    root = fleet_dir / OVERLAY
    if not root.is_dir():
        return {}
    history = overlay_history(fleet_dir)
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
            files[dest] = {"sha256": digest, "data": base64.b64encode(data).decode(), "prior": sorted(prior),
                           "private": True}
    return files


@contextlib.contextmanager
def overlay_lock(fleet_dir: Path):
    """Hold the overlay history's OS lock, waiting at most OVERLAY_LOCK_SECONDS for another sync."""
    lock = fleet_dir / OVERLAY / OVERLAY_LOCK
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + OVERLAY_LOCK_SECONDS
        while True:
            try:
                if os.name == "nt":
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if time.monotonic() >= deadline:
                    raise fleet.FleetError(f"the overlay history stayed locked for {OVERLAY_LOCK_SECONDS}s by another "
                                           f"skills sync: {lock}") from error
                time.sleep(0.05)
        try:
            yield
        finally:
            if os.name == "nt":
                os.lseek(fd, 0, os.SEEK_SET)
                with contextlib.suppress(OSError):
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.close(fd)  # also releases the lock


def record_overlay(fleet_dir: Path, files: dict) -> None:
    """Add the overlay hashes a host has accepted to the overlay history.

    One read-modify-write under the history's lock, so a concurrent sync's hashes are kept, written whole
    through an exclusively created temp file and an atomic replace, so a failed write leaves the old history.
    """
    path = fleet_dir / OVERLAY / OVERLAY_HISTORY
    with overlay_lock(fleet_dir):
        history = overlay_history(fleet_dir)
        merged = {**history, **{dest: sorted(set(history.get(dest, [])) | {f["sha256"]}) for dest, f in files.items()}}
        if merged == history:
            return
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=OVERLAY_HISTORY + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                out.write(json.dumps(merged, indent=2, sort_keys=True) + "\n")
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise


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
    stopped = f"; retirement stopped: {result['retire_stopped']}" if result.get("retire_stopped") else ""
    if status == "failed":
        return f"FAILED: {result['error']}{stopped}"
    if status == "conflict":
        return f"conflict: local edits, nothing written: {listed(result['conflicts'])}{stopped}"
    retired, kept = result.get("retired", []), result.get("kept", [])
    counts = [f"+{len(result['added'])}" if result["added"] else "", f"~{len(result['changed'])}" if result["changed"] else "",
              f"-{len(retired)}" if retired else ""]
    counts = " ".join(c for c in counts if c)
    clients = ", ".join(f"{k} {v}" for k, v in result["clients"].items())
    elevation = f"; elevation: {listed(result['elevation'])}" if result.get("elevation") else ""
    dry = status == "would update"
    unpublished = (f"; {'would retire' if dry else 'retired'} unpublished: {listed(retired)}" if retired else "") + (
        f"; unpublished with local edits, {'would keep' if dry else 'kept'} and stop managing: {listed(kept)}" if kept else "")
    return (f"{status}" + (f" ({counts})" if counts else "") + (f"; {clients}" if clients else "") + elevation + unpublished
            + stopped)


def preflight(fleet_doc: dict, fleet_dir: Path, dry_run: bool, emit: Callable[[str], None],
              only: Optional[set] = None) -> dict:
    """Build what every host shares once per sync: the publication, the overlay, and the global instructions."""
    pub = publication.Publication(publication.find_checkout(fleet_doc))
    published = {entry["skill"] for entry in pub.manifest["files"]}
    overlay = overlay_files(fleet_dir, published, published_prior_by_dest(pub))
    overlay_names = {dest.split("/")[0] for dest in overlay}
    names = published | overlay_names
    if only is not None:
        unknown = sorted(only - names)
        if unknown:
            raise fleet.FleetError(f"unknown skills: {unknown}")
    # A configured overlay that is missing must not read as an empty one: then every host retires nothing.
    stopped = overlay_problem(fleet_doc, fleet_dir)
    glob = global_payload(fleet_doc, fleet_dir)
    selected = names if only is None else only
    emit(f"source_commit {pub.source[:12]}: {len(selected)} skills selected"
         + (f" ({len(selected & overlay_names)} from the private overlay)" if selected & overlay_names else "")
         + ("; global instructions" if glob else ""))
    if (fleet_dir / OVERLAY).is_dir() and not fleet_doc.get("skills_overlay"):
        emit("note: hosts.json does not set skills_overlay, so a missing skills/ overlay would not stop retirement")
    return {"fleet_doc": fleet_doc, "fleet_dir": fleet_dir, "dry_run": dry_run, "only": only, "pub": pub,
            "overlay": overlay, "retire_stopped": stopped, "names": names, "global": glob}


def run_host(state: dict, host: dict, emit: Callable[[str], None]) -> str:
    name = host["name"]
    only = state["only"]
    exclude = set(host.get("exclude_skills", []))
    files = payload_files(state["pub"], only, exclude)
    overlay = {dest: f for dest, f in state["overlay"].items()
               if dest.split("/")[0] not in exclude and (only is None or dest.split("/")[0] in only)}
    files.update(overlay)
    # A host retires a skill it recorded only when the skill is in neither the publication nor the
    # overlay, nor excluded on this host; a run narrowed to some skills, or one whose configured
    # overlay is missing, retires nothing.
    keep = sorted(state["names"] | exclude) if only is None and not state["retire_stopped"] else None
    payload = {"dry_run": state["dry_run"], "clients": host.get("clients", []), "files": files,
               "global": state["global"], "keep": keep}
    result, output = fleet.run_node(name, name == state["fleet_doc"]["source_host"], REMOTE_JS, payload,
                                    TIMEOUT_SECONDS)
    if result is None:
        result = {"status": "failed", "error": output}
    if state["retire_stopped"] and only is None:
        # Every host gets the reason, a failed or conflicted one too; one that would otherwise pass is blocked.
        result = {**result, "retire_stopped": state["retire_stopped"]}
        if result["status"] in ("same", "updated", "would update"):
            result["status"] = "blocked"
    if (not state["dry_run"] and overlay and result["status"] in ("updated", "same")
            and "present" in result["clients"].values()):
        record_overlay(state["fleet_dir"], overlay)
    note = f"; excluded {', '.join(sorted(exclude))}" if exclude else ""
    emit(f"{name}: skills {describe(result)}{note}")
    return "FAILED" if result["status"] == "failed" else result["status"]


def run(fleet_doc: dict, fleet_dir: Path, targets: list, dry_run: bool, emit: Callable[[str], None],
        only: Optional[set] = None) -> dict:
    state = preflight(fleet_doc, fleet_dir, dry_run, emit, only)
    return {host["name"]: run_host(state, host, emit) for host in targets}


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

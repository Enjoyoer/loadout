#!/usr/bin/env python3
"""Verify the public skill and plugin manifest against committed Git blobs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def main() -> None:
    head = git("rev-parse", "HEAD").decode().strip()
    manifest = json.loads(git("show", f"{head}:MANIFEST.json"))
    if manifest.get("schema_version") != 2 or manifest.get("hash_basis") != "git-blob":
        raise SystemExit("Unsupported manifest schema or hash basis")

    source = manifest["source_commit"]
    git("cat-file", "-e", f"{source}^{{commit}}")
    subprocess.run(
        ["git", "-C", str(ROOT), "merge-base", "--is-ancestor", source, head],
        check=True,
    )
    if git("rev-parse", f"{source}:skills") != git("rev-parse", f"{head}:skills"):
        raise SystemExit("Committed skills tree changed after the manifest source")
    paths = git("ls-tree", "-r", "--name-only", source, "--", "skills").decode().splitlines()
    entries = manifest["files"]
    listed = [entry["path"] for entry in entries]
    if paths != listed or len(paths) != len(set(paths)):
        raise SystemExit("Manifest paths differ from committed skills tree")

    skills: set[str] = set()
    for entry in entries:
        path = entry["path"]
        parts = Path(path).parts
        if len(parts) < 4 or parts[0] != "skills" or any(part in {"", ".", ".."} for part in parts):
            raise SystemExit(f"Invalid skill path: {path}")
        if parts[2] != entry["skill"] or parts[1] != entry["category"]:
            raise SystemExit(f"Incorrect skill mapping: {path}")
        if git("ls-tree", source, "--", path).split(maxsplit=1)[0] not in {b"100644", b"100755"}:
            raise SystemExit(f"Non-regular skill file: {path}")
        blob = git("cat-file", "blob", f"{source}:{path}")
        if len(blob) != entry["bytes"] or hashlib.sha256(blob).hexdigest() != entry["sha256"]:
            raise SystemExit(f"Blob mismatch: {path}")
        skills.add(parts[2])

    if len(entries) != manifest["file_count"] or len(skills) != manifest["skill_count"]:
        raise SystemExit("Manifest counts differ from committed skills tree")

    if git("rev-parse", f"{source}:plugins") != git("rev-parse", f"{head}:plugins"):
        raise SystemExit("Committed plugins tree changed after the manifest source")
    paths = git("ls-tree", "-r", "--name-only", source, "--", "plugins").decode().splitlines()
    plugin_entries = manifest["plugin_files"]
    if paths != [entry["path"] for entry in plugin_entries] or len(paths) != len(set(paths)):
        raise SystemExit("Manifest paths differ from committed plugins tree")
    pins = {plugin["id"]: plugin["paseo"] for plugin in manifest["plugins"]}
    for entry in plugin_entries:
        path = entry["path"]
        parts = Path(path).parts
        if len(parts) < 3 or parts[0] != "plugins" or any(part in {"", ".", ".."} for part in parts):
            raise SystemExit(f"Invalid plugin path: {path}")
        if parts[1] != entry["plugin"] or entry["plugin"] not in pins:
            raise SystemExit(f"Incorrect plugin mapping: {path}")
        if git("ls-tree", source, "--", path).split(maxsplit=1)[0] not in {b"100644", b"100755"}:
            raise SystemExit(f"Non-regular plugin file: {path}")
        blob = git("cat-file", "blob", f"{source}:{path}")
        if len(blob) != entry["bytes"] or hashlib.sha256(blob).hexdigest() != entry["sha256"]:
            raise SystemExit(f"Blob mismatch: {path}")
        if parts[2:] == ("paseo-plugin.json",):
            spec = json.loads(blob)
            if spec.get("id") != parts[1] or spec["requirements"]["paseo"] != pins[parts[1]]:
                raise SystemExit(f"Plugin id or Paseo pin differs from the manifest: {path}")
    if len(plugin_entries) != manifest["plugin_file_count"] or len(pins) != manifest["plugin_count"]:
        raise SystemExit("Manifest counts differ from committed plugins tree")
    if {entry["plugin"] for entry in plugin_entries} != set(pins):
        raise SystemExit("Manifest plugin list differs from committed plugins tree")
    print(f"Verified {len(skills)} skills, {len(pins)} plugins, and {len(entries) + len(plugin_entries)} committed files at {source}")


if __name__ == "__main__":
    main()

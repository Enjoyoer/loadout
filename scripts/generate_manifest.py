#!/usr/bin/env python3
"""Generate a publication manifest from the committed skill and plugin trees at HEAD."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def committed(source: str, kind: str, depth: int) -> list[tuple[str, tuple[str, ...]]]:
    """Path and parts of every committed file under `<kind>s` at source; only regular files qualify."""
    found = []
    for line in git("ls-tree", "-r", source, "--", f"{kind}s").decode().splitlines():
        meta, path = line.split("\t", 1)
        parts = Path(path).parts
        if len(parts) < depth or parts[0] != f"{kind}s" or any(part in {"", ".", ".."} for part in parts):
            raise SystemExit(f"Invalid {kind} path: {path}")
        if meta.split()[0] not in {"100644", "100755"}:
            raise SystemExit(f"Non-regular {kind} file: {path}")
        found.append((path, parts))
    return found


def build(source: str) -> dict:
    """The manifest for the committed skill and plugin trees at source."""
    files = []
    for path, parts in committed(source, "skill", 4):
        blob = git("cat-file", "blob", f"{source}:{path}")
        files.append({
            "path": path,
            "category": parts[1],
            "skill": parts[2],
            "bytes": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
        })
    plugin_files = []
    plugins = []
    for path, parts in committed(source, "plugin", 3):
        blob = git("cat-file", "blob", f"{source}:{path}")
        plugin_files.append({
            "path": path,
            "plugin": parts[1],
            "bytes": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
        })
        if parts[2:] == ("paseo-plugin.json",):
            spec = json.loads(blob)
            if spec.get("id") != parts[1]:
                raise SystemExit(f"Plugin id differs from its directory: {path}")
            plugins.append({"id": parts[1], "paseo": spec["requirements"]["paseo"]})
    if {entry["plugin"] for entry in plugin_files} != {plugin["id"] for plugin in plugins}:
        raise SystemExit("Every plugin directory needs a paseo-plugin.json")
    return {
        "schema_version": 2,
        "hash_basis": "git-blob",
        "source_commit": source,
        "skill_count": len({entry["skill"] for entry in files}),
        "file_count": len(files),
        "files": files,
        "plugin_count": len(plugins),
        "plugin_file_count": len(plugin_files),
        "plugins": plugins,
        "plugin_files": plugin_files,
    }


def main() -> None:
    source = git("rev-parse", "HEAD").decode().strip()
    manifest = build(source)
    (ROOT / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {manifest['file_count']} skill files and {manifest['plugin_file_count']} plugin files from {source}")


if __name__ == "__main__":
    main()

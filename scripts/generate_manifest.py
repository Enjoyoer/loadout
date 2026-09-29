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


def main() -> None:
    source = git("rev-parse", "HEAD").decode().strip()
    paths = git("ls-tree", "-r", "--name-only", source, "--", "skills").decode().splitlines()
    files = []
    for path in paths:
        parts = Path(path).parts
        if len(parts) < 4 or parts[0] != "skills":
            raise SystemExit(f"Invalid skill path: {path}")
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
    for path in git("ls-tree", "-r", "--name-only", source, "--", "plugins").decode().splitlines():
        parts = Path(path).parts
        if len(parts) < 3 or parts[0] != "plugins":
            raise SystemExit(f"Invalid plugin path: {path}")
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
    manifest = {
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
    (ROOT / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {len(files)} skill files and {len(plugin_files)} plugin files from {source}")


if __name__ == "__main__":
    main()

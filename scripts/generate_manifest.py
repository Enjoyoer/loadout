#!/usr/bin/env python3
"""Generate a publication manifest from the committed skill tree at HEAD."""

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
    manifest = {
        "schema_version": 1,
        "hash_basis": "git-blob",
        "source_commit": source,
        "skill_count": len({entry["skill"] for entry in files}),
        "file_count": len(files),
        "files": files,
    }
    (ROOT / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {len(files)} committed files from {source}")


if __name__ == "__main__":
    main()

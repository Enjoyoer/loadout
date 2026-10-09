#!/usr/bin/env python3
"""Verify the public skill and plugin manifest against committed Git blobs."""

from __future__ import annotations

import json
import subprocess

from generate_manifest import ROOT, build, git


def difference(recorded: dict, expected: dict) -> str:
    """The first field where the committed manifest differs from the regenerated one."""
    for key in dict.fromkeys([*expected, *recorded]):
        have, want = recorded.get(key), expected.get(key)
        if have == want:
            continue
        if isinstance(have, list) and isinstance(want, list):
            for old, new in zip(have, want):
                if old != new:
                    return f"{key} entry {new.get('path', new.get('id'))}"
            return f"{key} lists {len(have)} entries, the committed tree has {len(want)}"
        return f"{key} is {have!r}, the committed tree gives {want!r}"
    return ""


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
    if git("rev-parse", f"{source}:plugins") != git("rev-parse", f"{head}:plugins"):
        raise SystemExit("Committed plugins tree changed after the manifest source")

    detail = difference(manifest, build(source))
    if detail:
        raise SystemExit(f"Manifest differs from the committed trees at {source}: {detail}")
    print(f"Verified {manifest['skill_count']} skills, {manifest['plugin_count']} plugins, and "
          f"{manifest['file_count'] + manifest['plugin_file_count']} committed files at {source}")


if __name__ == "__main__":
    main()

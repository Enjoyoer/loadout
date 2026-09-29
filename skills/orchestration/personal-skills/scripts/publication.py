"""Read the verified Loadout publication from a Git checkout.

Files are read from the manifest's source_commit with `git cat-file` and
checked against the manifest byte counts and SHA256 before use. Prior
published hashes come from every committed version of MANIFEST.json.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Optional

import fleet

SCRIPT_DIR = Path(__file__).resolve().parent


class Publication:
    def __init__(self, root: Path):
        self.root = root
        self.manifest = json.loads(self.git("show", "HEAD:MANIFEST.json"))
        if self.manifest.get("schema_version") != 2 or self.manifest.get("hash_basis") != "git-blob":
            raise fleet.FleetError("unsupported manifest schema or hash basis")
        self.source = self.manifest["source_commit"]
        self._prior: Optional[dict] = None

    def git(self, *args: str) -> bytes:
        try:
            return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as error:
            raise fleet.FleetError(f"git {' '.join(args[:2])} failed: {error.stderr.decode().strip()}") from error

    def blob(self, entry: dict) -> bytes:
        data = self.git("cat-file", "blob", f"{self.source}:{entry['path']}")
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise fleet.FleetError(f"committed blob does not match the manifest: {entry['path']}")
        return data

    def prior(self) -> dict:
        """Every SHA256 each path has had in a committed MANIFEST.json."""
        if self._prior is None:
            seen: dict = {}
            for commit in self.git("log", "--format=%H", "--", "MANIFEST.json").decode().split():
                try:
                    old = json.loads(self.git("show", f"{commit}:MANIFEST.json"))
                except (fleet.FleetError, ValueError):
                    continue
                for entry in old.get("files", []) + old.get("plugin_files", []):
                    seen.setdefault(entry["path"], set()).add(entry["sha256"])
            self._prior = {path: sorted(hashes) for path, hashes in seen.items()}
        return self._prior


def find_checkout(fleet_doc: dict) -> Path:
    """The checkout this script runs from, else the source host's recorded checkout."""
    try:
        top = subprocess.check_output(["git", "-C", str(SCRIPT_DIR), "rev-parse", "--show-toplevel"],
                                      stderr=subprocess.DEVNULL).decode().strip()
        if (Path(top) / "MANIFEST.json").is_file():
            return Path(top)
    except (subprocess.CalledProcessError, OSError):
        pass
    source = next(host for host in fleet_doc["hosts"] if host["name"] == fleet_doc["source_host"])
    checkout = source.get("checkout")
    if checkout and (Path(checkout).expanduser() / "MANIFEST.json").is_file():
        return Path(checkout).expanduser()
    raise fleet.FleetError("no Loadout checkout: run from a checkout or set the source host's checkout")

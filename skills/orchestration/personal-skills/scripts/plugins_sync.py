#!/usr/bin/env python3
"""Stage, install, and confirm verified Loadout Paseo plugins on fleet hosts in the plugins scope.

Each host's `paseo` entry authorizes the steps: `stage` copies verified source to
`plugin_root` and runs `npm ci` plus the package check; `install` (a subset)
installs or reloads on the daemon, only when the daemon version is inside the
plugin's pin and `pluginsEnabled` is already true. A host with
`plugin_root: null` only reports whether its installed source matches.
The sync never writes plugin settings, plugin state, or pluginsEnabled.
"""

from __future__ import annotations

import argparse
import base64
import sys
from pathlib import Path
from typing import Callable, Optional

import fleet
import publication

REMOTE_JS = Path(__file__).resolve().parent / "plugins_sync_remote.js"


def plugin_payload(pub: publication.Publication, ids: list) -> dict:
    pins = {plugin["id"]: plugin["paseo"] for plugin in pub.manifest["plugins"]}
    unknown = sorted(set(ids) - set(pins))
    if unknown:
        raise fleet.FleetError(f"plugins not in the manifest: {unknown}")
    prior = pub.prior()
    out = {plugin_id: {"pin": pins[plugin_id], "files": {}} for plugin_id in ids}
    for entry in pub.manifest["plugin_files"]:
        if entry["plugin"] in out:
            rel = "/".join(entry["path"].split("/")[2:])
            out[entry["plugin"]]["files"][rel] = {"sha256": entry["sha256"], "prior": prior.get(entry["path"], []),
                                                  "data": base64.b64encode(pub.blob(entry)).decode()}
    return out


def describe(result: dict) -> list:
    if result["status"] == "failed" and result.get("error"):
        return [f"FAILED: {result['error']}"]
    if result["status"] == "conflict":
        return [f"conflict: local edits in staged source, nothing written: {', '.join(result['conflicts'][:8])}"]
    lines = [result["status"]]
    daemon = result.get("daemon")
    if daemon:
        cli = f" (CLI {daemon['cli']})" if daemon.get("cli") and daemon["cli"] != daemon["version"] else ""
        lines[0] += f"; daemon {daemon['version']}{cli}, pluginsEnabled {str(daemon['pluginsEnabled']).lower()}"
    for plugin_id, info in result["plugins"].items():
        if "state" in info:
            detail = f" ({', '.join(info['differ'])})" if info.get("differ") else ""
            lines.append(f"  {plugin_id}: installed source {info['state']}{detail}")
        else:
            parts = [f"staged {info['staged']}"]
            if info["checked"]:
                parts.append(f"check {info['checked']}")
            if info["installed"]:
                parts.append(info["installed"])
            if info["running"] is not None:
                parts.append("running" if info["running"] else "NOT running")
            lines.append(f"  {plugin_id}: {'; '.join(parts)}")
    return lines


def run(fleet_doc: dict, fleet_dir: Path, targets: list, dry_run: bool, emit: Callable[[str], None]) -> dict:
    pub = publication.Publication(publication.find_checkout(fleet_doc))
    emit(f"source_commit {pub.source[:12]}")
    statuses = {}
    for host in targets:
        name = host["name"]
        paseo = host["paseo"]
        ids = paseo.get("stage", []) or [p["id"] for p in pub.manifest["plugins"]]
        payload = {"dry_run": dry_run, "plugin_root": paseo.get("plugin_root"),
                   "stage": paseo.get("stage", []) if paseo.get("plugin_root") is not None else [],
                   "install": paseo.get("install", []) if paseo.get("plugin_root") is not None else [],
                   "plugins": plugin_payload(pub, ids)}
        result, output = fleet.run_node(name, name == fleet_doc["source_host"], REMOTE_JS, payload)
        if result is None:
            result = {"status": "failed", "error": output}
        lines = describe(result)
        emit(f"{name}: plugins {lines[0]}")
        for line in lines[1:]:
            emit(f"{name}: {line.strip()}")
        statuses[name] = "FAILED" if result["status"] == "failed" else result["status"]
    return statuses


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="preflight and report without writing")
    parser.add_argument("--host", help="sync only this fleet host")
    args = parser.parse_args(argv)
    source = fleet.resolve()
    print(fleet.describe(source))
    try:
        if source.path is None:
            raise fleet.FleetError("no fleet directory")
        fleet_doc = fleet.load(source.path)
        targets = fleet.select(fleet_doc, "plugins", args.host)
        statuses = run(fleet_doc, source.path, targets, args.dry_run, lambda line: print("  " + line, flush=True))
    except fleet.FleetError as error:
        print(f"invalid: {error}", file=sys.stderr)
        return 2 if isinstance(error, fleet.HostSelectionError) else 1
    return 0 if all(s in ("same", "updated", "would update", "drift") for s in statuses.values()) else 1


if __name__ == "__main__":
    sys.exit(main())

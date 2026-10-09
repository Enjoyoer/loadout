#!/usr/bin/env python3
"""Sync managed Codex and Claude Code settings to fleet hosts in the client-config scope.

Reads <fleet>/client-config.json. Each host gets the base settings, then its
role's (`local` for the source host, `remote` for the others, unless the host
overrides it), then its own `hosts.<name>` overrides. Only managed keys are
written; each changed file is backed up in place and replaced atomically.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import fleet

MERGE_JS = Path(__file__).resolve().parent / "client_config_merge.js"
TIMEOUT_SECONDS = 300
# --update-claude lets the host run `claude update` for up to 10 minutes.
UPDATE_TIMEOUT_SECONDS = 900
CATALOG_KEYS = {"token_file", "codex", "claude", "roles", "hosts"}
CODEX_KEYS = {"top", "sections", "reportOnly"}
CLAUDE_KEYS = {"minVersion", "settings", "env", "token_env"}
LAYER_CODEX_KEYS = {"top", "sections"}
LAYER_CLAUDE_KEYS = {"settings", "env", "token_env"}
ROLES = ("local", "remote")


def _toml_values(mapping, where):
    if not isinstance(mapping, dict):
        raise fleet.FleetError(f"{where} must be an object")
    for key, value in mapping.items():
        if isinstance(value, bool) or isinstance(value, (str, int, float)):
            continue
        raise fleet.FleetError(f"{where}.{key} must be a string, number, or boolean")


def _layer(layer, where, base=False):
    if not isinstance(layer, dict):
        raise fleet.FleetError(f"{where} must be an object")
    fleet._keys(layer, {"codex", "claude"} | ({"role"} if where.startswith("hosts.") else set()), where)
    codex = layer.get("codex", {})
    fleet._keys(codex, CODEX_KEYS if base else LAYER_CODEX_KEYS, f"{where}.codex")
    _toml_values(codex.get("top", {}), f"{where}.codex.top")
    sections = codex.get("sections", {})
    if not isinstance(sections, dict):
        raise fleet.FleetError(f"{where}.codex.sections must be an object")
    for name, keys in sections.items():
        _toml_values(keys, f"{where}.codex.sections.{name}")
    claude = layer.get("claude", {})
    fleet._keys(claude, CLAUDE_KEYS if base else LAYER_CLAUDE_KEYS, f"{where}.claude")
    for key in ("settings", "env"):
        if not isinstance(claude.get(key, {}), dict):
            raise fleet.FleetError(f"{where}.claude.{key} must be an object")
    if not all(isinstance(v, str) for v in claude.get("env", {}).values()):
        raise fleet.FleetError(f"{where}.claude.env values must be strings")
    token_env = claude.get("token_env")
    if token_env is not None and not isinstance(token_env, str):
        raise fleet.FleetError(f"{where}.claude.token_env must be an env name or null")


def load_catalog(path: Path, fleet_doc: dict) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise fleet.FleetError(f"cannot read {path}: {error}") from error
    fleet._keys(data, CATALOG_KEYS, path.name)
    _layer({"codex": data.get("codex", {}), "claude": data.get("claude", {})}, "base", base=True)
    fleet._strings(data.get("codex", {}).get("reportOnly", []), "codex.reportOnly")
    if "minVersion" in data.get("claude", {}) and not isinstance(data["claude"]["minVersion"], str):
        raise fleet.FleetError("claude.minVersion must be a string")
    if "token_file" in data and not isinstance(data["token_file"], str):
        raise fleet.FleetError("token_file must be a path string")
    roles = data.get("roles", {})
    fleet._keys(roles, set(ROLES), "roles")
    for role, layer in roles.items():
        _layer(layer, f"roles.{role}")
    scoped = {host["name"] for host in fleet.hosts_for(fleet_doc, "client-config")}
    for name, layer in data.get("hosts", {}).items():
        if name not in scoped:
            raise fleet.FleetError(f"hosts.{name} is not a fleet host with the client-config scope")
        _layer(layer, f"hosts.{name}")
        if layer.get("role", "remote") not in ROLES:
            raise fleet.FleetError(f"hosts.{name}.role must be one of {list(ROLES)}")
    return data


def role_of(catalog: dict, fleet_doc: dict, host: str) -> str:
    default = "local" if host == fleet_doc["source_host"] else "remote"
    return catalog.get("hosts", {}).get(host, {}).get("role", default)


def settings_for(catalog: dict, fleet_doc: dict, host: str) -> dict:
    """Base, then role, then host overrides. Top-level Claude settings replace whole values."""
    codex = {"top": {}, "sections": {}, "reportOnly": list(catalog.get("codex", {}).get("reportOnly", []))}
    claude = {"settings": {}, "env": {}, "token_env": None,
              "minVersion": catalog.get("claude", {}).get("minVersion")}
    role = role_of(catalog, fleet_doc, host)
    layers = [catalog, catalog.get("roles", {}).get(role, {}), catalog.get("hosts", {}).get(host, {})]
    for layer in layers:
        c = layer.get("codex", {})
        codex["top"].update(c.get("top", {}))
        for name, keys in c.get("sections", {}).items():
            codex["sections"].setdefault(name, {}).update(keys)
        k = layer.get("claude", {})
        claude["settings"].update(k.get("settings", {}))
        claude["env"].update(k.get("env", {}))
        if "token_env" in k:
            claude["token_env"] = k["token_env"]
    return {"role": role, "codex": codex, "claude": claude}


def describe(name: str, result: dict) -> list:
    lines = []
    codex = result["codex"]
    if codex["status"] == "absent":
        lines.append(f"{name}: codex absent, skipped")
    else:
        state = "CHANGED " + ",".join(codex["changes"]) if codex["changes"] else "unchanged"
        backup = f" (backup {codex['backup']})" if codex.get("backup") else ""
        report = " ".join(f"{k}={v}" for k, v in codex["report"].items())
        lines.append(f"{name}: codex {state}{backup}" + (f"; host-local {report}" if report else ""))
    claude = result["claude"]
    if claude["status"] == "absent":
        lines.append(f"{name}: claude absent, skipped")
    else:
        state = "CHANGED " + ",".join(claude["changes"]) if claude["changes"] else "unchanged"
        backup = f" (backup {claude['backup']})" if claude.get("backup") else ""
        lines.append(f"{name}: claude {state}{backup}")
    cc = result.get("claude_code")
    if cc:
        if cc["updated_to"]:
            lines.append(f"{name}: claude-code {cc['have']} -> {cc['updated_to']} (min {cc['min']})")
        elif cc["ok"]:
            lines.append(f"{name}: claude-code {cc['have']} ok")
        else:
            lines.append(f"{name}: claude-code {cc['have'] or 'not found'}, below min {cc['min']} (run with --update-claude)")
    return lines


def status_of(result: dict, dry_run: bool) -> str:
    changed = any(result[k]["status"] == "changed" for k in ("codex", "claude"))
    if not changed:
        return "same"
    return "would update" if dry_run else "updated"


def run(fleet_doc: dict, fleet_dir: Path, targets: list, dry_run: bool, update_claude: bool,
        emit: Callable[[str], None]) -> dict:
    catalog = load_catalog(fleet_dir / "client-config.json", fleet_doc)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    token = None
    statuses = {}
    for host in targets:
        name = host["name"]
        wanted = settings_for(catalog, fleet_doc, name)
        if wanted["claude"]["token_env"] and token is None:
            token_file = catalog.get("token_file")
            if not token_file:
                raise fleet.FleetError("claude.token_env is set but token_file is missing")
            try:
                token = Path(token_file).expanduser().read_text(encoding="utf-8").strip()
            except OSError as error:
                raise fleet.FleetError(f"cannot read token_file: {error.strerror}") from error
        payload = {"codex": wanted["codex"], "claude": wanted["claude"],
                   "token": token if wanted["claude"]["token_env"] else None,
                   "stamp": stamp, "dry_run": dry_run, "update_claude": update_claude}
        result, output = fleet.run_node(name, name == fleet_doc["source_host"], MERGE_JS, payload,
                                        UPDATE_TIMEOUT_SECONDS if update_claude else TIMEOUT_SECONDS)
        if result is None or result.get("error"):
            error = output if result is None else result["error"]
            if token:
                error = error.replace(token, "<token>")
            emit(f"{name} ({wanted['role']}): FAILED: {error}")
            statuses[name] = "FAILED"
            continue
        for line in describe(f"{name} ({wanted['role']})", result):
            emit(line)
        statuses[name] = status_of(result, dry_run)
    return statuses


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing")
    parser.add_argument("--host", help="sync only this fleet host")
    parser.add_argument("--update-claude", action="store_true", help="run `claude update` below the minimum version")
    args = parser.parse_args(argv)
    source = fleet.resolve()
    print(fleet.describe(source))
    if source.path is None:
        print("no fleet directory; nothing to sync", file=sys.stderr)
        return 1
    try:
        fleet_doc = fleet.load(source.path)
        targets = fleet.select(fleet_doc, "client-config", args.host)
        print(f"catalog: {source.path / 'client-config.json'}")
        statuses = run(fleet_doc, source.path, targets, args.dry_run, args.update_claude,
                       lambda line: print("  " + line, flush=True))
    except fleet.FleetError as error:
        print(f"invalid: {error}", file=sys.stderr)
        return 2 if isinstance(error, fleet.HostSelectionError) else 1
    return 1 if "FAILED" in statuses.values() else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Resolve and validate the private fleet for personal-skills.

Order: $LOADOUT_FLEET, then the per-user config directory
(${XDG_CONFIG_HOME:-~/.config}/loadout/fleet, or %APPDATA%\\loadout\\fleet on
Windows), then the legacy fleet/local/ beside the installed SKILL.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, NamedTuple, Optional

SKILL_DIR = Path(__file__).resolve().parent.parent
SCHEMA_VERSIONS = {1, 2}
TRANSPORTS = {"ssh", "paseo-relay"}
SCOPES = ("skills", "plugins", "providers")
FILE_SCOPES = {"skills", "plugins"}
OSES = {"macos", "windows", "linux"}
CLIENTS = {"codex", "claude", "opencode"}
TOP_KEYS = {"schema_version", "source_host", "transport", "notes", "hosts", "global"}
HOST_KEYS = {"name", "os", "checkout", "clients", "paseo", "transport", "sync", "paseo_offer"}
PASEO_KEYS = {"plugin_root", "stage", "install"}


class FleetSource(NamedTuple):
    kind: str  # "env", "config", "legacy", or "none"
    path: Optional[Path]


def config_fleet_dir(env: Mapping[str, str], windows: bool) -> Optional[Path]:
    if windows:
        appdata = env.get("APPDATA")
        return Path(appdata) / "loadout" / "fleet" if appdata else None
    base = env.get("XDG_CONFIG_HOME") or str(Path(env.get("HOME", "~")).expanduser() / ".config")
    return Path(base) / "loadout" / "fleet"


def resolve(
    env: Mapping[str, str] = os.environ,
    skill_dir: Path = SKILL_DIR,
    windows: bool = os.name == "nt",
) -> FleetSource:
    explicit = env.get("LOADOUT_FLEET")
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_dir():
            raise SystemExit(f"LOADOUT_FLEET is not a directory: {path}")
        return FleetSource("env", path)
    config = config_fleet_dir(env, windows)
    if config is not None and config.is_dir():
        return FleetSource("config", config)
    legacy = skill_dir / "fleet" / "local"
    if legacy.is_dir():
        return FleetSource("legacy", legacy)
    return FleetSource("none", None)


def describe(source: FleetSource) -> str:
    if source.path is None:
        return "fleet: none (current host only)"
    return f"fleet: {source.kind} {source.path}"


class FleetError(ValueError):
    pass


def _strings(value: Any, where: str, allowed: Optional[set] = None) -> list:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise FleetError(f"{where} must be a list of strings")
    if len(set(value)) != len(value):
        raise FleetError(f"{where} has duplicates")
    unknown = sorted(set(value) - allowed) if allowed is not None else []
    if unknown:
        raise FleetError(f"{where} has unknown values {unknown}; allowed {sorted(allowed)}")
    return value


def _keys(obj: Any, allowed: set, where: str) -> None:
    if not isinstance(obj, dict):
        raise FleetError(f"{where} must be an object")
    unknown = sorted(set(obj) - allowed)
    if unknown:
        raise FleetError(f"{where} has unknown keys {unknown}")


def validate(data: Any) -> dict:
    """Check a hosts.json document and fill in each host's effective transport and sync."""
    _keys(data, TOP_KEYS, "hosts.json")
    version = data.get("schema_version", 1)
    if version not in SCHEMA_VERSIONS:
        raise FleetError(f"schema_version {version!r} is not one of {sorted(SCHEMA_VERSIONS)}")
    default_transport = data.get("transport", "ssh")
    if version == 1:
        # Version 1 recorded transport as free text; every host was reached over SSH.
        default_transport = "ssh"
    elif default_transport not in TRANSPORTS:
        raise FleetError(f"transport {default_transport!r} is not one of {sorted(TRANSPORTS)}")
    hosts = data.get("hosts")
    if not isinstance(hosts, list) or not hosts:
        raise FleetError("hosts must be a non-empty list")
    names = set()
    out = []
    for index, host in enumerate(hosts):
        where = f"hosts[{index}]"
        _keys(host, HOST_KEYS, where)
        name = host.get("name")
        if not isinstance(name, str) or not name:
            raise FleetError(f"{where}.name must be a non-empty string")
        where = f"host {name}"
        if name in names:
            raise FleetError(f"{where} is listed twice")
        names.add(name)
        if host.get("os") not in OSES:
            raise FleetError(f"{where}: os {host.get('os')!r} is not one of {sorted(OSES)}")
        transport = host.get("transport", default_transport)
        if transport not in TRANSPORTS:
            raise FleetError(f"{where}: transport {transport!r} is not one of {sorted(TRANSPORTS)}")
        paseo = host.get("paseo")
        if paseo is not None:
            _keys(paseo, PASEO_KEYS, f"{where}.paseo")
            stage = _strings(paseo.get("stage", []), f"{where}.paseo.stage")
            install = _strings(paseo.get("install", []), f"{where}.paseo.install")
            if not set(install) <= set(stage):
                raise FleetError(f"{where}.paseo.install must be a subset of stage")
        if "sync" in host:
            sync = _strings(host["sync"], f"{where}.sync", set(SCOPES))
            if not sync:
                raise FleetError(f"{where}.sync must not be empty")
        elif transport == "paseo-relay":
            raise FleetError(f"{where}: a paseo-relay host needs an explicit sync list, such as [\"providers\"]")
        else:
            sync = ["skills"] + (["plugins"] if paseo is not None else [])
        if transport == "paseo-relay":
            blocked = sorted(set(sync) & FILE_SCOPES)
            if blocked:
                raise FleetError(f"{where}: paseo-relay has no file transport, so sync cannot include {blocked}")
            if not isinstance(host.get("paseo_offer"), str):
                raise FleetError(f"{where}: a paseo-relay host needs paseo_offer, the path to its pairing offer")
        if "paseo_offer" in host and not isinstance(host["paseo_offer"], str):
            raise FleetError(f"{where}.paseo_offer must be a string path")
        if "skills" in sync:
            _strings(host.get("clients"), f"{where}.clients", CLIENTS)
        elif "clients" in host:
            _strings(host["clients"], f"{where}.clients", CLIENTS)
        if "plugins" in sync and paseo is None:
            raise FleetError(f"{where}: sync includes plugins but the host has no paseo entry")
        checkout = host.get("checkout")
        if checkout is not None and not isinstance(checkout, str):
            raise FleetError(f"{where}.checkout must be a string or null")
        out.append({**host, "transport": transport, "sync": sync})
    source = data.get("source_host")
    if source not in names:
        raise FleetError(f"source_host {source!r} is not a listed host")
    if next(h for h in out if h["name"] == source)["transport"] != "ssh":
        raise FleetError("source_host must use the ssh transport; it runs locally")
    if "global" in data:
        _keys(data["global"], CLIENTS, "global")
        for client, target in data["global"].items():
            if not isinstance(target, str):
                raise FleetError(f"global.{client} must be a string path")
    return {**data, "schema_version": version, "hosts": out}


def load(directory: Path) -> dict:
    path = directory / "hosts.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise FleetError(f"cannot read {path}: {error}") from error
    return validate(data)


def hosts_for(fleet: dict, scope: str) -> list:
    return [host for host in fleet["hosts"] if scope in host["sync"]]


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["resolve", "validate"])
    args = parser.parse_args(argv)
    source = resolve()
    print(describe(source))
    if args.command == "validate" and source.path is not None:
        try:
            fleet = load(source.path)
        except FleetError as error:
            print(f"invalid: {error}", file=sys.stderr)
            return 1
        print(f"schema_version {fleet['schema_version']}, source_host {fleet['source_host']}")
        for host in fleet["hosts"]:
            skipped = [scope for scope in SCOPES if scope not in host["sync"]]
            print(f"  {host['name']}: {host['transport']}, sync {','.join(host['sync'])}"
                  + (f"; skipped {','.join(skipped)}" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

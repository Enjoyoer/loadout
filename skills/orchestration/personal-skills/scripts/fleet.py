#!/usr/bin/env python3
"""Resolve and validate the private fleet for personal-skills.

Order: $LOADOUT_FLEET, then the per-user config directory
(${XDG_CONFIG_HOME:-~/.config}/loadout/fleet, or %APPDATA%\\loadout\\fleet on
Windows), then the legacy fleet/local/ beside the installed SKILL.md.

`push` carries the source host's fleet directory to every other ssh host, so the
source host is the only place the fleet is edited.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping, NamedTuple, Optional

SKILL_DIR = Path(__file__).resolve().parent.parent
PUSH_JS = Path(__file__).resolve().parent / "fleet_push_remote.js"
# Helpers the remote programs share; run_node ships it ahead of each program.
COMMON_JS = Path(__file__).resolve().parent / "remote_common.js"
SYNC_RECORD = ".loadout-sync.json"
SKIP_NAMES = {SYNC_RECORD, ".DS_Store"}
# Remote programs travel gzip+base64 so they survive cmd.exe and terminal quoting.
BOOT = "eval(require('zlib').gunzipSync(Buffer.from(process.argv[1],'base64')).toString())"
# Keepalives end a session whose host went to sleep or dropped off within about a minute.
SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
               "-o", "ServerAliveCountMax=4"]
PUSH_TIMEOUT_SECONDS = 180
RESULT = re.compile(r"@@LOADOUT-RESULT (.*?) @@END", re.S)
SCHEMA_VERSIONS = {1, 2}
TRANSPORTS = {"ssh", "paseo-relay"}
SCOPES = ("skills", "plugins", "providers", "client-config")
# Scopes that move files or secrets, so they need an ssh transport.
SSH_SCOPES = {"skills", "plugins", "client-config"}
OSES = {"macos", "windows", "linux"}
# Host names are ssh aliases and reach ssh's argv, so a leading '-' would read as an option.
HOST_NAME = re.compile(r"[A-Za-z0-9._][A-Za-z0-9._-]*")
CLIENTS = {"codex", "claude", "opencode", "pi"}
TOP_KEYS = {"schema_version", "source_host", "transport", "notes", "hosts", "global"}
HOST_KEYS = {"name", "os", "checkout", "clients", "paseo", "transport", "sync", "paseo_offer", "exclude_skills"}
PASEO_KEYS = {"plugin_root", "stage", "install"}
# global.claude may name the claudeMd field of Claude Code's managed settings instead of a file.
MANAGED_CLAUDE_MD = "managed-settings:claudeMd"
# Every other global target is a path: ~, /, $VAR or ${VAR}, %VAR%, or a drive like C:\.
GLOBAL_PATH = re.compile(r"(~([\\/]|$)|/|\$\{?[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%|[A-Za-z]:[\\/])")


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


class HostSelectionError(FleetError):
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
        if not HOST_NAME.fullmatch(name):
            raise FleetError(f"{where}.name {name!r} must use only A-Z, a-z, 0-9, '.', '_' or '-' and not start with '-'")
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
            blocked = sorted(set(sync) & SSH_SCOPES)
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
        _strings(host.get("exclude_skills", []), f"{where}.exclude_skills")
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
            if client == "claude" and target == MANAGED_CLAUDE_MD:
                continue
            if not GLOBAL_PATH.match(target):
                token = f"{MANAGED_CLAUDE_MD} or " if client == "claude" else ""
                raise FleetError(f"global.{client} {target!r} must be {token}a path starting with ~, /, $VAR, "
                                 "%VAR%, or a drive like C:\\")
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


def select(fleet: dict, scope: str, only: Optional[str] = None) -> list:
    """Hosts in a scope, optionally narrowed to one host that must exist and be in scope."""
    targets = hosts_for(fleet, scope)
    if only is None:
        return targets
    if only not in {host["name"] for host in fleet["hosts"]}:
        raise HostSelectionError(f"unknown host: {only}")
    targets = [host for host in targets if host["name"] == only]
    if not targets:
        raise HostSelectionError(f"host {only} does not have the {scope} sync scope")
    return targets


def pack(data: bytes) -> str:
    return base64.b64encode(gzip.compress(data)).decode()


def bundle(program: Path) -> bytes:
    """The program with remote_common.js ahead of it: one script, so a host needs no shared file."""
    return COMMON_JS.read_bytes() + b"\n" + program.read_bytes()


def parse_result(output: str) -> Optional[dict]:
    match = RESULT.search(output)
    if not match:
        return None
    return json.loads(match.group(1).replace("\r", "").replace("\n", ""))


def fleet_files(directory: Path) -> dict:
    """Every regular file in the fleet directory except the skills/ overlay, by POSIX relative path."""
    files = {}
    for path in sorted(directory.rglob("*")):
        rel = path.relative_to(directory).as_posix()
        if path.name in SKIP_NAMES or path.name.endswith(".loadout-tmp"):
            continue
        if rel == "skills" or rel.startswith("skills/"):
            continue  # the private skill overlay installs through the skills step, not the fleet copy
        if path.is_symlink():
            raise FleetError(f"symlink in the source fleet directory: {rel}")
        if path.is_file():
            data = path.read_bytes()
            files[rel] = {"sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode()}
    return files


def push_targets(fleet: dict) -> tuple:
    """Hosts that receive the fleet (other ssh hosts) and relay hosts that do not need it."""
    others = [host for host in fleet["hosts"] if host["name"] != fleet["source_host"]]
    return ([host for host in others if host["transport"] == "ssh"],
            [host for host in others if host["transport"] != "ssh"])


def run_node(name: str, local: bool, program: Path, payload: dict, timeout: Optional[float] = None) -> tuple:
    """Run a Loadout node program, bundled with remote_common.js, on a host with a gzip+base64 JSON payload on stdin.

    Returns (result dict or None, raw output). Secrets travel only on stdin.
    """
    body = pack(json.dumps(payload).encode())
    script = pack(bundle(program))
    env = None
    if local:
        command = ["node", "-e", BOOT, "--", script]
        # Inside an agent session, keep daemon commands off the agent's own identity.
        env = {k: v for k, v in os.environ.items() if k not in ("PASEO_AGENT_ID", "PASEO_AGENT_CWD")}
    else:
        command = ["ssh", *SSH_OPTIONS, "--", name, f'node -e "{BOOT}" -- {script}']
    try:
        done = subprocess.run(command, input=body, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout}s"
    output = done.stdout + done.stderr
    result = parse_result(done.stdout)
    if result is None:
        return None, f"no result from host (exit {done.returncode}): {output.strip()[-300:]}"
    return result, output


def push_host(name: str, files: dict, dry_run: bool) -> dict:
    result, error = run_node(name, False, PUSH_JS, {"dry_run": dry_run, "target": None, "files": files},
                             PUSH_TIMEOUT_SECONDS)
    return result if result is not None else {"status": "failed", "error": error}


def describe_push(result: dict) -> str:
    status = result["status"]
    if status == "conflict":
        return f"conflict: hand-edited on the host, nothing written: {', '.join(result['conflicts'])}"
    if status == "failed":
        return f"FAILED: {result['error']}"
    parts = [f"{sign}{len(result[key])}" for sign, key in (("+", "added"), ("~", "changed"), ("-", "removed"))
             if result[key]]
    return status + (f" ({' '.join(parts)})" if parts else "")


def push_to(host: dict, files: dict, dry_run: bool, emit) -> str:
    """Push the fleet files to one host other than the source host. Returns its status."""
    if host["transport"] != "ssh":
        emit(f"{host['name']}: fleet not needed ({host['transport']})")
        return "not needed"
    result = push_host(host["name"], files, dry_run)
    emit(f"{host['name']}: fleet {describe_push(result)}")
    return "FAILED" if result["status"] == "failed" else result["status"]


def push(fleet: dict, directory: Path, dry_run: bool, only: Optional[str], emit) -> dict:
    """Push the fleet to every other ssh host. Returns a status per host."""
    files = fleet_files(directory)
    targets, relays = push_targets(fleet)
    return {host["name"]: push_to(host, files, dry_run, emit) for host in relays + targets
            if only in (None, host["name"])}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["resolve", "validate", "push"])
    parser.add_argument("--dry-run", action="store_true", help="push: report without writing")
    parser.add_argument("--host", help="push: only this host")
    args = parser.parse_args(argv)
    source = resolve()
    print(describe(source))
    if args.command == "resolve":
        return 0
    if source.path is None:
        return 0 if args.command == "validate" else 1
    try:
        fleet = load(source.path)
    except FleetError as error:
        print(f"invalid: {error}", file=sys.stderr)
        return 1
    if args.command == "push":
        if args.host and args.host not in {host["name"] for host in fleet["hosts"]}:
            print(f"unknown host: {args.host}", file=sys.stderr)
            return 2
        if args.host == fleet["source_host"]:
            print(f"{args.host}: fleet source (not pushed)")
            return 0
        try:
            statuses = push(fleet, source.path, args.dry_run, args.host, lambda line: print("  " + line, flush=True))
        except FleetError as error:
            print(f"invalid: {error}", file=sys.stderr)
            return 1
        return 0 if all(s in ("same", "updated", "would update", "not needed") for s in statuses.values()) else 1
    print(f"schema_version {fleet['schema_version']}, source_host {fleet['source_host']}")
    for host in fleet["hosts"]:
        skipped = [scope for scope in SCOPES if scope not in host["sync"]]
        print(f"  {host['name']}: {host['transport']}, sync {','.join(host['sync'])}"
              + (f"; skipped {','.join(skipped)}" if skipped else ""))
    return 0

if __name__ == "__main__":
    sys.exit(main())

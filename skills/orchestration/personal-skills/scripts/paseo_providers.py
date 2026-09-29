#!/usr/bin/env python3
"""Sync pinned Paseo provider-picker rows to every fleet host in the providers scope.

Reads <fleet>/paseo-providers.json, merges its pinned provider fields into each
host's ~/.paseo/config.json (every other provider and host-local field is kept,
and the file is backed up in place), then reloads the daemon. Write and reload
are reported separately.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import fleet

MERGE_JS = Path(__file__).resolve().parent / "paseo_providers_merge.js"
BOOT = fleet.BOOT
pack = fleet.pack
parse_result = fleet.parse_result
CONFIG_KEYS = {"providers", "env", "hosts"}
HOST_KEYS = {"env", "inherit_env", "required_env"}
AGENT_VARS = ("PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_HOME")
RELAY_TITLE = "loadout-provider-sync"
# Relay timings; the environment overrides exist for tests.
RELAY_WAIT_SECONDS = float(os.environ.get("LOADOUT_RELAY_WAIT_SECONDS", 120))
RELAY_READY_SECONDS = float(os.environ.get("LOADOUT_RELAY_READY_SECONDS", 30))
RELAY_RESEND_SECONDS = float(os.environ.get("LOADOUT_RELAY_RESEND_SECONDS", 15))
RELAY_POLL_SECONDS = float(os.environ.get("LOADOUT_RELAY_POLL_SECONDS", 2))
RELAY_SENDS = 3
RELOAD_TIMEOUT_SECONDS = 90


def _env_map(value, where):
    if not isinstance(value, dict) or not all(
        isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())
        for env in value.values()
    ):
        raise fleet.FleetError(f"{where} must map provider names to string env objects")
    return value


def load_config(path: Path, fleet_doc: dict) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise fleet.FleetError(f"cannot read {path}: {error}") from error
    fleet._keys(data, CONFIG_KEYS, path.name)
    providers = data.get("providers")
    if not isinstance(providers, dict) or not providers:
        raise fleet.FleetError("providers must be a non-empty object")
    for name, block in providers.items():
        models = block.get("models") if isinstance(block, dict) else None
        if not isinstance(models, list) or not models:
            raise fleet.FleetError(f"providers.{name}.models must be a non-empty list")
        ids = set()
        for model in models:
            model_id, label = model.get("id"), model.get("label")
            if not isinstance(model_id, str) or not model_id or model_id in ids:
                raise fleet.FleetError(f"providers.{name}: model ids must be unique non-empty strings")
            ids.add(model_id)
            # Picker labels are names only: no model IDs or version numbers.
            if not isinstance(label, str) or not label.strip() or re.search(r"\d", label) \
                    or model_id.lower() in label.lower():
                raise fleet.FleetError(f"providers.{name}.{model_id}: label {label!r} must be a name only")
    _env_map(data.get("env", {}), "env")
    scoped = {host["name"] for host in fleet.hosts_for(fleet_doc, "providers")}
    for name, settings in data.get("hosts", {}).items():
        if name not in scoped:
            raise fleet.FleetError(f"hosts.{name} is not a fleet host with the providers scope")
        fleet._keys(settings, HOST_KEYS, f"hosts.{name}")
        _env_map(settings.get("env", {}), f"hosts.{name}.env")
        if not isinstance(settings.get("inherit_env", True), bool):
            raise fleet.FleetError(f"hosts.{name}.inherit_env must be true or false")
        required = settings.get("required_env", {})
        if not isinstance(required, dict) or not all(
            isinstance(keys, list) and all(isinstance(k, str) for k in keys) for keys in required.values()
        ):
            raise fleet.FleetError(f"hosts.{name}.required_env must map providers to lists of env names")
    return data


def payload(config: dict, host: str, stamp: str, dry_run: bool) -> dict:
    settings = config.get("hosts", {}).get(host, {})
    env = {k: dict(v) for k, v in config.get("env", {}).items()} if settings.get("inherit_env", True) else {}
    for provider, values in settings.get("env", {}).items():
        env.setdefault(provider, {}).update(values)
    return {
        "host": host,
        "providers": config["providers"],
        "env": env,
        "required_env": settings.get("required_env", {}),
        "stamp": stamp,
        "dry_run": dry_run,
        "config_path": None,
    }


class Runner:
    """Runs the merge program and the daemon reload on one host."""

    def __init__(self, host: dict, source_host: str, fleet_dir: Path):
        self.host = host
        self.name = host["name"]
        self.local = self.name == source_host
        offer = host.get("paseo_offer")
        self.offer_path = (fleet_dir / Path(offer).expanduser()) if offer else None
        self.mode = "local" if self.local else host["transport"]

    def base_env(self) -> dict:
        return {k: v for k, v in os.environ.items() if k not in AGENT_VARS}

    def relay_env(self) -> dict:
        if self.offer_path is None or not self.offer_path.is_file():
            raise RuntimeError(f"missing pairing offer {self.offer_path}")
        return {**self.base_env(), "PASEO_HOST": self.offer_path.read_text(encoding="utf-8").strip()}

    def paseo(self, *args: str, timeout: int = 60) -> str:
        done = subprocess.run(["paseo", *args], env=self.relay_env(), capture_output=True, text=True, timeout=timeout)
        if done.returncode != 0:
            raise RuntimeError(f"paseo {args[0]} {args[1] if len(args) > 1 else ''}: {done.stderr.strip() or done.stdout.strip()}")
        return done.stdout

    def write(self, program: str, data: str) -> str:
        if self.mode == "local":
            done = subprocess.run(["node", "-e", BOOT, "--", program, data], capture_output=True, text=True)
            return done.stdout + done.stderr
        if self.mode == "ssh":
            command = f'node -e "{BOOT}" -- {program} {data}'
            done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.name, command],
                                  capture_output=True, text=True, stdin=subprocess.DEVNULL)
            return done.stdout + done.stderr
        return self.write_relay(program, data)

    def write_relay(self, program: str, data: str) -> str:
        if self.host["os"] == "windows":
            raise RuntimeError("paseo-relay provider sync needs a POSIX shell on the host")
        self.sweep_stale()
        workspace = terminal = None
        try:
            workspace = json.loads(self.paseo("workspace", "create", "--isolation", "local", "--path", "/tmp",
                                              "--title", RELAY_TITLE, "--json"))["workspaceId"]
            terminal = json.loads(self.paseo("terminal", "create", "--workspace", workspace,
                                             "--name", RELAY_TITLE, "--json"))["id"]
            return self.run_in_terminal(terminal, program, data)
        finally:
            self.cleanup(workspace, terminal)

    def run_in_terminal(self, terminal: str, program: str, data: str) -> str:
        # send-keys does not wait for delivery, and input sent before the shell
        # starts can be lost, so wait for the shell's first output, then resend
        # while the nonce has not been echoed. The merge is idempotent.
        nonce = secrets.token_hex(4)
        done = re.compile(rf"@@LOADOUT-EXIT-{nonce}:(\d+)")
        command = (f"node -e \"{BOOT}\" -- '{program}' '{data}'; "
                   f"printf '\\n@@LOADOUT-EXIT-{nonce}:%s\\n' \"$?\"")
        capture = lambda: self.paseo("terminal", "capture", terminal, "--scrollback")
        start = time.monotonic()
        output = capture()
        while not output.strip() and time.monotonic() - start < RELAY_READY_SECONDS:
            time.sleep(RELAY_POLL_SECONDS)
            output = capture()
        ready = bool(output.strip())
        sends = 0
        last_send = 0.0
        deadline = time.monotonic() + RELAY_WAIT_SECONDS
        while True:
            if done.search(output):
                return output
            now = time.monotonic()
            if sends < RELAY_SENDS and nonce not in output and (sends == 0 or now - last_send >= RELAY_RESEND_SECONDS):
                self.paseo("terminal", "send-keys", terminal, command, "Enter")
                sends += 1
                last_send = now
            elif now > deadline:
                if not output.strip():
                    detail = "the terminal stayed empty, so the shell never started or never received input"
                elif nonce not in output:
                    detail = "the shell " + ("is up" if ready else "started late") + f" but never received the command after {sends} sends"
                else:
                    detail = "the command started but did not finish; last output: " + output.strip()[-200:]
                raise RuntimeError(f"relay terminal did not finish within {int(RELAY_WAIT_SECONDS)}s: {detail}")
            time.sleep(RELAY_POLL_SECONDS)
            output = capture()

    def workspaces(self) -> list:
        return json.loads(self.paseo("workspace", "ls", "--json") or "[]")

    def sweep_stale(self) -> None:
        """Archive sync workspaces a killed earlier run left behind."""
        for entry in self.workspaces():
            if entry.get("name") == RELAY_TITLE:
                self.paseo("workspace", "archive", entry["workspaceId"])

    def cleanup(self, workspace: Optional[str], terminal: Optional[str]) -> None:
        if terminal:
            try:
                self.paseo("terminal", "kill", terminal)
            except (RuntimeError, subprocess.SubprocessError):
                pass
        if workspace:
            for _ in range(5):
                try:
                    self.paseo("workspace", "archive", workspace)
                    if all(entry.get("workspaceId") != workspace for entry in self.workspaces()):
                        return
                except (RuntimeError, subprocess.SubprocessError, ValueError):
                    pass
                time.sleep(RELAY_POLL_SECONDS)
            raise RuntimeError(f"relay workspace cleanup failed: {workspace}")

    def reload(self) -> str:
        if self.mode == "local":
            command = ["paseo", "reload"]
            env = self.base_env()
        elif self.offer_path is not None:
            command = ["paseo", "reload"]
            env = self.relay_env()
        else:
            command = ["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.name, "paseo reload"]
            env = self.base_env()
        try:
            done = subprocess.run(command, env=env, capture_output=True, text=True, timeout=RELOAD_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"timed out after {RELOAD_TIMEOUT_SECONDS}s; the write above still stands")
        if done.returncode != 0:
            raise RuntimeError((done.stderr.strip() or done.stdout.strip() or f"exit {done.returncode}")
                               + "; the write above still stands")
        return "ok"


def sync_host(runner: Runner, config: dict, program: str, stamp: str, dry_run: bool,
              emit: Callable[[str], None]) -> bool:
    name = f"{runner.name} ({runner.mode})"
    try:
        output = runner.write(program, pack(json.dumps(payload(config, runner.name, stamp, dry_run)).encode()))
        result = parse_result(output)
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        emit(f"{name}: write FAILED: {error}")
        return False
    if result is None:
        emit(f"{name}: write FAILED: no result from the merge program: {output.strip()[-300:]}")
        return False
    if result["error"]:
        emit(f"{name}: write FAILED: {result['error']}")
        return False
    state = "CHANGED" if result["changed"] else "unchanged"
    if dry_run and result["changed"]:
        state = "would change (dry run)"
    backup = f"; backup {result['backup']}" if result["backup"] else ""
    emit(f"{name}: write {state}; labels {'verified' if result['verified'] else 'MISMATCH'}; "
         f"preserved [{', '.join(result['preserved'])}]{backup}")
    if not result["verified"]:
        return False
    if dry_run:
        emit(f"{name}: reload skipped (dry run)")
        return True
    try:
        emit(f"{name}: reload {runner.reload()}")
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        emit(f"{name}: reload FAILED: {error}")
        return False
    return True


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing or reloading")
    parser.add_argument("--host", help="sync only this fleet host")
    args = parser.parse_args(argv)

    source = fleet.resolve()
    print(fleet.describe(source))
    if source.path is None:
        print("no fleet directory; nothing to sync", file=sys.stderr)
        return 1
    try:
        fleet_doc = fleet.load(source.path)
        config_path = source.path / "paseo-providers.json"
        config = load_config(config_path, fleet_doc)
    except fleet.FleetError as error:
        print(f"invalid: {error}", file=sys.stderr)
        return 1
    print(f"providers: {config_path}")
    targets = fleet.hosts_for(fleet_doc, "providers")
    if args.host:
        known = {host["name"] for host in fleet_doc["hosts"]}
        if args.host not in known:
            print(f"unknown host: {args.host}", file=sys.stderr)
            return 2
        targets = [host for host in targets if host["name"] == args.host]
        if not targets:
            print(f"host {args.host} does not have the providers sync scope", file=sys.stderr)
            return 2
    skipped = [host["name"] for host in fleet_doc["hosts"] if "providers" not in host["sync"]]
    if skipped and not args.host:
        print(f"skipped (no providers scope): {', '.join(skipped)}")

    # Turn SIGTERM and SIGHUP into exits so relay cleanup still runs.
    for sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, lambda number, _frame: sys.exit(128 + number))
    program = pack(MERGE_JS.read_bytes())
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    ok = True
    for host in targets:
        runner = Runner(host, fleet_doc["source_host"], source.path)
        ok = sync_host(runner, config, program, stamp, args.dry_run, lambda line: print("  " + line, flush=True)) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

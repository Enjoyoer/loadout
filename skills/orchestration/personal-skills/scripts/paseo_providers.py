#!/usr/bin/env python3
"""Sync pinned Paseo provider-picker rows to every fleet host in the providers scope.

Reads <fleet>/paseo-providers.json, merges its pinned provider fields into each
host's ~/.paseo/config.json (every other provider and host-local field is kept,
and the file is backed up in place), then reloads the daemon. Write and reload
are reported separately; a reload failure after an unchanged write is only a
warning.
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
CONFIG_KEYS = {"providers", "env", "hosts", "pi"}
HOST_KEYS = {"env", "inherit_env", "required_env", "providers", "pi"}
AGENT_VARS = ("PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_HOME")
RELAY_TITLE = "loadout-provider-sync"
# Relay timings; the environment overrides exist for tests.
RELAY_WAIT_SECONDS = float(os.environ.get("LOADOUT_RELAY_WAIT_SECONDS", 120))
RELAY_POLL_SECONDS = float(os.environ.get("LOADOUT_RELAY_POLL_SECONDS", 2))
RELAY_READY_SECONDS = float(os.environ.get("LOADOUT_RELAY_READY_SECONDS", 30))
RELAY_SETTLE_SECONDS = float(os.environ.get("LOADOUT_RELAY_SETTLE_SECONDS", 3))
RELAY_RESEND_SECONDS = float(os.environ.get("LOADOUT_RELAY_RESEND_SECONDS", 10))
PROMPT = re.compile(r"[$#%>\u276f]\s*$")
RELOAD_TIMEOUT_SECONDS = 90


def _env_map(value, where):
    if not isinstance(value, dict) or not all(
        isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())
        for env in value.values()
    ):
        raise fleet.FleetError(f"{where} must map provider names to string env objects")
    return value


def _providers(providers, where):
    if not isinstance(providers, dict):
        raise fleet.FleetError(f"{where} must be an object")
    for name, block in providers.items():
        models = block.get("models") if isinstance(block, dict) else None
        if not isinstance(models, list) or not models:
            raise fleet.FleetError(f"providers.{name}.models must be a non-empty list")
        ids = set()
        for model in models:
            if not isinstance(model, dict): raise fleet.FleetError("model must be an object")
            model_id, label = model.get("id"), model.get("label")
            if not isinstance(model_id, str) or not model_id or model_id in ids:
                raise fleet.FleetError(f"providers.{name}: model ids must be unique non-empty strings")
            ids.add(model_id)
            # Picker labels are names only: no model IDs or version numbers.
            if not isinstance(label, str) or not label.strip() or re.search(r"\d", label) \
                    or model_id.lower() in label.lower():
                raise fleet.FleetError(f"providers.{name}.{model_id}: label {label!r} must be a name only")


def _pi(value, where):
    if not isinstance(value, dict): raise fleet.FleetError(f"{where} must be an object")
    fleet._keys(value, {"root", "runtime", "catalogSources", "defaultSourceProvider"}, where)
    if not isinstance(value.get("root"), str) or not isinstance(value.get("runtime"), dict):
        raise fleet.FleetError(f"{where} requires root and runtime")
    if "models" in value["runtime"]: raise fleet.FleetError("Pi models must derive from the shared catalog")
    fleet._strings(value.get("catalogSources", ["claude", "codex"]), f"{where}.catalogSources")


def load_config(path: Path, fleet_doc: dict) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise fleet.FleetError(f"cannot read {path}: {error}") from error
    fleet._keys(data, CONFIG_KEYS, path.name)
    providers = data.get("providers")
    if not isinstance(providers, dict) or not providers:
        raise fleet.FleetError("providers must be a non-empty object")
    _providers(providers, "providers")
    if "pi" in data: _pi(data["pi"], "pi")
    _env_map(data.get("env", {}), "env")
    scoped = {host["name"] for host in fleet.hosts_for(fleet_doc, "providers")}
    for name, settings in data.get("hosts", {}).items():
        if name not in scoped:
            raise fleet.FleetError(f"hosts.{name} is not a fleet host with the providers scope")
        fleet._keys(settings, HOST_KEYS, f"hosts.{name}")
        if "pi" in settings: _pi(settings["pi"], f"hosts.{name}.pi")
        _providers(settings.get("providers", {}), f"hosts.{name}.providers")
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
    providers = {**config["providers"], **settings.get("providers", {})}
    pi = settings.get("pi", config.get("pi"))
    generated = None
    if pi:
        sys.path.insert(0, str(Path(__file__).parent / 'pi'))
        from catalog import derive
        generated = derive(providers, pi)
        providers['pi'] = generated['provider']
        env.setdefault('pi', {})['LOADOUT_PI_ROOT'] = pi['root']
    return {
        "pi": generated,
        "pi_files": ({f.name: f.read_text() for f in (Path(__file__).parent / 'pi').glob('*') if f.suffix in {'.py', '.mjs'}} if generated else {}),
        "host": host,
        "providers": providers,
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
        terminal = None
        try:
            self.cleanup(None)
            workspace = json.loads(self.paseo("workspace", "create", "--isolation", "local", "--path", "/tmp",
                                              "--title", RELAY_TITLE, "--json"))["workspaceId"]
            terminal = json.loads(self.paseo("terminal", "create", "--workspace", workspace,
                                             "--name", RELAY_TITLE, "--json"))["id"]
            return self.run_in_terminal(terminal, program, data)
        finally:
            # Every exit path, including a create that failed after the host made
            # the workspace, ends with no sync workspace left on the host.
            self.cleanup(terminal)

    def run_in_terminal(self, terminal: str, program: str, data: str) -> str:
        nonce = secrets.token_hex(4)
        done = re.compile(rf"@@LOADOUT-EXIT-{nonce}:(\d+)")
        command = (f"node -e \"{BOOT}\" -- '{program}' '{data}'; "
                   f"printf '\\n@@LOADOUT-EXIT-{nonce}:%s\\n' \"$?\"")
        # A relay host's new terminal drops input sent before its shell is up, so
        # wait for a prompt, let the shell settle, then send once.
        self.wait_for_prompt(terminal)
        self.paseo("terminal", "send-keys", terminal, command, "Enter")
        sent = time.monotonic()
        resent = False
        deadline = sent + RELAY_WAIT_SECONDS
        while True:
            output = self.paseo("terminal", "capture", terminal, "--scrollback")
            if done.search(output):
                return output
            # One bounded resend, only when the shell never echoed the command:
            # without the nonce on screen the first send cannot have run.
            if not resent and nonce not in "".join(output.split()) and time.monotonic() - sent >= RELAY_RESEND_SECONDS:
                self.paseo("terminal", "send-keys", terminal, command, "Enter")
                resent = True
            if time.monotonic() > deadline:
                tail = "".join(output.strip().split())[-200:] or "(terminal output empty)"
                raise RuntimeError(f"relay terminal did not finish within {int(RELAY_WAIT_SECONDS)}s; last output: {tail}")
            time.sleep(RELAY_POLL_SECONDS)

    def wait_for_prompt(self, terminal: str) -> bool:
        deadline = time.monotonic() + RELAY_READY_SECONDS
        while True:
            lines = [line for line in self.paseo("terminal", "capture", terminal).splitlines() if line.strip()]
            if lines and PROMPT.search(lines[-1]):
                time.sleep(RELAY_SETTLE_SECONDS)
                return True
            if time.monotonic() > deadline:
                return False
            time.sleep(RELAY_POLL_SECONDS)

    def stale(self) -> list:
        return [entry["workspaceId"] for entry in json.loads(self.paseo("workspace", "ls", "--json") or "[]")
                if entry.get("name") == RELAY_TITLE]

    def cleanup(self, terminal: Optional[str]) -> None:
        """Kill the sync terminal and archive every sync workspace on the host."""
        if terminal:
            try:
                self.paseo("terminal", "kill", terminal)
            except (RuntimeError, subprocess.SubprocessError):
                pass
        left = ["?"]
        for _ in range(5):
            try:
                left = self.stale()
                if not left:
                    return
                for workspace in left:
                    self.paseo("workspace", "archive", workspace)
            except (RuntimeError, subprocess.SubprocessError, ValueError):
                pass
            time.sleep(RELAY_POLL_SECONDS)
        raise RuntimeError(f"relay workspace cleanup failed: {', '.join(left)}")

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
              emit: Callable[[str], None]) -> str:
    """Returns "same", "updated", "would update", or "FAILED"."""
    name = f"{runner.name} ({runner.mode})"
    try:
        output = runner.write(program, pack(json.dumps(payload(config, runner.name, stamp, dry_run)).encode()))
        result = parse_result(output)
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        emit(f"{name}: write FAILED: {error}")
        return "FAILED"
    if result is None:
        emit(f"{name}: write FAILED: no result from the merge program: {output.strip()[-300:]}")
        return "FAILED"
    if result["error"]:
        emit(f"{name}: write FAILED: {result['error']}")
        return "FAILED"
    state = "CHANGED" if result["changed"] else "unchanged"
    if dry_run and result["changed"]:
        state = "would change (dry run)"
    backup = f"; backup {result['backup']}" if result["backup"] else ""
    emit(f"{name}: write {state}; labels {'verified' if result['verified'] else 'MISMATCH'}; "
         f"preserved [{', '.join(result['preserved'])}]{backup}")
    if not result["verified"]:
        return "FAILED"
    if dry_run:
        emit(f"{name}: reload skipped (dry run)")
        return "would update" if result["changed"] else "same"
    try:
        emit(f"{name}: reload {runner.reload()}")
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        if not result["changed"]:
            # Nothing was written, so the daemon's config is what a prior run left; not a sync failure.
            emit(f"{name}: reload warning (config unchanged, not a failure): {error}")
            return "same"
        emit(f"{name}: reload FAILED: {error}")
        return "FAILED"
    return "updated" if result["changed"] else "same"


def run(fleet_doc: dict, fleet_dir: Path, targets: list, dry_run: bool, emit: Callable[[str], None]) -> dict:
    config = load_config(fleet_dir / "paseo-providers.json", fleet_doc)
    program = pack(MERGE_JS.read_bytes())
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return {host["name"]: sync_host(Runner(host, fleet_doc["source_host"], fleet_dir), config, program, stamp,
                                    dry_run, emit)
            for host in targets}


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
    # Turn SIGTERM and SIGHUP into exits so relay cleanup still runs.
    for sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, lambda number, _frame: sys.exit(128 + number))
    try:
        fleet_doc = fleet.load(source.path)
        targets = fleet.select(fleet_doc, "providers", args.host)
        print(f"providers: {source.path / 'paseo-providers.json'}")
        skipped = [host["name"] for host in fleet_doc["hosts"] if "providers" not in host["sync"]]
        if skipped and not args.host:
            print(f"skipped (no providers scope): {', '.join(skipped)}")
        statuses = run(fleet_doc, source.path, targets, args.dry_run, lambda line: print("  " + line, flush=True))
    except fleet.FleetError as error:
        print(f"invalid: {error}", file=sys.stderr)
        return 2 if isinstance(error, fleet.HostSelectionError) else 1
    return 1 if "FAILED" in statuses.values() else 0


if __name__ == "__main__":
    sys.exit(main())

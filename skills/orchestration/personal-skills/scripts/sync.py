#!/usr/bin/env python3
"""Sync the fleet with one command.

Runs, in order: fleet validate, fleet push, skills, plugins, providers,
client-config, honoring each host's `sync` list, then prints one table of
host by scope. Each step's preflight (publication, overlay, catalog, token)
runs once, and an error there fails that step for every host and stops their
later scopes. The step then runs one host at a time, so an error on one host
fails that cell only. A conflict, or a fleet push failure, on a host stops the
later scopes for that host only. Run with --dry-run first.
"""

from __future__ import annotations

import argparse
import signal
import sys
import traceback
from typing import Callable, Optional

import client_config
import fleet
import paseo_providers
import plugins_sync
import skills_sync

STEPS = ("fleet", "skills", "plugins", "providers", "client-config")
OK = {"same", "updated", "would update", "not needed", "source", "drift", "skipped", "-"}
STOPS = {"conflict"}


def preflight(step: str, doc: dict, fleet_dir, targets: list, args, emit: Callable) -> Callable:
    """Build a step's shared state once; returns the step's run for one host."""
    if step == "fleet":
        files = fleet.fleet_files(fleet_dir)
        return lambda host: fleet.push_to(host, files, args.dry_run, emit)
    if step == "skills":
        module, state = skills_sync, skills_sync.preflight(doc, fleet_dir, args.dry_run, emit)
    elif step == "plugins":
        module, state = plugins_sync, plugins_sync.preflight(doc, fleet_dir, args.dry_run, emit, args.migrate_path)
    elif step == "providers":
        module, state = paseo_providers, paseo_providers.preflight(doc, fleet_dir, args.dry_run)
    else:
        module, state = client_config, client_config.preflight(doc, fleet_dir, targets, args.dry_run,
                                                               args.update_claude)
    return lambda host: module.run_host(state, host, emit)


def failed(error: Exception, prefix: str, emit: Callable) -> None:
    """Report an error. Anything but a FleetError is a fault in this code, so its traceback follows."""
    if isinstance(error, fleet.FleetError):
        emit(f"{prefix}FAILED: {error}")
        return
    emit(f"{prefix}FAILED: {type(error).__name__}: {error}")
    for line in "".join(traceback.format_exception(type(error), error, error.__traceback__)).rstrip().splitlines():
        emit(line)


def run_step(step: str, doc: dict, fleet_dir, targets: list, args, emit: Callable) -> tuple:
    """Preflight once, then run each host on its own; any host error fails that host and the next one still runs.

    Returns (status per host, whether the shared preflight failed).
    """
    try:
        run = preflight(step, doc, fleet_dir, targets, args, emit)
    except Exception as error:  # one message, and every host of the step fails
        failed(error, "", emit)
        return {host["name"]: "FAILED" for host in targets}, True
    statuses = {}
    for host in targets:
        try:
            statuses[host["name"]] = run(host)
        except Exception as error:  # a bad result from one host must not end the run
            failed(error, f"{host['name']}: {step} ", emit)
            statuses[host["name"]] = "FAILED"
    return statuses, False


def table(hosts: list, steps: list, cells: dict) -> str:
    rows = [["host", *steps]] + [[h, *(cells[h].get(s, "-") for s in steps)] for h in hosts]
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip() for row in rows)


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="preflight and report everything without writing")
    parser.add_argument("--host", help="sync only this fleet host")
    parser.add_argument("--only", help=f"comma-separated steps from {','.join(STEPS)} (default: all)")
    parser.add_argument("--migrate-path", action="store_true",
                        help="plugins: move plugins installed from another directory to plugin_root, keeping settings")
    parser.add_argument("--update-claude", action="store_true", help="client-config: run `claude update` below minVersion")
    args = parser.parse_args(argv)
    steps = list(STEPS)
    if args.only:
        wanted = args.only.split(",")
        unknown = sorted(set(wanted) - set(STEPS))
        if unknown:
            parser.error(f"unknown steps {unknown}; choose from {','.join(STEPS)}")
        steps = [s for s in STEPS if s in wanted]

    source = fleet.resolve()
    print(fleet.describe(source))
    if source.path is None:
        print("no fleet directory; create one from fleet/example (see fleet/README.md)", file=sys.stderr)
        return 1
    try:
        doc = fleet.load(source.path)
    except fleet.FleetError as error:
        print(f"invalid fleet: {error}", file=sys.stderr)
        return 1
    names = [host["name"] for host in doc["hosts"]]
    if args.host and args.host not in names:
        print(f"unknown host: {args.host}", file=sys.stderr)
        return 2
    hosts = [args.host] if args.host else names
    print(f"fleet valid: schema_version {doc['schema_version']}, {len(names)} hosts" + (" (dry run)" if args.dry_run else ""))
    # Relay cleanup in the provider step runs from finally blocks; make SIGTERM reach them.
    for sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, lambda number, _frame: sys.exit(128 + number))

    cells = {h: {} for h in hosts}
    stopped: set = set()
    emit = lambda line: print("    " + line, flush=True)
    for step in steps:
        print(f"\n== {step}")
        if step == "fleet":
            for h in hosts:
                if h == doc["source_host"]:
                    cells[h]["fleet"] = "source"
            others = [host for host in doc["hosts"] if host["name"] in hosts and host["name"] != doc["source_host"]]
            statuses = run_step(step, doc, source.path, others, args, emit)[0] if others else {}
            for h, status in statuses.items():
                cells[h]["fleet"] = status
                if status not in OK:
                    stopped.add(h)
            continue
        scoped = {host["name"] for host in fleet.hosts_for(doc, step)}
        targets = {}
        for h in hosts:
            if h not in scoped:
                cells[h][step] = "skipped"
            elif h in stopped:
                cells[h][step] = "stopped"
            else:
                targets[h] = next(host for host in doc["hosts"] if host["name"] == h)
        if not targets:
            emit("no hosts")
            continue
        statuses, shared_failed = run_step(step, doc, source.path, list(targets.values()), args, emit)
        for h, status in statuses.items():
            cells[h][step] = status
            if status in STOPS or shared_failed:
                stopped.add(h)

    print("\n" + table(hosts, steps, cells))
    bad = {c for row in cells.values() for c in row.values()} - OK - {"stopped"}
    if stopped:
        print(f"\nstopped after a conflict, a fleet failure, or a failed shared preflight: {', '.join(sorted(stopped))}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

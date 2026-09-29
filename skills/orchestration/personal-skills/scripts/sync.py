#!/usr/bin/env python3
"""Sync the fleet with one command.

Runs, in order: fleet validate, fleet push, skills, plugins, providers,
client-config, honoring each host's `sync` list, then prints one table of
host by scope. A conflict, or a fleet push failure, on a host stops the later
scopes for that host only. Run with --dry-run first.
"""

from __future__ import annotations

import argparse
import signal
import sys
from typing import Callable, Optional

import client_config
import fleet
import paseo_providers
import plugins_sync
import skills_sync

STEPS = ("fleet", "skills", "plugins", "providers", "client-config")
OK = {"same", "updated", "would update", "not needed", "source", "drift", "skipped", "-"}
STOPS = {"conflict"}


def scope_runner(step: str, args) -> Callable:
    if step == "skills":
        return lambda doc, path, targets, emit: skills_sync.run(doc, path, targets, args.dry_run, emit)
    if step == "plugins":
        return lambda doc, path, targets, emit: plugins_sync.run(doc, path, targets, args.dry_run, emit,
                                                                  args.migrate_path)
    if step == "providers":
        return lambda doc, path, targets, emit: paseo_providers.run(doc, path, targets, args.dry_run, emit)
    return lambda doc, path, targets, emit: client_config.run(doc, path, targets, args.dry_run,
                                                              args.update_claude, emit)


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
            statuses = fleet.push(doc, source.path, args.dry_run, args.host, emit)
            for h, status in statuses.items():
                cells[h]["fleet"] = status
                if status not in OK:
                    stopped.add(h)
            continue
        scoped = {host["name"] for host in fleet.hosts_for(doc, step)}
        targets = []
        for h in hosts:
            if h not in scoped:
                cells[h][step] = "skipped"
            elif h in stopped:
                cells[h][step] = "stopped"
            else:
                targets.append(next(host for host in doc["hosts"] if host["name"] == h))
        if not targets:
            emit("no hosts")
            continue
        try:
            statuses = scope_runner(step, args)(doc, source.path, targets, emit)
        except fleet.FleetError as error:
            emit(f"FAILED: {error}")
            statuses = {host["name"]: "FAILED" for host in targets}
        for h, status in statuses.items():
            cells[h][step] = status
            if status in STOPS:
                stopped.add(h)

    print("\n" + table(hosts, steps, cells))
    bad = {c for row in cells.values() for c in row.values()} - OK - {"stopped"}
    if stopped:
        print(f"\nstopped after a conflict or fleet failure: {', '.join(sorted(stopped))}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

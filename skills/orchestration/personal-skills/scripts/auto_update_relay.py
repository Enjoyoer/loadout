#!/usr/bin/env python3
"""Relay the auto-update feed and canary receipts from the publishing host to the other registry hosts.

Run on the host the registry names as feed.source_host (and as the canary host for canary rows). For each other
registry host with an `ssh` alias, `auto-update.mjs export` produces the copies that validate now (the feed, and
the receipts of canary rows that host runs), and fleet.run_node ships them in the fleet's digest-checked stdin
envelope to auto_update_relay_remote.js, which writes them only to the runner's fixed owner-only relay files.
Nothing here builds a path, a command or a value from the feed. --dry-run checks everything and writes nothing.

  push [--dry-run] [--host <target>]   send now, by hand
  tick --self <host> [--node <path>]   scheduler entry, after each runner tick on the publishing host: sends a
                                       target only what changed since it last answered (a new feed, a new receipt),
                                       or everything again after RESEND_HOURS. Quiet on any other host. A target
                                       that could not be reached is tried again next tick; that resends data only,
                                       never an apply: a failed version stays held by each host's own state.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet  # noqa: E402
import probe  # noqa: E402

HERE = Path(__file__).resolve().parent
RECEIVER = HERE / "auto_update_relay_remote.js"
RUNNER = HERE / "auto-update" / "auto-update.mjs"
TIMEOUT_SECONDS = 120
RESEND_HOURS = 6
NODE = "node"


def state_dir() -> Path:
    """The runner's state directory (auto-update.mjs stateDir)."""
    if sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        root = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return root / "loadout" / "auto-update"


def load_sent() -> dict:
    """What each target last answered for. Absent or not valid JSON means nothing recorded, so everything is sent
    again (data only); any other error reading it propagates and this tick sends nothing."""
    try:
        text = (state_dir() / "relay-sent.json").read_text(encoding="utf-8")
    except probe.ABSENT:
        return {}
    try:
        doc = json.loads(text)
    except ValueError:
        return {}
    return doc if isinstance(doc, dict) else {}


def save_sent(sent: dict) -> None:
    folder = state_dir()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".relay-sent.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(sent, handle, indent=1, sort_keys=True)
    os.replace(tmp, folder / "relay-sent.json")


def export(fleet_dir: Path, source: str, target: str) -> tuple:
    """The header and relay docs `export` prints for one target host."""
    env = dict(os.environ, LOADOUT_FLEET=str(fleet_dir))
    done = subprocess.run([NODE, str(RUNNER), "export", "--host", source, "--for", target],
                          capture_output=True, text=True, env=env, timeout=60)
    if done.returncode != 0:
        raise fleet.FleetError(f"export for {target} failed: {done.stderr.strip()[-200:]}")
    lines = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    return lines[0], lines[1:]


def describe(result: dict) -> str:
    if result.get("status") == "failed":
        return f"FAILED: {result.get('error')}"
    parts = [result["status"]]
    for key in ("written", "same"):
        if result.get(key):
            parts.append(f"{key} {', '.join(result[key])}")
    for r in result.get("rejected", []):
        parts.append(f"rejected {r.get('name')}: {r.get('why')}")
    return "; ".join(parts)


def relay(fleet_dir: Path, dry_run: bool, only: Optional[str], emit, changed_only: bool = False,
          self_host: Optional[str] = None) -> bool:
    registry = json.loads((fleet_dir / "auto-update" / "registry.json").read_text(encoding="utf-8"))
    source = registry.get("feed", {}).get("source_host")
    if changed_only and source != self_host:
        return True  # not the publishing host: nothing to relay, nothing to say
    if not source:
        raise fleet.FleetError("registry.feed.source_host is not set; nothing to relay")
    sent = load_sent() if changed_only else {}
    now = dt.datetime.now(dt.timezone.utc)
    targets = [name for name, host in registry["hosts"].items() if name != source and host.get("ssh")]
    if only is not None:
        if only not in targets:
            raise fleet.FleetError(f"{only} is not a relay target (another registry host with ssh)")
        targets = [only]
    ok = True
    for target in targets:
        header, docs = export(fleet_dir, source, target)
        digests = {d["name"]: d["doc"]["sha256"] for d in docs}
        last = sent.get(target, {})
        if changed_only:
            try:
                fresh = now - dt.datetime.fromisoformat(last.get("at", "").replace("Z", "+00:00")) < dt.timedelta(hours=RESEND_HOURS)
            except ValueError:
                fresh = False
            if fresh and digests == last.get("docs"):
                continue
        for s in header["skipped"]:
            emit(f"{target}: not sent {s['name']}: {s['why']}")
        if not docs:
            emit(f"{target}: nothing valid to send")
            ok = False
            continue
        payload = {"dry_run": dry_run, "for_host": target, "docs": docs}
        result, output = fleet.run_node(header["ssh"], False, RECEIVER, payload, TIMEOUT_SECONDS)
        if result is None:
            result = {"status": "failed", "error": output}
        emit(f"{target}: {describe(result)}")
        ok = ok and result["status"] in ("updated", "same", "would update")
        # The target answered for these exact bytes (written, same or refused): do not send them again until they
        # change. No answer (unreachable, timeout) or a file-system error there is not recorded, so the next tick
        # tries again; that resends data only.
        transient = any(r.get("transient") for r in result.get("rejected", []))
        if changed_only and result["status"] != "failed" and not transient:
            sent[target] = {"docs": digests, "at": now.strftime("%Y-%m-%dT%H:%M:%SZ")}
            save_sent(sent)
    return ok


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["push", "tick"])
    parser.add_argument("--dry-run", action="store_true", help="check and report, write nothing")
    parser.add_argument("--host", help="only this registry host")
    parser.add_argument("--self", dest="self_host", help="tick: this host's registry name")
    parser.add_argument("--node", help="the Node to run the exporter with (schedulers have a bare PATH)")
    args = parser.parse_args(argv)
    global NODE
    if args.node:
        NODE = args.node
    if args.command == "tick" and (not args.self_host or args.dry_run or args.host):
        print("tick takes --self <host> only", file=sys.stderr)
        return 2
    source = fleet.resolve()
    if source.path is None:
        print("no fleet directory", file=sys.stderr)
        return 1
    try:
        ok = relay(source.path, args.dry_run, args.host, lambda line: print(line, flush=True),
                   changed_only=args.command == "tick", self_host=args.self_host)
        return 0 if ok else 1
    except (fleet.FleetError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"relay: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

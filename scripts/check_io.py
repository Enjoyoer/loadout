#!/usr/bin/env python3
"""Repo I/O rules: python3 scripts/check_io.py [raw-write] [fail-open-probe] [--base REV] (default: every rule).

Rule raw-write fails when plugin or remote-program code writes or removes files outside the shared
safe-write helpers, applied two ways:

- Plugins (strict). Plugin code outside test/ and vendor/ may import only read-side
  functions from node:fs and node:fs/promises. Plugin state is written through
  writeJsonAtomically in plugins/<id>/server/vendor/atomic-json.ts.
- Remote programs (ratchet). The fleet sync's remote programs in
  skills/orchestration/personal-skills/scripts/ write with replaceFile() and delete with
  removeFile() from remote_common.js. Raw fs write calls in each other program are
  counted, and the check fails when a count grows past BASELINE.

Rule fail-open-probe fails when a change adds a probe that reads an error or unknown state as
absent, empty, or a default: a catch that only returns a default, existsSync, a Python `if not
p.is_dir(): return {}` (or `... if p.is_file() else {}`), or an `except OSError` (or broader) that
only returns a default. Plugin, fleet sync, and OPC code holds many such probes already, so the
rule is a ratchet: it counts them per file and fails when a file has more than at the merge base
of --base (default origin/main) and HEAD. A renamed file keeps its old count. The fix is a probe
that reads only ENOENT or ENOTDIR as absent and throws anything else: probe() and isAbsent() in
plugins/_shared/fs-probe.ts and remote_common.js, and probe() and ABSENT in personal-skills/scripts/probe.py.

An exception goes on the offending line itself, with a reason and an expiry date:
    // raw-write-ok: <reason>; expires YYYY-MM-DD
    # probe-ok: <reason>; expires YYYY-MM-DD
An expired exception fails the check.
"""

from __future__ import annotations

import argparse
import datetime
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
REMOTE = ROOT / "skills" / "orchestration" / "personal-skills" / "scripts"
OPC = ROOT / "skills" / "orchestration" / "opc" / "scripts"

# Functions plugin code may import from node:fs or node:fs/promises. Anything else is a write.
READ_SIDE = {
    "access", "accessSync", "constants", "createReadStream", "existsSync", "lstat", "lstatSync",
    "mkdir", "mkdirSync", "opendir", "readFile", "readFileSync", "readdir", "readdirSync",
    "readlink", "readlinkSync", "realpath", "realpathSync", "stat", "statSync", "watch",
    "Dirent", "Stats",
}
FS_IMPORT = re.compile(
    r"""import\s+(?P<what>[^;'"]*?)\s+from\s*['"](?:node:)?fs(?:/promises)?['"]"""
    r"""|require\(\s*['"](?:node:)?fs(?:/promises)?['"]\s*\)""",
    re.S,
)
REMOTE_WRITE = re.compile(r"\b(writeFileSync|renameSync|rmSync|unlinkSync|copyFileSync|openSync)\s*\(")
# Raw fs write calls per remote program on main when this check was added. Lower a number
# when you remove calls; never raise one.
BASELINE = {
    "client_config_merge.js": 6,
    "paseo_providers_merge.js": 8,
    "plugins_sync_remote.js": 1,
    "skills_sync_remote.js": 7,
}
# What follows an exception's tag (raw-write-ok, probe-ok) on the offending line.
EXCEPTION = r":\s*(?P<reason>[^;]*\S)\s*;\s*expires\s+(?P<date>\d{4}-\d{2}-\d{2})"
PLUGIN_FIX = ("Plugin state is written only through writeJsonAtomically in ./vendor/atomic-json.ts "
              "(copy of plugins/_shared/atomic-json.ts); add the plugin to CONSUMERS in scripts/check_vendored.py.")
REMOTE_FIX = ("Write with replaceFile() and delete with removeFile() from remote_common.js; they re-check "
              "ancestors and recorded hashes at the point of use.")


def excepted(line: str, rel: str, n: int, found: list[str], tag: str = "raw-write-ok") -> bool:
    """True when the line carries a current exception; an expired or malformed one is reported."""
    if tag not in line:
        return False
    m = re.search(re.escape(tag) + EXCEPTION, line)
    if not m:
        found.append(f"{rel}:{n}: malformed exception; write `{tag}: <reason>; expires YYYY-MM-DD`.")
        return False
    if datetime.date.fromisoformat(m["date"]) < datetime.date.today():
        found.append(f"{rel}:{n}: exception expired on {m['date']} ({m['reason']}). Fix the line or renew with a new reason.")
        return False
    return True


def plugin_files() -> list[Path]:
    out = []
    for plugin in sorted(PLUGINS.iterdir()):
        if not plugin.is_dir() or plugin.name.startswith("_"):
            continue
        for directory, subdirs, files in os.walk(plugin):
            subdirs[:] = sorted(d for d in subdirs if d not in {"node_modules", "test", "vendor"})
            out += [Path(directory, f) for f in sorted(files)
                    if f.endswith((".ts", ".js", ".mjs", ".cjs")) and not f.endswith((".test.ts", ".d.ts"))]
    return out


def plugin_problems() -> list[str]:
    found: list[str] = []
    for path in plugin_files():
        rel = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        for m in FS_IMPORT.finditer(text):
            n = text.count("\n", 0, m.start()) + 1
            if excepted(lines[n - 1], rel, n, found):
                continue
            what = m["what"]
            named = re.fullmatch(r"(?:type\s+)?\{(?P<names>[^}]*)\}", (what or "").strip())
            if what is None or not named:
                found.append(f"{rel}:{n}: imports all of node:fs. Import only read-side functions by name. {PLUGIN_FIX}")
                continue
            for item in named["names"].split(","):
                item = item.strip()
                if not item or item.startswith("type "):
                    continue
                name = item.split(" as ")[0].strip()
                if name not in READ_SIDE:
                    found.append(f"{rel}:{n}: imports {name} from node:fs. {PLUGIN_FIX}")
    return found


def remote_problems() -> list[str]:
    found: list[str] = []
    for path in sorted(REMOTE.glob("*.js")):
        if path.name == "remote_common.js":
            continue
        rel = path.relative_to(ROOT).as_posix()
        count = 0
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            hits = len(REMOTE_WRITE.findall(line))
            if hits and not excepted(line, rel, n, found):
                count += hits
        base = BASELINE.get(path.name, 0)
        if count > base:
            found.append(f"{path.name}: raw fs writes grew {base} -> {count}. {REMOTE_FIX}")
        elif count < base:
            print(f"note: {path.name} has {count} raw fs writes, below its baseline {base}; "
                  f"lower BASELINE in scripts/check_io.py to {count}.")
    return found


# fail-open-probe: what reads an error as absence, by language. Each match is one probe.
JS_DEFAULT = r"""(?:false|null|undefined|\[\]|\{\}|""|'')"""
PY_DEFAULT = r"""(?:\{\}|\[\]|None|False|set\(\)|""|'')"""
PY_EXISTS = (r"(?:(?:[\w.]+|\([^()\n]*\))\.(?:is_dir|is_file|exists)\(\)"
             r"|os\.path\.(?:exists|lexists|isdir|isfile)\([^()\n]*\))")
# An except clause that catches more than absence: bare, Exception, or any OSError besides the two absent ones.
PY_BROAD = r"(?:[ \t]*|[^:\n]*\b(?:BaseException|Exception|OSError|IOError|EnvironmentError|PermissionError)\b[^:\n]*)"
PROBES = {
    "js": (
        ("catch-returns-default", re.compile(r"\bcatch\s*(?:\([^)]*\))?\s*\{\s*return(?:\s+" + JS_DEFAULT + r")?\s*;?\s*\}")),
        ("existsSync", re.compile(r"\bexistsSync\s*\(")),
    ),
    "py": (
        ("absent-means-empty", re.compile(
            r"\b(?:el)?if\s+not\s+" + PY_EXISTS + r"\s*:[ \t]*(?:#[^\n]*)?(?:\n[ \t]*)?return(?:[ \t]+" + PY_DEFAULT
            + r")?[ \t]*(?:#[^\n]*)?$"
            r"|\bif\s+" + PY_EXISTS + r"\s+else\s+" + PY_DEFAULT + r"(?![\w.(])", re.M)),
        ("except-returns-default", re.compile(
            r"^[ \t]*except\b" + PY_BROAD + r":[ \t]*(?:#[^\n]*)?(?:\n[ \t]*)?return(?:[ \t]+" + PY_DEFAULT
            + r")?[ \t]*(?:#[^\n]*)?$", re.M)),
    ),
}
PROBE_LANGUAGE = {".ts": "js", ".js": "js", ".mjs": "js", ".cjs": "js", ".py": "py"}
PROBE_RULE = ("An error is not absence: only ENOENT or ENOTDIR (FileNotFoundError, NotADirectoryError) mean "
              "a path is absent, and any other error must propagate.")


def probe_files() -> list[str]:
    """Repo-relative plugin, fleet sync, and OPC source files the rule counts, outside tests and vendored copies."""
    out = []
    for top in (PLUGINS, REMOTE, OPC):
        for directory, subdirs, files in os.walk(top):
            subdirs[:] = sorted(d for d in subdirs if d not in {"node_modules", "test", "tests", "vendor"})
            for name in sorted(files):
                rel = Path(directory, name).relative_to(ROOT).as_posix()
                if Path(name).suffix not in PROBE_LANGUAGE or name.endswith((".test.ts", ".d.ts")):
                    continue
                # Plugin code is its server/ tree and index.server.ts, plus the shared helpers.
                if top == PLUGINS and not re.match(r"plugins/(_shared/[^/]+|[^/]+/(server/.+|index\.server\.ts))$", rel):
                    continue
                out.append(rel)
    return out


def probes(rel: str, text: str) -> dict[str, list[tuple[int, int]]]:
    """Each probe kind in the text, with the first and last line of every match."""
    found: dict[str, list[tuple[int, int]]] = {}
    for kind, pattern in PROBES[PROBE_LANGUAGE[Path(rel).suffix]]:
        for m in pattern.finditer(text):
            first = text.count("\n", 0, m.start()) + 1
            found.setdefault(kind, []).append((first, first + text.count("\n", m.start(), m.end())))
    return found


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, encoding="utf-8")


def merge_base(base: str) -> str:
    """The merge base of base and HEAD; origin/main stands in for an empty, all-zero, or unknown base."""
    for candidate in dict.fromkeys((base, "origin/main")):
        if candidate.strip("0") and git("rev-parse", "--verify", "-q", candidate + "^{commit}").returncode == 0:
            done = git("merge-base", candidate, "HEAD")
            if done.returncode == 0:
                return done.stdout.strip()
    raise SystemExit(f"fail-open-probe: no merge base of {base or '(empty)'} or origin/main with HEAD; "
                     "pass --base <commit>, with full history fetched.")


def added_lines(base: str, rel: str) -> set[int]:
    """The lines of rel that differ from base, by their line number now; empty for a file git does not track."""
    added: set[int] = set()
    diff = git("diff", "-U0", "--no-color", "--no-ext-diff", base, "--", rel).stdout
    for m in re.finditer(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", diff, re.M):
        added.update(range(int(m[1]), int(m[1]) + int(m[2] or 1)))
    return added


def probe_problems(base: str) -> tuple[list[str], str]:
    found: list[str] = []
    base = merge_base(base)
    renamed = git("diff", "-M", "--name-status", "-z", "--diff-filter=R", base).stdout.split("\0")
    old_path = {renamed[i + 2]: renamed[i + 1] for i in range(0, len(renamed) - 2, 3) if renamed[i].startswith("R")}
    for rel in probe_files():
        lines = (ROOT / rel).read_text(encoding="utf-8").splitlines()
        now = probes(rel, "\n".join(lines))
        for kind, spans in sorted(now.items()):
            counted = [span for span in spans
                       if not any(excepted(lines[n - 1], rel, n, found, "probe-ok") for n in range(span[0], span[1] + 1))]
            if not counted:
                continue
            before = git("show", f"{base}:{old_path.get(rel, rel)}")
            had = len(probes(rel, before.stdout).get(kind, [])) if before.returncode == 0 else 0
            if len(counted) > had:
                # Name the probes on changed lines, which hold the new one; all of them when none is on one.
                added = added_lines(base, rel)
                firsts = {first for first, last in counted if added.intersection(range(first, last + 1))}
                lines_at = sorted(firsts or {first for first, _ in counted})
                found.append(f"{rel}:{','.join(map(str, lines_at))}: {kind} grew {had} -> {len(counted)} against "
                             f"{base[:9]}. {PROBE_RULE} {probe_fix(rel)}")
    return found, base


def probe_fix(rel: str) -> str:
    """Where the file's runtime finds the probe helper."""
    scripts = "skills/orchestration/personal-skills/scripts/"
    if rel.startswith("plugins/_shared/"):
        return "Use probe() or isAbsent() from ./fs-probe.ts."
    if rel.startswith("plugins/"):
        return ("Use probe() or isAbsent() from the plugin's server/vendor/fs-probe.ts (copy of plugins/_shared/fs-probe.ts); "
                "list the plugin under fs-probe.ts in CONSUMERS in scripts/check_vendored.py.")
    if rel.startswith(scripts) and "/" not in rel[len(scripts):]:
        if rel.endswith(".py"):
            return "Use probe.probe() or `except probe.ABSENT` from probe.py beside this script."
        return ("Use probe(fs, file) or isAbsent(e) from remote_common.js, which fleet.run_node ships ahead of each "
                "remote program; a standalone payload repeats that check inline.")
    if rel.endswith(".py"):
        return "Catch only FileNotFoundError and NotADirectoryError, as personal-skills/scripts/probe.py does."
    return "Catch the error and rethrow it unless its code is ENOENT or ENOTDIR, as probe() in remote_common.js does."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("rules", nargs="*", metavar="rule", help="raw-write or fail-open-probe; default: both")
    parser.add_argument("--base", default="origin/main",
                        help="fail-open-probe counts against the merge base of this and HEAD (default: origin/main)")
    args = parser.parse_args(argv)
    rules = args.rules or ["raw-write", "fail-open-probe"]
    if unknown := sorted(set(rules) - {"raw-write", "fail-open-probe"}):
        parser.error(f"unknown rule {', '.join(unknown)}")
    found, passed = [], []
    if "raw-write" in rules:
        raw = plugin_problems() + remote_problems()
        found += raw
        if not raw:
            passed.append("raw-write: no plugin imports a write-side fs function and no remote program grew its raw fs writes")
    if "fail-open-probe" in rules:
        probed, base = probe_problems(args.base)
        found += probed
        if not probed:
            passed.append(f"fail-open-probe: no file grew its error-as-absence probes against {base[:9]}")
    for line in found:
        print(line, file=sys.stderr)
    for line in passed:
        print(line)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())

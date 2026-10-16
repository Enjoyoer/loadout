#!/usr/bin/env python3
"""Fail when plugin or remote-program code writes or removes files outside the shared safe-write helpers.

Rule raw-write, applied two ways:

- Plugins (strict). Plugin code outside test/ and vendor/ may import only read-side
  functions from node:fs and node:fs/promises. Plugin state is written through
  writeJsonAtomically in plugins/<id>/server/vendor/atomic-json.ts.
- Remote programs (ratchet). The fleet sync's remote programs in
  skills/orchestration/personal-skills/scripts/ write with replaceFile() and delete with
  removeFile() from remote_common.js. Raw fs write calls in each other program are
  counted, and the check fails when a count grows past BASELINE.

An exception goes on the offending line itself, with a reason and an expiry date:
    // raw-write-ok: <reason>; expires YYYY-MM-DD
An expired exception fails the check.
"""

from __future__ import annotations

import datetime
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
REMOTE = ROOT / "skills" / "orchestration" / "personal-skills" / "scripts"

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
EXCEPTION = re.compile(r"raw-write-ok:\s*(?P<reason>[^;]*\S)\s*;\s*expires\s+(?P<date>\d{4}-\d{2}-\d{2})")
PLUGIN_FIX = ("Plugin state is written only through writeJsonAtomically in ./vendor/atomic-json.ts "
              "(copy of plugins/_shared/atomic-json.ts); add the plugin to CONSUMERS in scripts/check_vendored.py.")
REMOTE_FIX = ("Write with replaceFile() and delete with removeFile() from remote_common.js; they re-check "
              "ancestors and recorded hashes at the point of use.")


def excepted(line: str, rel: str, n: int, found: list[str]) -> bool:
    """True when the line carries a current exception; an expired or malformed one is reported."""
    if "raw-write-ok" not in line:
        return False
    m = EXCEPTION.search(line)
    if not m:
        found.append(f"{rel}:{n}: malformed exception; write `raw-write-ok: <reason>; expires YYYY-MM-DD`.")
        return False
    if datetime.date.fromisoformat(m["date"]) < datetime.date.today():
        found.append(f"{rel}:{n}: exception expired on {m['date']} ({m['reason']}). Remove the raw write or renew with a new reason.")
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


def main() -> int:
    found = plugin_problems() + remote_problems()
    for line in found:
        print(line, file=sys.stderr)
    if found:
        return 1
    print("raw-write: no plugin imports a write-side fs function and no remote program grew its raw fs writes")
    return 0


if __name__ == "__main__":
    sys.exit(main())

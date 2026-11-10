"""Backup retention for a writer that leaves a timestamped backup beside a file it replaced (remote_common.js has the
same rule for the node writers)."""
import re, stat
from datetime import datetime
from pathlib import Path

KEEP = 5


def prune_backups(file, written, pattern, stamp_format, keep=KEEP):
    """Keep the newest `keep` backups of file that this writer made, counting written, and delete the rest.

    pattern is a regex for the rest of a sibling's name after file's name, matched whole and ASCII-only (\\d is 0-9); its group `stamp` must
    parse with stamp_format, and the stamp in the name (not mtime) orders them. written is never deleted. A sibling
    counts only when lstat finds a regular file, so a symlink is never followed or removed, and a hand-made backup
    under another name (.before-*, .bak-pr*, ...) never matches. Never raises: returns the errors, so a failed prune
    never fails or undoes the write.
    """
    file, errors, found = Path(file), [], []
    try:
        for entry in file.parent.iterdir():
            name = entry.name
            if name == Path(written).name or not name.startswith(file.name): continue
            m = re.fullmatch(pattern, name[len(file.name):], re.ASCII)
            if not m: continue
            try: stamp = datetime.strptime(m["stamp"], stamp_format)
            except ValueError: continue
            try:
                if stat.S_ISREG(entry.lstat().st_mode): found.append((stamp, name, entry))
            except FileNotFoundError: pass
            except OSError as e: errors.append(f"{name}: {e}")
        found.sort(reverse=True)
        for _, name, entry in found[max(keep - 1, 0):]:
            try: entry.unlink()
            except FileNotFoundError: pass
            except OSError as e: errors.append(f"{name}: {e}")
    except Exception as e: errors.append(f"{file.name}: {e}")
    return ["backup prune failed, kept: " + e for e in errors]

"""Probe a path without reading an error as absence.

Only FileNotFoundError and NotADirectoryError mean nothing is there. Any other OSError (a permission
error, an I/O error, a symlink loop) leaves the state unknown and propagates, so no caller reads it as
absent, empty, or a default. os.path.exists() and its kin, and since Python 3.14 pathlib's exists(),
is_dir() and is_file(), return False for those errors too.
"""

from __future__ import annotations

import os
from typing import Optional, Union

# The errors that mean nothing is at a path; catch only these to read a path as absent.
ABSENT = (FileNotFoundError, NotADirectoryError)


def probe(path: Union[str, os.PathLike], *, follow: bool = False) -> Optional[os.stat_result]:
    """What is at path: its lstat (its stat with follow), or None when it is absent. Any other OSError propagates."""
    try:
        return os.stat(path) if follow else os.lstat(path)
    except ABSENT:
        return None

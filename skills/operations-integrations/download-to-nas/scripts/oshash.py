#!/usr/bin/env python3
"""Print OpenSubtitles movie hash and file size: <hash16hex>|<size>."""
import os
import struct
import sys

CHUNK = 65536

def oshash(path: str) -> tuple[str, int]:
    size = os.path.getsize(path)
    h = size
    fmt = '<Q'
    with open(path, 'rb') as f:
        for _ in range(CHUNK // 8):
            h = (h + struct.unpack(fmt, f.read(8))[0]) & 0xFFFFFFFFFFFFFFFF
        f.seek(max(0, size - CHUNK), 0)
        for _ in range(CHUNK // 8):
            h = (h + struct.unpack(fmt, f.read(8))[0]) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}", size

if __name__ == "__main__":
    h, s = oshash(sys.argv[1])
    print(f"{h}|{s}")

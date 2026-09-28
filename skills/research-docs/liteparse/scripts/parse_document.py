#!/usr/bin/env python
"""Small wrapper around LiteParse's `lit parse` command."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


EXTENSIONS = {"markdown": ".liteparse.md", "text": ".liteparse.txt", "json": ".liteparse.json"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse a document with LiteParse.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--format", choices=sorted(EXTENSIONS), default="markdown")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--target-pages")
    parser.add_argument("--max-pages", type=int)
    parser.add_argument("--no-ocr", action="store_true")
    args = parser.parse_args()

    input_path = args.input.resolve()
    output_path = args.output or input_path.with_suffix(EXTENSIONS[args.format])

    cmd = ["lit", "parse", str(input_path), "--format", args.format, "-o", str(output_path), "--quiet"]
    if args.target_pages:
        cmd.extend(["--target-pages", args.target_pages])
    if args.max_pages:
        cmd.extend(["--max-pages", str(args.max_pages)])
    if args.no_ocr:
        cmd.append("--no-ocr")

    subprocess.run(cmd, check=True)
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

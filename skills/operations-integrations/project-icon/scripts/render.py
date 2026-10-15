#!/usr/bin/env python3
"""Render with librsvg's rsvg-convert; generate an actual-size light/dark preview."""
import argparse
import base64
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("svg", type=Path)
parser.add_argument("png", type=Path)
args = parser.parse_args()
renderer = shutil.which("rsvg-convert")
if not renderer:
    parser.error("Install librsvg (rsvg-convert) first; no fallback renderer is used")
args.png.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([renderer, "-w", "512", "-h", "512", "-f", "png", "-o", str(args.png), str(args.svg)], check=True)
# Render each thumbnail directly with librsvg, rather than relying on browser scaling.
images = {}
for size in (512, 40, 20):
    data = subprocess.check_output([renderer, "-w", str(size), "-h", str(size), "-f", "png", str(args.svg)])
    images[size] = base64.b64encode(data).decode("ascii")
rows = []
for size, data in images.items():
    chips = "".join(
        f'<span style="display:inline-block;padding:16px;background:{bg}"><img width="{size}" height="{size}" src="data:image/png;base64,{data}" alt="{size}px icon"></span>'
        for bg in ("#ffffff", "#1c1c1e")
    )
    rows.append(f"<section><h2>{size} px</h2>{chips}</section>")
preview = args.png.with_suffix(".preview.html")
preview.write_text('<!doctype html><html lang="en"><meta charset="utf-8"><title>Icon legibility</title><body style="background:#ddd;font-family:system-ui"><h1>Light and dark, actual size</h1>' + "".join(rows) + "</body></html>", encoding="utf-8")
print(f"Rendered {args.png}; inspect {preview} at 100% zoom before applying")

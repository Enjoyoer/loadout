---
name: liteparse
description: Use when extracting or inspecting PDFs with LiteParse, especially scanned or image-heavy files, OCR candidates, page screenshots, markdown/text/JSON output, bounding boxes, or page coordinates. Use the bundled type-specific artifact skills for Office files and native PDF authoring/editing.
---

# LiteParse

## Rule

Use `lit` first for PDF extraction, OCR, screenshots, and coordinates. Route DOCX to `documents:documents`, XLSX/CSV to `spreadsheets:Spreadsheets`, PPTX to `presentations:Presentations`, and PDF authoring/editing or fillable forms to `pdf:pdf`. Use Browser or a structured HTML parser for web and HTML content.

## Commands

Write output to a temp file, then read the file.

```powershell
lit parse "input.pdf" --format markdown -o "input.extracted.md" --quiet
lit parse "input.pdf" --format json -o "input.extracted.json" --quiet
lit screenshot "input.pdf" -o "screenshots" --target-pages 1 --quiet
```

Useful options:

| Option | Use |
|---|---|
| `--target-pages 1,3-5` | Parse selected pages only. |
| `--max-pages 20` | Bound large files. |
| `--no-ocr` | Skip OCR for born-digital PDFs. |
| `--ocr-language eng` | OCR language. |
| `--image-mode placeholder` | Keep markdown light. |
| `--image-mode embed --image-output-dir images` | Extract images next to markdown. |

## Helper Script

For repeatable extraction, run:

```powershell
python "$env:USERPROFILE\.codex\skills\liteparse\scripts\parse_document.py" "input.pdf" --format markdown
```

The script writes an adjacent `.liteparse.md`, `.liteparse.txt`, or `.liteparse.json` file unless `--output` is provided.

## Fallbacks

- If `lit` is missing, install with `uv tool install liteparse`.
- Do not use LiteParse as a generic Office converter; invoke the matching bundled artifact skill.
- If visual layout matters, generate screenshots and inspect rendered pages before trusting text order.

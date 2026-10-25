---
name: liteparse
description: Use when a PDF is scanned or image-only and needs OCR, or when you need page screenshots, bounding boxes, or page coordinates. Ordinary text PDFs use `pdftotext -layout` instead, not LiteParse. Use the bundled type-specific artifact skills for Office files and native PDF authoring/editing.
---

# LiteParse

## Rule

Use `pdftotext -layout` first for text PDFs. Use `lit` only when a PDF is scanned or image-only and needs OCR, and then use `lit parse --format text`, not markdown: markdown splits labels from values and table rows.

`lit screenshot` and `lit parse --format json` (bounding boxes, page coordinates) stay fine for any PDF when you need rendered pages or positions.

Route DOCX to `documents:documents`, XLSX/CSV to `spreadsheets:Spreadsheets`, PPTX to `presentations:Presentations`, and PDF authoring/editing or fillable forms to `pdf:pdf`. Use Browser or a structured HTML parser for web and HTML content.

## Commands

Write output to a temp file, then read the file.

Text PDF (`pdftotext` comes from poppler):

```powershell
pdftotext -layout "input.pdf" "input.extracted.txt"
```

Scanned or image-only PDF, screenshots, and coordinates:

```powershell
lit parse "input.pdf" --format text -o "input.extracted.txt" --quiet
lit parse "input.pdf" --format json -o "input.extracted.json" --quiet
lit screenshot "input.pdf" -o "screenshots" --target-pages 1 --quiet
```

A text PDF is one where `pdftotext` returns the page's words; if it returns nothing or near nothing, treat the PDF as scanned.

Useful options:

| Option | Use |
|---|---|
| `--target-pages 1,3-5` | Parse selected pages only. |
| `--max-pages 20` | Bound large files. |
| `--ocr-language eng` | OCR language. |
| `--no-ocr` | Skip OCR when you only need JSON coordinates from a text PDF. |

## Helper Script

For repeatable extraction, run:

```powershell
python "$env:USERPROFILE\.codex\skills\liteparse\scripts\parse_document.py" "input.pdf"
```

The script defaults to `--format text` and writes an adjacent `.liteparse.txt` file unless `--output` is provided. `--format json` and `--format markdown` stay selectable.

## Fallbacks

- If `lit` is missing, install with `uv tool install liteparse`.
- Do not use LiteParse as a generic Office converter; invoke the matching bundled artifact skill.
- If visual layout matters, generate screenshots and inspect rendered pages before trusting text order.

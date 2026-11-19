#!/usr/bin/env python3
"""Run small syntax, link, and scenario-schema checks for OPN."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: Path, errors: list[str]) -> str:
    if not path.is_file():
        errors.append(f"missing {path.relative_to(ROOT)}")
        return ""
    return path.read_text(encoding="utf-8")


def validate_links(documents: dict[str, str], errors: list[str]) -> None:
    for name, text in documents.items():
        for target in re.findall(r"\]\(([^)#]+)(?:#[^)]+)?\)", text):
            if target.startswith(("http:", "https:", "plugin:", "thread:")):
                continue
            resolved = (ROOT / name).parent / target
            if not resolved.is_file():
                errors.append(f"{name}: broken relative link {target}")


MODEL_MAP_LINK = "](../opc/references/routing.md"
# The canonical catalog labels (personal-skills scripts/pi/catalog.py CANONICAL) and Pi's thinking levels, as whole
# words, plus a model id prefix.
MODEL_LABELS = ("Opus", "Sonnet", "Fable", "Haiku", "Astra", "Sol", "Terra", "Luna", "Web Extra", "Web Pro")
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
MODEL_TERMS = re.compile(r"\b(?:" + "|".join(re.escape(term).replace(r"\ ", r"\s+") for term in MODEL_LABELS + THINKING_LEVELS) +
                         r")\b|\b(?:gpt|claude|chatgpt)-", re.IGNORECASE)


def validate_model_free(text: str, errors: list[str]) -> None:
    """Models live in OPC's shared map: SKILL.md names none outside the line that links to it."""
    link_lines = [line for line in text.splitlines() if MODEL_MAP_LINK in line]
    if len(link_lines) != 1:
        errors.append(f"SKILL.md: needs exactly one line linking the OPC model map (found {len(link_lines)})")
    for number, line in enumerate(text.splitlines(), 1):
        if MODEL_MAP_LINK not in line and (match := MODEL_TERMS.search(line)):
            errors.append(f"SKILL.md:{number}: names a model or thinking level ({match.group(0)}); link the OPC model map instead")


def validate_evals(raw: str, errors: list[str]) -> int:
    if not raw:
        return 0
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        errors.append(f"evals.json: {exc}")
        return 0
    if document.get("skill") != "opn":
        errors.append("evals.json: skill must be opn")
    if document.get("skill_path") != "skills/orchestration/opn/SKILL.md":
        errors.append("evals.json: skill_path must point to the repository skill")
    cases = document.get("cases")
    if not isinstance(cases, list):
        errors.append("evals.json: cases must be a list")
        return 0
    ids: list[str] = []
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            errors.append(f"evals.json: case {index} is not an object")
            continue
        case_id = case.get("id")
        if not isinstance(case_id, str) or not re.fullmatch(r"[a-z0-9-]+", case_id):
            errors.append(f"evals.json: case {index} has invalid id")
            continue
        ids.append(case_id)
        if not isinstance(case.get("prompt"), str) or not case["prompt"].strip():
            errors.append(f"evals.json:{case_id}: missing prompt")
        if not isinstance(case.get("scenario"), dict) or not case["scenario"]:
            errors.append(f"evals.json:{case_id}: missing scenario fixture")
        if not isinstance(case.get("expected"), dict) or not case["expected"]:
            errors.append(f"evals.json:{case_id}: missing expected behavior")
        rubric = case.get("rubric")
        if not isinstance(rubric, list) or not rubric:
            errors.append(f"evals.json:{case_id}: missing behavioral rubric")
        else:
            for item in rubric:
                if not isinstance(item, dict) or not item.get("criterion") or not item.get("observable"):
                    errors.append(f"evals.json:{case_id}: rubric items need criterion and observable")
        if "assert" in case or "must_contain" in case:
            errors.append(f"evals.json:{case_id}: phrase-presence assertion remains")
    duplicates = [item for item, count in Counter(ids).items() if count > 1]
    if duplicates:
        errors.append(f"evals.json: duplicate ids {sorted(duplicates)}")
    return len(cases)


def validate_documents(documents: dict[str, str], evals_raw: str, errors: list[str]) -> int:
    validate_links(documents, errors)
    validate_model_free(documents.get("SKILL.md", ""), errors)
    return validate_evals(evals_raw, errors)


def main() -> int:
    errors: list[str] = []
    documents = {
        "SKILL.md": read(ROOT / "SKILL.md", errors),
        "references/host-adapters.md": read(ROOT / "references" / "host-adapters.md", errors),
    }
    evals = read(ROOT / "evals.json", errors)
    read(ROOT / "agents" / "openai.yaml", errors)  # presence check only
    eval_count = validate_documents(documents, evals, errors)
    if errors:
        print(f"OPN validation failed with {len(errors)} error(s):", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"OPN structural validation passed ({eval_count} scenario fixtures; behavioral execution not included).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

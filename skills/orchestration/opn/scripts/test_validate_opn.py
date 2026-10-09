from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VALIDATOR = load("validate_opn", Path(__file__).with_name("validate-opn.py"))


class OpnStructureTests(unittest.TestCase):
    def test_repository_policy_and_fixtures_pass_structural_checks(self) -> None:
        errors: list[str] = []
        documents = {
            "SKILL.md": (ROOT / "SKILL.md").read_text(encoding="utf-8"),
            "references/host-adapters.md": (ROOT / "references" / "host-adapters.md").read_text(encoding="utf-8"),
        }
        evals = (ROOT / "evals.json").read_text(encoding="utf-8")
        count = VALIDATOR.validate_documents(documents, evals, errors)
        self.assertEqual(errors, [])
        self.assertGreater(count, 0)

    def test_phrase_presence_assertions_are_rejected(self) -> None:
        errors: list[str] = []
        raw = '{"skill":"opn","skill_path":"skills/orchestration/opn/SKILL.md","cases":[{"id":"bad","prompt":"x","scenario":{"x":1},"expected":{"x":1},"rubric":[{"criterion":"x","observable":"y"}],"assert":{"must_contain":["x"]}}]}'
        count = VALIDATOR.validate_evals(raw, errors)
        self.assertEqual(count, 1)
        self.assertTrue(any("phrase-presence" in error for error in errors))


if __name__ == "__main__":
    unittest.main()

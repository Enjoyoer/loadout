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

    def test_model_names_and_thinking_levels_outside_the_map_link_are_rejected(self) -> None:
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        injected = ["Use Sol low.", "Use Terra high.", "Use Astra high.", "Use Haiku.", "Use thinking medium.",
                    "Use thinking low.", "Set thinkingOptionId: low on OPN workers.",
                    "Default to reasoning_effort: medium for review workers.", "Use `effort`: `low` for watchers.",
                    '{"effort": "low"}', '"defaultThinkingLevel": "high"', "`thinkingLevel`: `xhigh`",
                    "thinking_level=high", "Set the thinking level to high for audits",
                    "set reasoning to high for reviews", "Set effort to xhigh", "Keep effort set to high for reviews",
                    "Use xhigh effort for reviews", "| effort | xhigh |", "effort: **high**", "| thinking | high |"]
        for line in injected:
            with self.subTest(line=line):
                errors: list[str] = []
                VALIDATOR.validate_model_free(text + "\n" + line + "\n", errors)
                self.assertEqual(len(errors), 1, errors)
                self.assertIn("names a model or thinking level", errors[0])
        prose = ["Follow up on high priority issues.", "Turn the monitor off before leaving.",
                 "Keep the noise low during the call.", "Use minimal effort to remove stale labels.",
                 "Put high effort into the first draft.", "Capture their thinking on high-priority issues.",
                 "Direct effort to high priority issues.", "Limit effort to max 3 retries.", "Write a haiku."]
        for line in prose:
            with self.subTest(line=line):
                errors = []
                VALIDATOR.validate_model_free(text + "\n" + line + "\n", errors)
                self.assertEqual(errors, [])
        # The map-link line may name them.
        errors = []
        VALIDATOR.validate_model_free(text.replace("[model map](", "[model map, Sol low and Terra high](", 1), errors)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()

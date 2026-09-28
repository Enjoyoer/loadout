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
ADAPTERS = load("opn_host_adapters", Path(__file__).with_name("host_adapters.py"))


class OpnStructureTests(unittest.TestCase):
    def test_repository_policy_and_fixtures_pass_structural_checks(self) -> None:
        errors: list[str] = []
        documents = {
            "SKILL.md": (ROOT / "SKILL.md").read_text(encoding="utf-8"),
            "references/host-adapters.md": (ROOT / "references" / "host-adapters.md").read_text(encoding="utf-8"),
            "host_adapters.py": (ROOT / "scripts" / "host_adapters.py").read_text(encoding="utf-8"),
        }
        evals = (ROOT / "evals.json").read_text(encoding="utf-8")
        metadata = (ROOT / "agents" / "openai.yaml").read_text(encoding="utf-8")
        count = VALIDATOR.validate_documents(documents, evals, metadata, errors)
        self.assertEqual(errors, [])
        self.assertGreater(count, 0)

    def test_phrase_presence_assertions_are_rejected(self) -> None:
        errors: list[str] = []
        raw = '{"skill":"opn","skill_path":"skills/orchestration/opn/SKILL.md","cases":[{"id":"bad","prompt":"x","scenario":{"x":1},"expected":{"x":1},"rubric":[{"criterion":"x","observable":"y"}],"assert":{"must_contain":["x"]}}]}'
        count = VALIDATOR.validate_evals(raw, errors)
        self.assertEqual(count, 1)
        self.assertTrue(any("phrase-presence" in error for error in errors))


class OpnAdapterTests(unittest.TestCase):
    @staticmethod
    def operations(names: tuple[str, ...]):
        return {name: (lambda *args, _name=name, **kwargs: (_name, args, kwargs)) for name in names}

    def test_selected_adapter_dispatches_only_declared_operations(self) -> None:
        native = ADAPTERS.NativeSubagentAdapter(self.operations(ADAPTERS.NATIVE_SUBAGENT_OPERATIONS))
        self.assertEqual(native.call("spawn_agent", "brief")[0], "spawn_agent")
        with self.assertRaises(ValueError):
            native.call("codex_app__create_thread")

    def test_authority_gate_prevents_self_granted_delegation(self) -> None:
        capabilities = self.operations(ADAPTERS.CODEX_NAMED_TASK_OPERATIONS)
        self.assertIsNone(ADAPTERS.select_host_adapter(capabilities))
        selected = ADAPTERS.select_host_adapter(capabilities, delegation_authorized=True)
        self.assertIsInstance(selected, ADAPTERS.CodexNamedTaskAdapter)

    def test_native_fallback_and_direct_work_when_unavailable(self) -> None:
        native = self.operations(ADAPTERS.NATIVE_SUBAGENT_OPERATIONS)
        selected = ADAPTERS.select_host_adapter(native, delegation_authorized=True)
        self.assertIsInstance(selected, ADAPTERS.NativeSubagentAdapter)
        self.assertIsNone(ADAPTERS.select_host_adapter({}, delegation_authorized=True))

    def test_owner_identity_never_invents_codex_fields(self) -> None:
        native = ADAPTERS.NativeSubagentAdapter(self.operations(ADAPTERS.NATIVE_SUBAGENT_OPERATIONS))
        identity = native.owner_identity(
            owner_handle="native-worker-1",
            folder="/workstreams/atlas",
            memory_root="/workstreams/atlas",
            resumability=True,
        )
        self.assertEqual(identity["host_adapter"], "native_subagent")
        self.assertNotIn("project_id", identity)
        self.assertNotIn("thread_id", identity)

    def test_owner_identity_requires_owned_folder_fields(self) -> None:
        native = ADAPTERS.NativeSubagentAdapter(self.operations(ADAPTERS.NATIVE_SUBAGENT_OPERATIONS))
        with self.assertRaises(ValueError):
            native.owner_identity(
                owner_handle="native-worker-1",
                folder="",
                memory_root="/workstreams/atlas",
                resumability=True,
            )

    def test_codex_identity_requires_real_complete_tuple(self) -> None:
        codex = ADAPTERS.CodexNamedTaskAdapter(self.operations(ADAPTERS.CODEX_NAMED_TASK_OPERATIONS))
        with self.assertRaises(ValueError):
            codex.owner_identity(
                owner_handle="codex-worker-1",
                folder="/workstreams/atlas",
                memory_root="/workstreams/atlas",
                resumability=True,
                project_id="project-1",
            )
        identity = codex.owner_identity(
            owner_handle="codex-worker-1",
            folder="/workstreams/atlas",
            memory_root="/workstreams/atlas",
            resumability=True,
            project_id="project-1",
            task_id="task-1",
            thread_id="thread-1",
        )
        self.assertEqual(identity["thread_id"], "thread-1")


if __name__ == "__main__":
    unittest.main()

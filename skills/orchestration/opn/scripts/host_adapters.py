"""Small, host-neutral adapter selection for authorized OPN delegation."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


CODEX_NAMED_TASK_OPERATIONS = (
    "codex_app__list_projects",
    "codex_app__list_threads",
    "codex_app__create_thread",
    "codex_app__send_message_to_thread",
)
NATIVE_SUBAGENT_OPERATIONS = ("spawn_agent", "followup_task", "wait_agent")


class HostAdapterUnavailable(RuntimeError):
    """A requested operation is not callable on the selected host."""

    def __init__(self, missing_capabilities: tuple[str, ...]) -> None:
        self.missing_capabilities = missing_capabilities
        missing = ", ".join(missing_capabilities)
        super().__init__(f"OPN host operation unavailable: {missing}")


def _lookup(capabilities: object, name: str) -> object:
    if isinstance(capabilities, Mapping):
        return capabilities.get(name)
    return getattr(capabilities, name, None)


def _missing(capabilities: object, required: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(name for name in required if not callable(_lookup(capabilities, name)))


class _BaseHostAdapter:
    adapter_name = ""
    required_operations: tuple[str, ...] = ()

    def __init__(self, capabilities: object) -> None:
        self.capabilities = capabilities

    @classmethod
    def missing_capabilities(cls, capabilities: object) -> tuple[str, ...]:
        return _missing(capabilities, cls.required_operations)

    @classmethod
    def is_callable(cls, capabilities: object) -> bool:
        return not cls.missing_capabilities(capabilities)

    def call(self, operation: str, *args: Any, **kwargs: Any) -> Any:
        if operation not in self.required_operations:
            raise ValueError(f"{self.adapter_name} does not expose {operation}")
        function = _lookup(self.capabilities, operation)
        if not callable(function):
            raise HostAdapterUnavailable((operation,))
        return function(*args, **kwargs)

    def owner_identity(
        self,
        *,
        owner_handle: str,
        folder: str,
        memory_root: str,
        resumability: bool,
    ) -> dict[str, object]:
        values = {
            "host_adapter": self.adapter_name,
            "host_local_owner_handle": owner_handle,
            "folder": folder,
            "memory_root": memory_root,
            "resumability": resumability,
        }
        for field, value in (
            ("host_local_owner_handle", owner_handle),
            ("folder", folder),
            ("memory_root", memory_root),
        ):
            if not isinstance(value, str) or not value:
                raise ValueError(f"{field} must be non-empty text")
        if not isinstance(resumability, bool):
            raise ValueError("resumability must be boolean")
        return values


class CodexNamedTaskAdapter(_BaseHostAdapter):
    """Adapter for the durable named-task/project/thread host surface."""

    adapter_name = "codex_named_task"
    required_operations = CODEX_NAMED_TASK_OPERATIONS

    def owner_identity(
        self,
        *,
        owner_handle: str,
        folder: str,
        memory_root: str,
        resumability: bool,
        project_id: str | None = None,
        task_id: str | None = None,
        thread_id: str | None = None,
    ) -> dict[str, object]:
        values = super().owner_identity(
            owner_handle=owner_handle,
            folder=folder,
            memory_root=memory_root,
            resumability=resumability,
        )
        supplied = {"project_id": project_id, "task_id": task_id, "thread_id": thread_id}
        if any(value is not None for value in supplied.values()):
            if not all(isinstance(value, str) and value for value in supplied.values()):
                raise ValueError("Codex project_id, task_id, and thread_id must be supplied together")
            values.update(supplied)
        return values


class NativeSubagentAdapter(_BaseHostAdapter):
    """Fallback adapter for hosts with native spawn/follow-up/wait primitives."""

    adapter_name = "native_subagent"
    required_operations = NATIVE_SUBAGENT_OPERATIONS


def select_host_adapter(
    capabilities: object,
    *,
    delegation_authorized: bool = False,
) -> _BaseHostAdapter | None:
    """Select an adapter only when the caller has authority to delegate.

    Returning ``None`` is intentional: the caller may use direct work only
    inside its authorized scope when it owns that scope and no existing owner
    applies. It must not synthesize a capability blocker or task identity.
    """

    if not delegation_authorized:
        return None
    if CodexNamedTaskAdapter.is_callable(capabilities):
        return CodexNamedTaskAdapter(capabilities)
    if NativeSubagentAdapter.is_callable(capabilities):
        return NativeSubagentAdapter(capabilities)
    return None

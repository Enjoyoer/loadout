# OPN Host Adapters

This reference defines the callable host surface used only after the current user and host authorize delegation. Read the main policy for the shared brief, ownership, evidence, cleanup, and memory invariants.

## Capability contract

`capabilities` is a host-provided registry. An operation is available only when its value is callable. Selection is deterministic:

1. `CodexNamedTaskAdapter` wins when `codex_app__list_projects`, `codex_app__list_threads`, `codex_app__create_thread`, and `codex_app__send_message_to_thread` are callable.
2. Otherwise `NativeSubagentAdapter` is available when `spawn_agent`, `followup_task`, and `wait_agent` are callable.
3. If neither set is callable, selection returns no adapter. The caller may continue directly only when it is authorized for the scope, owns it, and no existing folder owner applies. A denied operation, inaccessible resource, or mismatched owner identity remains a blocker for the dependent action and never becomes direct-work authority.

Selection runs only after the caller explicitly asserts that delegation is authorized; without that assertion it returns no adapter. It does not infer or grant that authority.

A selected adapter calls only its own operations listed above and refuses any other. An operation that is not callable is unavailable and is reported by name.

## Adapter behavior

The Codex adapter reuses or unarchives the exact owner, creates only when no valid owner exists, seeds the brief described by the main policy, requires acknowledgment, and surfaces the user-facing task. The native adapter creates or resumes one folder-owning Worker, waits for its bounded result, and returns it to OPN. Both apply the owner's recorded Worker model choice from the main policy's two options, ask when none is recorded, and report rather than substitute when the host cannot expose the recorded model, effort, or Fast setting. Neither adapter takes over an existing folder after an identity mismatch; reconcile it or block the dependent action.

Both adapters create the Worker in place, under the delegating PM's existing container and working directory, and never create a new container for it:

- `CodexNamedTaskAdapter` creates a thread inside a project. Reuse the PM's existing project and create only the thread within it. Never create a new project.
- `NativeSubagentAdapter` creates or resumes the Worker under the caller, inheriting the caller's workspace and working directory. When the caller is itself an agent, omitting the workspace from the creation primitive is the correct default: an agent-scoped call places the Worker in the caller's workspace and records a real parent link. The genuine mistake is creating a workspace first and then creating the Worker inside it. Only where a host's primitive would otherwise place the Worker elsewhere, pass the caller's existing workspace explicitly, never a new one.
- Resuming an existing owner follows the same rule and creates no new container or directory. If a host can only delegate by creating a new container, do not create one; fall back to capability contract item 3. This concerns the harness's container and directory layout, not scope: the owner still owns its durable folder.

## Owner identity

`owner_identity` records only `host_adapter`, `host_local_owner_handle`, `folder`, `memory_root`, and `resumability`. `host_adapter` is `codex_named_task` or `native_subagent`. `host_local_owner_handle`, `folder`, and `memory_root` must be non-empty text, and `resumability` must be a boolean. The Codex adapter may add real `project_id`, `task_id`, and `thread_id` values, only all three together and each non-empty. The native adapter never adds Codex fields. A missing or mismatched identity stops the delegated action and returns a concrete dependent blocker. It is not permission to synthesize data, take over the folder, or perform the restricted action directly.

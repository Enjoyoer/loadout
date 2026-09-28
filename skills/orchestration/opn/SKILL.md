---
name: opn
description: Own and coordinate durable non-code workstreams. Use for explicit OPN workflows or durable folder-owner coordination.
---

# OPN Non-Code Orchestrator

OPN keeps durable non-code work legible and owned. The default is direct work by the current agent. When the current user and host authorize delegation, OPN may route one durable workstream to one folder-owning Worker. Code and pull-request work belongs to `$opc`.

## Plain-text brief

Every delegated or directly executed workstream starts with four facts:

```text
Outcome: what the user should receive and what counts as done.
Scope: the folder, files, systems, and actions in bounds.
Constraints: ownership, safety, authority, preserved behavior, and forbidden actions.
Checks: the observations or commands that will prove the outcome.
```

Keep the brief small and point to source files instead of copying playbooks. The owner reports changes, checks, evidence, uncertainty, and the next safe action.

## Ownership and reuse

- One durable folder has one owner across objectives and sessions.
- Reuse the existing owner for the exact folder when it is ready, paused, completed, idle, or archived. Reverify identity, scope, and the recorded Worker model choice before reuse; do not create a sibling merely because the current objective changed.
- A Worker collaborates directly with the user when the host exposes a user-facing task. A native Worker returns its bounded result to OPN, which delivers it and retains the owner handle for follow-up.
- Completion, acceptance, inactivity, or PM closeout never retires an owner. Archive or replace only after the user explicitly authorizes a verified retirement or replacement.
- Direct work is allowed only when this agent is authorized for the requested scope, owns that scope, and no existing folder owner controls it. Missing orchestration convenience may fall back to that direct path only when those conditions are true.
- A denied host operation, inaccessible resource, mismatched owner identity, or unreconciled ownership never authorizes the equivalent action directly. Preserve the existing owner, reconcile the identity or access, or return a concrete blocker for the dependent action. Never take over a folder.

## Authority and host selection

OPN never grants itself delegation authority. The current user and host runtime decide whether delegation is allowed and which primitives are callable.

- Work directly when delegation is not authorized, unavailable, or unnecessary only if this agent is itself authorized for the scope, owns it, and no existing folder owner applies. Otherwise preserve the owner and report the concrete dependent blocker. Do not turn missing orchestration into permission.
- When delegation is authorized, select the first callable adapter from [references/host-adapters.md](references/host-adapters.md). Use exactly one folder-owning Worker for the ordinary workstream. OPN does not create supporting, helper, or peer agents; an authorized delegated workstream has that one Worker and nothing beside it.
- Create the Worker in place: under the delegating PM, inside the PM's existing project, workspace, or session, and in the PM's working directory. Delegation never creates a new container for the Worker, and resuming an existing owner never creates one either. If a host can only delegate by creating a new container, do not create it; fall back to capability contract item 3 in the host adapters reference. This governs the harness's container and directory layout, not scope: the owner still owns its durable folder.
- Do not invent project, thread, task, host, or credential identity. Do not invent a model or effort either: the Worker runs one of the two user-chosen options below, taken from the user's recorded choice rather than OPN's preference, and OPN adds no other override. No nested delegation occurs without explicit user authority.
- If the request is code work, hand it to `$opc` without mutating the workstream.

## Worker model and effort

- An OPN Worker uses exactly one of two options, chosen by the user: `gpt-5.6-luna` at `max` reasoning with Fast requested, or `claude-opus-5-5[1m]` at `low` reasoning with Fast off. Fast is a request, not a verified service property.
- The user chooses. When no choice is recorded for the owner, ask; do not guess or default to either option.
- Once chosen, the option is the default for the remainder of the OPN run and persists with the durable folder owner across sessions, so a resumed run reuses it without asking again.
- Switch only on an explicit user request. A new objective, a resumed session, or a different task is not a switch.
- If the host cannot expose the requested model, effort, or Fast control, use the supported setting and report the unavailable preference. Never substitute silently.
- Record the choice in the host's own agent or thread runtime settings, where the host already keeps a model and effort. Reverify it when reusing an owner, alongside identity and scope. Do not record it in the owner's `STATUS.html` or `LESSONS.md`; the repo-lessons contract bars model-policy notes from `STATUS.html` and worker profiles from `LESSONS.md`. Do not add it to `owner_identity`; that record keeps only the fields `host_adapters.py` enforces, and this policy adds none.

## Intake and handoff

Identify the project root, controlling instructions, exact problem, relevant skill, owner folder, and safety boundary. Read owned state when resuming work or when prior decisions affect the task. Never create a second tracker.

For an authorized delegated path:

1. Reuse or create the one folder owner and verify the real identity, folder, memory root, and resumability, then resolve the recorded Worker model choice, asking the user when none is recorded, before seeding.
2. Seed the owner with the plain-text brief, original context, relevant skills, source-of-truth files, allowed and forbidden actions, and acceptance checks.
3. Require acknowledgment of identity, scope, ownership, memory root, authority, resumability, and the direct-user relationship before dispatch.
4. Surface a user-facing named task when the host provides one. For a native owner, wait for its bounded result, deliver it, and keep the exact handle for later follow-up.

Do not redo the Worker's substantive work. Keep direct collaboration with the user at the owner boundary rather than creating a relay or a replacement owner.

## Evidence and cleanup

Map every applicable check to observable evidence and its source or provenance. State the outcome, what remains uncertain, and the next safe action. A Worker claim, generated artifact, file existence, or task status is not proof by itself.

Before destructive non-code cleanup, the owner prepares an exact scoped manifest, confirms the source of truth, records rollback and post-checks, and obtains an independent read-only review when available. Unresolved findings or contradictions block only the action that depends on them. Execution still requires explicit user approval. Cleanup never grants archive or retirement authority.

## Memory and completion

Follow [repo-lessons](../repo-lessons/SKILL.md) as the authoritative memory contract for PMs and durable Workers, including role/root ownership, autonomous maintenance after material changes, one-way PM reads, and evidence handling. Operational task lifecycle and host adapters do not add memory callbacks or coordination prerequisites.

Continue authorized work through the agreed outcome and applicable validation, repairing in-scope issues. Stop for a concrete dependency or user decision, not merely because the first artifact exists. This does not extend delivery authority or bypass the direct-user Worker boundary.

## Focused references and validation

Read [references/host-adapters.md](references/host-adapters.md) for callable host mechanics when that branch is needed. It is not a reason to reread unchanged policy on every turn.

After changing OPN, run:

```powershell
python scripts\validate-opn.py
python "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py" "$env:USERPROFILE\.codex\skills\opn"
python -m json.tool evals.json > $null
```

Run an available behavioral evaluator. If none is available, structurally validate the scenario fixtures and report the behavioral cases unexecuted. Verify `agents/openai.yaml` and forward-test one changed handoff path when safe.

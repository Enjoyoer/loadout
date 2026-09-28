---
name: repo-lessons
description: Maintain an assigned project's or durable workstream's STATUS.html and LESSONS.md, including the comprehensive update that $handoff commits before an owner migrates or is replaced.
---

# Project Memory

Each owner maintains exactly two memory files in its assigned root:

- `STATUS.html` is the concise current-state board.
- `LESSONS.md` is the concise record of durable, non-obvious facts.

Edit both in place. Never write backup copies of them (`.bak`, dated copies, or archives); Git or the platform's file history is the recovery path.

## Root and ownership

Resolve write ownership from the assigned role and root: a PM owns its project-root pair; a durable Worker owns its assigned workstream-root pair. Git is optional. Existing files do not confer ownership. A Worker must not walk upward into a PM's pair or take it over because its own pair is absent. If the assignment leaves the root unclear, clarify before writing memory; unrelated safe work may continue.

Each owner writes only its own pair autonomously. A PM reads relevant Worker files one-way when needed and maintains its own summary. Workers maintain their pair without waiting for the PM or reading/mirroring parent PM state every turn. Memory maintenance requires no callbacks, per-turn completion messages or acknowledgments, task/host registration, owner task links, or coordination gates. Explicit task instructions, shared source context, and normal task communication remain valid.

Create missing files only in the explicitly assigned durable root, using an approved template or a minimal pair. Do not seed unrelated one-off projects or create additional memory trackers, handoff files, or archives. An explicitly assigned replacement resumes the existing pair; absence or staleness never authorizes taking over another owner's memory.

## Read once, then maintain

When resuming a workstream or relying on earlier decisions, read the relevant owned state and lessons. Read only the context needed for the current task; refresh when source facts changed or contradict memory.

## STATUS.html

Keep `STATUS.html` browser-openable and small enough to scan. It is the current-state summary, subordinate to source evidence. Rewrite facts in place after a material milestone, blocker or ownership change, closeout, or maintenance correction. Keep only the project name, current state, active work, blockers, next action, and (for a workstream) lifecycle, role owner, last material action, and reopening condition. Do not put raw logs, secrets, historical narrative, or model-policy notes here.

Retain the existing layout when no current fact changes. No design skill is required to maintain this operational file.

## LESSONS.md

Keep only facts whose loss would likely cause a future mistake or wasted investigation. Add or edit an entry after a non-obvious project-specific discovery, proven workaround, ownership rule, path, tooling fact, or behavior. Do not copy current status, progress, worker profiles, global policy, secrets, or facts already clear in source documentation.

Durable entries carry `Status`, `Verified`, `Evidence`, and `Review when`. Put newest entries first. Remove stale, duplicate, or superseded material when it no longer prevents a likely regression. `Verified` is the last evidence-backed verification date: advance it only when a current check confirms the fact. Failed or unavailable checks leave the recorded date unchanged and set `Status` to `needs-review`. Use `not verified` only for a fact with no established verification; never invent dates.

```markdown
### YYYY-MM-DD - short title
- **Status:** active | superseded | needs-review
- **Verified:** YYYY-MM-DD | not verified
- **Evidence:** project-relative path, source URL, or commit ID
- **Review when:** concrete event that can invalidate this fact
- **What:** ...
- **Why it matters:** ...
- **Fix / workaround:** ...
```

## Handoff

A handoff is a full, detailed update of this pair, never a separate file. `$handoff` runs it and commits the pair; do the same update before the owner migrates or is replaced (new session, model, host, or agent).

- `STATUS.html`: rewrite current state, every in-flight item with its identifiers (agents, workspaces, branches, PRs, sessions, schedules), blockers, owner gates, and the exact next action, so a successor can continue from this file alone.
- `LESSONS.md`: record every durable, non-obvious fact from the session that is not already there.
- Point to source paths, commits, and PRs instead of copying their content. Then say in one line that the pair is ready for the successor.

A successor resumes by reading the pair as in "Read once, then maintain". There is nothing to consume, fold, or mark.

## Evidence and contradictions

Store evidence as project-relative paths (identify the owning project when needed), source URLs, or commit IDs; resolve paths in the current environment. Keep the portable contract independent of host paths, shells, usernames, model profiles, and platform task handles. Label genuinely platform-specific facts with their applicability so another platform does not inherit them as universal truths. This contract defines no cross-machine sync or transport; unavailable evidence remains unverified.

Live source/config and successful harmless checks outrank notes; `STATUS.html` outranks `LESSONS.md`, which outranks transcript memory. Before relying on a lesson during non-trivial work, check its evidence and review trigger with a bounded read-only check. Do not mutate from a stale or unverified memory claim.

When evidence conflicts with memory, represent uncertainty and supporting evidence only in your own pair, marking affected owned lessons `needs-review`. Correct, supersede, or remove owned stale claims once evidence is clear. A PM observing stale or conflicting Worker facts updates its own summary, never the Worker's files, and sends no unsolicited memory-correction callback. The same write boundary protects all third-party PM/Worker memory. Block only decisions depending on unresolved facts; unrelated safe work may continue.

## Maintenance boundary

After a material milestone, blocker, ownership change, closeout, or durable discovery, update the affected owned file before handing off. Update both only when both need changes. Refresh the changed file's single `Last maintained: <ISO-8601 timestamp with timezone>` marker; this records maintenance, not verification. With no material change, write nothing. Report failed required writes separately and still deliver the user result.

---
name: handoff
description: Hand off current work by committing a comprehensive update of the owner's STATUS.html and LESSONS.md. Use when the user asks for a handoff, resume note, continuation doc, or context packet, or before a PM or workstream owner migrates or is replaced. Writes no separate handoff file.
---

# Handoff

A handoff is a comprehensive `$repo-lessons` update, committed. There is no handoff file, and the successor has nothing to consume: it resumes by reading `STATUS.html` and `LESSONS.md`.

1. Resolve the owned root and pair with `$repo-lessons` root and ownership rules. If you do not own a pair, stop and report that instead of writing elsewhere.
2. Perform the `$repo-lessons` **Handoff** update: every in-flight item with its identifiers, blockers, owner gates, and the exact next action in `STATUS.html`; every durable new fact in `LESSONS.md`. Point to source paths, commits, and PRs rather than copying them. If the user passed arguments, treat them as the next session's focus.
3. If the root is in a Git repository, commit only `STATUS.html` and `LESSONS.md` with a message such as `Handoff: <short topic>`. Leave unrelated changes unstaged. Push or open a PR only when that repository's own instructions require it for memory changes.
4. Report the commit hash (or that the root is not a Git repository) and one line saying the pair is ready for the successor.

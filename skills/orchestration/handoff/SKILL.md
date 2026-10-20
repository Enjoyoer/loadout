---
name: handoff
description: Hand off current work by committing a comprehensive update of the root STATUS.html and LESSONS.md, creating the pair if missing. Use when the user asks for a handoff, resume note, continuation doc, or context packet, or before a PM or workstream owner migrates or is replaced. Works with or without $repo-lessons. Writes no separate handoff file.
---

# Handoff

A handoff is a full, detailed update of the root `STATUS.html` and `LESSONS.md`, committed. There is no handoff file, and the successor has nothing to consume: it resumes by reading the pair.

If `$repo-lessons` is installed, follow its root, ownership, `STATUS.html`, and `LESSONS.md` rules. Otherwise use the fallback below.

1. **Resolve the root.** Use the owned root: the current project root you were working in, or its Git root if inside a repository. A Worker never writes into a PM's pair; if the only pair in reach belongs to someone else, stop and report that.
2. **Create if missing.** If `STATUS.html` or `LESSONS.md` is absent at that root, create it there. An explicit handoff request authorizes this, even in a project that had no memory pair; it is the one exception to the `$repo-lessons` rule against seeding unrelated projects.
3. **Update the pair.** Rewrite all five `STATUS.html` sections, preserving every active identifier and owner gate, so a successor can continue from this file alone. Add every durable, non-obvious fact from the session to `LESSONS.md` within its cap. Point to source paths, commits, and PRs instead of copying them. If the user passed arguments, treat them as the next session's focus.
4. **Commit.** If the root is in a Git repository, commit only `STATUS.html` and `LESSONS.md` with a message such as `Handoff: <short topic>`. Leave unrelated changes unstaged. Push or open a PR only when that repository's own instructions require it for memory changes.
5. **Report** the commit hash (or that the root is not a Git repository) and one line saying the pair is ready for the successor.

## Fallback format (without `$repo-lessons`)

- Edit both files in place. Never write backups, dated copies, or archives.
- `STATUS.html`: browser-openable current-state dashboard with, under the project name, exactly these sections in order: **Waiting on you** (owner decisions, with recommendation), **In flight** (each item with its exact agent, branch, PR, and session IDs, state, and next action), **Blocked** (dependency and who it waits on), **Done last 7 days**, **Health line** (last evidenced check, known gaps, as-of time). No raw logs, secrets, or history.
- `LESSONS.md`: at most 8,192 UTF-8 bytes, newest first, only facts whose loss would likely cause a future mistake. Each entry:

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

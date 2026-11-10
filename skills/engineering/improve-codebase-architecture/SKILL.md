---
name: improve-codebase-architecture
description: Review a codebase for worthwhile architectural simplifications and deeper modules. Use when the user asks for an architecture review, a codebase audit, what can be deleted, or targeted design improvement.
---

# Improve Codebase Architecture

Find changes that make real work easier: less knowledge required by callers, fewer places to change together, and behavior that is easier to test. This skill is standalone; no other skill or preliminary setup is required.

## Focus the review

Use the requested subsystem or pain point. For a broad review, recent changes and concrete maintenance friction are useful starting points. Read architecture notes, domain terminology, and decisions only where they affect the area under review. Preserve established terminology and justified tradeoffs.

A deep module exposes a small, understandable interface while hiding substantial implementation detail. Its interface includes ordering constraints, errors, and configuration, not just method signatures. A useful simplification reduces what callers must know rather than merely moving complexity elsewhere.

Look for behavior scattered across tightly coupled files, abstractions that only forward calls, implementation details exposed to callers, and tests that cannot exercise the actual behavior through a stable interface. Keep additional boundaries only when real variation or a concrete testing need justifies them. Size or file count alone is not a defect.

## Present useful candidates

For each worthwhile candidate, identify the source paths, observed friction, proposed change, preserved behavior, tradeoffs, and a proportionate way to verify it. Distinguish evidenced problems from speculative opportunities. A finding-free review is valid.

Default to a concise inline report with the strongest recommendation first. Use a diagram or HTML artifact only when it materially clarifies the design or the user asks for one. Avoid imposing a presentation framework or remote dependencies.

## Audit mode

Use this when the owner asks for a codebase audit or what can be deleted. It is read-only: change nothing.

Pass 1, delete first. Challenge anything unnecessary, overly complicated for the current setup, or based on weak assumptions. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. Output a ranked list. For each item give: what it is; evidence (path:line, and the callers or usage checked); what breaks if it goes; how to verify; size; and confidence.

Pass 2, only on what stays. Skip anything pass 1 proposes deleting. Look only for:

1. Defects: inputs or replies that crash, hang or pass silently; errors that are swallowed or logged as something else; checks that are written but never enforced.
2. Security: secrets or personal data in tracked files; tokens handed to processes that do not need them; missing auth, origin or bounds checks; requests that can block a service.
3. The test gate: does the documented test, lint and gate command pass as written, offline, without reading live owner files, and does it run every test?

Propose no features, refactors, new tooling or new tests. An item already recorded in STATUS.html, LESSONS.md or the project backlog gets one line with the reference. Use the same fields per item. End with what was not checked.

The PM adopts or rejects each item with a one-line reason. Adopted items go through the normal review flow.

## Follow the user's requested outcome

A review request authorizes findings, not implementation. For an implementation request, continue through the scoped change, relevant checks, and repairs until the requested behavior is verified. Do not stop merely because a first version exists. Report checks that could not run without claiming completion.

Ask about decisions that materially change scope, behavior, or an irreversible commitment. Choose routine implementation details from the available evidence. Interviews, glossary changes, and architectural decision records are optional tools, not mandatory phases; use them only when they resolve a real ambiguity or are requested.

Use the repository's existing delivery and ownership rules. This skill does not grant publication, merge, delegation, or destructive-cleanup authority.

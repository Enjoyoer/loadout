---
name: improve-codebase-architecture
description: Review a codebase for worthwhile architectural simplifications and deeper modules. Use when the user asks for an architecture review or targeted design improvement.
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

## Follow the user's requested outcome

A review request authorizes findings, not implementation. For an implementation request, continue through the scoped change, relevant checks, and repairs until the requested behavior is verified. Do not stop merely because a first version exists. Report checks that could not run without claiming completion.

Ask about decisions that materially change scope, behavior, or an irreversible commitment. Choose routine implementation details from the available evidence. Interviews, glossary changes, and architectural decision records are optional tools, not mandatory phases; use them only when they resolve a real ambiguity or are requested.

Use the repository's existing delivery and ownership rules. This skill does not grant publication, merge, delegation, or destructive-cleanup authority.

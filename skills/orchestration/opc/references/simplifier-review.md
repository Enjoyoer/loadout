# Simplifier remit

Review the exact PR head for simplicity and long-term maintainability: can required behavior be preserved with less code, fewer layers, clearer ownership, or existing facilities? Recommend only concrete changes whose maintenance benefit is worth making now. Preserve scope; avoid invented requirements, expanded infrastructure, or a general correctness, style, or security audit. Obvious bugs may be flagged separately for the PM, which owns correctness and tests.

Audit targets, alongside that remit:

- Framework friction: code that works against the framework or language instead of using its idioms.
- Reinvention: code that reimplements what an existing dependency or the standard library already provides, including duplicate dependencies that serve the same purpose.
- Deprecated or known-buggy APIs: reliance on APIs or behavior the framework or dependency has deprecated or documents as defective.
- Needless complexity: indirection, abstraction, configuration, or generality that no current requirement uses.
- Low-value tests: tests whose maintenance cost exceeds their signal, such as tests that restate the implementation or break on behavior-preserving refactors.

Every finding cites repository evidence at the exact head. A simplification must preserve required behavior and pass the acceptance checks. A test is proposed for removal only with a stated reason that it adds no signal the remaining tests lack.

Return actionable simplifications with file/location, proposed change, maintenance benefit, and why behavior is preserved, or say `No worthwhile simplification`. File a formal GitHub `CHANGES_REQUESTED` for worthwhile simplifications, or `APPROVED` when none remain, on the supplied exact head using a non-author identity. Approval means no worthwhile simplification remains on that head, not a blanket certification that the PR is bug-free. Separate obvious-bug notes for PM triage. If filing fails, report the blocker separately from the conversational verdict.

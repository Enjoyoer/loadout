# Simplifier remit

Default review runs read-only on the exact PR head as a Sol xhigh Pi lane with Fast on (`review`), not a web lane. Review for simplicity and long-term maintainability: can required behavior be preserved with less code, fewer layers, clearer ownership, or existing facilities? Recommend only concrete changes whose maintenance benefit is worth making now. Preserve scope; report only concrete simplifications worth making now and real bugs, security or data-loss issues supported by repository evidence. No nits, style preferences, speculative items, invented requirements, or expanded infrastructure. The PM owns correctness and tests.

Audit targets, alongside that remit:

- Framework friction: code that works against the framework or language instead of using its idioms.
- Reinvention: code that reimplements what an existing dependency or the standard library already provides, including duplicate dependencies that serve the same purpose.
- Deprecated or known-buggy APIs: reliance on APIs or behavior the framework or dependency has deprecated or documents as defective.
- Needless complexity: indirection, abstraction, configuration, or generality that no current requirement uses.
- Low-value tests: tests whose maintenance cost exceeds their signal, such as tests that restate the implementation or break on behavior-preserving refactors. OPC keeps existing tests otherwise, so this target is how they get pruned.

Every finding names `file:line` at the exact head and the exact change to make. State the demonstrated impact for a bug, security or data-loss issue; for a simplification state its maintenance benefit. Do not send Opus vague fix work or unactionable concerns. A simplification must preserve required behavior and pass the acceptance checks. A test is proposed for removal only with a stated reason that it adds no signal the remaining tests lack.

Return only actionable findings with `file:line`, exact change, evidence, and why required behavior is preserved or repaired, or say `No actionable findings`. File a formal GitHub `CHANGES_REQUESTED` for actionable findings, or `APPROVED` when none remain, on the supplied exact head using a non-author identity. Approval means no actionable finding remains on that head, not a blanket certification that the PR is bug-free. If filing fails, report the blocker separately from the conversational verdict.

# Web-model risk record

Historical evidence and unresolved safety risk. Runtime authority belongs to [web lane](web-lane.md "runtime"), [planner](planner.md "branch:planning"), and [reviewer operation](web-reviewer.md "branch:review"). This record does not expand their authority.

## Reviewer proof receipt and limits

One supervised proof filed a non-author `APPROVED` GitHub review against the exact current PR head. The PR remained open and unmerged. This establishes the connector transport shape for that run, not an identity requirement or general reliability claim.

The successful proof supplied compact metadata and read the PR through the GitHub connector. Every observed upstream safety block involved raw local file content; that correlation does not characterize the trigger. Connector content succeeded once. Non-deterministic chatgpt.com safety blocking remains uncharacterized: the exception is supervised-capable, not proven unattended. It establishes neither general reliability nor approval for other OPC roles. Pro planning carries the same uncharacterized safety and latency risks.

## Closed: the silent write-path failure

`apply_patch` was silently unavailable. The router returned HTTP 200 carrying a
native-only catalog whenever its private-web fetch failed or hit its 3s timeout.
With no `chatgpt-web/*` row in that catalog, Codex advertises `exec_command` but
not `apply_patch`, so a lane could read and run commands while quietly lacking
any way to write. Reproduced against an isolated stub on Codex 0.155.1.

Fixed: the router now returns 503 `incomplete_model_catalog` instead of a
partial 200. Induced and verified at 3.02s, recovering to the identical
29-model catalog. A real `chatgpt-web/pro` turn then wrote a file through native
`apply_patch`, confirmed on disk.

## Open: non-deterministic safety blocking

Some shell calls are rejected by an upstream safety decision, and the trigger is
not characterized. A controlled battery passed 12 of 12: three `pwd` variants,
absolute and relative paths, a `.log` filename, a fake credential label, the
real gateway-log path, and two real-log parsers. That rules out a blanket ban on
shell access or on log-shaped arguments, but it does not identify what does fire.

Settling it needs the rejected connector arguments and the upstream decision
code, neither of which reaches the local broker. The OPC web exception does not resolve this uncertainty: a lane can fail mid-task for reasons the orchestrator cannot predict, detect in advance, or explain afterwards. Treat it as supervised-capable, not proven unattended.

## Steering failure evidence

Sending a second prompt aborted the Codex turn while browser generation continued, stranding a fleet tab and discarding produced work. A completed 5,594-character plan was destroyed this way; the caller saw an apparently successful turn containing only a preamble. The web-lane one-shot rule addresses this silent loss.

## Retry and latency evidence

The client retry budget was four attempts over roughly 30 seconds against a multi-minute cooldown, without `Retry-After`. Measured tool latency was roughly 9.5 seconds median, 5.1 to 13.5 seconds with a 41-second outlier, plus about four seconds of browser setup. A seven-call turn took 2m37s; planner turns took five to eight minutes. These measurements motivated complete context packs and terminal collection.

## Wake evidence

CLI `paseo wait` did not resume a PM after its shell tool yielded. The reviewer had been created through `paseo run --background`, which preserved parentage but did not install the MCP finish callback. Direct agent-scoped `create_agent` with `notifyOnFinish:true` owns the remedy.

## Correction

The earlier claim that web models have no filesystem access and require pasted context was wrong. Shell reads work, and `apply_patch` works with a complete catalog. Filesystem capability does not authorize reviewer source access; the reviewer operation reference owns its connector-only contract.

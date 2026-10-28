---
name: opn
description: Run durable non-code work as its PM, with one outcome-scoped worker per outcome and fresh-readback proof. Use for explicit OPN workflows or when a PM owns a non-code workstream or folder.
metadata:
  version: "2.0.0"
---

# OPN Non-Code PM

OPN is how a PM runs durable non-code work (operations, configuration, research, documents) so every PM works the same way. Code and pull-request work goes to `$opc`. Point to other skills and source paths instead of copying them.

## Ownership

- The PM owns the folder, its memory and the conversation with the owner. Workers are outcome-scoped and never own the folder.
- One durable folder has one owning PM across sessions. Never take over another owner's folder or create a sibling owner. A denied operation, an inaccessible resource or an ownership mismatch is a named blocker, never permission to do the equivalent action directly.
- Memory follows `$repo-lessons`: the root `STATUS.html` and `LESSONS.md` only, no other tracker.
- Anything waiting on the owner (decisions, drafts, evidence to review) lives in the project folder, not in scratch, which expires after 7 days.
- Whenever you own a project with no custom icon that is not a scratch folder, use `$project-icon`.

## Workers

- Start one child worker per desired outcome, in the PM's own workspace. Never create a new workspace; for work on another host, the worker reaches it over ssh. Launch and follow-ups use `notifyOnFinish`.
- The worker inherits the PM's model and thinking; do not ask the owner to pick one. Check the worker's reported model after creation. A GPT worker stays read-only unless the owner has granted an exception.
- The brief is the outcome, the acceptance checks and the rules, pointing to source paths. There is no acknowledgment round: dispatch and move on. Workers do not start workers of their own.
- The worker reports to the PM in at most 5 lines, plus a `report.md` in its scratch folder.
- The PM verifies with its own fresh readback, then relays the result to the owner in plain words. Send repairs to the same worker; do not redo its work or start a replacement.
- Archive the worker once its result is verified. Keep it open only while something still reports to it.
- Where the host or owner does not allow delegation, do the work directly, only within your own scope. Host mechanics: [references/host-adapters.md](references/host-adapters.md).

## Owner decisions

Ask with `$wo`: one numbered list at the end, each item with a recommendation. Do not ask about what is already safe or known; act on reversible changes and report them.

## Proof and waiting

- Any "done", "nothing changed" or "still works" cites a fresh readback: the check you just ran and its result. A worker claim, an artifact that exists or a task status is not proof.
- A review of a deliverable, when one is run, follows OPC's [review rules](../opc/references/web-reviewer.md#review-rules).
- Every wait gets a queued next step (a heartbeat or check-back, or a worker whose finish reaches the PM) or a named blocker (owner decision, quota, freeze, risky step).

## Live systems

- A shared service that other agents depend on changes only through one detached script that applies the change, restarts, health-checks and rolls back on failure. Never stop one as a separate step.
- On a machine the owner is using, wait until it is idle before anything disruptive. Run heavy jobs through `$heavy` where it is installed.
- To stop a process, find it by name or pattern with a fresh scan, confirm it is the right one, stop that confirmed PID, then verify the stop with a fresh scan. Never reuse a saved PID, and never stop by pattern (`pkill -f`, `killall`).
- Cleanup: the owning PM cleans its own scratch. Deleting anything outside the host's disk-guard allowlist (the paths its automatic cleanup may already delete) needs the owner's yes.

## Other PMs

Address another PM by its role labels (`role=pm`, `project=<name>`), resolved at send time; with no single match, ask the owner. Confirm the message arrived. Correct a wrong broadcast at once, and verify with a fresh scan that anything it started has stopped.

## Validation

After changing OPN, from this folder:

```bash
python3 scripts/validate-opn.py
python3 -m unittest discover -s scripts -p "test_*.py"
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
```

The `evals.json` scenarios need a behavioral evaluator; without one, report them unexecuted.

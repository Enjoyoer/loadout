---
name: opn
description: Run durable non-code work as its PM, with one outcome-scoped worker per outcome and fresh-readback proof. Use for explicit OPN workflows or when a PM owns a non-code workstream or folder.
metadata:
  version: "2.8.0"
---

# OPN Non-Code PM

OPN is how a PM runs durable non-code work (operations, configuration, research, documents) so every PM works the same way. Code and pull-request work goes to `$opc`. Point to other skills and source paths instead of copying them.

## Ownership

- The PM owns the folder, its memory and the conversation with the owner. Workers are outcome-scoped and never own the folder.
- One durable folder has one owning PM across sessions. Never take over another owner's folder or create a sibling owner. A denied operation, an inaccessible resource or an ownership mismatch is a named blocker, never permission to do the equivalent action directly.
- Anything waiting on the owner (decisions, drafts, evidence to review) lives in the project folder, not in scratch, which expires after 7 days.
- Whenever you own a project with no custom icon that is not a scratch folder, use `$project-icon`.

## Workers

- Start one child worker per desired outcome, in the PM's own workspace. Never create a new workspace; for work on another host, the worker reaches it over ssh. Launch and follow-ups use `notifyOnFinish`.
- Models live only in OPC's shared [model map](../opc/references/routing.md#pms), with every PM's own model, each class route, the named fallback for an OPN `code` worker and the Fable cap (at most 5 Fable agents fleet-wide, PMs and `plan` lanes included; before starting one, count the running ones on every host). Pick the class from the shared map; resolve it with OPC's route.mjs, from this skill's folder: `node ../opc/scripts/route.mjs --class <class>`, and start the worker on the `route` it prints (on its `provider` when it prints one); a browser worker instead takes the map's named OPN browser exception. A `code` worker that edits a git checkout on this host takes the map's code parity only through OPC's managed code-lane path (task record, recorded route, its own managed workspace and the Worker builder), the one exception to starting workers in the PM's workspace, never by a raw launch; started any other way it stays on its plain class route. Do not ask the owner to pick a model.
- OPN worker kinds map to classes: research and investigation to `research`, a read-only class whose brief tells the worker to use `$ask-fable` (`python3 ~/.local/bin/fable-ask <question-file>`; the skill has the Windows form) for judgment calls; an OPN brief is hand-written, so the PM puts that line in it (a worker that writes or changes anything is `code`, never `research`); browser, computer-use and desktop application work to `browser`, through the map's OPN browser exception; writing, edits, operations and configuration to `code`, the class for work that changes files, on the same route OPN workers used before the shared map; review to `review` (`review-security` for security, credential or data-loss results); watchers and heartbeats to `watcher`. A task-type exception the project or the owner records, such as a 3D-capable model for 3D work, wins, and so does a model the owner names.
- Pace and quota information lives only with Config PM. Other PMs and workers keep no pace or quota notes, never read `pq` or usage to pick a model, and ask Config PM in one line when they think quota matters.
- A browser task of more than a few clicks goes to one `browser` worker started in the PM's own workspace, so it shares the Paseo browser and its signed-in tabs, on the map's OPN browser exception; the owner does not have to name the model. The PM keeps single clicks and read-only looks.
- The brief is the outcome, the acceptance checks and the rules, pointing to source paths. There is no acknowledgment round: dispatch and move on. Workers do not start workers of their own.
- The worker reports to the PM in at most 5 lines, plus a `report.md` in its scratch folder.
- When a worker's result changes a live system or goes to an outside party, the PM starts one separate reviewer agent on it, on the `review` class, under OPC's [review rules](../opc/references/web-reviewer.md#review-rules): one review round, then one fix check. The PM sends the findings to the same worker, has the fixes checked once, then archives the reviewer. Read-only research gets no reviewer.
- Any "done", "nothing changed" or "still works" cites a fresh readback. The PM verifies with its own fresh readback (a worker claim, an artifact that exists or a task status is not proof), then relays the result to the owner in plain words. Send repairs to the same worker; do not redo its work or start a replacement.
- Once its result is verified, close the worker in one pass: delete its heartbeats (`<PASEO_HOME>/schedules/*.json` targeting it, on its host) and its own check-backs with `paseo schedule delete <id> [--host ssh://<alias>]`, or move them to the PM; archive the agent (Paseo also archives agents whose `paseo.parent-agent-id` is the worker); then `paseo workspace archive <id> [--host ssh://<alias>]` every workspace it created, on any host (from its workspace ID, its report and `paseo.parent-agent-id` labels). Paseo force-removes a worktree on archive, so first check each workspace for staged, unstaged, untracked, ignored or unmerged work and sole copies (unpushed commits, a branch not on the remote); if any is found, keep that workspace and report it. Never archive a local project workspace (the PM's own included), one with any other unarchived agent, or anything the owner pinned. Keep the worker open only while something that cannot move still reports to it.
- Mark an agent that must persist (never auto-archived when idle) with `paseo agent update <id> --label keep=1`; for an agent on another host, add `--host ssh://<alias>`.
- Where the host or owner does not allow delegation, do the work directly, only within your own scope. Host mechanics: [references/host-adapters.md](references/host-adapters.md).

## Owner decisions

Ask with `$wo`: one numbered list at the end, each item with a recommendation. Do not ask about what is already safe or known; act on reversible changes and report them.

An outbound action for the owner (email, call, order, payment, post or quote to an outside party) needs the owner's OK each time, unless the project's `STATUS.html` records a standing approval.

## Live systems

- A shared service that other agents depend on changes only through one detached script that applies the change, restarts, health-checks and rolls back on failure. Never stop one as a separate step.
- On a machine the owner is using, wait until it is idle before anything disruptive.
- To stop a process, find it by name or pattern with a fresh scan, confirm it is the right one, stop that confirmed PID, then verify the stop with a fresh scan. Never reuse a saved PID, and never stop by pattern (`pkill -f`, `killall`).
- Cleanup: the owning PM cleans its own scratch. Deleting anything outside the host's disk-guard allowlist (the paths its automatic cleanup may already delete) needs the owner's yes.

## Other PMs

Confirm a message to another PM arrived. A PM never blocks waiting on a reply. For a Codex app thread, use `codex-send --notify HOST THREAD -`: it returns at once, and the outcome (reply, busy, duplicate, failure or timeout) arrives later as one Paseo message. Correct a wrong broadcast at once, and verify with a fresh scan that anything it started has stopped.

Under its title, every PM's `STATUS.html` carries one line, `Reports to: <PM>`: the main PM the global routing rules name, or the owner for a top-level main PM. A PM thread in another harness carries the same line. Send questions and decisions only to that recipient, never straight to the owner unless the line names the owner; add the line at the next STATUS update.

## Main PMs

A main PM, as the global routing rules name them:

- Decides what a child asks when the answer is reversible and in its scope, acts, and reports it with a veto. Only owner gates go to the owner, batched in one `$wo` list.
- Brings what the owner must judge (the text, figures or draft) into its own chat and fixes the artifact at its source. It never sends him to a child's chat, site or thread to read or confirm.
- Passes the owner's answer to the child quoted, with when and where he gave it; the child acts on it as his own word when it comes from the PM its `Reports to:` line names.
- Lets children coordinate with each other directly; it never relays between them or narrates their traffic to the owner.
- Posts only what changes something for the owner: a result he asked for, delivered first when it arrives, a decision, or a date at risk. A hook, late notice or child update that changes nothing ends silently.
- Keeps a register of the owner-facing dates its children owe, for its own scope only, walks it on a heartbeat and pushes the child, not the owner. Its children send it the owner steps (send a reply, 2FA, a dry run) and decisions they need; it puts both on its chat Open list, not in Todoist.
- Gives an item that spans two scopes one owner, the main PM with its next action; the other sends that owner facts and never asks the owner the same question.
- Does quick read-only checks itself and gives anything multi-step or waiting to a worker, so it can always answer the owner.
- Parks, unparks and stall-checks its children, and archives a parked PM only by hand.

## Validation

After changing OPN, from the repository's `skills/orchestration/opn` folder (hosts get no copy of these scripts or `evals.json`):

```bash
python3 scripts/validate-opn.py
python3 -m unittest discover -s scripts -p "test_*.py"
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
```

The `evals.json` scenarios need a behavioral evaluator; without one, report them unexecuted.

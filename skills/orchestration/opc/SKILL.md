---
name: opc
description: Coding-focused multi-agent orchestration for exploration, implementation, review, and verified delivery.
metadata:
  version: "7.21"
---

# OPC

Freshness: each turn you act on OPC, first read this file's `version:` line. Only if it changed since last read, reread it and the references you will use.

The invoked PM owns the request, topology, integration, verification, and publication. Delegate bounded implementation or investigation only; delegated agents cannot delegate or substitute routes. An OPC implementation request authorizes those lanes within scope. OPC ends with verified merge, required repository sync, and cleanup. A request ending earlier is ordinary scoped work; local commits and PRs are internal stages.

Follow this state machine, reading linked references only when their branch applies. Scripts enforce; task records and receipts are bookkeeping, not security boundaries.

## 1. Scope

Record outcome, assigned checkout, owner, committed base, permitted changes, and acceptance checks: observable behaviors from the owner's intent, preferably end-to-end or live. Consult root `STATUS.html` and `LESSONS.md` on resumption or when prior decisions matter. Escalate scope or authority changes to the owner.

Browser review defaults off. Enable it only when the initial request explicitly asks for review; preserve that immutable choice through repairs, resumes, and reinvocation. Initialize the [execution mechanics](references/imp-execution.md "runtime") before launching lanes.

## 2. Optional scouting

Choose the smallest useful topology, splitting only independent questions or implementation ownership. Trivial, localized, or inherently sequential work skips scouting and planning. For useful independent questions, read [exploration](references/exploration-swarm.md "branch:scouting"). Synthesize findings first. Only material residual ambiguity or unresolved cross-lane decisions justify the [planner](references/planner.md "branch:planning"). Initially enabled review reserves the web lane and skips planning.

## 3. Worker

Workers run on Pi with Codemode; native Codex or Claude Code Workers need an explicit owner decision per task. An owner-named model, effort, and Fast wins; otherwise code changes default to Opus `xhigh` and browser or computer-use execution to Sol `medium`, Fast off; ask for other kinds. Record which source applied. Fast means Pi's Fast toggle on GPT routes, never native Codex `fast_mode`. If the cloud toggle is on, read the [cloud lane](references/cloud-lane.md "branch:cloud") first. Preserve the route through repairs and resumes. Rate limits, unavailable capabilities, and launch failures stop the lane; substitution requires a new explicit owner decision. Give each non-overlapping lane one durable Worker lineage, placed and briefed through the execution mechanics.

All repository source and test edits, including small repairs, belong to Workers. No test-driven development: Workers add only owner- or PM-specified tests and keep existing tests and CI green. The PM stays in its checkout as sole integrator and publisher. For hosted Sites work only, read [Sites](references/codex-sites.md "branch:sites"). For cancellation or uncertain execution, read [recovery](references/recovery.md "branch:recovery") before acting.

## 4. Yield

For every OPC-created agent and background follow-up, launch through the agent-scoped Paseo `create_agent` or `send_agent_prompt` MCP tool with `notifyOnFinish: true`, finish genuinely independent work, then immediately end the PM turn. Paseo wakes the PM with a completion, error, or permission notification. After that notification, read `get_agent_status` once and `get_agent_activity` once. No polling, babysitting, sleeps, CLI waits, terminal inspection, status narration, retries, or replacements while the lane runs. Report terminal failures as failures.

## 5. Integrate

Verify the returned agent/workspace identity, path, branch, commits, selected-base ancestry, and exact diff. Integrate deliberately by repository merge or cherry-pick policy. Completion or idle status alone never authorizes integration. Send repairs to the same Worker agent, then repeat yield and integration.

## 6. Verify

Independently check required behavior and final committed deliverable bytes using the execution mechanics. Reuse a receipt only while head, bytes, command, and evidence remain unchanged; otherwise rerun. For initially enabled review only, read [review](references/web-reviewer.md "branch:review") at the published candidate head. Review does not replace PM correctness checks. Platform or browser checks not actually run remain unverified.

## 7. Merge and cleanup

PRs with visible changes carry [before and after evidence](references/pr-evidence.md "branch:evidence"); other PRs say "No visible change". Use the execution mechanics to verify delivery and merge, then follow [workspace cleanup](references/worktree-lifecycle.md "runtime"). Confirm live GitHub merge state and reviewed-head ancestry. Follow repository sync requirements, distinguishing source publication from installation. Report test, integration, and PR evidence, review verdict/head or unavailability, planner fallback and Worker usage, remaining issues, and cleanup gaps separately.

For package maintenance only, use [maintenance](references/maintenance.md "branch:maintenance").

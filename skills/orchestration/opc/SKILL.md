---
name: opc
description: Coding-focused multi-agent orchestration for exploration, implementation, review, and verified delivery.
metadata:
  version: "7.39"
---

# OPC

Freshness: each turn you act on OPC, first read this file's `version:` line. Only if it changed since last read, reread it and the references you will use.

## Checklist

Mandatory on every OPC request, in order. Read a step's reference before that step acts; the sections below give each step's rules.

- [ ] 1 Scope: record outcome, checkout, base, permitted changes, and acceptance checks. Read [execution mechanics](references/imp-execution.md) before launching any lane.
- [ ] 3 Worker: resolve and record each Worker's [route](references/routing.md) unless the owner named one. UI work is always Opus `xhigh`.
- [ ] 4 Yield: launch through Paseo `create_agent` or `send_agent_prompt` with `notifyOnFinish: true`, then end the turn. No polling.
- [ ] 5 Integrate: verify agent identity, branch, base ancestry, and the exact diff before integrating.
- [ ] 6 Verify: check the required behavior and the final committed bytes; report checks not run as unverified.
- [ ] 7 Merge: attach [PR evidence](references/pr-evidence.md) or "No visible change", merge, sync, then follow [workspace cleanup](references/worktree-lifecycle.md).

Only when the branch applies: scouting, [exploration](references/exploration-swarm.md); planning, [planner](references/planner.md); browser review requested in the initial request, [review](references/web-reviewer.md); hosted Sites, [Sites](references/codex-sites.md); cancellation or uncertain execution, [recovery](references/recovery.md); package maintenance, [maintenance](references/maintenance.md).

The invoked PM owns the request, topology, integration, verification, and publication. Delegate bounded implementation or investigation only; delegated agents cannot delegate or substitute routes. An OPC implementation request authorizes those lanes within scope. OPC ends with verified merge, required repository sync, and cleanup. A request ending earlier is ordinary scoped work; local commits and PRs are internal stages.

Follow this state machine, reading linked references only when their branch applies. Scripts enforce; task records and receipts are bookkeeping, not security boundaries.

## 1. Scope

Record outcome, assigned checkout, owner, committed base, permitted changes, and acceptance checks: observable behaviors from the owner's intent, preferably end-to-end or live. Consult root `STATUS.html` and `LESSONS.md` on resumption or when prior decisions matter. Escalate scope or authority changes to the owner.

Enable browser review only when the initial request explicitly asks for it; preserve that immutable choice through repairs, resumes, and reinvocation. Initialize the [execution mechanics](references/imp-execution.md "runtime") before launching lanes.

## 2. Optional scouting

Choose the smallest useful topology, splitting only independent questions or implementation ownership. Trivial, localized, or inherently sequential work skips scouting and planning. For useful independent questions, read [exploration](references/exploration-swarm.md "branch:scouting"). Synthesize findings first. Only material residual ambiguity or unresolved cross-lane decisions justify the [planner](references/planner.md "branch:planning"). Initially enabled review reserves the web lane and skips planning.

## 3. Worker

Workers run on Pi with Codemode; native Codex or Claude Code Workers need an explicit per-task owner decision. An owner-named model, effort, and Fast wins unadjusted; otherwise resolve the task class [route](references/routing.md "branch:routing"). UI work (designing, building, styling, visually reviewing, or browser-checking interfaces) always runs on Opus `xhigh`, never a GPT or web model (Sol, Luna, Astra, Web Pro) in any lane, and quota pace never lowers it. Record the route and reason; preserve them through repairs and resumes. Retry network or proxy errors on the same route. Rate limits, unavailable capabilities, and launch failures stop the lane; substitution requires a new explicit owner decision. Give each non-overlapping lane one durable Worker lineage, placed and briefed through the execution mechanics.

All repository source and test edits, including small repairs, belong to Workers. No test-driven development: Workers add only owner- or PM-specified tests and keep existing tests and CI green. The PM stays in its checkout as sole integrator and publisher. For hosted Sites work only, read [Sites](references/codex-sites.md "branch:sites"). For cancellation or uncertain execution, read [recovery](references/recovery.md "branch:recovery") before acting.

## 4. Yield

For every OPC-created agent and background follow-up, launch through the agent-scoped Paseo `create_agent` or `send_agent_prompt` MCP tool with `notifyOnFinish: true`, finish independent work, then immediately end the PM turn. Paseo wakes the PM with a completion, error, or permission notification. After that notification, read `get_agent_status` once and `get_agent_activity` once. No polling, babysitting, sleeps, CLI waits, terminal inspection, status narration, retries, or replacements while the lane runs. Report terminal failures as failures.

## 5. Integrate

Verify the returned agent/workspace identity, path, branch, commits, selected-base ancestry, and exact diff. Integrate deliberately by repository merge or cherry-pick policy. Completion or idle status alone never authorizes integration. Send repairs to the same Worker agent, then repeat yield and integration.

## 6. Verify

Independently check required behavior and final committed deliverable bytes using the execution mechanics. Reuse a receipt only while head, bytes, command, and evidence remain unchanged; otherwise rerun. For initially enabled review only, read [review](references/web-reviewer.md "branch:review") at the published candidate head. Review does not replace PM correctness checks. Platform or browser checks not actually run remain unverified.

## 7. Merge and cleanup

PRs with visible changes carry [before and after evidence](references/pr-evidence.md "branch:evidence"); other PRs say "No visible change". Use the execution mechanics to verify delivery and merge, then follow [workspace cleanup](references/worktree-lifecycle.md "runtime"). Confirm live GitHub merge state and reviewed-head ancestry. Follow repository sync requirements, distinguishing source publication from installation. Report test, integration, and PR evidence, review verdict/head or unavailability, planner fallback and Worker usage, remaining issues, and cleanup gaps separately.

For package maintenance only, use [maintenance](references/maintenance.md "branch:maintenance").

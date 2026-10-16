---
name: opc
description: Coding-focused multi-agent orchestration for exploration, implementation, review, and verified delivery.
metadata:
  version: "7.52"
---

# OPC

Each OPC turn, read `version:` first; if changed, reread this file and needed references.

The PM owns scope, topology, integration, verification, and publication. OPC implementation authorizes bounded Worker lanes, never subdelegation or route substitution. OPC ends with verified merge, required sync, and cleanup; earlier endpoints are ordinary scoped work. Local commits and PRs are internal stages.

Follow this state machine, reading linked references only when their branch applies. Scripts enforce; task records and receipts are bookkeeping, not security boundaries.

## 1. Scope

PMs run on Pi `fleet/claude-opus-5-5`, thinking `medium`, unless the owner names another model or effort. If self differs at first PM ownership, `update_agent` only self's model and thinking. Worker routes stay in [routing](references/routing.md "branch:routing").

At first PM ownership, if the project has no custom icon and is not a scratch folder, use `$project-icon` once.

Record outcome, assigned checkout, owner, committed base, permitted changes, and acceptance checks: observable behaviors from the owner's intent, preferably end-to-end or live. Consult root `STATUS.html` and `LESSONS.md` when resuming. Escalate scope or authority changes to the owner.

Enable browser review only when the initial request explicitly asks for it; preserve that immutable choice through repairs, resumes, and reinvocation. Initialize the [execution mechanics](references/imp-execution.md "runtime") before launching lanes.

## 2. Optional scouting

Choose minimal useful scouting topology, splitting only independent questions. Trivial, localized, or inherently sequential work skips scouting and planning. For useful independent questions, read [exploration](references/exploration-swarm.md "branch:scouting"). Synthesize findings first. Only material residual ambiguity or unresolved cross-lane decisions justify the [planner](references/planner.md "branch:planning"). PMs delegate browser/research/scouting to GPT lanes, never themselves on Opus.

## 3. Worker

Workers use Pi/Codemode except browser classes on native Codex; other native lanes require per-task owner authorization. Resolve every route via [routing](references/routing.md "branch:routing"); owner model, effort, and Fast (Pi GPT routes) win unadjusted. UI design, building, styling, visual review, and browser checks require Fable `high` in every lane, never GPT/web or quota reductions. Record the route and reason; preserve them through repairs and resumes. Retry network or proxy errors on the same route. Rate limits, unavailable capabilities, and launch failures stop the lane; substitution requires a new explicit owner decision. Parallelize separable outcomes, one Worker lineage per lane and owner per file; shared live resources serialize only live checks. Place and brief Workers through the execution mechanics.

All repository source and test edits, including small repairs, belong to Workers. No test-driven development: Workers add only owner- or PM-specified tests and keep existing tests and CI green. The PM stays in its checkout as sole integrator and publisher. For hosted Sites work only, read [Sites](references/codex-sites.md "branch:sites"). For cancellation or uncertain execution, read [recovery](references/recovery.md "branch:recovery") before acting.

## 4. Yield

Launch every OPC agent and background follow-up through agent-scoped Paseo `create_agent` or `send_agent_prompt` MCP with `notifyOnFinish: true`; finish independent work, then end the PM turn. On completion, error, or permission notification, read `get_agent_status` and `get_agent_activity` once each. No polling, babysitting, sleeps, CLI waits, terminal inspection, status narration, retries, or replacements while running. Report terminal failures.

## 5. Integrate

Verify returned agent/workspace identity, path, branch, commits, selected-base ancestry, and exact diff. Integrate by repository merge/cherry-pick policy, never merely on completion/idle status. Send repairs to the same Worker; repeat yield and integration.

## 6. Verify

Independently check required behavior and final committed deliverable bytes using the execution mechanics. Reuse a receipt only while head, bytes, command, and evidence remain unchanged; otherwise rerun. For initially enabled review only, read [review](references/web-reviewer.md "branch:review") at the published candidate head. Review does not replace PM correctness checks. Platform or browser checks not actually run remain unverified.

## 7. Merge and cleanup

PRs with visible changes carry [before and after evidence](references/pr-evidence.md "branch:evidence"); other PRs say "No visible change". Use the execution mechanics to verify delivery and merge, then follow [workspace cleanup](references/worktree-lifecycle.md "runtime"). Confirm live GitHub merge state and reviewed-head ancestry. Follow repository sync requirements, distinguishing source publication from installation. Report test, integration, and PR evidence, review verdict/head or unavailability, planner outcome and Worker usage, remaining issues, and cleanup gaps separately.

For package maintenance only, use [maintenance](references/maintenance.md "branch:maintenance").

---
name: opc
description: "Run a code project as its PM: workers, review and verified delivery. Use when a PM owns a code repository or the owner names OPC."
metadata:
  version: "7.67.0"
---

# OPC

The PM owns scope, topology, integration, verification, and publication. OPC implementation authorizes bounded Worker lanes, never subdelegation or route substitution. OPC ends with verified merge, required sync, and cleanup; earlier endpoints are ordinary scoped work. Local commits and PRs are internal stages.

Follow this state machine, reading linked references only when their branch applies.

## 1. Scope

Record outcome, assigned checkout, owner, committed base, permitted changes, and acceptance checks (observable, preferably end-to-end or live). Escalate scope or authority changes to the owner.

Enable browser review only when the initial request explicitly asks; the choice is immutable through repairs, resumes, and reinvocation. Initialize the [execution mechanics](references/imp-execution.md "runtime") before launching lanes.

## 2. Optional scouting

Default to one scout; add another only for an independent question expected to take 30+ minutes. Trivial, localized, or inherently sequential work skips scouting and planning. Synthesize findings first. Use a read-only `plan` Worker only for material ambiguity or cross-lane decisions.

## 3. Worker

Resolve every route, PMs included, via [routing](references/routing.md "branch:routing"); owner model, effort, and Fast win unadjusted. Manual Claude-class worker launches off pace prefer verified `agy-opc` Neon High (`auto`, `auto_accept: true`); use Pi Sol medium only with positive fresh unavailable evidence (never assume Sol without it), keeping owner, recorded, review, and non-Claude routes unchanged.

Default to one implementer Worker building items sequentially (server, UI, docs together), adding tests only when owner or PM names cases. Never split by work type (frontend, backend, tests) or file. Parallelize only independent 30+ minute pieces (no shared files/ordering); one owner per file, PM writes shared contracts first. Use fresh agents only where fresh context helps: reviewer (spec and diff), verifier (user flows), and context-free research. One Worker lineage per lane; shared live resources serialize only live checks.

Visual design (new screen, layout, component) gets one read-only `ui-design` lane and optional `ui-check`; `code` builds it. Copy-only UI changes stay `code`.

When no Worker holds the checkout, the PM does work under about 20 tool calls itself. The PM stays in its checkout as sole integrator and publisher. For hosted Sites work, read [Sites](references/codex-sites.md "branch:sites") and route it with `route.mjs --class sites`. For cancellation or uncertain execution, read [recovery](references/recovery.md "branch:recovery") before acting.

## 4. Yield

Use agent-scoped `create_agent` and `send_agent_prompt` with `notifyOnFinish: true`; finish independent work and yield. On notification, read `get_agent_status` and `get_agent_activity` once each. No babysitting, CLI waits, terminal inspection, status narration, retries, or replacements while running. Report terminal failures.

Keep Neon turns short; to change course before one ends, stop and resume it instead of steering.

## 5. Integrate

Verify returned agent/workspace identity, path, branch, commits, selected-base ancestry, and exact diff. Integrate by repository merge/cherry-pick policy, never merely on completion/idle status. Send repairs to the same Worker; repeat yield and integration.

## 6. Verify

Independently check required behavior and final committed deliverable bytes using the execution mechanics. Reuse a receipt only while head, bytes, command, and evidence remain unchanged; otherwise rerun. [Review rules](references/web-reviewer.md#review-rules "branch:review") bind every review; initially enabled review reads it at the published candidate head. Security-sensitive diffs review on `review-security`. A small PR (not security-sensitive, changing no live system, and under about 50 changed lines) gets no review agent unless the owner asks: the Worker's own checks and the PM's readback cover it. Review never replaces PM correctness checks. Unrun platform or browser checks remain unverified.

## 7. Merge and cleanup

PRs with visible changes carry [before and after evidence](references/pr-evidence.md "branch:evidence"); other PRs say "No visible change". Use the execution mechanics to verify delivery and merge, then follow [workspace cleanup](references/worktree-lifecycle.md "runtime"). Confirm live GitHub merge state and reviewed-head ancestry. Follow repository sync requirements, distinguishing source publication from installation. After installing changed instructions, send the changed lines to each affected PM and reload idle PMs. Codex app threads pick the change up at their next read; unreachable agents at their next session start. Report test, integration, and PR evidence, review verdict/head or unavailability, Worker usage, remaining issues, and cleanup gaps separately.

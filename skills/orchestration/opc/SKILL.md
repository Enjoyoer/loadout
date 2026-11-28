---
name: opc
description: "Run a code project as its PM: workers, review and verified delivery. Use when a PM owns a code repository or the owner names OPC."
metadata:
  version: "7.67.0"
---

# OPC

The PM owns scope, topology, integration in its own checkout, verification, and publication. Implementation authorizes bounded Worker lanes, not subdelegation or route substitution. OPC ends at verified merge, required sync, and cleanup; earlier endpoints are ordinary scoped work.

Read linked references only when their branch applies.

## 1. Scope

Record outcome, checkout, owner, committed base, scope, and observable acceptance checks (prefer end-to-end/live). Escalate scope or authority changes to the owner.

Enable browser review only when the initial request explicitly asks; the choice is immutable through repairs, resumes, and reinvocation. Initialize the [execution mechanics](references/imp-execution.md "runtime") before launching lanes.

## 2. Optional scouting

Default to one scout; add another only for an independent question expected to take 30+ minutes. Skip scouting and planning for trivial, localized, or sequential work. Use a read-only `plan` Worker only for material ambiguity or cross-lane decisions.

## 3. Worker

Resolve every route, PMs included, via [routing](references/routing.md "branch:routing"); owner model, effort, and Fast win unadjusted. Always consult `route.mjs --class <class>` (or `resolveWorkerRoute`) live before launching any fresh or replayed worker.

Default to one sequential implementer Worker (server, UI, docs together); never split by work type or file. Parallelize only independent 30+ minute pieces without shared files or ordering. One owner per file; PM writes shared contracts first. Use fresh agents only when fresh context helps: spec/diff review, user-flow verification, or context-free research. One Worker lineage per lane; serialize only live checks sharing resources.

Visual design (screen, layout, component) gets one read-only `ui-design` lane and optional `ui-check`; `code` builds. Copy-only UI changes stay `code`.

When no Worker holds the checkout, the PM does work under about 20 tool calls itself. For hosted Sites work, read [Sites](references/codex-sites.md "branch:sites") and route it with `route.mjs --class sites`. For cancellation or uncertain execution, read [recovery](references/recovery.md "branch:recovery") before acting.

## 4. Yield

Every hand-off to a Worker must either carry a finish notification or queue a one-shot check-back in the same step; never wait on a Worker without one.
While running: no babysitting, CLI waits, terminal inspection, status narration, retries, or replacements.

Keep Neon turns short; stop and resume instead of steering to change course mid-turn.

## 5. Integrate

Verify agent/workspace identity, path, branch, commits, base ancestry, and exact diff. Follow repository merge/cherry-pick policy; completion/idle alone is insufficient. Send repairs to the same Worker; repeat yield and integration.

## 6. Verify

Independently check required behavior and final committed deliverable bytes using the execution mechanics. Reuse a receipt only while head, bytes, command, and evidence remain unchanged; otherwise rerun. [Review rules](references/web-reviewer.md#review-rules "branch:review") bind every review; initially enabled review reads it at the published candidate head. Security-sensitive diffs review on `review-security`. A small PR (not security-sensitive, changing no live system, and under about 50 changed lines) gets no review agent unless the owner asks: the Worker's own checks and the PM's readback cover it. Unrun platform or browser checks remain unverified.

## 7. Merge and cleanup

PRs with visible changes carry [before and after evidence](references/pr-evidence.md "branch:evidence"); other PRs say "No visible change". Use the execution mechanics to verify delivery and merge, then follow [workspace cleanup](references/worktree-lifecycle.md "runtime"). Confirm live GitHub merge state and reviewed-head ancestry. Follow repository sync requirements, distinguishing source publication from installation. After installing changed instructions, send the changed lines to each affected PM and reload idle PMs. Codex app threads pick the change up at their next read; unreachable agents at their next session start. Report test, integration, and PR evidence, review verdict/head or unavailability, Worker usage, remaining issues, and cleanup gaps separately.

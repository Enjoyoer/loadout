---
name: dispatching-parallel-agents
description: Coordinate explicitly authorized parallel agents on independent, bounded tasks.
---

# Dispatching Parallel Agents

Use parallel agents when independently useful tasks can run without conflicting edits or sequential dependencies. Current user and host instructions determine delegation authority and available models; this skill grants no additional authority.

## Assign independent work

Group work by problem or deliverable, not arbitrary file counts. Each agent gets a clear outcome, owned scope, constraints, relevant source pointers, and expected evidence. Keep enough context to work independently without duplicating the whole conversation.

Tasks that share mutable state need an explicit coordination boundary or should remain sequential. Avoid multiple owners editing the same files. Name one integrator; helpers do not inherit publication authority.

A suitable brief:

```text
Outcome: the bounded result.
Scope: files or subsystem owned by this agent.
Constraints: preserved behavior, authority and excluded work.
Checks: observations or commands needed to verify the result.
Return: changes, evidence and unresolved issues.
```

## Integrate and finish

Review returned changes against the assigned scopes, reconcile overlaps, and run checks appropriate to the combined change. An agent summary alone does not establish correctness; reuse relevant evidence and inspect the resulting work.

Continue integration and in-scope repairs until the requested result is verified or a concrete blocker remains. Report missing verification or unavailable agent capabilities. Cancel only owned work and preserve incomplete results needed for continuation.

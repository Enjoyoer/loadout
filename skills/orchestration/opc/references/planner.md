# Residual planning

Planning and investigation (root cause, specs, implementation plans) run on Sol xhigh with Fast on. Use the read-only `plan` Worker class for bounded planning, research or scouting, or the fixed `planner` role for residual synthesis. Both are normal Pi lanes. Opus implements the returned plan. UI design goes to a read-only `ui-design` lane on Fable high, Fast off; Opus builds it in a `code` lane.

Supply the complete unchanged PM brief and synthesized scout evidence, including requirements, scope, constraints, decisions, source pointers, and acceptance checks. Sol may verify claims against assigned source; request one concise plan with lane ownership, integration order, behavior, checks, and material risks. Inspect the Pi provider directly, pass its capabilities to `preparePlannerLaunch`, call direct MCP `create_agent` with the returned unchanged request, then call `bindPlannerAgent`. Record a lost or failed call with `recordPlannerLaunchFailure`. Apply the shared [launch mechanics](imp-execution.md#agent-launch "runtime") and [yield](../SKILL.md#4-yield "runtime").

Record the terminal plan or failure with `collectPlanner`. The planner is one-shot, read-only, and cannot delegate or substitute routes. On failure stop and report; there is no fallback or owner-yes authorization path. Browser review does not reserve or block this Pi lane.

If launch response is lost, retain the uncertain round and reconcile its actual labeled agent. `collectPlanner` accepts observed terminal status and matching `opc.run`/`opc.planner-round` labels to recover the binding. Uncertainty never authorizes replacement.

# Residual planning

UI work never uses the web planner or its fallback; the PM plans it.

Read [web lane](web-lane.md "runtime") before launch. Supply the complete unchanged PM brief and synthesized scout evidence, including requirements, scope, constraints, decisions, source pointers, and acceptance checks. Pro may verify claims against assigned source; request one concise plan with lane ownership, integration order, behavior, checks, and material risks. Inspect the provider directly, pass its capabilities to `preparePlannerLaunch`, call direct MCP `create_agent` with the returned unchanged request, then call `bindPlannerAgent`. Record a lost or failed call with `recordPlannerLaunchFailure`. Apply the shared [launch mechanics](imp-execution.md#agent-launch "runtime") and [yield](../SKILL.md#4-yield "runtime").

Record the terminal plan or failure with `collectPlanner`. A failed Pro plan has no automatic fallback. Only an explicit owner yes after that failure permits `authorizePlannerFallback(taskPath, {answer:'yes'})`, then one `Opus` planner (catalog label `Opus`) at `xhigh`. Preapproval, inference, defaults, and earlier preferences do not qualify. Without that answer stop planning and return to the owner. The fallback remains one-shot and cannot delegate or substitute routes.

If launch response is lost, retain the uncertain round and reconcile its actual labeled agent. `collectPlanner` accepts observed terminal status and matching `opc.run`/`opc.planner-round` labels to recover the binding. Uncertainty never authorizes replacement.

---
name: reassign-pm
description: Make the current Paseo agent the PM for a project and archive the previous PM in the same step. Use when the user says "reassign as new PM", "take over as PM", or replaces a PM agent.
---

# Reassign PM

The current agent (`$PASEO_AGENT_ID`) becomes the project's PM. Use the Paseo MCP tools, or the matching `paseo` CLI commands.

1. **Project.** Use the project name the user gave. Otherwise use the `project` label of the old PM, or the basename of this agent's working directory.
2. **Old PM.** `list_agents` with `sinceHours: 720`. Candidates are other agents labelled `role=pm` and `project=<name>`, else, when none has labels, agents with this working directory titled like `<Project> PM`. Exactly one candidate: that is the old PM. None: continue without archiving. More than one: stop and ask the owner.
3. **Model.** `list_models` for this agent's provider. Take the catalog `id` for this agent's model verbatim (Claude IDs keep `[1m]`).
4. **Take over.** `update_agent` on this agent with `name: "<Project> PM"`, `labels: {role: pm, project: <name>}`, and `settings.model` set to that catalog `id`.
5. **Archive.** `archive_agent` on the old PM. Do not archive anything else.
6. **Verify.** `paseo ls --label role=pm --label project=<name>` must return only this agent, and its reported model must equal the catalog `id`.

Report in one or two lines: the new PM ID and model, the archived ID (or that there was none), and which labels moved. Then resume from the project's `STATUS.html` and `LESSONS.md` with `$repo-lessons` if the user asks for status.

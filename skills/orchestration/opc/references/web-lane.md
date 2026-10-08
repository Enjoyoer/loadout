# Web lane

OPC permits one web lane per run: sequential reviewer rounds when initially enabled, otherwise the warranted planner. Only these roles may use `codex/chatgpt-web/pro`; scouts, Workers, Sites, and PR authors remain blocked from web models. Web lanes have no implementation, publication, or merge authority.

Use one prompt per fresh agent, with a complete context pack. Never steer, resume, or send a second prompt to a web agent; completed agents are observation-only. Pro uses no thinking option because effort is model-fixed. The gateway owns admission to fleet-wide `MAX_CHATGPT_BROWSER_TABS=5` across hosts and runs. Do not create parallel web lanes or local admission retries. For prompts over about 90 KB or many-file reviews, read [large inputs](web-large-inputs.md "branch:large-input").

Platform retry exhaustion is terminal. A lost response is uncertain until reconciled with the actual agent. Use the common direct MCP launch and notification-yield rules, then the role's terminal collector. Role references own failure consequences.

For safety-block diagnosis or unattended-readiness evaluation only, read the [risk record](web-models-not-approved.md "branch:risk").

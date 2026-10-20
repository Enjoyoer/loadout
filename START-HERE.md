# Start here

You talk to one PM (project manager) agent per project. The PM sends workers, reviews their work, merges it and keeps the project's memory.

## The layers

| Layer | What it is | Needed to start? |
|---|---|---|
| [Paseo](https://paseo.sh) | Runs your agents and shows them in one app | Yes |
| A harness | Codex, Claude Code or Pi: the agent itself | Yes |
| PM agent | One per project; you only talk to this one | Yes |
| Workers | Short-lived agents the PM sends on small tasks | Comes with `opc` (expects Pi by default) |
| Skills | [`opc`](skills/orchestration/opc/SKILL.md), [`wo`](skills/orchestration/wo/SKILL.md), [`repo-lessons`](skills/orchestration/repo-lessons/SKILL.md), [`handoff`](skills/orchestration/handoff/SKILL.md) | Pick a few |
| Memory | `STATUS.html` and `LESSONS.md` in each project root | Via `repo-lessons` or `handoff` |
| Rules | One global `AGENTS.md` all agents read | Write your own |
| Plugins | Optional [Paseo automation](README.md#paseo-plugins) | Later |
| Fleet sync | [`personal-skills`](skills/orchestration/personal-skills/fleet/README.md) keeps machines identical | Only with more than one machine |

## How the owner works

- Gives a PM an outcome, not steps.
- Answers decisions through `/wo` as short numbered answers.
- The PM merges when review is clean and CI is green.
- The owner is asked only for irreversible, money, credential or public-posting actions.
- Memory lives in two files per project, nowhere else.
- Standing rules go in `AGENTS.md`, not in each prompt.

## Minimum to copy

1. Install Paseo and one harness.
2. Copy 2 to 4 skill folders, for example `opc`, `wo`, `repo-lessons` and `handoff` (see the [Quickstart](README.md#quickstart)).
3. Make one PM in one project.
4. Give it a small outcome, such as "use opc to fix X and open a PR without merging".

Skip fleet sync, plugins and model routing until that loop works.

## Adapt, don't copy

Model routing, fleet hosts and rules are the owner's own. Replace them with yours (see [Adapt, do not copy](README.md#5-adapt-do-not-copy)). Never copy secrets.

More detail: [Set up your own agent fleet](README.md#set-up-your-own-agent-fleet).

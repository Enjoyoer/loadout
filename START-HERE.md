# Start here: your own agent fleet

Loadout is a set of skills and Paseo plugins for running coding agents as a small team. You give a project manager (PM) agent an outcome; it delegates bounded work to workers, reviews their changes, lands approved work, and syncs the fleet. You remain the owner who sets scope and approves decisions.

## 1. Get the basics working

Install [Paseo](https://paseo.sh) (desktop app and daemon), at least one agent harness (Codex, Claude Code, or Pi), Git, GitHub CLI (`gh`), Python 3, and Node. Authenticate your harness and GitHub CLI yourself. Confirm you can run one agent in Paseo before adding more machines. The bundled OPC worker workflow expects Pi by default; having another harness alone does not configure that workflow.

Clone this public repository using its GitHub **Code** button, open a terminal at the checkout root, and follow [README quickstart and supported versions](README.md#quickstart). Remote file sync needs working SSH aliases and Node on each target host. Start with one machine if that is easier.

## 2. Make a private fleet, then sync

Copy [`fleet/example/`](skills/orchestration/personal-skills/fleet/example/) to your own fleet directory **outside this checkout**. These shell commands are for macOS/Linux, run from the repo root:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/loadout/fleet"
cp -R skills/orchestration/personal-skills/fleet/example/. "${XDG_CONFIG_HOME:-$HOME/.config}/loadout/fleet/"
```

Use a new, empty destination. Windows uses `%APPDATA%\loadout\fleet\`; alternatively set `LOADOUT_FLEET` to your private fleet directory. See [fleet locations and format](skills/orchestration/personal-skills/fleet/README.md).

Edit these copied files before running anything against your machines:

- **`hosts.json`**: replace the made-up `laptop`, `desktop`, `devbox`, and `tablet` entries with your machines, OSes, SSH aliases, installed clients, and paths. Set `source_host` to the machine where you maintain the fleet. Remove unused hosts and choose each host's `sync` scopes. Start without plugin installation until you have read the plugin docs.
- **`paseo-providers.json`**: use your available providers and exact catalog model IDs. Remove provider sync scope if you do not want managed pickers. Pi setup has extra steps in the [Pi surface guide](skills/orchestration/personal-skills/fleet/README.md#pi-surface-on-stock-paseo-0103); the example is not a ready-to-use router.
- **`client-config.json`**: choose only the Codex and Claude Code settings you want managed, or omit `client-config` scope. Keep credentials out of it.
- **`global/AGENTS.md`**: write your own working rules and check the `global` destinations in `hosts.json`. These instructions can apply across your projects.

The exact commands below come from [personal-skills](skills/orchestration/personal-skills/SKILL.md#sync-the-fleet) and the [fleet README](skills/orchestration/personal-skills/fleet/README.md). Run them beside that skill's `SKILL.md`:

```bash
cd skills/orchestration/personal-skills
python3 scripts/fleet.py resolve
python3 scripts/fleet.py validate
python3 scripts/sync.py --dry-run
# Review the table and agree to the changes before applying:
python3 scripts/sync.py
```

Sync validates and pushes fleet config, then handles skills, plugins, providers, and client settings for opted-in hosts. It verifies published bytes and protects local edits. Resolve `conflict`, `blocked`, or `FAILED` rows instead of forcing past them; a skipped scope is not a successful install. Edit fleet files only on the source host.

## 3. Run the core loop

Create a PM agent in your project and give it an outcome, allowed scope, acceptance checks, and publication limits. For example: "Use opc to implement this change, ask me about decisions, and open a PR without merging." Workers do bounded tasks; the PM reviews, integrates, verifies, and lands only within your authorization, then syncs where required.

Invoke an installed skill by asking the agent to **use its name**. Codex also accepts `$opc`-style mentions; Claude Code uses `/opc` for a user-installed skill (marketplace installs use namespaced commands); Pi uses `/skill:opc`. Substitute the names below:

| Skill | When to use it |
|---|---|
| [`opc`](skills/orchestration/opc/SKILL.md) | "Use opc for this change." The coding team loop: delegate, review, integrate, verify, land, and clean up. State explicitly if it must stop at a PR. |
| [`wo`](skills/orchestration/wo/SKILL.md) | "Use wo" or "what's open?" Lists owner decisions as short numbered questions with recommendations; replies map back in order. `/wo` works in Claude Code and Codex; Pi uses `/skill:wo`. |
| [`repo-lessons`](skills/orchestration/repo-lessons/SKILL.md) | "Use repo-lessons to update project memory." Keeps current state in root `STATUS.html` and durable facts in `LESSONS.md`, so the team can resume without replaying a chat. |
| [`personal-skills`](skills/orchestration/personal-skills/SKILL.md) | "Use personal-skills to sync my fleet." Reviews a dry run, then installs verified packages and opted-in configuration across hosts without overwriting unknown edits. |
| [`handoff`](skills/orchestration/handoff/SKILL.md) / [`reassign-pm`](skills/orchestration/reassign-pm/SKILL.md) | Ask the outgoing PM to "use handoff" to update and commit its memory pair, then ask the replacement to "use reassign-pm" to take over, retain workers, and archive the previous PM after verification. |
| [`unstuck`](skills/orchestration/unstuck/SKILL.md) | "Why isn't this done?" or "scope explosion". A fresh PM on a strong model reviews a stalled project without touching it: numbers, scope timeline, one-line cause, minimal path, and owner decisions with defaults. |

## 4. Add plugins deliberately

Plugins are optional, trusted, unsandboxed daemon code. Read each linked README for settings, version pins, and installation. Use the [personal-skills plugin procedure](skills/orchestration/personal-skills/SKILL.md#paseo-plugins) to stage/install selected plugins; enabling trusted plugins and arming automation are separate owner decisions.

- [`cache-aware-autocompact`](plugins/cache-aware-autocompact/README.md): compacts eligible idle agents around prompt-cache timing; dry-run by default, with Pi GPT compaction off by default.
- [`merged-worker-archiver`](plugins/merged-worker-archiver/README.md): archives clean, idle worker worktree workspaces after their branch is merged; dry-run until armed.
- [`usage-limit-auto-resume`](plugins/usage-limit-auto-resume/README.md): resumes after usage limits and retries eligible provider failures in the same session; sends nothing until armed.
- [`orphan-project-sweeper`](plugins/orphan-project-sweeper/README.md): removes orphaned Paseo project records whose root is gone and no active workspaces remain; dry-run until armed.
- [`workspace-folder-title`](plugins/workspace-folder-title/README.md): names new workspaces after their working folder without replacing caller-supplied titles; active when installed.
- [`pi-fast-toggle`](plugins/pi-fast-toggle/README.md): adds a per-agent Fast pill for eligible Pi models, affecting the next turn; hidden until its private runtime settings are configured.

## 5. Adapt, do not copy

OPC's [routing classes](skills/orchestration/opc/references/routing.md) assume the original owner's models and subscriptions. Edit the classes for your own models before delegating, keeping the implementation in `skills/orchestration/opc/scripts/route.mjs` consistent with the policy. Use exact provider catalog IDs, not guessed names. An unavailable route is a reason to stop, not silently substitute a model.

Keep secrets in a secrets manager and authenticate locally. Never commit credentials, tokens, pairing offers, real fleet configuration, or private paths. The example fleet's names are illustrations, not machines to connect to. Start small, review what the PM and plugins actually do, and expand only after the loop works for you.

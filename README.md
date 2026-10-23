# Loadout

[![CI](https://github.com/Enjoyoer/loadout/actions/workflows/ci.yml/badge.svg)](https://github.com/Enjoyoer/loadout/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Enjoyoer/loadout)](https://github.com/Enjoyoer/loadout/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

New here and want to copy a few skills? Read [START-HERE.md](START-HERE.md) first: one screen on the layers, how the owner works, and the minimum to copy.

Agent skills for Claude Code and Codex, a fleet sync that keeps them identical across machines, and plugins for the [Paseo](https://paseo.sh) agent daemon. Together they run coding agents as a small team: you give a project manager (PM) agent an outcome; it delegates bounded work to workers, reviews their changes, lands approved work, and syncs the fleet. You remain the owner who sets scope and approves decisions.

- **26 skills** for multi-agent orchestration, project memory and handoffs, architecture and domain modeling, docs lookup, PDFs, total-cost shopping research, frontend design, browser automation, and interactive setup wizards.
- **Fleet sync**: one command installs verified skills (every file checked against a SHA256 manifest) on every host over SSH, and never overwrites a local edit.
- **6 Paseo plugins**: four server plugins that resume agents after usage limits, archive merged worker workspaces, compact idle agents to save prompt-cache cost, and clean up orphaned projects, each only logging what it would do until you arm it; plus `workspace-folder-title`, which titles new workspaces with their folder name, and `pi-fast-toggle`, composer Fast shortcuts and a per-agent thinking level menu.

Each skill lives at `skills/<category>/<name>` and installs flat as `<client skills directory>/<name>`. The repository contains no credentials or private host configuration.

## Quickstart

**Claude Code**, in two commands:

```bash
claude plugin marketplace add Enjoyoer/loadout
claude plugin install loadout-engineering@loadout
```

Skills then appear as `/loadout-engineering:codebase-design` and so on. The marketplace groups the skills into six plugins, listed in [Skills](#skills); install any of them.

**Codex, or any client that reads a skills folder:** clone, verify, and copy the packages you want:

```bash
git clone https://github.com/Enjoyoer/loadout && cd loadout
python3 scripts/verify_manifest.py
cp -R skills/planning-writing/grilling "${CODEX_HOME:-$HOME/.codex}/skills/"
```

**Fleet sync, without touching your machine:** `python3 examples/fleet_demo.py` runs a dry run, a sync, a no-op rerun, and a local-edit conflict against two simulated hosts in a temporary folder.

### Supported versions

| Component | Supported |
|---|---|
| Claude Code | Current release with plugin marketplaces |
| Codex | Current release with a `skills` folder |
| Paseo plugins | Paseo `>=0.10.3 <0.12.0`, and `>=0.11.1 <0.12.0` for `pi-fast-toggle` (pinned in each `paseo-plugin.json`) |
| Fleet sync and tests | Python 3 and Node on each host; CI runs Python 3.12 and Node 24 on Ubuntu, macOS and Windows |

## Set up your own agent fleet

### 1. Get the basics working

Install [Paseo](https://paseo.sh) (desktop app and daemon), at least one agent harness (Codex, Claude Code, or Pi), Git, GitHub CLI (`gh`), Python 3, and Node. Authenticate your harness and GitHub CLI yourself. Confirm you can run one agent in Paseo before adding more machines. The bundled OPC worker workflow expects Pi by default; having another harness alone does not configure that workflow.

Clone and verify this repository as in the [Quickstart](#quickstart), and work from the checkout root. Remote file sync needs working SSH aliases and Node on each target host. Start with one machine if that is easier.

### 2. Make a private fleet, then sync

Copy [`fleet/example/`](skills/orchestration/personal-skills/fleet/example/) to your own fleet directory **outside this checkout**. These shell commands are for macOS/Linux, run from the repo root:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/loadout/fleet"
cp -R skills/orchestration/personal-skills/fleet/example/. "${XDG_CONFIG_HOME:-$HOME/.config}/loadout/fleet/"
```

Use a new, empty destination. Windows uses `%APPDATA%\loadout\fleet\`; alternatively set `LOADOUT_FLEET` to your private fleet directory. See [fleet locations and format](skills/orchestration/personal-skills/fleet/README.md).

Edit these copied files before running anything against your machines:

- **`hosts.json`**: replace the made-up `laptop`, `desktop`, `devbox`, and `tablet` entries with your machines, OSes, SSH aliases, installed clients, and paths. Set `source_host` to the machine where you maintain the fleet. Remove unused hosts and choose each host's `sync` scopes. Start without plugin installation until you have read the plugin docs. Remote `ssh` hosts are reached over SSH; `paseo-relay` hosts are reached through their Paseo daemon and get provider sync only.
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

Sync validates and pushes fleet config, then handles skills, global instructions, plugins, provider pickers, and Codex and Claude Code settings for opted-in hosts. It verifies published bytes and protects local edits. Resolve `conflict`, `blocked`, or `FAILED` rows instead of forcing past them; a skipped scope is not a successful install. Edit fleet files only on the source host.

Skills you keep private (personal, account-bound, or holding credentials) go in `skills/<name>/` inside your fleet directory. The same sync installs them next to the published ones, and they are never committed or pushed. After changing a host's `plugin_root`, plugins installed from the old directory report `blocked`; `sync.py --migrate-path` moves them and keeps their settings (see the `personal-skills` skill).

### 3. Run the core loop

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

### 4. Add plugins deliberately

Plugins are optional, trusted, unsandboxed daemon code. Read each plugin's README (linked in [Paseo plugins](#paseo-plugins)) for settings, version pins, and installation. Use the [personal-skills plugin procedure](skills/orchestration/personal-skills/SKILL.md#paseo-plugins) to stage and install selected plugins; enabling trusted plugins and arming automation are separate owner decisions.

### 5. Adapt, do not copy

OPC's [routing classes](skills/orchestration/opc/references/routing.md) assume the original owner's models and subscriptions. Edit the classes for your own models before delegating, keeping the implementation in `skills/orchestration/opc/scripts/route.mjs` consistent with the policy. Use exact provider catalog IDs, not guessed names. An unavailable route is a reason to stop, not silently substitute a model.

Keep secrets in a secrets manager and authenticate locally. Never commit credentials, tokens, pairing offers, real fleet configuration, or private paths. The example fleet's names are illustrations, not machines to connect to. Start small, review what the PM and plugins actually do, and expand only after the loop works for you.

## Skills

All 26 active packages. Install them flat under the target client's `skills` directory, or through the Claude Code plugin that groups them. There are no archived packages in this public repository.

| Category (`skills/<category>`) | Packages | Claude Code plugin |
|---|---|---|
| Engineering (`engineering`) | `codebase-design`, `domain-modeling`, `improve-codebase-architecture`, `uv-python` | `loadout-engineering` |
| Operations and integrations (`operations-integrations`) | `bw-login`, `project-icon`, `recover-mouse-input`, `wizard` | `loadout-ops` |
| Orchestration (`orchestration`) | `dispatching-parallel-agents`, `handoff`, `opc`, `opn`, `reassign-pm`, `repo-lessons`, `unstuck`, `wo` | `loadout-orchestration` |
| Orchestration (`orchestration`) | `personal-skills` | none; install from a clone |
| Planning and writing (`planning-writing`) | `grilling`, `sample` | `loadout-writing` |
| Research and documentation (`research-docs`) | `find-docs`, `liteparse`, `tco-search` | `loadout-research` |
| Web and browser (`web-browser`) | `browse-x`, `frontend-design`, `pake`, `playwright` | `loadout-web` |

Some packages need an external CLI, connected service, or local credential. Read each `SKILL.md` before using it. Personal, account-bound, or credential-bearing skills are not published here; keep them in your private skill overlay (see [step 2](#2-make-a-private-fleet-then-sync)).

## Verified install

For a verified install that protects local edits, clone this repository to a local filesystem, then verify its committed publication:

```bash
python3 scripts/verify_manifest.py
```

Choose the packages you want and follow the `personal-skills` skill or the manifest-based install instructions below. Codex uses `${CODEX_HOME:-$HOME/.codex}/skills/<name>` on Unix and `%USERPROFILE%\.codex\skills\<name>` on Windows. Claude Code uses `~/.claude/skills/<name>` on Unix and `%USERPROFILE%\.claude\skills\<name>` on Windows. Install only into clients present on the host. This repository does not install global agent instructions, provider settings, or credentials.

For a manual install, resolve the `source_commit` in `MANIFEST.json`, verify each selected committed blob's byte count and SHA256, then copy it to the flat destination after checking for local edits and symlink or junction ancestors. `skills/orchestration/personal-skills/SKILL.md` describes the full preflight. A changed installed file that matches no verified prior publication is a conflict; leave it untouched.

A package may read an optional private `references/local.md` for host-specific settings, and `personal-skills` reads your private fleet from `$LOADOUT_FLEET` or the fleet directory from [step 2](#2-make-a-private-fleet-then-sync). Both are ignored by Git, absent from the manifest, and never published. The `sample` package learns style from examples supplied by the user; this public version contains no personal voice profile.

## Paseo plugins

`plugins/<id>` holds [Paseo](https://paseo.sh) plugins. Five are server-only; `pi-fast-toggle` also adds composer controls in the client. Each is trusted, unsandboxed code that runs inside a daemon, so read its README before installing it.

| Plugin | Does | Default on a fresh install |
|---|---|---|
| [`cache-aware-autocompact`](plugins/cache-aware-autocompact/README.md) | Sends `/compact` to idle Claude, Codex and Pi agents before their prompt cache expires; by default it also compacts cold Claude-family agents above the context threshold (Pi GPT models are off by default) | Dry-run until `armed` |
| [`merged-worker-archiver`](plugins/merged-worker-archiver/README.md) | Archives clean, idle worker worktree workspaces whose branch is merged into its base | Dry-run until `armed` |
| [`usage-limit-auto-resume`](plugins/usage-limit-auto-resume/README.md) | Resumes an agent after a usage limit or a transient provider error, in the same session | Dry-run until `armed` |
| [`orphan-project-sweeper`](plugins/orphan-project-sweeper/README.md) | Deletes Paseo project rows with no active workspace and a missing root path | Dry-run until `armed` |
| [`workspace-folder-title`](plugins/workspace-folder-title/README.md) | Titles new workspaces with their folder name instead of a bare git branch name, without replacing caller-supplied titles | Active when installed |
| [`pi-fast-toggle`](plugins/pi-fast-toggle/README.md) | Composer Fast shortcuts and per-agent thinking level menu (Paseo `>=0.11.1 <0.12.0`): Ctrl/Cmd+Shift+F toggles Fast for tier-capable Pi agents and Ctrl/Cmd+Shift+M opens the thinking level menu | Fast inactive until its `routing.json` setting exists |

`plugins/_shared` is not a plugin. It holds the canonical source of code that several plugins vendor into their own folders, such as the fail-closed daemon endpoint resolver and the atomic JSON state writer; see [CONTRIBUTING.md](.github/CONTRIBUTING.md).

Every plugin pins a Paseo version range in `paseo-plugin.json`. To install one manually, run `npm ci` and `npm run check` (or `npm run typecheck`) in its folder, confirm the daemon's `pluginsEnabled` is `true`, then run `paseo plugin install "$PWD"`. `personal-skills` stages and installs plugins across a fleet; see its `Paseo plugins` section. Plugin settings stay host-local and are never part of this repository.

`personal-skills` can also sync pinned Paseo provider-picker rows (model lists and router environment) to fleet hosts that opt in with the `providers` scope, from a private `paseo-providers.json` in your fleet directory. See its `Paseo provider pickers` section and `fleet/example/paseo-providers.json`. It can likewise sync managed Codex and Claude Code settings to hosts in the `client-config` scope; see `fleet/example/client-config.json`.

## Tests

```bash
python3 -m unittest discover -s tests
```

CI runs these on Ubuntu, macOS, and Windows for every pull request, together with manifest verification, the `opc` package validator, and each plugin's `npm run check` (or `typecheck`) on Ubuntu and Windows.

## Publication integrity

`MANIFEST.json` records committed Git-blob sizes and SHA256 values for every active skill and plugin file, and each plugin's Paseo version pin. Commit package content first, run `python3 scripts/generate_manifest.py`, then commit the manifest separately. `scripts/verify_manifest.py` checks the complete committed tree. The working tree, generated files, local secrets, and another repository's history are not publication sources.

## Contributing and support

Issues and pull requests are welcome, and every new one is triaged within 7 days. See [CONTRIBUTING.md](.github/CONTRIBUTING.md), report security problems privately as described in [SECURITY.md](.github/SECURITY.md), and follow the [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## License

Original material is licensed under [MIT](LICENSE). `frontend-design` and `playwright` retain their bundled Apache-2.0 licenses; `playwright` also retains its upstream notice. `codebase-design`, `domain-modeling`, `improve-codebase-architecture`, `grilling`, and `wizard` are adapted from Matt Pocock's MIT-licensed skills, and `find-docs` from Context7's MIT-licensed skill; each carries its upstream `LICENSE.txt`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). These package-level terms take precedence for those files.

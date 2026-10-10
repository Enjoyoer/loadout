# Loadout

[![CI](https://github.com/Enjoyoer/loadout/actions/workflows/ci.yml/badge.svg)](https://github.com/Enjoyoer/loadout/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Enjoyoer/loadout)](https://github.com/Enjoyoer/loadout/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Agent skills for Claude Code and Codex, a fleet sync that keeps them identical across machines, and plugins for the [Paseo](https://paseo.sh) agent daemon.

- **22 skills** for multi-agent orchestration, project memory and handoffs, architecture and domain modeling, docs lookup, PDFs, frontend design, and browser automation.
- **Fleet sync**: one command installs verified skills (every file checked against a SHA256 manifest) on every host over SSH, and never overwrites a local edit.
- **6 Paseo plugins**: five server plugins that resume agents after usage limits, archive merged worker workspaces, compact idle agents to save prompt-cache cost, clean up orphaned projects, and keep PM workers on Pi, each only logging what it would do until you arm it; plus `pi-fast-toggle`, a per-agent Fast pill for Pi agents.

Each skill lives at `skills/<category>/<name>` and installs flat as `<client skills directory>/<name>`. The repository contains no credentials or private host configuration.

## Quickstart

**Claude Code**, in two commands:

```bash
claude plugin marketplace add Enjoyoer/loadout
claude plugin install loadout-engineering@loadout
```

Skills then appear as `/loadout-engineering:codebase-design` and so on. The marketplace groups the skills into six plugins; install any of them:

| Plugin | Skills |
|---|---|
| `loadout-engineering` | `codebase-design`, `domain-modeling`, `improve-codebase-architecture`, `uv-python` |
| `loadout-orchestration` | `opc`, `opn`, `dispatching-parallel-agents`, `claude-cloud`, `handoff`, `repo-lessons`, `reassign-pm` |
| `loadout-writing` | `grilling`, `sample` |
| `loadout-research` | `find-docs`, `liteparse` |
| `loadout-web` | `frontend-design`, `playwright`, `browse-x`, `pake` |
| `loadout-ops` | `wizard`, `recover-mouse-input` |

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
| Paseo plugins | Paseo `>=0.10.3 <0.12.0` (pinned in each `paseo-plugin.json`) |
| Fleet sync and tests | Python 3 and Node on each host; CI runs Python 3.12 and Node 24 on Ubuntu, macOS and Windows |

## Verified install

For a verified install that protects local edits, clone this repository to a local filesystem, then verify its committed publication:

```bash
python3 scripts/verify_manifest.py
```

Choose the packages you want and follow the `personal-skills` skill or the manifest-based install instructions below. Codex uses `${CODEX_HOME:-$HOME/.codex}/skills/<name>` on Unix and `%USERPROFILE%\.codex\skills\<name>` on Windows. Claude Code uses `~/.claude/skills/<name>` on Unix and `%USERPROFILE%\.claude\skills\<name>` on Windows. Install only into clients present on the host. This repository does not install global agent instructions, provider settings, or credentials.

For a manual install, resolve the `source_commit` in `MANIFEST.json`, verify each selected committed blob's byte count and SHA256, then copy it to the flat destination after checking for local edits and symlink or junction ancestors. `skills/orchestration/personal-skills/SKILL.md` describes the full preflight. A changed installed file that matches no verified prior publication is a conflict; leave it untouched.

Some packages need an external CLI, connected service, or local credential. Read each `SKILL.md` before using it. A package may read an optional private `references/local.md` for host-specific settings, and `personal-skills` reads your private fleet from `$LOADOUT_FLEET` or `~/.config/loadout/fleet/` (see `skills/orchestration/personal-skills/fleet/README.md`). Both are ignored by Git, absent from the manifest, and never published. The `sample` package learns style from examples supplied by the user; this public version contains no personal voice profile.

## Packages

See [SKILLS_CATALOG.md](SKILLS_CATALOG.md) for all 22 active packages. There are no archived packages in this public repository.

## Sync a fleet

`personal-skills` syncs skills, global instructions, Paseo plugins, Paseo provider pickers, and Codex and Claude Code settings to every host in a private fleet with one command:

```bash
python3 skills/orchestration/personal-skills/scripts/sync.py --dry-run   # review the table first
python3 skills/orchestration/personal-skills/scripts/sync.py
```

Describe your hosts first: copy `skills/orchestration/personal-skills/fleet/example/` to `~/.config/loadout/fleet/` and edit it (see its `fleet/README.md`). Each host's `sync` list decides which steps it gets. Hosts need `node`. Remote `ssh` hosts are reached over SSH; `paseo-relay` hosts are reached through their Paseo daemon and get provider sync only.

Skills you keep private (personal, account-bound, or holding credentials) go in `skills/<name>/` inside your fleet directory. The same sync installs them next to the published ones, and they are never committed or pushed.

After changing a host's `plugin_root`, plugins installed from the old directory report `blocked`; `sync.py --migrate-path` moves them and keeps their settings (see the `personal-skills` skill).

## Paseo plugins

`plugins/<id>` holds [Paseo](https://paseo.sh) plugins. Five are server-only; `pi-fast-toggle` also adds a composer pill in the client. Each is trusted, unsandboxed code that runs inside a daemon, so read its README before installing it.

| Plugin | Does | Default on a fresh install |
|---|---|---|
| `cache-aware-autocompact` | Sends `/compact` to idle Claude, Codex and Pi agents before their prompt cache expires; by default it also compacts cold Claude-family agents above the context threshold (Pi GPT models are off by default) | Dry-run until `armed` |
| `merged-worker-archiver` | Archives worker worktree workspaces whose branch is merged into its base | Dry-run until `armed` |
| `usage-limit-auto-resume` | Resumes an agent after a usage limit or a transient provider error | Dry-run until `armed` |
| `orphan-project-sweeper` | Deletes Paseo project rows with no active workspace and a missing root path | Dry-run until `armed` |
| `pm-native-worker-guard` | Stops and archives native Codex or Claude Code agents created by a PM, so PM workers run on Pi | Dry-run until `armed` |
| `pi-fast-toggle` | Adds a per-agent Fast pill to Pi agents on tier-capable models; pressing it sets the agent's service-tier label for the next turn | Inactive until its `routing.json` setting exists |

`plugins/_shared` is not a plugin. It holds the canonical source of code that several plugins vendor into their own folders, such as the fail-closed daemon endpoint resolver; see [CONTRIBUTING.md](CONTRIBUTING.md).

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

Issues and pull requests are welcome, and every new one is triaged within 7 days. See [CONTRIBUTING.md](CONTRIBUTING.md), report security problems privately as described in [SECURITY.md](SECURITY.md), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Original material is licensed under [MIT](LICENSE). `frontend-design` and `playwright` retain their bundled Apache-2.0 licenses; `playwright` also retains its upstream notice. `codebase-design`, `domain-modeling`, `improve-codebase-architecture`, `grilling`, and `wizard` are adapted from Matt Pocock's MIT-licensed skills, and `find-docs` from Context7's MIT-licensed skill; each carries its upstream `LICENSE.txt`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). These package-level terms take precedence for those files.

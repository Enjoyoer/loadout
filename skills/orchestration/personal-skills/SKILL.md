---
name: personal-skills
description: Sync selected skill packages, Paseo plugins, and optional Paseo provider pickers and client settings from this repository to local Codex, Claude Code, and Paseo daemon installations across a fleet, with committed-blob verification and local-edit protection.
---

# Personal skills

Use the repository root `README.md` for the current manifest format, installation destinations, and validation steps. The user chooses the packages. Target hosts come from the user's private fleet directory (see Fleet); without one, sync only the current host.

## Sync the fleet

To sync the fleet, run `python3 scripts/sync.py --dry-run` beside this `SKILL.md`, show the user its table, then run `python3 scripts/sync.py` once they agree. That is the only sync path.

- It runs, in order: fleet validate, fleet push, skills, plugins, providers, client-config. Each host takes only the scopes in its `sync` list.
- It ends with one table of host by scope: `same`, `updated`, `would update`, `conflict`, `blocked`, `drift`, `skipped`, `stopped`, `not needed`, `source`, or `FAILED`.
- A conflict, or a fleet push failure, stops the later scopes for that host only. Report those hosts and their files; never force past a conflict.
- `--host <name>` narrows it to one host, and `--only fleet,skills,...` to some steps. `--update-claude` lets client-config run `claude update` below `minVersion`.
- Exit status is 0 only when no host is `conflict`, `blocked`, or `FAILED`.
- The sections below define what each step does. The per-step scripts (`fleet.py`, `skills_sync.py`, `plugins_sync.py`, `paseo_providers.py`, `client_config.py`) are its building blocks, for diagnosing one step.

## Source and selection

- Resolve an ordinary local Git checkout of this repository. Read `MANIFEST.json` from one immutable commit and its `source_commit` once. Require the documented schema (`schema_version: 2`) and `hash_basis: git-blob`.
- Select package names from the manifest. Source files live at `skills/<category>/<skill-name>/<file>` and install flat at `<client-home>/skills/<skill-name>/<file>`.
- Read every selected file from the recorded `source_commit` with `git cat-file blob`. Verify the manifest byte count and SHA256 before considering a destination.

## Destinations

- Codex: `${CODEX_HOME:-$HOME/.codex}/skills/<skill-name>`.
- Claude Code: `~/.claude/skills/<skill-name>`.
- Resolve home directories and path syntax on the target host. A client is present when its binary or skills root exists; skip and report an absent client.
- Skill sync installs skill packages. It installs global instructions only from the user's fleet description, and never installs credentials, model settings, or other agent-client configuration.

## Fleet

- Resolve the fleet directory with `python3 scripts/fleet.py resolve` beside this `SKILL.md`, or by the same rule by hand: `$LOADOUT_FLEET` (must be a directory), else `${XDG_CONFIG_HOME:-~/.config}/loadout/fleet/` (`%APPDATA%\loadout\fleet\` on Windows), else the legacy `fleet/local/` beside this `SKILL.md`. Start the sync report with the source used, as the script prints it.
- The fleet directory is the user's private fleet: never commit, publish, or quote it into a public file. It is not a package file, so sync never overwrites or removes it, and never replaces a symlinked `fleet/local/` on a host that already has one.
- `fleet/README.md` defines the format and `fleet/example/` shows a made-up fleet. A user starts by copying `fleet/example/` to the fleet directory and editing it. Never treat the example as a real target.
- Without a fleet directory, the fleet is the current host only, with no global instructions.
- An invalid fleet stops the whole run. Skill sync covers hosts whose `sync` includes `skills`, and plugin sync hosts whose `sync` includes `plugins`; report every other host as skipped for that scope, not failed. `paseo-relay` hosts have no file transport and never receive files.
- Sync every eligible host by default unless the user narrows it. Each host resolves its own paths and shell, syncs the clients present, and reports absent clients as skipped.
- Report each host separately. A blocker stops only that host. Report an unreachable host as an outstanding gap; never report a host as synced until it is verified, and never drop an unreached host from the report.
- Edit the fleet only on the source host. Every sync run starts with the fleet push (`scripts/fleet.py push`, after `validate`), which carries the source fleet directory over SSH to the config fleet directory of every other `ssh` host, verifies each file by SHA256, and replaces a host's copy only when it still matches the last synced version recorded in its `.loadout-sync.json`. Report fleet status per host: `same`, `updated`, `conflict`, or `FAILED`. A conflict is a hand edit on that host: nothing is written there; stop that host's sync and report the files. `paseo-relay` hosts do not need the fleet. Never send the fleet to Git or a public service.

## Paseo plugins

Plugins live at `plugins/<id>/` and are listed in the manifest's `plugins` and `plugin_files`. They are trusted, unsandboxed code that runs inside a daemon, so each host goes through three separate steps, and each needs its own authorization in the host's `paseo` entry or from the user:

1. **Stage source.** For each ID in `stage`, verify every manifest blob, then apply the local-edit preflight to `<plugin_root>/<id>/`. Carry verified bytes over the fleet transport, reverify them on the host, and write them. Run `npm ci` and the package's `check` script (or `typecheck` when it has no `check`) on the host. A failure stops that plugin on that host. Leave `node_modules` out of the preflight and the hash comparison.
2. **Install on the daemon.** Only for IDs in `install`. Read the running daemon's version with `paseo daemon status --json` (`daemonVersion`) on the host, not the CLI version, and require it to satisfy the plugin's `paseo` pin from the manifest; a daemon outside the pin is a blocker, not a reason to edit the pin. Raise a pin only in a published package change after live verification against the new Paseo version. Read the root `pluginsEnabled` in the daemon's `<PASEO_HOME>/config.json`; missing means `false`. If it is not `true`, stop and follow the `paseo-plugin` skill: the user must explicitly allow trusted plugins on that daemon before anything is enabled. Otherwise run `paseo plugin install <plugin_root>/<id>` on the host, or `paseo plugin reload <id>` when it is already installed from that directory.
3. **Confirm.** Require `paseo plugin ls` on the host to report the plugin `running` and enabled, and read `paseo plugin logs <id>` for load errors.

The plugins step (`scripts/plugins_sync.py`) implements these steps. It checks npm only when staged source changed or `node_modules` is missing. It reports `blocked` when a daemon gate fails, and `drift` for a `plugin_root: null` host whose installed source differs.

Never write plugin settings, plugin state, or `pluginsEnabled` as part of a sync, and never arm a plugin. A plugin with an `armed` setting starts in dry-run when its settings file is absent; a plugin without one acts as soon as it runs, so read its README before listing it in `install`. Preserve every existing settings file. A host with `plugin_root: null` manages its plugins elsewhere: report whether its installed source matches the manifest and change nothing. Report staged, installed, running, blocked, and unreachable plugins per host.

## Paseo provider pickers

For hosts whose `sync` includes `providers`, the providers step (`scripts/paseo_providers.py`) merges the pinned provider rows in `<fleet>/paseo-providers.json` into `~/.paseo/config.json` on each host whose `sync` includes `providers`, then reloads that daemon. It keeps every other provider and host-local field, backs the file up in place as `config.json.bak-loadout-<stamp>`, and checks that the picker labels read back exactly as pinned.

- The source host runs locally. `ssh` hosts run the merge over SSH and reload over SSH, or over their `paseo_offer` when set. `paseo-relay` hosts run it in a temporary Paseo workspace terminal (allow up to two minutes) and reload over the relay. A new relay terminal drops input sent before its shell is up, so the step waits for a prompt, then a one-second settle, then sends once. Every exit path, including timeouts, failed creates, and SIGTERM, archives all `loadout-provider-sync` workspaces on the host and confirms none remain; leftovers from a killed run are swept before starting. Paseo agent variables (`PASEO_HOME`, `PASEO_AGENT_ID`, `PASEO_AGENT_CWD`) are removed from relay calls.
- The merge program travels gzip and base64 encoded so it survives `cmd.exe` and terminal quoting. Hosts need `node`; relay hosts need a POSIX shell.
- Each host reports the write and the reload on separate lines. A relay reload can time out after a successful write; report that as a reload failure, not a failed write, and do not undo the write.
- Never put the catalog, router URLs, or offers in this repository.

## Client config

For hosts whose `sync` includes `client-config`, the client-config step (`scripts/client_config.py`) writes only the managed Codex `config.toml` and Claude Code `settings.json` keys from `<fleet>/client-config.json`, backing up each changed file first. The source host runs locally and other hosts over SSH. A secret from `token_file` travels only on SSH stdin and is never printed. Report each client per host, the host-local `reportOnly` values, and the Claude Code version against `minVersion`.

## Local-edit protection

The skills step (`scripts/skills_sync.py`) implements this for skills and global instructions. It reads blobs from `source_commit`, treats every version in the committed `MANIFEST.json` history as a verified prior publication, and records the global-instruction hashes it installed in each host's `loadout/global-sync.json`, under the config directory from Fleet. It skips each host's `exclude_skills`.

Preflight every selected destination before writing any file on that host. Reject escaping or duplicate paths, symlink or junction ancestors, unexpected file types, and hash mismatches. An existing file may be replaced only if it matches a verified prior publication of the same source path or the desired blob. Preserve unknown local edits and stop the host without a partial package update. Leave unselected files untouched.

After a successful preflight, write verified bytes, verify every installed hash, and run the available package validators. Report selected packages, commit IDs, destinations, files written, files already current, skipped clients, and blockers. A host without its own checkout may receive verified bytes from another eligible checkout, but must reverify them before the same preflight and write.

## Publishing a package change

This covers skills and plugins. Commit package content first. Generate the manifest from that committed tree with `source_commit` equal to the content commit, then commit the manifest separately. Verify that the complete active `skills/` and `plugins/` trees match manifest paths, byte counts, and SHA256 values. Review the diff before publishing. The public repository has its own clean history; do not import another repository's history or machine-local state.

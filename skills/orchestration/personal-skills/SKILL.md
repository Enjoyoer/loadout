---
name: personal-skills
description: Sync selected skill packages, Paseo plugins, and optional Paseo provider pickers and client settings from this repository to local Codex, Claude Code, and Paseo daemon installations across a fleet, with committed-blob verification and local-edit protection.
---

# Personal skills

Use the repository root `README.md` for the current manifest format, installation destinations, and validation steps. The user chooses the packages. Target hosts come from the user's private fleet directory (see Fleet). Without one nothing syncs; to sync only the current host, create a one-host fleet.

## Sync the fleet

To sync the fleet, run `python3 scripts/sync.py --dry-run` beside this `SKILL.md`, show the user its table, then run `python3 scripts/sync.py` once they agree. That is the only sync path.

- It runs, in order: fleet validate, fleet push, skills, plugins, providers, client-config. Each host takes only the scopes in its `sync` list.
- It ends with one table of host by scope: `same`, `updated`, `would update`, `conflict`, `blocked`, `skipped`, `stopped`, `source`, or `FAILED`.
- A conflict, or a fleet push failure, stops the later scopes for that host only. Report those hosts and their files; never force past a conflict.
- Any other error, or a host that stops answering (SSH keepalives, then a per-step time limit: 3 minutes for the fleet push, 5 for skills, providers, and client-config, 15 for client-config with `--update-claude`, 20 for plugins), is `FAILED` for that host and step; the next host still runs. An error that is not a fleet error also prints its traceback. Each step's shared setup (publication, overlay, catalog, token) runs once, and an error there is one failure report for that shared setup that fails the step for every host and stops their later scopes.
- `--host <name>` narrows it to one host, and `--only fleet,skills,...` to some steps. `--update-claude` lets client-config run `claude update` below `minVersion`.
- Exit status is 0 only when no host is `conflict`, `blocked`, or `FAILED`.
- The per-step scripts (`fleet.py`, `skills_sync.py`, `plugins_sync.py`, `paseo_providers.py`, `client_config.py`) are its building blocks, for diagnosing one step.

## Source and selection

- Resolve an ordinary local Git checkout of this repository. Read `MANIFEST.json` from one immutable commit and its `source_commit` once. Require the documented schema (`schema_version: 2`) and `hash_basis: git-blob`.
- Select package names from the manifest. Source files live at `skills/<category>/<skill-name>/<file>` and install flat at `<client-home>/skills/<skill-name>/<file>`.
- Private skills come from the fleet directory's `skills/<skill-name>/` overlay (see [Private skills](fleet/README.md#private-skills)). They are selected and installed like published packages, never committed, and a name clash with a published package stops the run.
- Read every selected file from the recorded `source_commit` with `git cat-file blob`. Verify the manifest byte count and SHA256 before considering a destination.

## Destinations

- Codex: `${CODEX_HOME:-$HOME/.codex}/skills/<skill-name>`.
- Claude Code: `~/.claude/skills/<skill-name>`.
- Configured official Loadout Pi: `<runtime-root>/agent/skills/<skill-name>`, discovered from the host provider command. It receives the same verified blobs and global instructions as the other clients, with the same conflict protection. Generated settings point to this directory; per-agent homes copy the synced AGENTS.md.
- Packages may ship `slash/<name>.md` (a lowercase, hyphenated command name). Sync installs these flat at `${CODEX_HOME:-$HOME/.codex}/prompts/<name>.md` and `<runtime-root>/agent/prompts/<name>.md`, on every OS, with the same preflight, local-edit protection, pending records and retirement as skills. Prompt names must be unique across selected packages. Codex invokes them as `/prompts:<name>` (custom prompts are deprecated); Pi as `/<name>`, after `/reload` in an active session. Claude Code already invokes user skills as `/<skill-name>`, so it gets no duplicate command file.
- `wo` uses the skill as its only slash entry: Claude Code and Codex `/wo`, Pi `/skill:wo`. It ships no separate prompt file.
- Resolve home directories and path syntax on the target host. A client is present when its binary or skills root exists; skip and report an absent client.
- The skills step also installs private fleet `bin/common/` and the host-OS folder flat into the user's `.local/bin` (see [Helpers in `bin/`](fleet/README.md#helpers-in-bin)), with the same protection as global instructions.
- Skill sync installs global instructions only from the user's fleet description, and never installs credentials, model settings, or other agent-client configuration.

## Fleet

- Resolve the fleet directory with `python3 scripts/fleet.py resolve` beside this `SKILL.md` (rule: [Where the fleet lives](fleet/README.md#where-the-fleet-lives); `$LOADOUT_FLEET`, else `${XDG_CONFIG_HOME:-~/.config}/loadout/fleet/`, `%APPDATA%\loadout\fleet\` on Windows). Start the sync report with the source used, as the script prints it. Without one it reports `fleet: none (current host only)` and nothing syncs.
- The fleet directory is the user's private fleet: never commit, publish, or quote it into a public file, and never send it to Git or a public service. Sync never overwrites or removes it.
- `fleet/README.md` defines the format and `fleet/example/` shows a made-up fleet to copy and edit. Never treat the example as a real target.
- An invalid fleet stops the whole run. Hosts outside a step's scope are reported as skipped for it, not failed.
- Sync every eligible host by default unless the user narrows it. Each host resolves its own paths and shell, syncs the clients present, and reports absent clients as skipped.
- Report each host separately. A blocker stops only that host. Report an unreachable host as an outstanding gap; never report a host as synced until it is verified, and never drop an unreached host from the report.
- Edit the fleet only on the source host. Every run starts with the [fleet push](fleet/README.md#fleet-push), which reports `same`, `updated`, `conflict`, or `FAILED` per host. A conflict is a hand edit on that host: nothing is written there; stop that host's sync and report the files. Token files, pairing offers, backups, and every other unpublished file stay on the source host; a token reaches only the hosts that name it, through the client-config step.
- The fleet push, skills, plugins, and client-config steps each run one Node program per host. The program and its payload travel together on SSH stdin as one envelope; the command line holds only a short fixed boot and the envelope's SHA256, and nothing runs unless the envelope matches it. So the command stays below the 8,191-character `cmd.exe` limit, and secrets never reach a command line. Each program first clears the inherited `PASEO_HOST`, `PASEO_HOME`, `PASEO_AGENT_ID`, and `PASEO_AGENT_CWD`, then sets `PASEO_HOME` to the host's `paseo_home` from `hosts.json` when there is one, so every config read, daemon gate, install, reload, and confirmation addresses that home (or the default `~/.paseo`) and its daemon.

## Paseo plugins

Plugins live at `plugins/<id>/` and are listed in the manifest's `plugins` and `plugin_files`. They are trusted, unsandboxed code that runs inside a daemon, so each host goes through three separate steps, and each needs its own authorization in the host's `paseo` entry or from the user:

1. **Stage source.** For each ID in `stage`, verify every manifest blob, then apply the local-edit preflight to `<plugin_root>/<id>/`. Carry verified bytes over the fleet transport, reverify them on the host, and write them. Run `npm ci` and the package's `check` script (or `typecheck` when it has no `check`) on the host. A failure stops that plugin on that host. Leave `node_modules` out of the preflight and the hash comparison.
2. **Install on the daemon.** Only for IDs in `install`. Read the running daemon's version with `paseo daemon status --json` (`daemonVersion`) on the host, not the CLI version, and require it to satisfy the plugin's `paseo` pin from the manifest; a daemon outside the pin is a blocker, not a reason to edit the pin. Raise a pin only in a published package change after live verification against the new Paseo version. Read the root `pluginsEnabled` in the daemon's `<PASEO_HOME>/config.json`; missing means `false`. If it is not `true`, stop and follow the `paseo-plugin` skill: the user must explicitly allow trusted plugins on that daemon before anything is enabled. Otherwise run `paseo plugin install <plugin_root>/<id>` on the host, or `paseo plugin reload <id>` when it is already installed from that directory.
3. **Confirm.** Require `paseo plugin ls` on the host to report the plugin `running` and enabled, and read `paseo plugin logs <id>` for load errors.

The plugins step (`scripts/plugins_sync.py`) implements these steps. Per staged directory, the host's `loadout/plugins-sync.json` (in the config directory from Fleet) records the source last checked with its result, and separately the source the daemon was last confirmed running.

- It skips `npm ci` and the check only when staged source is unchanged, `node_modules` exists, and a passed check is recorded for that source.
- A passed check is not an activation: an installed plugin is reloaded unless the record shows the daemon confirmed running this exact source. Before it installs or reloads, the step records the reload as owed and clears that only once the plugin is confirmed running, so a failed reload, a daemon gate, or a lost connection leaves it owed for the next run, reported as `reloaded (reload owed: <why>)`. A host with no activation recorded reloads each installed plugin once, since `paseo plugin ls` does not show which source a daemon loaded.
- A file an earlier publication had and the current one does not is deleted from `<plugin_root>/<id>/` only while it still matches a published version; an edited copy is a conflict. The daemon checks run between the preflight and the writes, so each staged write and removal checks its file again right before it (a removal first moves the file aside and verifies it), and a file edited meanwhile is kept and fails the host. Files never published there, such as `node_modules`, are left alone.
- `--dry-run` shows the checks that would run again and the files that would be removed. It reports `blocked` when a daemon gate fails or a plugin is installed from another directory.

Never write plugin settings, plugin state, or `pluginsEnabled` as part of a sync, and never arm a plugin. A plugin with an `armed` setting starts in dry-run when its settings file is absent; a plugin without one acts as soon as it runs, so read its README before listing it in `install`. Preserve every existing settings file. Report staged, installed, running, blocked, and unreachable plugins per host.

A plugin installed from another directory (for example after changing `plugin_root`) is reported `blocked: installed from <path>`. Move it by hand: `paseo plugin remove` deletes `<PASEO_HOME>/plugin-settings/<id>`, which holds the plugin's arming, so back up that settings directory, remove the plugin, sync, restore the settings, then run `paseo plugin reload <id>`.

## Paseo provider pickers

For hosts whose `sync` includes `providers`, the providers step (`scripts/paseo_providers.py`) merges the pinned provider rows in `<fleet>/paseo-providers.json` into `<PASEO_HOME>/config.json` (default `~/.paseo/config.json`), then reloads that daemon. It keeps every other provider and host-local field, backs the file up in place as `config.json.bak-loadout-<stamp>-<random>` (a new file each time; see [Backup retention](fleet/README.md#backup-retention)), and checks that the picker labels read back exactly as pinned. It replaces the file only while it still holds the revision the merge read: a concurrent change (the daemon, an editor) is read again and merged, never overwritten, and the backup holds the revision actually replaced; a file that keeps changing is left alone and the host fails. The config, the merged rows, and `required_env` are all checked before anything on the host changes, including the Pi runtime. Optional `launch` settings route only Paseo-launched Claude Code and Codex (see [paseo-providers.json](fleet/README.md#paseo-providersjson)).

- The source host runs locally. `ssh` hosts run the merge and reload over SSH, or reload over their `paseo_offer` when set. Inherited Paseo variables (`PASEO_HOST`, `PASEO_HOME`, `PASEO_AGENT_ID`, `PASEO_AGENT_CWD`) are removed from every call, so a host's write and reload address its own daemon at its `paseo_home` (or the default home); an offer reload adds only that host's own offer as `PASEO_HOST`.
- The merge program travels gzip and base64 encoded in a SHA256-verified envelope on stdin. Hosts need `node`. A dry run does not change configuration or reload.
- Each host reports the write and the reload on separate lines. A reload can time out after a successful write; report that as a reload failure, not a failed write, and do not undo the write.
- **Owed reloads.** A write that may have changed the config or a Pi runtime file (including one whose result never came back, or a Pi runtime configuration that failed partway) leaves a reload owed, recorded on the source host in `loadout/provider-reloads.json` beside the config fleet directory, per host, as the id of every operation that may owe one. The host owes a reload while it has any id.
  - One provider operation runs per host at a time: a run adds its id, marked running, before writing, and keeps it running until its final update after the reload decision; a run that finds an id still running on that host writes nothing and fails that host (`another provider sync is in flight`). An id still marked running a day later was left by a killed run and counts as ended.
  - The final update removes the run's id after a successful reload or a write that changed nothing, and otherwise keeps it marked ended with the time; a write whose result never came back may still land, so its id is kept as uncertain with the time it failed.
  - A successful reload also clears the other debts whose write ended before it started: an uncertain one only when the reload started more than twice the write timeout (10 minutes) after it failed, never a running one or one that ended after the reload started.
  - Each record change is a short transaction, never held across a write or reload, under an OS lock (`flock` on POSIX, `msvcrt.locking` on Windows) on `provider-reloads.json.lock`, which is never deleted and is released by the OS when its holder exits; a run waits up to 15 seconds for it. Any record error, a lock timeout or a failed release included, fails that host only, saying whether the write and the reload ran and that a reload may still be owed.
  - The next run retries an owed reload even when the config is unchanged, reported as `reload (owed since <stamp>)`; a retry that fails again is `FAILED`, and `--dry-run` shows it as `would update`. With an unchanged write and no reload owed (the record, read at that moment, holding no id but the run's own), a reload failure is only a warning and the host stays `same`.
- Never put the catalog, router URLs, or offers in this repository.

Pi providers use the same fleet rows, generated during this step; see [Pi surface on stock Paseo](fleet/README.md#pi-surface-on-stock-paseo). Install the pinned package with the reviewed host-specific apply script before syncing its runtime. The generated runtime ships `fleet-routing.mjs` with `service-guard.mjs`, a backstop (not a sandbox) against a Pi shell call that stops a shared fleet service; see the `guard` key in `fleet/README.md`. A provider model default does not select a provider in every UI client; each client selects Pi in its picker.

## Client config

For hosts whose `sync` includes `client-config`, the client-config step (`scripts/client_config.py`) writes only the managed Codex `config.toml` and Claude Code `settings.json` keys from `<fleet>/client-config.json`, and removes only the keys listed in `removeTop` and `removeEnv` (on a host with the `providers` scope, only once that host's current provider settings are written and reloaded; until then the host reports `held`). Each changed file is backed up under a new name and replaced only while it still holds the revision the merge read (see [client-config.json](fleet/README.md#client-configjson)). A Codex file with a construct that could define, shadow, or duplicate a managed key path is refused with nothing written as `unsupported TOML, edit by hand`. The source host runs locally and other hosts over SSH. A secret from `token_file` travels only on SSH stdin and is never printed. Report each client per host, the host-local `reportOnly` values, and the Claude Code version against `minVersion`.

`client-config.json` may also declare Streamable HTTP `mcpServers` (see [Fleet MCP servers](fleet/README.md#fleet-mcp-servers)); every listed host needs both the `client-config` and `providers` scopes, and the providers step must install the launcher first. No MCP token value is put in any configuration, and during a rollout sync twice (providers, client-config, providers). Always dry-run both `providers` and `client-config` before an approved rollout.

## Local-edit protection

The skills step (`scripts/skills_sync.py`) implements this for skills and global instructions.

- It reads blobs from `source_commit`, treats every version in the committed `MANIFEST.json` history as a verified prior publication, and records the global-instruction hashes it installed in each host's `loadout/global-sync.json`, under the config directory from Fleet. It skips each host's `exclude_skills`.
- Overlay files use the hashes recorded in the overlay's `.loadout-overlay.json`, plus the published history of the same install path, as their verified prior versions. A hash is recorded there only after a host with a present client accepts it, as one transaction under an OS lock on `.loadout-overlay.json.lock` (waiting up to 15 seconds), written whole through a temp file.
- A host also accepts the version its record shows the sync last installed at that path, and a version a run recorded as pending: before writing anything, a run records in `global-sync.json` each version it is about to write, so a run cut off part way does not turn its own writes into conflicts.

**Retirement.** The same `global-sync.json` lists every skill file the sync installed or found current, per client skill directory. A recorded skill retires only when it is neither published, nor in the overlay, nor in that host's `exclude_skills` (an excluded skill is kept), and it is then removed only while every file in it is one the sync recorded, unedited. Immediately before removal its ancestors, tree, file types, and recorded hashes are checked again; a skill that changed since the preflight, or cannot be verified again, is kept and reported with the reason. A skill with any other file or edit is reported, kept, and dropped from the record, so the sync stops managing it. A skill the record does not list is never touched, and a run narrowed with `--skills` retires nothing. `--dry-run` lists what would be retired and kept.

- On a host with a configured Loadout Pi, a run that retires a skill also prints one line listing each Pi agent whose `<runtime-root>/agents/<agent id>/settings.overlay.json` names it in `skillsExclude`. It only reports: the Pi launcher skips an unknown `skillsExclude` name with a warning, and the sync never writes under `agents/`.
- When `hosts.json` sets `skills_overlay` and the fleet's `skills/` overlay is missing or not a directory, it is not read as an empty overlay: no host retires anything, every host keeps its record and reports `blocked` with the reason, and installs still run. Restore the overlay, or leave an empty `skills/` directory to retire its skills on purpose. Without `skills_overlay`, a missing overlay retires its skills.

**Preflight.** Preflight every selected destination before writing any file on that host. Reject escaping or duplicate paths, paths that are not portable (a backslash, colon, control character, trailing dot or space, or a Windows device name) or that would name one file on a case-insensitive host, symlink or junction ancestors (from the home directory down, for a destination inside it), unexpected file types, and hash mismatches. An existing file may be replaced only if it matches a verified prior publication of the same source path or the desired blob. Preserve unknown local edits and stop the host without a partial package update. Leave unselected files untouched.

After a successful preflight, write verified bytes, verify every installed hash, and run the available package validators. A preflight is not a lock: each write checks its directories and its file again right before it, and a file that changed meanwhile is not written over and fails the host. Report selected packages, commit IDs, destinations, files written, files already current, skipped clients, and blockers. A host without its own checkout may receive verified bytes from another eligible checkout, but must reverify them before the same preflight and write.

## Publishing a package change

This covers skills and plugins. Commit package content first. Generate the manifest from that committed tree with `source_commit` equal to the content commit, then commit the manifest separately. Verify that the complete active `skills/` and `plugins/` trees match manifest paths, byte counts, and SHA256 values. Review the diff before publishing. The public repository has its own clean history; do not import another repository's history or machine-local state.

---
name: personal-skills
description: Sync selected skill packages and Paseo plugins from this repository to local Codex, Claude Code, and Paseo daemon installations across a fleet, with committed-blob verification and local-edit protection.
---

# Personal skills

Use the repository root `README.md` for the current manifest format, installation destinations, and validation steps. The user chooses the packages. Target hosts come from the user's fleet description in `fleet/`; without one, sync only the current host.

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

- Read `fleet/local/` beside this installed `SKILL.md`. It is the user's private fleet: never commit, publish, or quote it into a public file. It is not a package file, so sync never overwrites or removes it on a host that already has it.
- `fleet/README.md` defines the format and `fleet/example/` shows a made-up fleet. A user starts by copying `fleet/example/` to `fleet/local/` and editing it. Never treat the example as a real target.
- Without `fleet/local/`, the fleet is the current host only, with no global instructions.
- Sync every host in the fleet by default unless the user narrows it. Each host resolves its own paths and shell, syncs the clients present, and reports absent clients as skipped.
- Report each host separately. A blocker stops only that host. Report an unreachable host as an outstanding gap; never report a host as synced until it is verified, and never drop an unreached host from the report.
- Carry `fleet/local/` to another host only over the transport the fleet names, and only when that host lacks it or the user asks. Never send it to Git or a public service.

## Paseo plugins

Plugins live at `plugins/<id>/` and are listed in the manifest's `plugins` and `plugin_files`. They are trusted, unsandboxed code that runs inside a daemon, so each host goes through three separate steps, and each needs its own authorization in the host's `paseo` entry or from the user:

1. **Stage source.** For each ID in `stage`, verify every manifest blob, then apply the local-edit preflight to `<plugin_root>/<id>/`. Carry verified bytes over the fleet transport, reverify them on the host, and write them. Run `npm ci` and the package's `check` script (or `typecheck` when it has no `check`) on the host. A failure stops that plugin on that host. Leave `node_modules` out of the preflight and the hash comparison.
2. **Install on the daemon.** Only for IDs in `install`. Read the daemon version with `paseo --version` on the host and require it to satisfy the plugin's `paseo` pin from the manifest; a daemon outside the pin is a blocker, not a reason to edit the pin. Raise a pin only in a published package change after live verification against the new Paseo version. Read the root `pluginsEnabled` in the daemon's `<PASEO_HOME>/config.json`; missing means `false`. If it is not `true`, stop and follow the `paseo-plugin` skill: the user must explicitly allow trusted plugins on that daemon before anything is enabled. Otherwise run `paseo plugin install <plugin_root>/<id>` on the host, or `paseo plugin reload <id>` when it is already installed from that directory.
3. **Confirm.** Require `paseo plugin ls` on the host to report the plugin `running` and enabled, and read `paseo plugin logs <id>` for load errors.

Never write plugin settings, plugin state, or `pluginsEnabled` as part of a sync, and never arm a plugin. A plugin with an `armed` setting starts in dry-run when its settings file is absent; a plugin without one acts as soon as it runs, so read its README before listing it in `install`. Preserve every existing settings file. A host with `plugin_root: null` manages its plugins elsewhere: report whether its installed source matches the manifest and change nothing. Report staged, installed, running, blocked, and unreachable plugins per host.

## Local-edit protection

Preflight every selected destination before writing any file on that host. Reject escaping or duplicate paths, symlink or junction ancestors, unexpected file types, and hash mismatches. An existing file may be replaced only if it matches a verified prior publication of the same source path or the desired blob. Preserve unknown local edits and stop the host without a partial package update. Leave unselected files untouched.

After a successful preflight, write verified bytes, verify every installed hash, and run the available package validators. Report selected packages, commit IDs, destinations, files written, files already current, skipped clients, and blockers. A host without its own checkout may receive verified bytes from another eligible checkout, but must reverify them before the same preflight and write.

## Publishing a package change

This covers skills and plugins. Commit package content first. Generate the manifest from that committed tree with `source_commit` equal to the content commit, then commit the manifest separately. Verify that the complete active `skills/` and `plugins/` trees match manifest paths, byte counts, and SHA256 values. Review the diff before publishing. The public repository has its own clean history; do not import another repository's history or machine-local state.

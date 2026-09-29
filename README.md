# Loadout Skills

A public collection of 25 agent skills for coding, research, writing, browser work, integrations, and orchestration, plus 4 Paseo daemon plugins. Each package lives at `skills/<category>/<name>` and installs flat as `<client skills directory>/<name>`. The repository has its own history and contains no machine credentials or private fleet configuration.

## Install

Clone this repository to a local filesystem, then verify its committed publication:

```bash
python3 scripts/verify_manifest.py
```

Choose the packages you want and follow the `personal-skills` skill or the manifest-based install instructions below. Codex uses `${CODEX_HOME:-$HOME/.codex}/skills/<name>` on Unix and `%USERPROFILE%\.codex\skills\<name>` on Windows. Claude Code uses `~/.claude/skills/<name>` on Unix and `%USERPROFILE%\.claude\skills\<name>` on Windows. Install only into clients present on the host. This repository does not install global agent instructions, provider settings, or credentials.

For a manual install, resolve the `source_commit` in `MANIFEST.json`, verify each selected committed blob's byte count and SHA256, then copy it to the flat destination after checking for local edits and symlink or junction ancestors. `skills/orchestration/personal-skills/SKILL.md` describes the full preflight. A changed installed file that matches no verified prior publication is a conflict; leave it untouched.

Some packages need an external CLI, connected service, or local credential. Read each `SKILL.md` before using it. A package may read an optional private `references/local.md` for host-specific settings, and `personal-skills` reads your private fleet from `$LOADOUT_FLEET` or `~/.config/loadout/fleet/` (see `skills/orchestration/personal-skills/fleet/README.md`). Both are ignored by Git, absent from the manifest, and never published. The `sample` package learns style from examples supplied by the user; this public version contains no personal voice profile.

## Packages

See [SKILLS_CATALOG.md](SKILLS_CATALOG.md) for all 25 active packages. There are no archived packages in this public repository.

## Paseo plugins

`plugins/<id>` holds server-only [Paseo](https://paseo.sh) plugins. Each is trusted, unsandboxed code that runs inside a daemon, so read its README before installing it.

| Plugin | Does | Default on a fresh install |
|---|---|---|
| `cache-aware-autocompact` | Sends `/compact` to idle Claude and Codex agents before their prompt cache expires | Dry-run until `armed` |
| `merged-worker-archiver` | Archives worker worktree workspaces whose branch is merged into its base | Dry-run until `armed` |
| `usage-limit-auto-resume` | Resumes an agent after a usage limit or a transient provider error | Dry-run until `armed` |
| `orphan-project-sweeper` | Deletes Paseo project rows with no active workspace and a missing root path | Acts immediately; no dry-run |

Every plugin pins a Paseo version range in `paseo-plugin.json`. To install one manually, run `npm ci` and `npm run check` (or `npm run typecheck`) in its folder, confirm the daemon's `pluginsEnabled` is `true`, then run `paseo plugin install "$PWD"`. `personal-skills` stages and installs plugins across a fleet; see its `Paseo plugins` section. Plugin settings stay host-local and are never part of this repository.

`personal-skills` can also sync pinned Paseo provider-picker rows (model lists and router environment) to fleet hosts that opt in with the `providers` scope, from a private `paseo-providers.json` in your fleet directory. See its `Paseo provider pickers` section and `fleet/example/paseo-providers.json`. It can likewise sync managed Codex and Claude Code settings to hosts in the `client-config` scope; see `fleet/example/client-config.json`.

## Tests

```bash
python3 -m unittest discover -s tests
```

## Publication integrity

`MANIFEST.json` records committed Git-blob sizes and SHA256 values for every active skill and plugin file, and each plugin's Paseo version pin. Commit package content first, run `python3 scripts/generate_manifest.py`, then commit the manifest separately. `scripts/verify_manifest.py` checks the complete committed tree. The working tree, generated files, local secrets, and another repository's history are not publication sources.

## License

Original material is licensed under [MIT](LICENSE). `frontend-design` and `playwright` retain their bundled Apache-2.0 licenses; `playwright` also retains its upstream notice. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). These package-level terms take precedence for those files.

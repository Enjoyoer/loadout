# Fleet format

A fleet describes the hosts that `personal-skills` syncs. The public `example/` folder shows the format with made-up values. Your real fleet lives in a private fleet directory with the same layout, outside this repository.

```
example/                     public, made up
  hosts.json
  global/AGENTS.md           optional
<fleet directory>/           yours, private (copy example/ here and edit)
  hosts.json
  global/AGENTS.md           optional
```

## Where the fleet lives

`python3 scripts/fleet.py resolve` prints the directory in use. The first match wins:

1. `$LOADOUT_FLEET`, a directory. If it is set but missing, resolution fails instead of falling back.
2. `${XDG_CONFIG_HOME:-~/.config}/loadout/fleet/`. On Windows, `%APPDATA%\loadout\fleet\`.
3. `fleet/local/` beside the installed `SKILL.md`, the older location. It is ignored by Git and absent from the manifest.

With none of these, the fleet is the current host only. To move an existing `fleet/local/`, copy it to the config directory, check `fleet.py resolve` reports `config`, then remove the old copy.

## hosts.json

`python3 scripts/fleet.py validate` checks the file and prints each host's transport and sync scopes. Unknown keys and values are errors.

- `schema_version`: `2`. A file without it is version 1: `transport` is free text, every host is reached over SSH, and hosts have no `transport` or `sync` of their own.
- `source_host`: name of the host whose checkout is the sync source. It runs locally, so it must use `ssh`.
- `transport`: default for every host, `ssh` or `paseo-relay`. Record host names, not IP addresses that may change.
- `notes`: optional free text.
- `hosts[]`: one entry per host.
  - `name`: address used by the transport; for `ssh`, the SSH alias.
  - `os`: `macos`, `windows`, or `linux`.
  - `transport`: optional, overrides the top-level value.
    - `ssh`: files and commands travel over SSH.
    - `paseo-relay`: the host is reached only through its Paseo daemon via a pairing offer. There is no file transport, so it cannot take `skills` or `plugins`, and it needs an explicit `sync`.
  - `paseo_offer`: path to a file holding the host's Paseo pairing offer. Required for `paseo-relay`; optional for `ssh`, where it lets daemon commands go over the relay. Keep offers private.
  - `sync`: optional list of scopes from `skills`, `plugins`, `providers`. Default: `skills`, plus `plugins` when `paseo` is present. Skill sync skips a host without `skills`, and plugin sync a host without `plugins`, and both report it as skipped, not failed. `providers` is opt-in and is used by the Paseo provider-picker sync.
  - `checkout`: path to a local Git checkout of this repository, or `null` (the default). A host without a checkout receives verified bytes from the source host and reverifies them.
  - `clients`: clients to sync, from `codex`, `claude`, `opencode`. Required when `sync` includes `skills`. Absent clients are skipped and reported.
  - `paseo`: optional. Paseo plugin sync for this host's daemon. Required when `sync` includes `plugins`.
    - `plugin_root`: directory where verified plugin sources are staged, one subdirectory per plugin ID. `null` means this host's plugins are managed outside the sync; the sync only reports whether they match the manifest.
    - `stage`: plugin IDs whose verified source is copied to `plugin_root`, installed with `npm ci`, and checked.
    - `install`: plugin IDs, a subset of `stage`, authorized for `paseo plugin install` on this daemon. List a plugin here only after its host-local settings and arming have been decided.
- `global`: optional. Maps each client to where `global/AGENTS.md` is installed.
  - `codex`: normally `$CODEX_HOME/AGENTS.md`.
  - `claude`: normally `~/.claude/CLAUDE.md`; a managed deployment may use the `claudeMd` field of Claude Code managed settings instead.
  - `opencode`: normally `~/.config/opencode/AGENTS.md`.

Omit `global` or `global/AGENTS.md` to skip global instructions. Global instructions follow the same preflight: never overwrite a changed target that matches no known prior version.

Plugin settings, plugin state, and the daemon's `pluginsEnabled` switch are host-local. The sync never writes them. See the `Paseo plugins` section of `SKILL.md`.

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

- `source_host`: name of the host whose checkout is the sync source.
- `transport`: how hosts reach each other, such as `ssh`. Record host names, not IP addresses that may change.
- `hosts[]`: one entry per host.
  - `name`: address used by the transport.
  - `os`: `macos`, `windows`, or `linux`.
  - `checkout`: path to a local Git checkout of this repository, or `null`. A host without a checkout receives verified bytes from the source host and reverifies them.
  - `clients`: clients to sync, from `codex`, `claude`, `opencode`. Absent clients are skipped and reported.
  - `paseo`: optional. Paseo plugin sync for this host's daemon. Omit it to skip plugins on the host.
    - `plugin_root`: directory where verified plugin sources are staged, one subdirectory per plugin ID. `null` means this host's plugins are managed outside the sync; the sync only reports whether they match the manifest.
    - `stage`: plugin IDs whose verified source is copied to `plugin_root`, installed with `npm ci`, and checked.
    - `install`: plugin IDs, a subset of `stage`, authorized for `paseo plugin install` on this daemon. List a plugin here only after its host-local settings and arming have been decided.
- `global`: optional. Maps each client to where `global/AGENTS.md` is installed.
  - `codex`: normally `$CODEX_HOME/AGENTS.md`.
  - `claude`: normally `~/.claude/CLAUDE.md`; a managed deployment may use the `claudeMd` field of Claude Code managed settings instead.
  - `opencode`: normally `~/.config/opencode/AGENTS.md`.

Omit `global` or `global/AGENTS.md` to skip global instructions. Global instructions follow the same preflight: never overwrite a changed target that matches no known prior version.

Plugin settings, plugin state, and the daemon's `pluginsEnabled` switch are host-local. The sync never writes them. See the `Paseo plugins` section of `SKILL.md`.

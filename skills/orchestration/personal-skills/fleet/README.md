# Fleet format

A fleet describes the hosts that `personal-skills` syncs. The public `example/` folder shows the format with made-up values. Your real fleet lives in `local/` with the same layout; it is ignored by Git and absent from the manifest.

```
fleet/
  example/            public, made up
    hosts.json
    global/AGENTS.md  optional
  local/              yours, private (copy example/ here and edit)
    hosts.json
    global/AGENTS.md  optional
```

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

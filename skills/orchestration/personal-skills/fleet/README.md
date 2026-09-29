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
- `global`: optional. Maps each client to where `global/AGENTS.md` is installed.
  - `codex`: normally `$CODEX_HOME/AGENTS.md`.
  - `claude`: normally `~/.claude/CLAUDE.md`; a managed deployment may use the `claudeMd` field of Claude Code managed settings instead.
  - `opencode`: normally `~/.config/opencode/AGENTS.md`.

Omit `global` or `global/AGENTS.md` to sync skills only. Global instructions follow the same preflight: never overwrite a changed target that matches no known prior version.

# Fleet format

A fleet describes the hosts that `personal-skills` syncs. Sync it with `python3 scripts/sync.py --dry-run`, then `python3 scripts/sync.py`; the per-file tools named below are the steps it runs. The public `example/` folder shows the format with made-up values. Your real fleet lives in a private fleet directory with the same layout, outside this repository.

```
example/                     public, made up
  hosts.json
  paseo-providers.json       optional
  client-config.json         optional
  global/AGENTS.md           optional
<fleet directory>/           yours, private (copy example/ here and edit)
  hosts.json
  paseo-providers.json       optional
  client-config.json         optional
  global/AGENTS.md           optional
  skills/<name>/SKILL.md     optional private skills (the overlay)
```

## Where the fleet lives

`python3 scripts/fleet.py resolve` prints the directory in use. The first match wins:

1. `$LOADOUT_FLEET`, a directory. If it is set but missing, resolution fails instead of falling back.
2. `${XDG_CONFIG_HOME:-~/.config}/loadout/fleet/`. On Windows, `%APPDATA%\loadout\fleet\`.
3. `fleet/local/` beside the installed `SKILL.md`, the older location. It is ignored by Git and absent from the manifest.

Edit the fleet only on the source host. `python3 scripts/fleet.py push [--dry-run] [--host <name>]` copies it to `~/.config/loadout/fleet/` (`%APPDATA%\loadout\fleet\` on Windows) on every other `ssh` host, and every sync run does this first. Each copy carries a `.loadout-sync.json` record of the hashes last synced. A host's copy is replaced only while it still matches that record. A hand-edited, added, or unrecorded differing file is a conflict, and nothing is written on that host until you resolve it, usually by deleting the host's copy. `paseo-relay` hosts get no copy. Hosts need `node`.

With none of these, the fleet is the current host only. To move an existing `fleet/local/`, copy it to the config directory, check `fleet.py resolve` reports `config`, then remove the old copy.

## Private skills

Put skills that must stay private (personal, account-bound, or holding credentials) in `skills/<name>/` inside the fleet directory on the source host, laid out like any installed package with a `SKILL.md`. The skills step installs them with the published ones, with the same `--skills` and `exclude_skills` selection and the same local-edit protection:

- A name that is also a published skill stops the run; rename one of them.
- Every overlay file hash the sync has sent is recorded in `skills/.loadout-overlay.json`, so a newer version replaces an older installed one while a hand edit on a host stays a conflict. A skill that moved here from the public repository also replaces its last published copy.
- `__pycache__`, `.pyc`, and `.DS_Store` are skipped; symlinks are errors.
- The fleet push does not copy `skills/` to other hosts; skill bytes travel only through the skills step.

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
  - `sync`: optional list of scopes from `skills`, `plugins`, `providers`, `client-config`. Default: `skills`, plus `plugins` when `paseo` is present. Each sync skips a host outside its scope and reports it as skipped, not failed. `providers` (Paseo provider pickers) and `client-config` (managed Codex and Claude Code settings) are opt-in. `paseo-relay` hosts can take only `providers`.
  - `exclude_skills`: optional skill names the skills sync leaves alone on this host, such as a package you keep a private version of.
  - `checkout`: path to a local Git checkout of this repository, or `null` (the default). A host without a checkout receives verified bytes from the source host and reverifies them.
  - `clients`: clients to sync, from `codex`, `claude`, `opencode`. Required when `sync` includes `skills`. Absent clients are skipped and reported.
  - `paseo`: optional. Paseo plugin sync for this host's daemon. Required when `sync` includes `plugins`.
    - `plugin_root`: directory where verified plugin sources are staged, one subdirectory per plugin ID. `null` means this host's plugins are managed outside the sync; the sync only reports whether they match the manifest. Changing it for a host with installed plugins needs `sync.py --migrate-path` once.
    - `stage`: plugin IDs whose verified source is copied to `plugin_root`, installed with `npm ci`, and checked.
    - `install`: plugin IDs, a subset of `stage`, authorized for `paseo plugin install` on this daemon. List a plugin here only after its host-local settings and arming have been decided.
- `global`: optional. Maps each client to where `global/AGENTS.md` is installed.
  - `codex`: normally `$CODEX_HOME/AGENTS.md`.
  - `claude`: normally `~/.claude/CLAUDE.md`; a managed deployment may use the `claudeMd` field of Claude Code managed settings instead.
  - `opencode`: normally `~/.config/opencode/AGENTS.md`.

Omit `global` or `global/AGENTS.md` to skip global instructions. Global instructions follow the same preflight: never overwrite a changed target that matches no known prior version.

Plugin settings, plugin state, and the daemon's `pluginsEnabled` switch are host-local. The sync never writes them. See the `Paseo plugins` section of `SKILL.md`.

## paseo-providers.json

Optional. The Paseo provider-picker sync (`python3 scripts/paseo_providers.py`) reads it and updates hosts whose `sync` includes `providers`. It holds router URLs and host settings, so it stays in the private fleet directory.

- `providers`: pinned blocks keyed by Paseo provider, such as `claude` or `codex`. Each block's fields replace the same fields in the host's `agents.providers.<provider>`; other fields there are kept. `models[]` rows need a unique `id` and a `label` that is a name only: no digits and not the model ID.
- `env`: optional default environment per provider, merged into `agents.providers.<provider>.env` on every host.
- `hosts`: optional settings by host name, each for a host with the `providers` scope.
  - `env`: per-provider values layered over the default.
  - `inherit_env`: `false` skips the default `env`, so the host keeps its own values.
  - `required_env`: per-provider variable names that must be set after the merge, or the host fails without a write.

## client-config.json

Optional. `python3 scripts/client_config.py [--dry-run] [--host <name>] [--update-claude]` reads it and updates hosts whose `sync` includes `client-config`. Each host gets the base settings, then its role's, then its own `hosts.<name>` overrides. It holds router URLs, so it stays in the private fleet directory.

- `token_file`: optional path, on the source host, to a secret file. Its contents go to hosts whose settings name a `claude.token_env`, over SSH stdin only. The token is never passed as an argument, stored in this file, or printed.
- `codex`: managed keys for Codex `config.toml`.
  - `top`: top-level keys. Missing keys are inserted before the blank lines that precede the first section header.
  - `sections`: named sections such as `model_providers.<id>`, each a map of keys. A missing section is appended.
  - `reportOnly`: top-level keys that are printed per host and never written.
  - Values are strings, numbers, or booleans. The merge is line-based and keeps CRLF, comments, and every other key and section.
- `claude`: managed parts of Claude Code `~/.claude/settings.json`.
  - `settings`: top-level keys, each replaced whole.
  - `env`: keys merged into `env`.
  - `token_env`: an `env` name to fill from `token_file`, or `null`.
  - `minVersion`: base only. Hosts below it are reported, and `--update-claude` runs `claude update` on them. Versions compare like `sort -V`.
- `roles.local`, `roles.remote`: layers with `codex` (`top`, `sections`) and `claude` (`settings`, `env`, `token_env`). The source host is `local` and every other host `remote`.
- `hosts.<name>`: the same layer for one host, plus an optional `role` that overrides the default.

Only these keys are written. Everything else stays host-local. A missing client is skipped. Each changed file is backed up in place as `<file>.bak-loadout-<stamp>` and replaced atomically; a second run reports `unchanged`.


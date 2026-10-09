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
- `global`: optional. Maps each client to where `global/AGENTS.md` is installed. A target is a path starting with `~`, `/`, `$VAR` or `${VAR}`, `%VAR%`, or a drive such as `C:\`, and must be absolute once the host expands it. `fleet.py validate` rejects anything else, and a host refuses a target that is not absolute or names a variable it does not set, so text is never written as a file.
  - `codex`: normally `$CODEX_HOME/AGENTS.md`.
  - `claude`: normally `~/.claude/CLAUDE.md`. For a managed deployment, `managed-settings:claudeMd` installs the instructions as the `claudeMd` string field of Claude Code's `managed-settings.json`: `/Library/Application Support/ClaudeCode/` on macOS, `/etc/claude-code/` on Linux, and `%ProgramFiles%\ClaudeCode\` on Windows (`C:\ProgramData\ClaudeCode\` only when that file exists and the Program Files one does not). Only `claudeMd` changes: the file is first backed up beside itself as `<file>.bak-<UTC stamp>`, then replaced atomically and checked. When the user cannot replace it, macOS and Linux use `sudo -n` and keep its owner and mode; if that needs a password, nothing is written. On Windows run the sync from an administrator shell. `--dry-run` reports whether elevation is needed. `LOADOUT_CLAUDE_MANAGED_SETTINGS` on the host overrides the file path, for tests.
  - `opencode`: normally `~/.config/opencode/AGENTS.md`.

Omit `global` or `global/AGENTS.md` to skip global instructions. Global instructions follow the same preflight: never overwrite a changed target that matches no known prior version. For `managed-settings:claudeMd` the preflight compares the field's value, a missing file or field is added, and unparseable JSON or a non-object is a conflict.

Plugin settings, plugin state, and the daemon's `pluginsEnabled` switch are host-local. The sync never writes them. See the `Paseo plugins` section of `SKILL.md`.

## paseo-providers.json

Optional. The Paseo provider-picker sync (`python3 scripts/paseo_providers.py`) reads it and updates hosts whose `sync` includes `providers`. It holds router URLs and host settings, so it stays in the private fleet directory.

- `providers`: pinned blocks keyed by Paseo provider, such as `claude` or `codex`. Each block's fields replace the same fields in the host's `agents.providers.<provider>`; other fields there are kept. `models[]` rows need a unique `id` and a `label` that is a name only: no digits and not the model ID.
- `env`: optional default environment per provider, merged into `agents.providers.<provider>.env` on every host.
- `hosts`: optional settings by host name, each for a host with the `providers` scope.
  - `env`: per-provider values layered over the default.
  - `inherit_env`: `false` skips the default `env`, so the host keeps its own values.
  - `required_env`: per-provider variable names that must be set after the merge, or the host fails without a write.

## Pi surface on stock Paseo 0.10.3

The optional `example/pi-provider-overlay.json` illustrates the Pi fields to add to your existing provider catalog. `paseo-providers.json` may contain `pi` with `root`, `catalogSources` (normally `claude` and `codex`), `defaultSourceProvider`, and `runtime`. Hosts can override `pi`; the provider step generates Pi's `models.json` from the same provider rows on every selected host. Do not maintain a separate Pi model list. Canonical labels are Opus, Sonnet, Fable, Astra, Sol, Luna, Web Extra, Web Pro. Use one row per label. An optional `pi.claudeApiKeyRoute` of `{"prefix": "api", "labelSuffix": "API"}` adds a second Pi entry per Claude row, labeled for example "Opus API", whose model ID is `<prefix>/<apiModelId>`. Use it when the router pins that prefix to a pay-per-use API key while plain IDs keep the subscription logins. The entry copies the Claude row's transport, context window, output limit and thinking options, so verify the key's real context window first. It applies to Pi only, never to the native Claude provider. Each entry sits directly after its base row. An optional `pi.labelOrder`, for example `["Fable", "Opus", "Sonnet"]`, puts those labels first in Pi only, each followed by its API entry; unlisted labels keep their catalog order and direct provider rows stay last, and new picker rows need a daemon config reload. A row may include `api` and `apiModelId` when the backend requires a different API or catalog ID than the native CLI. Copy the backend ID from its model list. For example, a native Claude catalog can retain its context suffix while the same row records the router's exact unsuffixed ID. Native routes remain available.

### Native OpenCode Zen free models

Use `example/opencode-free-overlay.json` to pin the native `opencode` picker rows: `opencode/space-bunny-free` is SBF and `opencode/muse-spark-1.3-contributor-free` is MS. Merge the overlay into the existing catalog without replacing Claude/Codex rows, changing defaults or adding `opencode` to Pi's `catalogSources`. Apply the overlay only to approved hosts; host-specific `providers.opencode` blocks can keep excluded hosts untouched. Copy IDs verbatim from the target's `paseo provider models opencode`. Free rows must have no `service_tiers`, including an empty list.

These models use OpenCode Zen directly, not a fleet router or CLIProxyAPI. Zen uses `https://opencode.ai/zen/v1/chat/completions` for SBF and `https://opencode.ai/zen/v1/responses` for MS. OpenCode resolves its existing environment, config and auth sources; API auth normally resides in `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`, under `opencode.key`, with `type: "api"`. It uses the non-secret `public` sentinel when free anonymous access is available. No new credentials, Pi login, auth migration or security change is required for the native path. Inspect only key names and lengths.

Direct Pi is not a supported fleet path for this pair: MS rejects non-OpenCode clients with HTTP 403 `FreeTierError` ("OpenCode's free tier can only be used from within OpenCode"). Do not impersonate OpenCode or bypass that restriction with headers. The native provider remains visible in the client picker and model-browser profiles; `pi/picker-patch.py` hides only Claude/Codex and preserves OpenCode. Keep Pi as the client default, while letting the owner select OpenCode and then SBF or MS. No preference migration or bundle reapply is needed if the current patch already passes the visibility check.

Standard means ordinary native OpenCode use with no tier setting. Do not enable Codex Fast for these models. The defensive Pi routing hooks also refuse explicit Fast/Ultrafast for these untiered IDs, allow Standard without sending a wire tier, omit router metadata and fail closed when label lookup fails. This guard does not make direct MS access supported. Free availability and IP limits remain upstream-controlled. MS is a contributor tier allowing upstream training on prompts and completions; see [Zen's current terms](https://opencode.ai/docs/zen/).

**MS is for non-sensitive work only.** Keep it as an explicit picker choice: never make it a default, route agents to it automatically, or use it for any agent that handles private, client or business data. SBF has no such restriction recorded, but the same caution applies to anything sent to a free upstream tier.

After approval, back up the private fleet file and merge the native rows for each approved host. Dry-run a provider-only sync, review the generated proposal, then apply at an approved runtime boundary. Verify exact native picker IDs and labels, lack of tiers, unchanged Pi defaults and client OpenCode visibility. Avoid changing native command, environment, auth, enabled state or active agents. If runtime helpers or renderer bundles need a change, coordinate that separately. Roll back only the new host-local `agents.providers.opencode.models` field from the recorded config backup after checking for unrelated edits; restore the private fleet file as well. Never restore an entire stale config over business-controller changes.

`runtime` describes the router `route` (TOML path and key path) or `baseUrl`, existing `credential` reference, optional `credentialHeaders`, `python` (Python 3.11+), and the loopback `paseoMcp.url`. The router base URL must use https unless its host is loopback (`127.0.0.1`, `localhost`, `::1`), because the key travels as a Bearer header. Credentials resolve at request time through an existing text, env, env-file, JSON or TOML source. An optional `gmail` object (`email`, `home`, optional loopback callback `port`) adds a read-only Gmail MCP server from the `workspace-mcp` package installed in `home/venv`. `home` holds the OAuth client JSON and token, owner-only, and is never synced; on POSIX, configure refuses a group- or other-accessible `home`. Read-only is enforced three times: the server runs with `--read-only` (the `gmail.readonly` scope), write and auth tools are passed to `--disabled-tools`, and Pi hides the server except for an allowlist of read tools, which are reachable through Codemode. Pi reads `mcp.json` at session start, so writing it needs no daemon reload. An optional `directProviders` object adds unauthenticated OpenAI-compatible endpoints that bypass the router, such as a local model gate: `{"<name>": {"baseUrl": "http://gate.example.test:8080/v1", "api": "openai-completions", "auth": "none", "models": [{"id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap"}]}}`. Each model is listed once; it becomes a `models.json` provider with a dummy `local-no-auth` key and a picker row `<name>/<id>` labeled with its `name`, with thinking options from the non-null `thinkingLevelMap` levels (Medium preferred as default). Credentials, headers, `compat` flags, other APIs and the names `fleet`, `opencode` and `llama.cpp` are rejected. These routes have no service tier, so Fast is never offered. New picker rows need a daemon config reload. No key contents belong in this file. Generated Pi settings fix built-in Codemode on with `defaultTools: ["+codemode"]`; no profile, feature or per-agent flag enables it. Sync validates these settings and the runtime fails closed if the effective session settings or active tools lack Codemode. Session evidence records the check. The skills sync discovers the configured official Pi home from the host provider command and installs the same selected, manifest-verified skills under `agent/skills`; generated settings reference that shared directory. Global instructions sync to `agent/AGENTS.md` and are copied into each agent home at launch. No Claude-only tool is required to discover and read these skill files. The settings carry the source provider's default model and thinking. Pi exposes only its supported thinking levels; Web models retain model-fixed thinking. Native `ultra` and `ultracode` selections need an explicit native fallback because Pi 1.0 has no such selector.

Install official Pi 1.0.0 first using the reviewed `scripts/pi/apply.sh` (POSIX) or `apply.ps1` (PowerShell), with a generated per-host proposal and a fresh `--state` file. `plan`, `apply`, and `rollback` require a reachable stock daemon reporting a release version in `>=0.10.3 <0.12.0`. `--activate` reloads only that selected daemon. Apply backs up the daemon config and runtime before writing; rollback verifies the backup and refuses unrelated config changes. A failed partial apply can be rolled back with the same state. The installed package is retained for later reapply.

The provider sync needs the existing package. It generates runtime helpers and catalog together, backs up changed files, then merges provider rows. Each real agent gets a stable private `PI_CODING_AGENT_DIR` and an MCP endpoint carrying its caller ID. Stock 0.10.3 rejects official Pi through its `mcpServers` API. The interim stdio bridge exposes the daemon tools through Codemode and fills omitted child provider/model/thinking from the current parent snapshot, while preserving explicit overrides. Enable daemon MCP and injection through the reviewed apply proposal.

`isDefault` selects a model within a provider; stock 0.10.3 has no daemon-wide default provider. Web UI clients store their new-agent preference in `@paseo:create-agent-preferences`. Emit a script with `node scripts/pi/app-defaults.mjs catalogs.json`, where the input maps provider names to verbatim `list_models` results' model arrays. Run it on that client's actual origin: it carries the saved model/thinking or source catalog default, preserves native preferences, and saves rollback bytes. Add `--rollback` to emit restoration. Native clients must select Pi in their picker. This preference is client-local and can affect all connected hosts, so apply it only when those hosts support Pi. A headless host cannot set every client's storage through daemon config.

OPC resolves fixed role labels from the target Pi catalog at spawn time; missing or ambiguous labels fail clearly. OPC Workers run on Pi. An owner-selected Worker model, effort, and Fast choice wins; without one, code tasks default to the `Opus` label at `xhigh` and browser or computer-use tasks to `Sol` at `medium`, both with Fast off. A model or effort the Pi catalog does not serve stops the lane. A native Codex or Claude Code Worker, including one needed for native plan or permission modes, requires an explicit owner authorization for that task. Pi has no plan mode or permission-mode controls and its tools execute with the host user's authority. Fast is the Pi Fast toggle label `opc.service-tier=fast` on GPT routes: OPC sets it for a Fast Worker and leaves it unset when Fast is off, because an explicit Standard tier is refused on routes without service tiers. For Fast-requested Sol workers, the generated router extension requests `service_tier: priority`; request acceptance does not prove priority was granted. Its private per-session evidence records the requested and reported tier, without headers or transcript contents.

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


### Desktop picker defaults and update guard

Generate `client-preferences.js` with `pi/app-defaults.mjs` from the same catalog rows used for the host. Pass it to `picker-patch.py APP_DIST apply --preferences-script client-preferences.js`. The patch state records the script's sha256 and refuses a later apply or reapply with a different script; after reviewing a regenerated script, accept it with `--preferences-sha256 HASH` (the refusal prints the hash). The renderer carries the previous provider's catalog label and thinking onto Pi before loading saved form preferences. It keeps a localStorage backup for the rollback script emitted by `app-defaults.mjs --rollback`. Bundle rollback restores the exact original bytes; preference rollback must run in each affected client origin.

On Windows, point the existing Desktop shortcut to `picker-launch.ps1 -PreferencesScript SCRIPT` (add `-AppRoot APP_ROOT` when more than one install exists). It reapplies the supported picker patch before launch after an app update. If the reapply fails, for example because a per-machine install under Program Files is not writable without elevation, or the bundle shape is unsupported, it logs a warning to `%LOCALAPPDATA%\loadout\picker-launch.log` and still launches the unpatched client; run the logged reapply command from an elevated PowerShell afterwards. That command calls Python by the absolute path the guard resolved unelevated, not through PATH. Back up the shortcut before changing it and restore it on rollback. The app updater's immediate internal restart can bypass an OS shortcut; rerun this launch guard after that restart. Do not change daemon availability or native-agent settings to hide providers.

### Provider catalog without a runtime install

A providers-only host can set its host `pi` descriptor to `{"catalogOnly": true}`. This derives Pi's models from the same catalog sources, but emits only the `models` field. It preserves local command, availability and environment, and writes no Pi agent home or binary. Before syncing an older daemon, validate the generated rows with that version's schema, back up its config, and exercise a guarded provider-only rollback. This does not activate Pi on a host where it is unavailable.

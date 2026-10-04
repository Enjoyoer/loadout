# orphan-project-sweeper

Startup endpoint resolution uses explicit `PASEO_HOST`, then `$PASEO_HOME/paseo.pid` runtime listen metadata. An explicit non-default `PASEO_HOME` without valid endpoint metadata refuses to connect instead of falling back to another daemon. Invalid explicit hosts also fail closed. The standard local endpoint is a fallback only for an unset home or `~/.paseo`.

Server-only Paseo plugin (Paseo >=0.9.2 <0.11.0) that deletes an orphaned Paseo project row.
A project is orphaned only when both hold at evaluation time:

1. it has zero active (non-archived) workspaces, joined on `projectId`, and
2. its `projectRootPath` no longer exists on disk (`lstat` fails with `ENOENT`/`ENOTDIR`).

It defaults to dry-run until `armed` is exactly `true`. It removes Paseo bookkeeping,
never git branches or repository/worktree directories. The daemon also removes the
project's custom icon when deleting its row (see Recovery).

## Triggers

- **Startup sweep**: 5 seconds after the plugin loads, every project is evaluated once.
- **`workspace.archived` hook**: the hook records the `projectId` and returns
  immediately (hooks abort after 30 seconds). A module-scope timer re-checks live
  state up to 5 times over about 5 minutes (10s, 30s, 60s, 90s, 120s), because archive
  events can fire before worktree cleanup. Candidates are deduplicated per project and
  capped at 64; anything dropped is caught by the next startup sweep.

Every decision logs one stdout line (`paseo plugin logs orphan-project-sweeper`) with
`projectId`, `path`, and a reason (including `would-delete` when unarmed and
`cap-reached` for candidates beyond the sweep limit): `orphaned(...)`, `path-still-exists`,
`active-workspaces`, `path-unverifiable`, or `project-missing`. The project is
re-evaluated immediately before each delete.

## Internal client dependency and the version bound

This plugin does **not** use the public plugin SDK surface for its daemon access. It
imports `DaemonClient` from `@getpaseo/client/internal/daemon-client`, an internal,
unversioned export, for two reasons:

- the `PluginServerContext` passed to `contribute()` carries no Paseo SDK handle, so a
  startup sweep has nothing to call; the hook-supplied `PaseoApi` exists only inside
  hook and RPC callbacks, and
- `PaseoApi.projects` exposes only `list()` and `subscribe()`, no delete. The typed
  `DaemonClient.removeProject()` is exactly what `paseo project delete` calls.

Because that internal surface can change in any minor release, and a plugin that
deletes rows must fail closed on an unknown Paseo version, `paseo-plugin.json` pins
`"paseo": ">=0.9.2 <0.11.0"` and `package.json` pins `@getpaseo/client` to exactly
`0.9.2`. `DaemonClient`, `listProjects()`, `fetchWorkspaces()`, and `removeProject()`
are present in the pinned 0.9.2 client. Recovery and settings behavior below were
verified against the 0.9.2 server source and local CLI help. The allowed 0.10 releases
have not been exercised for this safeguard change. Re-check before admitting 0.11.

The plugin opens a short-lived local connection per sweep or re-check, the same way the
Paseo CLI does. The daemon address is resolved from `PASEO_HOST`, then
`$PASEO_HOME/paseo.pid`, then `127.0.0.1:6767` only for the default home. A non-default home without valid listen metadata refuses to connect. esbuild bundles `@getpaseo/client`
into the server bundle (only the plugin SDK specifiers and `zod` stay external), so
`npm install` must have run in this directory before `paseo plugin install` or `reload`.

## Settings

Host-scoped settings registered with `server.registerSettings`, stored at
`<PASEO_HOME>/plugin-settings/orphan-project-sweeper/config.json` as
`{"version":1,"values":{...}}`. A missing file uses defaults. Settings are re-read
before each startup sweep or deferred archive re-check, so edits apply to the next
sweep without a reload. Unknown keys, malformed documents, unsupported settings
versions, or read failures log a settings error and evaluate in dry-run with defaults.

| Key | Default | Meaning |
|---|---|---|
| `armed` | `false` | Only JSON boolean `true` allows deletion. Every other value is dry-run. |
| `maxDeletesPerSweep` | `5` | Positive safe integer limiting successful deletions per sweep. Invalid values fall back to `5` and log the invalid setting. |

To arm, set `values.armed` to `true` in that host's settings document. For example:

```json
{"version":1,"values":{"armed":true,"maxDeletesPerSweep":5}}
```

A full sweep deletes at most the cap, then logs `cap-reached` with each remaining
candidate's project ID, path, and reason. Those rows stay for the next sweep.
There is no periodic full sweep: the next startup sweep (plugin load) or a later
archive event can revisit them. Each deferred archive re-check evaluates one project
and has its own sweep budget. Dry-run uses the same cap for `would-delete` previews.
Skipped candidates and failed deletions do not consume the cap. Every delete or
`would-delete` preview re-evaluates the project against live daemon and filesystem
state immediately before the decision.

## Dry run

Preview one full sweep without installing the plugin:

```bash
npm ci
npm run dry-run
npm run dry-run -- --host <host:port> --config <values.json>
```

This opens a short-lived connection to the local daemon using the resolution above,
logs `would-delete`, `cap-reached`, and skip decisions, and closes the connection.
`--config` takes a plain settings values object, not the versioned envelope.
Defaults apply when omitted. The script forces dry-run even if the file says
`"armed": true`. It does not write settings or call `removeProject`.
`npm run dry-run -- --help` prints usage without connecting.

## Recovery

Deletion removes the persisted project record, including its root-path registration,
custom name, and custom icon metadata. Paseo also removes the custom icon file.
With this plugin's zero-active-workspace gate, already archived workspace records
are left in place. Re-adding a directory registers a project again; it does not
restore the deleted record's customizations or reconnect those old workspace records.

Restore the directory first, then register it with the CLI:

```bash
paseo project create <project-directory>
```

`paseo project create --help` describes this as "Register a project directory".
The 0.9.2 server rejects a missing directory, and allocates a new project ID when no
active project is registered for that root. Reapply any custom name or icon separately.
This is registration, not an undo of the removed row.

To disarm, set `values.armed` to `false` in the settings document, retaining the
`version: 1` envelope and other settings. The next sweep evaluates without deleting.
A sweep already in progress uses the settings it read at its start. For example:

```json
{"version":1,"values":{"armed":false,"maxDeletesPerSweep":5}}
```

The recovery details were checked in the 0.9.2 server's `handleProjectRemoveRequest`,
`handleProjectAddRequest`, and `FileBackedProjectRegistry`, and the CLI's project
create help. Recovery has not been exercised against a live daemon.

## Develop

```bash
npm ci
npm run check
```

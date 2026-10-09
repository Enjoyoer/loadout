# orphan-project-sweeper

Startup endpoint resolution uses explicit `PASEO_HOST`, then `$PASEO_HOME/paseo.pid` runtime listen metadata. An explicit non-default `PASEO_HOME` without valid endpoint metadata refuses to connect instead of falling back to another daemon. Invalid explicit hosts also fail closed. The standard local endpoint is a fallback only for an unset home or `~/.paseo`.

Server-only Paseo plugin (Paseo >=0.10.3 <0.12.0) that deletes an orphaned Paseo project row.
A project is orphaned only when all of these hold at evaluation time:

1. it has zero active (non-archived) workspaces, joined on `projectId`, and
2. its `projectRootPath` no longer exists on disk (`lstat` fails with `ENOENT`/`ENOTDIR`),
   while its parent directory (and, on Windows, its drive root) still exists and is not empty.
   A root on an unmounted or late-mounting volume is skipped as `parent-missing`, never deleted.
   An unmounted volume usually leaves its mount point as an empty directory, so an empty parent
   counts as absent.
3. On Linux and macOS, every mount point `/etc/fstab` declares over the root path is mounted now.
   A non-empty parent alone proves nothing, because the directory under a mount point can hold
   unrelated files. Linux reads `/proc/self/mountinfo` (an automount trigger alone does not count);
   macOS and other POSIX systems compare the mount point's device id with its parent directory's.
   A declared mount that is absent skips the project as `mount-absent`. If `/etc/fstab` exists but
   cannot be read, or the mount table cannot be read, the project is kept as `mount-unverifiable`.
   A mount the host does not declare (mounted by hand or by a desktop session) looks like a plain
   directory, so only the empty-parent rule covers it.
4. On Windows, no existing ancestor of the root is a reparse point. A junction or directory symlink
   (`lstat` reports a symbolic link), a volume mount point (a folder whose device id differs from
   its parent's), or an ancestor `lstat` cannot read for a reason other than `ENOENT` keeps the
   project as `mount-unverifiable`. A missing folder under plain folders on a present drive is
   still a candidate. The drive-root rule above is unchanged.

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
`active-workspaces`, `path-unverifiable`, `parent-missing`, `mount-absent`, `mount-unverifiable`,
or `project-missing`. The project is re-evaluated immediately before each delete: filesystem and
mount checks first, then the daemon's workspace count, then the root, parent and mount checks
once more right before `removeProject`; any absent or unverifiable state skips the delete. The
daemon's `project.remove.request` carries only the project ID, so it cannot refuse a row that
changed after that last check; closing the remaining gap needs a daemon-side precondition on the
request.

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
`"paseo": ">=0.10.3 <0.12.0"` and `package.json` pins `@getpaseo/client`,
`@getpaseo/plugin`, and `@getpaseo/protocol` to exactly `0.11.1`. `DaemonClient`,
`listProjects()`, `fetchWorkspaces()`, and `removeProject()` keep the same signatures
from 0.9.2 to 0.11.1; the 0.10.3 client only adds optional daemon password auth, and the
0.11.1 client only adds usage reports and a connection wait for file uploads.
Recovery and settings behavior below were verified against the 0.9.2 server source and
local CLI help, and the plugin's tests pass against the 0.11.1 packages. The same build
was proven on disposable 0.10.3 and 0.11.1 daemons: unarmed it logged `would-delete` for
a fixture project with no active workspace and a removed directory, and armed it deleted
that row while the live fixture project remained. Re-check before admitting 0.12.

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

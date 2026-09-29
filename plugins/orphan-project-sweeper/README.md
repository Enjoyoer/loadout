# orphan-project-sweeper

Server-only Paseo plugin (Paseo 0.9.x) that deletes an orphaned Paseo project row.
A project is orphaned only when both hold at evaluation time:

1. it has zero active (non-archived) workspaces, joined on `projectId`, and
2. its `projectRootPath` no longer exists on disk (`lstat` fails with `ENOENT`/`ENOTDIR`).

It only touches Paseo bookkeeping. It never deletes git branches, worktree directories,
or anything else on disk, and it never edits `~/.paseo/config.json`.

## Triggers

- **Startup sweep**: 5 seconds after the plugin loads, every project is evaluated once.
- **`workspace.archived` hook**: the hook records the `projectId` and returns
  immediately (hooks abort after 30 seconds). A module-scope timer re-checks live
  state up to 5 times over about 5 minutes (10s, 30s, 60s, 90s, 120s), because archive
  events can fire before worktree cleanup. Candidates are deduplicated per project and
  capped at 64; anything dropped is caught by the next startup sweep.

Every decision logs one stdout line (`paseo plugin logs orphan-project-sweeper`) with
`projectId`, `path`, and a reason: `orphaned(...)`, `path-still-exists`,
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
were checked against 0.9.2 and 0.10.1; other 0.10 releases are admitted without that
check. Re-check them before admitting 0.11.

The plugin opens a short-lived local connection per sweep or re-check, the same way the
Paseo CLI does. The daemon address is resolved from `PASEO_HOST`, then
`$PASEO_HOME/paseo.pid`, then `127.0.0.1:6767`. esbuild bundles `@getpaseo/client`
into the server bundle (only the plugin SDK specifiers and `zod` stay external), so
`npm install` must have run in this directory before `paseo plugin install` or `reload`.

## No dry-run

This plugin has no settings and no `armed` switch. It acts as soon as it is installed
and running, starting with the startup sweep. Install it only where deleting orphaned
project rows automatically is wanted.

## Manifest gotcha

The 0.8.0 daemon rejects a `description` key in `paseo-plugin.json` with
`Unrecognized key: "description"`, even though the plugin docs list it as optional.
The installed manifest schema accepts only `id`, `requirements`, and `build`. Keep the
description in `package.json` instead.

## Develop

```bash
npm ci
npm run typecheck
paseo plugin install "$PWD"      # first time
paseo plugin reload orphan-project-sweeper
paseo plugin logs orphan-project-sweeper
```

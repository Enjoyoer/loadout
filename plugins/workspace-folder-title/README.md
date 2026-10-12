# workspace-folder-title

Server-only Paseo plugin for Paseo >=0.10.3 <0.12.0. It gives a new workspace the basename of its working directory instead of the bare git branch name that Paseo may choose by default.

## What it does

The plugin never replaces a title supplied by the caller. It fills omitted titles for normal directory sources. Worktree sources are left for the post-creation safety net, which uses the actual worktree folder.

It has two daemon hooks:

- `server.before("workspace.create", ...)` fills an omitted workspace title from a directory source before Paseo creates the workspace. It does not title worktree sources.
- `server.on("workspace.created", ...)` is a safety net. If the resulting name is empty or is a bare branch name, including `main`, `master`, `trunk`, or `develop`, it checks the current branch and renames the workspace to the basename of `workspace.cwd` through the Paseo SDK.

Each rename writes one log line. The plugin has no settings and no UI.

## Install

Install the plugin from its directory source with the Paseo plugin command, or add the directory through Paseo's plugin management UI. Build it first with:

```bash
npm install
npm run check
```

Enable `workspace-folder-title` in the target Paseo daemon. The plugin runs in the daemon and does not add an app surface.

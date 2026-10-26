# history-cwd-fallback

Server-only Paseo plugin for Paseo >=0.10.3 <0.14.0. It lets an archived agent whose working directory was deleted open its history again.

## The problem

Paseo shows an archived agent's timeline by starting its provider again in the agent's stored working directory (a "history" open). When that directory is gone, for example a worktree removed after its branch merged, the provider never starts: Node reports `spawn <command> ENOENT` because the directory it should run in is missing, and the timeline fails to load. Pi agents hit this; the same applies to any provider Paseo starts this way. A plugin hook cannot change the directory Paseo starts the provider in, and the provider's launch command cannot help either, since the spawn fails before it runs.

## What it does

It registers one hook, `server.before("agent.session_open", ...)`, and never changes the request it receives.

- **History open, directory missing:** the plugin creates a link at the missing path that points to an empty, read-only directory, `<PASEO_HOME>/plugin-state/history-cwd-fallback/empty` (a junction on Windows), creating any missing parent directories too. The provider starts there, so the timeline opens. One minute after the last history open that needed it, the plugin removes the link and the parent directories it created, if they are empty. The provider keeps running in the empty directory, which stays valid. The agent's stored directory never changes.
- **History open, directory present:** nothing happens. The provider runs in its real directory, exactly as without the plugin.
- **Any other open (a new turn, an unarchive, a new agent) on a path the plugin has linked:** the plugin refuses it with `Working directory does not exist`, as Paseo itself refuses once the link is gone. A real turn never runs in the stand-in directory. Opens on any other path are untouched.

Each link is recorded in `<PASEO_HOME>/plugin-state/history-cwd-fallback/links.json` before it is made. When the plugin stops, it removes its links at once; after a crash, it removes any recorded link when it next starts. It removes a path only while it is still its own link to the empty directory, and a parent directory only when it is empty.

Each link and removal writes one log line. The plugin has no settings and no UI, and acts as soon as it is installed and enabled.

## Limits

- On Windows the empty directory is not read-only, since Windows has no equivalent of POSIX mode `0500` on a directory; it is still never given a real turn.
- While the plugin is stopped by a crash and not yet restarted, a link it made can stay in place until it starts again.

## Install

Install the plugin from its directory source with the Paseo plugin command, or add the directory through Paseo's plugin management UI. Build it first with:

```bash
npm install
npm run check
```

Enable `history-cwd-fallback` in the target Paseo daemon. The plugin runs in the daemon and does not add an app surface.

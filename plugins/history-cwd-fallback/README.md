# history-cwd-fallback

Server-only Paseo plugin for Paseo >=0.10.3 <0.14.0. It lets an archived agent whose Paseo worktree was deleted open its history again.

## The problem

Paseo shows an archived agent's timeline by starting its provider again in the agent's stored working directory (a "history" open). When that directory is gone, for example a worktree removed after its branch merged, the provider never starts. Node reports `spawn <command> ENOENT` because the directory it should run in is missing, and the timeline fails to load. Pi agents hit this, and so can any provider Paseo starts this way. A plugin hook cannot change the directory Paseo starts the provider in. The provider's launch command cannot help either, since the spawn fails before it runs.

## What it does

It registers one hook, `server.before("agent.session_open", ...)`, and never changes the request it receives.

- **History open of a missing worktree directory:** the plugin creates a link at the missing path that points to an empty, read-only directory, `<PASEO_HOME>/plugin-state/history-cwd-fallback/empty` (a junction on Windows). The provider starts there, so the timeline opens. One minute after the last history open that needed it, the plugin removes the link. The provider keeps running in the empty directory, which stays valid. The agent's stored directory never changes.
- **Where it links:** only a path strictly inside Paseo's worktrees root, which is `worktrees.root` in `<PASEO_HOME>/config.json` when set and otherwise `<PASEO_HOME>/worktrees`. Containment is decided on the resolved path text, without following links. The path's parent must already exist. Every directory from the root down to that parent must be a real directory, not a link, and must hold no `.git` entry, so a link never lands inside a live git work tree. The plugin never creates a directory there. For any other missing path it does nothing, and the history read fails as it would without the plugin.
- **Present directory:** nothing happens. The provider runs in its real directory, exactly as without the plugin.
- **Any other open of a linked path:** this covers a new turn, an unarchive and a new agent. The plugin refuses it with `Working directory does not exist`, as Paseo itself refuses once the link is gone. A real turn never runs in the stand-in.

Sending a message to an archived agent whose worktree is missing works like this. Paseo first loads the agent for history, which the plugin cannot tell apart from a timeline open, so that load may create the link. Paseo then opens the agent for the turn, and the plugin refuses that open. The agent stays archived and no turn runs.

Each link is recorded in `<PASEO_HOME>/plugin-state/history-cwd-fallback/links.json` before it is made. When the plugin stops, it removes its links at once. After a crash, it removes any recorded link the next time it starts. A path is removed only while it is still a link to the plugin's own empty directory. If something wrote into that directory through a link, the plugin leaves the link in place and stops making new links until the directory is empty again. Either case writes a log line. A ledger that cannot be read is moved aside (`links.json.bad-<time>`) and logged. Links made by the running plugin are still removed, because it keeps its own record of them.

Each link and removal writes one log line. The plugin has no settings and no UI, and acts as soon as it is installed and enabled.

## Known limits

- An agent whose working directory was a subdirectory of a deleted worktree, or whose directory lay outside the worktrees root, still cannot open its history. That is no worse than without the plugin.
- On Windows the empty directory is not read-only, since an ACL deny did not stop writes in testing. The plugin checks that the directory is empty before each link and before each removal.
- History opens that need a link run one at a time. A worktrees root on a slow or hung network mount can delay them past Paseo's plugin request timeout. Paths outside the root are never touched on disk.
- A ledger moved aside after a crash loses the links it listed. Those links stay until they are removed by hand.
- Removal checks the link and then removes it. A link replaced by something else in the moment between those two steps could still be removed.
- Two plugin processes sharing one Paseo home, for example one left orphaned by a daemon crash, could each overwrite the other's ledger entries.

## Install

Install the plugin from its directory source with the Paseo plugin command, or add the directory through Paseo's plugin management UI. Build it first with:

```bash
npm install
npm run check
```

Enable `history-cwd-fallback` in the target Paseo daemon. The plugin runs in the daemon and does not add an app surface.

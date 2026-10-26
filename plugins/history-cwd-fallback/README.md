# history-cwd-fallback

Server-only Paseo plugin for Paseo >=0.10.3 <0.14.0. It lets an archived agent whose Paseo worktree was deleted open its history again.

## The problem

Paseo shows an archived agent's timeline by starting its provider again in the agent's stored working directory (a "history" open). When that directory is gone, for example a worktree removed after its branch merged, the provider never starts. Node reports `spawn <command> ENOENT` because the directory it should run in is missing, and the timeline fails to load. Pi agents hit this, and so can any provider Paseo starts this way. A plugin hook cannot change the directory Paseo starts the provider in. The provider's launch command cannot help either, since the spawn fails before it runs.

## What it does

It registers one hook, `server.before("agent.session_open", ...)`, and never changes the request it receives.

- **History open of a missing worktree directory:** the plugin creates a link at the missing path that points to an empty, read-only directory, `<PASEO_HOME>/plugin-state/history-cwd-fallback/empty` (a junction on Windows). The provider starts there, so the timeline opens. Six seconds after the last history open that needed it, the plugin removes the link. That is long enough for the provider to start, and no longer. The provider keeps running in the empty directory, which stays valid. The agent's stored directory never changes.
- **Where it links:** only a path strictly inside Paseo's worktrees root, which is `worktrees.root` in `<PASEO_HOME>/config.json` when set and otherwise `<PASEO_HOME>/worktrees`. Containment is decided on the resolved path text, without following links. The path's parent must already exist. Every directory from the root down to that parent must be a real directory, not a link, and must hold no `.git` entry, so a link never lands inside a live git work tree. The plugin never creates a directory there. For any other missing path it does nothing, and the history read fails as it would without the plugin.
- **Present directory:** nothing happens. The provider runs in its real directory, exactly as without the plugin.
- **Any other open of a linked path:** this covers a new turn, an unarchive and a new agent. The plugin refuses it with `Working directory does not exist`, as Paseo itself refuses once the link is gone. A real turn never runs in the stand-in.

Sending a message to an archived agent whose worktree is missing works like this. Paseo first loads the agent for history, which the plugin cannot tell apart from a timeline open, so that load may create the link. Paseo then opens the agent for the turn, and the plugin refuses that open. The agent stays archived and no turn runs.

Each link is recorded in `<PASEO_HOME>/plugin-state/history-cwd-fallback/links.json` before it is made. When the plugin stops, it removes its links at once. After a crash, it removes any recorded link the next time it starts. A path is removed only while it is still a link to the plugin's own empty directory. If something wrote into that directory through a link, the plugin leaves the link in place and stops making new links until the directory is empty again. Either case writes a log line. A ledger that cannot be read is moved aside (`links.json.bad-<time>`) and logged. Links made by the running plugin are still removed, because it keeps its own record of them.

Each link and removal writes one log line. The plugin has no settings and no UI, and acts as soon as it is installed and enabled.

## Why six seconds

Paseo 0.11.1 and 0.13.0 emit no hook or event after a provider is started for a history open, so the plugin cannot drop the link the moment Pi is up. The link must outlive Pi's whole start: Paseo spawns a short MCP probe in the directory, then the real process, and Pi then checks that its session's directory exists. These timings were measured on a Mac, from the link being made to the timeline response, which bounds that check from above:

| Paseo | Idle (8 opens) | Heavy CPU load (5 opens) | Shortest link that sometimes failed |
|---|---|---|---|
| 0.11.1 | 0.86 to 1.71 s | 1.48 to 2.96 s | 1.5 s |
| 0.13.0 | 0.92 to 1.20 s | 1.36 to 2.02 s | 1.0 s |

The hold is 6 s, about twice the worst case. After that the link is not needed: the provider keeps its directory, and a loaded agent does not start again for later timeline reads.

## Known limits

- **The six-second window.** While a link exists, the missing worktree looks present to the rest of Paseo. If someone restores the agent's archived workspace in those seconds, Paseo takes its "unarchive" path instead of "restore". It does not recreate the worktree, and it rewrites the workspace record as a plain directory workspace (`kind: "directory"`, with no branch or worktree root). After the link is gone, that workspace can no longer be restored as a worktree; the git branch and its commits are unaffected. Opening an archived agent and then clicking restore within six seconds hits this. Wait a few seconds after opening the agent before you restore. Likewise, `paseo run --cwd <that path>` in the window creates a stray directory workspace at that path before the plugin refuses the agent. The plugin has no hook on workspace recovery or creation, so it cannot prevent this.
- **A crashed plugin.** If the plugin process dies while a link exists, the link stays and the refusal of other opens is off. A send to that agent can then unarchive it and run a real turn in the read-only stand-in. Paseo marks the plugin `failed` and does not restart it; a reload or daemon restart removes the link.
- **Refusal is by path text.** An alias of a live link is not refused: a different letter case in the root part on a case-insensitive disk, the real path under a symlinked worktrees root, or a symlink elsewhere that points in. Paseo stores agent directories in one form, so this needs a hand-made directory.
- **The root's own ancestors are not checked for git.** The `.git` guard covers the worktrees root and the directories below it. If `worktrees.root` is inside a git repository, a link shows in that repository's `git status` for those seconds. If the root is reached through a symbolic link, Paseo stores real paths that are outside the configured root, so the plugin does nothing.
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

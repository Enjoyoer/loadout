# merged-worker-archiver

Server-only Paseo plugin for Paseo 0.9.1. It archives worker **worktree** workspaces,
and through Paseo's own workspace archive the agents in them, once the worker branch
is merged into its base. It is **event-driven**: every finished agent turn (PM or
worker) evaluates the worktrees of that agent's project and repository within seconds.
It is **dry-run by default**: it only logs what it would do until `armed` is set in its
settings.

## What counts as merged

Checked with read-only git in the worktree (`GIT_OPTIONAL_LOCKS=0`, no prompts, never
`fetch`, never writes refs or the index):

1. **Ancestry**: `HEAD` is an ancestor of one of the existing local base refs:
   the exact `baseRef` the worktree was cut from, `refs/heads/<baseRefName>`, or that
   branch's configured upstream. The base comes from Paseo's own worktree metadata,
   `<git-dir>/paseo/worktree.json`. No metadata means no base, which means skip.
2. **Pull request** (squash merges), only when ancestry fails and `useGh` is true:
   `gh pr view <branch> --json number,state,mergeCommit,headRefOid,headRefName,baseRefName`
   must report `MERGED` with a `mergeCommit`, the same head branch, the same base
   branch, and the local `HEAD` must be contained in the merged PR head
   (`git merge-base --is-ancestor HEAD <headRefOid>`). Local commits after the PR head
   are unmerged work.

No fetch is performed. Refs are only as fresh as the last fetch made by the worker, the
PM, or Paseo's own git service; the PR path covers remote merges the local refs have not
seen yet. A fetch option was deliberately left out.

## Skip rules (fail closed)

Every decision is `skip` unless all of these pass. Reasons appear verbatim in the log.

| Reason | Rule |
|---|---|
| `not-worktree(kind)` | Only `workspaceKind: "worktree"`. `local_checkout`, `checkout`, `directory` are never touched. |
| `already-archiving` | Paseo is already archiving it. |
| `no-directory` | Workspace has no directory. |
| `pm-agent` | Any agent labelled `role=pm` (case-insensitive) or titled with a standalone `PM`. |
| `no-agents` | Worktree with no live agents (opt in with `allowAgentlessWorkspaces`). |
| `agent-running` / `agent-initializing` | Any agent running or initializing. |
| `agent-status-<s>` | Any agent in a status other than `idle` or `closed` (for example `error`). |
| `pending-permission` | Any agent has pending permissions. |
| `attention-<reason>` | `requiresAttention` for anything other than `finished`. |
| `workspace-running` / `workspace-needs_input` / `workspace-failed` | Workspace status. |
| `script-running(name)` | A workspace script or service is running. |
| `grace-period(idle, remaining)` | Latest activity (workspace activity/status time, agent updated, last user message, attention time) is younger than `graceMinutes` (default 0, so this only applies when raised). |
| `ambiguous(...)` | No activity timestamp, path not statable, empty reflog, PR merged without merge commit, PR head commit not local. |
| `path-missing` | Directory gone; left to Paseo's own reconciliation. |
| `detached-head` | No branch. |
| `no-base(...)` | No Paseo worktree metadata, or none of the base refs exist locally. |
| `branch-is-base` | The worktree is on its base branch. |
| `operation-in-progress(x)` | Merge, cherry-pick, revert, rebase, or bisect in progress. |
| `dirty(changed, untracked)` | Any staged, unstaged, or untracked change (`--untracked-files=all`). |
| `no-branch-commits` | The branch reflog has no `commit`/`cherry-pick` entry. A branch with no own commits is trivially an ancestor of its base (also after a pure rebase onto a newer base); that is "no work yet", not "merged". |
| `not-merged(...)` | Commits not contained in the base, no merged PR (`no PR`, `PR #n open`, `gh unavailable`, `no GitHub remote`, `gh disabled`). |
| `unmerged-commits(...)` | Local commits after the merged PR head. |
| `pr-head-mismatch` / `pr-base-mismatch` | The PR found is not this branch into this base. |
| `git-error(...)` / `git-timeout(...)` / `git-not-found` / `gh-error(...)` / `gh-timeout` | Any command failure. |
| `recheck: ...` | Armed only: live state is re-read and every gate re-run immediately before archiving. |

A sweep is aborted with no decisions if the daemon is unreachable or the workspace or
agent list is incomplete (pagination without a cursor), because a hidden agent could be
running. Invalid settings also abort the sweep.

## What archiving does

The only action is the official `paseo.workspaces.archive(workspaceId)` (the same
request as `paseo workspace archive`). In Paseo 0.9.1 that (`archiveByScope`):

- archives every agent in the workspace, kills its terminals, and archives the record;
- runs the project's worktree teardown commands, if any;
- if the worktree is Paseo-owned and no other active workspace references it, removes
  the directory with `git worktree remove --force` (Paseo's force, not this plugin's).
  Ignored files in the worktree (for example `node_modules`, `.env`) go with it; the
  plugin already refused if anything tracked or untracked-but-not-ignored was present;
- does **not** delete the branch. Verified in the isolated test: after archive the
  directory and its `git worktree` entry were gone and `worker-merged` still existed.

The plugin never deletes branches, never forces anything itself, and never edits
`~/.paseo/config.json`.

### Relation to Paseo's built-in `autoArchiveAfterMerge`

Paseo 0.9.1 has `daemon.autoArchiveAfterMerge`. It only fires when
the daemon itself watched a pull request go from open to merged while running, and it
ignores local merges, so locally merged worktrees stay. This plugin covers
local merges (ancestry) and PRs merged while the daemon was not watching.

## Triggers

0.9.1 has no git, PR, or merge hook. A merge is almost always performed by a PM or
worker agent inside a Paseo turn, so the turn end is the trigger.

- **`agent.turn_ended` (any agent, PMs in `local_checkout` workspaces included)**: the
  hook only records the agent's workspace id and returns (hooks abort after 30 s).
  After `eventDebounceSeconds` (default 3 s) of quiet, capped at 4x that under a
  steady stream, one scoped evaluation runs for every recorded workspace plus every
  worktree workspace with the same `projectId` **or** the same git common dir
  (`git rev-parse --git-common-dir`, realpath-normalized, cached per directory), so
  worktrees of one repository are covered even when project ids differ. A worker's
  own workspace is always included. A burst of turns becomes one evaluation.
- **Follow-ups**: when an event evaluation finds a worktree that passed every gate
  except "merged" (clean, agents idle, own commits, `not-merged(...)`), that project
  is re-checked after `followUpDelaysSeconds` (default 15 s, 60 s, 180 s; at most 5
  entries, at most 64 workspaces pending). This covers merges that land a moment after
  the turn (merge queue, `gh pr merge` returning before the ref updates). The chain
  stops once the worktree stops being a pending merge, and a new event restarts it.
- **Periodic sweep**: a slow backstop for merges made outside Paseo (GitHub web UI).
  First full sweep 30 s after load, then every `sweepIntervalMinutes` (default 60).
- `agent.archived` is observed only to pick up the subprocess `PaseoApi`.

Each finished turn logs one `event` line; each evaluation ends with `sweep-done`
including `trigger`, `pendingMerge`, and `latencyMs` (first coalesced event to end of
evaluation). Permission and attention state are read from agent snapshots at decision
time. Sweeps are serialized; there is no per-sweep archive cap.

## Settings

Host-scoped plugin settings (`server.registerSettings`), stored by Paseo at
`<PASEO_HOME>/plugin-settings/merged-worker-archiver/config.json` as
`{"version":1,"values":{...}}`. Missing file means all defaults. Unknown keys or wrong
types make the settings invalid, which stops all evaluation. The retired key
`maxArchivesPerSweep` (the cap was removed) is accepted and ignored so existing files
keep loading. Settings are re-read before
every sweep, so edits take effect on the next sweep without a reload.

| Key | Default | Meaning |
|---|---|---|
| `armed` | `false` | `true` allows real archiving. Anything else is dry-run. |
| `sweepIntervalMinutes` | `60` | Backstop full-sweep interval (1 to 1440). |
| `graceMinutes` | `0` | Minimum idle time before archiving (0 to 10080). A merged branch means the PM already integrated the work; raise it to keep an inspection window. |
| `eventDebounceSeconds` | `3` | Coalescing window after a turn ends (0 to 60). |
| `followUpDelaysSeconds` | `[15, 60, 180]` | Re-checks for clean, idle, not-yet-merged worktrees (at most 5, each 1 to 3600). |
| `commandTimeoutSeconds` | `15` | Per git/gh call timeout. |
| `useGh` | `true` | Use `gh pr view` for squash-merged PRs. |
| `allowAgentlessWorkspaces` | `false` | Also consider worktrees with no live agents. |
| `logNonCandidates` | `false` | Also log a line for non-worktree workspaces. |

## Logs

One stdout line per decision (`paseo plugin logs merged-worker-archiver`):

```
[merged-worker-archiver] {"action":"would-archive","workspaceId":"wks_...","name":"...","agentIds":["..."],"branch":"opc/x","base":"main","reason":"merged-ancestry(refs/remotes/origin/main)"}
```

`action` is `skip`, `would-archive` (dry-run), `archived`, or `archive-failed`. Each
evaluation ends with a `sweep-done` summary; failures log `sweep-aborted`. Non-worktree
workspaces are counted in the summary only unless `logNonCandidates` is on.

## Daemon access and version bound

`PluginServerContext` has no Paseo SDK handle, so a timer-driven sweep has nothing to
call until a hook runs. The plugin therefore:

- reuses the subprocess-wide `PaseoApi` from hook context once any hook has fired (the
  docs state it lives as long as the plugin subprocess), and
- otherwise opens a short-lived connection with the **public** `createPaseoClient()`
  from `@getpaseo/client` (no internal exports), resolved from `PASEO_HOST`, then
  `$PASEO_HOME/paseo.pid`, then `127.0.0.1:6767`.

`paseo-plugin.json` pins `"paseo": ">=0.9.2 <0.11.0"` and `package.json` pins
`@getpaseo/client` to exactly `0.9.2`: the plugin depends on 0.9.1 archive semantics
(directory removal, branch kept), the worktree metadata location, and snapshot field
names. Those were checked against 0.9.2 and 0.10.1; other 0.10 releases are admitted
without that check. Re-check them before admitting 0.11.

Paseo compiles the plugin from source with esbuild and bundles `@getpaseo/client`
(with `@getpaseo/protocol`), about 8.4 MB, so `npm install` must have run here before
install or reload. Loading takes about 10 s.

## Develop and verify

```bash
npm install
npm run check          # typecheck + unit tests (node:test, fake git/gh) + esbuild bundle (to node_modules/.cache)
npm run dry-run -- --host 127.0.0.1:6767          # read-only table against a live daemon
npm run dry-run -- --grace 0 --config <settings.json>
```

`scripts/dry-run.ts` sweeps with `armed: false` and `forceDryRun: true`, so every decision returns at the `would-archive` log line before the archive call is reached.

## Install and arm (PM, after owner approval)

```bash
cd "<this folder>" && npm install && npm run check
paseo plugin install "$PWD"                      # production daemon, starts in dry-run
paseo plugin ls                                  # expect: merged-worker-archiver running
paseo plugin logs merged-worker-archiver         # review would-archive / skip lines
```

Arm only after reviewing dry-run output, by writing the plugin settings file (not
`~/.paseo/config.json`):

```bash
mkdir -p ~/.paseo/plugin-settings/merged-worker-archiver
printf '%s\n' '{"version":1,"values":{"armed":true}}' > ~/.paseo/plugin-settings/merged-worker-archiver/config.json
```

Disarm by setting `armed` to `false` (takes effect at the next evaluation) or
`paseo plugin disable merged-worker-archiver`.

Upgrading an installed copy (directory install): `npm install && npm run check`, then
`paseo plugin reload merged-worker-archiver` and confirm `running` in `paseo plugin ls`.
Existing settings files keep loading; `maxArchivesPerSweep` is ignored.

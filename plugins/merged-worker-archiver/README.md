# merged-worker-archiver

Server-only Paseo plugin. Requires Paseo 0.15. It archives worker **worktree** workspaces,
and through Paseo's own workspace archive the agents in them, once the worker branch
is merged into its base. It is **event-driven**: every finished agent turn (PM or
worker) evaluates the worktrees of that agent's project and repository within seconds.
It is **dry-run by default**: it only logs what it would do until `armed` is set in its
settings.

Full sweeps run two more paths, each with its own switch:

- **Workspace cleanup** (`armWorkspaceCleanup`): archives the record of an idle, agentless
  project checkout or local workspace, archives an idle agentless worktree whose branch is
  merged and whose tree is clean, and tells the owning PM once about an idle agentless
  worktree it keeps. That PM may run on another Paseo daemon (`peerHosts`).
- **Stale sweep** (`staleSweep`, off by default): tells each PM once a day about its non-PM
  agents idle for 3 days and its worktree or scratch workspaces with no live agent, and
  archives them instead for PMs or projects that opt in (`staleArchiveAll` opts in all).

No workspace is archived while one of its live agents has an active or paused heartbeat or
is owed a usage-limit-auto-resume resume (see Skip rules, `heartbeat` and `auto-resume`).

## What counts as merged

Checked with read-only git in the worktree (`GIT_OPTIONAL_LOCKS=0`, no prompts, inherited
`GIT_*_PATHSPECS` modes removed, never `fetch`, never writes refs or the index):

1. **Ancestry**: `HEAD` is an ancestor of one of the existing local base refs:
   the exact `baseRef` the worktree was cut from, `refs/heads/<baseRefName>`, or the base
   branch's configured upstream (`<baseRefName>@{upstream}`, else
   `refs/remotes/origin/<baseRefName>`). A candidate naming the worker branch itself, such
   as the `refs/remotes/origin/<branch>` that `git push -u` sets as its upstream, is never
   used. The base comes from Paseo's worktree metadata, `<git-dir>/paseo/worktree.json`.
   No metadata means no base, which means skip.
2. **Pull request** (squash merges), only when ancestry fails and `useGh` is true:
   `gh pr view <branch> --json number,state,mergeCommit,headRefOid,headRefName,baseRefName`
   must report `MERGED` with a `mergeCommit`, the same head branch, the same base
   branch, and the local `HEAD` must be contained in the merged PR head
   (`git merge-base --is-ancestor HEAD <headRefOid>`). Local commits after the PR head
   are unmerged work.

No fetch is performed, deliberately. Refs are as fresh as the last fetch by the worker, the
PM, or Paseo's git service; the PR path covers remote merges the local refs have not seen.

## Finished workspaces without a PR

Review agents and abandoned lanes never merge. With `archiveFinishedWithoutPr` (default
`true`) a worktree that is not merged is still archived when all of these hold:

1. It is a Paseo `worktree` workspace whose real path is strictly inside
   `<PASEO_HOME>/worktrees` (compared case-insensitively on Windows), and not the root of
   any Paseo project. Local checkouts and directory workspaces never qualify.
2. It passes every agent and workspace gate below (all agents `idle` or `closed`, nothing
   running, no pending permission or attention), and its latest activity is at least
   `finishedGraceMinutes` ago (default 120, never less than `graceMinutes`).
3. No agent is a PM, and no agent has the label `noarchive` (any value).
4. It passes the merged path's cleanliness gates, except for ignored files: no operation in
   progress, no changed or untracked file, no non-empty submodule directory, and no ignored
   file except **regenerable output**: a path with a segment `node_modules`, `__pycache__`,
   `.pytest_cache`, `.venv`, `.turbo`, `.next`, `.cache`, or `coverage`, or a file name
   ending in `.tsbuildinfo`. `dist` and `build` do not count. An ignored file whose name
   matches `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, or `id_ecdsa*` (any case)
   blocks even inside a regenerable directory (`git ls-files --others --ignored` lists
   them), as does any other ignored file and any path git prints quoted.
5. It has no unpushed commits, checked live: `git ls-remote --heads` must succeed for every
   remote, and `HEAD` must be contained in (or equal to) a listed head commit that is
   present locally. Remote-tracking refs are not trusted; an offline or failing remote is
   a skip.
6. Every remote is a `github.com` remote, and `gh pr list -R github.com/<owner/repo> --head
   <branch> --state open` returns no PR for each repository. gh runs without `GH_HOST` and
   `GH_ENTERPRISE_TOKEN`, so it cannot query another host, and needs `useGh`. Another host,
   or gh disabled, missing, or failing for any repository, is a skip.

Only these merge-check results fall through to this path: `dirty(ignored=N)`,
`not-merged(...)`, `no-branch-commits`, `no-base(...)`, `branch-is-base`,
`unmerged-commits(...)`, `pr-head-mismatch`, `pr-base-mismatch`. Every error, dirty, or
ambiguous result stays a skip. A skip keeps the merge reason first and appends the no-PR
reason, for example `not-merged(ahead=2 of refs/heads/main; no PR); no-pr: unpushed-commits(...)`.
The archive reason is `finished-no-pr(pushed(live <remote>))`. The archive is the same call,
cap, back-off and armed re-check as the merged path (dry-run logs `would-archive`), and
never deletes the branch.

## Skip rules (fail closed)

Non-worktree workspaces also qualify as `empty-disposable-workspace` when their absolute cwd
is strictly under `<PASEO_HOME>/worktrees` (default `~/.paseo/worktrees`) or
`~/.cache/fleet-scratch` (`%USERPROFILE%\.cache\fleet-scratch` on Windows), with both
lexical and real paths in the same root. The root itself, missing or unresolvable paths,
and symlinks escaping the root do not qualify. They need **no non-archived agents**, no
running scripts, a non-blocking workspace status, and activity older than `graceMinutes`.
This rule ignores `allowAgentlessWorkspaces`, needs no git check, and archives the workspace
record, not the scratch folder. Other local workspaces, including project checkouts, are
archived only by armed workspace cleanup.

Every decision is `skip` unless its applicable gates pass. Reasons appear verbatim in the log.

| Reason | Rule |
|---|---|
| `not-worktree(kind)` | Non-worktree outside the disposable roots (including project checkouts), or containment cannot be established. |
| `non-archived-agents` | Disposable non-worktree still has any non-archived agent, even idle or closed. |
| `empty-disposable-workspace` | Archive reason: non-worktree under a disposable root, no non-archived agents, no running scripts, status and grace gates passed. |
| `already-archiving` | Paseo is already archiving it. |
| `no-directory` | Workspace has no directory. |
| `pm-agent` | Any agent labelled `role=pm` (case-insensitive) or titled with a standalone `PM`. |
| `no-agents` | Worktree with no live agents (opt in with `allowAgentlessWorkspaces`). In a full sweep, workspace cleanup decides it instead. |
| `agent-running` / `agent-initializing` | Any agent running or initializing. |
| `agent-status-<s>` | Any agent in a status other than `idle` or `closed` (for example `error`). |
| `pending-permission` | Any agent has pending permissions. |
| `attention-<reason>` | `requiresAttention` for anything other than `finished`. |
| `workspace-running` / `workspace-needs_input` / `workspace-failed` | Workspace status. |
| `script-running(name)` | A workspace script or service is running. |
| `heartbeat(<ids>) on agent <id>; else archivable: ...` | A live agent in the workspace is the target of an active or paused schedule (a heartbeat, `target.agentId`). Archiving would archive the agent, and Paseo would complete its schedules. Delete or move it (`paseo schedule delete <id>`) and the next sweep archives. `heartbeats-unknown(...)`: the schedule list could not be read, which blocks every archive of a workspace with a live agent. |
| `auto-resume(<records>) on agent <id>; else archivable: ...` | usage-limit-auto-resume still owes a live agent a resume: a record for it in `<PASEO_HOME>/plugin-state/usage-limit-auto-resume/state.json` that is not settled (`detected`, `parked`, `resuming`, `verifying`, `uncertain`; only `done`, `exhausted`, `opted-out` and `superseded` are settled). Archiving would supersede it, and a weekly quota hold can wait days. `auto-resume-unknown(...)`, for example `auto-resume-unknown(installed, state file missing)`: the file cannot be read or parsed, or is missing while that plugin is installed (per the daemon's plugin list, which must be readable); this blocks every archive of a workspace with a live agent. A missing file without the plugin means no records. |
| `grace-period(idle, remaining)` | Latest activity (workspace activity/status time, agent updated, last user message, attention time) is younger than `graceMinutes` (default 0). |
| `ambiguous(...)` | No activity timestamp, path not statable, empty reflog, PR merged without merge commit, PR head commit not local, a submodule path that is not UTF-8, a git top level (`rev-parse --show-toplevel`, only its line end removed) whose realpath is not the workspace directory's. |
| `path-missing` | Directory gone; left to Paseo's own reconciliation. |
| `detached-head` | No branch. |
| `no-base(...)` | No Paseo worktree metadata, or none of the base refs exist locally. |
| `branch-is-base` | The worktree is on its base branch. |
| `operation-in-progress(x)` | Merge, cherry-pick, revert, rebase, or bisect in progress. |
| `dirty(changed, untracked, ignored)` | Any staged, unstaged, or untracked change (`--untracked-files=all`), or any git-ignored file (`--ignored=matching`); only ignored files reports `dirty(ignored=N)`, `N` counting the paths git lists (an ignored directory once). On the merged path every ignored file blocks, `node_modules` and `dist` included, by the owner's choice of safety over cleanup: delete such output or archive by hand. The no-PR path and agentless cleanup skip regenerable output (item 4 above), and report a sensitive name inside it as `dirty(sensitive-ignored=n:path)`. |
| `submodule(path)` | A submodule directory (a gitlink in the index, `git ls-files --stage` from the worktree top level) that is not an empty, real directory. The superproject's status cannot vouch for it (`submodule.<name>.ignore`, `diff.ignoreSubmodules`, unlisted ignored files, invisible files in an unpopulated directory). An empty directory does not block; a symlink or junction in its place does. |
| `no-branch-commits` | The branch reflog has no `commit`/`cherry-pick` entry: a branch with no own commits is trivially an ancestor of its base, which means "no work yet", not "merged". |
| `not-merged(...)` | Commits not contained in the base, no merged PR (`no PR`, `PR #n open`, `gh unavailable`, `no GitHub remote`, `gh disabled`). |
| `unmerged-commits(...)` | Local commits after the merged PR head. |
| `pr-head-mismatch` / `pr-base-mismatch` | The PR found is not this branch into this base. |
| `git-error(...)` / `git-timeout(...)` / `git-not-found` / `gh-error(...)` / `gh-timeout` | Any command failure. |
| `...; no-pr: <reason>` | Not merged, and the no-PR path also skipped it: `noarchive-label`, a grace or agent gate, a cleanliness gate, `project-root`, `outside-paseo-worktrees`, `dirty(sensitive-ignored=n:path)`, `unpushed-commits(...)`, `pr-open(owner/repo#n)`, `pr-unknown(...)` (gh disabled or unavailable, or a non-GitHub remote), `gh-error(...)`, `gh-timeout(...)`, or a failed `ls-remote` as `git-error(...)`. |
| `recheck: ...` | Armed only: live state is re-read and every gate re-run immediately before archiving. |

A sweep is aborted with no decisions, on every path, if the daemon is unreachable, the
workspace or agent list is incomplete (pagination without a cursor, since a hidden agent
could be running), the project list is unavailable, fails, or has a project without a root
path, or the settings are invalid.

## What archiving does

The only action is the official `paseo.workspaces.archive(workspaceId)` (the same
`archive_workspace_request` as `paseo workspace archive`), handled by `archiveByScope`
(workspace scope). It:

- stops the workspace's setup, archives every agent in it (ending their heartbeats and
  superseding any owed resume, hence the gates above), kills its terminals, and archives
  the record;
- for a Paseo-owned worktree that no other active workspace references, runs the project's
  worktree teardown commands and removes the directory with `git worktree remove --force`
  (Paseo's force). The plugin already refused any changed, untracked, or ignored file
  except regenerable output, and any non-empty submodule directory, so only clean,
  committed content is removed;
- does **not** delete the branch.

A `local_checkout` or `directory` record never claims to be Paseo-owned (cleanup skips one
that does, `paseo-owned-worktree-record`), so archiving it runs no teardown and deletes no
file. Archiving a project's last or main checkout record does **not** remove the project:
`project ls` still lists it, and opening the folder again makes a new record in the same
project. Only `project.remove` archives a project's workspaces, and `orphan-project-sweeper`
removes a project only when its root folder is gone.

The plugin never deletes branches, never forces anything itself, and never edits
`~/.paseo/config.json`.

Paseo's built-in `daemon.autoArchiveAfterMerge` fires only when the daemon itself watched a
pull request go from open to merged while running, and ignores local merges. This plugin
covers local merges (ancestry) and PRs merged while the daemon was not watching.

## Workspace cleanup

In every **full sweep** (the startup sweep and the backstop every `sweepIntervalMinutes`,
never the event-driven ones) the workspaces the worker path leaves alone, project checkouts
and other local workspaces (`not-worktree(...)`) and worktrees with no live agent
(`no-agents`), go to workspace cleanup, which has two paths:

- **Stale record** (`cleanup: "stale-record"`, a `local_checkout` or `directory` workspace):
  archive the workspace record. No file is touched.
- **Agentless worktree** (`cleanup: "agentless-worktree"`): archive it when its branch is
  merged and its tree is clean, by the worker path's merge test
  (`stale-agentless-merged(...)`), removing a Paseo-owned worktree's directory. Ignored files
  count as on the no-PR path (item 4), so `dirty(ignored=N)` and
  `dirty(sensitive-ignored=n:path)` are possible. Any other result in the tables keeps it,
  and its PM is told once (`notify`).

Both paths first need all of these, else the line is `skip` with the reason shown:

| Reason | Rule |
|---|---|
| `already-archiving` / `no-directory` | Paseo is already archiving it, or it has no directory. |
| `agents(n)` | Any non-archived agent in any status, background agents included. |
| `pinned` / `noarchive-label` | Pinned in Paseo, or a `noarchive` workspace label. |
| `workspace-<status>` | Workspace status is not `done`. |
| `setup-running` | Workspace setup is still running. |
| `script-<lifecycle>(name)` | A workspace script or service is not `stopped`. |
| `terminals(n)` | A live terminal belongs to the workspace. |
| `ambiguous(no activity timestamp)` | Paseo gives no timestamp at all. |
| `recent(idle, stale after)` | Last activity is younger than `staleWorkspaceMinutes` (default 4320, 3 days). |
| `path-missing(left to Paseo)` / `ambiguous(path not statable)` | The directory is gone, or cannot be checked. |
| `paseo-owned-worktree-record` | A non-worktree record that claims a Paseo-owned worktree (`worktreeSlug` or `gitRuntime.isPaseoOwnedWorktree`). |

### Activity

Last activity is the newest of:

- the workspace's `createdAt`, `statusEnteredAt` (see below), `activityAt` and
  `lastUserMessageAt`;
- for every agent the workspace ever held, archived ones included: `createdAt`,
  `lastUserMessageAt`, `attentionTimestamp`, and `updatedAt` (see below);
- every agent's newest delivered message, from message receipts (below), at most its
  `archivedAt`;
- for an archived agent, the end of its last turn: `min(archivedAt, newest input + 12 h)`,
  its inputs being its `createdAt`, `lastUserMessageAt` and newest delivered message;
- for a worktree, the committer date of its HEAD commit (`git log -1`). A worktree whose HEAD
  git cannot read is skipped as `ambiguous(HEAD commit unreadable)`.

Archiving is not activity. Paseo stamps the archive time on both `archivedAt` and
`updatedAt` and clears `attentionTimestamp`, so an archived agent's `updatedAt` counts only
when earlier than its `archivedAt`, and `archivedAt` serves only as the cap above; the 12 h
allowance covers work after the newest input.

**Message receipts.** Messages from other agents (a PM's `paseo send`) do not set the
recipient's `lastUserMessageAt`. The daemon writes a receipt for every
`send_agent_message_request` that carries a `messageId` (the CLI and app always set one):
`<PASEO_HOME>/agent-requests/<sha256>.json` with the recipient's `agentId`, written
`pending`, rewritten `completed` on delivery, so its modification time is the delivery time.
The plugin reads them without writing, counts `completed` and `pending` ones, and reads only
files modified within `staleWorkspaceMinutes` plus 12 h. If the directory or a receipt
cannot be read (missing included), archive times count instead and `sweep-done` shows
`receiptsUnreadable`. Messages sent through Paseo's MCP tools write no receipt.

**`statusEnteredAt`** counts only when earlier than the newest `archivedAt` of the
workspace's agents, since a long-lived session stamps it when the last busy agent leaves.

Paseo exposes no record `updatedAt` and no script start or stop time, and reports
`activityAt` as null; a running script or live terminal blocks cleanup instead. File edits
made outside Paseo and not committed are not activity.

### Messages to the PM

A kept agentless worktree is reported once, with its path, branch, last commit, age since
last activity, and why it was kept. The owner is the parent named by the
`paseo.parent-agent-id` (full id) or `parent` (id prefix) label of the worktree's last agent,
when that parent is live. Otherwise it is the one live agent labelled `role=pm` whose
`project` label matches, case-insensitively, the last agent's `project` label or the
workspace's project name. The owner is resolved again just before sending. With several, or
with none here and none on a peer daemon, the plugin logs `notify-unrouted` and sends
nothing. Each PM gets one message per sweep listing at most 20 worktrees (`notify-deferred`
for the rest).

**Send rule** (every message this plugin sends, local, peer or stale): right before the send
the PM's status is read again, and the message goes out only while it is idle or closed, not
archived, and without a pending permission; otherwise it logs a deferral (`why` such as
`PM running` or `PM error`) and retries at the next full sweep, since a message would interrupt a turn, clear a permission request, or
unarchive the PM. It is sent with `activeTurnBehavior: "steer"`, so a turn that starts in
between gets the text added instead of replaced, and with a fixed `messageId`, so the daemon
drops a duplicate. With `staleSweep` on, kept worktrees go into the stale sweep's daily
message instead of a separate report.

Reported worktrees are kept in `<PASEO_HOME>/plugin-state/merged-worker-archiver/notified.json`
(owner-only), written before the message goes out, so a worktree is never reported twice:

- `sent`: delivered;
- `unconfirmed`: the send failed in a way that may have delivered it; never resent;
- `sending`: the plugin stopped between the two writes; never resent.

A send refused before delivery (`Agent not found`) is retried. Armed sweeps prune entries of
worktrees no longer listed. To report a worktree again, delete its entry, or the file, while
the plugin is stopped. A file that cannot be read (anything but missing) blocks every report
and logs `notify-state-unreadable` until fixed.

#### PMs on other daemons

With `peerHosts` set (default empty), a worktree with no owner on this daemon is looked up
on those daemons in order. Each is reached as the Paseo CLI reaches an `ssh://<alias>` host,
without the CLI: `ssh -o BatchMode=yes` (the `ssh` on the daemon's `PATH`, no shell) to the
peer daemon's port (6767) on that host's loopback, then the plugin's bundled `DaemonClient`,
so any `paseo` CLI version on `PATH` does not matter. One connection per peer serves a sweep.
On macOS and Linux the tunnel is Paseo's own `ssh -W`. On Windows, where Win32-OpenSSH never
answers `ssh -W` through a pipe, it is `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:6767` run
by a small windowless watchdog on the daemon's `node`, which ends `ssh` when the sweep closes
the connection, the plugin goes away, or the peer budget ends.

1. The last agent's `paseo.parent-agent-id` (full id; `parent` is not used): a live, not
   archived agent with exactly that id on the peer.
2. Otherwise the peer's live `role=pm` agents whose `project` label matches as above.

The owner must be unique across all peers: the parent on exactly one peer, else exactly one
project PM across all of them. Several matches log `notify-unrouted` with `several owners on
peers`, none logs `no owner on peers`; both list the `peers` asked. A failing peer logs one
`notify-peer-error` line (`peer`, `query`, `error`; `query` is `connect`, `parent`, `list`,
`state` or `send`, and a failed connect names the `ssh` error) and is asked nothing more that
sweep. While a peer has failed and the parent was not found elsewhere, no project PM is
chosen: `notify-unrouted` with `owner unknown on peers` and `peerErrors`. Nothing is recorded
for an unrouted worktree, so the next full sweep tries again.

Each peer call is bounded by `commandTimeoutSeconds`, and all peer work in one sweep by twice
that per listed peer (60 s with the default and two peers); once spent, a peer asked again
logs `notify-peer-error` with `peer time budget spent`.

Peers are asked only after every local report is sent. A peer send follows the send rule;
its `notified.json` entry names the peer as `host`, and its log lines carry `host` and `via`
(`peer-parent` or `peer-project-pm`). A send that cannot have been delivered (no connection,
budget spent, `Agent not found`) is retried at the next full sweep; any other failure, a
timeout included, is recorded `unconfirmed`. Dry-run sweeps look peers up read-only and log
`would-notify` with `host`.

Requirements and limits:

- `ssh://<alias>` is the only accepted form (letters, digits, `.`, `_`, `-`; at most 8 unique
  entries); a user, port, path or `daemonPort` makes the settings invalid, so the peer daemon
  must listen on port 6767. User, port and key belong in the ssh config of the daemon's account.
- SSH to each alias must work without a prompt (`BatchMode=yes`). No password is sent to a
  peer daemon, so one that requires a password refuses the connect.
- Project PMs are found only among agents the peer lists without `includeBackground`; a
  parent id is still found.

### Background workspaces and cleanup listings

Every sweep sets `filter.includeBackground` on its workspace and agent listings, as
`orphan-project-sweeper` does. Full sweeps also list every agent with the archived ones
(capped at 50 pages of 200) and the terminals. If that listing or the terminal list fails or
is incomplete, the sweep logs `cleanup-skipped` (and `cleanupSkipped` in `sweep-done`) and
runs only the worker path; an armed cleanup action whose fresh re-read fails is skipped or
deferred the same way. A daemon with more than 10,000 agents, archived included, skips
cleanup until the cap is raised. A failed workspace, live agent or project list still aborts
the whole sweep.

### Arming

Cleanup acts only when `armed` and `armWorkspaceCleanup` are both `true`. Otherwise every
cleanup decision logs `would-archive` or `would-notify`, writes no state and sends nothing;
with only `armed` on, these previews take no slot of `maxArchivesPerSweep`. An armed sweep
re-reads live state and re-runs every gate just before each archive and send. `sweep-done`
adds `cleanupMode`, `cleanup` (counts by action, `alreadyNotified` included) and `reports`.

## Stale sweep

Off by default (`staleSweep`). When on, every full sweep also looks for stale items on this
daemon and tells their PM, at most once a day:

1. **Agents**: every live non-PM agent (no `role=pm` label, no standalone `PM` in its title),
   not running or initializing, whose last activity is at least `staleAgentMinutes` ago
   (default 4320). Activity is the newest of its `createdAt`, `updatedAt`,
   `lastUserMessageAt`, `attentionTimestamp` and newest delivered message (see Activity).
2. **Workspaces**: every `worktree` workspace, and every workspace under a disposable root
   (`<PASEO_HOME>/worktrees`, `~/.cache/fleet-scratch`), with no live agent and no activity
   for at least `staleWorkspaceMinutes`, dated as in Activity. A missing directory is left
   to Paseo.

Never flagged or archived: PMs; anything a `staleExclude` entry matches (an agent id, a
workspace id, or a label as `key` or `key=value`, for example `keep=1`; an agent also
through its workspace's id or labels, a workspace also through the labels of any agent it
held); pinned workspaces and their agents; and anything labelled `noarchive`. `staleExclude`
does not affect workspace cleanup's kept-worktree report.

**The PM.** Up the item's parent labels, `paseo.parent-agent-id` or `parent` (for a
workspace, those of its last agent), through live agents to the first PM, at most 8 links,
so a sub-worker goes to its worker's PM. Else the one live `role=pm` agent matching the
item's `project` label or workspace project name. With none here, the `peerHosts` daemons
are asked as in PMs on other daemons, except that a parent found on a peer that is not a PM
is climbed there to the first PM, and with none above it the project names met on the way
are matched to a peer's `role=pm` agent. With none or several, the item is logged
`stale-unrouted` once a day and nothing is sent, unless `staleArchiveAll` is on (below).

**Messages.** Each PM gets one message listing its items (at most 50): name and id, status
or kind, where, branch, idle time and, when known, why it cannot be archived now
(`heartbeat(<id>)`, `live-children(n)`, `auto-resume(<record>)`, `not-merged(...)`, ...).
Workspace cleanup's kept worktrees (with `armWorkspaceCleanup` and `armed` on) go first in
the same message, at most 20, each still reported once (`notified`, `notified.json`), to the
PM found as above. One that turns up after the day's message waits for the next
(`notify-deferred`). Sends follow the send rule (deferral logged `stale-flag-deferred`). A PM
messaged within the last 23 hours gets nothing more, and an item listed within 23 hours is
not listed again (23, so the hourly backstop keeps a daily rhythm despite drift). The hold is
per daemon: a PM several daemons reach gets at most one message a day from each. The record
is `<PASEO_HOME>/plugin-state/merged-worker-archiver/stale-flags.json` (owner-only), written
`sending` before a message goes out, so a possibly delivered attempt is not repeated that
day. An unreadable file stops the stale sweep (`stale-skipped`) until fixed or removed.

**Opt-in archive.** Items whose PM is in `staleArchivePms` (agent ids) or whose project is
in `staleArchiveProjects` (names, case-insensitive) are archived instead of flagged, only
while `armed` is true; otherwise they are flagged and `would-archive` is logged.
`staleArchiveAll` (default false) opts in every stale item, including unrouted ones; there
is no `*` project match. An item archived only because of it logs `stale-archived` (or
`would-archive`) with `reason` `staleArchiveAll`, and an unrouted one has no `owner` and
nobody is told. Every gate, `staleExclude`, pinned and `noarchive` is re-checked on a fresh
read right before the archive:

- An agent must be idle or closed, with no pending permission, no attention other than
  `finished`, no live agent naming it as parent, no active or paused heartbeat (an unreadable
  schedule list blocks), and no unsettled usage-limit-auto-resume record
  (`auto-resume(<record>)`, `auto-resume-unknown(...)`, as in Skip rules). It is archived
  alone (`paseo archive <id>`); no workspace or file is touched.
- A workspace must get an archive decision from the worker path or workspace cleanup: a
  merged, clean, stale agentless worktree (`stale-agentless-merged(...)`) or an empty
  disposable workspace (`empty-disposable-workspace`). An unmerged or dirty worktree is
  flagged with the reason, never archived. `armWorkspaceCleanup` is not needed here.

Opt-in archives log `stale-archived` and take at most `maxArchivesPerSweep` per sweep
(counted apart from the worker pass). The rest log `stale-deferred` and are flagged or logged
`stale-unrouted` with `maxArchivesPerSweep=N reached`. An item that fails a gate is flagged
with the reason (`stale-archive-skipped`) or logged `stale-unrouted`. A failed stale archive
(refused re-check, error or throw) backs off as in Back-off below, logged `stale-backoff`;
previews and unarmed sweeps do not count toward it, and an item no longer stale is forgotten.

**Hosts.** Only this daemon's agents and workspaces are swept, by its own settings; peers are
only asked who the PM is.

`sweep-done` adds `stale` with counts (`stale`, `flagged`, `messages`, `held`, `deferred`,
`archived`, `backoff`, `unrouted`, `excluded`, `kept`, `pm`, and for kept worktrees
`reported`, `reportDeferred`, `reportUnrouted`, `wouldNotify`, ...); its `reports` lists the
kept worktrees reported.

## Triggers

Paseo has no git, PR, or merge hook; a merge is almost always made inside a Paseo turn, so
the turn end is the trigger.

- **`agent.turn_ended`** (any agent, PMs in `local_checkout` workspaces included): the hook
  only records the agent's workspace id and returns (hooks abort after 30 s). After
  `eventDebounceSeconds` (default 3 s) of quiet, capped at 4x that under a steady stream,
  one scoped evaluation runs for every recorded workspace plus every worktree workspace with
  the same `projectId` **or** the same git common dir (`git rev-parse --git-common-dir`,
  realpath-normalized, cached per directory).
- **Follow-ups**: a worktree that passed every gate except "merged" (`not-merged(...)`) gets
  its project re-checked after `followUpDelaysSeconds` (default 15 s, 60 s, 180 s; at most
  5 entries, at most 64 workspaces pending), for merges that land just after the turn
  (merge queue, `gh pr merge` returning before the ref updates). A new
  event restarts the chain.
- **Periodic sweep**: backstop for merges made outside Paseo. First full sweep 30 s after
  load, then every `sweepIntervalMinutes` (default 60).
- **`agent.archived`**: schedules its workspace for a debounced evaluation.

Each finished turn logs one `event` line; each evaluation ends with `sweep-done` including
`trigger`, `pendingMerge`, and `latencyMs` (first coalesced event to end of evaluation).
Permission and attention state are read from agent snapshots at decision time. Sweeps are
serialized.

## Per-sweep cap

One sweep makes at most `maxArchivesPerSweep` archive attempts (default 5). An armed call
that fails still uses a slot; a workspace that fails the armed re-check does not. Dry-run
applies the same cap, order, and back-offs to `would-archive`. Further eligible workspaces
get a `deferred` line and go first in a later sweep. In `sweep-done`, `counts.archive`
covers the candidates within the cap and `counts.deferred` the rest (also `deferred`), for
example `"archive":5,"deferred":2`.

### Fair order across sweeps

Each sweep visits first the workspaces an earlier armed sweep deferred at the cap,
longest-waiting first, then the rest in listing order. A deferred workspace keeps its place
until attempted or no longer eligible, so in full sweeps a workspace that stays eligible is
attempted within about (eligible candidates / `maxArchivesPerSweep`) sweeps. Scoped sweeps
attempt only their scope. The queue lives in memory; every full sweep drops workspaces no
longer listed, and only armed sweeps otherwise change it.

### Back-off after a failed archive call

A workspace whose armed archive call fails (error result or throw) sits out the next sweeps
that find it eligible: 1 after its first consecutive failure, then 2, 4, and at most 8, with
a `backoff` line and no slot taken. It is then retried; a successful archive clears it.
Back-offs live in memory, and a full sweep forgets workspaces no longer listed. Dry-run
sweeps that find it eligible advance the back-off too, so a preview may not match the next
armed sweep. In `sweep-done`, backed-off workspaces count as `counts.backoff` (also
`backoff`), never as `archive` or `deferred`.

## Settings

Host-scoped plugin settings (`server.registerSettings`), stored by Paseo at
`<PASEO_HOME>/plugin-settings/merged-worker-archiver/config.json` as
`{"version":1,"values":{...}}`. Missing file means all defaults. Unknown keys or wrong
types make the settings invalid, which stops all evaluation. Settings are re-read before
every sweep, so edits take effect without a reload.

| Key | Default | Meaning |
|---|---|---|
| `armed` | `false` | `true` allows real archiving. Anything else is dry-run. |
| `maxArchivesPerSweep` | `5` | Archive attempts per sweep (see Per-sweep cap). A whole number of at least 1; anything else makes the settings invalid. |
| `sweepIntervalMinutes` | `60` | Backstop full-sweep interval (1 to 1440). |
| `graceMinutes` | `0` | Minimum idle time before archiving (0 to 10080). Raise it to keep an inspection window. |
| `eventDebounceSeconds` | `3` | Coalescing window after a turn ends (0 to 60). |
| `followUpDelaysSeconds` | `[15, 60, 180]` | Re-checks for clean, idle, not-yet-merged worktrees (at most 5, each 1 to 3600). |
| `commandTimeoutSeconds` | `15` | Per git/gh call timeout. |
| `useGh` | `true` | Use `gh pr view` for squash-merged PRs. |
| `allowAgentlessWorkspaces` | `false` | Also consider worktrees with no live agents. |
| `logNonCandidates` | `false` | Also log a line for non-worktree workspaces. |
| `armWorkspaceCleanup` | `false` | `true` (with `armed`) lets workspace cleanup archive and message PMs. |
| `staleWorkspaceMinutes` | `4320` | Idle time before workspace cleanup acts (1 to 525600). |
| `archiveFinishedWithoutPr` | `true` | Also archive finished, clean, pushed worktrees with no open PR. |
| `finishedGraceMinutes` | `120` | Minimum idle time for that path (0 to 10080); the larger of this and `graceMinutes` applies. |
| `peerHosts` | `[]` | Other Paseo daemons, as `ssh://<alias>` (at most 8, unique), asked in order for a PM this daemon lacks. Any other form makes the settings invalid. |
| `staleSweep` | `false` | `true` turns on the stale sweep (flagging needs only this switch). |
| `staleAgentMinutes` | `4320` | Idle time before the stale sweep flags a non-PM agent (1 to 525600). |
| `staleArchivePms` | `[]` | PM agent ids whose stale items are archived instead of flagged (at most 100). |
| `staleArchiveProjects` | `[]` | Project names (case-insensitive), likewise (at most 100). |
| `staleArchiveAll` | `false` | `true` opts every stale item in to that archive, unrouted ones included. |
| `staleExclude` | `[]` | Agent ids, workspace ids, or labels as `key` or `key=value` the stale sweep never touches (at most 200, non-empty). |

## Logs

One stdout line per decision (`paseo plugin logs merged-worker-archiver`):

```
[merged-worker-archiver] {"action":"would-archive","workspaceId":"wks_...","name":"...","agentIds":["..."],"branch":"opc/x","base":"main","reason":"merged-ancestry(refs/remotes/origin/main)"}
```

`action` is `skip`, `would-archive` (dry-run), `archived`, `archive-failed` (its reason ends
with the back-off length), `backoff` (the reason shows which back-off sweep this is), or
`deferred` (over the cap). Workspace cleanup lines also carry `cleanup` and
`lastActivityAt`, and add `would-notify`, `notified`, `notify-deferred`, `notify-unrouted`
and `notify-failed`, with `path`, `lastCommit` and `owner` (and `host` for a peer PM), plus
`notify-peer-error`. The stale sweep logs `stale-flagged`, `stale-flag-deferred`,
`stale-flag-failed`, `stale-unrouted`, `stale-archived`, `stale-archive-skipped`,
`stale-backoff`, `stale-deferred`, and in a preview `would-flag`, `would-flag-unrouted` and
`would-archive`, each with `kind` (`agent` or `workspace`), `id`, `name`, `where`, `status`,
`idle`, `owner` and, when known, `blocked`; it logs `stale-skipped` when it cannot run. Each
evaluation ends with `sweep-done`; failures log `sweep-aborted`; invalid settings log
`config-invalid`. Non-worktree workspaces are only counted unless `logNonCandidates` is on.

## Daemon access and version bound

`PluginServerContext` has no Paseo SDK handle, so every sweep opens its own short-lived
connection with the typed `DaemonClient` from `@getpaseo/client/internal/daemon-client` (an
internal export, hence the exact pin) and closes it at the end. The daemon is resolved at
each sweep from an explicit `PASEO_HOST`, then the `$PASEO_HOME/paseo.pid` listen metadata,
then `127.0.0.1:6767` only for an unset home or `~/.paseo`. A non-default home without valid
listen metadata, or an invalid explicit host, refuses to connect, and that sweep logs
`sweep-aborted`.

`paseo-plugin.json` pins `"paseo": ">=0.15.0 <0.16.0"` and `package.json` pins
`@getpaseo/client`, `@getpaseo/plugin`, and `@getpaseo/protocol` to exactly `0.15.3`, as
`orphan-project-sweeper` does. The plugin depends on Paseo's archive semantics (directory
removed, branch kept), `<git-dir>/paseo/worktree.json`, and snapshot field names. Re-check
before admitting 0.16.

Paseo compiles the plugin from source with esbuild and bundles `@getpaseo/client` (with
`@getpaseo/protocol`), about 8.4 MB, so `npm install` must have run here before install or
reload. Loading takes about 10 s.

## Develop and verify

```bash
npm install
npm run check          # typecheck + unit tests (node:test, fake git/gh, real-git ignored-file and submodule tests) + esbuild bundle (to node_modules/.cache)
npm run dry-run -- --host 127.0.0.1:6767          # read-only table against a live daemon
npm run dry-run -- --grace 0 --config <settings.json>
npm run dry-run -- --cleanup-only --config <settings.json>   # workspace cleanup lines only
npm run dry-run -- --stale --config <settings.json>          # stale sweep preview (as if staleSweep were on)
```

`scripts/dry-run.ts` sweeps with `armed: false`, `armWorkspaceCleanup: false` and `forceDryRun: true`, so every decision stops at its `would-archive`, `would-notify` or `deferred` line. As a second guard, its client refuses to archive (workspaces and agents) or send, and its state stores refuse to write. It reads the notify and stale-flag state of `PASEO_HOME` (default `~/.paseo`), so already reported worktrees show as skipped and items flagged within a day are held. `--stale` previews the stale sweep (`would-flag`, `would-archive`) even when `staleSweep` is off.

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

Disarm by setting `armed` to `false` (next evaluation) or
`paseo plugin disable merged-worker-archiver`.

The stale sweep: preview with `npm run dry-run -- --stale --config <settings.json>`, then
add `"staleSweep":true` to `values`. It flags only; add `staleArchivePms`,
`staleArchiveProjects` or `"staleArchiveAll":true` (with `armed` on) to archive, and
`staleExclude` entries such as `"keep=1"` for what must stay.

Workspace cleanup is a separate, later step: review its lines (`npm run dry-run --
--cleanup-only --config <settings.json>`), then add `"armWorkspaceCleanup":true` next to
`"armed":true`. Setting it back to `false` stops cleanup at the next sweep and leaves worker
archiving armed.

Upgrading a directory install: `npm install && npm run check`, then
`paseo plugin reload merged-worker-archiver` and confirm `running` in `paseo plugin ls`.
Existing settings files keep loading.

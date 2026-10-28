# merged-worker-archiver

Startup endpoint resolution uses explicit `PASEO_HOST`, then `$PASEO_HOME/paseo.pid` runtime listen metadata. An explicit non-default `PASEO_HOME` without valid endpoint metadata refuses to connect instead of falling back to another daemon. Invalid explicit hosts also fail closed. The standard local endpoint is a fallback only for an unset home or `~/.paseo`.

Server-only Paseo plugin for Paseo >=0.10.3 <0.14.0. It archives worker **worktree** workspaces,
and through Paseo's own workspace archive the agents in them, once the worker branch
is merged into its base. It is **event-driven**: every finished agent turn (PM or
worker) evaluates the worktrees of that agent's project and repository within seconds.
It is **dry-run by default**: it only logs what it would do until `armed` is set in its
settings.

Since 0.4.0 its full sweeps also clean up stale workspaces (see Workspace cleanup): they
archive the record of an idle, agentless project checkout or local workspace, archive an
idle agentless worktree whose branch is merged and whose tree is clean, and tell the owning
PM once about an idle agentless worktree they keep. That path has its own switch,
`armWorkspaceCleanup`, and stays dry-run until it and `armed` are both on. Since 0.5.0 that
PM may run on another Paseo daemon (`peerHosts`, see Messages to the PM), and an agentless
worktree whose only ignored files are regenerable output counts as clean.

## What counts as merged

Checked with read-only git in the worktree (`GIT_OPTIONAL_LOCKS=0`, no prompts, inherited
`GIT_*_PATHSPECS` modes removed, never `fetch`, never writes refs or the index):

1. **Ancestry**: `HEAD` is an ancestor of one of the existing local base refs:
   the exact `baseRef` the worktree was cut from, `refs/heads/<baseRefName>`, or the base
   branch's configured upstream (`<baseRefName>@{upstream}`, else
   `refs/remotes/origin/<baseRefName>`). A candidate naming the worker branch itself, such
   as the `refs/remotes/origin/<branch>` that `git push -u` sets as its upstream, is never
   used. The base comes from Paseo's own worktree metadata,
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

## Finished workspaces without a PR

Review agents and abandoned lanes never merge, so they would linger. With
`archiveFinishedWithoutPr` (default `true`) a worktree that is not merged is still
archived when all of these hold:

1. It is a Paseo `worktree` workspace whose real path is strictly inside Paseo's managed
   worktrees directory (`<PASEO_HOME>/worktrees`, compared case-insensitively on Windows),
   and it is not the root of any Paseo project. Local checkouts and directory workspaces
   never qualify.
2. It passes every agent and workspace gate below (all agents `idle` or `closed`, nothing
   running, no pending permission or attention), and its latest activity is at least
   `finishedGraceMinutes` ago (default 120, and never less than `graceMinutes`).
3. No agent is a PM, and no agent has the label `noarchive` (any value), which opts the
   workspace out of this path.
4. It passes the merged path's cleanliness gates, with one difference: no operation in
   progress, no changed or untracked file, no non-empty submodule directory, and no ignored
   file except clearly regenerable output. An ignored path counts as regenerable when any
   segment is `node_modules`, `__pycache__`, `.pytest_cache`, `.venv`, `.turbo`, `.next`,
   `.cache`, or `coverage`, or the file name ends in `.tsbuildinfo`. `dist` and `build`
   do not count. An ignored file whose name matches `.env*`, `*.pem`, `*.key`, `id_rsa*`,
   `id_ed25519*`, or `id_ecdsa*` (any case) blocks it even inside a regenerable directory
   (`git ls-files --others --ignored` lists those files). So does any other ignored
   file, and any path git prints quoted. The merged path still counts every ignored file
   as dirty.
5. It has no unpushed commits, checked live: `git ls-remote --heads` must succeed for every
   remote, and `HEAD` must be contained in (or equal to) one of the listed head commits
   that is also present locally. Remote-tracking refs are not trusted, and an offline or
   failing remote is a skip.
6. Every remote is a `github.com` remote, and `gh pr list -R github.com/<owner/repo> --head
   <branch> --state open` returns no PR for each of their repositories. Every gh call runs
   without `GH_HOST` and `GH_ENTERPRISE_TOKEN`, so it cannot query another host. It needs
   `useGh`. A remote on any other host, or gh being disabled, missing, or failing for any
   repository, is a skip.

Only a merge-check result of "clean but not merged", or "dirty with ignored files only",
falls through to this path (`dirty(ignored=N)`, `not-merged(...)`, `no-branch-commits`, `no-base(...)`, `branch-is-base`,
`unmerged-commits(...)`, `pr-head-mismatch`, `pr-base-mismatch`). Every error, dirty, or
ambiguous result stays a skip. A skip keeps the merge reason first and appends the no-PR
reason, for example `not-merged(ahead=2 of refs/heads/main; no PR); no-pr: unpushed-commits(...)`.
The archive reason is `finished-no-pr(pushed(live <remote>))`. Archiving never deletes
the branch, so the commits stay reachable locally too.

Archiving is the same `paseo.workspaces.archive` call as the merged path, with the same
cap, back-off, and armed re-check. Dry-run logs a `would-archive` line for each.

## Skip rules (fail closed)

Non-worktree workspaces also qualify as `empty-disposable-workspace` when their
absolute cwd is strictly under `<PASEO_HOME>/worktrees` (default `~/.paseo/worktrees`)
or `~/.cache/fleet-scratch` (`%USERPROFILE%\.cache\fleet-scratch` on Windows), with
both lexical and real paths contained in the same root. The root itself, missing or
unresolvable paths, and symlinks escaping the root do not qualify. They must have
**no non-archived agents**, no running scripts, a non-blocking workspace status, and
activity older than `graceMinutes`. This rule ignores `allowAgentlessWorkspaces` and
needs no git or merge check; it archives the workspace record via Paseo, not the
scratch folder. Other local workspaces, including project checkouts, are never archived
by the worker path; only workspace cleanup (below) archives their record, and only when it
is armed. Actual `worktree` workspaces retain all existing merge and cleanliness gates.

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
| `grace-period(idle, remaining)` | Latest activity (workspace activity/status time, agent updated, last user message, attention time) is younger than `graceMinutes` (default 0, so this only applies when raised). |
| `ambiguous(...)` | No activity timestamp, path not statable, empty reflog, PR merged without merge commit, PR head commit not local, a submodule path that is not UTF-8, a git top level (`rev-parse --show-toplevel`, only its line end removed) whose realpath is not the workspace directory's. |
| `path-missing` | Directory gone; left to Paseo's own reconciliation. |
| `detached-head` | No branch. |
| `no-base(...)` | No Paseo worktree metadata, or none of the base refs exist locally. |
| `branch-is-base` | The worktree is on its base branch. |
| `operation-in-progress(x)` | Merge, cherry-pick, revert, rebase, or bisect in progress. |
| `dirty(changed, untracked, ignored)` | Any staged, unstaged, or untracked change (`--untracked-files=all`), or any git-ignored file (`--ignored=matching`). A worktree whose only extra files are ignored reports `dirty(ignored=N)`, for example an ignored `.env` or local notes. `N` counts the paths git lists, and an ignored directory counts once. On the merged worker path ignored dependency or build output (`node_modules`, `dist`) also blocks archival. That is intended: the owner chose safety over automatic cleanup. Delete such output, or archive the workspace by hand. The no-PR path and workspace cleanup's agentless worktrees count only ignored files that are not regenerable output (see Finished workspaces without a PR, item 4), so there `N` leaves out `__pycache__`, `node_modules` and the rest of that list, and an ignored file with a sensitive name inside such a directory reports `dirty(sensitive-ignored=n:path)`. |
| `submodule(path)` | A submodule directory (a gitlink in the index, `git ls-files --stage` from the worktree top level) that is not an empty, real directory. The superproject's status cannot vouch for it: `submodule.<name>.ignore` or `diff.ignoreSubmodules` hides its changes, its ignored files are never listed, and files in an unpopulated submodule directory are invisible to git. An unpopulated submodule (an empty directory) does not block; a symlink or junction in its place does. |
| `no-branch-commits` | The branch reflog has no `commit`/`cherry-pick` entry. A branch with no own commits is trivially an ancestor of its base (also after a pure rebase onto a newer base); that is "no work yet", not "merged". |
| `not-merged(...)` | Commits not contained in the base, no merged PR (`no PR`, `PR #n open`, `gh unavailable`, `no GitHub remote`, `gh disabled`). |
| `unmerged-commits(...)` | Local commits after the merged PR head. |
| `pr-head-mismatch` / `pr-base-mismatch` | The PR found is not this branch into this base. |
| `git-error(...)` / `git-timeout(...)` / `git-not-found` / `gh-error(...)` / `gh-timeout` | Any command failure. |
| `...; no-pr: <reason>` | Not merged, and the no-PR path also skipped it: `noarchive-label`, a grace or agent gate, a cleanliness gate, `project-root`, `outside-paseo-worktrees`, `dirty(sensitive-ignored=n:path)`, `unpushed-commits(...)`, `pr-open(owner/repo#n)`, `pr-unknown(...)` (gh disabled or unavailable, or a non-GitHub remote), `gh-error(...)`, `gh-timeout(...)`, or a failed `ls-remote` as `git-error(...)`. |
| `recheck: ...` | Armed only: live state is re-read and every gate re-run immediately before archiving. |

A sweep is aborted with no decisions if the daemon is unreachable or the workspace or
agent list is incomplete (pagination without a cursor), because a hidden agent could be
running, or if the project list is unavailable, fails, or has a project without a root path.
That abort applies to both paths: nothing is archived. Invalid settings also abort the sweep.

## What archiving does

The only action is the official `paseo.workspaces.archive(workspaceId)` (the same
request as `paseo workspace archive`). In Paseo 0.9.1 that (`archiveByScope`):

- archives every agent in the workspace, kills its terminals, and archives the record;
- runs the project's worktree teardown commands, if any;
- if the worktree is Paseo-owned and no other active workspace references it, removes
  the directory with `git worktree remove --force` (Paseo's force, not this plugin's).
  The plugin already refused if any changed, untracked, or ignored file or any non-empty
  submodule directory was present, so only clean, committed content is removed. The one
  exception is regenerable ignored output (`__pycache__`, `node_modules`, ...), which the
  no-PR path and agentless worktree cleanup allow and Paseo then removes with the tree;
- does **not** delete the branch. Verified in the isolated test: after archive the
  directory and its `git worktree` entry were gone and `worker-merged` still existed.

The plugin never deletes branches, never forces anything itself, and never edits
`~/.paseo/config.json`.

### Relation to Paseo's built-in `autoArchiveAfterMerge`

Paseo 0.9.1 has `daemon.autoArchiveAfterMerge`. It only fires when
the daemon itself watched a pull request go from open to merged while running, and it
ignores local merges, so locally merged worktrees stay. This plugin covers
local merges (ancestry) and PRs merged while the daemon was not watching.

## Workspace cleanup

Workspaces the worker path leaves alone used to stay forever: project checkouts and other
local workspaces (`not-worktree(...)`), and worktrees with no live agent (`no-agents`). In
every **full sweep** (the startup sweep and the backstop every `sweepIntervalMinutes`, never
the event-driven ones) those workspaces go to workspace cleanup, which has two paths:

- **Stale record** (`cleanup: "stale-record"`, a `local_checkout` or `directory` workspace):
  archive the workspace record. No file is touched (see below).
- **Agentless worktree** (`cleanup: "agentless-worktree"`): archive it when its branch is
  merged and its tree is clean, by the same merge test as the worker path
  (`stale-agentless-merged(...)`); this removes a Paseo-owned worktree's directory, as for
  workers. Ignored files count as on the no-PR path (item 4 of Finished workspaces without a
  PR): regenerable output such as `__pycache__` is clean, while an ignored file with a
  sensitive name (`.env*`, keys), any other ignored file, or a path git prints quoted is not
  (`dirty(ignored=N)`, `dirty(sensitive-ignored=n:path)`). An unmerged branch is kept either
  way; only the reason changes. Any other result in the table below means the plugin keeps it
  and tells its PM once (`notify`).

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

Last activity is the newest of these timestamps, as Paseo and git expose them:

- the workspace: `createdAt` (0.13), `statusEnteredAt` (see below), `activityAt` and
  `lastUserMessageAt` (0.13);
- every agent the workspace ever held, archived ones included: `createdAt`,
  `lastUserMessageAt`, `attentionTimestamp`, and `updatedAt` (see below);
- every agent's newest delivered message, from Paseo's message receipts (see below), at most
  its `archivedAt`;
- for an archived agent, the end of its last turn: `min(archivedAt, newest input + 12 h)`,
  where its inputs are its `createdAt`, its `lastUserMessageAt` and its newest delivered
  message;
- for a worktree, the committer date of its HEAD commit (`git log -1`), which covers work
  committed after the last message. A worktree whose HEAD git cannot read is skipped as
  `ambiguous(HEAD commit unreadable)`.

Archiving an agent is not activity in itself. Paseo stamps an agent's archive time on both
`archivedAt` and `updatedAt`, and archiving clears its `attentionTimestamp`. Counting that
time would date an agentless workspace from its last agent's archive, which often comes days
after the last work. So an archived agent's `updatedAt` counts only when it is earlier than
its `archivedAt`, and `archivedAt` serves only as the cap above. The work an agent does after
its newest input leaves no other trace, so the 12 h last-turn allowance covers it. An agent
archived within 12 h of its last input therefore counts as active until its archive.

**Message receipts.** Messages from other agents, such as a PM's `paseo send`, do not set
the recipient's `lastUserMessageAt` on 0.13. On 0.11.1 and 0.13.0 (the same code) the daemon
writes a receipt for every `send_agent_message_request` that carries a `messageId`, which the
CLI and the app always set: `<PASEO_HOME>/agent-requests/<sha256>.json` with the recipient's
`agentId`, written `pending` and rewritten `completed` once the message is delivered. So the
file's modification time is the delivery time. The plugin reads these files without writing
anything. It counts `completed` and `pending` receipts, since a pending one may have reached
the agent. It reads only files modified within `staleWorkspaceMinutes` plus 12 h, since
older ones cannot make a workspace recent; the age a report shows therefore ignores older
receipts. If the directory or a receipt cannot be read (a missing directory included), archive
times count instead, which only makes workspaces newer, and `sweep-done` shows
`receiptsUnreadable`. Messages sent through Paseo's MCP tools write no receipt; for those the
last-turn allowance and the archive cap apply.

**`statusEnteredAt`.** A long-lived Paseo session stamps the workspace's `statusEnteredAt`
with the moment its last busy agent leaves, which can be its archive. The plugin counts
`statusEnteredAt` only when it is earlier than the newest `archivedAt` of the workspace's
agents. In practice each sweep opens a new session, which for an agentless workspace reports
the workspace's `createdAt` there.

Paseo does not expose the workspace record's `updatedAt`, and scripts report only their
`lifecycle`, with no start or stop time, so neither can count; a running script or a live
terminal blocks cleanup instead. On 0.11.1 and 0.13.0 `activityAt` is always null. File
edits made outside Paseo and not committed are not activity.

### What archiving a record does

The plugin calls `paseo.workspaces.archive(workspaceId)`, which on 0.11.1 and 0.13.0 sends
`archive_workspace_request` to `archiveByScope` (workspace scope). It stops the
workspace's setup, archives its agents, kills its terminals and archives the record. It
removes a directory, after running the project's worktree teardown commands, only for a
Paseo-owned worktree that no other active workspace references. For a record that is not a
worktree, Paseo counts it as Paseo-owned only when the record itself says so, which a
`local_checkout` or `directory` record never does, and cleanup skips any record that claims
it (`paseo-owned-worktree-record`). So a stale record's archive runs no teardown command and
deletes no file. On scratch daemons the checkout's files and git branches were unchanged
afterwards.

Archiving a project's last or main checkout record does **not** archive or remove the
project: Paseo only logs that the project has no active workspace left, and `project ls`
still lists it. Only removing the project (`project.remove`) archives its workspaces, and
`orphan-project-sweeper` removes a project only when its root folder is gone. Opening the
folder again in Paseo makes a new workspace record in the same project (checked on 0.13.0).

### Messages to the PM

A kept agentless worktree is reported once, with its path, branch, last commit, age since
last activity, and why it was kept. The owner is the parent named by the
`paseo.parent-agent-id` (full id) or `parent` (id prefix) label of the worktree's last agent,
when that parent is a live agent. Otherwise it is the one live agent labelled `role=pm`
whose `project` label matches, case-insensitively, the last agent's `project` label or the
workspace's project name. The owner is resolved again just before sending. With several, or
with none here and none on a peer daemon (see PMs on other daemons), the plugin logs
`notify-unrouted` and sends nothing. Each PM gets one message per
sweep listing at most 20 worktrees (`notify-deferred` for the rest). Right before each send
the plugin reads that PM's status again, and sends only while it is idle or closed, not
archived, and without a pending permission. Otherwise it logs `notify-deferred` and tries
again at the next full sweep: a message would interrupt a turn, clear a pending permission
request, or unarchive the PM. The message is sent with `activeTurnBehavior: "steer"`, so a
turn that starts in the moment between that check and the send gets the text added where
the provider can steer, instead of being replaced.

Reported worktrees are kept in `<PASEO_HOME>/plugin-state/merged-worker-archiver/notified.json`
(owner-only), written before the message goes out, so a worktree is never reported twice:

- `sent`: delivered;
- `unconfirmed`: the send failed in a way that may have delivered it; never resent;
- `sending`: the plugin stopped between the two writes; never resent.

A send refused before delivery (`Agent not found`) is retried. The message also carries a
fixed `messageId`, so the daemon drops a duplicate. Entries of worktrees that are no longer
listed are pruned by armed sweeps. To report a worktree again, delete its entry, or the file,
while the plugin is stopped. A file that cannot be read (anything but missing) blocks every
report and logs `notify-state-unreadable` until it is fixed.

#### PMs on other daemons

With `peerHosts` set (default empty, which changes nothing), a worktree with no owner on this
daemon is looked up on those daemons, in the order listed, through the `paseo` CLI on the
plugin's `PATH`: no shell, and each call bounded by `commandTimeoutSeconds`.

1. The last agent's `paseo.parent-agent-id` (full id; the `parent` prefix label is not used),
   with `paseo inspect --host <peer> --json -- <id>`. It counts when that agent is live and
   not archived there.
2. Otherwise the project's `role=pm` agents, with
   `paseo ls --host <peer> -g --label role=pm --label project=<name> --json` for each project
   name (the last agent's `project` label and the workspace's project name). The CLI matches
   labels exactly and does not print them, so each name is asked as written and in lower case.
   A `project` label in any other spelling, or a `role` other than lower-case `pm`, is not
   found on a peer.

The owner must be unique across all peers: the parent on exactly one peer, else exactly one
project PM across all of them. Several matches log `notify-unrouted` with `several owners on
peers`, and no match logs it with `no owner on peers`; both list the `peers` asked. A peer
that fails (unreachable, a timeout, a CLI error) logs one `notify-peer-error` line (`peer`,
`query`, `error`) and is asked nothing more in that sweep, so it costs at most one timeout.
While a peer has failed and the parent was not found elsewhere, no project PM is chosen, since
the failed peer may hold another: the line is `notify-unrouted` with `owner unknown on peers`
and `peerErrors`. Nothing is recorded for an unrouted worktree, so the next full sweep tries
again.

Peers are asked only after every report to a PM on this daemon has been sent, so a slow or
unreachable peer cannot delay or block those. A peer send follows the local rules: right
before it the PM is read again with `paseo inspect`, and the report goes out only while that
PM is `idle` or `closed`, not archived and without a pending permission (else
`notify-deferred`), with `paseo send --host <peer> --no-wait --behavior steer`. Its
`notified.json` entry names the peer as `host`, and its log lines carry `host` and `via`
(`peer-parent` or `peer-project-pm`). A send that cannot have been delivered (no CLI, a usage
error, no connection, `Agent not found`) is retried at the next full sweep; any other failure
is recorded as `unconfirmed` and never resent. The CLI sets its own message id, so for peer
sends `notified.json` alone keeps each worktree to one report. Dry-run sweeps look peers up
too (read only) and log `would-notify` with `host`.

Requirements and limits:

- `ssh://<alias>` is the only accepted form (letters, digits, `.`, `_`, `-`; at most 8 unique
  entries); a user, port, path or `daemonPort` makes the settings invalid. So the peer daemon
  must listen on the CLI's default SSH daemon port (6767) on that host.
- SSH to each alias must work without a prompt from the daemon's environment: the CLI runs
  `ssh -o BatchMode=yes`.
- The `paseo` CLI must have `send --behavior` (0.13.0 has it, 0.11.1 does not). With an older
  CLI every peer send is refused before delivery and retried, so nothing is lost or sent twice.
- Not checked on Windows, where the CLI is usually a `.cmd` shim that runs only through a
  shell; expect `notify-peer-error` there.

### Background workspaces

Paseo 0.13 hides background workspaces and their agents from listings unless the request
sets `filter.includeBackground`. Every sweep asks the daemon whether it has background
workspaces (`supportsBackgroundWorkspaces()`, from the server info) and then includes them,
as `orphan-project-sweeper` 0.2.1 does; 0.11.1 has none. A client that cannot answer aborts
the sweep, so nothing is decided from a list that may be missing workspaces or agents.

### Listings that only cleanup reads

Cleanup also needs every agent with the archived ones (for activity and the owner) and the
terminal list. Full sweeps read them in a separate listing, capped like the others at 50
pages of 200 agents. If that listing or the terminal list fails or is incomplete, the sweep
logs `cleanup-skipped` (also as `cleanupSkipped` in `sweep-done`) and runs only the worker
path; cleanup waits for the next full sweep. An armed cleanup archive or report whose fresh
re-read fails is skipped or deferred the same way. A failed workspace, live agent or project
list still aborts the whole sweep. A daemon with more than 10,000 agents, archived ones
included, skips cleanup at every full sweep until the cap is raised.

### Arming

Cleanup acts only when `armed` and `armWorkspaceCleanup` are both `true`. Otherwise every
cleanup decision logs `would-archive` or `would-notify`, writes no state and sends nothing;
with only `armed` on, these previews take no slot of `maxArchivesPerSweep`. An armed sweep
re-reads live state and re-runs every gate just before each archive and before sending.
`sweep-done` adds `cleanupMode`, `cleanup` (counts by action, `alreadyNotified` included)
and `reports` (worktrees reported, or that would be).

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
- **`agent.archived`**: also schedules its workspace for a debounced evaluation, so
  an empty disposable workspace need not wait for the periodic sweep.

Each finished turn logs one `event` line; each evaluation ends with `sweep-done`
including `trigger`, `pendingMerge`, and `latencyMs` (first coalesced event to end of
evaluation). Permission and attention state are read from agent snapshots at decision
time. Sweeps are serialized.

## Per-sweep cap

One sweep makes at most `maxArchivesPerSweep` archive attempts (default 5). The cap
counts attempts, not successes: an armed archive call that fails still uses a slot, a
workspace that fails the armed fresh-state re-check does not, and deferred workspaces
are not re-checked. Dry-run applies the same cap, order, and back-offs to
`would-archive`, so it shows what an armed sweep would attempt from the same state. That
is not a promise about the next armed sweep: see the dry-run note under Back-off.

Further eligible workspaces are not archived: each gets a `deferred` log line, and they
wait for a later sweep (the next turn end in their project or repository, or the
periodic sweep), where they go first (see Fair order). In `sweep-done`, `counts.archive`
covers only the candidates within the cap and `counts.deferred` the rest (also reported
as `deferred`), so a sweep that finds 7 eligible workspaces reports
`"archive":5,"deferred":2`.

### Fair order across sweeps

Paseo lists workspaces in a stable order, so without help the same first candidates
would get the slots every sweep. Each sweep therefore visits first the workspaces that
an earlier armed sweep deferred at the cap, longest-waiting first, and then the rest in
listing order. A deferred workspace keeps its place in that queue until it is attempted
or stops being eligible, so in full sweeps (the startup and periodic sweeps) a
workspace that stays eligible is attempted within about (eligible candidates /
`maxArchivesPerSweep`) sweeps, however many candidates ahead of it keep failing. The
bound counts full sweeps of candidates that stay eligible throughout: a scoped sweep
(after a turn end, or a follow-up) attempts only the workspaces in its scope. With the
cap at 5 and 45 workspaces whose archive call always fails listed ahead of 1 healthy
one, all of them eligible throughout, the healthy one is attempted by the 10th armed
full sweep.

The queue lives in memory only (a plugin reload or daemon restart clears it), and every
full sweep, armed or dry-run, drops workspaces that are no longer listed. Apart from
that, only armed sweeps change it: a dry-run sweep visits candidates in queue order but
attempts nothing, so listed workspaces keep their places.

### Back-off after a failed archive call

A workspace whose armed archive call fails (an error result or a thrown call) backs off,
so a call that keeps failing does not keep spending slots. It sits out the next sweeps
that find it eligible: 1 after its first consecutive failure, then 2, 4, and at most 8.
While it sits out it gets a `backoff` log line and takes no slot, so other candidates
get the slots. When its back-off ends it is retried like any other candidate; nothing
is given up permanently. A successful archive clears the back-off. Back-offs live in
memory only, so a plugin reload or daemon restart clears them, and a full sweep forgets
workspaces that are no longer listed. Only sweeps that find the workspace eligible
count toward its back-off.

Dry-run sweeps count too: a dry-run sweep that finds a backed-off workspace eligible
advances its back-off exactly as an armed sweep would. A dry-run preview therefore does
not promise to match the next armed sweep. A back-off that the preview shows as active
may have ended by the time an armed sweep runs, and that sweep then retries the
workspace.

In `sweep-done`, backed-off workspaces are counted as `counts.backoff` (also reported as
`backoff`), never as `archive` or `deferred`. With 5 workspaces whose archive call
always fails ahead of 2 good ones, the first armed sweep reports 5 `archive-failed` and
`"archive":5,"deferred":2`. The next archives the deferred good two first and reports
`"archive":2,"backoff":5`, and the one after retries the failing five.

## Settings

Host-scoped plugin settings (`server.registerSettings`), stored by Paseo at
`<PASEO_HOME>/plugin-settings/merged-worker-archiver/config.json` as
`{"version":1,"values":{...}}`. Missing file means all defaults. Unknown keys or wrong
types make the settings invalid, which stops all evaluation. Settings are re-read before
every sweep, so edits take effect on the next sweep without a reload.

| Key | Default | Meaning |
|---|---|---|
| `armed` | `false` | `true` allows real archiving. Anything else is dry-run. |
| `maxArchivesPerSweep` | `5` | Archive attempts per sweep; the rest are deferred to the next sweep. An armed archive call that fails still uses a slot, then that workspace backs off for a few sweeps (see Back-off), and dry-run previews the same number as `would-archive`. A whole number of at least 1; anything else makes the settings invalid. |
| `sweepIntervalMinutes` | `60` | Backstop full-sweep interval (1 to 1440). |
| `graceMinutes` | `0` | Minimum idle time before archiving (0 to 10080). A merged branch means the PM already integrated the work; raise it to keep an inspection window. |
| `eventDebounceSeconds` | `3` | Coalescing window after a turn ends (0 to 60). |
| `followUpDelaysSeconds` | `[15, 60, 180]` | Re-checks for clean, idle, not-yet-merged worktrees (at most 5, each 1 to 3600). |
| `commandTimeoutSeconds` | `15` | Per git/gh call timeout. |
| `useGh` | `true` | Use `gh pr view` for squash-merged PRs. |
| `allowAgentlessWorkspaces` | `false` | Also consider worktrees with no live agents. |
| `logNonCandidates` | `false` | Also log a line for non-worktree workspaces. |
| `armWorkspaceCleanup` | `false` | `true` (with `armed`) lets workspace cleanup archive and message PMs. Anything else is dry-run for that path. |
| `staleWorkspaceMinutes` | `4320` | Idle time before workspace cleanup acts (1 to 525600; 3 days by default). |
| `archiveFinishedWithoutPr` | `true` | Also archive finished worktrees with no open PR that are clean and pushed (see Finished workspaces without a PR). |
| `finishedGraceMinutes` | `120` | Minimum idle time for that path (0 to 10080). The larger of this and `graceMinutes` applies. |
| `peerHosts` | `[]` | Other Paseo daemons, as `ssh://<alias>` (at most 8, unique), asked in order for the PM of a kept agentless worktree when this daemon has none (see PMs on other daemons). Any other form makes the settings invalid. Empty asks only this daemon. |

## Logs

One stdout line per decision (`paseo plugin logs merged-worker-archiver`):

```
[merged-worker-archiver] {"action":"would-archive","workspaceId":"wks_...","name":"...","agentIds":["..."],"branch":"opc/x","base":"main","reason":"merged-ancestry(refs/remotes/origin/main)"}
```

`action` is `skip`, `would-archive` (dry-run), `archived`, `archive-failed` (its reason
ends with the back-off length), `backoff` (sitting out after a failed archive call; the
reason shows which back-off sweep this is), or `deferred` (over the per-sweep cap).
Workspace cleanup lines also carry `cleanup` and `lastActivityAt`, and add the actions
`would-notify`, `notified`, `notify-deferred`, `notify-unrouted` and `notify-failed`, with
`path`, `lastCommit` and `owner` (and `host` for a PM on a peer daemon). A peer daemon that
fails logs `notify-peer-error` with `peer`, `query` and `error`. Each
evaluation ends with a `sweep-done` summary; failures log `sweep-aborted`. Non-worktree
workspaces are counted in the summary only unless `logNonCandidates` is on.

## Daemon access and version bound

`PluginServerContext` has no Paseo SDK handle, and the `PaseoApi` that hooks receive
cannot tell whether the daemon has background workspaces. So every sweep opens its own
short-lived connection, as the Paseo CLI does, with the typed `DaemonClient` from
`@getpaseo/client/internal/daemon-client` (an internal export, which is why the version is
pinned exactly), and closes it when the sweep ends. The daemon is resolved at each sweep
from `PASEO_HOST`, then `$PASEO_HOME/paseo.pid`, then `127.0.0.1:6767` only for the
default home. A non-default home without valid listen metadata refuses to connect, and
that sweep logs `sweep-aborted`.

`paseo-plugin.json` pins `"paseo": ">=0.10.3 <0.14.0"` and `package.json` pins
`@getpaseo/client`, `@getpaseo/plugin`, and `@getpaseo/protocol` to exactly `0.13.0`
(0.4.0, from 0.11.1, for `supportsBackgroundWorkspaces()`; the same pins as
`orphan-project-sweeper`). The 0.13.0 client works with older daemons: the workspace
cleanup proof below ran this build on 0.13.0 and 0.11.1, and a 0.10.3 scratch daemon ran
a dry-run sweep with cleanup lines and no error. The plugin depends on 0.9.1 archive semantics
(directory removal, branch kept), the worktree metadata location, and snapshot field
names. Those were checked against 0.9.2, 0.10.1, 0.10.3, and 0.11.1. The owner admitted
0.12 and 0.13 after a 0.13.0 canary ran the plugin; in the 0.13.0 server the worktree
metadata is still `<git-dir>/paseo/worktree.json` and archive still never deletes the
branch. 0.13 hides background workspaces from `workspaces.list` unless asked; since 0.4.0
the plugin asks (see Background workspaces). Re-check before admitting 0.14.

The 0.10.3 check used its installed client and plugin type declarations and a
credential-free, disposable daemon with a fake ACP provider and scratch git repository.
With no settings file, both the startup fallback client and a real `agent.turn_ended`
hook logged `would-archive` for a clean, locally merged worker. After arming only the
scratch daemon's settings, a completed fixture turn triggered a fresh-state recheck
and the official archive action. The worker agent and workspace were archived, the
Paseo-owned directory and git worktree entry were removed, and the branch remained.
An unmerged worker in the same project was skipped and its directory remained.
No runtime or dependency change was needed for 0.10.3; the existing manifest range
already includes it. The same fixture was repeated with the 0.11.1 build on disposable
0.10.3 and 0.11.1 daemons, with the same result. These checks do not exercise the GitHub
squash-merge path, project teardown scripts, or concurrent live-agent races.

Workspace cleanup (0.4.0) was checked on disposable 0.13.0 and 0.11.1 daemons, each with
its own home and port, a fake ACP provider, scratch git repositories, and
`staleWorkspaceMinutes` 4. Dry-run, and then `armed` alone, changed nothing: the same
workspaces, projects, files, branches and PM timeline, and no state file. With both
switches on, the first sweep archived the stale project checkout and local workspace
records (and on 0.13.0 a background one) with their files intact and every project still
listed, archived the merged clean agentless worktree, and kept the unmerged and the dirty
(untracked file) agentless worktrees (and on 0.13.0 a background unmerged one). Their PM
got one message, routed by the parent label for one and by `role=pm` plus `project` for
the others. Workspaces with an agent, a running script, a terminal or recent activity were
kept. A plugin reload and a daemon restart each ran another sweep that sent nothing more.
A worktree whose project has no PM, and one whose project has two, logged
`notify-unrouted` and nothing was recorded for them. A second round on both versions
checked the activity and send rules. An agent archived just before the sweep left its
workspace stale, and the record was archived with its files intact. A commit made just
before the sweep kept a worktree `recent`. A worktree whose HEAD commit was its newest
activity was reported with that age. A report to a PM in a running turn logged
`notify-deferred` (`PM running`) and was sent at the next sweep, once the PM was idle.
A third round checked the receipts on both versions. Each `paseo send` added one
`completed` receipt for the recipient, with the send time as its file time. On 0.13.0 a
send from another agent (`PASEO_AGENT_ID` set) left `lastUserMessageAt` unchanged and
still wrote a receipt. A workspace whose agent was archived more than 4 minutes after its
last input stayed `recent`, dated by the archive, and became `would-archive` 4 minutes
after it. With the receipt directory made
unreadable, the sweep showed `receiptsUnreadable` and dated the same workspaces by their
archive.

Peer routing and agentless cleanliness (0.5.0) were checked on a pair of disposable 0.13.0
daemons, each with its own home and port and a fake ACP provider. The plugin ran on one; the
other held the peer agents. The plugin's own `paseo` CLI and its SSH transport were used
unchanged. Only `ssh` on the plugin daemon's `PATH` was a stand-in that bridged one fixture
alias to the peer's port and refused every other alias, plus one fixture alias that fails like
an unknown host. With `peerHosts` empty, the two worktrees whose owners were on the peer logged
`notify-unrouted` and no ssh call was made, as in 0.4.0. In dry-run with the failing alias
listed first, lookups ran and nothing was sent or written. Armed, the local PM got its one
report, the worktree whose parent was on the peer was reported to that parent (recorded with
`host`), and the project-PM worktree stayed `notify-unrouted` with `peerErrors`; the failing
peer was asked once in the sweep. With only the working peer listed, the project worktree
went to the peer's `role=pm` agent, its `project` label being the lower-case form of the
worker's, and a further sweep sent nothing. A report to a peer PM in a running turn logged
`notify-deferred` (`PM running`) and was sent at the next sweep once the PM was idle. Two
aliases for the same peer made one PM ambiguous, which logged `notify-unrouted` (`several
owners on peers`). An invalid `peerHosts` entry logged `config-invalid`. The same run archived
a merged agentless worktree whose only ignored files were two `__pycache__` directories (its
branch was kept), reported an unmerged one as `not-merged(...)` instead of `dirty(ignored=2)`,
and reported a merged one with an ignored `.env` as `dirty(ignored=1)`.

Paseo compiles the plugin from source with esbuild and bundles `@getpaseo/client`
(with `@getpaseo/protocol`), about 8.4 MB, so `npm install` must have run here before
install or reload. Loading takes about 10 s.

## Develop and verify

```bash
npm install
npm run check          # typecheck + unit tests (node:test, fake git/gh, real-git ignored-file and submodule tests) + esbuild bundle (to node_modules/.cache)
npm run dry-run -- --host 127.0.0.1:6767          # read-only table against a live daemon
npm run dry-run -- --grace 0 --config <settings.json>
npm run dry-run -- --cleanup-only --config <settings.json>   # workspace cleanup lines only
```

`scripts/dry-run.ts` sweeps with `armed: false`, `armWorkspaceCleanup: false` and `forceDryRun: true`, so every decision returns at the `would-archive` or `would-notify` (or, past the cap, `deferred`) log line before an archive call or a message is reached. As a second guard, the client it passes refuses to archive or send, and its state store refuses to write. It reads the notify state of `PASEO_HOME` (default `~/.paseo`), so already reported worktrees show as skipped.

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

Workspace cleanup is a separate, later step: review its `would-archive` and `would-notify`
lines (for example `npm run dry-run -- --cleanup-only --config <settings.json>`), then add
`"armWorkspaceCleanup":true` next to `"armed":true` in the same `values` object. Setting it
back to `false` stops cleanup at the next sweep and leaves worker archiving armed.

Upgrading an installed copy (directory install): `npm install && npm run check`, then
`paseo plugin reload merged-worker-archiver` and confirm `running` in `paseo plugin ls`.
Existing settings files keep loading. A `maxArchivesPerSweep` value left in one from an
earlier version is honored again, and a value below 1 makes the settings invalid.
Worktrees that hold ignored files (for example `node_modules` or `.env`) are now skipped
as `dirty(...)`.

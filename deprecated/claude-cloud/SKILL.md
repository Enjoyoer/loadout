---
name: claude-cloud
description: Offload a coding task to a Claude Code cloud session (claude.ai/code), billed to the owner's claude.ai cloud-session credits. Use for long-running work, work that must continue with the laptop closed, or several independent tasks to run in parallel. Also covers checking and teleporting a cloud session back.
---

# Claude Code cloud sessions

Cloud sessions run on Anthropic infrastructure against a repository and bill the claude.ai account's cloud-session credits, not the local proxy quota.

## When to use

- Long-running work that should not tie up a local agent.
- Work that must keep going with the laptop closed.
- Several independent tasks: each `--cloud` call is its own parallel session.

Keep the task local when it needs local-only files, services, secrets, or hosts, or when it depends on uncommitted local state.

## Preflight

1. Run `claude auth status`. The CLI must be logged in to the claude.ai account that holds the credits, not a proxy API key. If it is not, stop and ask the owner to run `claude` then `/login` interactively.
   - **Cloud profile.** If `~/.config/opc/cloud-profile` exists, it names the Claude Code config directory whose claude.ai login holds this host's cloud credits. Prefix every `claude` command in this skill with `CLAUDE_CONFIG_DIR='<that directory>'` (the auth check, `--cloud`, `-p ... --cloud`, `--teleport`). The host's default login stays as it is. `node <opc>/scripts/cloud-lane.mjs status` shows the profile and its account. On Windows, run launches and follow-ups through `node <opc>/scripts/cloud-lane.mjs launch <brief file> --profile <dir>|none` and `follow-up <session id> <message file> --profile <dir>|none`, which pass the file as one argument without a shell; `$(cat ...)` and the `CLAUDE_CONFIG_DIR=` prefix do not work in PowerShell or cmd.
2. Run `git remote -v` in the repository.
3. **Upload warning.** If there is no Git remote, or the Claude GitHub App is not installed on that repository, the whole local repository is bundled and uploaded. GitHub tokens cannot list App installations, so the owner records confirmed repositories in `~/.config/opc/cloud-repos`, one `owner/repo` per line, or `owner/*` for every repository of an account. If the GitHub remote matches a line (case-insensitive), the App is confirmed: proceed without asking. Otherwise, before offloading a private or secret-bearing repository, stop and get the owner's explicit approval. Prefer pushing to a GitHub remote with the Claude GitHub App installed.
4. Commit and push anything the cloud session must see; it does not inherit uncommitted work when working from the remote.

## Commands

Run from inside the repository:

```bash
claude --cloud "<brief>" --model 'claude-opus-5-5[1m]' --effort xhigh  # create one new cloud session
claude -p "<message>" --cloud <session_id | claude.ai/code URL> --model 'claude-opus-5-5[1m]' --effort xhigh  # queue a follow-up
claude --teleport [session_id] --model 'claude-opus-5-5[1m]' --effort xhigh  # pull a finished session into this terminal
```

- Owner rule: every cloud session runs `claude-opus-5-5[1m]` at `--effort xhigh`, never another model or effort, whatever the task's class or route. Pass both flags on every launch, follow-up and teleport, exactly as shown.
- `--cloud` requires an interactive terminal. Non-interactive invocations, including an agent's Bash tool call, run locally and silently ignore `--cloud`.

- Write the description as a complete, self-contained brief: outcome, scope, constraints, and checks. The session cannot ask the local agent follow-up questions, so the brief must also:
  - give a unique marker and say "open a PR from your working branch titled `[<marker>] <summary>` against the default branch, and leave it unmerged". Do not name a branch: the cloud git proxy lets a session push only to its own assigned `claude/<slug>-<suffix>` branch and rejects pushes to any other name;
  - forbid edits to the project's memory files (`STATUS.html`, `LESSONS.md`).
- `--remote` is a deprecated alias for `--cloud`; do not use it.
- Teleport is one-way: a local terminal session cannot be pushed to the cloud.
- Record every launch as in [Launch record](#launch-record): the intent before the command, the result after it.

## Launch record

An accepted session keeps working and billing whether or not the launcher captured its ID, so a launch whose outcome is unknown is reconciled, never repeated.

- Under OPC, use its cloud lane instead of this recipe: `beginCloudLaunch` records the intent before the command, `recordCloudLaunchFailure` marks a failed or ambiguous capture `uncertain`, and `reconcileCloudLaunch` settles it.
- Otherwise, before sending the command, add a line to the project's `STATUS.html`: `launching`, the marker, the repository, and the time. After the capture, replace it with the session ID, URL, marker, and expected PR. If the command or capture fails, the output is ambiguous, or the capture is lost, mark the line `uncertain`.
- A `launching` or `uncertain` line, including one found on resumption, needs reconciling: look for a PR titled `[<marker>]` (see Results) and for the session at claude.ai/code, and record a found session as above. Only once no session exists for certain, mark the line `no session`; one new launch with the same marker may then follow these steps. Never launch for a marker whose line is `launching`, `uncertain`, or a recorded session.

## Results

The session pushes nothing back to the launcher. Detect completion by either signal:

- a PR whose title starts with `[<marker>]`: `gh pr list --repo <owner/repo> --state all --limit 100 --json number,title,state,isDraft,headRefName` filtered on that title prefix. Its `headRefName` is the session's `claude/...` branch;
- the session page at the returned claude.ai/code URL.

`claude --teleport <id>` pulls a finished session in. Verify the result as you would any delegated work before merging.

Known failures: a brief that names its own branch makes the session's push fail, so it never opens the PR. A session can also run for hours without pushing. Before giving up on it, read its claude.ai/code page and, if it is idle or unreadable, send one `-p` follow-up asking it to push; fall back to a local worker only if the page shows a failure or it stays quiet after that. "Attaching to an existing cloud session is not enabled for your account" only means `-p` was missing from a follow-up, not that cloud sessions are unavailable. "Cloud sessions are disabled by your organization's policy" or "aren't available with <provider>" means cloud sessions cannot run from this login. The title marker and "open a PR" in the brief are what make completion detectable at all.

## From Paseo agents

Use a PTY, since the Bash tool is non-interactive:

1. Write the brief to a file, for example `/tmp/brief.txt`.
2. Record the launch intent ([Launch record](#launch-record)).
3. `create_terminal` in the repository.
4. `send_terminal_keys` with `claude --cloud "$(cat /tmp/brief.txt)" --model 'claude-opus-5-5[1m]' --effort xhigh` (with the cloud profile prefix when one is set) followed by a newline.
5. `capture_terminal` to read the session ID and URL, and record them. If the capture fails or shows no session ID, mark the launch `uncertain` and reconcile it; never send the command again.

The machine running the agent must satisfy the preflight login check.

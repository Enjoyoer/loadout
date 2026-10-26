---
name: unstuck
description: Review a stalled project with a fresh PM and get it unstuck. Use when a project has burned many hours or worker lanes without reaching its core goal, or the owner says "stuck", "why isn't this done", or "scope explosion".
---

# Unstuck

A fresh PM on the strongest available model, high thinking (the owner names it), reviews a stalled project and returns a plan the owner can approve in one reply. The usual cause is a design or process loop, such as fail-closed code plus a review loop that rewards finding new refusals, so the core cycle never runs.

## 1. Review only

- Write no code, open no PRs, send nothing to the stuck PM or its workers, and do not reuse their context.
- Read project memory with `$repo-lessons`.
- Read the earlier PMs and their worker lanes: `paseo ls -a -g`, then `paseo inspect <id>` and `paseo logs <id>` for each PM and a sample of lanes.
- Read git and PR history on main and on long-lived branches.

## 2. Numbers before opinions

Measure first. Adapt the patterns to the project:

```bash
git ls-files -z | grep -zEiv 'test|spec' | xargs -0 cat | wc -l   # production LOC
git ls-files -z | grep -zEi 'test|spec' | xargs -0 cat | wc -l    # test LOC
git grep -Eio 'refus|throw|guard|fail.?closed' | wc -l             # refusal paths
git log main --since=8.weeks --date=format:%G-W%V --format=%ad | sort | uniq -c   # main commits per week
gh pr list --state all --limit 300 --json state --jq 'group_by(.state)[] | "\(.[0].state) \(length)"'
```

Also count lanes and review rounds per week from Paseo, and how many times the core goal cycle has completed end to end. Take that last number from logs, ledgers or the owner, never from tests.

## 3. Timeline of scope growth

List the dated points where scope jumped (LOC spikes, new subsystems, new rule or evidence layers, PM swaps) and what each added that is not on the path to the goal.

## 4. Cause and rewrite

- State the cause in one line. It is a design or process cause, never a language or model one.
- Answer any rewrite proposal directly. Default: no, because a rewrite restarts the hours with the same failure mode.

## 5. Extract the intent

- Write the minimal path to one end-to-end success of the core goal.
- Keep only parts proven to work. Everything else is a delete candidate.
- Look for an existing tool or library that already does the hard part, and prefer adopting it plus thin glue over building.

## 6. Report and owner decisions

Reply with a short report: the numbers table, the timeline, the one-line cause, the rewrite answer, and the minimal path. End with owner decisions in `$wo` format: one numbered list, each item with a default, so "go with defaults" works. Cover:

1. What to delete and what to keep.
2. The base branch, and which open PRs and branches to close.
3. Rule changes the plan needs (AGENTS.md, language rules).
4. License or vendoring for the adopted tool.
5. Review scope for the delete-down PR.
6. Which agents to archive.
7. The live boundary: what may touch production, real accounts or users.

## 7. After the owner answers

- First PR: delete down to the proven core. Next PR: thin glue to the adopted tool.
- Add no new guard layers until the core cycle has run end to end once, live.
- Keep review loops short: merge on green and send findings to follow-up lanes instead of another round.
- Every review follows OPC's [review rules](../opc/references/web-reviewer.md#review-rules): a round cap and one reviewer at a time.
- Then take over with `$reassign-pm`, or keep reviewing if the owner says so.

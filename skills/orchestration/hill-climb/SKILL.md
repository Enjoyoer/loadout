---
name: hill-climb
description: Turn a task into a score agreed with the owner, then have builder agents raise it round by round, scored by separate judges, until a bar is met. Use when the owner asks to hill-climb, to make something measurably better or faster, to make a loop, build or UI flow faster, or asks where the time goes.
---

# Hill climb

A round counts only when a score proves it. An estimate or a diff is not a result.

## 1. Agree the score first
- The PM proposes what the score means: the metric, the scenario it runs on, the categories, the bar, and the budget (rounds, hours or units).
- The owner confirms before any round runs. Record the agreed definition in the project's root `STATUS.html`.
- Prefer a programmatic score: tests, an eval built from real past failures, a benchmark, latency, size or token count. Use model judges only for taste (UI, writing, design).
- A score that a builder can raise without the work getting better is the wrong score. Fix the score with the owner before climbing.

## 2. Roles
- The builder and the judges are separate agents. The builder never scores its own work.
- Each judge scores fresh every round, in a new agent, without seeing other judges' scores or earlier rounds.
- Judges score each named category from 1 to 10, with a one-line reason per score.
- Every judging pass also scores at least one known-good reference in the same pass: a competitor, the prior best, or a gold sample. A judge whose reference scores low is miscalibrated; report it, do not average it in.
- Judges are not told the bar. The parent aggregates scores and decides.
- Programmatic scores are judges too: run them the same way each round and record their raw output.

## 3. Judge ladder
- Gate with the cheapest judge first (a test run, a script, a small model). Add the expensive judges only after it passes.
- Judges follow the fleet's routing: `$opc` Worker classes, and its `review-security` class for security-sensitive work. Project rules on which models may read code still apply.

## 4. Rounds
- One builder per round, under `$opc` Worker rules. The brief gives the score definition, the last round's per-category scores and reasons, and the change to try. It does not give the bar.
- Make one change per round when possible, so the score change has one cause.
- A change that does less work, skips a check or narrows coverage is a regression, even if the score rises.

## 5. Stop rules
Stop when one of these holds:
- every gating judge meets the bar in every category;
- the owner's budget is spent;
- 2 rounds pass with no gain above the noise floor. End with a report: best version, scores, what was tried.

Keep the passing version (commit or PR) before trying any higher bar. Raise the bar only when the owner asks.

## 6. Phase 2: hold the score, cut the cost (optional)
- Once the bar is met, the owner may ask to cut size, tokens or time while the score holds.
- Every gating judge must still meet the bar after each cut. Example: the eval stays perfect while tool descriptions shrink to a third.
- A cut that drops the score is reverted and logged as "no win".

## 7. Evidence
- Log every round: round number, revision, and the score per judge and per category, plus the reference scores. A plateau must be visible from the log.
- Keep the current best and a short round log in `STATUS.html`, or in one evidence file it links. Do not create a new tracker.
- Put lessons (a judge that lied, a trap in the scenario) in `LESSONS.md` through `$repo-lessons`.
- Keep raw logs, judge outputs and CSVs in `~/.cache/fleet-scratch/<project>/<task>/`.

## Time metric
When the score is time (a loop, pipeline, build, agent run or UI flow), map the stages, cut the biggest, and prove each cut with before and after numbers.

### Fix the scenario
- Write down one scenario: input, workload size, host, revision, flags. Mark it warm or cold; never mix the two.
- Record workload counts and outcomes with every run. Runs compare only when both match. Use exit codes and receipts, not a timer's "ok", to call a run clean.

### Instrument with the least change
- Use what exists first: log timestamps, CI step times, timing flags, tracing spans.
- If you must add code, add one line per stage, `TIMING <stage> <subject> <seconds> <outcome>`, from a monotonic clock, plus one CSV row per run.
- Child timers nest inside a whole-run timer; never add nested times together. Report untimed gaps between top-level stages: a big gap is an unnamed stage.

### Baseline and noise floor
- Run the scenario at least 5 times (3 when one run takes over 10 minutes). Take median and p90 per stage.
- Noise floor: the larger of (p90 minus median) of the total and 2% of the median total. A smaller change is noise.
- Without controlled runs (live systems), use only comparable natural runs and say so. Offline replay of saved inputs proves a stage got faster, not the whole run.

### Stage map
Keep one table, sorted by share, largest first, with a line under it for scenario, revision, date and noise floor. Shares use top-level stages only.

| Stage | Start marker | End marker | Median s | p90 s | n | Share |
|---|---|---|---:|---:|---:|---:|

### Pick and prove cuts
- Start with the largest stages and the largest p90 tails. Prefer removing repeated or wasted work (a rescan, a retry, a fixed sleep longer than the event) to faster code.
- Do not cut recovery waits, cold loads or safety checks to shrink a number, and do not count background work the critical path does not wait for.
- Never book a saving twice or promise the sum of upper bounds; overlapping fixes share the same seconds.
- Per cut, report stage and total median before and after, delta, noise floor, n, and both revisions. Keep it only if the delta beats the noise floor, workload and outcomes match, and correctness checks are green; otherwise revert and log "no win".
- Round 0 can be one read-only scout that builds the map and a ranked target list with evidence and expected seconds. After each latency commit, run one read-only review for weakened guards.
- Stop when the top stage is below the noise floor, the next target costs more to prove than it saves, or the owner's target is met. Claim a sustained win only after 3 comparable clean runs at the new revision.

## Related
Use `$trial` to test a process or skill change against past work. This skill raises a score on the work itself.

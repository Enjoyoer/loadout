---
name: trial
description: Use when the owner says "trial" or "replay", or asks whether an idea (a video, an X bookmark, a skill or workflow change) would help before adopting it.
---

# Trial

Test an idea against our own past work before adopting it. Do everything up to a verdict; never adopt the change yourself.

## 1. Split the idea into rules
- Break the idea into separate rules that can each be tested on its own.
- For each rule, write down:
  - the symptom it should fix;
  - the harm it could cause, for example a review cap that cuts off a real finding.

## 2. Find cases (last 14 days, at most 20)
- Look in every host's agent histories (`paseo ls --global`, `paseo logs`) and in each project's STATUS.html, LESSONS.md and owner reports.
- Collect both kinds:
  - **Help cases:** the symptom happened.
  - **Harm cases:** the rule would have stopped something that turned out to be useful.
- If a rule has no help cases at all, mark it Drop and stop working on it.
- Listings are capped. If a host returns exactly the cap (200), page through with `--since` windows until you have the whole 14 days. List any agent whose log can't be read as a coverage gap.
- Touch a file in the trial folder at least every 5 days, so the 7-day scratch expiry doesn't delete the evidence.

## 3. Judge each case
- For every case, write: does the rule apply, and would the outcome have been better, worse or the same?
- Back every judgment with evidence: the agent id plus a short quote, or a file path.
- If there's no evidence, write "unknown", not "same".

## 4. Replay at most 3 cases
- Pick the most informative cases and rerun each from its original state, in a scratch copy under `~/.cache/fleet-scratch/<project>/trial-<topic>/`.
- Use the same model and prompt each time: once with the current text and once with the proposed text.
- Count only what you saw happen in those runs. A reasoned prediction is not a result.
- Launch every replay agent with its cwd set explicitly to the scratch clone (no remote), and check the cwd before sending the prompt. A default cwd can land in the real repo.
- During a replay:
  - never push, merge, message other agents, or touch live services or real accounts;
  - stop if the replay would need any of those.

## Budget
- Use one analysis worker. Read-only GPT is fine for this.
- Use one reviewer at a time.
- No nested sub-agents.
- Stop once the verdict is clear, even if you haven't used every case or replay.

## Verdict
- Write a table to the scratch folder with these columns: rule, help cases, harm cases, unknown, replay result, verdict.
- Each verdict is one of Adopt, Adopt modified (say what changed) or Drop.
- A help case only shows that the symptom happened. Adopt and Adopt modified stay "provisional" until a replay shows the improvement. Report coverage gaps next to the verdicts.
- Report to the owning PM in at most 6 lines. Include harms and unknowns plainly; never hide a rule that did harm.
- End the report with: `Trial: N cases, R replays, verdicts: ...`.
- The owning PM decides what to adopt. Skills belong to the skills owner.

## Asking the owner
Ask only if you are blocked. Put all the context in the question: what blocks you, the options, and your recommendation.

## X bookmarks
A bookmark that proposes a tool or workflow change uses this skill as its A/B plan. If it gets no help cases, it closes as Drop without a replay.

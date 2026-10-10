# PR evidence

The PM attaches before and after evidence when a PR changes something a person can see: a picker or menu, a plugin surface, a sidebar or panel, a TUI, or a web page. A PR with no visible change says "No visible change" in its description instead of an image.

## Capture

- Capture before from the base and after from the candidate, with the same view, size, and data. Use images; use a short video only when motion matters.
- Capture from a disposable instance: a scratch app, a throwaway profile, or a headless browser. Never capture the owner's live desktop session.
- If the real UI cannot be captured safely, render the same data the UI shows and label the image "Rendered data, not a screenshot" in the file and the description.
- Use example data. Never capture keys, tokens, emails, account names, or other personal data; mask them when they cannot be avoided.

## Check each file

Text-only staged-content scanners cannot read binaries, so a clean scan does not clear an image or video. Before pushing, check every file:

1. Look at it at full size, including corners, tooltips, and status bars. For video, watch it end to end.
2. Read embedded text and metadata, for example `strings -n 6 FILE` and `exiftool FILE`. Strip metadata with `exiftool -all= -overwrite_original FILE`, then check again.
3. Recapture or mask anything private; never push a file that failed a check.

## Publish

Evidence lives on the orphan branch `pr-evidence`, never merged, so it stays out of the main history. Use one folder per PR, named by PR number or branch name. Work in a temporary detached worktree outside the delivery checkout, so no local branch is moved:

```bash
git fetch origin pr-evidence && git worktree add --detach <tmp> origin/pr-evidence
# first use only, when origin has no pr-evidence branch yet (Git refuses if a local one exists):
git worktree add --orphan -b pr-evidence <tmp>
```

A local `pr-evidence` branch can hold evidence that was never pushed. Never reset or delete it: if `git rev-list --count origin/pr-evidence..pr-evidence` is not 0, cherry-pick those commits into the worktree first so they are published too.

Copy the files to `<tmp>/<folder>/` (for example `before.png` and `after.png`), commit only that folder, and `git push origin HEAD:pr-evidence`. A rejected push means newer remote evidence: fetch, `git rebase origin/pr-evidence` in the worktree, and push again. Remove the temporary worktree only after the push succeeds; to stop earlier, keep the commit on a branch first (`git branch pr-evidence-<folder>` in the worktree).

Embed the files in the PR description with raw links:

```markdown
| Before | After |
| --- | --- |
| ![before](https://raw.githubusercontent.com/<owner>/<repo>/pr-evidence/<folder>/before.png) | ![after](https://raw.githubusercontent.com/<owner>/<repo>/pr-evidence/<folder>/after.png) |
```

A video shows as a link, not inline. Report the evidence links, or "No visible change", with the delivery report.

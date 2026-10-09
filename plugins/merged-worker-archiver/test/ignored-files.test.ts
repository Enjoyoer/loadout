import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { evaluateWorkspace } from "../server/evaluate.ts";
import { nodeFileSystem, runCommand } from "../server/io.ts";
import { agent, NOW, workspace } from "./fakes.ts";

// Real git: the point is what `git status` itself reports for an ignored file.
it("a merged worktree whose only change is a git-ignored file is not archived: dirty(ignored=1)", async () => {
  const root = path.resolve("node_modules/.cache"); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "ignored-test-"));
  try {
    const repo = path.join(dir, "repo");
    const wt = path.join(dir, "wt");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
    await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, ".gitignore"), ".env\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "-b", "opc/feature", wt, "main");
    await writeFile(path.join(wt, "work.txt"), "work\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "work");
    git(repo, "merge", "-q", "--ff-only", "opc/feature");
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
    await mkdir(path.join(gitDir, "paseo"));
    await writeFile(path.join(gitDir, "paseo", "worktree.json"), JSON.stringify({ version: 2, baseRefName: "main", baseRef: "refs/heads/main" }));
    await writeFile(path.join(wt, ".env"), "TOKEN=local\n");

    const decide = () =>
      evaluateWorkspace(workspace({ workspaceDirectory: wt }), [agent()], defaultConfig({ useGh: false }), {
        merge: { run: runCommand, fs: nodeFileSystem },
        fs: nodeFileSystem,
        now: () => NOW,
      });
    const blocked = await decide();
    assert.equal(blocked.action, "skip");
    assert.equal(blocked.reason, "dirty(ignored=1)");

    // The ignored file was the only blocker.
    await rm(path.join(wt, ".env"));
    const clean = await decide();
    assert.equal(clean.action, "archive", clean.reason);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

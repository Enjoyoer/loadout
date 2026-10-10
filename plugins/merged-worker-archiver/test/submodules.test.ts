import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { evaluateWorkspace } from "../server/evaluate.ts";
import { nodeFileSystem, runCommand } from "../server/io.ts";
import { agent, NOW, workspace } from "./fakes.ts";

// Real git: the point is what `git status` does not report inside a submodule.
it("a merged worktree whose submodule holds files git status does not report is not archived: submodule(sub)", async () => {
  const root = path.resolve("node_modules/.cache"); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "submodule-test-"));
  try {
    const lib = path.join(dir, "lib");
    const repo = path.join(dir, "repo");
    const wt = path.join(dir, "wt");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" }).trim();
    await mkdir(lib);
    git(lib, "init", "-q", "-b", "main");
    await writeFile(path.join(lib, "lib.txt"), "lib\n");
    git(lib, "add", ".");
    git(lib, "commit", "-qm", "lib");
    await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "submodule", "add", "-q", lib, "sub");
    // The committed .gitmodules hides every change inside the submodule from the superproject's status.
    git(repo, "config", "-f", ".gitmodules", "submodule.sub.ignore", "all");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "-b", "opc/feature", wt, "main");
    await writeFile(path.join(wt, "work.txt"), "work\n");
    git(wt, "add", "work.txt");
    git(wt, "commit", "-qm", "work");
    git(repo, "merge", "-q", "--ff-only", "opc/feature");
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
    await mkdir(path.join(gitDir, "paseo"));
    await writeFile(path.join(gitDir, "paseo", "worktree.json"), JSON.stringify({ version: 2, baseRefName: "main", baseRef: "refs/heads/main" }));

    const status = () => git(wt, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching");
    const decide = () =>
      evaluateWorkspace(workspace({ workspaceDirectory: wt }), [agent()], defaultConfig({ useGh: false }), {
        merge: { run: runCommand, fs: nodeFileSystem },
        fs: nodeFileSystem,
        now: () => NOW,
      });

    // An unpopulated submodule is an empty directory: nothing to lose.
    const unpopulated = await decide();
    assert.equal(unpopulated.action, "archive", unpopulated.reason);

    // A file in the unpopulated submodule directory is invisible to git.
    await writeFile(path.join(wt, "sub", "stray.txt"), "stray\n");
    assert.equal(status(), "");
    const stray = await decide();
    assert.equal(stray.action, "skip");
    assert.equal(stray.reason, "submodule(sub)");
    await rm(path.join(wt, "sub", "stray.txt"));

    // Populated, with an uncommitted file the ignore setting keeps out of the superproject's status.
    git(wt, "submodule", "update", "-q", "--init");
    await writeFile(path.join(wt, "sub", "notes.txt"), "uncommitted\n");
    assert.equal(status(), "");
    const populated = await decide();
    assert.equal(populated.action, "skip");
    assert.equal(populated.reason, "submodule(sub)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

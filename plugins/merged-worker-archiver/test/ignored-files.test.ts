import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { evaluateCleanup } from "../server/cleanup.ts";
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
      evaluateWorkspace(workspace({ workspaceDirectory: wt }), [agent()], defaultConfig({ useGh: false, archiveFinishedWithoutPr: false }), {
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

/**
 * A real repository with a merged agentless worktree (Paseo metadata included) that ignores __pycache__/
 * and .env, and its workspace cleanup decision two hours after its last commit.
 */
async function agentlessWorktree(run: (wt: string, git: (cwd: string, ...args: string[]) => string, decide: () => Promise<string>) => Promise<void>): Promise<void> {
  const root = path.resolve("node_modules/.cache"); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "agentless-ignored-"));
  try {
    const repo = path.join(dir, "repo");
    const wt = path.join(dir, "wt");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
    await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, ".gitignore"), "__pycache__/\n.env\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "-b", "opc/feature", wt, "main");
    await writeFile(path.join(wt, "work.py"), "print('work')\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "work");
    git(repo, "merge", "-q", "--ff-only", "opc/feature");
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
    await mkdir(path.join(gitDir, "paseo"));
    await writeFile(path.join(gitDir, "paseo", "worktree.json"), JSON.stringify({ version: 2, baseRefName: "main", baseRef: "refs/heads/main" }));
    for (const cache of ["__pycache__", "pkg/__pycache__"]) {
      await mkdir(path.join(wt, cache), { recursive: true });
      await writeFile(path.join(wt, cache, "work.cpython-312.pyc"), "bytecode");
    }
    const decide = async () => {
      const decision = await evaluateCleanup(workspace({ workspaceDirectory: wt }), {
        config: defaultConfig({ useGh: false, staleWorkspaceMinutes: 60 }),
        deps: { merge: { run: runCommand, fs: nodeFileSystem }, fs: nodeFileSystem, now: () => Date.now() + 2 * 60 * 60_000 },
        agents: [],
        history: [],
        terminals: 0,
        deliveries: new Map(),
        notified: new Map(),
      });
      return `${decision.action} ${decision.reason}`;
    };
    await run(wt, git, decide);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

it("workspace cleanup: an agentless worktree whose only ignored files are __pycache__ output counts as clean", async () => {
  await agentlessWorktree(async (wt, git, decide) => {
    // Merged and clean apart from the bytecode: archived (the merged worker path would say dirty(ignored=2)).
    assert.match(await decide(), /^archive stale-agentless-merged\(idle=2h; merged-ancestry\(refs\/heads\/main\)\)$/);
    // Unmerged: still kept and reported, now for the branch rather than the bytecode.
    await writeFile(path.join(wt, "more.py"), "print('more')\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "more");
    assert.match(await decide(), /^notify not-merged\(ahead=1 of refs\/heads\/main; gh disabled\); idle=2h$/);
  });
});

it("workspace cleanup: an agentless worktree with an ignored .env stays dirty and is kept", async () => {
  await agentlessWorktree(async (wt, _git, decide) => {
    await writeFile(path.join(wt, ".env"), "TOKEN=local\n");
    assert.equal(await decide(), "notify dirty(ignored=1); idle=2h");
    // Inside a regenerable directory too.
    await rm(path.join(wt, ".env"));
    await writeFile(path.join(wt, "pkg", "__pycache__", ".env"), "TOKEN=local\n");
    assert.equal(await decide(), "notify dirty(sensitive-ignored=1:pkg/__pycache__/.env); idle=2h");
  });
});

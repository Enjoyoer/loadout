import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { evaluateWorkspace } from "../server/evaluate.ts";
import { agent, NOW, workspace } from "./fakes.ts";

// Every git call in this file inherits GIT_LITERAL_PATHSPECS=1, under which a pathspec such as `:/` matches nothing.
// It is set before io.ts loads, so the plugin's git environment starts from it too.
process.env.GIT_LITERAL_PATHSPECS = "1";
const { nodeFileSystem, runCommand } = await import("../server/io.ts");

const GIT_CONFIG = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_CONFIG, ...args], { cwd, encoding: "utf8" }).trim();

const decide = (wt: string) =>
  evaluateWorkspace(workspace({ workspaceDirectory: wt }), [agent()], defaultConfig({ useGh: false }), {
    merge: { run: runCommand, fs: nodeFileSystem },
    fs: nodeFileSystem,
    now: () => NOW,
  });

/** A worktree on opc/feature whose own commit is merged into main. `stage(repo)` stages the repo's first commit. */
async function mergedWorktree(dir: string, stage: (repo: string) => Promise<void>): Promise<string> {
  const repo = path.join(dir, "repo");
  const wt = path.join(dir, "wt");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await stage(repo);
  git(repo, "commit", "-qm", "init");
  git(repo, "worktree", "add", "-q", "-b", "opc/feature", wt, "main");
  await writeFile(path.join(wt, "work.txt"), "work\n");
  git(wt, "add", "work.txt");
  git(wt, "commit", "-qm", "work");
  git(repo, "merge", "-q", "--ff-only", "opc/feature");
  const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
  await mkdir(path.join(gitDir, "paseo"));
  await writeFile(path.join(gitDir, "paseo", "worktree.json"), JSON.stringify({ version: 2, baseRefName: "main", baseRef: "refs/heads/main" }));
  return wt;
}

/** A merged worktree with an unpopulated submodule `sub` whose committed .gitmodules hides every change in it. */
async function submoduleWorktree(dir: string): Promise<string> {
  const lib = path.join(dir, "lib");
  await mkdir(lib);
  git(lib, "init", "-q", "-b", "main");
  await writeFile(path.join(lib, "lib.txt"), "lib\n");
  git(lib, "add", ".");
  git(lib, "commit", "-qm", "lib");
  return mergedWorktree(dir, async (repo) => {
    git(repo, "submodule", "add", "-q", lib, "sub");
    git(repo, "config", "-f", ".gitmodules", "submodule.sub.ignore", "all");
    git(repo, "add", ".");
  });
}

async function scratch(name: string): Promise<string> {
  const root = path.resolve("node_modules/.cache"); await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, `${name}-`));
}

// Real git: the point is what `git status` does not report inside a submodule.
it("a merged worktree whose submodule holds files git status does not report is not archived: submodule(sub)", async () => {
  const dir = await scratch("submodule-test");
  try {
    const wt = await submoduleWorktree(dir);
    const status = () => git(wt, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching");

    // An unpopulated submodule is an empty directory: nothing to lose.
    const unpopulated = await decide(wt);
    assert.equal(unpopulated.action, "archive", unpopulated.reason);

    // A file in the unpopulated submodule directory is invisible to git.
    await writeFile(path.join(wt, "sub", "stray.txt"), "stray\n");
    assert.equal(status(), "");
    const stray = await decide(wt);
    assert.equal(stray.action, "skip");
    assert.equal(stray.reason, "submodule(sub)");
    await rm(path.join(wt, "sub", "stray.txt"));

    // Populated, with an uncommitted file the ignore setting keeps out of the superproject's status.
    git(wt, "submodule", "update", "-q", "--init");
    await writeFile(path.join(wt, "sub", "notes.txt"), "uncommitted\n");
    assert.equal(status(), "");
    const populated = await decide(wt);
    assert.equal(populated.action, "skip");
    assert.equal(populated.reason, "submodule(sub)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("a submodule path that is a symlink to an empty directory is not archived: submodule(sub)", async () => {
  const dir = await scratch("submodule-link-test");
  try {
    const wt = await submoduleWorktree(dir);
    const empty = path.join(dir, "empty");
    await mkdir(empty);
    await rm(path.join(wt, "sub"), { recursive: true });
    await symlink(empty, path.join(wt, "sub"), "junction");
    const linked = await decide(wt);
    assert.equal(linked.action, "skip");
    assert.equal(linked.reason, "submodule(sub)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Byte 0xff alone is not UTF-8; EF BF BD is U+FFFD, which lossy decoding turns 0xff into. Windows and macOS file
// systems do not store such names.
it("gitlinks named sub-\\xff and sub-\\xef\\xbf\\xbd are not archived: a path that is not UTF-8 is ambiguous", { skip: process.platform === "win32" || process.platform === "darwin" }, async () => {
  const dir = await scratch("submodule-bytes-test");
  try {
    const invalid = Buffer.from([0x73, 0x75, 0x62, 0x2d, 0xff]);
    const replacement = Buffer.from([0x73, 0x75, 0x62, 0x2d, 0xef, 0xbf, 0xbd]);
    const wt = await mergedWorktree(dir, async (repo) => {
      const entry = (name: Buffer) => Buffer.concat([Buffer.from(`160000 ${"1".repeat(40)} 0\t`), name, Buffer.from([0])]);
      execFileSync("git", [...GIT_CONFIG, "update-index", "-z", "--index-info"], { cwd: repo, input: Buffer.concat([entry(invalid), entry(replacement)]) });
    });
    // The checkout leaves both unpopulated gitlinks as empty directories; only sub-\xff holds a file.
    const root = Buffer.from(`${wt}/`);
    await writeFile(Buffer.concat([root, invalid, Buffer.from("/notes.txt")]), "uncommitted\n");
    const decision = await decide(wt);
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "ambiguous(submodule path not UTF-8)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

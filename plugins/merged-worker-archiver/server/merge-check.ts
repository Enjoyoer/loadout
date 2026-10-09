import type { CommandResult, CommandRunner, FileSystem } from "./types.ts";

export interface MergeCheckDeps {
  run: CommandRunner;
  fs: FileSystem;
  timeoutMs: number;
  useGh: boolean;
}

export interface MergeCheckResult {
  merged: boolean;
  via?: "ancestry" | "pr";
  branch: string | null;
  base: string | null;
  reason: string;
}

type WorktreeMetadata = {
  baseRef?: unknown;
  baseRefName?: unknown;
};

type PullRequest = {
  number?: unknown;
  state?: unknown;
  mergeCommit?: { oid?: unknown } | null;
  headRefOid?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
};

function text(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function gitFailure(label: string, result: CommandResult): string {
  if (result.timedOut) return `git-timeout(${label})`;
  if (result.notFound) return "git-not-found";
  return `git-error(${label}:exit=${result.code ?? "null"}:${text(result)})`;
}

async function runGit(
  deps: MergeCheckDeps,
  directory: string,
  args: readonly string[],
  label: string,
): Promise<{ result: CommandResult; failure: string | null }> {
  const result = await deps.run("git", args, directory, deps.timeoutMs);
  if (result.code === 0) return { result, failure: null };
  return { result, failure: gitFailure(label, result) };
}

function baseName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

// Branch name of a local or remote-tracking ref: refs/remotes/origin/x and refs/heads/x are both x.
function shortBranchName(ref: string): string {
  return ref.replace(/^refs\/remotes\/[^/]+\//, "").replace(/^refs\/heads\//, "");
}

async function existingRef(deps: MergeCheckDeps, directory: string, ref: string): Promise<boolean> {
  const { result } = await runGit(deps, directory, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], `verify ${ref}`);
  return result.code === 0;
}

// The upstream of the BASE branch, never of the worktree's own branch: after `git push -u`
// the worker branch's upstream is refs/remotes/origin/<branch>, which always contains HEAD.
async function baseUpstreamRef(deps: MergeCheckDeps, directory: string, baseRefName: string): Promise<string> {
  const { result } = await runGit(deps, directory, ["rev-parse", "--symbolic-full-name", `${baseRefName}@{upstream}`], `upstream ${baseRefName}`);
  const value = result.code === 0 ? result.stdout.trim() : "";
  return value || `refs/remotes/origin/${baseRefName}`;
}

function parseMetadata(raw: string | null): { value: WorktreeMetadata | null; reason: string | null } {
  if (raw === null) return { value: null, reason: "no-base(paseo worktree metadata missing)" };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: null, reason: "no-base(paseo worktree metadata is not an object)" };
    }
    return { value: value as WorktreeMetadata, reason: null };
  } catch {
    return { value: null, reason: "no-base(paseo worktree metadata invalid JSON)" };
  }
}

function statusCounts(status: string): { changed: number; untracked: number } {
  let changed = 0;
  let untracked = 0;
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("??")) untracked += 1;
    else changed += 1;
  }
  return { changed, untracked };
}

function hasBranchCommit(reflog: string): boolean {
  return reflog.split("\n").some((line) => /\b(?:commit|cherry-pick)\b/.test(line));
}

function prReason(pr: PullRequest, number: number, baseRef: string): string {
  if (pr.state === "OPEN") return `not-merged(ahead of ${baseRef}; PR #${number} open)`;
  if (pr.state === "CLOSED") return `not-merged(ahead of ${baseRef}; PR #${number} closed)`;
  return `not-merged(ahead of ${baseRef}; PR #${number} state=${String(pr.state ?? "unknown")})`;
}

export async function checkMerged(directory: string, deps: MergeCheckDeps): Promise<MergeCheckResult> {
  const gitDirResult = await runGit(deps, directory, ["rev-parse", "--absolute-git-dir"], "absolute-git-dir");
  if (gitDirResult.failure) return { merged: false, branch: null, base: null, reason: gitDirResult.failure };
  const gitDir = gitDirResult.result.stdout.trim();
  if (!gitDir) return { merged: false, branch: null, base: null, reason: "ambiguous(git dir missing)" };

  const branchResult = await runGit(deps, directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], "symbolic-ref");
  if (branchResult.failure) {
    if (branchResult.result.code === 1) return { merged: false, branch: null, base: null, reason: "detached-head" };
    return { merged: false, branch: null, base: null, reason: branchResult.failure };
  }
  const branch = branchResult.result.stdout.trim();
  if (!branch) return { merged: false, branch: null, base: null, reason: "detached-head" };

  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    if (await deps.fs.exists(`${gitDir}/${marker}`)) {
      return { merged: false, branch, base: null, reason: `operation-in-progress(${marker})` };
    }
  }

  const statusResult = await runGit(deps, directory, ["status", "--porcelain=v1", "--untracked-files=all"], "status");
  if (statusResult.failure) return { merged: false, branch, base: null, reason: statusResult.failure };
  const status = statusCounts(statusResult.result.stdout);
  if (status.changed > 0 || status.untracked > 0) {
    return { merged: false, branch, base: null, reason: `dirty(changed=${status.changed},untracked=${status.untracked})` };
  }

  const reflogResult = await runGit(deps, directory, ["reflog", "show", "--format=%H %gs"], "reflog");
  if (reflogResult.failure) return { merged: false, branch, base: null, reason: reflogResult.failure };
  if (!reflogResult.result.stdout.trim()) return { merged: false, branch, base: null, reason: "ambiguous(branch reflog empty)" };
  if (!hasBranchCommit(reflogResult.result.stdout)) return { merged: false, branch, base: null, reason: "no-branch-commits" };

  const metadata = parseMetadata(await deps.fs.readText(`${gitDir}/paseo/worktree.json`));
  if (metadata.reason || !metadata.value) {
    return { merged: false, branch, base: null, reason: metadata.reason ?? "no-base(paseo worktree metadata missing)" };
  }
  const baseRefName = typeof metadata.value.baseRefName === "string" ? metadata.value.baseRefName : null;
  const exactBase = typeof metadata.value.baseRef === "string" ? metadata.value.baseRef : null;
  if (baseRefName && branch === baseRefName) return { merged: false, branch, base: baseRefName, reason: "branch-is-base" };
  if (!baseRefName && !exactBase) return { merged: false, branch, base: null, reason: "no-base(paseo worktree metadata has no base ref)" };

  const candidates: string[] = [];
  if (exactBase) candidates.push(exactBase);
  if (baseRefName) candidates.push(`refs/heads/${baseRefName}`);
  if (baseRefName) candidates.push(await baseUpstreamRef(deps, directory, baseRefName));
  let baseRef: string | null = null;
  let base: string | null = null;
  for (const candidate of [...new Set(candidates)]) {
    if (shortBranchName(candidate) === branch) continue;
    if (!(await existingRef(deps, directory, candidate))) continue;
    const candidateBase = baseRefName ?? baseName(candidate);
    const ancestor = await runGit(deps, directory, ["merge-base", "--is-ancestor", "HEAD", candidate], `is-ancestor ${candidate}`);
    if (ancestor.result.code === 0) {
      return { merged: true, via: "ancestry", branch, base: candidateBase, reason: `merged-ancestry(${candidate})` };
    }
    if (ancestor.failure && ancestor.result.code !== 1) {
      return { merged: false, branch, base: candidateBase, reason: ancestor.failure };
    }
    if (!baseRef) {
      baseRef = candidate;
      base = candidateBase;
    }
  }
  if (!baseRef) return { merged: false, branch, base: baseRefName ?? exactBase, reason: "no-base(base ref not found locally)" };

  const aheadResult = await runGit(deps, directory, ["rev-list", "--count", `${baseRef}..HEAD`], `rev-list ${baseRef}..HEAD`);
  if (aheadResult.failure) return { merged: false, branch, base, reason: aheadResult.failure };
  const aheadText = aheadResult.result.stdout.trim();
  const ahead = Number.parseInt(aheadText, 10);
  const aheadValue = Number.isFinite(ahead) ? ahead : "unknown";
  if (!deps.useGh) return { merged: false, branch, base, reason: `not-merged(ahead=${aheadValue} of ${baseRef}; gh disabled)` };

  const ghResult = await deps.run("gh", ["pr", "view", branch, "--json", "number,state,mergeCommit,headRefOid,headRefName,baseRefName"], directory, deps.timeoutMs);
  if (ghResult.notFound) return { merged: false, branch, base, reason: `not-merged(ahead=${aheadValue} of ${baseRef}; gh unavailable)` };
  if (ghResult.timedOut) return { merged: false, branch, base, reason: "gh-timeout" };
  if (ghResult.code !== 0) {
    const stderr = ghResult.stderr.toLowerCase();
    if (stderr.includes("no pull requests found")) return { merged: false, branch, base, reason: `not-merged(ahead=${aheadValue} of ${baseRef}; no PR)` };
    if (stderr.includes("no git remotes found")) return { merged: false, branch, base, reason: `not-merged(ahead=${aheadValue} of ${baseRef}; no GitHub remote)` };
    return { merged: false, branch, base, reason: `gh-error(exit=${ghResult.code ?? "null"}:${text(ghResult)})` };
  }

  let pr: PullRequest;
  try {
    const parsed = JSON.parse(ghResult.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    pr = parsed as PullRequest;
  } catch {
    return { merged: false, branch, base, reason: "gh-error(unparseable json)" };
  }
  const number = typeof pr.number === "number" ? pr.number : 0;
  if (pr.headRefName !== branch) return { merged: false, branch, base, reason: `pr-head-mismatch(PR #${number})` };
  if (pr.baseRefName !== base) return { merged: false, branch, base, reason: `pr-base-mismatch(PR #${number})` };
  if (pr.state !== "MERGED") return { merged: false, branch, base, reason: prReason(pr, number, baseRef) };
  if (!pr.mergeCommit || typeof pr.mergeCommit !== "object" || typeof pr.mergeCommit.oid !== "string" || !pr.mergeCommit.oid) {
    return { merged: false, branch, base, reason: `ambiguous(PR #${number} merged without mergeCommit)` };
  }
  if (typeof pr.headRefOid !== "string" || !pr.headRefOid) {
    return { merged: false, branch, base, reason: `ambiguous(PR #${number} missing headRefOid)` };
  }
  const contained = await runGit(deps, directory, ["merge-base", "--is-ancestor", "HEAD", pr.headRefOid], `is-ancestor PR #${number} head`);
  if (contained.result.code === 0) return { merged: true, via: "pr", branch, base, reason: `merged-pr(#${number})` };
  if (contained.result.code === 1) return { merged: false, branch, base, reason: `unmerged-commits(after PR #${number} head)` };
  if (contained.failure) {
    if (contained.result.code === 128) return { merged: false, branch, base, reason: `ambiguous(PR #${number} head commit not present locally)` };
    return { merged: false, branch, base, reason: contained.failure };
  }
  return { merged: false, branch, base, reason: `not-merged(PR #${number} head containment failed)` };
}

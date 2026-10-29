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

// Ignored output the no-PR path and workspace cleanup's agentless worktrees may discard: dependency, cache, and
// coverage output a review or build recreates.
// Build output names (dist, build) are not on the list: projects commit or ignore real files under them.
const REGENERABLE_SEGMENTS = new Set(["node_modules", "__pycache__", ".pytest_cache", ".venv", ".turbo", ".next", ".cache", "coverage"]);
// An ignored file with one of these basenames blocks those paths, even inside a regenerable directory.
const SENSITIVE_BASENAME = /^\.env|\.pem$|\.key$|^id_(?:rsa|ed25519|ecdsa)/i;
// The same names as git pathspecs, for listing ignored files inside regenerable directories.
const SENSITIVE_PATHSPECS = [".env*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "id_ecdsa*"].map((glob) => `:(glob,icase)**/${glob}`);

/** An ignored porcelain path that is clearly regenerable. A quoted path (special characters) never is. */
function isRegenerablePath(path: string): boolean {
  if (!path || path.startsWith("\"")) return false;
  const segments = path.split("/").filter(Boolean);
  if (SENSITIVE_BASENAME.test(segments.at(-1) ?? "")) return false;
  if (segments.some((segment) => REGENERABLE_SEGMENTS.has(segment))) return true;
  return !path.endsWith("/") && (segments.at(-1)?.endsWith(".tsbuildinfo") ?? false);
}

function statusCounts(status: string, allowRegenerable = false): { changed: number; untracked: number; ignored: number; regenerable: number } {
  let changed = 0;
  let untracked = 0;
  let ignored = 0;
  let regenerable = 0;
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("??")) untracked += 1;
    else if (line.startsWith("!!")) {
      if (allowRegenerable && isRegenerablePath(line.slice(3))) regenerable += 1;
      else ignored += 1;
    }
    else changed += 1;
  }
  return { changed, untracked, ignored, regenerable };
}

function dirtyReason(status: { changed: number; untracked: number; ignored: number }): string | null {
  const parts: string[] = [];
  if (status.changed > 0 || status.untracked > 0) parts.push(`changed=${status.changed}`, `untracked=${status.untracked}`);
  if (status.ignored > 0) parts.push(`ignored=${status.ignored}`);
  return parts.length > 0 ? `dirty(${parts.join(",")})` : null;
}

const GITLINK_ENTRY = Buffer.from("160000 ");
// Strict UTF-8 that keeps a leading U+FEFF, so a decoded path names exactly the bytes git listed.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Submodule (gitlink) paths in `git ls-files --stage -z` output: "<mode> <object> <stage>\t<path>\0" per entry.
 * Paths are bytes: null when a gitlink path is not valid UTF-8 (lossy decoding could merge two of them into one
 * name) or its entry is malformed.
 */
function gitlinkPaths(listing: Buffer): string[] | null {
  const paths = new Set<string>();
  for (let start = 0; start < listing.length; ) {
    const nul = listing.indexOf(0, start);
    const end = nul < 0 ? listing.length : nul;
    const entry = listing.subarray(start, end);
    start = end + 1;
    if (!entry.subarray(0, GITLINK_ENTRY.length).equals(GITLINK_ENTRY)) continue;
    const tab = entry.indexOf(9);
    if (tab < 0) return null;
    try {
      paths.add(STRICT_UTF8.decode(entry.subarray(tab + 1)));
    } catch {
      return null;
    }
  }
  return [...paths];
}

function hasBranchCommit(reflog: string): boolean {
  return reflog.split("\n").some((line) => /\b(?:commit|cherry-pick)\b/.test(line));
}

function prReason(pr: PullRequest, number: number, baseRef: string): string {
  if (pr.state === "OPEN") return `not-merged(ahead of ${baseRef}; PR #${number} open)`;
  if (pr.state === "CLOSED") return `not-merged(ahead of ${baseRef}; PR #${number} closed)`;
  return `not-merged(ahead of ${baseRef}; PR #${number} state=${String(pr.state ?? "unknown")})`;
}

type Inspection =
  | { ok: true; gitDir: string; branch: string }
  | { ok: false; branch: string | null; reason: string };

/**
 * Gates shared by every archive path: a branch, no git operation in progress, a clean status
 * (changed, untracked, and ignored files all count), and no non-empty submodule directory.
 */
async function inspectWorktree(directory: string, deps: MergeCheckDeps, allowRegenerable = false): Promise<Inspection> {
  const gitDirResult = await runGit(deps, directory, ["rev-parse", "--absolute-git-dir"], "absolute-git-dir");
  if (gitDirResult.failure) return { ok: false, branch: null, reason: gitDirResult.failure };
  const gitDir = gitDirResult.result.stdout.trim();
  if (!gitDir) return { ok: false, branch: null, reason: "ambiguous(git dir missing)" };

  const branchResult = await runGit(deps, directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], "symbolic-ref");
  if (branchResult.failure) {
    if (branchResult.result.code === 1) return { ok: false, branch: null, reason: "detached-head" };
    return { ok: false, branch: null, reason: branchResult.failure };
  }
  const branch = branchResult.result.stdout.trim();
  if (!branch) return { ok: false, branch: null, reason: "detached-head" };

  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    if (await deps.fs.exists(`${gitDir}/${marker}`)) {
      return { ok: false, branch, reason: `operation-in-progress(${marker})` };
    }
  }

  // Ignored files (.env, notes, node_modules) count as dirty too: archiving removes the
  // worktree with --force. "matching" lists an ignored directory once instead of every file in it.
  const statusResult = await runGit(deps, directory, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], "status");
  if (statusResult.failure) return { ok: false, branch, reason: statusResult.failure };
  const counts = statusCounts(statusResult.result.stdout, allowRegenerable);
  const dirty = dirtyReason(counts);
  if (dirty) return { ok: false, branch, reason: dirty };

  // That status cannot vouch for submodules: submodule.<name>.ignore or diff.ignoreSubmodules hides their changes,
  // their ignored files are never listed, and files in an unpopulated submodule directory are invisible to git.
  // Archiving removes them with the worktree, so any submodule directory that is not empty blocks it. The index is
  // listed from the top level with no pathspec, so every entry is listed whatever directory the workspace names.
  const topResult = await runGit(deps, directory, ["rev-parse", "--show-toplevel"], "show-toplevel");
  if (topResult.failure) return { ok: false, branch, reason: topResult.failure };
  // Only git's own line end comes off: a path can end in a space, and a trimmed one names a different checkout.
  const topOutput = topResult.result.stdout;
  const topLevel = topOutput.endsWith("\n") ? topOutput.slice(0, -1) : topOutput;
  const [realTop, realDirectory] = topLevel ? await Promise.all([deps.fs.realpath(topLevel), deps.fs.realpath(directory)]) : [null, null];
  if (!realTop || realTop !== realDirectory) {
    return { ok: false, branch, reason: "ambiguous(git top level is not the workspace directory)" };
  }
  const indexResult = await runGit(deps, topLevel, ["ls-files", "--stage", "-z"], "ls-files");
  if (indexResult.failure) return { ok: false, branch, reason: indexResult.failure };
  const submodules = indexResult.result.stdoutBytes ? gitlinkPaths(indexResult.result.stdoutBytes) : null;
  if (!submodules) return { ok: false, branch, reason: "ambiguous(submodule path not UTF-8)" };
  for (const submodule of submodules) {
    if (!(await deps.fs.isEmptyDirectory(`${topLevel}/${submodule}`))) {
      return { ok: false, branch, reason: `submodule(${submodule})` };
    }
  }

  // Status lists an ignored directory once, so list the ignored files inside it whose names look sensitive.
  if (counts.regenerable > 0) {
    const sensitive = await runGit(deps, topLevel, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...SENSITIVE_PATHSPECS], "sensitive ignored files");
    if (sensitive.failure) return { ok: false, branch, reason: sensitive.failure };
    const hits = sensitive.result.stdout.split("\0").filter(Boolean);
    if (hits.length > 0) return { ok: false, branch, reason: `dirty(sensitive-ignored=${hits.length}:${hits[0]})` };
  }
  return { ok: true, gitDir, branch };
}

/**
 * `allowRegenerable` applies the no-PR path's ignored-file rule (regenerable output is not dirty, a sensitive
 * name or a quoted path is). Only workspace cleanup's agentless worktrees set it; the merged worker path does
 * not, so it still counts every ignored file as dirty.
 */
export async function checkMerged(directory: string, deps: MergeCheckDeps, options: { allowRegenerable?: boolean } = {}): Promise<MergeCheckResult> {
  const inspection = await inspectWorktree(directory, deps, options.allowRegenerable === true);
  if (!inspection.ok) return { merged: false, branch: inspection.branch, base: null, reason: inspection.reason };
  const { gitDir, branch } = inspection;

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

export interface FinishedCheckResult {
  finished: boolean;
  branch: string | null;
  base: string | null;
  reason: string;
}

// owner/repo of a GitHub remote URL (https, ssh, or scp-like), or null for anything else.
function githubRepo(url: string): string | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The no-PR path: a clean worktree whose work is safe elsewhere and that no open PR is waiting on.
 * A live `git ls-remote` of every remote must show a head commit, present locally, that contains HEAD, and gh
 * must report no open PR for the branch in any GitHub remote's repository. Anything unknown is a skip.
 */
export async function checkFinishedWithoutPr(directory: string, deps: MergeCheckDeps): Promise<FinishedCheckResult> {
  // Regenerable ignored output (node_modules, .cache, ...) does not block this path; the merged path keeps it dirty.
  const inspection = await inspectWorktree(directory, deps, true);
  if (!inspection.ok) return { finished: false, branch: inspection.branch, base: null, reason: inspection.reason };
  const { branch } = inspection;
  const skip = (reason: string): FinishedCheckResult => ({ finished: false, branch, base: null, reason });

  const remotesResult = await runGit(deps, directory, ["remote"], "remote");
  if (remotesResult.failure) return skip(remotesResult.failure);
  const remotes = remotesResult.result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (remotes.length === 0) return skip("unpushed-commits(no remote)");

  // Pushed: proven against the remotes as they are now, never against possibly stale remote-tracking refs.
  // Every remote must answer; one that fails or is offline makes the answer unknown.
  const repos = new Set<string>();
  let pushedTo: string | null = null;
  for (const remote of remotes) {
    const urlResult = await runGit(deps, directory, ["remote", "get-url", remote], `get-url ${remote}`);
    if (urlResult.failure) return skip(urlResult.failure);
    const repo = githubRepo(urlResult.result.stdout);
    if (!repo) return skip(`pr-unknown(remote ${remote} is not github.com)`);
    repos.add(repo.toLowerCase());
    const live = await runGit(deps, directory, ["ls-remote", "--heads", remote], `ls-remote ${remote}`);
    if (live.failure) return skip(live.failure);
    if (pushedTo) continue;
    const oids = [...new Set(live.result.stdout.split("\n").map((line) => line.split("\t")[0]!.trim()).filter((oid) => /^[0-9a-f]{40,64}$/.test(oid)))];
    if (oids.length === 0) continue;
    // Remote head commits that are not present locally are left out, so they can never prove anything.
    const present = await runGit(deps, directory, ["rev-list", "--ignore-missing", "--no-walk", ...oids], `present ${remote}`);
    if (present.failure) return skip(present.failure);
    const local = present.result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (local.length === 0) continue;
    const outside = await runGit(deps, directory, ["rev-list", "--count", "HEAD", "--not", ...local], `contained ${remote}`);
    if (outside.failure) return skip(outside.failure);
    if (outside.result.stdout.trim() === "0") pushedTo = remote;
  }
  if (!pushedTo) return skip("unpushed-commits(no live remote head contains HEAD)");

  if (!deps.useGh) return skip("pr-unknown(gh disabled)");
  for (const repo of repos) {
    const ghResult = await deps.run("gh", ["pr", "list", "-R", `github.com/${repo}`, "--head", branch, "--state", "open", "--json", "number", "--limit", "20"], directory, deps.timeoutMs);
    if (ghResult.notFound) return skip("pr-unknown(gh unavailable)");
    if (ghResult.timedOut) return skip(`gh-timeout(${repo})`);
    if (ghResult.code !== 0) return skip(`gh-error(${repo}:exit=${ghResult.code ?? "null"}:${text(ghResult)})`);
    let open: unknown;
    try {
      open = JSON.parse(ghResult.stdout) as unknown;
    } catch {
      return skip(`gh-error(${repo}:unparseable json)`);
    }
    if (!Array.isArray(open)) return skip(`gh-error(${repo}:unparseable json)`);
    if (open.length > 0) {
      const number = (open[0] as { number?: unknown } | null)?.number;
      return skip(`pr-open(${repo}#${typeof number === "number" ? number : "?"})`);
    }
  }
  return { finished: true, branch, base: null, reason: `finished-no-pr(pushed(live ${pushedTo}))` };
}

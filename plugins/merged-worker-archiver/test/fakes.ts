import type { CommandResult, CommandRunner, FileSystem } from "../server/types.ts";
import type { AgentView, WorkspaceView } from "../server/types.ts";

export const HEAD = "a".repeat(40);
export const CREATED = "c".repeat(40);
export const PR_HEAD = "b".repeat(40);
export const GIT_DIR = "/repo/.git/worktrees/wt";
export const CWD = "/wt";

export interface GitScenario {
  branch: string | null;
  metadata: string | null;
  markers: string[];
  status: string;
  head: string;
  /** Reflog lines as `%H %gs`, newest first. */
  reflog: string[];
  /** Upstream of the worktree branch itself; other branches track origin/<same name>. */
  upstream: string | null;
  refs: Record<string, boolean>;
  ancestors: Record<string, number>;
  ahead: number;
  gh: Partial<CommandResult> | null;
  prHeadAncestor: number;
  /** Make the git call whose args include this token time out. */
  timeoutOn?: string;
  /** Make the git call whose args include this token fail with exit 128. */
  failOn?: string;
}

export function scenario(overrides: Partial<GitScenario> = {}): GitScenario {
  return {
    branch: "opc/feature",
    metadata: JSON.stringify({ version: 2, baseRefName: "main", baseRef: "refs/heads/main" }),
    markers: [],
    status: "",
    head: HEAD,
    reflog: [`${HEAD} commit: work`, `${CREATED} branch: Created from refs/remotes/origin/main`],
    upstream: "refs/remotes/origin/opc/feature",
    refs: { "refs/heads/main": true, "refs/remotes/origin/main": true },
    ancestors: { "refs/heads/main": 1, "refs/remotes/origin/main": 1 },
    ahead: 2,
    gh: null,
    prHeadAncestor: 0,
    ...overrides,
  };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
const fail = (code: number, stderr = ""): CommandResult => ({ code, stdout: "", stderr, timedOut: false, notFound: false });

export interface Recorded {
  command: string;
  args: readonly string[];
  cwd: string;
}

export function fakeRunner(s: GitScenario, calls: Recorded[] = []): CommandRunner {
  return async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === "gh") {
      if (!s.gh) return { code: null, stdout: "", stderr: "", timedOut: false, notFound: true };
      return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false, ...s.gh };
    }
    if (s.timeoutOn && args.some((arg) => arg.includes(s.timeoutOn!))) {
      return { code: null, stdout: "", stderr: "", timedOut: true, notFound: false };
    }
    if (s.failOn && args.some((arg) => arg.includes(s.failOn!))) return fail(128, "fatal: boom");
    const [sub, ...rest] = args;
    switch (sub) {
      case "rev-parse": {
        if (rest[0] === "--show-toplevel") return ok(`${CWD}\n`);
        if (rest[0] === "--absolute-git-dir") return ok(`${GIT_DIR}\n`);
        if (rest[0] === "--verify" && rest[1] === "HEAD^{commit}") return ok(`${s.head}\n`);
        if (rest[0] === "--symbolic-full-name") {
          const name = rest[1]!.replace(/@\{upstream\}$/, "");
          if (name && name !== s.branch) return ok(`refs/remotes/origin/${name}\n`);
          return s.upstream ? ok(`${s.upstream}\n`) : fail(128, "no upstream");
        }
        if (rest[0] === "--verify" && rest[1] === "-q") {
          const ref = rest[2]!.replace("^{commit}", "");
          return s.refs[ref] ? ok(`${"d".repeat(40)}\n`) : fail(1);
        }
        break;
      }
      case "symbolic-ref":
        return s.branch ? ok(`${s.branch}\n`) : fail(1);
      case "status":
        return ok(s.status);
      case "ls-files":
        return { ...ok(), stdoutBytes: Buffer.alloc(0) };
      case "reflog":
        return ok(s.reflog.map((line) => `${line}\n`).join(""));
      case "merge-base": {
        const target = rest[2]!;
        if (target === PR_HEAD) return s.prHeadAncestor === 0 ? ok() : fail(s.prHeadAncestor);
        const code = s.ancestors[target] ?? 128;
        return code === 0 ? ok() : fail(code);
      }
      case "rev-list":
        return ok(`${s.ahead}\n`);
    }
    return fail(129, `unexpected git ${args.join(" ")}`);
  };
}

export function fakeFs(s: GitScenario, options: { directory?: boolean | null } = {}): FileSystem {
  return {
    async isDirectory() {
      return options.directory === undefined ? true : options.directory;
    },
    async exists(path) {
      return s.markers.some((marker) => path === `${GIT_DIR}/${marker}`);
    },
    async isEmptyDirectory() {
      return false;
    },
    async realpath(path) {
      return path;
    },
    async readText(path) {
      return path === `${GIT_DIR}/paseo/worktree.json` ? s.metadata : null;
    },
  };
}

export const NOW = Date.parse("2026-09-22T12:00:00.000Z");
export const LONG_AGO = "2026-09-22T10:00:00.000Z";

export function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: "wks_1",
    name: "worker",
    workspaceKind: "worktree",
    workspaceDirectory: CWD,
    status: "done",
    archivingAt: null,
    activityAt: LONG_AGO,
    statusEnteredAt: LONG_AGO,
    scripts: [],
    ...overrides,
  };
}

export function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: "agent-0001-worker",
    workspaceId: "wks_1",
    status: "idle",
    title: "Fix the thing",
    labels: { role: "worker" },
    pendingPermissions: [],
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    updatedAt: LONG_AGO,
    lastUserMessageAt: LONG_AGO,
    archivedAt: null,
    ...overrides,
  };
}

export const mergedPr = (overrides: Record<string, unknown> = {}) => ({
  code: 0,
  stdout: JSON.stringify({
    number: 42,
    state: "MERGED",
    mergeCommit: { oid: "e".repeat(40) },
    headRefOid: PR_HEAD,
    headRefName: "opc/feature",
    baseRefName: "main",
    ...overrides,
  }),
});

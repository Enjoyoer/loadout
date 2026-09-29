import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig, type ArchiverConfig } from "../server/config.ts";
import { evaluateWorkspace } from "../server/evaluate.ts";
import type { AgentView, WorkspaceView } from "../server/types.ts";
import { agent, fakeFs, fakeRunner, mergedPr, NOW, scenario, workspace, type GitScenario, type Recorded } from "./fakes.ts";

async function decide(
  options: {
    git?: Partial<GitScenario>;
    ws?: Partial<WorkspaceView>;
    agents?: AgentView[];
    config?: Partial<ArchiverConfig>;
    directory?: boolean | null;
  } = {},
) {
  const s = scenario(options.git);
  const calls: Recorded[] = [];
  const fs = fakeFs(s, { directory: options.directory });
  const decision = await evaluateWorkspace(
    workspace(options.ws),
    options.agents ?? [agent()],
    defaultConfig(options.config),
    { merge: { run: fakeRunner(s, calls), fs }, fs, now: () => NOW },
  );
  return { decision, calls };
}

describe("merged paths", () => {
  it("archives when HEAD is an ancestor of the local base", async () => {
    const { decision } = await decide({ git: { ancestors: { "refs/heads/main": 0 } } });
    assert.equal(decision.action, "archive");
    assert.equal(decision.reason, "merged-ancestry(refs/heads/main)");
    assert.equal(decision.branch, "opc/feature");
    assert.equal(decision.base, "main");
    assert.deepEqual(decision.agentIds, ["agent-0001-worker"]);
  });

  it("archives when HEAD is an ancestor of the base upstream only", async () => {
    const { decision } = await decide({ git: { ancestors: { "refs/heads/main": 1, "refs/remotes/origin/main": 0 } } });
    assert.equal(decision.action, "archive");
    assert.equal(decision.reason, "merged-ancestry(refs/remotes/origin/main)");
  });

  it("never fetches or mutates: only read-only git subcommands", async () => {
    const { calls } = await decide({ git: { gh: mergedPr() } });
    const allowed = new Set(["rev-parse", "symbolic-ref", "status", "reflog", "merge-base", "rev-list"]);
    for (const call of calls.filter((c) => c.command === "git")) assert.ok(allowed.has(call.args[0]!), call.args.join(" "));
  });

  it("archives a squash-merged PR when local HEAD is contained in the PR head", async () => {
    const { decision, calls } = await decide({ git: { gh: mergedPr() } });
    assert.equal(decision.action, "archive");
    assert.equal(decision.reason, "merged-pr(#42)");
    const gh = calls.find((call) => call.command === "gh");
    assert.deepEqual(gh?.args.slice(0, 3), ["pr", "view", "opc/feature"]);
  });

  it("does not call gh when useGh is false", async () => {
    const { decision, calls } = await decide({ git: { gh: mergedPr() }, config: { useGh: false } });
    assert.equal(decision.action, "skip");
    assert.match(decision.reason, /^not-merged\(ahead=2 of refs\/heads\/main; gh disabled\)$/);
    assert.equal(calls.some((call) => call.command === "gh"), false);
  });
});

describe("PR skip rules", () => {
  const cases: Array<[string, Partial<GitScenario>, RegExp]> = [
    ["gh missing", { gh: null }, /^not-merged\(ahead=2 of refs\/heads\/main; gh unavailable\)$/],
    ["no PR", { gh: { code: 1, stderr: 'no pull requests found for branch "opc/feature"' } }, /^not-merged\(.*no PR\)$/],
    ["open PR", { gh: mergedPr({ state: "OPEN", mergeCommit: null }) }, /^not-merged\(.*PR #42 open\)$/],
    ["closed PR", { gh: mergedPr({ state: "CLOSED", mergeCommit: null }) }, /PR #42 closed/],
    ["no GitHub remote", { gh: { code: 1, stderr: "no git remotes found" } }, /^not-merged\(.*no GitHub remote\)$/],
    ["gh error", { gh: { code: 1, stderr: "HTTP 401: Bad credentials" } }, /^gh-error\(exit=1:HTTP 401/],
    ["gh timeout", { gh: { code: null, timedOut: true } }, /^gh-timeout$/],
    ["gh bad json", { gh: { code: 0, stdout: "not json" } }, /^gh-error\(unparseable json\)$/],
    ["merged without merge commit", { gh: mergedPr({ mergeCommit: null }) }, /^ambiguous\(PR #42 merged without mergeCommit\)$/],
    ["head mismatch", { gh: mergedPr({ headRefName: "other" }) }, /^pr-head-mismatch/],
    ["base mismatch", { gh: mergedPr({ baseRefName: "release" }) }, /^pr-base-mismatch/],
    ["local commits after PR head", { gh: mergedPr(), prHeadAncestor: 1 }, /^unmerged-commits/],
    ["PR head not local", { gh: mergedPr(), prHeadAncestor: 128 }, /^ambiguous\(PR #42 head commit not present locally\)$/],
  ];
  for (const [name, git, reason] of cases) {
    it(`skips: ${name}`, async () => {
      const { decision } = await decide({ git });
      assert.equal(decision.action, "skip");
      assert.match(decision.reason, reason);
    });
  }
});

describe("git skip rules", () => {
  const cases: Array<[string, Partial<GitScenario>, RegExp]> = [
    ["detached HEAD", { branch: null }, /^detached-head$/],
    ["no paseo metadata", { metadata: null }, /^no-base\(paseo worktree metadata/],
    ["invalid metadata", { metadata: "{" }, /^no-base\(/],
    ["metadata without base", { metadata: JSON.stringify({ version: 2 }) }, /^no-base\(/],
    ["base refs missing", { refs: {}, upstream: null }, /^no-base\(base ref not found locally\)$/],
    ["branch is the base", { branch: "main" }, /^branch-is-base$/],
    ["uncommitted change", { status: " M src/a.ts\n", ancestors: { "refs/heads/main": 0 } }, /^dirty\(changed=1,untracked=0\)$/],
    ["staged change", { status: "A  src/b.ts\n", ancestors: { "refs/heads/main": 0 } }, /^dirty\(changed=1,untracked=0\)$/],
    ["untracked file", { status: "?? notes.txt\n", ancestors: { "refs/heads/main": 0 } }, /^dirty\(changed=0,untracked=1\)$/],
    ["merge in progress", { markers: ["MERGE_HEAD"], ancestors: { "refs/heads/main": 0 } }, /^operation-in-progress\(MERGE_HEAD\)$/],
    ["rebase in progress", { markers: ["rebase-merge"], ancestors: { "refs/heads/main": 0 } }, /^operation-in-progress\(rebase-merge\)$/],
    ["no commits on branch", { reflog: [`${"a".repeat(40)} branch: Created from main`], ancestors: { "refs/heads/main": 0 } }, /^no-branch-commits$/],
    [
      "rebased onto newer base without own commits",
      {
        reflog: [`${"a".repeat(40)} rebase (finish): refs/heads/opc/feature onto ${"a".repeat(40)}`, `${"c".repeat(40)} branch: Created from refs/remotes/origin/main`],
        ancestors: { "refs/heads/main": 0 },
      },
      /^no-branch-commits$/,
    ],
    ["empty reflog", { reflog: [], ancestors: { "refs/heads/main": 0 } }, /^ambiguous\(branch reflog empty\)$/],
    ["commits not in base, no gh", { gh: null }, /^not-merged\(ahead=2/],
    ["git timeout", { timeoutOn: "--porcelain=v1" }, /^git-timeout\(status\)$/],
    ["git error on ancestry", { failOn: "--is-ancestor", ancestors: { "refs/heads/main": 0 } }, /^git-error\(is-ancestor refs\/heads\/main:exit=128/],
    ["git error on status", { failOn: "--porcelain=v1" }, /^git-error\(status:exit=128/],
  ];
  for (const [name, git, reason] of cases) {
    it(`skips: ${name}`, async () => {
      const { decision } = await decide({ git });
      assert.equal(decision.action, "skip", decision.reason);
      assert.match(decision.reason, reason);
    });
  }

  it("skips when git is not installed", async () => {
    const s = scenario({ ancestors: { "refs/heads/main": 0 } });
    const fs = fakeFs(s);
    const decision = await evaluateWorkspace(workspace(), [agent()], defaultConfig(), {
      merge: { run: async () => ({ code: null, stdout: "", stderr: "", timedOut: false, notFound: true }), fs },
      fs,
      now: () => NOW,
    });
    assert.equal(decision.reason, "git-not-found");
  });
});

describe("workspace and agent skip rules", () => {
  const merged: Partial<GitScenario> = { ancestors: { "refs/heads/main": 0 } };
  const cases: Array<[string, Parameters<typeof decide>[0], RegExp]> = [
    ["local checkout", { ws: { workspaceKind: "local_checkout" } }, /^not-worktree\(local_checkout\)$/],
    ["directory workspace", { ws: { workspaceKind: "directory" } }, /^not-worktree\(directory\)$/],
    ["checkout workspace", { ws: { workspaceKind: "checkout" } }, /^not-worktree\(checkout\)$/],
    ["archiving", { ws: { archivingAt: "2026-09-22T11:59:00Z" } }, /^already-archiving$/],
    ["no directory", { ws: { workspaceDirectory: undefined } }, /^no-directory$/],
    ["role=pm agent", { agents: [agent(), agent({ id: "pm-agent-1", labels: { role: "PM" } })] }, /^pm-agent$/],
    ["PM title", { agents: [agent({ title: "Docs PM", labels: {} })] }, /^pm-agent$/],
    ["no agents", { agents: [] }, /^no-agents$/],
    ["running agent", { agents: [agent(), agent({ id: "agent-2-running", status: "running" })] }, /^agent-running\(agent-2-\)$/],
    ["initializing agent", { agents: [agent({ status: "initializing" })] }, /^agent-initializing/],
    ["errored agent", { agents: [agent({ status: "error" })] }, /^agent-status-error/],
    ["pending permission", { agents: [agent({ pendingPermissions: [{ id: "p" }] })] }, /^pending-permission/],
    ["attention for permission", { agents: [agent({ requiresAttention: true, attentionReason: "permission" })] }, /^attention-permission/],
    ["attention for error", { agents: [agent({ requiresAttention: true, attentionReason: "error" })] }, /^attention-error/],
    ["workspace running", { ws: { status: "running" } }, /^workspace-running$/],
    ["workspace needs input", { ws: { status: "needs_input" } }, /^workspace-needs_input$/],
    ["script running", { ws: { scripts: [{ scriptName: "dev", lifecycle: "running" }] } }, /^script-running\(dev\)$/],
    [
      "grace period when raised",
      { config: { graceMinutes: 30 }, agents: [agent({ updatedAt: "2026-09-22T11:50:00.000Z" })] },
      /^grace-period\(idle=10m, remaining=20m\)$/,
    ],
    ["grace from workspace activity", { config: { graceMinutes: 30 }, ws: { activityAt: "2026-09-22T11:59:00.000Z" } }, /^grace-period/],
    [
      "no timestamps",
      {
        ws: { activityAt: null, statusEnteredAt: null },
        agents: [agent({ updatedAt: undefined, lastUserMessageAt: null, attentionTimestamp: null })],
      },
      /^ambiguous\(no activity timestamp\)$/,
    ],
    ["path missing", { directory: false }, /^path-missing/],
    ["path unstatable", { directory: null }, /^ambiguous\(path not statable\)$/],
  ];
  for (const [name, options, reason] of cases) {
    it(`skips: ${name}`, async () => {
      const { decision, calls } = await decide({ git: merged, ...options });
      assert.equal(decision.action, "skip");
      assert.match(decision.reason, reason);
      if (!/dirty|path/.test(name)) assert.equal(calls.length, 0, "no git before the cheap gates pass");
    });
  }

  it("allows finished-attention and closed agents", async () => {
    const { decision } = await decide({
      git: merged,
      agents: [agent({ requiresAttention: true, attentionReason: "finished" }), agent({ id: "agent-closed", status: "closed" })],
    });
    assert.equal(decision.action, "archive");
    assert.deepEqual(decision.agentIds, ["agent-0001-worker", "agent-closed"]);
  });

  it("allows an agentless worktree only when configured", async () => {
    const { decision } = await decide({ git: merged, agents: [], config: { allowAgentlessWorkspaces: true } });
    assert.equal(decision.action, "archive");
  });

  it("defaults to a zero grace period: a just-finished agent's merged worktree is archivable", async () => {
    const { decision } = await decide({ git: merged, agents: [agent({ updatedAt: "2026-09-22T11:59:59.000Z" })] });
    assert.equal(decision.action, "archive");
  });
});

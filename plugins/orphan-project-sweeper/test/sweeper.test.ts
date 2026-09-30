import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { readConfig } from "../server/config.ts";
import { OrphanProjectSweeper, type SweeperApi } from "../server/sweeper.ts";

type Project = Awaited<ReturnType<SweeperApi["listProjects"]>>["projects"][number];

async function fixture(t: TestContext, values: unknown = {}, count = 1) {
  // All filesystem fixtures stay in this worktree's ignored dependency directory.
  const root = await mkdtemp(path.join(process.cwd(), "node_modules/sweeper-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let projects = Array.from({ length: count }, (_, index) => ({
    projectId: `project-${index}`, projectRootPath: path.join(root, `missing-${index}`),
    projectDisplayName: `Project ${index}`, projectKind: "directory",
  } satisfies Project));
  const removed: string[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  let listCalls = 0;
  let fetchCalls = 0;
  const state = {
    values,
    beforeList: async (_call: number) => {},
    beforeFetch: async (_call: number) => {},
    active: [] as { projectId: string }[],
    failDelete: false,
    forgetProjects() { projects = []; },
  };
  const api: SweeperApi = {
    async listProjects() {
      calls.push("list");
      await state.beforeList(++listCalls);
      return { projects, requestId: "test" };
    },
    async fetchWorkspaces() {
      calls.push("fetch");
      await state.beforeFetch(++fetchCalls);
      return { entries: state.active, pageInfo: { nextCursor: null } } as Awaited<ReturnType<SweeperApi["fetchWorkspaces"]>>;
    },
    async removeProject(id) {
      calls.push(`remove:${id}`);
      if (state.failDelete) throw new Error("test delete failed");
      removed.push(id);
      projects = projects.filter((project) => project.projectId !== id);
      return { removedWorkspaceIds: [] };
    },
  };
  const sweeper = new OrphanProjectSweeper({ log: (line) => logs.push(line), error: (line) => logs.push(line) }, {
    withDaemon: async (fn) => fn(api),
    config: async () => readConfig(state.values, (line) => logs.push(line)),
  });
  t.after(() => sweeper.stop());
  return { sweeper, state, removed, logs, calls, root };
}

it("unarmed evaluates and logs projectId, path and reason without deleting", async (t) => {
  const f = await fixture(t);
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes('decision=would-delete') && line.includes('projectId=project-0') && line.includes(`path=${JSON.stringify(path.join(f.root, "missing-0"))}`) && line.includes('reason=orphaned(')));
  assert.deepEqual(f.calls, ["list", "fetch", "list", "fetch"]);
});

it("armed deletes after a fresh evaluation", async (t) => {
  const f = await fixture(t, { armed: true });
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, ["project-0"]);
  assert.deepEqual(f.calls, ["list", "fetch", "list", "fetch", "remove:project-0"]);
});

it("forced dry-run overrides armed settings", async (t) => {
  const f = await fixture(t, { armed: true });
  await f.sweeper.sweep({ forceDryRun: true, source: "cli-dry-run" });
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("decision=would-delete source=cli-dry-run")));
});

it("armed cap leaves remaining candidates and resets for the next sweep", async (t) => {
  const f = await fixture(t, { armed: true, maxDeletesPerSweep: 2 }, 5);
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, ["project-0", "project-1"]);
  const capped = f.logs.filter((line) => line.includes("decision=cap-reached"));
  assert.equal(capped.length, 3);
  assert.ok(capped.every((line) => line.includes("projectId=") && line.includes("path=") && line.includes("reason=orphaned(") && line.includes("maxDeletesPerSweep=2")));
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, ["project-0", "project-1", "project-2", "project-3"]);
});

it("dry-run previews the same cap without calling removeProject", async (t) => {
  const f = await fixture(t, { maxDeletesPerSweep: 1 }, 3);
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.equal(f.logs.filter((line) => line.includes("decision=would-delete")).length, 1);
  assert.equal(f.logs.filter((line) => line.includes("decision=cap-reached")).length, 2);
});

it("invalid cap logs its default and limits an armed sweep to five", async (t) => {
  const f = await fixture(t, { armed: true, maxDeletesPerSweep: -1 }, 7);
  await f.sweeper.sweep();
  assert.equal(f.removed.length, 5);
  assert.ok(f.logs.some((line) => line.includes("setting=maxDeletesPerSweep") && line.includes("fallback=5")));
  assert.equal(f.logs.filter((line) => line.includes("decision=cap-reached")).length, 2);
});

it("re-reads settings between sweeps and rejects truthy arming", async (t) => {
  const f = await fixture(t, { armed: "true" });
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  f.state.values = { armed: true };
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, ["project-0"]);
});

it("re-evaluation prevents deletion when an active workspace appears", async (t) => {
  const f = await fixture(t, { armed: true });
  f.state.beforeFetch = async (call) => {
    if (call === 2) f.state.active = [{ projectId: "project-0" }];
  };
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("changed on re-verify") && line.includes("reason=active-workspaces")));
});

it("re-evaluation prevents deletion when the path reappears", async (t) => {
  const f = await fixture(t, { armed: true });
  f.state.beforeList = async (call) => {
    if (call === 2) await mkdir(path.join(f.root, "missing-0"));
  };
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("changed on re-verify") && line.includes("reason=path-still-exists")));
});

it("re-evaluation prevents deletion when the project row disappears", async (t) => {
  const f = await fixture(t, { armed: true });
  f.state.beforeList = async (call) => {
    if (call === 2) f.state.forgetProjects();
  };
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("changed on re-verify") && line.includes("reason=project-missing")));
});

it("existing paths and active workspaces remain skipped in armed mode", async (t) => {
  const f = await fixture(t, { armed: true }, 2);
  await mkdir(path.join(f.root, "missing-0"));
  f.state.active = [{ projectId: "project-1" }];
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("reason=path-still-exists")));
  assert.ok(f.logs.some((line) => line.includes("reason=active-workspaces")));
});

it("delete errors are logged without reporting successful deletion", async (t) => {
  const f = await fixture(t, { armed: true });
  f.state.failDelete = true;
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("decision=delete-failed")));
  assert.ok(f.logs.some((line) => line.endsWith("deleted=0 wouldDelete=0")));
});

for (const armed of [false, true]) {
  it(`archive re-check honors armed=${armed} and re-evaluates`, { timeout: 2000 }, async (t) => {
    const f = await fixture(t, { armed });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.sweeper.noteArchivedWorkspace({ id: "workspace-0", projectId: "project-0", cwd: path.join(f.root, "missing-0") });
    t.mock.timers.tick(10_000);
    // Drain async filesystem work, without advancing the re-check timer again.
    const decisionLogged = () => f.logs.some((line) => line.includes(`decision=${armed ? "delete" : "would-delete"} source=re-check`));
    for (let turn = 0; turn < 1000 && !decisionLogged(); turn++) await setImmediate();
    assert.ok(decisionLogged(), "archive re-check completed");
    assert.deepEqual(f.removed, armed ? ["project-0"] : []);
    assert.deepEqual(f.calls, ["list", "fetch", "list", "fetch", ...(armed ? ["remove:project-0"] : [])]);
  });
}

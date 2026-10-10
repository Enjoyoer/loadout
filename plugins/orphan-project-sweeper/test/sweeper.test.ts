import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { readConfig } from "../server/config.ts";
import { OrphanProjectSweeper, type SweeperApi, type SweeperHost } from "../server/sweeper.ts";

type Project = Awaited<ReturnType<SweeperApi["listProjects"]>>["projects"][number];

async function fixture(t: TestContext, values: unknown = {}, count = 1, options: { host?: SweeperHost; paths?: string[] } = {}) {
  // All filesystem fixtures stay in this worktree's ignored dependency directory.
  const root = await mkdtemp(path.join(process.cwd(), "node_modules/sweeper-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // An empty parent reads as an unmounted volume, so the parent keeps one unrelated file. That file only clears the
  // empty-parent check; it is no proof of a mount. Deletes here proceed because no mount the host declares over this
  // checkout is absent.
  await writeFile(path.join(root, "keep"), "");
  const paths = options.paths ?? Array.from({ length: count }, (_, index) => path.join(root, `missing-${index}`));
  let projects = paths.map((projectRootPath, index) => ({
    projectId: `project-${index}`, projectRootPath,
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
    pageInfo: { nextCursor: null } as { nextCursor: string | null; hasMore?: boolean },
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
      return { entries: state.active, pageInfo: state.pageInfo } as Awaited<ReturnType<SweeperApi["fetchWorkspaces"]>>;
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
    ...(options.host ? { host: options.host } : {}),
  });
  t.after(() => sweeper.stop());
  return { sweeper, state, removed, logs, calls, root };
}

type FakeEntry = { kind: "dir" | "file" | "junction"; dev?: number };

/** A host whose filesystem is the given entries and files; a junction reads as a directory once followed. */
function fakeHost(platform: NodeJS.Platform, entries: Record<string, FakeEntry>, files: Record<string, string> = {}): SweeperHost {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const missing = (target: string) => Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
  const entry = (target: string) => {
    const found = entries[target];
    if (!found) throw missing(target);
    return found;
  };
  const stats = (found: FakeEntry, follow: boolean) => ({
    isDirectory: () => found.kind === "dir" || (follow && found.kind === "junction"),
    isSymbolicLink: () => !follow && found.kind === "junction",
    dev: found.dev ?? 1,
  });
  return {
    platform,
    lstat: async (target) => stats(entry(target), false),
    stat: async (target) => stats(entry(target), true),
    readdir: async (target) => {
      entry(target);
      return Object.keys(entries).filter((name) => name !== target && paths.dirname(name) === target).map((name) => paths.basename(name));
    },
    readFile: async (target) => {
      const text = files[target];
      if (text === undefined) throw missing(target);
      return text;
    },
    realpath: async (target) => {
      entry(target);
      return target;
    },
  };
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

it("a missing root whose parent is also missing is not orphaned", async (t) => {
  const f = await fixture(t, { armed: true });
  await rm(f.root, { recursive: true, force: true });
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("decision=skip") && line.includes("projectId=project-0") && line.includes("reason=parent-missing")));
});

it("a missing root whose parent is an existing empty directory is not deleted", async (t) => {
  const f = await fixture(t, { armed: true });
  await rm(path.join(f.root, "keep"));
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("decision=skip") && line.includes("projectId=project-0") && line.includes("reason=parent-missing") && line.includes("empty-directory")));
});

it("delete errors are logged without reporting successful deletion", async (t) => {
  const f = await fixture(t, { armed: true });
  f.state.failDelete = true;
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("decision=delete-failed")));
  assert.ok(f.logs.some((line) => line.endsWith("deleted=0 wouldDelete=0")));
});

it("an incomplete workspace listing aborts an armed sweep instead of deleting", { timeout: 2000 }, async (t) => {
  const f = await fixture(t, { armed: true });
  // The daemon announces another page (which would hold the project's active workspace) but gives no cursor for it.
  f.state.pageInfo = { hasMore: true, nextCursor: null };
  await assert.rejects(f.sweeper.sweep(), /more pages without a cursor/);
  assert.deepEqual(f.removed, []);
  // A cursor handed out twice ends the listing too, instead of looping forever.
  f.state.pageInfo = { hasMore: true, nextCursor: "cursor-1" };
  await assert.rejects(f.sweeper.sweep(), /repeated cursor/);
  assert.deepEqual(f.removed, []);
});

for (const armed of [false, true]) {
  it(`archive re-check honors armed=${armed} and re-evaluates`, { timeout: 2000 }, async (t) => {
    const f = await fixture(t, { armed });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.sweeper.noteArchivedWorkspace({ id: "workspace-0", projectId: "project-0", cwd: path.join(f.root, "missing-0") });
    t.mock.timers.tick(10_000);
    // Drain async filesystem work, without advancing the re-check timer again. The wait is bounded by wall time, not by
    // event-loop turns: thread-pool fs calls (the mount check reads fstab and mountinfo) can outlast many fast turns.
    const decisionLogged = () => f.logs.some((line) => line.includes(`decision=${armed ? "delete" : "would-delete"} source=re-check`));
    const deadline = Date.now() + 1500;
    while (!decisionLogged() && Date.now() < deadline) await setImmediate();
    assert.ok(decisionLogged(), "archive re-check completed");
    assert.deepEqual(f.removed, armed ? ["project-0"] : []);
    assert.deepEqual(f.calls, ["list", "fetch", "list", "fetch", ...(armed ? ["remove:project-0"] : [])]);
  });
}

it("an archive re-check whose removeProject fails keeps its remaining re-checks", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, { armed: true });
  f.state.failDelete = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const drain = async (text: string) => {
    const deadline = Date.now() + 1500;
    while (!f.logs.some((line) => line.includes(text)) && Date.now() < deadline) await setImmediate();
    // Let the re-check schedule its next attempt before the timer is advanced.
    await setImmediate();
    return f.logs.some((line) => line.includes(text));
  };
  f.sweeper.noteArchivedWorkspace({ id: "workspace-0", projectId: "project-0", cwd: path.join(f.root, "missing-0") });
  t.mock.timers.tick(10_000);
  assert.ok(await drain("decision=delete-failed source=re-check attempt=1/5"), f.logs.join("\n"));
  f.state.failDelete = false;
  t.mock.timers.tick(30_000);
  assert.ok(await drain("decision=delete source=re-check attempt=2/5"), f.logs.join("\n"));
  assert.deepEqual(f.removed, ["project-0"]);
});

it("on Windows a missing root under a junction is kept as mount-unverifiable, and one under plain folders stays a candidate", async (t) => {
  const host = fakeHost("win32", {
    "C:\\": { kind: "dir" },
    "C:\\work": { kind: "dir" },
    "C:\\work\\linked": { kind: "junction" },
    "C:\\work\\linked\\keep": { kind: "file" },
    "C:\\work\\plain": { kind: "dir" },
    "C:\\work\\plain\\keep": { kind: "file" },
  });
  const f = await fixture(t, {}, 0, { host, paths: ["C:\\work\\linked\\gone", "C:\\work\\plain\\gone"] });
  await f.sweeper.sweep();
  assert.ok(f.logs.some((line) => line.includes("decision=skip") && line.includes("projectId=project-0") && line.includes("reason=mount-unverifiable") && line.includes("reparse-point")));
  assert.ok(f.logs.some((line) => line.includes("decision=would-delete") && line.includes("projectId=project-1")));
  assert.deepEqual(f.removed, []);
});

it("a mount that disappears between evaluation and delete makes the delete skip", async (t) => {
  const mountinfo = "1 0 0:1 / / rw - ext4 root rw\n";
  const files: Record<string, string> = {
    "/etc/fstab": "vol /mnt/vol ext4 defaults 0 2\n",
    "/proc/self/mountinfo": `${mountinfo}2 1 0:2 / /mnt/vol rw - ext4 vol rw\n`,
  };
  const host = fakeHost("linux", {
    "/": { kind: "dir" }, "/mnt": { kind: "dir" }, "/mnt/vol": { kind: "dir" }, "/mnt/vol/keep": { kind: "file" },
  }, files);
  const f = await fixture(t, { armed: true }, 0, { host, paths: ["/mnt/vol/gone"] });
  // The re-verify's workspace count runs after its mount check; the volume goes away there.
  f.state.beforeFetch = async (call) => {
    if (call === 2) files["/proc/self/mountinfo"] = mountinfo;
  };
  await f.sweeper.sweep();
  assert.deepEqual(f.removed, []);
  assert.ok(f.logs.some((line) => line.includes("changed on final check") && line.includes("reason=mount-absent")), f.logs.join("\n"));
});

it("on Windows a missing root is kept as mount-unverifiable when its parent is a regular file", async (t) => {
  const host = fakeHost("win32", {
    "C:\\": { kind: "dir" },
    "C:\\work": { kind: "file" },
  });
  const f = await fixture(t, {}, 0, { host, paths: ["C:\\work\\gone"] });
  await f.sweeper.sweep();
  assert.ok(f.logs.some((line) => line.includes("decision=skip") && line.includes("projectId=project-0") && line.includes("reason=mount-unverifiable") && line.includes("not-a-directory")), f.logs.join("\n"));
  assert.deepEqual(f.removed, []);
});

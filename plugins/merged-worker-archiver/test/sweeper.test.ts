import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { Sweeper, type ArchiverApi } from "../server/sweeper.ts";
import type { WorkspaceView } from "../server/types.ts";
import { agent, fakeFs, fakeRunner, NOW, scenario, workspace } from "./fakes.ts";

it("with the default cap, one sweep over 7 eligible candidates archives 5 and reports 2 deferred; the next sweep archives the 2", async () => {
  const workspaces = Array.from({ length: 7 }, (_, i) => workspace({ id: `wks_${i}`, name: `worker-${i}` }));
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const archiveCalls: string[] = [];
  // Archived workspaces (and their agents) are gone from later listings, as in Paseo.
  const live = () => workspaces.filter((ws) => !archiveCalls.includes(ws.id));
  const api: ArchiverApi = {
    workspaces: {
      list: async () => page(live()),
      archive: async (workspaceId) => {
        archiveCalls.push(workspaceId);
        return { archivedAt: new Date(NOW).toISOString(), error: null };
      },
    },
    agents: { list: async () => page(live().map((ws) => ({ agent: agent({ id: `agent-${ws.id}`, workspaceId: ws.id }) }))) },
  };
  const s = scenario({ ancestors: { "refs/heads/main": 0 } });
  const fs = fakeFs(s);
  const lines: string[] = [];
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api, release: async () => undefined }),
    log: (line) => lines.push(line),
    fs,
    merge: { run: fakeRunner(s), fs },
    resolveCommonDir: async () => null,
    now: () => NOW,
  });
  const actions = () => lines.filter((line) => !line.includes("sweep-done")).map((line) => JSON.parse(line.replace(/^\[merged-worker-archiver\] /, "")).action);
  const sweepDone = () => JSON.parse(lines.find((line) => line.includes("sweep-done"))!.replace(/^\[merged-worker-archiver\] sweep-done /, ""));

  // The default config is dry-run: it previews exactly what an armed sweep would do.
  await sweeper.sweep(defaultConfig(), { trigger: "test" });
  assert.deepEqual(actions(), [...Array(5).fill("would-archive"), "deferred", "deferred"]);
  assert.deepEqual(sweepDone().counts, { archive: 5, deferred: 2 });
  assert.equal(sweepDone().deferred, 2);
  assert.deepEqual(archiveCalls, []);

  lines.length = 0;
  const result = await sweeper.sweep(defaultConfig({ armed: true }), { trigger: "test" });
  assert.deepEqual(result.archived, ["wks_0", "wks_1", "wks_2", "wks_3", "wks_4"]);
  assert.deepEqual(archiveCalls, result.archived);
  assert.deepEqual(actions(), [...Array(5).fill("archived"), "deferred", "deferred"]);
  assert.deepEqual(sweepDone().counts, { archive: 5, deferred: 2 });
  assert.equal(sweepDone().deferred, 2);

  // The first five are gone from the list, so the deferred two are archived next.
  lines.length = 0;
  const next = await sweeper.sweep(defaultConfig({ armed: true }), { trigger: "test" });
  assert.deepEqual(next.archived, ["wks_5", "wks_6"]);
  assert.deepEqual(actions(), ["archived", "archived"]);
  assert.deepEqual(sweepDone().counts, { archive: 2 });
  assert.equal(sweepDone().deferred, 0);
  assert.equal(archiveCalls.length, 7);
});

/**
 * Armed sweeps over a stable listing in which archived workspaces disappear, as in Paseo.
 * `failure` says how a workspace's archive call fails, or null for a call that succeeds.
 */
function armedSweeps(workspaces: WorkspaceView[], failure: (workspaceId: string) => "error" | "throw" | null) {
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const archivedIds = new Set<string>();
  const live = () => workspaces.filter((ws) => !archivedIds.has(ws.id));
  const calls: string[] = [];
  const api: ArchiverApi = {
    workspaces: {
      list: async () => page(live()),
      archive: async (workspaceId) => {
        calls.push(workspaceId);
        const mode = failure(workspaceId);
        if (mode === "throw") throw new Error("socket closed");
        if (mode === "error") return { archivedAt: null, error: "teardown failed" };
        archivedIds.add(workspaceId);
        return { archivedAt: new Date(NOW).toISOString(), error: null };
      },
    },
    agents: { list: async () => page(live().map((ws) => ({ agent: agent({ id: `agent-${ws.id}`, workspaceId: ws.id }) }))) },
  };
  const s = scenario({ ancestors: { "refs/heads/main": 0 } });
  const fs = fakeFs(s);
  const lines: string[] = [];
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api, release: async () => undefined }),
    log: (line) => lines.push(line),
    fs,
    merge: { run: fakeRunner(s), fs },
    resolveCommonDir: async () => null,
    now: () => NOW,
  });
  return async () => {
    lines.length = 0;
    calls.length = 0;
    const result = await sweeper.sweep(defaultConfig({ armed: true }), { trigger: "test" });
    const entries = lines.filter((line) => !line.includes("sweep-done")).map((line) => JSON.parse(line.replace(/^\[merged-worker-archiver\] /, "")));
    const done = JSON.parse(lines.find((line) => line.includes("sweep-done"))!.replace(/^\[merged-worker-archiver\] sweep-done /, ""));
    return { result, entries, actions: entries.map((entry) => entry.action as string), done, calls: [...calls] };
  };
}

it("5 candidates whose archive call always fails stop taking the cap: 2 good candidates are archived within 2 armed sweeps, and the failing 5 are retried once their back-off ends", async () => {
  const bad = Array.from({ length: 5 }, (_, i) => workspace({ id: `wks_bad_${i}`, name: `bad-${i}` }));
  const good = Array.from({ length: 2 }, (_, i) => workspace({ id: `wks_good_${i}`, name: `good-${i}` }));
  // Both failure shapes: an error result and a thrown call.
  const sweep = armedSweeps([...bad, ...good], (id) => (id === "wks_bad_3" || id === "wks_bad_4" ? "throw" : id.startsWith("wks_bad_") ? "error" : null));
  const badIds = bad.map((ws) => ws.id);

  // Sweep 1: the failing five come first and use the whole cap; the good two are deferred.
  let s = await sweep();
  assert.deepEqual(s.calls, badIds);
  assert.deepEqual(s.result.archived, []);
  assert.deepEqual(s.actions, [...Array(5).fill("archive-failed"), "deferred", "deferred"]);
  assert.match(s.entries[0].reason, /; archive error: teardown failed; back-off 1 sweep\(s\)$/);
  assert.match(s.entries[3].reason, /; archive threw: socket closed; back-off 1 sweep\(s\)$/);
  assert.deepEqual(s.done.counts, { archive: 5, deferred: 2 });
  assert.equal(s.done.deferred, 2);
  assert.equal(s.done.backoff, 0);

  // Sweep 2: the deferred two go first and are archived; the failing five sit out their back-off without a slot.
  s = await sweep();
  assert.deepEqual(s.calls, ["wks_good_0", "wks_good_1"]);
  assert.deepEqual(s.result.archived, ["wks_good_0", "wks_good_1"]);
  assert.deepEqual(s.actions, ["archived", "archived", ...Array(5).fill("backoff")]);
  assert.match(s.entries[2].reason, /; archive back-off sweep 1\/1 after 1 failed archive call\(s\)$/);
  assert.deepEqual(s.done.counts, { archive: 2, backoff: 5 });
  assert.equal(s.done.deferred, 0);
  assert.equal(s.done.backoff, 5);

  // Sweep 3: the back-off has ended, so the failing five are retried; they fail again.
  s = await sweep();
  assert.deepEqual(s.calls, badIds);
  assert.deepEqual(s.actions, Array(5).fill("archive-failed"));
  assert.match(s.entries[0].reason, /; back-off 2 sweep\(s\)$/);
  assert.deepEqual(s.done.counts, { archive: 5 });

  // Each further failure doubles the wait (2, 4, then at most 8 sweeps), and after every wait they are retried.
  for (const [failures, wait] of [[2, 2], [3, 4], [4, 8], [5, 8]] as const) {
    for (let n = 1; n <= wait; n += 1) {
      s = await sweep();
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.actions, Array(5).fill("backoff"));
      assert.match(s.entries[0].reason, new RegExp(`; archive back-off sweep ${n}/${wait} after ${failures} failed archive call\\(s\\)$`));
    }
    s = await sweep();
    assert.deepEqual(s.calls, badIds);
    assert.match(s.entries[0].reason, new RegExp(`; back-off ${Math.min(2 * wait, 8)} sweep\\(s\\)$`));
  }
});

it("with the cap at 5, 45 always-failing candidates listed ahead of 1 healthy one cannot defer it forever: it is attempted within ceil(45/5)+1 sweeps", async () => {
  const failing = Array.from({ length: 45 }, (_, i) => workspace({ id: `wks_fail_${String(i).padStart(2, "0")}`, name: `fail-${i}` }));
  const healthy = workspace({ id: "wks_healthy", name: "healthy" });
  const sweep = armedSweeps([...failing, healthy], (id) => (id === "wks_healthy" ? null : "error"));
  const bound = Math.ceil(45 / 5) + 1;

  let attemptedIn: number | null = null;
  for (let n = 1; n <= bound && attemptedIn === null; n += 1) {
    const s = await sweep();
    // The cap holds, and every evaluated workspace is counted once, matching the decision lines.
    const lines = (action: string) => s.actions.filter((a) => a === action).length;
    assert.ok(s.calls.length <= 5, `sweep ${n} made ${s.calls.length} archive calls`);
    assert.equal(s.done.evaluated, 46);
    assert.equal(Object.values<number>(s.done.counts).reduce((sum, count) => sum + count, 0), 46);
    assert.equal(s.done.counts.archive ?? 0, s.calls.length);
    assert.equal(s.done.counts.deferred ?? 0, lines("deferred"));
    assert.equal(s.done.deferred, lines("deferred"));
    assert.equal(s.done.counts.backoff ?? 0, lines("backoff"));
    assert.equal(s.done.backoff, lines("backoff"));
    const healthyAction = s.entries.find((entry) => entry.workspaceId === "wks_healthy").action;
    if (s.calls.includes("wks_healthy")) {
      attemptedIn = n;
      assert.equal(healthyAction, "archived");
      assert.deepEqual(s.result.archived, ["wks_healthy"]);
    } else {
      assert.equal(healthyAction, "deferred");
    }
  }
  assert.ok(attemptedIn !== null, `the healthy workspace was not attempted within ${bound} sweeps`);
});

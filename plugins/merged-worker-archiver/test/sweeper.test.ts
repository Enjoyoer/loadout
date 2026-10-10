import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { Sweeper, type ArchiverApi } from "../server/sweeper.ts";
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

it("5 candidates whose archive call always fails stop taking the cap: 2 good candidates are archived within 2 armed sweeps, and the failing 5 are retried once their back-off ends", async () => {
  const bad = Array.from({ length: 5 }, (_, i) => workspace({ id: `wks_bad_${i}`, name: `bad-${i}` }));
  const good = Array.from({ length: 2 }, (_, i) => workspace({ id: `wks_good_${i}`, name: `good-${i}` }));
  const workspaces = [...bad, ...good];
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const archiveCalls: string[] = [];
  const archivedIds = new Set<string>();
  const live = () => workspaces.filter((ws) => !archivedIds.has(ws.id));
  const api: ArchiverApi = {
    workspaces: {
      list: async () => page(live()),
      // Both failure shapes: an error result and a thrown call.
      archive: async (workspaceId) => {
        archiveCalls.push(workspaceId);
        if (workspaceId === "wks_bad_3" || workspaceId === "wks_bad_4") throw new Error("socket closed");
        if (workspaceId.startsWith("wks_bad_")) return { archivedAt: null, error: "teardown failed" };
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
  const entries = () => lines.filter((line) => !line.includes("sweep-done")).map((line) => JSON.parse(line.replace(/^\[merged-worker-archiver\] /, "")));
  const actions = () => entries().map((entry) => entry.action);
  const sweepDone = () => JSON.parse(lines.find((line) => line.includes("sweep-done"))!.replace(/^\[merged-worker-archiver\] sweep-done /, ""));
  const armedSweep = async () => {
    lines.length = 0;
    archiveCalls.length = 0;
    return sweeper.sweep(defaultConfig({ armed: true }), { trigger: "test" });
  };
  const badIds = bad.map((ws) => ws.id);

  // Sweep 1: the failing five come first and use the whole cap; the good two are deferred.
  let result = await armedSweep();
  assert.deepEqual(archiveCalls, badIds);
  assert.deepEqual(result.archived, []);
  assert.deepEqual(actions(), [...Array(5).fill("archive-failed"), "deferred", "deferred"]);
  assert.match(entries()[0].reason, /; archive error: teardown failed; back-off 1 sweep\(s\)$/);
  assert.match(entries()[3].reason, /; archive threw: socket closed; back-off 1 sweep\(s\)$/);
  assert.deepEqual(sweepDone().counts, { archive: 5, deferred: 2 });
  assert.equal(sweepDone().deferred, 2);
  assert.equal(sweepDone().backoff, 0);

  // Sweep 2: the failing five sit out their back-off without a slot, so the good two are archived.
  result = await armedSweep();
  assert.deepEqual(archiveCalls, ["wks_good_0", "wks_good_1"]);
  assert.deepEqual(result.archived, ["wks_good_0", "wks_good_1"]);
  assert.deepEqual(actions(), [...Array(5).fill("backoff"), "archived", "archived"]);
  assert.match(entries()[0].reason, /; archive back-off sweep 1\/1 after 1 failed archive call\(s\)$/);
  assert.deepEqual(sweepDone().counts, { backoff: 5, archive: 2 });
  assert.equal(sweepDone().deferred, 0);
  assert.equal(sweepDone().backoff, 5);

  // Sweep 3: the back-off has ended, so the failing five are retried; they fail again.
  result = await armedSweep();
  assert.deepEqual(archiveCalls, badIds);
  assert.deepEqual(actions(), Array(5).fill("archive-failed"));
  assert.match(entries()[0].reason, /; back-off 2 sweep\(s\)$/);
  assert.deepEqual(sweepDone().counts, { archive: 5 });

  // The second failure doubles the back-off to 2 sweeps; after it they are retried again.
  for (const sweep of [1, 2]) {
    await armedSweep();
    assert.deepEqual(archiveCalls, []);
    assert.deepEqual(actions(), Array(5).fill("backoff"));
    assert.match(entries()[0].reason, new RegExp(`; archive back-off sweep ${sweep}/2 after 2 failed archive call\\(s\\)$`));
  }
  await armedSweep();
  assert.deepEqual(archiveCalls, badIds);
  assert.deepEqual(actions(), Array(5).fill("archive-failed"));
});

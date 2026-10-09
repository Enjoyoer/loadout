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

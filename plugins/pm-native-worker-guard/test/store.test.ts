import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { it, mock } from "node:test";
import { StateStore, type HandledRecord } from "../server/store.ts";
import { tempStatePath } from "./fakes.ts";

const record = (childId: string, overrides: Partial<HandledRecord> = {}): HandledRecord => ({
  childId,
  parentId: "p1",
  provider: "codex",
  outcome: "would-archive",
  reason: "pm-created-native-worker",
  at: "2026-10-08T12:00:00.000Z",
  ...overrides,
});

it("starts empty, upserts by child id, bounds entries, and survives a reload", async () => {
  const file = await tempStatePath();
  const store = new StateStore(file);
  assert.equal(await store.get("c1"), null);
  await store.put(record("c1"), 2);
  await store.put(record("c1", { outcome: "archived", notice: "pending" }), 2);
  await store.put(record("c2"), 2);
  await store.put(record("c3", { notice: "pending" }), 2);
  const reloaded = new StateStore(file);
  assert.equal(await reloaded.get("c1"), null);
  assert.deepEqual((await reloaded.pendingFor("p1")).map((entry) => entry.childId), ["c3"]);
  const raw = JSON.parse(await readFile(file, "utf8")) as { version: number; handled: HandledRecord[] };
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.handled.map((entry) => entry.childId), ["c2", "c3"]);
});

it("throws on an invalid state file instead of treating it as empty", async () => {
  const file = await tempStatePath();
  await writeFile(file, JSON.stringify({ version: 2, handled: [] }));
  await assert.rejects(new StateStore(file).get("c1"), /invalid state file/);
  await writeFile(file, "{");
  await assert.rejects(new StateStore(file).get("c1"));
});

it("throws on a state file whose records are malformed", async () => {
  const file = await tempStatePath();
  for (const handled of [[null], [{ ...record("c1"), outcome: "deleted" }], [{ ...record("c1"), at: "not-a-date" }], [{ ...record("c1"), notice: 1 }]]) {
    await writeFile(file, JSON.stringify({ version: 1, handled }));
    await assert.rejects(new StateStore(file).get("c1"), /invalid state file/);
  }
});

it("a cold first read that finishes after a newer write does not replace the cache", async () => {
  const file = await tempStatePath();
  await new StateStore(file).put(record("c0"), 10);
  const store = new StateStore(file);
  const realReadFile = fs.promises.readFile;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  // The store's first read gets the old file, but returns it only once released.
  mock.method(fs.promises, "readFile", async (...args: Parameters<typeof realReadFile>) => {
    const text = await realReadFile(...args);
    if (reads++ === 0) await held;
    return text;
  });
  syncBuiltinESMExports();
  try {
    const first = store.get("c0");
    const write = store.put(record("c1"), 10);
    // Room for a separate read and the write to land before the first read finishes.
    await Promise.race([write, new Promise((resolve) => setTimeout(resolve, 200))]);
    release();
    await Promise.all([first, write]);
    assert.equal((await store.get("c1"))?.childId, "c1");
    await store.put(record("c2"), 10);
    const raw = JSON.parse(await readFile(file, "utf8")) as { handled: HandledRecord[] };
    assert.deepEqual(raw.handled.map((entry) => entry.childId), ["c0", "c1", "c2"]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

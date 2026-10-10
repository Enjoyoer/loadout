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
  // Each read takes the file as it is when called, and returns it only when released.
  const held: Array<() => void> = [];
  mock.method(fs.promises, "readFile", ((filePath: string) => {
    const text = fs.readFileSync(filePath, "utf8");
    return new Promise<string>((resolve) => held.push(() => resolve(text)));
  }) as typeof fs.promises.readFile);
  syncBuiltinESMExports();
  try {
    const first = store.get("c0");
    const write = store.put(record("c1"), 10);
    // Every read either call starts is issued within the microtasks before this immediate.
    await new Promise((resolve) => setImmediate(resolve));
    // A read the write started on its own finishes first, and the write lands, before the first read returns.
    const own = held.splice(1);
    for (const release of own) release();
    if (own.length > 0) await write;
    for (const release of held.splice(0)) release();
    await Promise.all([first, write]);
    assert.equal((await store.get("c1"))?.childId, "c1");
    await store.put(record("c2"), 10);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { handled: HandledRecord[] };
    assert.deepEqual(raw.handled.map((entry) => entry.childId), ["c0", "c1", "c2"]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

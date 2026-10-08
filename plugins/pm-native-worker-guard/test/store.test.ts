import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { it } from "node:test";
import { defaultStatePath, StateStore, type HandledRecord } from "../server/store.ts";
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

it("lives under PASEO_HOME/plugin-state/pm-native-worker-guard", () => {
  assert.equal(defaultStatePath({ PASEO_HOME: "/srv/paseo-home" }), "/srv/paseo-home/plugin-state/pm-native-worker-guard/state.json");
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

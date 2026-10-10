import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { StateStore, type StateEntry, type WriteJson } from "../server/store.ts";
import { writeJsonAtomically } from "../server/vendor/atomic-json.ts";

function entry(key: string): StateEntry {
  return { key, agentId: "a", turnId: key, lastUserMessageAt: null, createdAt: "1", outcome: "skip", reason: "x" };
}

function latch() {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

// A state writer that logs each write it lands under one label. With hold, its first write
// parks inside the write, past the store's own checks, until hold resolves.
function recordingWriter(label: string, landed: string[], hold?: Promise<void>) {
  let enter = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let calls = 0;
  const write: WriteJson = async (filePath, value, options) => {
    if (calls++ === 0 && hold) { enter(); await hold; }
    await writeJsonAtomically(filePath, value, options);
    landed.push(label);
  };
  return { write, entered, calls: () => calls };
}

describe("StateStore", () => {
  it("deduplicates checkpoint keys durably and bounds state", async () => {
    const store = new StateStore(`/tmp/cache-aware-autocompact-${process.pid}.json`);
    await store.append({ key: "a:t1", agentId: "a", turnId: "t1", lastUserMessageAt: null, createdAt: "1", outcome: "skip", reason: "x" }, 2);
    await store.append({ key: "a:t1", agentId: "a", turnId: "t1", lastUserMessageAt: null, createdAt: "2", outcome: "would-compact", reason: "y" }, 2);
    assert.equal(await store.has("a:t1"), true);
    await store.append({ key: "a:t2", agentId: "a", turnId: "t2", lastUserMessageAt: null, createdAt: "3", outcome: "skip", reason: "z" }, 2);
    await store.append({ key: "a:t3", agentId: "a", turnId: "t3", lastUserMessageAt: null, createdAt: "4", outcome: "skip", reason: "q" }, 2);
    const entries = await store.read();
    assert.deepEqual(entries.map((entry) => entry.key), ["a:t2", "a:t3"]);
  });

  it("rejects malformed records instead of acting on them, and leaves the file alone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-aware-autocompact-"));
    const filePath = path.join(dir, "state.json");
    const turn = { agentId: "a", turnId: "t1", key: "a:t1", timeline: [], lastUserMessageAt: null, retryCount: 0, endedAt: "2026-09-26T08:00:00.000Z" };
    const states = [
      { version: 1, entries: [null] },
      { version: 1, entries: [{ ...entry("a:t1"), outcome: "deleted" }] },
      { version: 1, entries: [{ ...entry("a:t1"), createdAt: "not-a-date" }] },
      { version: 1, entries: [], turns: "a:t1" },
      { version: 1, entries: [], turns: [{ ...turn, endedAt: "not-a-date" }] },
      { version: 1, entries: [], turns: [{ ...turn, timeline: [{ type: "tool_call" }] }] },
    ];
    for (const state of states) {
      const text = JSON.stringify(state);
      await writeFile(filePath, text);
      const store = new StateStore(filePath);
      await assert.rejects(store.read(), /Invalid state/);
      await assert.rejects(store.latestTurn("a"), /Invalid state/);
      await assert.rejects(store.append(entry("a:t2"), 10), /Invalid state/);
      assert.equal(await readFile(filePath, "utf8"), text);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps accepting writes after one write fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-aware-autocompact-"));
    const filePath = path.join(dir, "state.json");
    const store = new StateStore(filePath);
    const entry = { key: "a:t1", agentId: "a", turnId: "t1", lastUserMessageAt: null, createdAt: "1", outcome: "skip" as const, reason: "x" };
    await mkdir(filePath);
    await assert.rejects(store.append(entry, 2));
    await rm(filePath, { recursive: true });
    await store.append(entry, 2);
    assert.deepEqual((await store.read()).map((candidate) => candidate.key), ["a:t1"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the state file whole when two stores in one process write concurrently", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-aware-autocompact-"));
    const filePath = path.join(dir, "state.json");
    const landed: string[] = [];
    const gate = latch();
    const oldWriter = recordingWriter("old", landed, gate.held);
    const older = new StateStore(filePath, oldWriter.write);
    const inFlight = older.append(entry("old:1"), 100);
    await oldWriter.entered;
    const queuedBefore = older.append(entry("old:2"), 100);
    const newer = new StateStore(filePath, recordingWriter("new", landed).write);
    const newWrite = newer.append(entry("new:1"), 100);
    const queuedAfter = older.append(entry("old:3"), 100);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(landed, []);
    gate.release();
    await Promise.all([inFlight, queuedBefore, newWrite, queuedAfter]);
    assert.deepEqual(landed, ["old", "new"]);
    assert.equal(oldWriter.calls(), 1);
    const state = JSON.parse(await readFile(filePath, "utf8")) as { version: number; entries: StateEntry[] };
    assert.equal(state.version, 1);
    assert.deepEqual(state.entries.map((candidate) => candidate.key), ["old:1", "new:1"]);
    assert.deepEqual(await readdir(dir), ["state.json"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("drops a late write from a closed store instead of overwriting the newer store's state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-aware-autocompact-"));
    const filePath = path.join(dir, "state.json");
    const landed: string[] = [];
    const gate = latch();
    const oldWriter = recordingWriter("old", landed, gate.held);
    const older = new StateStore(filePath, oldWriter.write);
    const oldWrite = older.append(entry("old:1"), 100);
    await oldWriter.entered;
    let landedAtClose: string[] | undefined;
    const closing = older.close().then(() => { landedAtClose = [...landed]; });
    const closedWith = () => landedAtClose;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closedWith(), undefined);
    const newer = new StateStore(filePath, recordingWriter("new", landed).write);
    const newWrite = newer.append(entry("new:1"), 100);
    gate.release();
    await closing;
    assert.ok(closedWith()?.includes("old"), "close() resolved before the old write landed");
    await Promise.all([oldWrite, newWrite]);
    assert.deepEqual(landed, ["old", "new"]);
    await older.append(entry("old:2"), 100);
    await older.rememberTurn({ agentId: "a", turnId: "t1", key: "a:t1", timeline: [], lastUserMessageAt: null, retryCount: 0, endedAt: "1" }, 100);
    assert.equal(oldWriter.calls(), 1);
    assert.deepEqual((await newer.read()).map((candidate) => candidate.key), ["old:1", "new:1"]);
    assert.equal(await newer.latestTurn("a"), null);
    assert.deepEqual(await readdir(dir), ["state.json"]);
    await rm(dir, { recursive: true, force: true });
  });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { StateStore, type StateEntry } from "../server/store.ts";

function entry(key: string): StateEntry {
  return { key, agentId: "a", turnId: key, lastUserMessageAt: null, createdAt: "1", outcome: "skip", reason: "x" };
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
    const older = new StateStore(filePath);
    const writes = Array.from({ length: 20 }, (_, index) => older.append(entry(`old:${index}`), 100));
    // Let the older store's first write get under way before the newer store starts.
    await new Promise((resolve) => setImmediate(resolve));
    const newer = new StateStore(filePath);
    writes.push(...Array.from({ length: 20 }, (_, index) => newer.append(entry(`new:${index}`), 100)));
    await Promise.all(writes);
    const state = JSON.parse(await readFile(filePath, "utf8")) as { version: number; entries: StateEntry[] };
    assert.equal(state.version, 1);
    const keys = state.entries.map((candidate) => candidate.key);
    assert.ok(keys.every((key) => /^(old|new):\d+$/.test(key)), keys.join(","));
    assert.deepEqual(keys.filter((key) => key.startsWith("new:")), Array.from({ length: 20 }, (_, index) => `new:${index}`));
    assert.deepEqual(await readdir(dir), ["state.json"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("drops a late write from a closed store instead of overwriting the newer store's state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-aware-autocompact-"));
    const filePath = path.join(dir, "state.json");
    const older = new StateStore(filePath);
    await older.append(entry("old:1"), 100);
    await older.close();
    await older.append(entry("old:2"), 100);
    const newer = new StateStore(filePath);
    await newer.append(entry("new:1"), 100);
    await older.append(entry("old:3"), 100);
    await older.rememberTurn({ agentId: "a", turnId: "t1", key: "a:t1", timeline: [], lastUserMessageAt: null, retryCount: 0, endedAt: "1" }, 100);
    assert.deepEqual((await newer.read()).map((candidate) => candidate.key), ["old:1", "new:1"]);
    assert.equal(await newer.latestTurn("a"), null);
    assert.deepEqual(await readdir(dir), ["state.json"]);
    await rm(dir, { recursive: true, force: true });
  });
});

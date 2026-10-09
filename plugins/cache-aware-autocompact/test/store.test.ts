import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { StateStore } from "../server/store.ts";

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
});

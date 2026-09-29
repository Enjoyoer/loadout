import assert from "node:assert/strict";
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
});

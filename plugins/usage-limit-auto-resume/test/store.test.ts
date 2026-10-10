import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MAX_SETTLED_RECORDS, ResumeStore } from "../server/store.ts";
import { buildRecord, type AgentSnapshot, type ResumeConfig } from "../server/model.ts";

const config: ResumeConfig = {
  maxAttempts: 3,
  baseDelaySeconds: 18000,
  maxDelaySeconds: 604800,
  resetBufferSeconds: 30,
  verificationTimeoutSeconds: 180,
  excludedProviders: ["chatgpt-web"],
  excludedLabels: ["noresume"],
};
const agent: AgentSnapshot = {
  id: "agent-1",
  workspaceId: "workspace-1",
  provider: "claude",
  model: "claude-opus-5-5[1m]",
  currentModeId: "bypassPermissions",
  thinkingOptionId: "low",
  cwd: "/repo",
  status: "idle",
  persistence: { provider: "claude", sessionId: "session-1", nativeHandle: "native-1" },
};

describe("ResumeStore", () => {
  it("round-trips records through the durable file", async () => {
    const store = new ResumeStore(`/tmp/usage-limit-auto-resume-test-${process.pid}.json`);
    const record = buildRecord(agent, "out of credits", undefined, config, Date.now(), "turn-1");
    assert.ok(record);
    await store.upsert(record);
    const records = await store.read();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.recordId, record.recordId);
    await store.remove(record.recordId);
    assert.deepEqual(await store.read(), []);
  });

  it("keeps both changes when two updates to one record run concurrently", async () => {
    // A resumed turn's start (resumeTurnId) and the send receipt (state) land together.
    const store = new ResumeStore(`/tmp/usage-limit-auto-resume-race-${process.pid}.json`);
    const record = buildRecord(agent, "out of credits", undefined, config, Date.now(), "turn-1");
    assert.ok(record);
    await store.upsert(record);
    await Promise.all([
      store.update(record.recordId, (value) => ({ ...value, resumeTurnId: "turn-2" })),
      store.update(record.recordId, (value) => ({ ...value, state: "verifying" })),
    ]);
    const [stored] = await store.read();
    assert.equal(stored?.resumeTurnId, "turn-2");
    assert.equal(stored?.state, "verifying");
    await store.remove(record.recordId);
  });

  it("keeps every record when upserts for different agents run concurrently", async () => {
    const store = new ResumeStore(`/tmp/usage-limit-auto-resume-upsert-${process.pid}.json`);
    const records = ["agent-a", "agent-b", "agent-c"].map((id) => buildRecord({ ...agent, id }, "out of credits", undefined, config, Date.now(), `turn-${id}`)!);
    await Promise.all(records.map((record) => store.upsert(record)));
    assert.deepEqual((await store.read()).map((record) => record.agentId).sort(), ["agent-a", "agent-b", "agent-c"]);
    for (const record of records) await store.remove(record.recordId);
  });

  it("never prunes an actionable or uncertain record, and leaves a guard for each pruned settled one", async () => {
    const filePath = path.join(tmpdir(), `usage-limit-auto-resume-retain-${process.pid}.json`);
    const old = (state: "parked" | "uncertain", turn: string) => ({ ...buildRecord(agent, "out of credits", undefined, config, Date.now(), turn)!, state, updatedAt: "2026-01-01T00:00:00.000Z" });
    const parked = old("parked", "turn-parked");
    const uncertain = old("uncertain", "turn-uncertain");
    const settled = Array.from({ length: MAX_SETTLED_RECORDS + 5 }, (_, n) => ({
      ...buildRecord(agent, "out of credits", undefined, config, Date.now(), `turn-${n}`)!,
      state: "done" as const,
      updatedAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + n * 1000).toISOString(),
    }));
    await writeFile(filePath, JSON.stringify({ version: 2, records: [parked, uncertain, ...settled] }));
    try {
      const store = new ResumeStore(filePath);
      const next = buildRecord(agent, "out of credits", undefined, config, Date.now(), "turn-next")!;
      await store.upsert(next);
      const ids = (await store.read()).map((record) => record.recordId);
      assert.deepEqual(ids, [parked.recordId, uncertain.recordId, ...settled.slice(5).map((record) => record.recordId), next.recordId]);
      for (const record of settled.slice(0, 5)) assert.equal(await store.hasTurn(record), true, record.sourceTurnId);
      assert.equal(await store.hasTurn({ ...settled[0]!, sourceTurnId: "turn-unseen" }), false);
      // An update keeps the guards.
      await store.update(next.recordId, (value) => ({ ...value, state: "parked" }));
      assert.equal(await store.hasTurn(settled[0]!), true);
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it("throws on a corrupt state file instead of reading it as empty", async () => {
    const filePath = `/tmp/usage-limit-auto-resume-corrupt-${process.pid}.json`;
    await writeFile(filePath, "{\"version\":2,\"records\":[");
    try {
      await assert.rejects(new ResumeStore(filePath).read(), /cannot read/);
    } finally {
      await rm(filePath, { force: true });
    }
  });
});

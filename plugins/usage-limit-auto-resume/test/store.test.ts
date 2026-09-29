import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResumeStore } from "../server/store.ts";
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
});

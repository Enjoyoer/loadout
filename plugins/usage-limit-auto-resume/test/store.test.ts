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
});

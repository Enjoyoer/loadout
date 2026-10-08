import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { DEFAULT_NOTICE, defaultConfig } from "../server/config.ts";
import { TIMELINE_KIND } from "../server/guard.ts";
import { PARENT_AGENT_ID_LABEL } from "../server/policy.ts";
import { CHILD_ID, PM_ID, child, created, entries, fakeApi, harness, pm } from "./fakes.ts";

const NOTICE = `pm-native-worker-guard archived ${CHILD_ID} (codex): ${DEFAULT_NOTICE}`;
const mutations = (calls: readonly string[]) => calls.filter((call) => !call.startsWith("refresh:"));

describe("armed", () => {
  it("archives a native child of an idle PM and notifies the PM once", async () => {
    const h = await harness({ armed: true });
    const api = fakeApi([pm(), child()]);
    const result = await h.guard.handleCreated(created(), api);
    assert.deepEqual(result, { action: "archived", reason: "pm-created-native-worker" });
    assert.deepEqual(mutations(api.calls), [`archive:${CHILD_ID}`, `send:${PM_ID}`]);
    assert.deepEqual(api.sent, [{ agentId: PM_ID, text: NOTICE }]);
    assert.ok(NOTICE.includes("pi/fleet/claude-opus-5-5") && NOTICE.includes("pi/fleet/gpt-6.1-sol"));
    assert.equal(api.rows.length, 0);
    const record = await h.store.get(CHILD_ID);
    assert.equal(record?.outcome, "archived");
    assert.equal(record?.notice, "sent");
    assert.deepEqual(entries(h.logs).map((entry) => entry.action), ["archived", "notify-sent"]);
  });

  it("matches claude and provider/model forms", async () => {
    for (const provider of ["claude", "claude/opus", "codex/gpt-5.5"]) {
      const h = await harness({ armed: true });
      const api = fakeApi([pm(), child({ provider })]);
      assert.equal((await h.guard.handleCreated(created({ provider }), api)).action, "archived", provider);
      assert.ok(api.calls.includes(`archive:${CHILD_ID}`));
    }
  });

  it("does not interrupt a mid-turn PM: appends a timeline row, then sends once the PM's turn ends", async () => {
    const h = await harness({ armed: true });
    const parent = pm({ status: "running", activeTurn: { turnId: "t1" } });
    const api = fakeApi([parent, child()]);
    await h.guard.handleCreated(created(), api);
    assert.deepEqual(mutations(api.calls), [`archive:${CHILD_ID}`, `append:${PM_ID}`]);
    assert.equal(api.sent.length, 0);
    assert.deepEqual(api.rows[0]?.item, {
      type: "plugin",
      id: `archived-${CHILD_ID}`,
      kind: TIMELINE_KIND,
      version: 1,
      data: { childId: CHILD_ID, provider: "codex", message: NOTICE },
    });
    assert.equal((await h.store.get(CHILD_ID))?.notice, "pending");

    // Another agent's turn ending changes nothing.
    await h.guard.handleTurnEnded({ id: "someone-else" }, api);
    assert.equal(api.sent.length, 0);

    // The PM's turn ends while it is still busy (a new turn already started): still pending.
    await h.guard.handleTurnEnded({ id: PM_ID }, api);
    assert.equal(api.sent.length, 0);

    parent.status = "idle";
    parent.activeTurn = null;
    await h.guard.handleTurnEnded({ id: PM_ID }, api);
    assert.deepEqual(api.sent, [{ agentId: PM_ID, text: NOTICE }]);
    assert.equal((await h.store.get(CHILD_ID))?.notice, "sent");

    await h.guard.handleTurnEnded({ id: PM_ID }, api);
    assert.equal(api.sent.length, 1);
  });

  it("does not notify when archiving fails, and records the failure", async () => {
    const h = await harness({ armed: true });
    const api = fakeApi([pm(), child()]);
    api.failArchive = true;
    const result = await h.guard.handleCreated(created(), api);
    assert.equal(result.action, "archive-failed");
    assert.equal(api.sent.length, 0);
    assert.equal((await h.store.get(CHILD_ID))?.outcome, "archive-failed");
  });

  it("logs a failed notice without retrying it", async () => {
    const h = await harness({ armed: true });
    const api = fakeApi([pm(), child()]);
    api.failSend = true;
    assert.equal((await h.guard.handleCreated(created(), api)).action, "archived");
    assert.equal((await h.store.get(CHILD_ID))?.notice, "failed");
    assert.ok(entries(h.logs).some((entry) => entry.action === "notify-failed"));
    await h.guard.handleTurnEnded({ id: PM_ID }, api);
    assert.equal(api.calls.filter((call) => call === `send:${PM_ID}`).length, 1);
  });

  it("ignores labels the PM sets on the child: only the owner settings approve", async () => {
    const h = await harness({ armed: true });
    const labels = { [PARENT_AGENT_ID_LABEL]: PM_ID, role: "pm", "pm-native-worker-guard": "allow", allowAgentIds: CHILD_ID };
    const api = fakeApi([pm(), child({ labels })]);
    assert.equal((await h.guard.handleCreated(created(), api)).action, "archived");
  });
});

describe("dry-run", () => {
  it("is the default and changes nothing", async () => {
    const h = await harness();
    const api = fakeApi([pm(), child()]);
    const result = await h.guard.handleCreated(created(), api);
    assert.deepEqual(result, { action: "would-archive", reason: "pm-created-native-worker" });
    assert.deepEqual(mutations(api.calls), []);
    assert.deepEqual(entries(h.logs).map((entry) => entry.action), ["would-archive"]);
    assert.equal((await h.store.get(CHILD_ID))?.outcome, "would-archive");
    await h.guard.handleTurnEnded({ id: PM_ID }, api);
    assert.deepEqual(mutations(api.calls), []);
  });

  it("invalid settings do nothing", async () => {
    const h = await harness(null);
    const api = fakeApi([pm(), child()]);
    assert.equal((await h.guard.handleCreated(created(), api)).action, "config-invalid");
    assert.deepEqual(api.calls, []);
  });
});

describe("left alone", () => {
  it("Pi children, without any SDK call", async () => {
    const h = await harness({ armed: true });
    const api = fakeApi([pm(), child({ provider: "pi" })]);
    for (const provider of ["pi", "pi/fleet/claude-opus-5-5"]) {
      assert.deepEqual(await h.guard.handleCreated(created({ provider }), api), { action: "ignore", reason: "not-native" });
    }
    assert.deepEqual(api.calls, []);
    assert.deepEqual(h.logs, []);
  });

  it("native children with no parent (owner-created), without any SDK call", async () => {
    const h = await harness({ armed: true });
    const api = fakeApi([child({ labels: {} })]);
    assert.deepEqual(await h.guard.handleCreated(created({ parentAgentId: null }), api), { action: "ignore", reason: "no-parent" });
    assert.deepEqual(api.calls, []);
  });

  it("native children of a non-PM parent", async () => {
    const variants: Array<Record<string, string>> = [{}, { role: "worker" }, { role: "pmx" }];
    for (const labels of variants) {
      const h = await harness({ armed: true });
      const api = fakeApi([pm({ labels }), child()]);
      assert.deepEqual(await h.guard.handleCreated(created(), api), { action: "skip", reason: "parent-not-pm" });
      assert.deepEqual(mutations(api.calls), []);
    }
  });

  it("accepts a configurable PM label and compares values case-insensitively", async () => {
    const h = await harness({ armed: true, pmLabelKey: "team-role", pmLabelValue: "lead" });
    const api = fakeApi([pm({ labels: { "team-role": " Lead " } }), child()]);
    assert.equal((await h.guard.handleCreated(created(), api)).action, "archived");
    const other = await harness({ armed: true, pmLabelKey: "team-role", pmLabelValue: "lead" });
    const otherApi = fakeApi([pm(), child()]);
    assert.equal((await other.guard.handleCreated(created(), otherApi)).reason, "parent-not-pm");
  });

  it("allowlisted children and parents, without any SDK call", async () => {
    const byChild = await harness({ armed: true, allowAgentIds: [CHILD_ID] });
    const api = fakeApi([pm(), child()]);
    assert.deepEqual(await byChild.guard.handleCreated(created(), api), { action: "skip", reason: "allowlisted-agent" });
    const byParent = await harness({ armed: true, allowParentIds: [PM_ID] });
    assert.deepEqual(await byParent.guard.handleCreated(created(), api), { action: "skip", reason: "allowlisted-parent" });
    assert.deepEqual(api.calls, []);
  });

  it("a missing parent, a missing or archived child, or a parent label that does not match", async () => {
    const cases: Array<[ReturnType<typeof fakeApi>, string]> = [
      [fakeApi([child()]), "parent-not-found"],
      [fakeApi([pm()]), "child-not-found"],
      [fakeApi([pm(), child({ archivedAt: "2026-10-08T11:59:59.000Z" })]), "child-already-archived"],
      [fakeApi([pm(), child({ labels: { [PARENT_AGENT_ID_LABEL]: "someone-else" } })]), "parent-label-mismatch"],
      [fakeApi([pm(), child({ provider: "pi" })]), "child-not-native"],
    ];
    for (const [api, reason] of cases) {
      const h = await harness({ armed: true });
      assert.deepEqual(await h.guard.handleCreated(created(), api), { action: "skip", reason });
      assert.deepEqual(mutations(api.calls), [], reason);
    }
  });
});

describe("fail safe", () => {
  it("an SDK error reading the parent or child leaves the agent alone and logs once", async () => {
    for (const failing of [PM_ID, CHILD_ID]) {
      const h = await harness({ armed: true });
      const api = fakeApi([pm(), child()]);
      api.failRefresh.add(failing);
      const result = await h.guard.handleCreated(created(), api);
      assert.equal(result.action, "skip");
      assert.match(result.reason ?? "", /^sdk-error\((parent|child)\): socket closed$/);
      assert.deepEqual(mutations(api.calls), []);
      api.failRefresh.clear();
      assert.equal((await h.guard.handleCreated(created(), api)).action, "duplicate");
      assert.deepEqual(mutations(api.calls), []);
      assert.equal(h.logs.length, 1);
    }
  });

  it("an unreadable state file stops all action and is logged once", async () => {
    const h = await harness({ armed: true });
    await writeFile(h.statePath, "{not json");
    const api = fakeApi([pm(), child()]);
    assert.deepEqual(await h.guard.handleCreated(created(), api), { action: "skip", reason: "state-unreadable" });
    assert.deepEqual(await h.guard.handleCreated(created({ id: "agent-child-0002" }), api), { action: "skip", reason: "state-unreadable" });
    assert.deepEqual(api.calls, []);
    assert.deepEqual(entries(h.logs).map((entry) => entry.action), ["state-unreadable"]);
  });

  it("a parent whose state cannot be read is not interrupted; the notice waits", async () => {
    const h = await harness({ armed: true });
    const api = fakeApi([pm(), child()]);
    api.onArchive = () => api.failRefresh.add(PM_ID);
    assert.equal((await h.guard.handleCreated(created(), api)).action, "archived");
    assert.equal(api.sent.length, 0);
    assert.equal((await h.store.get(CHILD_ID))?.notice, "pending");
    api.failRefresh.clear();
    await h.guard.handleTurnEnded({ id: PM_ID }, api);
    assert.equal(api.sent.length, 1);
  });
});

describe("idempotency", () => {
  it("concurrent duplicate events archive and notify once", async () => {
    const h = await harness({ armed: true });
    const api = fakeApi([pm(), child()]);
    const results = await Promise.all([h.guard.handleCreated(created(), api), h.guard.handleCreated(created(), api)]);
    assert.deepEqual(results.map((result) => result.action).sort(), ["archived", "duplicate"]);
    assert.equal(api.calls.filter((call) => call.startsWith("archive:")).length, 1);
    assert.equal(api.sent.length, 1);
  });

  it("a duplicate after a reload (new process, same state file) does nothing", async () => {
    const first = await harness({ armed: true });
    const api = fakeApi([pm(), child()]);
    await first.guard.handleCreated(created(), api);
    const second = await harness({ armed: true }, first.statePath);
    const before = api.calls.length;
    assert.deepEqual(await second.guard.handleCreated(created(), api), { action: "duplicate", reason: "archived" });
    assert.equal(api.calls.length, before);
    assert.deepEqual(second.logs, []);
  });

  it("a dry-run decision is not repeated after arming", async () => {
    const h = await harness();
    const api = fakeApi([pm(), child()]);
    await h.guard.handleCreated(created(), api);
    h.setConfig(defaultConfig({ armed: true }));
    assert.deepEqual(await h.guard.handleCreated(created(), api), { action: "duplicate", reason: "would-archive" });
    assert.deepEqual(mutations(api.calls), []);
  });

  it("two children archived while the PM is busy are reported in one message", async () => {
    const h = await harness({ armed: true });
    const parent = pm({ status: "running" });
    const second = child({ id: "agent-child-0002", provider: "claude" });
    const api = fakeApi([parent, child(), second]);
    await h.guard.handleCreated(created(), api);
    await h.guard.handleCreated(created({ id: "agent-child-0002", provider: "claude" }), api);
    assert.equal(api.rows.length, 2);
    parent.status = "idle";
    await Promise.all([h.guard.handleTurnEnded({ id: PM_ID }, api), h.guard.handleTurnEnded({ id: PM_ID }, api)]);
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0]?.text.split("\n").length, 2);
    assert.match(api.sent[0]?.text ?? "", /archived agent-child-0002 \(claude\)/);
  });
});

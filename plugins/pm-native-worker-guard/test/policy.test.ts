import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { allowlistReason, isBusy, isNativeProvider, isPmAgent, noticeText } from "../server/policy.ts";

const NATIVE = ["codex", "claude"];

it("treats codex, claude, and their provider/model forms as native", () => {
  for (const provider of ["codex", "claude", "Codex", "codex/gpt-5.5", "claude/opus", " claude "]) {
    assert.equal(isNativeProvider(provider, NATIVE), true, provider);
  }
  for (const provider of ["pi", "pi/fleet/claude-opus-5-5", "opencode", "claude-acp", "codexx", "", "acp/claude"]) {
    assert.equal(isNativeProvider(provider, NATIVE), false, provider);
  }
  assert.equal(isNativeProvider("opencode/local", ["opencode"]), true);
});

it("recognizes a PM by its label only", () => {
  const config = defaultConfig();
  assert.equal(isPmAgent({ role: "pm" }, config), true);
  assert.equal(isPmAgent({ role: " PM " }, config), true);
  assert.equal(isPmAgent({ role: "worker" }, config), false);
  assert.equal(isPmAgent({}, config), false);
  assert.equal(isPmAgent(undefined, config), false);
});

it("treats running, initializing, or an active turn as busy", () => {
  assert.equal(isBusy({ status: "running" }), true);
  assert.equal(isBusy({ status: "initializing" }), true);
  assert.equal(isBusy({ status: "idle", activeTurn: { turnId: "t" } }), true);
  assert.equal(isBusy({ status: "idle", activeTurn: null }), false);
  assert.equal(isBusy({ status: "error" }), false);
});

it("allowlists exact ids from settings", () => {
  const config = defaultConfig({ allowAgentIds: ["c1"], allowParentIds: ["p1"] });
  assert.equal(allowlistReason("c1", "p9", config), "allowlisted-agent");
  assert.equal(allowlistReason("c9", "p1", config), "allowlisted-parent");
  assert.equal(allowlistReason("c", "p", config), null);
});

it("formats the notice", () => {
  assert.equal(noticeText("c1", "codex", "Use Pi."), "pm-native-worker-guard archived c1 (codex): Use Pi.");
});

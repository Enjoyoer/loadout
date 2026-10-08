import assert from "node:assert/strict";
import { it } from "node:test";
import { ConfigSchema, DEFAULT_NOTICE, defaultConfig } from "../server/config.ts";

it("defaults to dry-run, role=pm, no allowlist, codex and claude as native providers", () => {
  const config = defaultConfig();
  assert.equal(config.armed, false);
  assert.equal(config.pmLabelKey, "role");
  assert.equal(config.pmLabelValue, "pm");
  assert.deepEqual(config.allowAgentIds, []);
  assert.deepEqual(config.allowParentIds, []);
  assert.deepEqual(config.nativeProviders, ["codex", "claude"]);
  assert.equal(config.notice, DEFAULT_NOTICE);
  assert.equal(config.maxStateEntries, 2_000);
});

it("only a boolean arms it; unknown keys and wrong types make the settings invalid", () => {
  assert.equal(ConfigSchema.parse({ armed: true }).armed, true);
  for (const armed of ["true", 1, null]) assert.equal(ConfigSchema.safeParse({ armed }).success, false);
  assert.equal(ConfigSchema.safeParse({ armd: true }).success, false);
  assert.equal(ConfigSchema.safeParse({ allowAgentIds: "abc" }).success, false);
  assert.equal(ConfigSchema.safeParse({ allowAgentIds: [""] }).success, false);
  assert.equal(ConfigSchema.safeParse({ nativeProviders: [] }).success, false);
});

it("trims allowlist ids", () => {
  assert.deepEqual(ConfigSchema.parse({ allowAgentIds: [" a1 "], allowParentIds: ["p1\n"] }).allowAgentIds, ["a1"]);
  assert.deepEqual(ConfigSchema.parse({ allowParentIds: ["p1\n"] }).allowParentIds, ["p1"]);
});

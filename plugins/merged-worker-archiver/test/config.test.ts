import assert from "node:assert/strict";
import { it } from "node:test";
import { ConfigSchema, defaultConfig } from "../server/config.ts";
import { resolveDaemonTarget } from "../server/daemon.ts";

it("defaults to dry-run, with workspace cleanup armed separately", () => {
  assert.equal(defaultConfig().armed, false);
  assert.equal(defaultConfig().armWorkspaceCleanup, false);
  assert.equal(ConfigSchema.safeParse({ armed: true }).data?.armWorkspaceCleanup, false);
  assert.equal(defaultConfig().staleWorkspaceMinutes, 3 * 24 * 60);
});

it("stale sweep: off by default, flag-only (no opt-in lists, no exclusions), 3 days; entries must be non-empty strings", () => {
  const config = defaultConfig();
  assert.equal(config.staleSweep, false);
  assert.equal(config.staleAgentMinutes, 3 * 24 * 60);
  assert.deepEqual([config.staleArchivePms, config.staleArchiveProjects, config.staleExclude], [[], [], []]);
  assert.equal(config.staleArchiveAll, false);
  assert.deepEqual(ConfigSchema.safeParse({ staleSweep: true, staleExclude: ["keep=1", " wks_1 "] }).data?.staleExclude, ["keep=1", "wks_1"]);
  for (const bad of [{ staleExclude: [""] }, { staleExclude: [1] }, { staleArchivePms: "pm" }, { staleAgentMinutes: 0 }, { staleSweep: "yes" }, { staleArchiveAll: "yes" }]) {
    assert.equal(ConfigSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

it("loads a live settings file that sets maxArchivesPerSweep and keeps its value", () => {
  const parsed = ConfigSchema.safeParse({ armed: true, maxArchivesPerSweep: 50 });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.armed, true);
  assert.equal(parsed.data?.maxArchivesPerSweep, 50);
});

it("maxArchivesPerSweep: a settings file without it loads as 5; 0, -1, 0.5 and \"5\" are refused", () => {
  const cases: Array<[unknown, number | "refused"]> = [[undefined, 5], [0, "refused"], [-1, "refused"], [0.5, "refused"], ["5", "refused"]];
  for (const [value, expected] of cases) {
    const parsed = ConfigSchema.safeParse(value === undefined ? { armed: true } : { armed: true, maxArchivesPerSweep: value });
    if (expected === "refused") assert.equal(parsed.success, false, JSON.stringify(value));
    else assert.equal(parsed.data?.maxArchivesPerSweep, expected);
  }
});

it("bounds follow-ups", () => {
  assert.equal(ConfigSchema.safeParse({ followUpDelaysSeconds: [1, 2, 3, 4, 5, 6] }).success, false);
  assert.equal(ConfigSchema.safeParse({ followUpDelaysSeconds: [0] }).success, false);
});

it("rejects unknown keys and non-boolean armed (fails closed as invalid settings)", () => {
  assert.equal(ConfigSchema.safeParse({ armd: true }).success, false);
  assert.equal(ConfigSchema.safeParse({ armed: "yes" }).success, false);
});

it("resolves the fallback daemon from PASEO_HOST, then the default", () => {
  assert.equal(resolveDaemonTarget({ PASEO_HOST: "127.0.0.1:7788" }).url, "ws://127.0.0.1:7788/ws");
  assert.throws(() => resolveDaemonTarget({ PASEO_HOME: "/nonexistent-home" }), /Refusing default-daemon fallback/);
});

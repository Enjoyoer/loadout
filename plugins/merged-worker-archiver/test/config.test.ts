import assert from "node:assert/strict";
import { it } from "node:test";
import { ConfigSchema, defaultConfig } from "../server/config.ts";
import { resolveDaemonTarget } from "../server/daemon.ts";

it("defaults to dry-run", () => {
  assert.equal(defaultConfig().armed, false);
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

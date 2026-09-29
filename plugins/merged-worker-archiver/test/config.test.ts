import assert from "node:assert/strict";
import { it } from "node:test";
import { ConfigSchema, defaultConfig } from "../server/config.ts";
import { resolveDaemonTarget } from "../server/daemon.ts";

it("defaults to dry-run, zero grace, a 60 minute backstop sweep, 3 s debounce, 15/60/180 s follow-ups", () => {
  const config = defaultConfig();
  assert.equal(config.armed, false);
  assert.equal(config.sweepIntervalMinutes, 60);
  assert.equal(config.graceMinutes, 0);
  assert.equal(config.eventDebounceSeconds, 3);
  assert.deepEqual(config.followUpDelaysSeconds, [15, 60, 180]);
  assert.equal(config.useGh, true);
});

it("accepts and ignores the retired maxArchivesPerSweep key (live settings file)", () => {
  const parsed = ConfigSchema.safeParse({ armed: true, maxArchivesPerSweep: 50 });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.armed, true);
  assert.equal(Object.hasOwn(parsed.data ?? {}, "maxArchivesPerSweep"), false);
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
  assert.equal(resolveDaemonTarget({ PASEO_HOME: "/nonexistent-home" }).source, "default");
});

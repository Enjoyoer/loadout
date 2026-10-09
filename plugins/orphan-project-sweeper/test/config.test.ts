import assert from "node:assert/strict";
import { it } from "node:test";
import { readConfig } from "../server/config.ts";

it("defaults to unarmed", () => {
  assert.equal(readConfig().armed, false);
});

it("only literal true arms the sweeper", () => {
  assert.equal(readConfig({ armed: true }).armed, true);
  for (const armed of [false, undefined, null, 0, 1, "true", "false", {}, []]) {
    assert.equal(readConfig({ armed }).armed, false);
  }
});

it("accepts positive integer caps", () => {
  for (const cap of [1, 5, 100]) {
    assert.equal(readConfig({ maxDeletesPerSweep: cap }).maxDeletesPerSweep, cap);
  }
});

it("invalid caps fall back to five and log the setting and fallback", () => {
  for (const cap of [0, -1, 1.5, "2", null, false, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const logs: string[] = [];
    const config = readConfig({ armed: true, maxDeletesPerSweep: cap }, (line) => logs.push(line));
    assert.deepEqual(config, { armed: true, maxDeletesPerSweep: 5 });
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /config-invalid setting=maxDeletesPerSweep .*fallback=5/);
  }
});

it("malformed documents and unknown keys fall back to unarmed defaults with a log", () => {
  for (const values of [null, [], "true", { armed: true, armd: true }]) {
    const logs: string[] = [];
    assert.deepEqual(readConfig(values, (line) => logs.push(line)), { armed: false, maxDeletesPerSweep: 5 });
    assert.match(logs[0]!, /config-invalid fallback=dry-run/);
  }
});

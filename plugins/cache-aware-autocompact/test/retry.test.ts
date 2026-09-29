import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RETRIES, nextRetryCount, RETRY_DELAY_MS, retryableSkip } from "../server/retry.ts";

describe("retry policy", () => {
  it("retries running-tool and not-idle skips after the short delay", () => {
    assert.equal(RETRY_DELAY_MS, 120_000);
    assert.equal(retryableSkip("running-tool"), true);
    assert.equal(retryableSkip("not-idle"), true);
    assert.equal(nextRetryCount("running-tool", 0), 1);
    assert.equal(nextRetryCount("not-idle", 2), 3);
    assert.equal(nextRetryCount("context-below-threshold(60000)", 0), null);
  });

  it("stops after the retry cap", () => {
    assert.equal(MAX_RETRIES, 3);
    assert.equal(nextRetryCount("running-tool", MAX_RETRIES), null);
    assert.equal(nextRetryCount("not-idle", MAX_RETRIES), null);
  });
});

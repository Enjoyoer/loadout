import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RETRIES, nextRetryCount, retryableSkip } from "../server/retry.ts";

describe("retry policy", () => {
  it("keeps unknown context terminal under both old and new reason strings", () => {
    for (const reason of ["context-below-threshold(unknown)", "context-unknown"]) {
      assert.equal(retryableSkip(reason), false);
      assert.equal(nextRetryCount(reason, 0), null);
      assert.equal(nextRetryCount(reason, MAX_RETRIES), null);
    }
  });
});

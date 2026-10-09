import assert from "node:assert/strict";
import { it } from "node:test";
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { compactionResult } from "../server/compaction.ts";

function timeline(items: Record<string, unknown>[]): PaseoAgentTimelineHandle {
  return { refetch: async () => ({ entries: items.map((item, seqEnd) => ({ item, seqEnd })), error: null }) } as unknown as PaseoAgentTimelineHandle;
}
it("requires a new completed row, not an old row or a send acknowledgement", async () => {
  await compactionResult(timeline([{ type: "compaction", status: "completed" }]), -1, new AbortController().signal, 0);
  assert.equal(await compactionResult(timeline([{ type: "compaction", status: "completed" }]), 0, new AbortController().signal, 0, 0), "unconfirmed");
});
it("rejects native Pi synthetic completed rows followed by errors and Claude cancellations", async () => {
  for (const text of ["[Error] Failed to compact context: Server is temporarily limiting requests", "Error during compaction: API Error", "Compaction canceled."]) {
    await assert.rejects(compactionResult(timeline([{ type: "compaction", status: "completed" }, { type: "assistant_message", text }]), -1, new AbortController().signal, 0), /failed or canceled/);
  }
});
it("fails closed on canceled observation", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(compactionResult(timeline([]), -1, controller.signal, 0), /canceled/);
});

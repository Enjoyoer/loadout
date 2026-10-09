import type { PaseoAgentTimelineHandle } from "@getpaseo/client";

export type CompactionObservation = "completed" | "unconfirmed";

/**
 * A send acknowledgement is not a summary. Require a new terminal compaction row.
 * Error output rejects. A window that ends with neither a completed row nor an error
 * gets one more look, then resolves "unconfirmed": a slow summary is not a failure.
 */
export async function compactionResult(timeline: PaseoAgentTimelineHandle, afterSeq: number, signal: AbortSignal,
  timeoutMs: number, pollMs = 1_000): Promise<CompactionObservation> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    if (await completedRow(timeline, afterSeq)) return "completed";
    if (Date.now() >= deadline) {
      await pause(pollMs, signal);
      if (signal.aborted) break;
      return await completedRow(timeline, afterSeq) ? "completed" : "unconfirmed";
    }
    await pause(pollMs, signal);
  }
  throw new Error("Compaction observation canceled");
}

async function completedRow(timeline: PaseoAgentTimelineHandle, afterSeq: number): Promise<boolean> {
  const page = await timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
  if (page.error || page.gap || page.staleCursor) throw new Error("Compaction result unavailable");
  const fresh = page.entries.filter(entry => entry.seqEnd > afterSeq);
  if (fresh.some(({ item }) => item.type === "assistant_message" &&
    /failed to compact|error during compaction|compaction cancel(?:ed|led)|\[System Error\]/i.test(item.text))) {
    throw new Error("Compaction failed or canceled");
  }
  const row = fresh.findLast(entry => entry.item.type === "compaction");
  return row?.item.type === "compaction" && row.item.status === "completed";
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

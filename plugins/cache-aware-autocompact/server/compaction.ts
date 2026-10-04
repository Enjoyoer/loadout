import type { PaseoAgentTimelineHandle } from "@getpaseo/client";

/** A send acknowledgement is not a summary. Require a new terminal compaction row. */
export async function compactionResult(timeline: PaseoAgentTimelineHandle, afterSeq: number, signal: AbortSignal,
  timeoutMs = 300_000, pollMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    const page = await timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
    if (page.error || page.gap || page.staleCursor) throw new Error("Compaction result unavailable");
    const fresh = page.entries.filter(entry => entry.seqEnd > afterSeq);
    if (fresh.some(({ item }) => item.type === "assistant_message" &&
      /failed to compact|error during compaction|compaction cancel(?:ed|led)|\[System Error\]/i.test(item.text))) {
      throw new Error("Compaction failed or canceled");
    }
    const row = fresh.findLast(entry => entry.item.type === "compaction");
    if (row?.item.type === "compaction") {
      if (row.item.status === "completed") return;

    }
    if (Date.now() >= deadline) throw new Error("Compaction result unconfirmed; automatic retry suppressed");
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, pollMs);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  throw new Error("Compaction observation canceled");
}

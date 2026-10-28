import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { paseoHome } from "./vendor/daemon-target.ts";
import { probe } from "./vendor/fs-probe.ts";

// Paseo's message delivery receipts, read-only: <PASEO_HOME>/agent-requests/<sha256>.json holding
// {fingerprint, agentId, state}. On 0.11.1 and 0.13.0 (identical code) the daemon writes one for
// every send_agent_message_request that carries a messageId, which the CLI and the app always set:
// first `pending`, then, once the message was handed to the agent, rewritten (atomically) as
// `completed`. So a receipt's modification time is when the message was delivered. Messages from
// other agents count here even though they do not set the agent's lastUserMessageAt. Sends made
// through Paseo's MCP tools write no receipt.

/** Newest delivery time (ms) per agent id, from receipts modified at or after `sinceMs`. */
export interface DeliveryReader {
  newestDeliveries(sinceMs: number): Promise<Map<string, number>>;
}

const BATCH = 64;

export class ReceiptReader implements DeliveryReader {
  readonly directory: string;

  constructor(directory = path.join(paseoHome(), "agent-requests")) {
    this.directory = directory;
  }

  /**
   * Any error, a missing directory included, is thrown, and the caller then counts archive times
   * instead (newer, so never staler than the truth). Only a receipt that disappears between the
   * listing and its read is passed over. A `pending` receipt counts too: its message may have
   * reached the agent.
   */
  async newestDeliveries(sinceMs: number): Promise<Map<string, number>> {
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
    const newest = new Map<string, number>();
    for (let start = 0; start < names.length; start += BATCH) {
      await Promise.all(
        names.slice(start, start + BATCH).map(async (name) => {
          const file = path.join(this.directory, name);
          const info = await probe(file, { follow: true });
          if (!info || !info.isFile() || info.mtimeMs < sinceMs) return;
          let raw: string;
          try {
            raw = await readFile(file, "utf8");
          } catch (error) {
            if ((await probe(file, { follow: true })) === null) return;
            throw error;
          }
          let receipt: { agentId?: unknown; state?: unknown };
          try {
            receipt = JSON.parse(raw) as { agentId?: unknown; state?: unknown };
          } catch {
            throw new Error(`malformed receipt ${name}`);
          }
          if (typeof receipt?.agentId !== "string" || (receipt.state !== "completed" && receipt.state !== "pending")) {
            throw new Error(`unexpected receipt ${name}`);
          }
          const at = info.mtimeMs;
          if ((newest.get(receipt.agentId) ?? -Infinity) < at) newest.set(receipt.agentId, at);
        }),
      );
    }
    return newest;
  }
}

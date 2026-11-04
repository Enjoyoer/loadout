// What a daemon reload or restart would load for an agent: its stored record under <PASEO_HOME>/agents. Paseo 0.10.3
// and 0.11.1 keep one JSON file per agent in a project directory (older homes also at the top level), with the agent's
// model and thinking option under config and its labels at the top. Settings acknowledged in memory can still fail to
// reach this file, so a return is confirmed here, never on the in-memory snapshot alone.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isAbsent } from "./vendor/fs-probe.ts";
import { paseoHome } from "./vendor/daemon-target.ts";
import type { Profile } from "./fallback.ts";

export type StoredProfiles = Profile[];

type StoredAgent = { id?: unknown; config?: { model?: unknown; thinkingOptionId?: unknown } | null; labels?: Record<string, unknown> | null; lastUserMessageAt?: unknown };

async function list(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
}

async function readRecord(file: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
  return JSON.parse(text);
}

/** Every stored copy of the agent's record; empty when none exists. An unreadable or unparseable record throws. */
async function storedRecords(agentId: string, home: string): Promise<StoredAgent[]> {
  if (!/^[A-Za-z0-9._-]+$/.test(agentId)) throw new Error(`unexpected agent id ${JSON.stringify(agentId)}`);
  const base = path.join(home, "agents");
  const files = [path.join(base, `${agentId}.json`)];
  for (const entry of await list(base)) if (entry.isDirectory()) files.push(path.join(base, entry.name, `${agentId}.json`));
  const records: StoredAgent[] = [];
  for (const file of files) {
    const record = await readRecord(file) as StoredAgent | null;
    if (!record) continue;
    if (record.id !== agentId) throw new Error(`stored record ${file} names another agent`);
    records.push(record);
  }
  return records;
}

/**
 * Every stored copy of the agent's profile; empty when no record exists. An unreadable or unparseable record throws,
 * so nothing is confirmed from it.
 */
export async function readStoredProfiles(agentId: string, home = paseoHome()): Promise<StoredProfiles> {
  return (await storedRecords(agentId, home)).map((record) => {
    const model = record.config?.model;
    const thinking = record.config?.thinkingOptionId;
    const tier = record.labels?.["opc.service-tier"];
    return {
      model: typeof model === "string" ? model : "",
      thinkingOptionId: typeof thinking === "string" ? thinking : null,
      serviceTier: typeof tier === "string" && tier.trim() ? tier.trim() : null,
    };
  });
}

/**
 * The agent's latest user message time in its stored record, which an agent fetch reports after a daemon restart. Null
 * when no record exists or it has none. An unreadable record, or copies that disagree, throw.
 */
export async function readStoredUserMessageAt(agentId: string, home = paseoHome()): Promise<string | null> {
  const values = new Set((await storedRecords(agentId, home)).map((record) => typeof record.lastUserMessageAt === "string" ? record.lastUserMessageAt : null));
  if (values.size > 1) throw new Error(`stored records of ${agentId} disagree on lastUserMessageAt`);
  return [...values][0] ?? null;
}

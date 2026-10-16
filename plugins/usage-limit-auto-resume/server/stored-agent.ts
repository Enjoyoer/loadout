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

/**
 * Every stored copy of the agent's profile; empty when no record exists. An unreadable or unparseable record throws,
 * so nothing is confirmed from it.
 */
export async function readStoredProfiles(agentId: string, home = paseoHome()): Promise<StoredProfiles> {
  if (!/^[A-Za-z0-9._-]+$/.test(agentId)) throw new Error(`unexpected agent id ${JSON.stringify(agentId)}`);
  const base = path.join(home, "agents");
  const files = [path.join(base, `${agentId}.json`)];
  for (const entry of await list(base)) if (entry.isDirectory()) files.push(path.join(base, entry.name, `${agentId}.json`));
  const profiles: StoredProfiles = [];
  for (const file of files) {
    const record = await readRecord(file) as { id?: unknown; config?: { model?: unknown; thinkingOptionId?: unknown } | null; labels?: Record<string, unknown> | null } | null;
    if (!record) continue;
    if (record.id !== agentId) throw new Error(`stored record ${file} names another agent`);
    const model = record.config?.model;
    const thinking = record.config?.thinkingOptionId;
    const tier = record.labels?.["opc.service-tier"];
    profiles.push({
      model: typeof model === "string" ? model : "",
      thinkingOptionId: typeof thinking === "string" ? thinking : null,
      serviceTier: typeof tier === "string" && tier.trim() ? tier.trim() : null,
    });
  }
  return profiles;
}

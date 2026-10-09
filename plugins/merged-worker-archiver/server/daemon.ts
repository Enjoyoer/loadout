import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { resolveDaemonTarget } from "./vendor/daemon-target.ts";

export { resolveDaemonTarget, type DaemonTarget } from "./vendor/daemon-target.ts";

export async function openDaemonClient(env: NodeJS.ProcessEnv = process.env): Promise<PaseoClient> {
  const target = resolveDaemonTarget(env);
  const client = createPaseoClient({
    url: target.url,
    clientId: `cid_plugin_merged_worker_archiver_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    appVersion: "0.9.2",
    reconnect: { enabled: false },
    suppressSendErrors: true,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`cannot connect to Paseo daemon at ${target.url} (${target.source}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return client;
}

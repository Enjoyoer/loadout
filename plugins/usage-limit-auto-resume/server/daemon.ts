import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { resolveDaemonTarget as resolveSharedDaemonTarget } from "./vendor/daemon-target.ts";

/** The shared fail-closed resolver, reduced to the bare WebSocket URL this plugin has always returned. */
export function resolveDaemonTarget(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSharedDaemonTarget(env).url;
}

export async function openDaemonClient(env: NodeJS.ProcessEnv = process.env): Promise<PaseoClient> {
  const target = resolveDaemonTarget(env);
  const client = createPaseoClient({
    url: target,
    clientId: `cid_plugin_usage_limit_auto_resume_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    appVersion: "0.9.2",
    reconnect: { enabled: false },
    suppressSendErrors: true,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`cannot connect to Paseo daemon at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return client;
}

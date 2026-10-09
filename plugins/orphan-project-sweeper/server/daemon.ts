import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveDaemonTarget } from "./vendor/daemon-target.ts";

// The PluginServerContext passed to contribute() carries no Paseo SDK handle; the
// hook-supplied `paseo` (PaseoApi) only exists inside hook and RPC callbacks, and it
// exposes projects.list()/subscribe() but no project delete. The startup sweep runs
// with no hook in flight, so this plugin opens its own short-lived local daemon
// connection, exactly the way the Paseo CLI does, and uses the typed
// DaemonClient.removeProject() that `paseo project delete` itself calls.

export { resolveDaemonTarget, type DaemonTarget } from "./vendor/daemon-target.ts";

const CONNECT_TIMEOUT_MS = 10_000;
const clientId = `cid_plugin_orphan_sweeper_${randomUUID().replace(/-/g, "")}`;

/** Open a connection, run `fn`, and always close the connection afterwards. */
export async function withDaemon<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
  const target = resolveDaemonTarget();
  const client = new DaemonClient({
    url: target.url,
    clientId,
    clientType: "cli",
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    reconnect: { enabled: false },
    suppressSendErrors: true,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot connect to Paseo daemon at ${target.url} (${target.source}): ${message}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export type { DaemonClient };

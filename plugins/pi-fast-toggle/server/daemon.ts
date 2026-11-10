import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveDaemonTarget } from "./vendor/daemon-target";

// Each write opens its own short-lived connection to the plugin's daemon through the typed
// DaemonClient (an internal export of @getpaseo/client, pinned exactly in package.json).
export async function withDaemon<T>(use: (client: DaemonClient) => Promise<T>): Promise<T> {
  const client = new DaemonClient({
    url: resolveDaemonTarget().url,
    clientId: `cid_plugin_pi_fast_toggle_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    clientType: "cli",
    appVersion: "0.2.0",
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
    suppressSendErrors: true,
  });
  try {
    await client.connect();
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

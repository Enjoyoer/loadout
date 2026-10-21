import type { PaseoClient } from "@getpaseo/client";
import { resolveDaemonTarget } from "./vendor/daemon-target.ts";

export { resolveDaemonTarget, type DaemonTarget } from "./vendor/daemon-target.ts";

type ClientModule = typeof import("@getpaseo/client");

/**
 * The plugin process already runs the host's @getpaseo/client for the hook API. A require the
 * bundler cannot resolve goes to the host's module loader and returns that loaded module, so the
 * second copy bundled with this plugin (its generated message validator alone is over 8 MB of
 * code) is never evaluated. Outside a plugin process, or if that load fails, the bundled copy is
 * loaded on demand.
 */
async function clientModule(): Promise<ClientModule> {
  try {
    const host = typeof require === "function" ? require(["@getpaseo", "client"].join("/")) as Partial<ClientModule> : null;
    if (typeof host?.createPaseoClient === "function") return host as ClientModule;
  } catch {
    // The bundled copy below.
  }
  return await import("@getpaseo/client");
}

export async function openDaemonClient(env: NodeJS.ProcessEnv = process.env): Promise<PaseoClient> {
  const target = resolveDaemonTarget(env);
  const { createPaseoClient } = await clientModule();
  const client = createPaseoClient({
    url: target.url,
    clientId: `cid_plugin_cache_aware_autocompact_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    connectTimeoutMs: 10_000,
    appVersion: "0.9.2",
    reconnect: { enabled: true },
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

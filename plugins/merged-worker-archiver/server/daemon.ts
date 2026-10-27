import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ArchiverApi } from "./sweeper.ts";
import type { TerminalView } from "./types.ts";
import { resolveDaemonTarget } from "./vendor/daemon-target.ts";

export { resolveDaemonTarget, type DaemonTarget } from "./vendor/daemon-target.ts";

// Every sweep opens its own short-lived connection, as the Paseo CLI does, through the typed
// DaemonClient (an internal export of @getpaseo/client, pinned exactly in package.json). It is the
// only client surface that tells whether the daemon has background workspaces
// (supportsBackgroundWorkspaces(), from the server info the daemon sends before connect() resolves);
// the hook-supplied PaseoApi cannot, so sweeps no longer reuse it.

const CONNECT_TIMEOUT_MS = 10_000;

export interface DaemonConnection {
  api: ArchiverApi;
  close(): Promise<void>;
}

export async function openDaemonClient(env: NodeJS.ProcessEnv = process.env): Promise<DaemonConnection> {
  const target = resolveDaemonTarget(env);
  const client = new DaemonClient({
    url: target.url,
    clientId: `cid_plugin_merged_worker_archiver_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    clientType: "cli",
    appVersion: "0.9.2",
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    reconnect: { enabled: false },
    suppressSendErrors: true,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`cannot connect to Paseo daemon at ${target.url} (${target.source}): ${error instanceof Error ? error.message : String(error)}`);
  }
  // The daemon payloads are wider than the views the plugin reads; only the listed fields are used.
  const api: ArchiverApi = {
    workspaces: {
      list: async (options) => (await client.fetchWorkspaces(options)) as unknown as Awaited<ReturnType<ArchiverApi["workspaces"]["list"]>>,
      archive: (workspaceId) => client.archiveWorkspace(workspaceId),
    },
    agents: {
      list: async (options) => (await client.fetchAgents(options)) as unknown as Awaited<ReturnType<ArchiverApi["agents"]["list"]>>,
    },
    projects: {
      list: () => client.listProjects(),
    },
    terminals: {
      list: async () => {
        const result = await client.listTerminals();
        return { entries: result.terminals as ReadonlyArray<TerminalView> };
      },
    },
    supportsBackgroundWorkspaces: () => client.supportsBackgroundWorkspaces(),
    sendAgentMessage: (agentId, text, options) => client.sendAgentMessage(agentId, text, options),
  };
  return { api, close: () => client.close() };
}


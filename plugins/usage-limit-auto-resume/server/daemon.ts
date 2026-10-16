import { createPaseoApi, type PaseoClient } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveDaemonTarget as resolveSharedDaemonTarget } from "./vendor/daemon-target.ts";

/** The shared fail-closed resolver, reduced to the bare WebSocket URL this plugin has always returned. */
export function resolveDaemonTarget(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSharedDaemonTarget(env).url;
}

/**
 * Per-agent settings the PM fallback writes. The public SDK handle has no setter for them, so they go through the
 * same daemon client the SDK wraps: one agent.config.apply carrying model and thinking, and a label update.
 */
export type AgentSettingsPort = {
  apply(agentId: string, config: { modelId: string; thinkingOptionId: string | null }): Promise<unknown>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
};

export type DaemonHandle = PaseoClient & { agentSettings: AgentSettingsPort };

// The same construction as createPaseoClient, keeping the underlying client for agentSettings.
export async function openDaemonClient(env: NodeJS.ProcessEnv = process.env): Promise<DaemonHandle> {
  const target = resolveDaemonTarget(env);
  const daemon = new DaemonClient({
    url: target,
    clientId: `cid_plugin_usage_limit_auto_resume_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    clientType: "cli",
    appVersion: "0.9.2",
    reconnect: { enabled: false },
    suppressSendErrors: true,
  });
  const api = createPaseoApi(daemon);
  const client: DaemonHandle = {
    ...api,
    connect: () => daemon.connect(),
    close: async () => {
      try { await api.dispose(); } finally { await daemon.close(); }
    },
    ensureConnected: () => daemon.ensureConnected(),
    getConnectionState: () => daemon.getConnectionState(),
    agentSettings: {
      apply: (agentId, config) => daemon.applyAgentConfig(agentId, config),
      setLabels: (agentId, labels) => daemon.updateAgent(agentId, { labels }),
    },
  };
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`cannot connect to Paseo daemon at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return client;
}

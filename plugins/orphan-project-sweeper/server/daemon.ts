import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

// The PluginServerContext passed to contribute() carries no Paseo SDK handle; the
// hook-supplied `paseo` (PaseoApi) only exists inside hook and RPC callbacks, and it
// exposes projects.list()/subscribe() but no project delete. The startup sweep runs
// with no hook in flight, so this plugin opens its own short-lived local daemon
// connection, exactly the way the Paseo CLI does, and uses the typed
// DaemonClient.removeProject() that `paseo project delete` itself calls.

export interface DaemonTarget {
  url: string;
  source: "PASEO_HOST" | "paseo.pid" | "default";
}

const DEFAULT_LISTEN = "127.0.0.1:6767";
const HOST_PORT = /^[A-Za-z0-9.\-[\]]+:\d+$/;

function hostPortToUrl(hostPort: string): string {
  const normalized = hostPort.replace(/^localhost:/, "127.0.0.1:");
  return `ws://${normalized}/ws`;
}

function paseoHome(): string {
  return process.env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
}

function readPidListen(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(paseoHome(), "paseo.pid"), "utf8")) as {
      listen?: unknown;
    };
    return typeof parsed.listen === "string" ? parsed.listen.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the local daemon WebSocket URL: PASEO_HOST, then the daemon's own
 * paseo.pid listen address, then the CLI default. Only TCP host:port targets are
 * supported; anything else (unix sockets, ssh, relay offers) falls back to the default.
 */
export function resolveDaemonTarget(env: NodeJS.ProcessEnv = process.env): DaemonTarget {
  const explicit = env.PASEO_HOST?.trim();
  if (explicit) {
    const stripped = explicit.replace(/^tcp:\/\//, "").replace(/\?.*$/, "");
    if (HOST_PORT.test(stripped)) return { url: hostPortToUrl(stripped), source: "PASEO_HOST" };
  }
  const pidListen = readPidListen();
  if (pidListen && HOST_PORT.test(pidListen)) {
    return { url: hostPortToUrl(pidListen), source: "paseo.pid" };
  }
  return { url: hostPortToUrl(DEFAULT_LISTEN), source: "default" };
}

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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import type { ArchiverApi } from "./sweeper.ts";

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

function paseoHome(env: NodeJS.ProcessEnv): string {
  return env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
}

function readPidListen(env: NodeJS.ProcessEnv): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(paseoHome(env), "paseo.pid"), "utf8")) as { listen?: unknown };
    return typeof parsed.listen === "string" ? parsed.listen.trim() : null;
  } catch {
    return null;
  }
}

export function resolveDaemonTarget(env: NodeJS.ProcessEnv = process.env): DaemonTarget {
  const explicit = env.PASEO_HOST?.trim();
  if (explicit) {
    const stripped = explicit.replace(/^tcp:\/\//, "").replace(/\?.*$/, "");
    if (HOST_PORT.test(stripped)) return { url: hostPortToUrl(stripped), source: "PASEO_HOST" };
  }
  const pidListen = readPidListen(env);
  if (pidListen && HOST_PORT.test(pidListen)) return { url: hostPortToUrl(pidListen), source: "paseo.pid" };
  return { url: hostPortToUrl(DEFAULT_LISTEN), source: "default" };
}

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

export function asArchiverApi(client: PaseoClient): ArchiverApi {
  return client as unknown as ArchiverApi;
}

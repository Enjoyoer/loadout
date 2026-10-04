import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

const DEFAULT_LISTEN = "127.0.0.1:6767";
const HOST_PORT = /^[A-Za-z0-9.\-[\]]+:\d+$/;

function paseoHome(env: NodeJS.ProcessEnv): string {
  return env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
}

function hostPortToUrl(hostPort: string): string {
  return `ws://${hostPort.replace(/^localhost:/, "127.0.0.1:")}/ws`;
}

export function resolveDaemonTarget(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PASEO_HOST?.trim();
  if (explicit) {
    const stripped = explicit.replace(/^tcp:\/\//, "").replace(/\?.*$/, "");
    if (HOST_PORT.test(stripped)) return hostPortToUrl(stripped);
    throw new Error("Invalid PASEO_HOST: expected a TCP host:port endpoint; refusing fallback");
  }
  try {
    const parsed = JSON.parse(readFileSync(path.join(paseoHome(env), "paseo.pid"), "utf8")) as { listen?: unknown };
    if (typeof parsed.listen === "string" && HOST_PORT.test(parsed.listen.trim())) return hostPortToUrl(parsed.listen.trim());
  } catch {
  }
  if (path.resolve(paseoHome(env)) !== path.resolve(homedir(), ".paseo")) {
    throw new Error(`No valid daemon endpoint metadata in ${paseoHome(env)}/paseo.pid; set PASEO_HOST explicitly. Refusing default-daemon fallback for non-default PASEO_HOME`);
  }
  return hostPortToUrl(DEFAULT_LISTEN);
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

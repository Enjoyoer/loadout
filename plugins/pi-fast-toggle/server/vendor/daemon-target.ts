// Canonical Paseo daemon endpoint resolver for the Loadout plugins.
//
// Every plugin is staged and installed on its own, so none can import this file at
// runtime. Each one carries a byte-identical copy in server/vendor/daemon-target.ts.
// Edit plugins/_shared/daemon-target.ts only, copy it over every vendored copy, and
// run python3 scripts/check_vendored.py, which CI also runs.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

/**
 * Resolve the local daemon WebSocket URL: PASEO_HOST, then the daemon's own
 * paseo.pid listen address, then the CLI default for the default home only.
 * Unsupported explicit endpoints and non-default homes without metadata fail closed.
 */
export function resolveDaemonTarget(env: NodeJS.ProcessEnv = process.env): DaemonTarget {
  const explicit = env.PASEO_HOST?.trim();
  if (explicit) {
    const stripped = explicit.replace(/^tcp:\/\//, "").replace(/\?.*$/, "");
    if (HOST_PORT.test(stripped)) return { url: hostPortToUrl(stripped), source: "PASEO_HOST" };
    throw new Error("Invalid PASEO_HOST: expected a TCP host:port endpoint; refusing fallback");
  }
  const pidListen = readPidListen(env);
  if (pidListen && HOST_PORT.test(pidListen)) return { url: hostPortToUrl(pidListen), source: "paseo.pid" };
  if (path.resolve(paseoHome(env)) !== path.resolve(homedir(), ".paseo")) {
    throw new Error(`No valid daemon endpoint metadata in ${paseoHome(env)}/paseo.pid; set PASEO_HOST explicitly. Refusing default-daemon fallback for non-default PASEO_HOME`);
  }
  return { url: hostPortToUrl(DEFAULT_LISTEN), source: "default" };
}

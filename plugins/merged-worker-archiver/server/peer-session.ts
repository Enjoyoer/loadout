import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createSshTunnel, parseHostTarget } from "@getpaseo/client/node";
import type { PeerConnector, PeerSession } from "./peers.ts";
import type { AgentView } from "./types.ts";

// A peer daemon is reached as the paseo CLI reaches an `ssh://<alias>` host: its daemon port (6767) on the remote
// side's loopback, over the `ssh` on this daemon's PATH with BatchMode, then the plugin's own pinned DaemonClient.
// So neither the paseo CLI on PATH nor its version matters.
//
// - POSIX: Paseo's own stdio tunnel (createSshTunnel, `ssh -W`), which lives exactly as long as its connection.
// - Windows: Win32-OpenSSH (10.0p2 and the inbox 9.5p2) never answers `ssh -W` when its stdin or stdout is a pipe,
//   as a Node child's is; files work, pipes do not. There the tunnel is a port forward, `ssh -N -L
//   127.0.0.1:<free port>:127.0.0.1:<daemon port> <alias>` with no stdio, run under a small Node watchdog (this
//   daemon's own node, process.execPath, no shell). The watchdog ends ssh when the plugin closes the session, when
//   the plugin process goes away (its stdin closes), or when the pass's lifetime ends, so no forward outlives it.

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const CONNECT_CHECK_MS = 100;

interface Tunnel {
  endpoint: string;
  /** What went wrong on the ssh side, when known. */
  failureDetail(): string | null;
  close(): void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A loopback port that was free a moment ago. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free loopback port"))));
    });
  });
}

// Runs as `node -e WATCHDOG <port> <lifetimeMs> <ssh args JSON>`. Prints "ready" once the forward accepts
// connections and passes ssh's stderr through. Win32-OpenSSH can print a fatal error (an unknown host, a refused
// key) and then not exit, so such a line ends it too. On any end it stops ssh and exits.
const WATCHDOG = `
const { spawn } = require("node:child_process");
const net = require("node:net");
const [port, lifetimeMs, argsJson] = process.argv.slice(1);
const ssh = spawn("ssh", JSON.parse(argsJson), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let stderr = "";
let done = false;
const FATAL = /^ssh: |Permission denied|Host key verification failed|Could not request local forwarding/m;
ssh.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  stderr = (stderr + chunk).slice(-4000);
  if (FATAL.test(stderr)) finish(3, "");
});
const finish = (code, text) => {
  if (done) return;
  done = true;
  try { ssh.kill(); } catch {}
  if (text) process.stderr.write(text);
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
};
ssh.on("error", (error) => finish(2, error.code === "ENOENT" ? "ssh not found on this daemon's PATH" : "ssh did not start: " + error.message));
ssh.on("exit", (code, signal) => finish(3, stderr.trim() ? "" : "ssh exited with " + (signal || "code " + code)));
process.stdin.on("end", () => finish(0));
process.stdin.on("close", () => finish(0));
process.stdin.resume();
setTimeout(() => finish(4, "tunnel lifetime reached"), Number(lifetimeMs)).unref();
const check = () => {
  if (done) return;
  const socket = net.connect(Number(port), "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); if (!done) process.stdout.write("ready\\n"); });
  socket.once("error", () => { socket.destroy(); setTimeout(check, ${CONNECT_CHECK_MS}); });
};
check();
`;

/** Windows: `ssh -N -L` under the watchdog. Resolves once the forward accepts connections. */
async function forwardTunnel(target: { host: string; sshPort?: number; daemonPort: number }, timeoutMs: number, lifetimeMs: number): Promise<Tunnel> {
  const port = await freeLoopbackPort();
  const args = [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes",
    ...(target.sshPort !== undefined ? ["-p", String(target.sshPort)] : []),
    "-L", `127.0.0.1:${port}:127.0.0.1:${target.daemonPort}`,
    target.host,
  ];
  const watchdog = spawn(process.execPath, ["-e", WATCHDOG, String(port), String(lifetimeMs), JSON.stringify(args)], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  watchdog.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
  const close = () => {
    if (watchdog.exitCode === null && watchdog.signalCode === null) watchdog.stdin.end();
  };
  const lastLine = () => stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
  await new Promise<void>((resolve, reject) => {
    // Shorter than the caller's limit, so this message (with ssh's last words) is the one reported.
    const timer = setTimeout(() => {
      close();
      const said = lastLine();
      reject(new Error(`ssh forward not ready within ${Math.round(timeoutMs / 1000)} s${said ? `: ${said}` : ""}`));
    }, Math.max(1_000, timeoutMs - 500));
    watchdog.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("ready")) return;
      clearTimeout(timer);
      resolve();
    });
    watchdog.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`tunnel watchdog did not start: ${error.message}`));
    });
    watchdog.once("exit", () => {
      clearTimeout(timer);
      // Let the last stderr arrive before reporting it.
      setTimeout(() => reject(new Error(lastLine() ?? "ssh forward ended")), 50);
    });
  });
  return { endpoint: `127.0.0.1:${port}`, failureDetail: () => stderr.trim() || null, close };
}

/** Opens one session to a peer daemon. Fails closed with the ssh or daemon error. */
export const openPeerSession: PeerConnector = async (host, timeoutMs, lifetimeMs) => {
  const target = parseHostTarget(host);
  if (target.kind !== "ssh") throw new Error(`not an ssh:// host: ${host}`);
  const tunnel: Tunnel = process.platform === "win32" ? await forwardTunnel(target.ssh, timeoutMs, lifetimeMs) : await createSshTunnel(target.ssh);
  const client = new DaemonClient({
    url: `ws://${tunnel.endpoint}/ws`,
    clientId: `cid_plugin_merged_worker_archiver_peer_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    clientType: "cli",
    appVersion: "0.9.2",
    connectTimeoutMs: timeoutMs,
    reconnect: { enabled: false },
    suppressSendErrors: true,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    // ssh reports its failure when it exits, a moment after the connection drops.
    for (let waited = 0; waited < 1_000 && !tunnel.failureDetail(); waited += 50) await delay(50);
    const detail = tunnel.failureDetail();
    tunnel.close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(detail ? `${detail.split("\n").filter(Boolean).at(-1)} (${reason})` : reason);
  }
  const session: PeerSession = {
    async listAgents(ms) {
      const live: AgentView[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = (await client.fetchAgents({ page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, timeout: ms })) as unknown as {
          entries: Array<{ agent: AgentView }>;
          pageInfo: { nextCursor: string | null; hasMore: boolean };
        };
        for (const { agent } of result.entries) if (!agent.archivedAt) live.push(agent);
        if (!result.pageInfo.hasMore) return live;
        if (!result.pageInfo.nextCursor) throw new Error("agents pagination reported more pages without a cursor");
        cursor = result.pageInfo.nextCursor;
      }
      throw new Error(`agents exceeded ${MAX_PAGES} pages`);
    },
    async getAgent(agentId, ms) {
      const result = await client.fetchAgent({ agentId, timeout: ms });
      return (result?.agent ?? null) as unknown as AgentView | null;
    },
    async send(agentId, text, messageId) {
      await client.sendAgentMessage(agentId, text, { messageId, activeTurnBehavior: "steer" });
    },
    async close() {
      await client.close().catch(() => undefined);
      tunnel.close();
    },
  };
  return session;
};

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { ConfigSchema } from "../server/config.ts";
import { buildRecord, type AgentSnapshot } from "../server/model.ts";
import { ResumeStore } from "../server/store.ts";

const agent: AgentSnapshot = {
  id: "agent-1",
  workspaceId: "workspace-1",
  provider: "claude",
  model: "claude-opus-5-5[1m]",
  currentModeId: "bypassPermissions",
  thinkingOptionId: "low",
  cwd: "/repo",
  status: "idle",
  persistence: { provider: "claude", sessionId: "session-1", nativeHandle: "native-1" },
};

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "condition not reached");
}

it("opens a fresh daemon client on the sweep after the cached client's transport died", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-sweep-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  console.log = () => undefined;
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const config = ConfigSchema.parse({ armed: true, pollIntervalSeconds: 5 });
    // A five-hour usage record stays parked (not-due), so every sweep fetches the agent through the cached client.
    await new ResumeStore().upsert(buildRecord(agent, "out of credits", undefined, config, Date.now(), "turn-1")!);
    const clients: Array<{ status: string; closed: boolean; refreshes: number }> = [];
    const open = async () => {
      const state = { status: "connected", closed: false, refreshes: 0 };
      clients.push(state);
      return {
        getConnectionState: () => ({ status: state.status }),
        close: async () => { state.closed = true; },
        agents: { ref: () => ({ refresh: async () => {
          state.refreshes += 1;
          if (state.status !== "connected") throw new Error("Transport not connected");
          return { agent };
        } }) },
      } as unknown as PaseoClient;
    };
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r1", values: config }) }),
      on: () => () => undefined,
    } as unknown as PluginServerContext;
    const cleanup = contribute(server, open);
    await until(() => clients[0]?.refreshes === 1);
    await new Promise((resolve) => setImmediate(resolve));
    clients[0]!.status = "disconnected"; // the transport was disposed, as after liveness timeouts during sleep
    mock.timers.tick(5000);
    await until(() => clients[1]?.refreshes === 1);
    assert.equal(clients.length, 2);
    assert.equal(clients[0]!.closed, true);
    assert.equal(clients[0]!.refreshes, 1);
    (cleanup as () => void)();
  } finally {
    mock.timers.reset();
    console.log = originalLog;
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

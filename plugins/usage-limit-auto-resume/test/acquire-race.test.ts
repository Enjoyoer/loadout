// The reviewer's repro for the shared daemon client: the startup inspection and the first sweep both need a client
// before either connect resolves. They must share one open, and cleanup must leave no client open.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { ConfigSchema } from "../server/config.ts";
import { buildRecord, type AgentSnapshot } from "../server/model.ts";
import { ResumeStore } from "../server/store.ts";
import { QuotaReader } from "../server/quota.ts";

const agent: AgentSnapshot = {
  id: "agent-1", workspaceId: "workspace-1", provider: "claude", model: "claude-opus-5-5[1m]",
  currentModeId: "bypassPermissions", thinkingOptionId: "low", cwd: "/repo", status: "idle",
  persistence: { provider: "claude", sessionId: "session-1", nativeHandle: "native-1" },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("startup inspection and the first sweep share one daemon client, and cleanup closes it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-auto-resume-acquire-race-"));
  const previousHome = process.env.PASEO_HOME;
  const originalLog = console.log;
  process.env.PASEO_HOME = home;
  console.log = () => undefined;
  try {
    const config = ConfigSchema.parse({ armed: true, pollIntervalSeconds: 3600 });
    // A parked usage record: the first sweep fetches its agent through acquire().
    await new ResumeStore().upsert(buildRecord(agent, "out of credits", undefined, config, Date.now(), "turn-1")!);
    const clients: Array<{ id: number; closed: boolean }> = [];
    const open = async () => {
      const state = { id: clients.length + 1, closed: false };
      clients.push(state);
      await sleep(50); // A real connect takes a round trip.
      return {
        getConnectionState: () => ({ status: state.closed ? "disconnected" : "connected" }),
        close: async () => { state.closed = true; },
        config: { get: async () => ({ config: { idleRuntimeCleanup: false } }) },
        agents: { ref: () => ({ refresh: async () => ({ agent }) }) },
      } as unknown as PaseoClient;
    };
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r1", values: config }) }),
      on: () => () => undefined,
    } as unknown as PluginServerContext;
    const plugin = contribute(server, open, new QuotaReader(async () => ({ error: "off" })));
    await sleep(500);
    plugin();
    await plugin.idle();
    await sleep(50);
    assert.equal(clients.length, 1, "one shared client");
    assert.deepEqual(clients.filter((c) => !c.closed).map((c) => c.id), [], "no client left open after cleanup");
  } finally {
    console.log = originalLog;
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

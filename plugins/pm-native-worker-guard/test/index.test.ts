import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { defaultConfig, type GuardConfig } from "../server/config.ts";
import { CHILD_ID, PM_ID, child, created, fakeApi, pm, tempStatePath } from "./fakes.ts";

type Handler = (event: unknown, context: unknown) => unknown;

function fakeServer(values: GuardConfig) {
  const handlers = new Map<string, Handler>();
  const before: string[] = [];
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "r1", values }),
      subscribe: () => () => undefined,
    }),
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    before(name: string) {
      before.push(name);
      return () => undefined;
    },
    handle: () => undefined,
    registerProvider: () => undefined,
  };
  return { server: server as unknown as PluginServerContext, handlers, before };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "condition not reached");
}

it("subscribes to agent.created and agent.turn_ended only, with state under PASEO_HOME, and cleans up", async () => {
  const home = path.dirname(path.dirname(await tempStatePath()));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const { server, handlers, before } = fakeServer(defaultConfig({ armed: true }));
    const cleanup = contribute(server);
    assert.deepEqual([...handlers.keys()].sort(), ["agent.created", "agent.turn_ended"]);
    assert.deepEqual(before, []);

    const api = fakeApi([pm({ status: "running" }), child()]);
    const context = { paseo: api, signal: new AbortController().signal };
    assert.equal(handlers.get("agent.created")!({ agent: { ...created(), workspaceId: "w1", cwd: "/w", title: null } }, context), undefined);
    await until(() => api.rows.length === 1);
    assert.ok(api.calls.includes(`archive:${CHILD_ID}`));

    api.agentsById.get(PM_ID)!.status = "idle";
    handlers.get("agent.turn_ended")!({ agent: { id: PM_ID }, turnId: "t1", outcome: { kind: "completed" }, timeline: [] }, context);
    await until(() => api.sent.length === 1);

    await until(() => lines.some((line) => line.includes('"action":"started"')));
    const started = JSON.parse(lines.find((line) => line.includes('"action":"started"'))!.replace(/^\[pm-native-worker-guard\] /, ""));
    assert.equal(started.mode, "armed");
    assert.equal(started.statePath, path.join(home, "plugin-state", "pm-native-worker-guard", "state.json"));

    (cleanup as () => void)();
    assert.equal(handlers.size, 0);
  } finally {
    console.log = originalLog;
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  }
});

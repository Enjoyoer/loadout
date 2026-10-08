import { defineSettings } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type GuardConfig } from "./server/config.ts";
import { Guard, type GuardApi } from "./server/guard.ts";
import { errorMessage, PLUGIN_ID } from "./server/policy.ts";
import { defaultStatePath, StateStore } from "./server/store.ts";

// Server-only plugin. Owner rule: agents created by a PM run on the Pi provider. When a
// PM (parent labelled role=pm by default) creates a native Codex or Claude Code agent,
// the plugin archives it (the daemon cancels its run first) and tells the PM why.
// Dry-run unless settings.armed is true. Every uncertain read leaves the agent alone.
//
// Paseo 0.10.3 gives before("agent.create") no parent agent, so the check runs on
// agent.created: the agent exists and may begin its first turn before it is stopped.

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(
    defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }),
  );
  const log = (line: string) => console.log(line);

  const readConfig = async (): Promise<GuardConfig | null> => {
    try {
      const state = await settings.read();
      if (state.status === "ready") return state.values;
      log(`[${PLUGIN_ID}] ${JSON.stringify({ action: "config-invalid", reason: state.error, effect: "nothing runs; fix settings" })}`);
    } catch (error) {
      log(`[${PLUGIN_ID}] ${JSON.stringify({ action: "config-unreadable", reason: errorMessage(error) })}`);
    }
    return null;
  };

  const statePath = defaultStatePath();
  const guard = new Guard({ readConfig, store: new StateStore(statePath), log, now: () => new Date() });

  // Hooks start the work and return; the hook's PaseoApi lives as long as this subprocess.
  const removeCreated = server.on("agent.created", (event, context) => {
    const api: GuardApi = context.paseo;
    void guard.handleCreated(event.agent, api);
  });
  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    const api: GuardApi = context.paseo;
    void guard.handleTurnEnded(event.agent, api);
  });

  void readConfig().then((config) => {
    log(
      `[${PLUGIN_ID}] ${JSON.stringify({
        action: "started",
        mode: config ? (config.armed ? "armed" : "dry-run") : "config-invalid",
        config,
        statePath,
      })}`,
    );
  });

  return () => {
    guard.stop();
    removeCreated();
    removeTurnEnded();
  };
}

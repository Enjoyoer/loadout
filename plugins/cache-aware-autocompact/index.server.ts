import { defineSettings } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION } from "./server/config.ts";
import { startScheduler } from "./server/runtime.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(
    defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }),
  );
  return startScheduler(server, {
    async readConfig() {
      try {
        const state = await settings.read();
        if (state.status === "ready") return state.values;
        console.log(`[cache-aware-autocompact] ${JSON.stringify({ action: "config-invalid", reason: state.error })}`);
      } catch (error) {
        console.log(`[cache-aware-autocompact] ${JSON.stringify({ action: "config-unreadable", reason: String(error) })}`);
      }
      return null;
    },
  });
}

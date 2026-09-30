import { defineSettings } from "@getpaseo/plugin";
import { ConfigSchema, readConfig, SETTINGS_ID, SETTINGS_VERSION } from "./server/config.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { OrphanProjectSweeper } from "./server/sweeper.ts";

// Server-only plugin: no client entry, no surfaces. It deletes a Paseo project row
// only when BOTH hold at evaluation time: the project has zero active (non-archived)
// workspaces AND its root path no longer exists on disk. It never deletes repository
// files or git branches. Dry-run unless settings.armed is true.
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(
    defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }),
  );
  const log = (line: string) => console.log(line);
  const sweeper = new OrphanProjectSweeper({
    log,
    error: (line) => console.error(line),
  }, {
    async config() {
      try {
        const state = await settings.read();
        if (state.status === "ready") return readConfig(state.values, log);
        log(`[orphan-project-sweeper] config-invalid reason=${JSON.stringify(state.error)} fallback=dry-run`);
      } catch (error) {
        log(`[orphan-project-sweeper] config-unreadable reason=${JSON.stringify(error instanceof Error ? error.message : String(error))} fallback=dry-run`);
      }
      return readConfig();
    },
  });

  // Archive events can fire before worktree cleanup and are best effort, so the hook
  // only records the candidate; a module-scope timer re-checks live state later.
  // Hooks abort after 30s, so nothing here waits.
  const removeHook = server.on("workspace.archived", (event) => {
    sweeper.noteArchivedWorkspace(event.workspace);
  });

  sweeper.scheduleStartupSweep();

  return () => {
    removeHook();
    sweeper.stop();
  };
}

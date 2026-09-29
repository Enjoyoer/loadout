import type { PluginServerContext } from "@getpaseo/plugin/server";
import { OrphanProjectSweeper } from "./server/sweeper";

// Server-only plugin: no client entry, no surfaces. It deletes a Paseo project row
// only when BOTH hold at evaluation time: the project has zero active (non-archived)
// workspaces AND its root path no longer exists on disk. It never touches git or the
// filesystem; Paseo bookkeeping only.
export default function contribute(server: PluginServerContext) {
  const sweeper = new OrphanProjectSweeper({
    log: (line) => console.log(line),
    error: (line) => console.error(line),
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

import { defineSettings } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type ArchiverConfig } from "./server/config.ts";
import { openDaemonClient, resolveDaemonTarget } from "./server/daemon.ts";
import { createCommonDirResolver, nodeFileSystem, runCommand } from "./server/io.ts";
import { EventScheduler, realTimers } from "./server/scheduler.ts";
import { Sweeper, type ApiLease, type ArchiverApi } from "./server/sweeper.ts";

// Server-only plugin. Archives worktree workspaces (and, through Paseo's own workspace
// archive, their agents) once the worker branch is merged into its base. Dry-run unless
// settings.armed is true. Every gate fails closed; see README.md.
//
// Triggers: every agent.turn_ended (any agent, PMs included) evaluates the worktrees of
// that agent's project and repository within seconds; a slow periodic sweep is only a
// backstop for merges made outside Paseo.

const STARTUP_DELAY_MS = 30_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(
    defineSettings({ id: SETTINGS_ID, scope: "host", version: SETTINGS_VERSION, schema: ConfigSchema }),
  );
  const log = (line: string) => console.log(line);

  // The subprocess-wide PaseoApi handed to hooks lives as long as this subprocess
  // (documented), so once any hook fires sweeps reuse it instead of a socket.
  let hookApi: PaseoApi | null = null;

  const acquireApi = async (): Promise<ApiLease> => {
    if (hookApi) return { api: hookApi satisfies ArchiverApi, release: async () => undefined };
    const client = await openDaemonClient();
    return { api: client satisfies ArchiverApi, release: () => client.close() };
  };

  let lastTimeoutMs = 15_000;
  const sweeper = new Sweeper({
    acquireApi,
    log,
    fs: nodeFileSystem,
    merge: { run: runCommand, fs: nodeFileSystem },
    resolveCommonDir: createCommonDirResolver(runCommand, () => lastTimeoutMs),
    now: () => Date.now(),
  });

  const loadConfig = async (): Promise<ArchiverConfig | null> => {
    try {
      const state = await settings.read();
      if (state.status === "ready") {
        lastTimeoutMs = state.values.commandTimeoutSeconds * 1000;
        return state.values;
      }
      log(`[merged-worker-archiver] config-invalid reason=${JSON.stringify(state.error)} (nothing runs; fix settings)`);
    } catch (error) {
      log(`[merged-worker-archiver] config-unreadable reason=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    }
    return null;
  };

  let stopped = false;
  let sweepTimer: NodeJS.Timeout | null = null;

  const scheduler = new EventScheduler({
    timers: realTimers,
    log,
    async settings() {
      const config = await loadConfig();
      if (!config) return null;
      return {
        debounceMs: config.eventDebounceSeconds * 1000,
        followUpDelaysMs: config.followUpDelaysSeconds.map((seconds) => seconds * 1000),
      };
    },
    async run(scope) {
      const config = await loadConfig();
      if (!config || stopped) return null;
      return sweeper.sweep(config, { trigger: scope.label, triggerWorkspaceIds: scope.triggerWorkspaceIds, eventAt: scope.eventAt });
    },
  });

  const runFullSweep = async (trigger: string) => {
    if (stopped) return;
    const config = await loadConfig();
    if (!config || stopped) return;
    await sweeper.sweep(config, { trigger });
  };

  const scheduleNextSweep = async (delayMs?: number) => {
    if (stopped) return;
    const config = await loadConfig();
    const intervalMs = (config?.sweepIntervalMinutes ?? 60) * 60_000;
    sweepTimer = setTimeout(() => {
      void runFullSweep(delayMs === undefined ? "interval" : "startup")
        .catch((error) => console.error("[merged-worker-archiver] sweep failed", error))
        .finally(() => void scheduleNextSweep());
    }, delayMs ?? intervalMs);
    sweepTimer.unref?.();
  };

  // Record and return: hooks abort after 30 s, so the evaluation runs later, coalesced.
  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    hookApi = context.paseo;
    const workspaceId = event.agent.workspaceId;
    if (!workspaceId || stopped) return;
    log(
      `[merged-worker-archiver] event ${JSON.stringify({
        hook: "agent.turn_ended",
        agentId: event.agent.id,
        workspaceId,
        outcome: event.outcome.kind,
        at: new Date().toISOString(),
      })}`,
    );
    scheduler.noteEvent(workspaceId);
  });
  const removeArchived = server.on("agent.archived", (_event, context) => {
    hookApi = context.paseo;
  });

  const target = resolveDaemonTarget();
  void loadConfig().then((config) => {
    log(
      `[merged-worker-archiver] started ${JSON.stringify({
        mode: config ? (config.armed ? "armed" : "dry-run") : "config-invalid",
        config,
        fallbackDaemon: target,
      })}`,
    );
  });
  void scheduleNextSweep(STARTUP_DELAY_MS);

  return () => {
    stopped = true;
    removeTurnEnded();
    removeArchived();
    scheduler.stop();
    if (sweepTimer) clearTimeout(sweepTimer);
    hookApi = null;
  };
}

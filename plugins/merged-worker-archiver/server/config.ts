import { z } from "zod";

// Host-scoped plugin settings, stored by Paseo at
// <PASEO_HOME>/plugin-settings/merged-worker-archiver/config.json as
// {"version":1,"values":{...}}. Every field has a safe default, so a missing file means
// "dry-run with defaults". `armed` is the only switch that allows real archiving.
// Unknown keys make the settings invalid (fail closed).
export const ConfigSchema = z
  .object({
    armed: z.boolean().default(false),
    /** Most workspaces one sweep archives (or would archive in dry-run); the rest wait for the next sweep. */
    maxArchivesPerSweep: z.number().int().min(1).default(5),
    /** Slow backstop for merges done outside Paseo (for example the GitHub web UI). */
    sweepIntervalMinutes: z.number().min(1).max(24 * 60).default(60),
    graceMinutes: z.number().min(0).max(7 * 24 * 60).default(0),
    commandTimeoutSeconds: z.number().min(1).max(120).default(15),
    useGh: z.boolean().default(true),
    /** Coalescing window after agent.turn_ended before the project is evaluated. */
    eventDebounceSeconds: z.number().min(0).max(60).default(3),
    /** Re-checks for clean, idle, not-yet-merged worktrees after an event evaluation. */
    followUpDelaysSeconds: z.array(z.number().min(1).max(3600)).max(5).default([15, 60, 180]),
    allowAgentlessWorkspaces: z.boolean().default(false),
    logNonCandidates: z.boolean().default(false),
  })
  .strict();

export type ArchiverConfig = z.output<typeof ConfigSchema>;

export const SETTINGS_ID = "config";
export const SETTINGS_VERSION = 1;

export function defaultConfig(overrides: Partial<ArchiverConfig> = {}): ArchiverConfig {
  return ConfigSchema.parse(overrides);
}

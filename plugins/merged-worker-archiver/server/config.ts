import { z } from "zod";

// Host-scoped plugin settings, stored by Paseo at
// <PASEO_HOME>/plugin-settings/merged-worker-archiver/config.json as
// {"version":1,"values":{...}}. Every field has a safe default, so a missing file means
// "dry-run with defaults". `armed` is the only switch that allows real archiving.
// Other unknown keys still make the settings invalid (fail closed).
const RETIRED_KEYS = ["maxArchivesPerSweep"] as const;

const ConfigObjectSchema = z
  .object({
    armed: z.boolean().default(false),
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

/** Retired keys (for example maxArchivesPerSweep, removed in 0.2.0) are accepted and ignored. */
export const ConfigSchema = z.preprocess((values) => {
  if (values === null || typeof values !== "object" || Array.isArray(values)) return values;
  const copy: Record<string, unknown> = { ...(values as Record<string, unknown>) };
  for (const key of RETIRED_KEYS) delete copy[key];
  return copy;
}, ConfigObjectSchema);

export type ArchiverConfig = z.output<typeof ConfigObjectSchema>;

export const SETTINGS_ID = "config";
export const SETTINGS_VERSION = 1;

export function defaultConfig(overrides: Partial<ArchiverConfig> = {}): ArchiverConfig {
  return ConfigSchema.parse(overrides);
}

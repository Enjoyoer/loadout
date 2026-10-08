import { z } from "zod";

// Host-scoped plugin settings, stored by Paseo at
// <PASEO_HOME>/plugin-settings/pm-native-worker-guard/config.json as
// {"version":1,"values":{...}}. Every field has a safe default, so a missing file means
// "dry-run with defaults". `armed` is the only switch that allows stopping and archiving.
// Unknown keys or wrong types make the settings invalid, and invalid settings do nothing.

export const DEFAULT_NOTICE =
  "PM-created workers must use the Pi provider, e.g. provider pi/fleet/claude-opus-5-5 for code changes or pi/fleet/gpt-6.1-sol for browser work. Ask the owner if a native worker is really needed.";

const Id = z.string().trim().min(1).max(256);

export const ConfigSchema = z
  .object({
    armed: z.boolean().default(false),
    /** Parent label that marks a PM. The value comparison ignores case and surrounding spaces. */
    pmLabelKey: Id.default("role"),
    pmLabelValue: Id.default("pm"),
    /** Child agent ids the owner pre-approved. Only this file can approve; agent labels never do. */
    allowAgentIds: z.array(Id).max(1000).default([]),
    /** PM agent ids allowed to create native workers. */
    allowParentIds: z.array(Id).max(1000).default([]),
    /** Native provider ids. A provider matches when it equals one, or starts with `<id>/`. */
    nativeProviders: z.array(Id).min(1).max(32).default(["codex", "claude"]),
    /** Guidance sent to the PM after the plugin's own "archived <id> (<provider>):" prefix. */
    notice: z.string().trim().min(1).max(2000).default(DEFAULT_NOTICE),
    /** Bound on persisted per-child decisions. */
    maxStateEntries: z.number().int().min(100).max(10_000).default(2_000),
  })
  .strict();

export type GuardConfig = z.output<typeof ConfigSchema>;

export const SETTINGS_ID = "config";
export const SETTINGS_VERSION = 1;

export function defaultConfig(overrides: Partial<GuardConfig> = {}): GuardConfig {
  return ConfigSchema.parse(overrides);
}

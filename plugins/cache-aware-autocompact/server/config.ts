import { z } from "zod";

export const ConfigSchema = z.object({
  /** The only setting that permits a real /compact send. Defaults to false forever. */
  armed: z.boolean().default(false),
  /** Delay after a completed turn. Defaults are cache TTL minus a safety margin. */
  claudeDelayMinutes: z.number().min(1).max(120).default(50),
  codexDelayMinutes: z.number().min(1).max(120).default(22),
  /** Latest reported context usage required before a timer is eligible. */
  thresholdTokens: z.number().int().min(1).max(10_000_000).default(100_000),
  /** Context size at which boundary checks favor recall over precision. */
  softThreshold: z.number().int().min(1).max(10_000_000).default(300_000),
  /** Keep only a bounded number of durable checkpoint decisions. */
  maxStateEntries: z.number().int().min(100).max(10_000).default(2_000),
}).strict();

export type AutoCompactConfig = z.output<typeof ConfigSchema>;
export const SETTINGS_ID = "config";
export const SETTINGS_VERSION = 1;

export function defaultConfig(overrides: Partial<AutoCompactConfig> = {}): AutoCompactConfig {
  return ConfigSchema.parse(overrides);
}

import { z } from "zod";

export const DEFAULT_MAX_DELETES_PER_SWEEP = 5;
export const SETTINGS_ID = "config";
export const SETTINGS_VERSION = 1;

// Keep raw values until sweep time so invalid caps can fall back with a log.
// Only literal true can arm the sweeper, regardless of the stored value's type.
export const ConfigSchema = z.object({
  armed: z.unknown().default(false),
  maxDeletesPerSweep: z.unknown().default(DEFAULT_MAX_DELETES_PER_SWEEP),
}).strict();

export interface SweeperConfig {
  armed: boolean;
  maxDeletesPerSweep: number;
}

export function readConfig(values: unknown = {}, log: (line: string) => void = () => {}): SweeperConfig {
  const parsed = ConfigSchema.safeParse(values);
  if (!parsed.success) {
    log("[orphan-project-sweeper] config-invalid fallback=dry-run,maxDeletesPerSweep=5");
    return { armed: false, maxDeletesPerSweep: DEFAULT_MAX_DELETES_PER_SWEEP };
  }
  const cap = parsed.data.maxDeletesPerSweep;
  const validCap = typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0;
  if (!validCap) {
    log(`[orphan-project-sweeper] config-invalid setting=maxDeletesPerSweep value=${JSON.stringify(cap)} fallback=${DEFAULT_MAX_DELETES_PER_SWEEP}`);
  }
  return {
    armed: parsed.data.armed === true,
    maxDeletesPerSweep: validCap ? cap : DEFAULT_MAX_DELETES_PER_SWEEP,
  };
}

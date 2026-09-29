import { z } from "zod";

const ConfigObjectSchema = z.object({
  armed: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  transientMaxAttempts: z.number().int().min(1).max(10).default(3),
  transientBackoffSeconds: z.array(z.number().int().min(0).max(86400)).min(1).max(10).default([0, 120, 300, 900]),
  baseDelaySeconds: z.number().int().min(60).max(86400).default(18000),
  maxDelaySeconds: z.number().int().min(300).max(604800).default(604800),
  pollIntervalSeconds: z.number().int().min(5).max(3600).default(30),
  resetBufferSeconds: z.number().int().min(0).max(3600).default(30),
  verificationTimeoutSeconds: z.number().int().min(30).max(86400).default(180),
  excludedProviders: z.array(z.string().min(1)).default(["chatgpt-web"]),
  excludedLabels: z.array(z.string().min(1)).default(["noresume"]),
});

export const ConfigSchema = ConfigObjectSchema.strict();
export type Config = z.output<typeof ConfigObjectSchema>;

export const SETTINGS_ID = "auto-resume-config";
export const SETTINGS_VERSION = 2;

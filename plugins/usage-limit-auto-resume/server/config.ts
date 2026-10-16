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
  // Quota awareness (pq): hold sends while the agent's whole pool is out, and time usage resumes from its resets.
  quotaAware: z.boolean().default(true),
  quotaResetBufferSeconds: z.number().int().min(0).max(3600).default(60),
  quotaCacheSeconds: z.number().int().min(0).max(600).default(60),
  pqTimeoutSeconds: z.number().int().min(1).max(15).default(5),
  excludedLabels: z.array(z.string().min(1)).default(["noresume"]),
  // PM quota fallback: a Pi PM on Claude moves to this exact catalog profile while pq shows Claude out, and is moved
  // back once pq shows Claude usable. Off by default; turning it off stops new swaps, never a pending return.
  pmFallback: z.boolean().default(false),
  pmFallbackModel: z.string().min(1).default("fleet/gpt-6.1-sol"),
  pmFallbackThinking: z.string().min(1).default("medium"),
  pmFallbackServiceTier: z.string().min(1).default("fast"),
  pmFallbackOptOutLabel: z.string().min(1).default("nofallback"),
  // Owner surface: register the original profile of a PM that is already elsewhere, or cancel one return by its id.
  pmFallbackEnroll: z.array(z.object({
    agentId: z.string().min(1),
    model: z.string().min(1),
    thinkingOptionId: z.string().min(1).nullable(),
    serviceTier: z.string().min(1).nullable(),
  }).strict()).max(50).default([]),
  pmFallbackCancel: z.array(z.string().min(1)).max(50).default([]),
});

export const ConfigSchema = ConfigObjectSchema.strict();
export type Config = z.output<typeof ConfigObjectSchema>;

export const SETTINGS_ID = "auto-resume-config";
export const SETTINGS_VERSION = 2;

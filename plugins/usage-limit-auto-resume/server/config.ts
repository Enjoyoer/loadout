import { z } from "zod";
import { DEFAULT_BACKOFF_SECONDS } from "./model.ts";

const ConfigObjectSchema = z.object({
  armed: z.boolean().default(false),
  // The retry delays in order; the last one repeats for as long as the record lives.
  transientBackoffSeconds: z.array(z.number().int().min(0).max(86400)).min(1).max(10).default([...DEFAULT_BACKOFF_SECONDS]),
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
  // back once pq shows Claude usable. Off by default; turning it off stops new swaps, never a pending return. Every such
  // PM is eligible: no label opts it out.
  pmFallback: z.boolean().default(false),
  pmFallbackModel: z.string().min(1).default("fleet/gpt-6.2-sol"),
  pmFallbackThinking: z.string().min(1).default("medium"),
  pmFallbackServiceTier: z.string().min(1).default("standard"),
  // The fallback chain: a PM whose original model has an entry first moves to that entry's exact catalog profile (no
  // Fast label) when its model is refused, and to the profile above only if that one is refused too. Any other PM
  // keeps the single step above.
  pmFallbackFirst: z.array(z.object({
    from: z.string().min(1),
    model: z.string().min(1),
    thinking: z.string().min(1),
  }).strict()).max(20).default([{ from: "fleet/claude-fable-5-2", model: "fleet/claude-opus-5-5", thinking: "high" }]),
  // Owner surface: register the original profile of a PM that is already elsewhere, or cancel one return by its id.
  pmFallbackEnroll: z.array(z.object({
    agentId: z.string().min(1),
    model: z.string().min(1),
    thinkingOptionId: z.string().min(1).nullable(),
    serviceTier: z.string().min(1).nullable(),
  }).strict()).max(50).default([]),
  pmFallbackCancel: z.array(z.string().min(1)).max(50).default([]),
  // Pace mode: while this host's pq reading shows the listed Claude accounts off pace, a live Pi PM on a Claude
  // subscription model moves in place to the profile below, and returns to its exact original once a fresh reading
  // shows them on pace. Off by default; turning it off stops new pace swaps, never a pending pace return.
  paceFallback: z.boolean().default(false),
  paceFallbackModel: z.string().min(1).default("fleet/gpt-6.2-sol"),
  paceFallbackThinking: z.string().min(1).default("medium"),
  paceFallbackServiceTier: z.string().min(1).default("standard"),
  // The pq account labels whose pace decides. Empty: pace cannot be decided and nothing moves. Real labels belong only
  // in the host settings file.
  pacePoolAccounts: z.array(z.string().min(1)).max(50).default([]),
  // PMs pace mode never moves: by `project` label, in addition to the built-in main PM projects (config, work,
  // personal), which no setting removes; and by agent id prefix. The prefixes belong only in the host settings file;
  // in host-local mode, while that list or pacePoolAccounts is empty, the host is unconfigured and pace mode moves
  // nothing. A complete remote pace source requires no private exclusion list entries (optional exclusions still apply).
  paceFallbackExcludedProjects: z.array(z.string().min(1)).max(50).default([]),
  paceFallbackExcludedAgents: z.array(z.string().min(1)).max(50).default([]),
  // Remote pace source (optional, off by default): reads a strictly validated tri-state pace verdict computed by
  // another host over existing authenticated SSH instead of local pq. Local pacePoolAccounts must stay empty when set.
  paceRemoteHost: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/).nullable().default(null),
  paceRemoteCommand: z.array(z.string().min(1).max(512).refine((arg) => !/[\0\r\n]/.test(arg), "control character not allowed")).min(1).max(16).nullable().default(null),
  paceRemoteTimeoutSeconds: z.number().int().min(1).max(30).default(10),
  paceRemoteMaxAgeSeconds: z.number().int().min(10).max(600).default(120),
});

export const ConfigSchema = ConfigObjectSchema.strict();
export type Config = z.output<typeof ConfigObjectSchema>;

export const SETTINGS_ID = "auto-resume-config";
export const SETTINGS_VERSION = 2;

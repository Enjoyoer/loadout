import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const config = defineSettings({ id: "routing", scope: "host", version: 1,
  schema: z.object({ runtimeRoot: z.string().default("") }) });
export const stateSchema = z.object({ capable: z.boolean(), fast: z.boolean(), tier: z.string() });
export const inspect = defineRpc({ name: "fast.inspect", input: z.object({ agentId: z.string() }), output: stateSchema });
export const toggle = defineRpc({ name: "fast.toggle", input: z.object({ agentId: z.string(), fast: z.boolean() }), output: stateSchema });

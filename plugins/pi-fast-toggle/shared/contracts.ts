import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const config = defineSettings({ id: "routing", scope: "host", version: 1,
  schema: z.object({ runtimeRoot: z.string().default("") }) });
export const stateSchema = z.object({ capable: z.boolean(), fast: z.boolean(), tier: z.string() });
export const inspect = defineRpc({ name: "fast.inspect", input: z.object({ agentId: z.string() }), output: stateSchema });
export const toggle = defineRpc({ name: "fast.toggle", input: z.object({ agentId: z.string(), fast: z.boolean() }), output: stateSchema });

const effortStateSchema = z.object({
  provider: z.string(), model: z.string().nullable(), selection: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional(), isDefault: z.boolean().optional() })),
  requested: z.string().nullable(), effective: z.string().nullable(), selected: z.string().nullable(),
  inherited: z.boolean(),
});
const effortResultSchema = z.object({ state: effortStateSchema.nullable(), error: z.string().nullable() });
export type EffortState = z.infer<typeof effortStateSchema>;
export const effortInspect = defineRpc({ name: "effort.inspect", input: z.object({ agentId: z.string() }), output: effortResultSchema });
export const effortSet = defineRpc({ name: "effort.set", input: z.object({
  agentId: z.string(), expectedProvider: z.string(), expectedModel: z.string(), thinkingOptionId: z.string(),
}), output: effortResultSchema });

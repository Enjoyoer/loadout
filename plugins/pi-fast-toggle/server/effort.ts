import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { effortSet, type EffortState } from "../shared/contracts";
import { withDaemon } from "./daemon";

class EffortError extends Error {}
const changed = "Agent or model changed. Close and reopen Thinking level.";
const unconfirmed = "Thinking update unconfirmed. Refresh before trying again.";
type Agent = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
const selection = (agent: Agent) => agent.runtimeInfo?.model ?? agent.model ?? null;
function sameAgent(a: Agent, b: Agent) {
  return !b.archivedAt && a.provider === b.provider && selection(a) === selection(b) && a.cwd === b.cwd;
}
async function refresh(paseo: PaseoApi, id: string) {
  const agent = (await paseo.agents.ref(id).refresh())?.agent;
  if (!agent || agent.archivedAt) throw new EffortError("Agent is unavailable or archived.");
  return agent;
}
async function inspect(paseo: PaseoApi, agentId: string) {
  const agent = await refresh(paseo, agentId);
  const catalog = await paseo.providers.listModels(agent.provider, { cwd: agent.cwd });
  if (catalog.error || !catalog.models) throw new EffortError("Thinking catalog unavailable. Retry inspection.");
  const selectedModel = selection(agent);
  const exact = catalog.models.filter(model => model.id === selectedModel);
  const matches = selectedModel === null ? catalog.models.filter(model => model.isDefault) :
    exact.length ? exact : catalog.models.filter(model => model.aliases?.includes(selectedModel));
  const model = matches.length === 1 ? matches[0] : undefined;
  const options = model?.thinkingOptions ?? [];
  // Duplicate option IDs cannot identify a unique radio choice or mutation.
  if (new Set(options.map(option => option.id)).size !== options.length) throw new EffortError("Thinking catalog is ambiguous.");
  const defaults = options.filter(option => option.isDefault);
  const fresh = await refresh(paseo, agentId);
  if (!sameAgent(agent, fresh)) throw new EffortError(changed);
  const requested = fresh.thinkingOptionId ?? null;
  const effective = fresh.effectiveThinkingOptionId ?? null;
  const current = requested ?? effective ?? model?.defaultThinkingOptionId ?? (defaults.length === 1 ? defaults[0].id : null);
  const state: EffortState = { provider: agent.provider, model: model?.id ?? null, selection: selectedModel,
    options: options.map(({ id, label, description, isDefault }) => ({ id, label, description, isDefault })),
    requested, effective, selected: options.some(option => option.id === current) ? current : null, inherited: requested === null };
  return { agent: fresh, state };
}
export async function inspectEffort(paseo: PaseoApi, agentId: string) {
  try { return { state: (await inspect(paseo, agentId)).state, error: null }; }
  catch (error) { return { state: null, error: error instanceof EffortError ? error.message : "Thinking catalog unavailable. Check the host connection and retry." }; }
}

export async function setEffort(paseo: PaseoApi, input: RpcInput<typeof effortSet>) {
  let attempted = false;
  try {
    const { agent, state } = await inspect(paseo, input.agentId);
    if (state.provider !== input.expectedProvider || state.model !== input.expectedModel) throw new EffortError(changed);
    if (!state.options.some(option => option.id === input.thinkingOptionId)) throw new EffortError("Thinking option is no longer available. Reopen the menu.");
    if (agent.thinkingOptionId === input.thinkingOptionId) return { state, error: null };
    // Catalog work is complete. Recheck immediately before the settings-only write.
    if (!sameAgent(agent, await refresh(paseo, input.agentId))) throw new EffortError(changed);
    attempted = true;
    await withDaemon(client => client.setAgentThinkingOption(input.agentId, input.thinkingOptionId));
    const result = await inspect(paseo, input.agentId);
    if (!sameAgent(agent, result.agent) || result.state.model !== state.model) throw new EffortError(changed);
    if (result.agent.thinkingOptionId !== input.thinkingOptionId) throw new EffortError(unconfirmed);
    return { state: result.state, error: null };
  } catch (error) {
    // A timeout or malformed response may follow a successful write. Reconcile, never resend.
    const current = attempted ? await inspectEffort(paseo, input.agentId) : null;
    return { state: current?.state ?? null, error: error instanceof EffortError ? error.message :
      attempted ? unconfirmed : "Thinking update unavailable. Refresh and check the host connection." };
  }
}

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { config, inspect, toggle, effortInspect, effortSet } from "./shared/contracts";
import { inspectEffort, setEffort } from "./server/effort";
import { runtime, catalog, requestedState, tierCapable, lunaModel, writeTier } from "./server/routing";
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(config);
  server.handle(effortInspect, ({ agentId }, { paseo }) => inspectEffort(paseo, agentId));
  server.handle(effortSet, (input, { paseo }) => setEffort(paseo, input));
  server.handle(inspect, async ({ agentId }, { paseo }) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    const state = { ...requestedState(agent?.labels), fixed: false };
    if (!agent || agent.provider !== "pi" || agent.archivedAt) return { capable: false, ...state };
    try {
      const cfg = await settings.read();
      if (cfg.status !== "ready") return { capable: false, ...state };
      const route = await runtime(cfg.values.runtimeRoot, agent.runtimeInfo?.model ?? agent.model ?? "");
      const rows = await catalog(cfg.values.runtimeRoot, route);
      const capable = tierCapable(route.model, rows);
      if (!capable || !lunaModel(route.model)) return { capable, ...state };
      // On Luna the routing sends Fast whatever the label says, so the pill is fixed on; it requests Ultrafast only for
      // an ultrafast label on a model row that lists ultrafast.
      const ultrafast = state.tier === "ultrafast" && !!rows.find(row => (row.slug ?? row.id) === route.model.id)
        ?.service_tiers?.some(tier => tier.id === "ultrafast");
      return { capable, ...state, fast: true, tier: ultrafast ? "ultrafast" : "fast", fixed: true };
    } catch { return { capable: false, ...state }; }
  });
  server.handle(toggle, async ({ agentId, fast }, { paseo }) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent || agent.provider !== "pi" || agent.archivedAt) throw Error("Only active Pi agents support this toggle");
    const cfg = await settings.read();
    if (cfg.status !== "ready") throw Error("Pi routing settings unavailable");
    const selection = agent.runtimeInfo?.model ?? agent.model ?? "";
    const route = await runtime(cfg.values.runtimeRoot, selection);
    if (!tierCapable(route.model, await catalog(cfg.values.runtimeRoot, route, true))) throw Error("Selected Pi model does not support Fast");
    if (lunaModel(route.model)) throw Error("Fast is always on for Luna");
    // Recheck selection after the network lookup, before making a label-only update.
    const fresh = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!fresh || fresh.provider !== "pi" || fresh.archivedAt || (fresh.runtimeInfo?.model ?? fresh.model) !== selection) throw Error("Agent model changed; retry");
    await writeTier(agentId, fast);
    const result = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (result?.labels?.["opc.service-tier"] !== (fast ? "fast" : "standard")) throw Error("Tier update was not confirmed");
    return { capable: true, ...requestedState(result.labels), fixed: false };
  });
  return () => {};
}

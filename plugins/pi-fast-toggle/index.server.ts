import type { PluginServerContext } from "@getpaseo/plugin/server";
import { config, inspect, toggle } from "./shared/contracts";
import { runtime, catalog, requestedState, tierCapable, writeTier } from "./server/routing";
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(config);
  server.handle(inspect, async ({ agentId }, { paseo }) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    const state = requestedState(agent?.labels);
    if (!agent || agent.provider !== "pi" || agent.archivedAt) return { capable: false, ...state };
    try {
      const cfg = await settings.read();
      if (cfg.status !== "ready") return { capable: false, ...state };
      const route = await runtime(cfg.values.runtimeRoot, agent.runtimeInfo?.model ?? agent.model ?? "");
      return { capable: tierCapable(route.model, await catalog(cfg.values.runtimeRoot, route)), ...state };
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
    // Recheck selection after the network lookup, before making a label-only update.
    const fresh = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!fresh || fresh.provider !== "pi" || fresh.archivedAt || (fresh.runtimeInfo?.model ?? fresh.model) !== selection) throw Error("Agent model changed; retry");
    await writeTier(route.spec.paseoMcp.url, agentId, fast);
    const result = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (result?.labels?.["opc.service-tier"] !== (fast ? "fast" : "standard")) throw Error("Tier update was not confirmed");
    return { capable: true, ...requestedState(result.labels) };
  });
  return () => {};
}

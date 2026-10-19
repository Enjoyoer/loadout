import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { inspect, toggle } from "../shared/contracts";
export type DirectoryAgent = { id: string; provider: string; workspaceId?: string | null; archivedAt?: string | null; model?: string | null; runtimeInfo?: { model?: string | null } | null; thinkingOptionId?: string | null; effectiveThinkingOptionId?: string | null };
export interface ComposerActions { canFast(): boolean; toggleFast(): Promise<void> }
export interface ComposerExtension { update(agent: DirectoryAgent, actions: ComposerActions): void; remove(id: string): void }

export function contributePills(client: PluginClientContext, extension?: ComposerExtension) {
  const pills = new Map<string, PluginButtonRegistration>();
  const generations = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const agents = new Map<string, DirectoryAgent>();
  let stopped = false;
  let snapshotGeneration = 0;
  let release: (() => Promise<void>) | undefined;
  const removeFast = (id: string) => { generations.set(id, (generations.get(id) ?? 0) + 1); pills.get(id)?.remove(); pills.delete(id); };
  const remove = (id: string) => { removeFast(id); agents.delete(id); extension?.remove(id); };
  function toggleFast(id: string): Promise<void> {
    const existing = pending.get(id);
    if (existing) return existing;
    const agent = agents.get(id);
    if (stopped || !agent) return Promise.reject(Error("Agent unavailable"));
    const work = (async () => {
      try {
        // Both clicks and keys inspect fresh state. Never invert a captured boolean.
        const current = await client.rpc(inspect, { agentId: id });
        if (stopped || !agents.has(id)) return;
        if (!current.capable) { removeFast(id); throw Error("Fast is unavailable for this model"); }
        await client.rpc(toggle, { agentId: id, fast: !current.fast });
      } catch {
        if (!stopped) pills.get(id)?.update({ label: "Fast: Retry", title: "Fast update unconfirmed. Retry to inspect current state before toggling." });
        throw Error("Fast unavailable or update unconfirmed. Check the model, connection and daemon MCP access before retrying.");
      } finally { pending.delete(id); }
      const latest = agents.get(id);
      if (!stopped && latest) await reconcile(latest);
    })();
    pending.set(id, work);
    pills.get(id)?.update({ label: "Fast: Applying..." });
    return work;
  }
  async function reconcile(agent: DirectoryAgent) {
    removeFast(agent.id);
    if (stopped || !agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    agents.set(agent.id, agent);
    extension?.update(agent, { canFast: () => pills.has(agent.id), toggleFast: () => toggleFast(agent.id) });
    if (agent.provider !== "pi") return;
    const generation = generations.get(agent.id);
    const state = await client.rpc(inspect, { agentId: agent.id }).catch(() => null);
    if (stopped || generation !== generations.get(agent.id) || !state?.capable) return;
    const pill = client.addComposerPill({ id: "fast", agentId: agent.id, workspaceId: agent.workspaceId,
      button: { title: `Fast ${state.fast ? "on" : "off"}: request ${state.fast ? "Standard" : "Fast"} next turn`, icon: "Zap", label: pending.has(agent.id) ? "Fast: Applying..." : state.tier === "ultrafast" ? "Fast: Ultrafast" : `Fast: ${state.fast ? "On" : "Off"}`,
        behavior: { kind: "action", onPress: () => toggleFast(agent.id) } } });
    pills.set(agent.id, pill);
  }
  const bootstrap = client.paseo.agents.list({ filter: { includeArchived: false }, subscribe: {} }).then(async directory => {
    if (stopped) { await directory.subscription.release(); return; }
    release = () => directory.subscription.release();
    directory.subscription.subscribe({ snapshot(data) {
      const snapshotId = ++snapshotGeneration;
      for (const id of generations.keys()) remove(id);
      for (const { agent } of data.entries) void reconcile(agent);
      // A subscribed directory snapshot is still paginated. Hydrate remaining agents
      // without creating another observation, and discard pages superseded by reconnect.
      void (async () => {
        let pageInfo = data.pageInfo;
        const seen = new Set<string>();
        while (!stopped && snapshotId === snapshotGeneration && pageInfo?.hasMore && pageInfo.nextCursor) {
          const cursor = pageInfo.nextCursor;
          if (seen.has(cursor)) throw Error("Agent directory cursor repeated");
          seen.add(cursor);
          const before = new Map(generations);
          const page = await client.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, cursor } });
          if (stopped || snapshotId !== snapshotGeneration) return;
          for (const { agent } of page.entries) {
            if (before.get(agent.id) === generations.get(agent.id)) void reconcile(agent);
          }
          pageInfo = page.pageInfo;
        }
      })().catch(() => {});
    }, update(message) {
      if (message.type !== "agent_update") return;
      const update = message.payload;
      if (update.kind === "remove") remove(update.agentId);
      else void reconcile(update.agent);
    }, error() { ++snapshotGeneration; for (const id of generations.keys()) remove(id); } });
  }).catch(() => { for (const id of generations.keys()) remove(id); });
  return async () => { stopped = true; ++snapshotGeneration; for (const id of generations.keys()) remove(id); await bootstrap; await release?.(); };
}

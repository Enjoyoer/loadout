import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { inspect, toggle } from "../shared/contracts";
export function contributePills(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const generations = new Map<string, number>();
  let stopped = false;
  let snapshotGeneration = 0;
  let release: (() => Promise<void>) | undefined;
  const remove = (id: string) => { generations.set(id, (generations.get(id) ?? 0) + 1); pills.get(id)?.remove(); pills.delete(id); };
  async function reconcile(agent: { id: string; provider: string; workspaceId?: string | null; archivedAt?: string | null }) {
    remove(agent.id);
    if (stopped || agent.provider !== "pi" || !agent.workspaceId || agent.archivedAt) return;
    const generation = generations.get(agent.id);
    const state = await client.rpc(inspect, { agentId: agent.id }).catch(() => null);
    if (stopped || generation !== generations.get(agent.id) || !state?.capable) return;
    const pill = client.addComposerPill({ id: "fast", agentId: agent.id, workspaceId: agent.workspaceId,
      button: { title: `Fast ${state.fast ? "on" : "off"}: request ${state.fast ? "Standard" : "Fast"} next turn`, icon: "Zap", label: state.tier === "ultrafast" ? "Fast: Ultrafast" : `Fast: ${state.fast ? "On" : "Off"}`,
        behavior: { kind: "action", async onPress() {
          // Read fresh state rather than a potentially stale captured boolean.
          const current = await client.rpc(inspect, { agentId: agent.id });
          if (!current.capable) { remove(agent.id); throw Error("Fast is unavailable for this model"); }
          await client.rpc(toggle, { agentId: agent.id, fast: !current.fast });
          await reconcile(agent);
        } } } });
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
  }).catch(() => { for (const id of pills.keys()) remove(id); });
  return async () => { stopped = true; for (const id of pills.keys()) remove(id); await bootstrap; await release?.(); };
}

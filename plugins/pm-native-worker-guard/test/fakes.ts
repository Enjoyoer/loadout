import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { defaultConfig, type GuardConfig } from "../server/config.ts";
import { Guard, type AgentView, type GuardAgentHandle, type GuardApi, type TimelineRow } from "../server/guard.ts";
import { PARENT_AGENT_ID_LABEL } from "../server/policy.ts";
import { StateStore } from "../server/store.ts";

export const PM_ID = "agent-pm-0001";
export const CHILD_ID = "agent-child-0001";
export const NOW = new Date("2026-10-08T12:00:00.000Z");

export function agent(overrides: Partial<AgentView> = {}): AgentView {
  return { id: CHILD_ID, provider: "codex", status: "running", labels: {}, archivedAt: null, activeTurn: null, ...overrides };
}

export function pm(overrides: Partial<AgentView> = {}): AgentView {
  return agent({ id: PM_ID, provider: "pi", status: "idle", labels: { role: "pm", project: "demo" }, ...overrides });
}

export function child(overrides: Partial<AgentView> = {}): AgentView {
  return agent({ labels: { [PARENT_AGENT_ID_LABEL]: PM_ID }, ...overrides });
}

export interface FakeApi extends GuardApi {
  agentsById: Map<string, AgentView>;
  calls: string[];
  sent: Array<{ agentId: string; text: string }>;
  rows: Array<{ agentId: string; item: TimelineRow }>;
  failRefresh: Set<string>;
  failArchive: boolean;
  failSend: boolean;
  failAppend: boolean;
  /** Called after an archive, so tests can model the daemon changing state. */
  onArchive?: (agentId: string) => void;
}

/** In-memory PaseoApi slice. Every call is recorded; mutations update the snapshots. */
export function fakeApi(agents: AgentView[]): FakeApi {
  const api: FakeApi = {
    agentsById: new Map(agents.map((entry) => [entry.id, entry])),
    calls: [],
    sent: [],
    rows: [],
    failRefresh: new Set(),
    failArchive: false,
    failSend: false,
    failAppend: false,
    agents: {
      ref(agentId: string): GuardAgentHandle {
        return {
          async refresh() {
            api.calls.push(`refresh:${agentId}`);
            if (api.failRefresh.has(agentId)) throw new Error("socket closed");
            const found = api.agentsById.get(agentId);
            return found ? { agent: structuredClone(found) } : null;
          },
          async archive() {
            api.calls.push(`archive:${agentId}`);
            if (api.failArchive) throw new Error("archive refused");
            const found = api.agentsById.get(agentId);
            if (!found) throw new Error(`Agent not found: ${agentId}`);
            found.archivedAt = NOW.toISOString();
            found.status = "closed";
            api.onArchive?.(agentId);
            return { archivedAt: found.archivedAt };
          },
          async send(text: string) {
            api.calls.push(`send:${agentId}`);
            if (api.failSend) throw new Error("send rejected");
            api.sent.push({ agentId, text });
          },
          timeline: {
            async append(item: TimelineRow) {
              api.calls.push(`append:${agentId}`);
              if (api.failAppend) throw new Error("append rejected");
              api.rows.push({ agentId, item });
              return { seq: api.rows.length, epoch: "e1" };
            },
          },
        };
      },
    },
  };
  return api;
}

export async function tempStatePath(): Promise<string> {
  const root = path.resolve("node_modules/.cache/pm-native-worker-guard-test");
  await mkdir(root, { recursive: true });
  return path.join(await mkdtemp(path.join(root, "state-")), "state.json");
}

export interface Harness {
  guard: Guard;
  store: StateStore;
  logs: string[];
  statePath: string;
  setConfig(config: GuardConfig | null): void;
}

export async function harness(config: Partial<GuardConfig> | null = {}, statePath?: string): Promise<Harness> {
  const file = statePath ?? (await tempStatePath());
  const store = new StateStore(file);
  const logs: string[] = [];
  let current: GuardConfig | null = config === null ? null : defaultConfig(config);
  const guard = new Guard({ readConfig: async () => current, store, log: (line) => logs.push(line), now: () => NOW });
  return { guard, store, logs, statePath: file, setConfig: (next) => (current = next) };
}

/** Parsed JSON payloads of the plugin's log lines. */
export function entries(logs: readonly string[]): Array<Record<string, unknown>> {
  return logs.map((line) => JSON.parse(line.replace(/^\[pm-native-worker-guard\] /, "")) as Record<string, unknown>);
}

export const created = (overrides: { id?: string; parentAgentId?: string | null; provider?: string } = {}) => ({
  id: CHILD_ID,
  parentAgentId: PM_ID as string | null,
  provider: "codex",
  ...overrides,
});

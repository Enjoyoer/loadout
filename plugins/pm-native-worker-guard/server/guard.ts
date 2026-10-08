import type { GuardConfig } from "./config.ts";
import {
  allowlistReason,
  errorMessage,
  isBusy,
  isNativeProvider,
  isPmAgent,
  noticeText,
  PARENT_AGENT_ID_LABEL,
  PLUGIN_ID,
} from "./policy.ts";
import type { HandledRecord, NoticeState, Outcome } from "./store.ts";

// The slice of the public PaseoApi (@getpaseo/client 0.10.3) this plugin uses. The hook
// context's `paseo` satisfies it; tests pass a fake.
export interface AgentView {
  id: string;
  provider: string;
  status: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  activeTurn?: { turnId: string } | null;
}

export interface TimelineRow {
  type: "plugin";
  id: string;
  kind: string;
  version: number;
  data: { childId: string; provider: string; message: string };
}

export interface GuardAgentHandle {
  /** fetch_agent_request; null when the daemon has no such agent. */
  refresh(): Promise<{ agent: AgentView } | null>;
  /** archive_agent_request; the daemon cancels any in-flight run, then archives. */
  archive(): Promise<{ archivedAt: string }>;
  /** send_agent_message_request; resolves on acceptance, not when the turn ends. */
  send(text: string): Promise<void>;
  timeline: { append(item: TimelineRow): Promise<unknown> };
}

export interface GuardApi {
  agents: { ref(agentId: string): GuardAgentHandle };
}

export interface GuardStore {
  get(childId: string): Promise<HandledRecord | null>;
  pendingFor(parentId: string): Promise<HandledRecord[]>;
  put(record: HandledRecord, maxEntries: number): Promise<void>;
}

export interface GuardDeps {
  /** Current settings, or null when they are invalid or unreadable (nothing runs). */
  readConfig(): Promise<GuardConfig | null>;
  store: GuardStore;
  log(line: string): void;
  now(): Date;
}

/** The fields of the agent.created hook agent (PluginHookAgent) this plugin reads. */
export interface CreatedAgent {
  id: string;
  parentAgentId: string | null;
  provider: string;
}

export interface GuardResult {
  action: string;
  reason?: string;
}

export const TIMELINE_KIND = "native-worker-archived";

interface Child {
  id: string;
  parentId: string;
  provider: string;
}

export class Guard {
  private readonly deps: GuardDeps;
  private readonly inFlight = new Set<string>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private stateErrorLogged = false;
  private stopped = false;

  constructor(deps: GuardDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.stopped = true;
  }

  private emit(action: string, fields: Record<string, unknown>): void {
    this.deps.log(`[${PLUGIN_ID}] ${JSON.stringify({ action, ...fields })}`);
  }

  private stateUnreadable(error: unknown): void {
    if (this.stateErrorLogged) return;
    this.stateErrorLogged = true;
    this.emit("state-unreadable", { reason: errorMessage(error), effect: "nothing is stopped or archived until the state file is fixed" });
  }

  /** agent.created: decide, then (armed) archive and notify. Never throws. */
  async handleCreated(agent: CreatedAgent, api: GuardApi): Promise<GuardResult> {
    if (this.stopped) return { action: "stopped" };
    const config = await this.deps.readConfig();
    if (!config) return { action: "config-invalid" };
    if (!isNativeProvider(agent.provider, config.nativeProviders)) return { action: "ignore", reason: "not-native" };
    if (!agent.parentAgentId) {
      this.emit("skip", { childId: agent.id, parentId: null, provider: agent.provider, reason: "no-parent" });
      return { action: "ignore", reason: "no-parent" };
    }
    if (this.inFlight.has(agent.id)) return { action: "duplicate", reason: "in-flight" };
    this.inFlight.add(agent.id);
    try {
      return await this.evaluate({ id: agent.id, parentId: agent.parentAgentId, provider: agent.provider }, config, api);
    } catch (error) {
      // Defensive: every expected failure is handled below; never let the hook throw.
      this.emit("error", { childId: agent.id, reason: errorMessage(error) });
      return { action: "error", reason: errorMessage(error) };
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  /** agent.turn_ended: deliver notices that waited for this PM's turn to end. Never throws. */
  async handleTurnEnded(agent: { id: string }, api: GuardApi): Promise<void> {
    if (this.stopped) return;
    let pending: HandledRecord[];
    try {
      pending = await this.deps.store.pendingFor(agent.id);
    } catch (error) {
      this.stateUnreadable(error);
      return;
    }
    if (pending.length === 0) return;
    const config = await this.deps.readConfig();
    if (!config?.armed) return;
    await this.deliver(agent.id, api, config, null);
  }

  private record(child: Child, outcome: Outcome, reason: string, extra: Partial<HandledRecord> = {}): HandledRecord {
    return { childId: child.id, parentId: child.parentId, provider: child.provider, outcome, reason, at: this.deps.now().toISOString(), ...extra };
  }

  /** Persist a terminal decision (best effort) and log it once. */
  private async finish(child: Child, config: GuardConfig, outcome: Outcome, reason: string): Promise<GuardResult> {
    try {
      await this.deps.store.put(this.record(child, outcome, reason), config.maxStateEntries);
    } catch (error) {
      this.emit("state-write-failed", { childId: child.id, reason: errorMessage(error) });
    }
    this.emit(outcome, { childId: child.id, parentId: child.parentId, provider: child.provider, reason });
    return { action: outcome, reason };
  }

  private async evaluate(child: Child, config: GuardConfig, api: GuardApi): Promise<GuardResult> {
    let existing: HandledRecord | null;
    try {
      existing = await this.deps.store.get(child.id);
    } catch (error) {
      this.stateUnreadable(error);
      return { action: "skip", reason: "state-unreadable" };
    }
    if (existing) return { action: "duplicate", reason: existing.outcome };

    const allowed = allowlistReason(child.id, child.parentId, config);
    if (allowed) return this.finish(child, config, "skip", allowed);

    // Both reads in parallel: the child may already be running its first turn.
    const [parentRead, childRead] = await Promise.allSettled([
      api.agents.ref(child.parentId).refresh(),
      api.agents.ref(child.id).refresh(),
    ]);
    if (parentRead.status === "rejected") return this.finish(child, config, "skip", `sdk-error(parent): ${errorMessage(parentRead.reason)}`);
    const parent = parentRead.value?.agent ?? null;
    if (!parent) return this.finish(child, config, "skip", "parent-not-found");
    if (!isPmAgent(parent.labels, config)) return this.finish(child, config, "skip", "parent-not-pm");
    if (childRead.status === "rejected") return this.finish(child, config, "skip", `sdk-error(child): ${errorMessage(childRead.reason)}`);
    const snapshot = childRead.value?.agent ?? null;
    if (!snapshot) return this.finish(child, config, "skip", "child-not-found");
    if (snapshot.archivedAt) return this.finish(child, config, "skip", "child-already-archived");
    if (snapshot.labels?.[PARENT_AGENT_ID_LABEL] !== child.parentId) return this.finish(child, config, "skip", "parent-label-mismatch");
    if (!isNativeProvider(snapshot.provider, config.nativeProviders)) return this.finish(child, config, "skip", "child-not-native");

    const reason = "pm-created-native-worker";
    if (!config.armed) return this.finish(child, config, "would-archive", reason);

    // Reserve before acting: without a durable record the action is not idempotent.
    try {
      await this.deps.store.put(this.record(child, "archiving", reason), config.maxStateEntries);
    } catch (error) {
      this.emit("skip", { childId: child.id, parentId: child.parentId, provider: child.provider, reason: `state-write-failed: ${errorMessage(error)}` });
      return { action: "skip", reason: "state-write-failed" };
    }

    try {
      await api.agents.ref(child.id).archive();
    } catch (error) {
      return this.finish(child, config, "archive-failed", `archive threw: ${errorMessage(error)}`);
    }
    this.emit("archived", { childId: child.id, parentId: child.parentId, provider: child.provider, reason, childStatus: snapshot.status });

    const text = noticeText(child.id, child.provider, config.notice);
    const archived = this.record(child, "archived", reason, { notice: "pending", noticeText: text });
    try {
      await this.deps.store.put(archived, config.maxStateEntries);
    } catch (error) {
      this.emit("state-write-failed", { childId: child.id, reason: errorMessage(error), effect: "parent not notified" });
      return { action: "archived", reason };
    }
    await this.deliver(child.parentId, api, config, archived);
    return { action: "archived", reason };
  }

  /** Serialized per parent so concurrent archives and turn ends never send twice. */
  private deliver(parentId: string, api: GuardApi, config: GuardConfig, fresh: HandledRecord | null): Promise<void> {
    const previous = this.deliveries.get(parentId) ?? Promise.resolve();
    const current = previous
      .then(() => this.deliverOnce(parentId, api, config, fresh))
      .catch((error) => this.emit("notify-failed", { parentId, reason: errorMessage(error) }))
      .finally(() => {
        if (this.deliveries.get(parentId) === current) this.deliveries.delete(parentId);
      });
    this.deliveries.set(parentId, current);
    return current;
  }

  private async mark(records: readonly HandledRecord[], notice: NoticeState, config: GuardConfig): Promise<void> {
    for (const record of records) {
      try {
        await this.deps.store.put({ ...record, notice }, config.maxStateEntries);
      } catch (error) {
        this.emit("state-write-failed", { childId: record.childId, reason: errorMessage(error) });
      }
    }
  }

  private async deliverOnce(parentId: string, api: GuardApi, config: GuardConfig, fresh: HandledRecord | null): Promise<void> {
    const pending = await this.deps.store.pendingFor(parentId);
    if (pending.length === 0) return;
    const childIds = pending.map((record) => record.childId);
    let parent: AgentView | null;
    try {
      parent = (await api.agents.ref(parentId).refresh())?.agent ?? null;
    } catch (error) {
      // Unknown parent state: do not risk interrupting it. Retried at its next turn end.
      this.emit("notify-deferred", { parentId, childIds, reason: `sdk-error(parent): ${errorMessage(error)}` });
      return;
    }
    if (!parent || parent.archivedAt) {
      await this.mark(pending, "dropped", config);
      this.emit("notify-dropped", { parentId, childIds, reason: parent ? "parent-archived" : "parent-not-found" });
      return;
    }
    if (isBusy(parent)) {
      // Paseo has no queued send: a prompt to a mid-turn agent interrupts it. Leave a
      // timeline row now and send the notice when this PM's turn ends.
      if (fresh && pending.some((record) => record.childId === fresh.childId)) {
        try {
          await api.agents.ref(parentId).timeline.append({
            type: "plugin",
            id: `archived-${fresh.childId}`,
            kind: TIMELINE_KIND,
            version: 1,
            data: { childId: fresh.childId, provider: fresh.provider, message: fresh.noticeText ?? "" },
          });
        } catch (error) {
          this.emit("timeline-row-failed", { parentId, childId: fresh.childId, reason: errorMessage(error) });
        }
      }
      this.emit("notify-deferred", { parentId, childIds, reason: `parent-${parent.status}` });
      return;
    }
    const text = pending.map((record) => record.noticeText ?? noticeText(record.childId, record.provider, config.notice)).join("\n");
    try {
      await api.agents.ref(parentId).send(text);
    } catch (error) {
      await this.mark(pending, "failed", config);
      this.emit("notify-failed", { parentId, childIds, reason: errorMessage(error) });
      return;
    }
    await this.mark(pending, "sent", config);
    this.emit("notify-sent", { parentId, childIds });
  }
}

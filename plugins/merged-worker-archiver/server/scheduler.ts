import type { SweepResult } from "./sweeper.ts";

// Event-driven evaluation. Hooks only call note(); the work runs later off the hook's
// critical path (hooks abort after 30 s). Events are coalesced: a burst of turns within
// the debounce window becomes one scoped sweep (bounded by a max wait so a steady stream
// of turns cannot starve it). Worktrees that are clean and idle but not yet merged get a
// short, bounded chain of follow-up re-checks, because a merge often lands a moment
// after the turn that performed it ends.

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realTimers: Timers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
  now: () => Date.now(),
};

export interface SchedulerSettings {
  debounceMs: number;
  followUpDelaysMs: readonly number[];
}

export interface ScopedRun {
  triggerWorkspaceIds: ReadonlySet<string>;
  label: string;
  eventAt: number;
}

export interface EventSchedulerDeps {
  timers: Timers;
  /** Current settings, or null when settings are invalid (nothing is scheduled). */
  settings(): Promise<SchedulerSettings | null>;
  run(scope: ScopedRun): Promise<SweepResult | null>;
  log(line: string): void;
}

const MAX_WAIT_FACTOR = 4;
const MAX_FOLLOW_UPS = 64;
const MAX_PENDING_TRIGGERS = 256;

export class EventScheduler {
  private readonly deps: EventSchedulerDeps;
  private readonly pending = new Map<string, number | null>(); // workspaceId -> follow-up stage (null = event)
  private firstEventAt: number | null = null;
  private debounceTimer: unknown = null;
  private maxWaitTimer: unknown = null;
  private flushing: Promise<void> | null = null;
  private readonly followUps = new Map<string, unknown>();
  private stopped = false;

  constructor(deps: EventSchedulerDeps) {
    this.deps = deps;
  }

  /** Called from agent.turn_ended. Synchronous, cheap, never throws. */
  noteEvent(workspaceId: string): void {
    if (this.stopped) return;
    // A fresh event restarts any follow-up chain for this workspace.
    this.cancelFollowUp(workspaceId);
    this.enqueue(workspaceId, null);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) this.deps.timers.clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) this.deps.timers.clearTimeout(this.maxWaitTimer);
    for (const handle of this.followUps.values()) this.deps.timers.clearTimeout(handle);
    this.followUps.clear();
    this.pending.clear();
  }

  /** Resolves when any in-flight flush has finished (tests). */
  async idle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  private enqueue(workspaceId: string, stage: number | null): void {
    if (!this.pending.has(workspaceId) && this.pending.size >= MAX_PENDING_TRIGGERS) return;
    const existing = this.pending.get(workspaceId);
    // An event beats a follow-up; between follow-ups keep the earliest stage.
    if (existing === undefined || stage === null || (existing !== null && stage < existing)) {
      this.pending.set(workspaceId, stage);
    }
    if (this.firstEventAt === null) this.firstEventAt = this.deps.timers.now();
    void this.arm();
  }

  private async arm(): Promise<void> {
    const settings = await this.deps.settings();
    if (!settings || this.stopped) return;
    if (this.debounceTimer) this.deps.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.deps.timers.setTimeout(() => this.fire(), settings.debounceMs);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = this.deps.timers.setTimeout(() => this.fire(), Math.max(settings.debounceMs * MAX_WAIT_FACTOR, 1));
    }
  }

  private fire(): void {
    if (this.debounceTimer) this.deps.timers.clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) this.deps.timers.clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    if (this.stopped || this.pending.size === 0) return;
    const batch = new Map(this.pending);
    const eventAt = this.firstEventAt ?? this.deps.timers.now();
    this.pending.clear();
    this.firstEventAt = null;
    const previous = this.flushing ?? Promise.resolve();
    const current: Promise<void> = previous
      .then(() => this.flush(batch, eventAt))
      .catch((error) => this.deps.log(`[merged-worker-archiver] event-flush-failed ${JSON.stringify(String(error))}`))
      .finally(() => {
        if (this.flushing === current) this.flushing = null;
      });
    this.flushing = current;
  }

  private async flush(batch: Map<string, number | null>, eventAt: number): Promise<void> {
    if (this.stopped) return;
    const stages = [...batch.values()];
    const label = stages.every((stage) => stage !== null)
      ? `follow-up(${[...new Set(stages)].map((stage) => `#${(stage as number) + 1}`).join(",")})`
      : "agent.turn_ended";
    const result = await this.deps.run({ triggerWorkspaceIds: new Set(batch.keys()), label, eventAt });
    if (!result || result.error || this.stopped) return;
    const settings = await this.deps.settings();
    if (!settings) return;
    const pendingMerge = new Set(result.pendingMerge);
    for (const decision of result.decisions) {
      if (!pendingMerge.has(decision.workspaceId)) this.cancelFollowUp(decision.workspaceId);
    }
    for (const workspaceId of pendingMerge) {
      const triggeredStage = batch.get(workspaceId);
      const next = triggeredStage === undefined || triggeredStage === null ? 0 : triggeredStage + 1;
      // A workspace re-found by a new event while its chain runs keeps its chain.
      if (triggeredStage === undefined && this.followUps.has(workspaceId)) continue;
      this.scheduleFollowUp(workspaceId, next, settings.followUpDelaysMs);
    }
  }

  private scheduleFollowUp(workspaceId: string, stage: number, delaysMs: readonly number[]): void {
    this.cancelFollowUp(workspaceId);
    const delay = delaysMs[stage];
    if (delay === undefined) {
      this.deps.log(`[merged-worker-archiver] follow-ups-exhausted ${JSON.stringify({ workspaceId })}`);
      return;
    }
    if (this.followUps.size >= MAX_FOLLOW_UPS) return;
    const handle = this.deps.timers.setTimeout(() => {
      this.followUps.delete(workspaceId);
      this.enqueue(workspaceId, stage);
    }, delay);
    this.followUps.set(workspaceId, handle);
  }

  private cancelFollowUp(workspaceId: string): void {
    const handle = this.followUps.get(workspaceId);
    if (handle === undefined) return;
    this.deps.timers.clearTimeout(handle);
    this.followUps.delete(workspaceId);
  }

  /** Test visibility. */
  pendingFollowUps(): string[] {
    return [...this.followUps.keys()];
  }
}

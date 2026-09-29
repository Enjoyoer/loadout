export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: TimerApi = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) { clearTimeout(handle as NodeJS.Timeout); },
};

export type PendingTimer = { key: string; agentId: string; handle: unknown };

export class AgentTimers {
  private readonly pending = new Map<string, PendingTimer>();
  private readonly timers: TimerApi;
  constructor(timers: TimerApi) { this.timers = timers; }
  schedule(key: string, agentId: string, delayMs: number, callback: () => void): void {
    this.cancel(agentId);
    const handle = this.timers.setTimeout(() => {
      this.pending.delete(agentId);
      callback();
    }, delayMs);
    this.pending.set(agentId, { key, agentId, handle });
  }
  cancel(agentId: string): boolean {
    const timer = this.pending.get(agentId);
    if (!timer) return false;
    this.timers.clearTimeout(timer.handle);
    this.pending.delete(agentId);
    return true;
  }
  cancelAll(): void {
    for (const agentId of this.pending.keys()) this.cancel(agentId);
  }
  has(agentId: string): boolean { return this.pending.has(agentId); }
  key(agentId: string): string | null { return this.pending.get(agentId)?.key ?? null; }
}

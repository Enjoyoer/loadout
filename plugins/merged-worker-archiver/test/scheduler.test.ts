import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventScheduler, type ScopedRun, type Timers } from "../server/scheduler.ts";
import type { SweepResult } from "../server/sweeper.ts";
import type { Decision } from "../server/types.ts";

class FakeTimers implements Timers {
  private current = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  now() {
    return this.current;
  }
  setTimeout(callback: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.current + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  /** Advance time, firing due timers in order; lets async work settle between them. */
  async advance(ms: number) {
    const target = this.current + ms;
    for (;;) {
      await settle();
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      due[1].callback();
    }
    this.current = target;
    await settle();
  }
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const decision = (workspaceId: string, reason: string): Decision => ({
  workspaceId,
  workspaceName: workspaceId,
  agentIds: [],
  branch: "b",
  base: "main",
  action: reason.startsWith("merged") ? "archive" : "skip",
  reason,
  candidate: true,
});

function setup(outcomes: (scope: ScopedRun, call: number) => { pendingMerge: string[]; decisions?: Decision[] }, settingsValid = true) {
  const timers = new FakeTimers();
  const runs: Array<ScopedRun & { at: number }> = [];
  const lines: string[] = [];
  const scheduler = new EventScheduler({
    timers,
    log: (line) => lines.push(line),
    settings: async () => (settingsValid ? { debounceMs: 3000, followUpDelaysMs: [15_000, 60_000, 180_000] } : null),
    run: async (scope) => {
      runs.push({ ...scope, at: timers.now() });
      const outcome = outcomes(scope, runs.length);
      const result: SweepResult = {
        decisions: outcome.decisions ?? outcome.pendingMerge.map((id) => decision(id, "not-merged(ahead=1)")),
        archived: [],
        pendingMerge: outcome.pendingMerge,
        error: null,
      };
      return result;
    },
  });
  return { timers, runs, lines, scheduler };
}

describe("EventScheduler", () => {
  it("noteEvent returns synchronously and evaluates after the debounce", async () => {
    const { timers, runs, scheduler } = setup(() => ({ pendingMerge: [] }));
    scheduler.noteEvent("pm");
    assert.equal(runs.length, 0);
    await timers.advance(2999);
    assert.equal(runs.length, 0);
    await timers.advance(1);
    assert.equal(runs.length, 1);
    assert.deepEqual([...runs[0]!.triggerWorkspaceIds], ["pm"]);
    assert.equal(runs[0]!.label, "agent.turn_ended");
    assert.equal(runs[0]!.eventAt, 0);
  });

  it("coalesces a burst of turns into one evaluation", async () => {
    const { timers, runs, scheduler } = setup(() => ({ pendingMerge: [] }));
    for (const id of ["pm", "w1", "pm", "w2"]) {
      scheduler.noteEvent(id);
      await timers.advance(1000);
    }
    await timers.advance(3000);
    assert.equal(runs.length, 1);
    assert.deepEqual([...runs[0]!.triggerWorkspaceIds].sort(), ["pm", "w1", "w2"]);
  });

  it("a steady stream cannot starve evaluation (max wait = 4 x debounce)", async () => {
    const { timers, runs, scheduler } = setup(() => ({ pendingMerge: [] }));
    for (let i = 0; i < 10; i += 1) {
      scheduler.noteEvent(`w${i}`);
      await timers.advance(2000);
    }
    assert.ok(runs.length >= 1);
    assert.equal(runs[0]!.at, 12_000);
  });

  it("schedules bounded follow-ups at 15 s, 60 s, 180 s for a pending merge, then stops", async () => {
    const { timers, runs, lines, scheduler } = setup(() => ({ pendingMerge: ["w"] }));
    scheduler.noteEvent("pm");
    await timers.advance(3000);
    await timers.advance(15_000 + 3000);
    await timers.advance(60_000 + 3000);
    await timers.advance(180_000 + 3000);
    await timers.advance(3_600_000);
    assert.deepEqual(
      runs.map((run) => [run.label, run.at]),
      [
        ["agent.turn_ended", 3000],
        ["follow-up(#1)", 21_000],
        ["follow-up(#2)", 84_000],
        ["follow-up(#3)", 267_000],
      ],
    );
    assert.ok(lines.some((line) => line.includes("follow-ups-exhausted")));
    assert.deepEqual(scheduler.pendingFollowUps(), []);
  });

  it("stops following up once the worktree is merged (archived)", async () => {
    const { timers, runs, scheduler } = setup((_scope, call) =>
      call === 1 ? { pendingMerge: ["w"] } : { pendingMerge: [], decisions: [decision("w", "merged-pr(#1)")] },
    );
    scheduler.noteEvent("pm");
    await timers.advance(3000 + 15_000 + 3000);
    await timers.advance(1_000_000);
    assert.equal(runs.length, 2);
    assert.deepEqual(scheduler.pendingFollowUps(), []);
  });

  it("does nothing while settings are invalid", async () => {
    const { timers, runs, scheduler } = setup(() => ({ pendingMerge: [] }), false);
    scheduler.noteEvent("pm");
    await timers.advance(100_000);
    assert.equal(runs.length, 0);
  });

  it("stop() cancels pending evaluations and follow-ups", async () => {
    const { timers, runs, scheduler } = setup(() => ({ pendingMerge: ["w"] }));
    scheduler.noteEvent("pm");
    await timers.advance(3000);
    scheduler.stop();
    scheduler.noteEvent("pm");
    await timers.advance(1_000_000);
    assert.equal(runs.length, 1);
  });
});

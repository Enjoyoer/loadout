import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentTimers, type TimerApi } from "../server/timer.ts";

class FakeTimers implements TimerApi {
  private next = 0;
  readonly callbacks = new Map<number, () => void>();
  setTimeout(callback: () => void, _ms: number) { const id = ++this.next; this.callbacks.set(id, callback); return id; }
  clearTimeout(handle: unknown) { this.callbacks.delete(handle as number); }
  fireAll() { for (const [id, callback] of [...this.callbacks]) { this.callbacks.delete(id); callback(); } }
}

describe("AgentTimers", () => {
  it("keeps one timer per agent and cancels on replacement", () => {
    const fake = new FakeTimers();
    const timers = new AgentTimers(fake);
    const fired: string[] = [];
    timers.schedule("turn-1", "a", 10, () => fired.push("old"));
    timers.schedule("turn-2", "a", 10, () => fired.push("new"));
    assert.equal(timers.key("a"), "turn-2");
    fake.fireAll();
    assert.deepEqual(fired, ["new"]);
  });
  it("cancels a timer on a new turn and all timers during cleanup", () => {
    const fake = new FakeTimers();
    const timers = new AgentTimers(fake);
    let fired = 0;
    timers.schedule("one", "a", 1, () => fired++);
    timers.schedule("two", "b", 1, () => fired++);
    assert.equal(timers.cancel("a"), true);
    timers.cancelAll();
    fake.fireAll();
    assert.equal(fired, 0);
    assert.equal(timers.cancel("missing"), false);
  });
  it("supports bounded replacement retries", () => {
    const fake = new FakeTimers();
    const timers = new AgentTimers(fake);
    const fired: number[] = [];
    for (let retry = 1; retry <= 3; retry++) {
      timers.schedule(`turn-1:retry-${retry}`, "a", 120_000, () => fired.push(retry));
    }
    assert.equal(timers.key("a"), "turn-1:retry-3");
    fake.fireAll();
    assert.deepEqual(fired, [3]);
  });
});

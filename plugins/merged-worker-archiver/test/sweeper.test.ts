import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultConfig } from "../server/config.ts";
import { Sweeper, type ArchiverApi } from "../server/sweeper.ts";
import type { AgentView, WorkspaceView } from "../server/types.ts";
import { agent, fakeFs, fakePeers, fakeRunner, LONG_AGO, memoryNotifyStore, NOW, scenario, workspace, type PeerFixtureAgent } from "./fakes.ts";

it("with the default cap, one sweep over 7 eligible candidates archives 5 and reports 2 deferred; the next sweep archives the 2", async () => {
  const workspaces = Array.from({ length: 7 }, (_, i) => workspace({ id: `wks_${i}`, name: `worker-${i}` }));
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const archiveCalls: string[] = [];
  // Archived workspaces (and their agents) are gone from later listings, as in Paseo.
  const live = () => workspaces.filter((ws) => !archiveCalls.includes(ws.id));
  const api: ArchiverApi = {
    workspaces: {
      list: async () => page(live()),
      archive: async (workspaceId) => {
        archiveCalls.push(workspaceId);
        return { archivedAt: new Date(NOW).toISOString(), error: null };
      },
    },
    agents: { list: async () => page(live().map((ws) => ({ agent: agent({ id: `agent-${ws.id}`, workspaceId: ws.id }) }))) },
    projects: { list: async () => ({ projects: [] }) },
    terminals: { list: async () => ({ entries: [] }) },
    supportsBackgroundWorkspaces: () => false,
  };
  const s = scenario({ ancestors: { "refs/heads/main": 0 } });
  const fs = fakeFs(s);
  const lines: string[] = [];
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api, release: async () => undefined }),
    log: (line) => lines.push(line),
    fs,
    merge: { run: fakeRunner(s), fs },
    resolveCommonDir: async () => null,
    now: () => NOW,
    notifyStore: memoryNotifyStore(),
  });
  const actions = () => lines.filter((line) => !line.includes("sweep-done")).map((line) => JSON.parse(line.replace(/^\[merged-worker-archiver\] /, "")).action);
  const sweepDone = () => JSON.parse(lines.find((line) => line.includes("sweep-done"))!.replace(/^\[merged-worker-archiver\] sweep-done /, ""));

  // The default config is dry-run: it previews exactly what an armed sweep would do.
  await sweeper.sweep(defaultConfig(), { trigger: "test" });
  assert.deepEqual(actions(), [...Array(5).fill("would-archive"), "deferred", "deferred"]);
  assert.deepEqual(sweepDone().counts, { archive: 5, deferred: 2 });
  assert.equal(sweepDone().deferred, 2);
  assert.deepEqual(archiveCalls, []);

  lines.length = 0;
  const result = await sweeper.sweep(defaultConfig({ armed: true }), { trigger: "test" });
  assert.deepEqual(result.archived, ["wks_0", "wks_1", "wks_2", "wks_3", "wks_4"]);
  assert.deepEqual(archiveCalls, result.archived);
  assert.deepEqual(actions(), [...Array(5).fill("archived"), "deferred", "deferred"]);
  assert.deepEqual(sweepDone().counts, { archive: 5, deferred: 2 });
  assert.equal(sweepDone().deferred, 2);

  // The first five are gone from the list, so the deferred two are archived next.
  lines.length = 0;
  const next = await sweeper.sweep(defaultConfig({ armed: true }), { trigger: "test" });
  assert.deepEqual(next.archived, ["wks_5", "wks_6"]);
  assert.deepEqual(actions(), ["archived", "archived"]);
  assert.deepEqual(sweepDone().counts, { archive: 2 });
  assert.equal(sweepDone().deferred, 0);
  assert.equal(archiveCalls.length, 7);
});

/**
 * Armed sweeps over a stable listing in which archived workspaces disappear, as in Paseo.
 * `failure` says how a workspace's archive call fails, or null for a call that succeeds.
 */
function armedSweeps(workspaces: WorkspaceView[], failure: (workspaceId: string) => "error" | "throw" | null) {
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const archivedIds = new Set<string>();
  const live = () => workspaces.filter((ws) => !archivedIds.has(ws.id));
  const calls: string[] = [];
  const api: ArchiverApi = {
    workspaces: {
      list: async () => page(live()),
      archive: async (workspaceId) => {
        calls.push(workspaceId);
        const mode = failure(workspaceId);
        if (mode === "throw") throw new Error("socket closed");
        if (mode === "error") return { archivedAt: null, error: "teardown failed" };
        archivedIds.add(workspaceId);
        return { archivedAt: new Date(NOW).toISOString(), error: null };
      },
    },
    agents: { list: async () => page(live().map((ws) => ({ agent: agent({ id: `agent-${ws.id}`, workspaceId: ws.id }) }))) },
    projects: { list: async () => ({ projects: [] }) },
    terminals: { list: async () => ({ entries: [] }) },
    supportsBackgroundWorkspaces: () => false,
  };
  const s = scenario({ ancestors: { "refs/heads/main": 0 } });
  const fs = fakeFs(s);
  const lines: string[] = [];
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api, release: async () => undefined }),
    log: (line) => lines.push(line),
    fs,
    merge: { run: fakeRunner(s), fs },
    resolveCommonDir: async () => null,
    now: () => NOW,
    notifyStore: memoryNotifyStore(),
  });
  return async () => {
    lines.length = 0;
    calls.length = 0;
    const result = await sweeper.sweep(defaultConfig({ armed: true }), { trigger: "test" });
    const entries = lines.filter((line) => !line.includes("sweep-done")).map((line) => JSON.parse(line.replace(/^\[merged-worker-archiver\] /, "")));
    const done = JSON.parse(lines.find((line) => line.includes("sweep-done"))!.replace(/^\[merged-worker-archiver\] sweep-done /, ""));
    return { result, entries, actions: entries.map((entry) => entry.action as string), done, calls: [...calls] };
  };
}

it("5 candidates whose archive call always fails stop taking the cap: 2 good candidates are archived within 2 armed sweeps, and the failing 5 are retried once their back-off ends", async () => {
  const bad = Array.from({ length: 5 }, (_, i) => workspace({ id: `wks_bad_${i}`, name: `bad-${i}` }));
  const good = Array.from({ length: 2 }, (_, i) => workspace({ id: `wks_good_${i}`, name: `good-${i}` }));
  // Both failure shapes: an error result and a thrown call.
  const sweep = armedSweeps([...bad, ...good], (id) => (id === "wks_bad_3" || id === "wks_bad_4" ? "throw" : id.startsWith("wks_bad_") ? "error" : null));
  const badIds = bad.map((ws) => ws.id);

  // Sweep 1: the failing five come first and use the whole cap; the good two are deferred.
  let s = await sweep();
  assert.deepEqual(s.calls, badIds);
  assert.deepEqual(s.result.archived, []);
  assert.deepEqual(s.actions, [...Array(5).fill("archive-failed"), "deferred", "deferred"]);
  assert.match(s.entries[0].reason, /; archive error: teardown failed; back-off 1 sweep\(s\)$/);
  assert.match(s.entries[3].reason, /; archive threw: socket closed; back-off 1 sweep\(s\)$/);
  assert.deepEqual(s.done.counts, { archive: 5, deferred: 2 });
  assert.equal(s.done.deferred, 2);
  assert.equal(s.done.backoff, 0);

  // Sweep 2: the deferred two go first and are archived; the failing five sit out their back-off without a slot.
  s = await sweep();
  assert.deepEqual(s.calls, ["wks_good_0", "wks_good_1"]);
  assert.deepEqual(s.result.archived, ["wks_good_0", "wks_good_1"]);
  assert.deepEqual(s.actions, ["archived", "archived", ...Array(5).fill("backoff")]);
  assert.match(s.entries[2].reason, /; archive back-off sweep 1\/1 after 1 failed archive call\(s\)$/);
  assert.deepEqual(s.done.counts, { archive: 2, backoff: 5 });
  assert.equal(s.done.deferred, 0);
  assert.equal(s.done.backoff, 5);

  // Sweep 3: the back-off has ended, so the failing five are retried; they fail again.
  s = await sweep();
  assert.deepEqual(s.calls, badIds);
  assert.deepEqual(s.actions, Array(5).fill("archive-failed"));
  assert.match(s.entries[0].reason, /; back-off 2 sweep\(s\)$/);
  assert.deepEqual(s.done.counts, { archive: 5 });

  // Each further failure doubles the wait (2, 4, then at most 8 sweeps), and after every wait they are retried.
  for (const [failures, wait] of [[2, 2], [3, 4], [4, 8], [5, 8]] as const) {
    for (let n = 1; n <= wait; n += 1) {
      s = await sweep();
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.actions, Array(5).fill("backoff"));
      assert.match(s.entries[0].reason, new RegExp(`; archive back-off sweep ${n}/${wait} after ${failures} failed archive call\\(s\\)$`));
    }
    s = await sweep();
    assert.deepEqual(s.calls, badIds);
    assert.match(s.entries[0].reason, new RegExp(`; back-off ${Math.min(2 * wait, 8)} sweep\\(s\\)$`));
  }
});

it("with the cap at 5, 45 always-failing candidates listed ahead of 1 healthy one cannot defer it forever: it is attempted within ceil(45/5)+1 sweeps", async () => {
  const failing = Array.from({ length: 45 }, (_, i) => workspace({ id: `wks_fail_${String(i).padStart(2, "0")}`, name: `fail-${i}` }));
  const healthy = workspace({ id: "wks_healthy", name: "healthy" });
  const sweep = armedSweeps([...failing, healthy], (id) => (id === "wks_healthy" ? null : "error"));
  const bound = Math.ceil(45 / 5) + 1;

  let attemptedIn: number | null = null;
  for (let n = 1; n <= bound && attemptedIn === null; n += 1) {
    const s = await sweep();
    // The cap holds, and every evaluated workspace is counted once, matching the decision lines.
    const lines = (action: string) => s.actions.filter((a) => a === action).length;
    assert.ok(s.calls.length <= 5, `sweep ${n} made ${s.calls.length} archive calls`);
    assert.equal(s.done.evaluated, 46);
    assert.equal(Object.values<number>(s.done.counts).reduce((sum, count) => sum + count, 0), 46);
    assert.equal(s.done.counts.archive ?? 0, s.calls.length);
    assert.equal(s.done.counts.deferred ?? 0, lines("deferred"));
    assert.equal(s.done.deferred, lines("deferred"));
    assert.equal(s.done.counts.backoff ?? 0, lines("backoff"));
    assert.equal(s.done.backoff, lines("backoff"));
    const healthyAction = s.entries.find((entry) => entry.workspaceId === "wks_healthy").action;
    if (s.calls.includes("wks_healthy")) {
      attemptedIn = n;
      assert.equal(healthyAction, "archived");
      assert.deepEqual(s.result.archived, ["wks_healthy"]);
    } else {
      assert.equal(healthyAction, "deferred");
    }
  }
  assert.ok(attemptedIn !== null, `the healthy workspace was not attempted within ${bound} sweeps`);
});

it("workspace cleanup previews until armWorkspaceCleanup is also on, then archives the stale record and tells the PM about the kept worktree once", async () => {
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const workspaces = [
    workspace({ id: "wks_pm", name: "pm-home", workspaceKind: "local_checkout", workspaceDirectory: "/pm" }),
    workspace({ id: "wks_local", name: "old-checkout", workspaceKind: "local_checkout", workspaceDirectory: "/checkout" }),
    workspace({ id: "wks_wt", name: "kept-worktree" }),
  ];
  const agents = [
    agent({ id: "pm-0001", workspaceId: "wks_pm", labels: { role: "pm", project: "demo" } }),
    agent({ id: "worker-0001", workspaceId: "wks_wt", archivedAt: LONG_AGO, labels: { role: "worker", "paseo.parent-agent-id": "pm-0001" } }),
  ];
  const archivedIds = new Set<string>();
  const sends: Array<{ agentId: string; messageId: string }> = [];
  const api: ArchiverApi = {
    workspaces: {
      list: async () => page(workspaces.filter((ws) => !archivedIds.has(ws.id))),
      archive: async (workspaceId) => {
        archivedIds.add(workspaceId);
        return { archivedAt: new Date(NOW).toISOString(), error: null };
      },
    },
    agents: {
      list: async (options) => page(agents.filter((entry) => options?.filter?.includeArchived || !entry.archivedAt).map((entry) => ({ agent: entry }))),
      get: async (agentId) => agents.find((entry) => entry.id === agentId) ?? null,
    },
    projects: { list: async () => ({ projects: [] }) },
    terminals: { list: async () => ({ entries: [] }) },
    supportsBackgroundWorkspaces: () => false,
    sendAgentMessage: async (agentId, _text, options) => {
      sends.push({ agentId, messageId: options.messageId });
    },
  };
  const s = scenario();
  const fs = fakeFs(s);
  const notifyStore = memoryNotifyStore();
  const lines: string[] = [];
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api, release: async () => undefined }),
    log: (line) => lines.push(line),
    fs,
    merge: { run: fakeRunner(s), fs },
    resolveCommonDir: async () => null,
    now: () => NOW,
    notifyStore,
  });
  const sweep = async (overrides: Record<string, unknown>) => {
    lines.length = 0;
    await sweeper.sweep(defaultConfig({ useGh: false, staleWorkspaceMinutes: 60, logNonCandidates: true, ...overrides }), { trigger: "test" });
    return lines
      .filter((line) => line.startsWith("[merged-worker-archiver] {"))
      .map((line) => JSON.parse(line.replace(/^\[merged-worker-archiver\] /, "")))
      .filter((entry) => entry.cleanup)
      .map((entry) => `${entry.action} ${entry.workspaceId}`);
  };

  // Dry-run by default, and arming worker archiving alone does not arm cleanup.
  for (const overrides of [{}, { armed: true }]) {
    assert.deepEqual(await sweep(overrides), ["skip wks_pm", "would-archive wks_local", "would-notify wks_wt"]);
    assert.deepEqual([...archivedIds], []);
    assert.deepEqual(sends, []);
    assert.equal(notifyStore.writes, 0);
  }

  assert.deepEqual(await sweep({ armed: true, armWorkspaceCleanup: true }), ["skip wks_pm", "archived wks_local", "notified wks_wt"]);
  assert.deepEqual([...archivedIds], ["wks_local"]);
  assert.deepEqual(sends.map((send) => send.agentId), ["pm-0001"]);
  assert.equal(notifyStore.entries.get("wks_wt")?.status, "sent");

  // Once per worktree: the next armed sweep keeps it and sends nothing.
  assert.deepEqual(await sweep({ armed: true, armWorkspaceCleanup: true }), ["skip wks_pm", "skip wks_wt"]);
  assert.equal(sends.length, 1);
});

it("an agent history listing that fails leaves out workspace cleanup only: the worker sweep still archives", async () => {
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const workspaces = [workspace({ id: "wks_worker" }), workspace({ id: "wks_local", workspaceKind: "local_checkout", workspaceDirectory: "/checkout" })];
  const archiveCalls: string[] = [];
  const api: ArchiverApi = {
    workspaces: {
      list: async () => page(workspaces.filter((ws) => !archiveCalls.includes(ws.id))),
      archive: async (workspaceId) => {
        archiveCalls.push(workspaceId);
        return { archivedAt: new Date(NOW).toISOString(), error: null };
      },
    },
    agents: {
      list: async (options) => {
        if (options?.filter?.includeArchived) throw new Error("agent history exceeded 50 pages");
        return page([{ agent: agent({ id: "agent-worker", workspaceId: "wks_worker" }) }]);
      },
    },
    projects: { list: async () => ({ projects: [] }) },
    terminals: { list: async () => ({ entries: [] }) },
    supportsBackgroundWorkspaces: () => false,
  };
  const s = scenario({ ancestors: { "refs/heads/main": 0 } });
  const fs = fakeFs(s);
  const lines: string[] = [];
  const notifyStore = memoryNotifyStore();
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api, release: async () => undefined }),
    log: (line) => lines.push(line),
    fs,
    merge: { run: fakeRunner(s), fs },
    resolveCommonDir: async () => null,
    now: () => NOW,
    notifyStore,
  });
  const result = await sweeper.sweep(defaultConfig({ armed: true, armWorkspaceCleanup: true, staleWorkspaceMinutes: 60 }), { trigger: "test" });
  assert.equal(result.error, null);
  assert.deepEqual(archiveCalls, ["wks_worker"]);
  assert.ok(lines.some((line) => line.startsWith("[merged-worker-archiver] cleanup-skipped ") && line.includes("agent history exceeded 50 pages")));
  const done = JSON.parse(lines.find((line) => line.includes("sweep-done"))!.replace(/^\[merged-worker-archiver\] sweep-done /, ""));
  assert.equal(done.cleanupSkipped, "agent history exceeded 50 pages");
  assert.equal(notifyStore.writes, 0);
});

/**
 * Armed workspace cleanup over kept (unmerged) agentless worktrees, each with one archived worker carrying
 * `labels`. This daemon's only PM works on project "other"; `peers` are the fixture peer daemons.
 */
function peerCleanup(options: { worktrees: Array<{ id: string; labels: Record<string, string> }>; peers: Record<string, PeerFixtureAgent[] | "down">; peerHosts: string[] }) {
  const page = <T>(entries: T[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const workspaces = [
    workspace({ id: "wks_pm", name: "pm-home", workspaceKind: "local_checkout", workspaceDirectory: "/pm" }),
    ...options.worktrees.map((wt) => workspace({ id: wt.id, name: wt.id })),
  ];
  const agents: AgentView[] = [
    agent({ id: "pm-local-0001", workspaceId: "wks_pm", labels: { role: "pm", project: "other" } }),
    ...options.worktrees.map((wt) => agent({ id: `worker-${wt.id}`, workspaceId: wt.id, archivedAt: LONG_AGO, labels: { role: "worker", ...wt.labels } })),
  ];
  const localSends: Array<{ agentId: string; text: string }> = [];
  const api: ArchiverApi = {
    workspaces: { list: async () => page(workspaces), archive: async () => ({ archivedAt: null, error: "not expected" }) },
    agents: {
      list: async (request) => page(agents.filter((entry) => request?.filter?.includeArchived || !entry.archivedAt).map((entry) => ({ agent: entry }))),
      get: async (agentId) => agents.find((entry) => entry.id === agentId) ?? null,
    },
    projects: { list: async () => ({ projects: [] }) },
    terminals: { list: async () => ({ entries: [] }) },
    supportsBackgroundWorkspaces: () => false,
    sendAgentMessage: async (agentId, text) => {
      localSends.push({ agentId, text });
    },
  };
  const s = scenario();
  const fs = fakeFs(s);
  const notifyStore = memoryNotifyStore();
  const peer = fakePeers(options.peers);
  const lines: string[] = [];
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api, release: async () => undefined }),
    log: (line) => lines.push(line),
    fs,
    merge: { run: fakeRunner(s), fs },
    resolveCommonDir: async () => null,
    now: () => NOW,
    notifyStore,
    peerConnector: peer.connect,
  });
  const sweep = async () => {
    lines.length = 0;
    const result = await sweeper.sweep(defaultConfig({ armed: true, armWorkspaceCleanup: true, useGh: false, staleWorkspaceMinutes: 60, peerHosts: options.peerHosts }), { trigger: "test" });
    const entries = lines.filter((line) => line.startsWith("[merged-worker-archiver] {")).map((line) => JSON.parse(line.replace(/^\[merged-worker-archiver\] /, "")));
    return { result, entries, lines: [...lines] };
  };
  return { sweep, localSends, peer, notifyStore };
}

it("peer routing: a kept worktree with no PM on this daemon is reported to its parent, by full id, on a peer", async () => {
  const t = peerCleanup({
    worktrees: [{ id: "wks_wt", labels: { "paseo.parent-agent-id": "pm-peer-0001", project: "demo" } }],
    peers: {
      "ssh://peer-a": [{ id: "pm-a-0001", labels: { role: "pm", project: "demo" } }],
      "ssh://peer-b": [{ id: "pm-peer-0001", labels: { role: "pm", project: "elsewhere" } }],
    },
    peerHosts: ["ssh://peer-a", "ssh://peer-b"],
  });
  const { entries } = await t.sweep();
  // The parent wins over another peer's project PM.
  const notified = entries.find((entry) => entry.action === "notified");
  assert.equal(notified?.workspaceId, "wks_wt");
  assert.equal(notified?.host, "ssh://peer-b");
  assert.equal(notified?.owner, "pm-peer-0001");
  assert.equal(notified?.via, "peer-parent");
  assert.deepEqual(t.peer.sent.map((send) => `${send.host} ${send.agentId}`), ["ssh://peer-b pm-peer-0001"]);
  assert.match(t.peer.sent[0]!.text, /\(wks_wt\)/);
  assert.deepEqual(t.localSends, []);
  assert.deepEqual(t.notifyStore.entries.get("wks_wt"), { at: new Date(NOW).toISOString(), agentId: "pm-peer-0001", status: "sent", host: "ssh://peer-b" });

  // Once per worktree, as for a PM on this daemon.
  await t.sweep();
  assert.equal(t.peer.sent.length, 1);
});

it("peer routing: with no parent there, the one live role=pm agent of the project on the peers gets the report", async () => {
  const t = peerCleanup({
    worktrees: [{ id: "wks_wt", labels: { project: "Demo" } }],
    peers: {
      "ssh://peer-a": [{ id: "worker-a-0001", labels: { role: "worker", project: "demo" } }],
      "ssh://peer-b": [
        { id: "pm-b-0001", labels: { role: "pm", project: "demo" } },
        { id: "pm-b-old", archived: true, labels: { role: "pm", project: "demo" } },
      ],
    },
    peerHosts: ["ssh://peer-a", "ssh://peer-b"],
  });
  const { entries } = await t.sweep();
  const notified = entries.find((entry) => entry.action === "notified");
  assert.equal(notified?.host, "ssh://peer-b");
  assert.equal(notified?.owner, "pm-b-0001");
  assert.equal(notified?.via, "peer-project-pm");
  assert.deepEqual(t.peer.sent.map((send) => `${send.host} ${send.agentId}`), ["ssh://peer-b pm-b-0001"]);
  assert.equal(t.notifyStore.entries.get("wks_wt")?.host, "ssh://peer-b");
});

it("peer routing: a project PM on more than one peer is ambiguous, so the worktree is unrouted and nothing is recorded", async () => {
  const t = peerCleanup({
    worktrees: [{ id: "wks_wt", labels: { project: "demo" } }],
    peers: {
      "ssh://peer-a": [{ id: "pm-a-0001", labels: { role: "pm", project: "demo" } }],
      "ssh://peer-b": [{ id: "pm-b-0001", labels: { role: "pm", project: "demo" } }],
    },
    peerHosts: ["ssh://peer-a", "ssh://peer-b"],
  });
  const { entries } = await t.sweep();
  const unrouted = entries.filter((entry) => entry.action === "notify-unrouted");
  assert.equal(unrouted.length, 1);
  assert.equal(unrouted[0].workspaceId, "wks_wt");
  assert.match(unrouted[0].owner, /several owners on peers: ssh:\/\/peer-a pm-a-0001,ssh:\/\/peer-b pm-b-0001$/);
  assert.deepEqual(unrouted[0].peers, ["ssh://peer-a", "ssh://peer-b"]);
  assert.deepEqual(t.peer.sent, []);
  assert.deepEqual(t.localSends, []);
  assert.equal(t.notifyStore.writes, 0);
});

it("peer routing: an unreachable peer is asked once, logged, and leaves this daemon's report unaffected", async () => {
  const t = peerCleanup({
    worktrees: [
      { id: "wks_remote", labels: { project: "demo" } },
      { id: "wks_local", labels: { "paseo.parent-agent-id": "pm-local-0001" } },
    ],
    peers: { "ssh://peer-down": "down" },
    peerHosts: ["ssh://peer-down"],
  });
  const { result, entries } = await t.sweep();
  assert.equal(result.error, null);
  assert.deepEqual(t.localSends.map((send) => send.agentId), ["pm-local-0001"]);
  assert.match(t.localSends[0]!.text, /wks_local/);
  assert.doesNotMatch(t.localSends[0]!.text, /wks_remote/);
  assert.deepEqual(t.notifyStore.entries.get("wks_local"), { at: new Date(NOW).toISOString(), agentId: "pm-local-0001", status: "sent" });
  assert.equal(t.notifyStore.entries.has("wks_remote"), false);

  assert.deepEqual(t.peer.connects, ["ssh://peer-down"]);
  const peerErrors = entries.filter((entry) => entry.action === "notify-peer-error");
  assert.deepEqual(peerErrors, [{ action: "notify-peer-error", peer: "ssh://peer-down", query: "connect", error: "cannot connect: ssh: Could not resolve hostname peer-down" }]);
  const unrouted = entries.find((entry) => entry.action === "notify-unrouted");
  assert.equal(unrouted?.workspaceId, "wks_remote");
  assert.match(unrouted?.owner, /owner unknown on peers: no role=pm agent on the peers that answered, and unreachable: ssh:\/\/peer-down$/);
  assert.deepEqual(unrouted?.peerErrors, { "ssh://peer-down": peerErrors[0]!.error });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import type { PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import contribute from "../index.server.ts";
import { ConfigSchema } from "../server/config.ts";
import { buildFailedTransientRecord, buildRecord, quotaDecision, scheduleUsage, shouldResume, supersedeForNewUserTurn, type AgentSnapshot } from "../server/model.ts";
import { agentPool, poolQuota, QuotaReader } from "../server/quota.ts";
import { ResumeStore } from "../server/store.ts";

// Fixture identities and dates only. Preserve the incident's order and intervals, not host data.
const at = (time: string) => Date.parse(`2026-01-02T${time}Z`);
const RATE_LIMIT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} (stopReason=error, model=fleet/claude-fixture)';

it("incident: a newer user turn's identical failure gets its own quota hold and resume after superseding either kind", async () => {
  for (const kind of ["transient", "usage"] as const) {
    for (const alreadySettled of [false, true]) {
      const scratch = path.join(homedir(), ".cache", "fleet-scratch", "loadout", "superseded-turn-regression");
      await mkdir(scratch, { recursive: true });
      const home = await mkdtemp(path.join(scratch, "lane-"));
      const oldHome = process.env.PASEO_HOME;
      const oldLog = console.log;
      const logs: string[] = [];
      process.env.PASEO_HOME = home;
      console.log = (line: string) => { logs.push(line); };
      mock.timers.enable({ apis: ["Date", "setInterval"], now: at("11:21:13.154") });
      let plugin: ReturnType<typeof contribute> | undefined;
      try {
        const config = ConfigSchema.parse({ armed: true, quotaCacheSeconds: 0 });
        const store = new ResumeStore();
        const error = kind === "transient" ? RATE_LIMIT : "usage_limit_exceeded (stopReason=error, model=fleet/claude-fixture)";
        const snapshot: AgentSnapshot = {
          id: "fixture-agent", provider: "pi", model: "fleet/claude-fixture", cwd: "/fixture-repo",
          status: "error", lastError: error, requiresAttention: true, attentionReason: "error",
          lastUserMessageAt: new Date(at("10:44:18.302")).toISOString(),
          persistence: { provider: "pi", sessionId: "fixture-session", nativeHandle: "fixture-session.jsonl" },
        };
        let quotaAvailable = false;
        const document = () => ({ schemaVersion: 1, snapshotStale: false, accounts: [1, 2].map(() => ({
          provider: "claude", fresh: true,
          windows: [{ id: "five_hour", leftPct: quotaAvailable ? 75 : 0, resetAt: at("14:30:00") / 1000 }],
        })) });
        const quotaSettings = { resetBufferSeconds: config.quotaResetBufferSeconds, maxDelaySeconds: config.maxDelaySeconds };
        const pool = () => poolQuota(document(), agentPool(snapshot.provider, snapshot.model));
        const timeline: AgentTimelineItem[] = [{ type: "user_message", text: "Finish the fixture task", messageId: "fixture-user-1" }];
        const handlers = new Map<string, (event: unknown, context?: unknown) => void>();
        const sends: Array<{ prompt: string; messageId: string }> = [];
        const api = {
          getConnectionState: () => ({ status: "connected" }), close: async () => undefined,
          agents: { ref: () => ({
            refresh: async () => ({ agent: { ...snapshot } }),
            timeline: { refetch: async () => ({ entries: timeline.map((item) => ({ item })), error: null, gap: false, staleCursor: false, hasNewer: false, hasOlder: false }) },
            send: async (prompt: string, options: { messageId: string }) => {
              sends.push({ prompt, messageId: options.messageId });
              timeline.push({ type: "user_message", text: prompt, messageId: options.messageId });
              snapshot.lastUserMessageAt = new Date().toISOString();
              snapshot.status = "running";
              snapshot.activeTurn = { turnId: "fixture-resume-turn" };
              handlers.get("agent.turn_started")!({ agent: { id: snapshot.id }, turnId: "fixture-resume-turn" });
            },
          }) },
        } as unknown as PaseoClient;
        const server = {
          registerSettings: () => ({ read: async () => ({ status: "ready", values: config }) }),
          on: (name: string, handler: (event: unknown, context?: unknown) => void) => { handlers.set(name, handler); return () => undefined; },
        } as unknown as PluginServerContext;
        plugin = contribute(server, async () => api, new QuotaReader(async () => ({ document: document() })));
        await plugin.idle();
        const fail = async (turnId: string) => {
          // Pi makes three provider retries, then emits one failed-turn event.
          for (let n = 0; n < 3; n++) timeline.push({ type: "reasoning", text: "fixture provider retry" });
          timeline.push({ type: "assistant_message", text: `[System Error] ${error}` });
          snapshot.status = "error";
          snapshot.activeTurn = null;
          handlers.get("agent.turn_ended")!({ agent: { id: snapshot.id }, turnId,
            outcome: { kind: "failed", error: { message: error } }, timeline: [...timeline] }, { paseo: api });
          await plugin!.idle();
        };
        const sweep = async (time: string) => {
          mock.timers.setTime(at(time));
          mock.timers.tick(30_000);
          await plugin!.idle();
        };
        const build = (turnId: string) => kind === "usage"
          ? scheduleUsage(buildRecord(snapshot, error, undefined, config, Date.now(), turnId, true)!, pool(), { ...quotaSettings, messageBufferSeconds: config.resetBufferSeconds })
          : buildFailedTransientRecord(snapshot, timeline, { message: error }, config, Date.now(), turnId)!;

        // Replay the model decisions alongside the actual hook and sweep lifecycle.
        const firstModel = build("fixture-turn-1");
        assert.ok(quotaDecision(firstModel, pool(), quotaSettings).hold);
        await fail("fixture-turn-1");
        const [first] = await store.read();
        assert.equal(first?.recordId, firstModel.recordId);
        assert.equal(first?.quotaHold?.until, new Date(at("14:31:00")).toISOString());
        assert.equal(sends.length, 0);

        mock.timers.setTime(at("12:30:00"));
        snapshot.lastUserMessageAt = new Date().toISOString();
        snapshot.status = "running";
        snapshot.activeTurn = { turnId: "fixture-turn-2" };
        timeline.push({ type: "user_message", text: "Continue the fixture task", messageId: "fixture-user-2" });
        handlers.get("agent.turn_started")!({ agent: { id: snapshot.id }, turnId: "fixture-turn-2" });
        await plugin.idle();
        await sweep("12:30:16.422"); // interval tick lands at 12:30:46, while the new turn is running
        assert.equal(sends.length, 0);
        if (kind === "transient") assert.ok(logs.some((line) => line.includes("reason=agent-status=running")));
        if (alreadySettled) {
          await store.update(first!.recordId, (record) => supersedeForNewUserTurn(record, { ...snapshot, status: "error", activeTurn: null }, "fixture-turn-2", timeline));
        }

        mock.timers.setTime(at("12:30:59.957"));
        snapshot.status = "error";
        snapshot.activeTurn = null;
        assert.deepEqual(shouldResume({ ...first!, notBefore: new Date(0).toISOString() }, snapshot, config), { ok: false, reason: "newer-user-message" });
        assert.equal(supersedeForNewUserTurn(first!, snapshot, "fixture-turn-2", timeline).state, "superseded");
        assert.equal(supersedeForNewUserTurn(first!, snapshot, first!.sourceTurnId, timeline), first, "the original turn remains a duplicate");
        assert.equal(supersedeForNewUserTurn(first!, snapshot, "fixture-turn-2", []), first, "missing message evidence keeps the old recovery path");
        const secondModel = build("fixture-turn-2");
        assert.equal(secondModel.failureSignature, firstModel.failureSignature);
        assert.notEqual(secondModel.recordId, firstModel.recordId);
        assert.ok(quotaDecision(secondModel, pool(), quotaSettings).hold);
        await fail("fixture-turn-2");
        const records = await store.read();
        assert.equal(records.length, 2, `${kind}, alreadySettled=${alreadySettled}: second failure must not be swallowed by the old record's evaluation`);
        assert.equal(records.find((record) => record.recordId === first!.recordId)?.state, "superseded");
        const second = records.find((record) => record.sourceTurnId === "fixture-turn-2")!;
        assert.equal(second.recordId, secondModel.recordId);
        assert.equal(second.lastUserMessageAt, snapshot.lastUserMessageAt);
        assert.equal(second.quotaHold?.until, new Date(at("14:31:00")).toISOString());
        assert.deepEqual(second.attempts, []);

        // Duplicate events remain duplicates, even after the first record has settled.
        await fail("fixture-turn-2");
        assert.equal((await store.read()).length, 2);
        assert.equal(sends.length, 0);
        quotaAvailable = true;
        const releaseTime = kind === "usage" ? "14:31:00" : "14:30:46.657";
        assert.deepEqual(quotaDecision(second, pool(), quotaSettings).hold, null);
        assert.deepEqual(shouldResume(second, snapshot, config, at(releaseTime)), { ok: true });
        await sweep(kind === "usage" ? "14:30:30" : "14:30:16.657");
        assert.equal(sends.length, 1);
        assert.equal(sends[0]!.messageId, `${second.recordId}:attempt:1`);
        if (kind === "transient") assert.equal(sends[0]!.prompt, "continue");
        assert.ok(logs.some((line) => line.includes(`quota-released agentId=${snapshot.id} recordId=${second.recordId}`)));
        const verifying = (await store.read()).find((record) => record.recordId === second.recordId)!;
        assert.equal(verifying.state, "verifying");
        const missingStart = { ...verifying, resumeTurnId: null };
        assert.equal(supersedeForNewUserTurn(missingStart, snapshot, "fixture-unobserved-turn", timeline), missingStart, "our own send must retain its record even if the turn-start observation is missing");
      } finally {
        try { plugin?.(); await plugin?.idle(); } finally {
          mock.timers.reset();
          console.log = oldLog;
          if (oldHome === undefined) delete process.env.PASEO_HOME;
          else process.env.PASEO_HOME = oldHome;
        }
        await rm(home, { recursive: true, force: true });
      }
    }
  }
});

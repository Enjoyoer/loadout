// Drives PM quota fallback from the plugin's existing triggers: a turn ending, and the poll sweep as a backstop. It
// has no timer or retry queue of its own; a failed or unverified change is simply tried again on the next trigger.
import type { PaseoApi } from "@getpaseo/client";
import type { Config } from "./config.ts";
import type { AgentSettingsPort } from "./daemon.ts";
import { enrollmentKey, fallbackIneligible, matchesProfile, newObligation, profileOf, restoreDue, SERVICE_TIER_LABEL, swapDecision, type Profile, type ReturnObligation, type ReturnStore } from "./fallback.ts";
import { agentPool, type PoolQuota, type QuotaPool } from "./quota.ts";
import { failureSignature, isActive, rebindRecord, type AgentSnapshot } from "./model.ts";
import type { ResumeStore } from "./store.ts";

export type FallbackApi = PaseoApi & { agentSettings?: AgentSettingsPort };

export type FallbackDeps = {
  returns: ReturnStore;
  records: ResumeStore;
  acquire: () => Promise<FallbackApi>;
  quota: (pool: QuotaPool, config: Config) => Promise<PoolQuota>;
  /** A resume send is in flight for the agent: its settings are not changed under it. */
  sending: (agentId: string) => boolean;
  log: (line: string) => void;
  failed: (action: string, error: unknown) => void;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const show = (profile: Profile) => JSON.stringify(profile);

export function createFallbackRunner(deps: FallbackDeps) {
  const { returns, records, log } = deps;
  // Agents whose settings this runner is changing right now; the resume engine leaves them alone meanwhile.
  const busy = new Set<string>();
  const quiet = new Map<string, string>();
  const once = (agentId: string, line: string) => { if (quiet.get(agentId) !== line) { quiet.set(agentId, line); log(line); } };

  async function fetchAgent(api: FallbackApi, agentId: string): Promise<AgentSnapshot | null> {
    const result = await api.agents.ref(agentId).refresh();
    return result?.agent ? result.agent as AgentSnapshot : null;
  }

  // Exact catalog ids only: the model must be listed verbatim with the thinking option. An unreadable catalog throws,
  // so the caller's trigger fails visibly and the next trigger tries again.
  async function inCatalog(api: FallbackApi, profile: Profile): Promise<boolean> {
    const listed = await api.providers.listModels("pi");
    if (listed.error || !listed.models) throw new Error(`pi catalog unavailable: ${listed.error ?? "no models"}`);
    const model = listed.models.find((entry) => entry.id === profile.model);
    if (!model) return false;
    return profile.thinkingOptionId === null || !!model.thinkingOptions?.some((option) => option.id === profile.thinkingOptionId);
  }

  async function locked(agentId: string, task: () => Promise<void>) {
    if (busy.has(agentId) || deps.sending(agentId)) return;
    busy.add(agentId);
    try { await task(); } catch (error) { deps.failed(`pm-fallback-failed agentId=${agentId}`, error); } finally { busy.delete(agentId); }
  }

  // The verified profile is in place: the active resume record follows it, and a restore ends the obligation.
  async function settle(obligation: ReturnObligation, agent: AgentSnapshot, goal: "swap" | "restore") {
    const active = await records.activeForAgent(agent.id);
    if (active) {
      const rebound = await records.update(active.recordId, (value) => isActive(value) ? rebindRecord(value, agent) : value);
      if (rebound && rebound.model !== active.model) log(`pm-record-rebound agentId=${agent.id} recordId=${active.recordId} model=${rebound.model}`);
    }
    if (goal === "swap") {
      await returns.update(obligation.obligationId, (o) => ({ ...o, phase: "fallback", lastError: null, updatedAt: new Date().toISOString() }));
      log(`pm-swap-verified agentId=${agent.id} obligationId=${obligation.obligationId} profile=${show(obligation.fallback)}`);
    } else {
      await returns.remove(obligation.obligationId);
      log(`pm-restore-verified agentId=${agent.id} obligationId=${obligation.obligationId} profile=${show(obligation.original)}`);
    }
  }

  // One pass for one obligation: refresh whether the return is due, then move the agent to the profile it owes.
  // Running agents are changed too: Paseo applies settings to the next turn and never interrupts the current one.
  async function reconcileLocked(agentId: string, config: Config) {
    let obligation = await returns.get(agentId);
    if (!obligation) return;
    const api = await deps.acquire();
    const agent = await fetchAgent(api, agentId);
    if (!agent) return once(agentId, `pm-return-waiting agentId=${agentId} obligationId=${obligation.obligationId} reason=agent-missing`);
    if (agent.archivedAt) return once(agentId, `pm-return-waiting agentId=${agentId} obligationId=${obligation.obligationId} reason=archived`);
    if (obligation.phase === "fallback") {
      const original = await deps.quota(agentPool("pi", obligation.original.model) ?? "claude", config);
      const due = restoreDue(obligation.restoreDueAt !== null, original);
      if (due !== (obligation.restoreDueAt !== null)) {
        obligation = await returns.update(obligation.obligationId, (o) => ({ ...o, restoreDueAt: due ? new Date().toISOString() : null, updatedAt: new Date().toISOString() }));
        if (!obligation) return;
        log(`pm-restore-${due ? "due" : "deferred"} agentId=${agentId} obligationId=${obligation.obligationId} quota=${JSON.stringify(original.status === "known" ? { available: original.available, exhausted: original.exhausted, weekly: original.weekly } : original.reason)}`);
      }
    }
    const goal = obligation.phase === "switching" ? "swap" : obligation.restoreDueAt ? "restore" : null;
    if (!goal) return;
    const target = goal === "swap" ? obligation.fallback : obligation.original;
    if (matchesProfile(agent, target)) return settle(obligation, agent, goal);
    if (!config.armed) return once(agentId, `pm-would-${goal} agentId=${agentId} obligationId=${obligation.obligationId} profile=${show(target)}`);
    if (!api.agentSettings) return once(agentId, `pm-${goal}-unsupported agentId=${agentId} reason=no-agent-settings-port`);
    const attempt = await returns.update(obligation.obligationId, (o) => ({ ...o, attempts: o.attempts + 1, lastAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    if (!attempt) return;
    log(`pm-${goal}-apply agentId=${agentId} obligationId=${obligation.obligationId} attempt=${attempt.attempts} status=${agent.status} profile=${show(target)}`);
    try {
      // Model and thinking travel in one request; the Fast label is the only label this feature writes.
      await api.agentSettings.apply(agentId, { modelId: target.model, thinkingOptionId: target.thinkingOptionId });
      if (profileOf(agent)?.serviceTier !== target.serviceTier) await api.agentSettings.setLabels(agentId, { [SERVICE_TIER_LABEL]: target.serviceTier ?? "" });
    } catch (error) {
      await returns.update(obligation.obligationId, (o) => ({ ...o, lastError: errorText(error), updatedAt: new Date().toISOString() }));
      log(`pm-${goal}-failed agentId=${agentId} obligationId=${obligation.obligationId} reason=${JSON.stringify(errorText(error))} retry=next-trigger`);
      return;
    }
    const after = await fetchAgent(api, agentId);
    if (after && matchesProfile(after, target)) return settle(attempt, after, goal);
    const seen = after ? profileOf(after) : null;
    await returns.update(obligation.obligationId, (o) => ({ ...o, lastError: `readback-mismatch ${JSON.stringify(seen)}`, updatedAt: new Date().toISOString() }));
    log(`pm-${goal}-mismatch agentId=${agentId} obligationId=${obligation.obligationId} readback=${JSON.stringify(seen)} retry=next-trigger`);
  }

  // A live Pi PM on Claude whose pool pq confirms out moves to the fallback profile. The obligation, with the exact
  // original profile, is stored before any setting changes.
  async function swapLocked(agentId: string, config: Config, why: string) {
    if (await returns.get(agentId)) return reconcileLocked(agentId, config);
    const api = await deps.acquire();
    const agent = await fetchAgent(api, agentId);
    if (!agent) return;
    const ineligible = fallbackIneligible(agent, config.pmFallbackOptOutLabel);
    if (ineligible) {
      if (agent.labels?.role === "pm") once(agentId, `pm-fallback-skipped agentId=${agentId} reason=${ineligible}`);
      return;
    }
    const original = profileOf(agent)!;
    const fallback: Profile = { model: config.pmFallbackModel, thinkingOptionId: config.pmFallbackThinking, serviceTier: config.pmFallbackServiceTier };
    const decision = swapDecision(await deps.quota("claude", config), await deps.quota(agentPool("pi", fallback.model) ?? "codex", config));
    if (!decision.swap) return once(agentId, `pm-fallback-held agentId=${agentId} reason=${JSON.stringify(decision.reason)} trigger=${why}`);
    if (!await inCatalog(api, fallback)) return once(agentId, `pm-fallback-skipped agentId=${agentId} reason=fallback-not-in-catalog profile=${show(fallback)}`);
    const stored = await returns.add(newObligation(agentId, original, fallback, "auto", "switching"));
    if (!stored) return reconcileLocked(agentId, config);
    log(`pm-swap-start agentId=${agentId} obligationId=${stored.obligationId} trigger=${why} original=${show(original)} fallback=${show(fallback)}`);
    await reconcileLocked(agentId, config);
  }

  // Owner settings: enroll a PM that is already on another profile, or cancel one obligation by its id.
  async function ingest(config: Config) {
    for (const obligationId of config.pmFallbackCancel) {
      const removed = await returns.remove(obligationId);
      if (removed) log(`pm-return-cancelled agentId=${removed.agentId} obligationId=${obligationId} by=owner-setting profile=${show(removed.original)}`);
    }
    if (!config.pmFallbackEnroll.length) return;
    const consumed = new Set((await returns.read()).consumed);
    for (const entry of config.pmFallbackEnroll) {
      const key = enrollmentKey(entry);
      if (consumed.has(key)) continue;
      const reject = async (reason: string) => { await returns.consume(key); log(`pm-enroll-rejected agentId=${entry.agentId} key=${key} reason=${reason}`); };
      if (await returns.get(entry.agentId)) { await reject("obligation-exists"); continue; }
      const api = await deps.acquire();
      const agent = await fetchAgent(api, entry.agentId);
      if (!agent || agent.archivedAt) { await reject(agent ? "archived" : "agent-missing"); continue; }
      if (agent.labels?.role !== "pm" || agent.provider !== "pi") { await reject("not-a-pi-pm"); continue; }
      const original: Profile = { model: entry.model, thinkingOptionId: entry.thinkingOptionId, serviceTier: entry.serviceTier };
      if (agentPool("pi", original.model) !== "claude") { await reject("original-not-claude"); continue; }
      if (!await inCatalog(api, original)) { await reject("original-not-in-catalog"); continue; }
      if (matchesProfile(agent, original)) { await reject("already-on-original"); continue; }
      const current = profileOf(agent);
      if (!current) { await reject("current-profile-unknown"); continue; }
      const stored = await returns.add(newObligation(entry.agentId, original, current, "enrolled", "fallback"), key);
      if (stored) log(`pm-enrolled agentId=${entry.agentId} obligationId=${stored.obligationId} original=${show(original)} current=${show(current)}`);
    }
  }

  return {
    isBusy: (agentId: string) => busy.has(agentId),

    /** A swap or a due restore is outstanding: the resume engine sends nothing until the profile is in place. */
    async blocksSend(agentId: string): Promise<boolean> {
      const obligation = await returns.get(agentId);
      return !!obligation && (obligation.phase === "switching" || obligation.restoreDueAt !== null);
    },

    /** Returns true when the agent has an obligation afterwards, so the caller sweeps its waiting record. */
    async afterTurnEnded(agentId: string, failure: string | null, config: Config): Promise<boolean> {
      if (await returns.get(agentId)) await locked(agentId, () => reconcileLocked(agentId, config));
      else if (config.pmFallback && failure && failureSignature(failure)) await locked(agentId, () => swapLocked(agentId, config, "usage-limit-turn"));
      else return false;
      return true;
    },

    /** The sweep's backstop: owner settings, every obligation, and PMs whose usage record is held on an out pool. */
    async sweep(config: Config) {
      // An enrollment that cannot be checked now (catalog or daemon unavailable) stays unconsumed for the next sweep and
      // never holds up the returns below.
      await ingest(config).catch((error) => deps.failed("pm-enroll-failed", error));
      for (const obligation of (await returns.read()).obligations) await locked(obligation.agentId, () => reconcileLocked(obligation.agentId, config));
      if (!config.pmFallback) return;
      for (const record of await records.read()) {
        if (!isActive(record) || record.kind === "transient" || !record.quotaHold || record.provider !== "pi") continue;
        if (await returns.get(record.agentId)) continue;
        await locked(record.agentId, () => swapLocked(record.agentId, config, "usage-record-held"));
      }
    },
  };
}

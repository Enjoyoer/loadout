// Drives PM quota fallback from the plugin's existing triggers: a turn ending, and the poll sweep as a backstop. It
// has no timer or retry queue of its own; a failed or unverified change is simply tried again on the next trigger.
import type { PaseoApi } from "@getpaseo/client";
import type { Config } from "./config.ts";
import type { AgentSettingsPort } from "./daemon.ts";
import { enrollmentKey, fallbackIneligible, isSwapEvidence, recordSwapEvidence, turnSwapEvidence, writeBlocked, type SwapEvidence, hasCapacity, matchesProfile, newObligation, profileOf, restoreDue, SERVICE_TIER_LABEL, storedMatches, swapDecision, type Profile, type ReturnObligation, type ReturnStore } from "./fallback.ts";
import { agentPool, type PoolQuota, type QuotaPool } from "./quota.ts";
import { isActive, rebindRecord, type AgentSnapshot } from "./model.ts";
import type { ResumeStore } from "./store.ts";

export type FallbackApi = PaseoApi & { agentSettings?: AgentSettingsPort };

export type FallbackDeps = {
  returns: ReturnStore;
  records: ResumeStore;
  acquire: () => Promise<FallbackApi>;
  /** One pool's quota; `fresh` skips the shared cached reading and asks pq now. */
  quota: (pool: QuotaPool, config: Config, options?: { fresh?: boolean }) => Promise<PoolQuota>;
  /** Every stored copy of the agent's profile: what a daemon reload or restart would load. */
  stored: (agentId: string) => Promise<Profile[]>;
  /** How long a settled change may take to reach the stored record before the next trigger tries again. */
  persistWaitMs?: number;
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

  // Exact catalog ids only: the profile with its thinking option made explicit (an unset one is the model's catalog
  // default, which is what the agent runs on), or null when the model or option is not listed verbatim. An unreadable
  // catalog throws, so the caller's trigger fails visibly and the next trigger tries again.
  async function inCatalog(api: FallbackApi, profile: Profile): Promise<Profile | null> {
    const listed = await api.providers.listModels("pi");
    if (listed.error || !listed.models) throw new Error(`pi catalog unavailable: ${listed.error ?? "no models"}`);
    const model = listed.models.find((entry) => entry.id === profile.model);
    const thinkingOptionId = profile.thinkingOptionId ?? model?.defaultThinkingOptionId ?? null;
    if (!model || !thinkingOptionId || !model.thinkingOptions?.some((option) => option.id === thinkingOptionId)) return null;
    return { ...profile, thinkingOptionId };
  }

  // A change counts only once every stored copy of the agent holds it: Paseo acknowledges settings in memory and
  // writes the record in the background, and a failed write would bring the old profile back on reload or restart.
  async function persisted(agentId: string, target: Profile): Promise<boolean> {
    for (let waited = 0; ; waited += 250) {
      if (storedMatches(await deps.stored(agentId), target)) return true;
      if (waited >= (deps.persistWaitMs ?? 5_000)) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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

  const quotaText = (quota: PoolQuota) => JSON.stringify(quota.status === "known" ? { available: quota.available, capacity: quota.capacity, exhausted: quota.exhausted, weekly: quota.weekly } : quota.reason);

  async function cancel(obligationId: string) {
    const removed = await returns.remove(obligationId);
    if (removed) log(`pm-return-cancelled agentId=${removed.agentId} obligationId=${obligationId} by=owner-setting profile=${show(removed.original)}`);
  }

  // The write gate, ahead of every settings change, repair or completion. A cancel is carried out here, so no trigger
  // can act on a cancelled obligation before the sweep reads the cancel list. An archived agent is left
  // exactly as it is: an unapplied swap intent is dropped, a landed one becomes a plain return that waits, and nothing
  // holds its resume sends.
  async function gate(obligation: ReturnObligation, agent: AgentSnapshot, config: Config): Promise<boolean> {
    const blocked = writeBlocked(obligation, agent, config);
    if (!blocked) return true;
    if (blocked === "cancelled") { await cancel(obligation.obligationId); return false; }
    if (obligation.phase === "switching" && agent.model !== obligation.fallback.model) {
      await returns.remove(obligation.obligationId);
      log(`pm-swap-dropped agentId=${agent.id} obligationId=${obligation.obligationId} reason=${blocked} profile=${show(profileOf(agent) ?? obligation.original)}`);
      return false;
    }
    if (obligation.phase === "switching" || obligation.restoreDueAt !== null) {
      await returns.update(obligation.obligationId, (o) => ({ ...o, phase: "fallback", restoreDueAt: null, updatedAt: new Date().toISOString() }));
    }
    once(agent.id, `pm-return-waiting agentId=${agent.id} obligationId=${obligation.obligationId} reason=${blocked}`);
    return false;
  }

  // A persisted swap intent is re-decided before it is applied (after a crash or restart the agent, its labels or the
  // quota may have changed): the agent must still be an eligible PM on its original model, and a fresh reading must
  // still confirm the original pool out, or the intent is dropped. Once the fallback model is in place the swap has
  // happened: for a PM it is finished as a swap (any partial setting repaired, the stored record confirmed, the resume
  // record rebound) whatever quota reads now; an agent that is no longer an eligible PM is not repaired, it only keeps
  // the return.
  async function recheckSwap(obligation: ReturnObligation, agent: AgentSnapshot, config: Config): Promise<ReturnObligation | null> {
    if (agent.model === obligation.fallback.model) {
      const ineligible = fallbackIneligible(agent, obligation.original.model);
      if (!ineligible) return obligation;
      log(`pm-swap-not-completed agentId=${agent.id} obligationId=${obligation.obligationId} reason=${ineligible} return=kept`);
      return returns.update(obligation.obligationId, (o) => ({ ...o, phase: "fallback", updatedAt: new Date().toISOString() }));
    }
    let reason = agent.model !== obligation.original.model ? "model-changed" : fallbackIneligible(agent, obligation.original.model);
    if (!reason && !config.pmFallback) reason = "pmFallback-off";
    if (!reason) {
      const decision = swapDecision(await deps.quota(agentPool("pi", obligation.original.model) ?? "claude", config, { fresh: true }), await deps.quota(agentPool("pi", obligation.fallback.model) ?? "codex", config, { fresh: true }));
      if (!decision.swap) reason = decision.reason;
    }
    if (!reason) return obligation;
    await returns.remove(obligation.obligationId);
    log(`pm-swap-dropped agentId=${agent.id} obligationId=${obligation.obligationId} reason=${JSON.stringify(reason)} profile=${show(profileOf(agent) ?? obligation.original)}`);
    return null;
  }

  // One pass for one obligation: refresh whether the return is due, then move the agent to the profile it owes.
  // Running agents are changed too: Paseo applies settings to the next turn and never interrupts the current one.
  async function reconcileLocked(agentId: string, config: Config) {
    let obligation: ReturnObligation | null = await returns.get(agentId);
    if (!obligation) return;
    const api = await deps.acquire();
    const agent = await fetchAgent(api, agentId);
    if (!agent) return once(agentId, `pm-return-waiting agentId=${agentId} obligationId=${obligation.obligationId} reason=agent-missing`);
    if (!await gate(obligation, agent, config)) return;
    if (obligation.phase === "switching") {
      obligation = await recheckSwap(obligation, agent, config);
      if (!obligation) return;
    }
    let goal: "swap" | "restore" | null = obligation.phase === "switching" ? "swap" : null;
    if (obligation.phase === "fallback") {
      const pool = agentPool("pi", obligation.original.model) ?? "claude";
      // Due, which holds resume sends, follows the latest reading. Applying the restore needs capacity in both windows
      // proven by a reading taken now; a stale, unknown or partial reading only waits.
      let reading = await deps.quota(pool, config);
      if (hasCapacity(reading)) reading = await deps.quota(pool, config, { fresh: true });
      const due = restoreDue(reading);
      if (due !== (obligation.restoreDueAt !== null)) {
        obligation = await returns.update(obligation.obligationId, (o) => ({ ...o, restoreDueAt: due ? new Date().toISOString() : null, updatedAt: new Date().toISOString() }));
        if (!obligation) return;
        log(`pm-restore-${due ? "due" : "deferred"} agentId=${agentId} obligationId=${obligation.obligationId} quota=${quotaText(reading)}`);
      }
      if (due) goal = "restore";
    }
    if (!goal) return;
    const target = goal === "swap" ? obligation.fallback : obligation.original;
    // Already in place in memory: settle once the stored record holds it too, else write it again so it is persisted.
    if (matchesProfile(agent, target) && await persisted(agentId, target)) return settle(obligation, agent, goal);
    if (!config.armed) return once(agentId, `pm-would-${goal} agentId=${agentId} obligationId=${obligation.obligationId} profile=${show(target)}`);
    if (!api.agentSettings) return once(agentId, `pm-${goal}-unsupported agentId=${agentId} reason=no-agent-settings-port`);
    const attempt = await returns.update(obligation.obligationId, (o) => ({ ...o, attempts: o.attempts + 1, lastAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    if (!attempt) return;
    log(`pm-${goal}-apply agentId=${agentId} obligationId=${obligation.obligationId} attempt=${attempt.attempts} status=${agent.status} profile=${show(target)}`);
    try {
      // Model and thinking travel in one request. The Fast label, the only label this feature writes, is always
      // written too, so the stored record is rewritten even when memory already held it.
      await api.agentSettings.apply(agentId, { modelId: target.model, thinkingOptionId: target.thinkingOptionId });
      await api.agentSettings.setLabels(agentId, { [SERVICE_TIER_LABEL]: target.serviceTier ?? "" });
    } catch (error) {
      await returns.update(obligation.obligationId, (o) => ({ ...o, lastError: errorText(error), updatedAt: new Date().toISOString() }));
      log(`pm-${goal}-failed agentId=${agentId} obligationId=${obligation.obligationId} reason=${JSON.stringify(errorText(error))} retry=next-trigger`);
      return;
    }
    const after = await fetchAgent(api, agentId);
    const inMemory = !!after && matchesProfile(after, target);
    if (inMemory && await persisted(agentId, target)) return settle(attempt, after!, goal);
    const seen = inMemory ? { stored: await deps.stored(agentId) } : { live: after ? profileOf(after) : null };
    const kind = inMemory ? "unpersisted" : "mismatch";
    await returns.update(obligation.obligationId, (o) => ({ ...o, lastError: `readback-${kind} ${JSON.stringify(seen)}`, updatedAt: new Date().toISOString() }));
    log(`pm-${goal}-${kind} agentId=${agentId} obligationId=${obligation.obligationId} readback=${JSON.stringify(seen)} retry=next-trigger`);
  }

  // A live Pi PM on Claude whose pool pq confirms out moves to the fallback profile. The obligation, with the exact
  // original profile, is stored before any setting changes.
  async function swapLocked(agentId: string, config: Config, why: string, evidence: SwapEvidence) {
    if (await returns.get(agentId)) return reconcileLocked(agentId, config);
    if (!config.pmFallback || !isSwapEvidence(evidence)) return;
    const api = await deps.acquire();
    const agent = await fetchAgent(api, agentId);
    if (!agent) return;
    const ineligible = fallbackIneligible(agent);
    if (ineligible) {
      if (agent.labels?.role === "pm") once(agentId, `pm-fallback-skipped agentId=${agentId} reason=${ineligible}`);
      return;
    }
    const configured: Profile = { model: config.pmFallbackModel, thinkingOptionId: config.pmFallbackThinking, serviceTier: config.pmFallbackServiceTier };
    const decision = swapDecision(await deps.quota("claude", config), await deps.quota(agentPool("pi", configured.model) ?? "codex", config));
    if (!decision.swap) return once(agentId, `pm-fallback-held agentId=${agentId} reason=${JSON.stringify(decision.reason)} trigger=${why}`);
    const fallback = await inCatalog(api, configured);
    if (!fallback) return once(agentId, `pm-fallback-skipped agentId=${agentId} reason=fallback-not-in-catalog profile=${show(configured)}`);
    const original = await inCatalog(api, profileOf(agent)!);
    if (!original) return once(agentId, `pm-fallback-skipped agentId=${agentId} reason=original-not-in-catalog profile=${show(profileOf(agent)!)}`);
    const stored = await returns.add(newObligation(agentId, original, fallback, "auto", "switching"));
    if (!stored) return reconcileLocked(agentId, config);
    log(`pm-swap-start agentId=${agentId} obligationId=${stored.obligationId} trigger=${why} original=${show(original)} fallback=${show(fallback)}`);
    await reconcileLocked(agentId, config);
  }

  // Owner settings: enroll a PM that is already on another profile, or cancel one obligation by its id.
  async function ingest(config: Config) {
    for (const obligationId of config.pmFallbackCancel) await cancel(obligationId);
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
      if (agentPool("pi", entry.model) !== "claude") { await reject("original-not-claude"); continue; }
      // An unset thinking option is stored as the catalog default, so the restore can be verified exactly.
      const original = await inCatalog(api, { model: entry.model, thinkingOptionId: entry.thinkingOptionId, serviceTier: entry.serviceTier });
      if (!original) { await reject("original-not-in-catalog"); continue; }
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
    async afterTurnEnded(agentId: string, outcome: Parameters<typeof turnSwapEvidence>[0], config: Config): Promise<boolean> {
      const evidence = turnSwapEvidence(outcome);
      if (await returns.get(agentId)) await locked(agentId, () => reconcileLocked(agentId, config));
      else if (config.pmFallback && isSwapEvidence(evidence)) await locked(agentId, () => swapLocked(agentId, config, "usage-limit-turn", evidence));
      else return false;
      return true;
    },

    /** The sweep's backstop: owner settings, every obligation, and PMs whose failed-turn quota record is held on an out pool. */
    async sweep(config: Config) {
      // An enrollment that cannot be checked now (catalog or daemon unavailable) stays unconsumed for the next sweep and
      // never holds up the returns below.
      await ingest(config).catch((error) => deps.failed("pm-enroll-failed", error));
      for (const obligation of (await returns.read()).obligations) await locked(obligation.agentId, () => reconcileLocked(obligation.agentId, config));
      if (!config.pmFallback) return;
      for (const record of await records.read()) {
        const evidence = recordSwapEvidence(record);
        if (!isSwapEvidence(evidence) || !record.quotaHold || record.provider !== "pi") continue;
        if (await returns.get(record.agentId)) continue;
        await locked(record.agentId, () => swapLocked(record.agentId, config, "usage-record-held", evidence));
      }
    },
  };
}

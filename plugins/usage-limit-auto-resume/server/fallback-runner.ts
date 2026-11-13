// Drives PM quota fallback from the plugin's existing triggers: a turn ending, and the poll sweep as a backstop. It
// has no timer or retry queue of its own; a failed or unverified change is simply tried again on the next trigger.
import type { PaseoApi } from "@getpaseo/client";
import type { Config } from "./config.ts";
import type { AgentSettingsPort } from "./daemon.ts";
import { chainDecision, chainRefusal, enrollmentKey, fallbackIneligible, fallbackSinceMs, pqProbeOpensAt, isSubscriptionClaude, isSwapEvidence, onOriginal, profileChanged, sameModel, sameProfile, recordSwapEvidence, scopedCapacity, scopedWindow, stageOf, turnSwapEvidence, writeBlocked, type SwapEvidence, hasCapacity, matchesProfile, newObligation, profileOf, restoreDue, SERVICE_TIER_LABEL, storedMatches, swapDecision, type Profile, type ReturnObligation, type ReturnStore } from "./fallback.ts";
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
  // Per Claude subscription model, the latest turn this daemon saw a Pi agent finish with a normal reply, stamped with
  // the turn's end. Real traffic succeeding proves that model usable when pq cannot (stale or unproven accounts), so it
  // makes the return of a PM whose original is that same model due. Limits can be per model (a Fable weekly window),
  // so another Claude model proves nothing for it.
  const claudeSuccess = new Map<string, { agentId: string; at: number }>();
  // PMs whose return was dropped because their profile was changed by hand, with that profile: no new swap while they
  // stay on it.
  const dropped = new Map<string, Profile>();
  const nowIso = () => new Date().toISOString();

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
      await returns.update(obligation.obligationId, (o) => ({ ...o, phase: "fallback", fallbackSince: o.fallbackSince ?? nowIso(), lastError: null, updatedAt: nowIso() }));
      log(`pm-swap-verified agentId=${agent.id} obligationId=${obligation.obligationId}${obligation.stage ? ` stage=${obligation.stage}` : ""} profile=${show(obligation.fallback)}`);
    } else {
      await returns.remove(obligation.obligationId);
      log(`pm-restore-verified agentId=${agent.id} obligationId=${obligation.obligationId} profile=${show(obligation.original)}`);
    }
  }

  const quotaText = (quota: PoolQuota) => JSON.stringify(quota.status === "known" ? { available: quota.available, capacity: quota.capacity, exhausted: quota.exhausted, weekly: quota.weekly, ...(quota.scoped && Object.keys(quota.scoped).length ? { scoped: quota.scoped } : {}) } : quota.reason);

  // A stage move that cannot go ahead leaves the PM where it is: the obligation goes back to the stage it is on, and
  // the return to the original stands.
  async function stayOnStage(obligation: ReturnObligation, stage: "first" | "last", reason: string) {
    const kept = await returns.update(obligation.obligationId, (o) => ({ ...o, phase: "fallback", stage, fallback: o.stages![stage], fallbackSince: o.fallbackSince ?? nowIso(), restoreDueAt: null, updatedAt: nowIso() }));
    if (kept) log(`pm-stage-dropped agentId=${obligation.agentId} obligationId=${obligation.obligationId} reason=${JSON.stringify(reason)} stays=${stage} profile=${show(kept.fallback)}`);
    return kept;
  }

  // Starts a move to another stage of the chain; the next pass applies it as a swap. The stage's proof clock restarts
  // when the move is verified.
  async function startStage(obligation: ReturnObligation, stage: "first" | "last", detail: string) {
    const from = obligation.stage;
    const moved = await returns.update(obligation.obligationId, (o) => o.phase === "fallback" && o.stage === from
      ? { ...o, phase: "switching", stage, fallback: o.stages![stage], fallbackSince: null, restoreDueAt: null, restoreReadback: null, updatedAt: nowIso() } : o);
    if (moved?.stage === stage && moved.phase === "switching") log(`pm-stage-start agentId=${obligation.agentId} obligationId=${obligation.obligationId} from=${from} to=${stage} ${detail} profile=${show(moved.fallback)}`);
    return moved;
  }

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
    const onStage = stageOf(obligation, profileOf(agent));
    if (obligation.phase === "switching" && agent.model !== obligation.fallback.model && onStage) await stayOnStage(obligation, onStage, blocked);
    else if (obligation.phase === "switching" && agent.model !== obligation.fallback.model) {
      await returns.remove(obligation.obligationId);
      log(`pm-swap-dropped agentId=${agent.id} obligationId=${obligation.obligationId} reason=${blocked} profile=${show(profileOf(agent) ?? obligation.original)}`);
      return false;
    }
    if (obligation.phase === "switching" || obligation.restoreDueAt !== null) {
      await returns.update(obligation.obligationId, (o) => ({ ...o, phase: "fallback", fallbackSince: o.fallbackSince ?? nowIso(), restoreDueAt: null, updatedAt: nowIso() }));
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
      return returns.update(obligation.obligationId, (o) => ({ ...o, phase: "fallback", fallbackSince: o.fallbackSince ?? nowIso(), updatedAt: nowIso() }));
    }
    const fresh = async () => [await deps.quota(agentPool("pi", obligation.original.model) ?? "claude", config, { fresh: true }), await deps.quota(agentPool("pi", obligation.fallback.model) ?? "codex", config, { fresh: true })] as const;
    // A move between the chain's stages: back toward the original it needs no re-check; onward it is re-decided like a
    // swap, and if it may not go ahead the PM stays on the stage it is on.
    const onStage = stageOf(obligation, profileOf(agent));
    if (onStage) {
      if (onStage === "last" && obligation.stage === "first") return obligation;
      let reason = fallbackIneligible(agent, obligation.original.model) ?? (config.pmFallback ? null : "pmFallback-off");
      if (!reason) {
        const decision = swapDecision(...await fresh());
        if (!decision.swap) reason = decision.reason;
      }
      if (!reason) return obligation;
      await stayOnStage(obligation, onStage, reason);
      return null;
    }
    let reason = agent.model !== obligation.original.model ? "model-changed" : fallbackIneligible(agent, obligation.original.model);
    if (!reason && !config.pmFallback) reason = "pmFallback-off";
    // A chain's first stage was chosen by a refusal of the original model that cannot be read again; the last stage,
    // skipped to, by every Claude account out, which can.
    if (!reason && obligation.stage === "last") {
      const decision = chainDecision(...await fresh());
      // No longer every Claude account out: the refusal of the original still stands, so the swap goes to the first
      // stage instead of being dropped.
      if (decision.stage === "first") {
        const restaged = await returns.update(obligation.obligationId, (o) => o.phase === "switching" && o.stage === "last"
          ? { ...o, stage: "first", fallback: o.stages!.first, updatedAt: nowIso() } : o);
        if (restaged?.stage === "first") log(`pm-swap-restaged agentId=${agent.id} obligationId=${obligation.obligationId} stage=first reason=claude-pool-not-exhausted profile=${show(restaged.fallback)}`);
        return restaged;
      }
      if (decision.stage !== "last") reason = decision.reason;
    } else if (!reason && !obligation.stages) {
      const decision = swapDecision(...await fresh());
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
      // An explicit model change (owner or another agent) ends the return: nothing is written over it. A PM already
      // back on its original profile settles below as a restore.
      const live = profileOf(agent);
      if (!live) return once(agentId, `pm-return-waiting agentId=${agentId} obligationId=${obligation.obligationId} reason=profile-unknown`);
      if (profileChanged(obligation, live)) {
        if (!await returns.remove(obligation.obligationId)) return;
        dropped.set(agentId, live);
        log(`pm-return-dropped agentId=${agentId} obligationId=${obligation.obligationId} reason=profile-changed live=${show(live)} original=${show(obligation.original)}`);
        return;
      }
      // Put on the chain's other stage by hand: that stage is the one the return now waits on.
      const onStage = stageOf(obligation, live);
      if (onStage && onStage !== obligation.stage) {
        obligation = await returns.update(obligation.obligationId, (o) => ({ ...o, stage: onStage, fallback: o.stages![onStage], fallbackSince: nowIso(), restoreDueAt: null, updatedAt: nowIso() }));
        if (!obligation) return;
        log(`pm-stage-adopted agentId=${agentId} obligationId=${obligation.obligationId} stage=${onStage} profile=${show(live)}`);
      }
      const pool = agentPool("pi", obligation.original.model) ?? "claude";
      // A chained original (Fable) needs its own model-scoped window proven too; any other original, both account windows.
      const window = obligation.stages ? scopedWindow(obligation.original.model) : null;
      // pq that showed the window left while the provider refused it proves nothing for this obligation.
      // It may still probe the original on pq proof once per PQ_PROBE_INTERVAL_MS; a restore already due by a probe
      // stays due until it lands.
      const distrusted = !!window && obligation.pqFableDistrusted === true;
      const probeOpensAt = pqProbeOpensAt(obligation);
      const probing = distrusted && (Date.now() >= probeOpensAt || obligation.restoreDueAt !== null && obligation.pqProbeAt === obligation.restoreDueAt);
      const proven = (quota: PoolQuota) => window ? (!distrusted || probing) && scopedCapacity(quota, window) : restoreDue(quota);
      const stepping = !!obligation.stages && obligation.stage === "last";
      // Due, which holds resume sends, follows the latest reading. Applying the restore needs capacity proven by a
      // reading taken now, or a Claude subscription turn of the original model this daemon saw succeed since the stage
      // began.
      let reading = await deps.quota(pool, config);
      if (proven(reading) || stepping && hasCapacity(reading)) reading = await deps.quota(pool, config, { fresh: true });
      const successOf = (model: string) => {
        const seen = claudeSuccess.get(model);
        return seen && seen.at > fallbackSinceMs(obligation!) ? seen : null;
      };
      const successText = (seen: { agentId: string; at: number }, model: string) => `claude-success agent=${seen.agentId.slice(0, 8)} model=${model} at=${new Date(seen.at).toISOString()}`;
      const success = successOf(obligation.original.model);
      const reason = success && (distrusted || !proven(reading)) ? successText(success, obligation.original.model)
        : proven(reading) ? `${distrusted ? "pq-fable-probe" : "pq-capacity"} quota=${quotaText(reading)}` : null;
      // Back on the original by hand: settled as a restore, which also writes the original's tier label.
      const due = reason !== null || onOriginal(obligation, live);
      // On the chain's last stage without proof for the original: proof for the first stage's model (the account windows
      // by pq, or a success of that model) steps the PM back to the first stage, from where the original's proof
      // finishes the return.
      if (!due && stepping) {
        const first = obligation.stages!.first;
        const firstSuccess = successOf(first.model);
        const step = hasCapacity(reading) ? `pq-capacity quota=${quotaText(reading)}` : firstSuccess ? successText(firstSuccess, first.model) : null;
        if (step) {
          if (!await startStage(obligation, "first", `reason=${step}`)) return;
          return reconcileLocked(agentId, config);
        }
      }
      if (due !== (obligation.restoreDueAt !== null)) {
        const at = nowIso(), probe = due && reason?.startsWith("pq-fable-probe");
        obligation = await returns.update(obligation.obligationId, (o) => ({ ...o, restoreDueAt: due ? at : null, ...(probe ? { pqProbeAt: at } : {}), updatedAt: at }));
        if (!obligation) return;
        log(`pm-restore-${due ? "due" : "deferred"} agentId=${agentId} obligationId=${obligation.obligationId} ${due ? `reason=${reason ?? "already-on-original"}` : `quota=${quotaText(reading)}`}`);
      }
      if (due) goal = "restore";
      else once(agentId, `pm-return-waiting agentId=${agentId} obligationId=${obligation.obligationId} reason=${distrusted && scopedCapacity(reading, window!) ? `pq-fable-contradicted next-probe=${new Date(probeOpensAt).toISOString()}` : "no-claude-proof"}${obligation.stage ? ` stage=${obligation.stage}` : ""} pq=${quotaText(reading)}`);
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
      // What a failed restore left in place is ours, not an owner change: kept so the next trigger retries over it.
      const left = goal === "restore" ? await fetchAgent(api, agentId).then((a) => a ? profileOf(a) : null).catch(() => null) : null;
      await returns.update(obligation.obligationId, (o) => ({ ...o, ...(left ? { restoreReadback: left } : {}), lastError: errorText(error), updatedAt: new Date().toISOString() }));
      log(`pm-${goal}-failed agentId=${agentId} obligationId=${obligation.obligationId} reason=${JSON.stringify(errorText(error))} retry=next-trigger`);
      return;
    }
    const after = await fetchAgent(api, agentId);
    const inMemory = !!after && matchesProfile(after, target);
    if (inMemory && await persisted(agentId, target)) return settle(attempt, after!, goal);
    const seen = inMemory ? { stored: await deps.stored(agentId) } : { live: after ? profileOf(after) : null };
    const kind = inMemory ? "unpersisted" : "mismatch";
    const readback = goal === "restore" && after ? profileOf(after) : null;
    await returns.update(obligation.obligationId, (o) => ({ ...o, ...(readback ? { restoreReadback: readback } : {}), lastError: `readback-${kind} ${JSON.stringify(seen)}`, updatedAt: new Date().toISOString() }));
    log(`pm-${goal}-${kind} agentId=${agentId} obligationId=${obligation.obligationId} readback=${JSON.stringify(seen)} retry=next-trigger`);
  }

  // A live Pi PM on Claude whose pool pq confirms out moves to the fallback profile. The obligation, with the exact
  // original profile, is stored before any setting changes.
  // A PM on the first stage of its chain whose turn there is refused for quota moves on to the last stage, by the same
  // rule as a swap (swapDecision). Its original stays the profile it returns to. Anything else is a plain pass.
  async function stepLocked(agentId: string, config: Config, why: string, evidence: SwapEvidence) {
    const obligation = await returns.get(agentId);
    if (!obligation) return;
    const first = obligation.stages?.first;
    // The refusal must be the first stage's own: an error naming another model (a turn still on the original) is not.
    if (!first || obligation.phase !== "fallback" || obligation.stage !== "first" || !isSwapEvidence(evidence) ||
      (evidence.named && !sameModel(evidence.named, first.model))) return reconcileLocked(agentId, config);
    const api = await deps.acquire();
    const agent = await fetchAgent(api, agentId);
    if (!agent || stageOf(obligation, profileOf(agent)) !== "first" || writeBlocked(obligation, agent, config)) return reconcileLocked(agentId, config);
    if (!config.pmFallback) {
      once(agentId, `pm-stage-held agentId=${agentId} reason=pmFallback-off trigger=${why}`);
      return reconcileLocked(agentId, config);
    }
    const decision = swapDecision(await deps.quota("claude", config), await deps.quota(agentPool("pi", obligation.stages!.last.model) ?? "codex", config));
    if (!decision.swap) {
      once(agentId, `pm-stage-held agentId=${agentId} reason=${JSON.stringify(decision.reason)} trigger=${why}`);
      return reconcileLocked(agentId, config);
    }
    await startStage(obligation, "last", `trigger=${why}`);
    await reconcileLocked(agentId, config);
  }

  async function swapLocked(agentId: string, config: Config, why: string, evidence: SwapEvidence) {
    if (await returns.get(agentId)) return stepLocked(agentId, config, why, evidence);
    if (!config.pmFallback || !isSwapEvidence(evidence)) return;
    const api = await deps.acquire();
    const agent = await fetchAgent(api, agentId);
    if (!agent) return;
    const wasDropped = dropped.get(agentId);
    if (wasDropped && sameProfile(profileOf(agent), wasDropped)) return once(agentId, `pm-fallback-skipped agentId=${agentId} reason=return-dropped profile=${show(wasDropped)}`);
    dropped.delete(agentId);
    const ineligible = fallbackIneligible(agent);
    if (ineligible) {
      if (agent.labels?.role === "pm") once(agentId, `pm-fallback-skipped agentId=${agentId} reason=${ineligible}`);
      return;
    }
    const configured: Profile = { model: config.pmFallbackModel, thinkingOptionId: config.pmFallbackThinking, serviceTier: config.pmFallbackServiceTier };
    const live = profileOf(agent)!;
    // A chained original (Fable): an account-level refusal of it moves the PM to the chain's first stage (Opus), or
    // straight to the last when pq proves every Claude account out. Any other original: the single step, as before.
    // A chained refusal is read against a fresh pq reading, which also tells whether pq and the provider disagree.
    const entry = config.pmFallbackFirst.find((item) => item.from === live.model);
    const claude = await deps.quota("claude", config, entry ? { fresh: true } : undefined);
    const lastPool = await deps.quota(agentPool("pi", configured.model) ?? "codex", config);
    let stage: "first" | "last" = "last", note = "", distrusted = false;
    if (entry) {
      const window = scopedWindow(live.model);
      if (!chainRefusal(evidence, claude, window)) return once(agentId, `pm-fallback-held agentId=${agentId} reason="not-account-level" trigger=${why}`);
      // Refused while pq shows this model's window left (a cooldown pq cannot see): pq proof will not return this PM.
      distrusted = !!window && scopedCapacity(claude, window);
      if (distrusted) note += ` pq=fable-contradicted`;
      const decision = chainDecision(claude, lastPool);
      if (!decision.stage) return once(agentId, `pm-fallback-held agentId=${agentId} reason=${JSON.stringify(decision.reason)} trigger=${why}`);
      stage = decision.stage;
      if (decision.stage === "last") note += ` reason=${decision.reason}`;
    } else {
      const decision = swapDecision(claude, lastPool);
      if (!decision.swap) return once(agentId, `pm-fallback-held agentId=${agentId} reason=${JSON.stringify(decision.reason)} trigger=${why}`);
    }
    const last = await inCatalog(api, configured);
    if (!last) return once(agentId, `pm-fallback-skipped agentId=${agentId} reason=fallback-not-in-catalog profile=${show(configured)}`);
    // The first stage writes no Fast label.
    const firstWanted: Profile | null = entry ? { model: entry.model, thinkingOptionId: entry.thinking, serviceTier: null } : null;
    const first = firstWanted ? await inCatalog(api, firstWanted) : null;
    if (firstWanted && !first) return once(agentId, `pm-fallback-skipped agentId=${agentId} reason=first-stage-not-in-catalog profile=${show(firstWanted)}`);
    const original = await inCatalog(api, live);
    if (!original) return once(agentId, `pm-fallback-skipped agentId=${agentId} reason=original-not-in-catalog profile=${show(live)}`);
    const chain = first ? { stages: { first, last }, stage, ...(distrusted ? { pqFableDistrusted: true } : {}) } : null;
    const fallback = chain ? chain.stages[stage] : last;
    const stored = await returns.add(newObligation(agentId, original, fallback, "auto", "switching", Date.now(), chain));
    if (!stored) return reconcileLocked(agentId, config);
    log(`pm-swap-start agentId=${agentId} obligationId=${stored.obligationId} trigger=${why}${chain ? ` stage=${stage}${note}` : ""} original=${show(original)} fallback=${show(fallback)}`);
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
    async afterTurnEnded(agentId: string, outcome: Parameters<typeof turnSwapEvidence>[0], config: Config, normalReply = false, endedAt = new Date().toISOString()): Promise<boolean> {
      const evidence = turnSwapEvidence(outcome);
      // A normal reply on a Claude subscription model, from an agent with no return of its own, while some PM waits on
      // the fallback profile: proof for the return. The agent is read only then.
      if (outcome.kind === "completed" && normalReply && !await returns.get(agentId)) {
        const waiting = (await returns.read()).obligations.some((o) => o.phase === "fallback");
        const agent = waiting ? await fetchAgent(await deps.acquire(), agentId).catch(() => null) : null;
        const model = agent?.model ?? agent?.runtimeInfo?.model;
        if (agent && model && isSubscriptionClaude(agent.provider, model)) {
          const at = Date.parse(endedAt);
          const previous = claudeSuccess.get(model);
          if (!previous || previous.at < at) claudeSuccess.set(model, { agentId, at });
        }
      }
      if (await returns.get(agentId)) await locked(agentId, () => stepLocked(agentId, config, "usage-limit-turn", evidence));
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
        const obligation = await returns.get(record.agentId);
        if (obligation) {
          // A held refusal on the first stage of a chain moves the PM on to the last.
          if (obligation.stages && obligation.phase === "fallback" && obligation.stage === "first" && sameModel(record.model, obligation.stages.first.model)) {
            await locked(record.agentId, () => stepLocked(record.agentId, config, "usage-record-held", evidence));
          }
          continue;
        }
        await locked(record.agentId, () => swapLocked(record.agentId, config, "usage-record-held", evidence));
      }
    },
  };
}

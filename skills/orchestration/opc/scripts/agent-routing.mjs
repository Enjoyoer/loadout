import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  isArmedServer, isCursorHostServer, isMappedServer, remoteCursorUnattendedMode, verifiedRemote,
} from './remote-target.mjs';

const effortOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const efforts = new Set(effortOrder);
const model = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[[A-Za-z0-9][A-Za-z0-9._-]{0,31}\])?$/;

export const MAX_CHATGPT_BROWSER_TABS = 5;

export function isValidModelId(value) {
  return typeof value === 'string' && model.test(value);
}

export const FIXED_ROLE_ROUTES = Object.freeze({
  // Owner decision 277a (adopted 2026-11-28, decision 429a): scout runs Terra high, Fast off.
  scout: Object.freeze({ label: 'Terra', fallbackProvider: 'codex', effort: 'high', fastMode: false }),
  reviewer: Object.freeze({ label: 'Web Pro', fallbackProvider: 'codex', effort: null, fastMode: false }),
});
// Fixed routes a role ran before a change. A route recorded as one of them still validates and launches on it; a new
// launch takes the current fixed route.
const FORMER_FIXED_ROLE_ROUTES = Object.freeze({
  scout: Object.freeze([Object.freeze({ label: 'Sol', fallbackProvider: 'codex', effort: 'xhigh', fastMode: false })]),
});

// Worker task classes when the owner names no model. Labels resolve through the target Pi catalog. Each class runs at
// its default effort. ceiling is the highest effort an already recorded lane of the class may rebuild at (lanes
// recorded before OPC 7.66 could sit above the default); null means the default.
const workerClass = (label, effort, ceiling = null, fastMode = false) => Object.freeze({ label, effort, ceiling, fastMode });
// Local code lanes default to Opus high (owner 2026-11-18); plan, ui-design and ui-check run Fable high; research runs
// Terra high (owner item 111). Routes are the minimum
// (owner rule): nothing lowers a route. Every class runs Fast off (owner 2026-11-07) except the Luna classes, which run
// Fast on (owner 2026-11-17), review, browser and browser-hard, which run Fast on by default (owner decision 327,
// 2026-11-22), and review-security (owner decision 332); otherwise Fast is an owner-named exception per task.
export const WORKER_DEFAULT_ROUTES = Object.freeze({
  // Owner 2026-11-18: code runs at Opus high; ceiling xhigh keeps earlier xhigh lanes rebuildable.
  code: workerClass('Opus', 'high', 'xhigh'),
  review: workerClass('Sol', 'high', null, true),
  // Owner decision 332: security, credential and data-loss reviews run on Sol xhigh, Fast on. After a terminal Sol
  // failure or a blocker verdict the PM may start one separate owner-named Opus xhigh, Fast off lane (routing.md);
  // FORMER_CLASS_ROUTES keeps earlier Opus high and xhigh lanes rebuildable.
  'review-security': workerClass('Sol', 'xhigh', null, true),
  // Owner 2026-11-18 (decision 244): plan runs read-only on Fable high, Fast off; FORMER_CLASS_ROUTES keeps earlier Sol
  // high lanes rebuildable.
  plan: workerClass('Fable', 'high'),
  // Owner item 111: research is its own read-only class on Terra high, Fast off, no longer an alias of plan. A research
  // lane recorded before the split carries kind plan and still rebuilds as a plan lane.
  research: workerClass('Terra', 'high'),
  // Owner 2026-11-17: browser, including computer use and desktop application workflows (owner 2026-11-18), runs at Sol
  // low; ceiling high keeps earlier medium lanes rebuildable.
  browser: workerClass('Sol', 'low', 'high', true),
  // Owner 2026-11-18: browser-hard runs at Sol high, not Astra, for fragile, ambiguous or repeatedly failing browser work.
  'browser-hard': workerClass('Sol', 'high', null, true),
  smoke: workerClass('Luna', 'low', null, true),
  // Owner 2026-11-18: watchers, heartbeats and scheduled jobs run at Sol low, Fast off; FORMER_CLASS_ROUTES keeps
  // earlier Luna xhigh lanes rebuildable.
  watcher: workerClass('Sol', 'low'),
  // Hosted Codex Sites interaction: native Codex Luna xhigh, Fast on (owner 2026-11-17).
  sites: workerClass('Luna', 'xhigh', null, true),
});
export const WORKER_CLASS_ALIASES = Object.freeze({
  'code-bounded': 'code', 'test-fix': 'code', automation: 'code', mechanical: 'code',
  'review-critical': 'review', 'review-general': 'review', security: 'review-security',
});
// The pre-7.53 ui class name, kept as a compatibility alias of ui-design.
const OWNER_RULE_ALIASES = Object.freeze({ ui: 'ui-design' });
export const canonicalWorkerClass = kind => Object.hasOwn(WORKER_CLASS_ALIASES, kind ?? '') ? WORKER_CLASS_ALIASES[kind]
  : Object.hasOwn(OWNER_RULE_ALIASES, kind ?? '') ? OWNER_RULE_ALIASES[kind] : kind;
const workerRule = kind => WORKER_DEFAULT_ROUTES[canonicalWorkerClass(kind)];
// Default routes a class ran before a class-table change. A lane recorded as that exact default still rebuilds on it,
// any route on that label in the class keeps its Fast rule, and no new task default takes it.
const FORMER_CLASS_ROUTES = Object.freeze({
  watcher: Object.freeze([Object.freeze({ label: 'Luna', effort: 'xhigh', fastMode: true })]),
  plan: Object.freeze([Object.freeze({ label: 'Sol', effort: 'high', fastMode: false })]),
  'review-security': Object.freeze([Object.freeze({ label: 'Opus', effort: 'high', fastMode: false }),
    Object.freeze({ label: 'Opus', effort: 'xhigh', fastMode: false })]),
});
// Each label draws on one provider's quota pool.
export const LABEL_POOLS = Object.freeze({ Opus: 'claude', Sonnet: 'claude', Fable: 'claude', Sol: 'codex', Terra: 'codex', Luna: 'codex', Astra: 'codex' });
// Owner rules for whole lanes. They resolve to owner-explicit routes, so nothing adjusts them.
// ui-design (read-only spec and static mockup) and ui-check (read-only compare of after-screenshots to the mockup) are
// Fable lanes, like the plan class; the build goes to a code lane (owner rule).
const FABLE_RULE = Object.freeze({ label: 'Fable', effort: 'high', fastMode: false });
export const OWNER_RULE_ROUTES = Object.freeze({
  'ui-design': Object.freeze({ ...FABLE_RULE, reason: 'ui-design: owner rule, Fable high, no GPT, read-only' }),
  'ui-check': Object.freeze({ ...FABLE_RULE, reason: 'ui-check: owner rule, Fable high, no GPT, read-only' }),
});
export const UI_CLASSES = Object.freeze(Object.keys(OWNER_RULE_ROUTES));
const uiClass = kind => UI_CLASSES.includes(canonicalWorkerClass(kind));
// UI work never uses GPT models or the ChatGPT web lane (owner rule).
export const GPT_WEB_LABELS = Object.freeze(['Sol', 'Terra', 'Luna', 'Astra', 'Web Pro', 'Web Extra']);
const GPT_WEB_MODEL = /(?:^|\/)(?:gpt-|chatgpt-web\/)/i;
export function isGptOrWebRoute(route, catalog = null) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  // A task default takes its class's label, unless it is a recorded former default of another label (an Opus
  // review-security lane from before decision 332).
  const label = route?.label ?? (route?.source === 'task-default' && !formerClassRoute(route, route.kind, rows) ? workerRule(route.kind)?.label
    : rows?.find(row => row.id === route?.model || row.id?.slice(row.id.indexOf('/') + 1) === route?.model)?.label);
  return GPT_WEB_LABELS.includes(label) || GPT_WEB_MODEL.test(route?.model ?? '');
}

// A class whose label is a Claude model never runs a GPT or web model, whatever a route claims.
const claudeClassOnGptModel = (rule, route) => !GPT_WEB_LABELS.includes(rule.label) && GPT_WEB_MODEL.test(route.model);
// A catalog row serves a model named by its full id or by its id without the provider prefix.
const namesRow = (row, model) => row.id === model || row.id?.slice(row.id.indexOf('/') + 1) === model;

// Web models are reserved for the fixed reviewer, even with native authorization or an opaque catalog id.
function requireWorkerModel(model, catalog = null) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  if (/(?:^|\/)chatgpt-web\//i.test(model ?? '') ||
      rows?.some(row => namesRow(row, model) && (/^Web(?:\s|$)/i.test(row.label ?? '') ||
        /(?:^|\/)chatgpt-web\//i.test(row.id ?? '')))) {
    throw Error('chatgpt-web models are reviewer-only; Workers cannot use the web lane');
  }
}

// A model id names a catalog label as one of its tokens, as fleet/claude-opus-5-5 and claude-opus-5-5[1m] name Opus.
const namesLabel = (model, label) => new RegExp(`(?:^|[/._-])${label.toLowerCase()}(?:$|[/._[-])`, 'i').test(model ?? '');
// A GPT or web model by its name or, with a catalog, by its row's label; never by a class table.
const isGptOrWebModel = (model, rows) => GPT_WEB_MODEL.test(model ?? '') ||
  GPT_WEB_LABELS.includes(rows?.find(row => namesRow(row, model))?.label);

// A ui-design or ui-check lane records and launches only Fable high, Fast off, never a GPT or web model (owner rule).
// With a catalog the model must be its Fable row; without one (a brief, a record) the model id must name Fable.
export function isUiRoute(route, catalog = null) {
  const rule = FABLE_RULE, rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  return route?.effort === rule.effort && route.fastMode === rule.fastMode && !isGptOrWebModel(route.model, rows) &&
    (rows ? namesRow(resolveCatalogLabel(rows, rule.label), route.model) : namesLabel(route.model, rule.label));
}

// Fable runs only at high with Fast off, in any lane and for any route, classless or not (owner rule).
// A model is a label's by its catalog row or, without one, by its name.
const labelModel = (model, label, rows) => rows?.find(row => namesRow(row, model))?.label === label || namesLabel(model, label);
const isFableModel = (model, rows) => labelModel(model, FABLE_RULE.label, rows);
const fableProblem = (route, rows = null) => isFableModel(route?.model, rows) &&
  !(route.effort === FABLE_RULE.effort && route.fastMode === FABLE_RULE.fastMode) ? 'Fable runs only at high with Fast off' : null;
function requireFableRule(route, rows = null) {
  const problem = fableProblem(route, rows);
  if (problem) throw Error(`${problem} (owner rule)`);
}
// A Luna class (Fast on, owner 2026-11-17) takes no route with Fast off, owner-named or not, and neither does a route
// on a former Fast-on Luna label of its class (a watcher on Luna). The Sol Fast-on defaults (decision 327) refuse nothing.
const FAST_REQUIRED_LABEL = 'Luna';
const formerClassRoutes = (route, taskClass, rows) => {
  const kind = canonicalWorkerClass(taskClass);
  return (Object.hasOwn(FORMER_CLASS_ROUTES, kind ?? '') ? FORMER_CLASS_ROUTES[kind] : [])
    .filter(former => labelModel(route?.model, former.label, rows));
};
const formerClassRoute = (route, taskClass, rows) => formerClassRoutes(route, taskClass, rows)[0];
function classFastProblem(route, taskClass, rows = null) {
  const kind = canonicalWorkerClass(taskClass), former = formerClassRoute(route, kind, rows);
  if (route?.fastMode === true) return null;
  const rule = WORKER_DEFAULT_ROUTES[kind];
  if (rule?.fastMode && rule.label === FAST_REQUIRED_LABEL) return `the ${kind} class runs Fast on (owner 2026-11-17)`;
  return former?.fastMode && former.label === FAST_REQUIRED_LABEL ? `a ${kind} route on ${former.label} runs Fast on (owner 2026-11-17)` : null;
}

// The owner's hard rules for a lane class bind every route, whatever its source says: ui-design and ui-check are exactly
// Fable high, Fast off, these classes never run a GPT or web model, Fable never runs at another level, a Fast-on class
// never runs Fast off, and no route runs below its class minimum. Inside them an owner-named route keeps its model and
// effort. A recorded lane (recorded) on a non-GPT model keeps its class's former minimum (FORMER_CLASS_MINIMUMS).
const CLAUDE_ONLY_CLASSES = Object.freeze(['code']);
// A class's minimum before a class-table change, kept for a lane recorded on a non-GPT model: review-security ran only
// non-GPT routes at high or above before decision 332 (an Opus, Sonnet or Fable lane), and those lanes still rebuild.
const FORMER_CLASS_MINIMUMS = Object.freeze({ 'review-security': 'high' });
function laneProblem(route, taskClass, rows, recorded = false) {
  taskClass = canonicalWorkerClass(taskClass);
  if (route.source === 'task-default' && canonicalWorkerClass(route.kind) !== taskClass) return `it is a ${route.kind} route`;
  if (offPaceRoute(route)) {
    if (route.kind !== taskClass) return `it is a ${route.kind} route`;
    if (unapprovedOffPace(route)) return `recorded ${route.source} is not its approved runtime`;
  }
  if (devinFirstRoute(route)) {
    if (route.kind !== taskClass) return `it is a ${route.kind} route`;
    if (unapprovedDevinFirst(route)) return `recorded ${route.source} is not its approved runtime`;
  }
  const offPace = offPaceRoute(route), devinFirst = devinFirstRoute(route);
  if (uiClass(taskClass)) return offPace || devinFirst || isUiRoute(route, rows) ? null : `a ${taskClass} lane runs only Fable high, Fast off`;
  const ownerRule = fableProblem(route, rows) ?? classFastProblem(route, taskClass, rows);
  if (ownerRule) return ownerRule;
  const rule = WORKER_DEFAULT_ROUTES[taskClass];
  // The one GPT exception: the exact off-pace backup in an eligible off-pace class, which records only through its
  // admitted off-pace resolution and launches only from its own recorded lane (owner decisions 310, 316, 393a).
  const backup = (route.source === 'pace-backup' || route.source === CURSOR_OVERFLOW_SOURCE) && offPace;
  if (CLAUDE_ONLY_CLASSES.includes(taskClass) && isGptOrWebModel(route.model, rows) && !backup) {
    return `${route.model} is a GPT or web model and the ${taskClass} class runs ${rule.label}`;
  }
  // The backup's medium is the owner's own level for it (2026-11-21), below the class minimum by decision.
  const former = recorded && Object.hasOwn(FORMER_CLASS_MINIMUMS, taskClass) && !isGptOrWebModel(route.model, rows)
    ? FORMER_CLASS_MINIMUMS[taskClass] : rule.effort;
  const minimum = Math.min(effortOrder.indexOf(rule.effort), effortOrder.indexOf(former));
  return !backup && effortOrder.indexOf(route.effort) < minimum
    ? `effort ${route.effort} is below the ${taskClass} minimum ${effortOrder[minimum]}` : null;
}
const knownClass = taskClass => Object.hasOwn(WORKER_DEFAULT_ROUTES, canonicalWorkerClass(taskClass) ?? '') || uiClass(taskClass);
// A task default runs its class's own model: with a catalog exactly the class's row, without one a model id that names
// the class's label (the name rule of the UI check), failing closed.
function defaultIdentityProblem(route, rows) {
  const rule = workerRule(route.kind);
  if (rows) return classModelId(route.kind, resolveCatalogLabel(rows, rule.label).id) === classModelId(route.kind, route.model) ? null : `${route.model} is not the ${route.kind} class's ${rule.label} model`;
  return namesLabel(route.model, rule.label) ? null : `${route.model} does not name the ${route.kind} class's ${rule.label} model`;
}

// A fresh lane's route checked against its intended class (recording, and a launch with no recorded route); with
// recorded, a lane's recorded route checked against the class it was recorded for (route.mjs replaying its flags).
export function validateLaneClass(route, taskClass, catalog = null, { recorded = false } = {}) {
  taskClass = canonicalWorkerClass(taskClass);
  if (!knownClass(taskClass)) throw workerRouteUnresolved();
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const problem = laneProblem(route, taskClass, rows, recorded) ?? (route.source === 'task-default' ? defaultIdentityProblem(route, rows) : null);
  if (problem) throw Error(`${taskClass} lane refuses this Worker route: ${problem}`);
}

// One route per lane: once a lane has a recorded route, the request, brief, and recording paths take only that route.
// Returns the lane's record entry, or null for a fresh lane.
export function recordedLaneEntry(task, lane, route) {
  const entry = task?.routes && Object.hasOwn(task.routes, lane ?? '') ? task.routes[lane] : null;
  if (entry && !isDeepStrictEqual(entry.route, route)) throw Error(`lane ${lane} already has a recorded route; repairs and resumes reuse it`);
  return entry;
}

const classReason = (kind, rule) => `${kind} default ${rule.label} ${rule.effort}, Fast ${rule.fastMode ? 'on' : 'off'}`;

// The one-line reason recorded with a Worker route and shown in its brief.
export const routeReason = route => route.reason ?? 'owner-named, never adjusted';

// Browser and Sites classes have standing native Codex authorization; other native Workers need a task owner decision.
export const BROWSER_NATIVE_AUTHORIZATION = 'owner 2026-10-14';
export const NATIVE_CLASS_AUTHORIZATION = Object.freeze({ browser: BROWSER_NATIVE_AUTHORIZATION,
  'browser-hard': BROWSER_NATIVE_AUTHORIZATION, sites: 'owner 2026-11-17' });
const browserClass = kind => Object.hasOwn(NATIVE_CLASS_AUTHORIZATION, canonicalWorkerClass(kind) ?? '');
const nativeModelId = id => id.slice(id.indexOf('/') + 1);
const classModelId = (kind, id) => browserClass(kind) ? nativeModelId(id) : id;
const routeClass = (route, taskClass) => taskClass ?? (route?.source === 'task-default' ? route.kind : null);
export const NATIVE_WORKER_AUTHORIZATION = 'owner-explicit';

function requireNativeAuthorization(provider, nativeAuthorization, reason) {
  if (nativeAuthorization !== NATIVE_WORKER_AUTHORIZATION) {
    throw Error(`${reason}; Workers run on Pi only, and a native ${provider.split('/')[0]} Worker needs an explicit owner authorization for this task`);
  }
}

export function resolveCatalogLabel(catalog, label) {
  const matches = catalog?.filter(row => row.label === label) || [];
  if (matches.length !== 1) throw Error(`catalog label ${label} must have exactly one row (found ${matches.length})`);
  return matches[0];
}

export function materializeFixedRoute(role, catalog, surface = 'pi') {
  if (!Object.hasOwn(FIXED_ROLE_ROUTES, role)) throw Error(`unknown fixed role: ${role}`);
  return materializeRule(FIXED_ROLE_ROUTES[role], catalog, surface);
}

// Maps a fixed-role rule that validateFixedRoute returned (the current route or a former approved one) to the catalog.
function materializeRule(rule, catalog, surface) {
  const provider = surface === 'pi' ? 'pi' : rule.fallbackProvider;
  const rows = Array.isArray(catalog) && surface === 'pi' ? catalog : catalog?.[provider];
  const row = resolveCatalogLabel(rows, rule.label);
  if (rule.effort && !row.thinkingOptions?.some(option => option.id === rule.effort)) {
    throw Error(`${rule.label} does not serve required thinking ${rule.effort}; use an explicitly selected fallback catalog`);
  }
  return { ...rule, model: row.id, provider: `${provider}/${row.id}` };
}

// While Claude is off pace (owner decision 314a, 2026-11-21; extended to default plan, ui-design and ui-check by
// While Claude is off pace (owner decision 314a, 2026-11-21; superseded by decision 393a for code-only agy Neon High
// -> agy Opus High -> Sol Medium Fast off, and decision 390a reverting fresh plan/ui-design/ui-check off-pace
// admissions while keeping legacy 366a receipts readable and rebuildable), a new Worker lane on a default code route
// runs on the generic ACP provider agy-opc in agy's native auto mode with auto_accept true. route.mjs admits it; a lane
// records it with a receipt binding task, lane, target and placement, never the routing.json state; it launches only
// from that recorded lane, and only while the record is exactly an approved runtime.
export const OFF_PACE_CLASSES = Object.freeze(['code']);
export const LEGACY_OFF_PACE_CLASSES = Object.freeze(['code', 'plan', 'ui-design', 'ui-check']);
export const DEVIN_FIRST_CLASSES = Object.freeze(['code', 'plan', 'ui-design', 'ui-check']);
export const OPUS_REPLACEMENT_RUNTIME = Object.freeze({ provider: 'agy-opc', extends: 'acp', model: 'claude-opus-5-5-high',
  effort: 'high', fastMode: false, mode: 'auto' });
export const REPLACEMENT_RUNTIME = Object.freeze({ provider: 'agy-opc', extends: 'acp', model: 'gemini-4-neon-high',
  effort: 'high', fastMode: false, mode: 'auto' });
// Decision 393a order: Neon High first, then exact agy Opus High.
export const REPLACEMENT_RUNTIMES = Object.freeze([REPLACEMENT_RUNTIME, OPUS_REPLACEMENT_RUNTIME]);
export const replacementRuntimeForModel = id => REPLACEMENT_RUNTIMES.find(rt => rt.model === id) ?? null;
export const OPUS_REPLACEMENT_REASON = 'code replacement for Opus high, Fast off while Claude is off pace: agy Opus high on the verified ACP runtime';
export const REPLACEMENT_REASON = 'code replacement for Opus high, Fast off while Claude is off pace: Neon high on the verified ACP runtime';
export const replacementReason = (kind, model = REPLACEMENT_RUNTIME.model) => {
  if (!LEGACY_OFF_PACE_CLASSES.includes(kind)) return null;
  if (model === OPUS_REPLACEMENT_RUNTIME.model) {
    return kind === 'code' ? OPUS_REPLACEMENT_REASON
      : `${kind} replacement for Fable high, Fast off while Claude is off pace: agy Opus high on the verified ACP runtime`;
  }
  if (model === REPLACEMENT_RUNTIME.model) {
    return kind === 'code' ? REPLACEMENT_REASON
      : `${kind} replacement for Fable high, Fast off while Claude is off pace: Neon high on the verified ACP runtime`;
  }
  return null;
};
// Decision 359: while the switch says not forced (a valid fresh false), new eligible code lanes of one launcher alternate
// subscription Opus high vs the agy side (Neon high first, then agy Opus high, then admissible Sol backup), one each.
export const OPUS_PARITY_REASON = 'code equal default, agy turn of the per-launcher subscription Opus and agy alternation: agy Opus high on the verified ACP runtime';
export const PARITY_REASON = 'code equal default, Neon turn of the per-launcher Opus and Neon alternation: Neon high on the verified ACP runtime';
export const parityReason = (model = REPLACEMENT_RUNTIME.model) => model === OPUS_REPLACEMENT_RUNTIME.model ? OPUS_PARITY_REASON
  : model === REPLACEMENT_RUNTIME.model ? PARITY_REASON : null;
const isParityReason = reason => reason === PARITY_REASON || reason === OPUS_PARITY_REASON;
const approvedReplacementReasons = (kind, model) => {
  const forced = replacementReason(kind, model);
  if (!forced) return [];
  const parity = kind === 'code' ? parityReason(model) : null;
  return parity ? [forced, parity] : [forced];
};
const RECEIPT_KEYS = ['provider', 'mode', 'target', 'task', 'lane', 'placement'];
// The backup when both agy models cannot launch (owner decisions 310, 316, 393a, medium per owner 2026-11-21): Pi Sol
// medium, Fast off, the one GPT route an eligible off-pace lane may run, and only as a lane recorded with this source
// and its class's approved reason, while off pace or (for code) on a decision 359 agy turn (route.mjs).
export const PACE_BACKUP_RUNTIME = Object.freeze({ model: 'fleet/gpt-6.2-sol', label: 'Sol', effort: 'medium', fastMode: false });
export const PACE_BACKUP_REASON = 'code backup while Claude is off pace and Neon cannot launch: Sol medium, Fast off';
export const paceBackupReason = kind => kind === 'code' ? PACE_BACKUP_REASON
  : LEGACY_OFF_PACE_CLASSES.includes(kind)
    ? `${kind} backup while Claude is off pace and Neon cannot launch: Sol medium, Fast off` : null;
// The same backup taken on a decision 359 agy turn, only with fresh evidence/holds that both agy models cannot launch.
export const PARITY_BACKUP_REASON = 'code backup on a Neon turn of the per-launcher alternation when Neon cannot launch: Sol medium, Fast off';
const approvedBackupReasons = kind => kind === 'code' ? [PACE_BACKUP_REASON, PARITY_BACKUP_REASON]
  : LEGACY_OFF_PACE_CLASSES.includes(kind) ? [paceBackupReason(kind)] : [];
// Decision 398a: the existing native Cursor overflow workflow (319b/320a) bound to the launch gate. Only an eligible
// bounded remote code lane, only after both agy models are held or positively unavailable on the authenticated target, and
// before Sol medium. Explicit cursor/gemini-4-neon, model-fixed thinking, 300k context, Fast off, no Max or Auto.
export const CURSOR_OVERFLOW_SOURCE = 'cursor-overflow';
export const CURSOR_OVERFLOW_LABEL = 'cursor-overflow';
export const CURSOR_OVERFLOW_RUNTIME = Object.freeze({ provider: 'cursor', model: 'gemini-4-neon', effort: null, fastMode: false, context: '300k' });
export const CURSOR_OVERFLOW_REASON = 'code overflow while Claude is off pace and both agy models cannot launch: Cursor Neon, 300k context, Fast off, no Max or Auto';
// Policy constants: an authenticated fresh Cursor plan_usage reading (the stock `paseo usage` report of source cursor,
// last success within the max age) must be strictly below this used percentage.
export const CURSOR_USAGE_MAX_USED_PCT = 98;
export const CURSOR_USAGE_MAX_AGE_MS = 10 * 60 * 1000;
export const CURSOR_USAGE_SOURCE = 'cursor';
export const CURSOR_USAGE_WINDOW = 'plan_usage';
// The existing bounded native Cursor path runs only on the configured Cursor host entry (remote-target.mjs), a linux host.
export const CURSOR_HOST_PLATFORM = 'linux';
const CURSOR_EXCLUSIONS_MAX = 64;
// owner/repo of a recorded task remote (https, ssh, or scp form), lowercased; null when it cannot be established.
export function taskProjectSlug(remote) {
  const m = typeof remote === 'string'
    ? /^(?:https?:\/\/[^/\s]+\/|ssh:\/\/[^/\s]+\/|[A-Za-z0-9._-]+@[^:/\s]+:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim())
    : null;
  return m ? m[1].toLowerCase() : null;
}
// Decision 398a sensitivity gate, checked at admission, record, and launch: a code lane other than main, whose task
// record states payment_data === false, on the configured Cursor host, whose project ancestry is authenticated and not listed
// in the private routing.json cursorExcludedProjects (a valid non-empty list; empty or absent admits no Cursor). Ancestry is authenticated only when the task's
// checkout, read live with git, still has the recorded origin, and every agent of the launcher chain (PASEO_AGENT_ID and
// its ParentAgentId chain, read from the local daemon) reports its working directory; an exclusion token found in the
// project slug, origin, real checkout path, or any launcher's working directory excludes the lane. Anything that cannot be
// established fails closed. Returns null when eligible, else a reason code (never echoes project identifiers).
export function cursorEligibilityProblem({ task, lane, kind, targetDaemon, doc = readLocalRouting(), ancestry = undefined }) {
  if (canonicalWorkerClass(kind) !== 'code') return 'class';
  if (typeof lane !== 'string' || !lane || lane === 'main') return 'lane';
  if (!task || typeof task !== 'object' || task.ui === true || task.payment_data !== false) return 'sensitivity';
  if (!isCursorHostServer(targetDaemon)) return 'target';
  const excluded = cursorExclusions(doc);
  if (!excluded) return 'exclusions';
  const slug = taskProjectSlug(task.repository?.remote);
  const dir = task.repository?.working_directory;
  if (!slug || typeof dir !== 'string' || !dir) return 'project';
  let liveOrigin, realDir;
  try {
    realDir = realpathSync(dir);
    liveOrigin = execFileSync('git', ['-C', realDir, 'remote', 'get-url', 'origin'],
      { timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 1 << 16 }).trim();
  } catch { return 'project'; } // probe-ok: fails closed, an unreadable checkout or origin admits no Cursor lane; expires 2027-05-22
  if (liveOrigin !== task.repository.remote) return 'project';
  if (ancestry === undefined) ancestry = launcherAncestry();
  if (!Array.isArray(ancestry) || !ancestry.length || ancestry[0].id !== process.env.PASEO_AGENT_ID ||
      ancestry.some(agent => typeof agent?.cwd !== 'string' || !agent.cwd.startsWith('/'))) return 'ancestry';
  if (cursorExcludedHit(excluded, [slug, liveOrigin, realDir, ...ancestry.map(agent => agent.cwd)])) return 'excluded';
  if (!offPaceLaunchAllowed(doc, ancestry.map(agent => agent.id))) return 'launcher';
  return null;
}
// The valid non-empty cursorExcludedProjects list, else null (no Cursor).
function cursorExclusions(doc) {
  const excluded = doc?.cursorExcludedProjects;
  return Array.isArray(excluded) && excluded.length > 0 && excluded.length <= CURSOR_EXCLUSIONS_MAX &&
    excluded.every(entry => typeof entry === 'string' && entry.trim() && entry.length <= 256) ? excluded : null;
}
const cursorExcludedHit = (excluded, values) => {
  const haystack = values.map(value => value.toLowerCase());
  return excluded.some(entry => { const token = entry.trim().toLowerCase(); return haystack.some(value => value.includes(token)); });
};
// Decision 398a at launch: the Cursor host worktree Cursor runs in, read on the authenticated launch connection, must have the task's
// recorded origin, and neither its origin, owner/repo, worktree path, nor project root may carry an exclusion token.
function cursorRemoteWorkspaceProblem(task, workspace, doc = readLocalRouting()) {
  const excluded = cursorExclusions(doc);
  const { origin, cwd, projectRoot } = workspace ?? {};
  if (!excluded) return 'exclusions';
  if (typeof origin !== 'string' || typeof cwd !== 'string' || typeof projectRoot !== 'string' ||
      origin !== task?.repository?.remote) return 'project';
  const slug = taskProjectSlug(origin);
  if (!slug) return 'project';
  return cursorExcludedHit(excluded, [slug, origin, cwd, projectRoot]) ? 'excluded' : null;
}
// Devin-first Pi Opus High branch (Decision 397c/399a: positive fresh Config-owned devin-ready.json only).
export const DEVIN_FIRST_RUNTIME = Object.freeze({ model: 'fleet/claude-opus-5-5', label: 'Opus', effort: 'high', fastMode: false });
export const devinFirstReason = kind => DEVIN_FIRST_CLASSES.includes(kind)
  ? `${kind} Devin-first Pi Opus high, Fast off (positive fresh CPA signal)` : null;
const BACKUP_RECEIPT_KEYS = ['task', 'lane', 'placement'];
const BOUND_BACKUP_RECEIPT_KEYS = ['target', 'task', 'lane', 'placement'];
// In-process live resolution attestation: stamped only by resolveWorkerRoute (route.mjs) with exact lane, target,
// class, and a live policy/daemon re-verification closure checked right at fresh launch/record time so remembered
// defaults, cross-lane reuse, and stale local runtimes are all refused.
export const LIVE_RESOLUTION_MAX_AGE_MS = 60 * 1000;
// A local agy replacement launch's caller-read inspect_provider capabilities are usable only this long after checked_at.
export const LOCAL_CAPABILITIES_MAX_AGE_MS = 2 * 60 * 1000;
const liveResolutions = new WeakMap();
export function stampLiveResolution(route, meta) {
  if (route && typeof route === 'object') {
    liveResolutions.set(route, Object.freeze({ ...meta, resolvedAt: Date.now() }));
  }
  return route;
}
export function liveResolutionMeta(route, now = Date.now()) {
  const meta = route && typeof route === 'object' ? liveResolutions.get(route) : null;
  return meta && meta.resolvedAt <= now && now - meta.resolvedAt <= LIVE_RESOLUTION_MAX_AGE_MS ? meta : null;
}
export function assertLiveResolution(route, { task = null, lane = null, taskClass = null, target = null, serverId = null, inPlace = false } = {}) {
  const live = liveResolutionMeta(route);
  if (!live || live.launchable !== true) {
    throw Error('fresh Worker launch requires a fresh live route from resolveWorkerRoute; pasted, remembered, or stale routes are refused');
  }
  if (inPlace && live.inPlaceAllowed !== true) {
    throw Error('this resolved route requires managed worktree placement and cannot launch in place');
  }
  const expectedClass = taskClass === 'opn-browser' ? 'opn-browser' : canonicalWorkerClass(taskClass ?? route?.kind);
  if (expectedClass != null && live.taskClass !== expectedClass) {
    throw Error(`live resolved route is for ${live.taskClass}, not ${expectedClass}; resolve again`);
  }
  if (task != null && live.taskId != null && live.taskId !== task.id) {
    throw Error('live resolved route is bound to another task; resolve again for this task');
  }
  if (lane != null && live.lane != null && live.lane !== lane) {
    throw Error(`live resolved route is bound to lane ${live.lane}, not ${lane}; resolve again`);
  }
  if (inPlace && lane != null && live.lane !== lane) {
    throw Error(`in-place fresh launch must resolve specifically for lane ${lane}; resolve again`);
  }
  if (task != null && (live.taskId !== task.id || live.lane !== lane)) {
    throw Error('fresh bound Worker launch requires resolveWorkerRoute bound to this exact task and lane; resolve again');
  }
  const launchTarget = target?.daemon ?? serverId ?? null;
  if (launchTarget != null && live.targetDaemon != null && live.targetDaemon !== 'local' && live.targetDaemon !== launchTarget) {
    throw Error('launch target does not match the live resolved target; resolve again');
  }
  // Exact remote binding: a remote launch (target.local === false) must have been resolved for exactly that daemon;
  // a local/'local'/unbound resolution never authorizes a remote placement, and the MCP serverId must agree.
  if (target?.local === false && (live.targetDaemon !== target.daemon || (serverId != null && serverId !== target.daemon))) {
    throw Error('remote launch requires a live route resolved for exactly this remote daemon; resolve again');
  }
  if (typeof live.verifyLive === 'function' && live.verifyLive() !== true) {
    throw Error('live routing policy or local daemon state changed since this route was resolved; resolve again');
  }
  return live;
}
// Resolver-only policies outside the 12-class worker table: main-pm (read-only policy ladder) and opn-browser (the named
// OPN native Codex browser exception, keeping the browser class unchanged and never admitting a code GPT route).
export const MAIN_PM_POLICY = Object.freeze({
  defaultRoute: Object.freeze({
    role: 'main-pm', source: 'policy-default', model: 'fleet/claude-opus-5-5', effort: 'high', fastMode: false,
    reason: 'main-pm default Claude Opus high, Fast off (resolver-only policy)',
  }),
  fallbackChain: Object.freeze([
    // Owner 404b correction (2026-11-25): main PMs (Config, Work, Personal) fall back only to Neon High or Opus High, in
    // this order: native agy Neon High, Cursor Neon High, agy Opus High. Sol is never a main-PM fallback.
    Object.freeze({ step: 'agy-neon', provider: 'agy-opc/gemini-4-neon-high', model: 'gemini-4-neon-high', effort: 'high', fast: false, standIn: true }),
    Object.freeze({ step: 'cursor-neon', provider: 'cursor/gemini-4-neon', model: 'gemini-4-neon', effort: 'high', fast: false }),
    Object.freeze({ step: 'agy-opus', provider: 'agy-opc/claude-opus-5-5-high', model: 'claude-opus-5-5-high', effort: 'high', fast: false, standIn: true }),
  ]),
});
// Owner decision 412a (2026-11-27): a fresh PM-started OPN browser worker runs native Codex gpt-6.2-sol, thinking low,
// Fast on, in the PM's own workspace so it shares the Paseo browser (native Codex gets the Paseo MCP browser tools from
// its runtime Paseo MCP server). No caller override changes the model, thinking, Fast, or workspace.
export const OPN_BROWSER_EXCEPTION = Object.freeze({
  provider: 'codex', model: 'gpt-6.2-sol', effort: 'low', fastMode: true,
  reason: 'opn-browser named exception: native Codex gpt-6.2-sol low, Fast on (PM workspace, owner 412a)',
  modeId: 'full-access',
});
// The one native Codex catalog row (`paseo provider models codex`, unprefixed ids) serving the opn-browser model at its
// thinking; a Pi row such as fleet/gpt-6.2-sol never authorizes it.
export function resolveOpnBrowserRow(rows) {
  const { model, effort } = OPN_BROWSER_EXCEPTION;
  const served = (Array.isArray(rows) ? rows : []).filter(row => row?.id === model &&
    row.thinkingOptions?.some(option => option?.id === effort));
  if (served.length !== 1) {
    throw Error(`the catalog must serve exactly one native Codex ${model} at ${effort} thinking; the opn-browser lane stops`);
  }
  return served[0];
}
// The native Codex full-access mode, advertised exactly once (stock Paseo Codex may omit isUnattended on it) and with no
// other unattended mode beside it; anything else is ambiguous and stops the opn-browser lane.
export function selectOpnBrowserMode(capabilities) {
  const { modeId } = OPN_BROWSER_EXCEPTION;
  const modes = capabilities?.enabled === true && capabilities.status === 'available' && Array.isArray(capabilities.modes)
    ? capabilities.modes : null;
  const full = modes?.filter(mode => mode?.id === modeId) ?? [];
  if (full.length !== 1 || full[0].isUnattended === false ||
      modes.some(mode => mode?.isUnattended === true && mode.id !== modeId)) {
    throw Error(`native Codex must advertise exactly one ${modeId} mode and no other unattended mode; the opn-browser lane stops`);
  }
  return modeId;
}
// Whether a route is an opn-browser route: its policy marker, which survives the CLI's JSON so a parsed or pasted copy
// stays marked, or resolveWorkerRoute's live opn-browser stamp. No caller class, omitted or other, maps a marked route
// to Pi, to the browser class, or to a recorded or managed lane; only the live stamp authorizes an in-place launch.
export const isOpnBrowserRoute = route => route != null && typeof route === 'object' &&
  (route.policy === 'opn-browser' || liveResolutions.get(route)?.taskClass === 'opn-browser');
// Whether already-parsed JSON text repeats a key in any object, with escaped spellings decoded.
export function repeatsKey(text) {
  const objects = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = objects.at(-1);
      if (keys && expectKey) {
        const key = JSON.parse(text.slice(i, end + 1));
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      i = end;
    } else if (c === '{') { objects.push(new Set()); expectKey = true; }
    else if (c === '[') { objects.push(null); expectKey = false; }
    else if (c === '}' || c === ']') { objects.pop(); expectKey = false; }
    else if (c === ',') expectKey = objects.at(-1) != null;
  }
  return false;
}
// The user's local OPC routing file, ~/.config/opc/routing.json, parsed, or null: read only on a Mac, from a regular file
// (no symlink) owned by this user and writable by no one else, at most 1 MiB, with no repeated key anywhere.
export function readLocalRouting() {
  return readOwnerJson(join(homedir(), '.config', 'opc', 'routing.json'));
}
// Any owner-only local OPC file read the same strict way (routing.json, the remote target mapping), or null.
export function readOwnerJson(path) {
  return process.platform === 'darwin' ? readOwnerJsonFile(path) : null;
}
// The same strict owner-only read on any POSIX host. Decision 435a uses it only for the Config-published Linux copy of
// routing.json, and only its antigravityFallback key (route.mjs); every Mac reader stays on readOwnerJson.
export function readOwnerJsonFile(path) {
  if (typeof process.getuid !== 'function') return null;
  let text;
  try {
    const link = lstatSync(path);
    if (!link.isFile()) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev || stat.uid !== process.getuid() ||
          (stat.mode & 0o022) !== 0 || stat.size > 1 << 20) return null;
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' && !Array.isArray(doc) && !repeatsKey(text) ? doc : null;
  } catch { return null; } // probe-ok: fails closed, an unreadable routing file allows no off-pace route; expires 2027-05-22
}

// Excluded launchers, listed locally in the routing file as replacementExcludedLaunchers (agent id prefixes), never take
// an off-pace route, nor does anything they launch: the launching agent (PASEO_AGENT_ID) and its ParentAgentId chain on
// the local daemon, at most 16 agents, must all be readable and none may match. A missing or malformed list, or a chain
// that cannot be read in full, allows no off-pace route.
const MAX_LAUNCHER_CHAIN = 16;
// The launcher chain as the local daemon reports it: [{id, cwd}] from PASEO_AGENT_ID up its ParentAgentId chain, or null.
export function launcherAncestry() {
  const env = { ...process.env };
  delete env.PASEO_HOST;
  const chain = [];
  for (let id = process.env.PASEO_AGENT_ID; chain.length < MAX_LAUNCHER_CHAIN;) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(id)) return null;
    let agent;
    try {
      agent = JSON.parse(execFileSync('paseo', ['inspect', id, '--json'],
        { env, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 16 << 20 }));
    } catch { return null; } // probe-ok: fails closed, an unreadable launcher chain allows no off-pace route; expires 2027-05-22
    if (agent?.Id !== id) return null;
    chain.push(Object.freeze({ id, cwd: typeof agent.Cwd === 'string' ? agent.Cwd : null }));
    if (agent.ParentAgentId === '' || agent.ParentAgentId === null) return chain;
    id = agent.ParentAgentId;
  }
  return null;
}
export function launcherChain() {
  const ancestry = launcherAncestry();
  return ancestry ? ancestry.map(agent => agent.id) : null;
}
// chain: a launcher chain read earlier in this process (launcherChain), so a caller holding a lock need not wait on it.
export function offPaceLaunchAllowed(doc = readLocalRouting(), chain = undefined) {
  const prefixes = doc?.replacementExcludedLaunchers;
  if (!Array.isArray(prefixes) || prefixes.some(prefix => typeof prefix !== 'string' || !prefix || prefix.length > 128)) return false;
  if (chain === undefined) chain = launcherChain();
  return Array.isArray(chain) && chain.length > 0 && chain[0] === process.env.PASEO_AGENT_ID &&
    !chain.some(id => prefixes.some(prefix => id.startsWith(prefix)));
}
// The local daemon's own serverId, from its read-only `paseo daemon status --json` (local home, never PASEO_HOST), or null
// when the daemon is not running or the status cannot be read. Decision 359 binds a parity lane's local target to it.
export function localServerId() {
  const env = { ...process.env };
  delete env.PASEO_HOST;
  try {
    const status = JSON.parse(execFileSync('paseo', ['daemon', 'status', '--json'],
      { env, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 1 << 20 }));
    return status?.localDaemon === 'running' && isTargetId(status.serverId) ? status.serverId : null;
  } catch { return null; } // probe-ok: fails closed, an unreadable local daemon status admits no parity lane; expires 2027-05-22
}
export const isReplacementMode = mode => mode === REPLACEMENT_RUNTIME.mode;
// The request settings of every replacement launch, fixed: thinking and the one generic ACP feature, auto_accept, set
// explicitly so nothing depends on what the launching parent would pass on; a caller cannot change or add to them.
export const replacementSettings = () => ({ thinkingOptionId: REPLACEMENT_RUNTIME.effort, features: { auto_accept: true } });
// A record or route that is not exactly an approved agy replacement runtime (class, provider, model, thinking, Fast, reason, mode).
const unapprovedReplacement = route => {
  const runtime = replacementRuntimeForModel(route.model);
  return !runtime || !LEGACY_OFF_PACE_CLASSES.includes(route.kind) ||
    route.effort !== runtime.effort || route.fastMode !== runtime.fastMode ||
    !approvedReplacementReasons(route.kind, runtime.model).includes(route.reason) ||
    route.receipt?.provider !== runtime.provider || !isReplacementMode(route.receipt?.mode);
};
// A record or route that is not exactly the off-pace backup (class, model, thinking, Fast, reason).
const unapprovedBackup = route => !LEGACY_OFF_PACE_CLASSES.includes(route.kind) ||
  route.model !== PACE_BACKUP_RUNTIME.model || route.effort !== PACE_BACKUP_RUNTIME.effort ||
  route.fastMode !== PACE_BACKUP_RUNTIME.fastMode || !approvedBackupReasons(route.kind).includes(route.reason);
const unapprovedCursor = route => route.kind !== 'code' || route.model !== CURSOR_OVERFLOW_RUNTIME.model ||
  route.effort !== null || route.fastMode !== false || route.reason !== CURSOR_OVERFLOW_REASON ||
  route.receipt?.provider !== CURSOR_OVERFLOW_RUNTIME.provider;
const unapprovedOffPace = route => route.source === 'replacement' ? unapprovedReplacement(route)
  : route.source === CURSOR_OVERFLOW_SOURCE ? unapprovedCursor(route) : unapprovedBackup(route);
export const OFF_PACE_SOURCES = Object.freeze(['replacement', 'pace-backup', CURSOR_OVERFLOW_SOURCE]);
export const DEVIN_FIRST_SOURCE = 'devin-first';
const offPaceRoute = route => OFF_PACE_SOURCES.includes(route?.source);
const devinFirstRoute = route => route?.source === DEVIN_FIRST_SOURCE;
const unapprovedDevinFirst = route => !DEVIN_FIRST_CLASSES.includes(route.kind) ||
  route.model !== DEVIN_FIRST_RUNTIME.model || route.effort !== DEVIN_FIRST_RUNTIME.effort ||
  route.fastMode !== DEVIN_FIRST_RUNTIME.fastMode || route.reason !== devinFirstReason(route.kind);
export const isTargetId = value => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
const exactKeys = (value, keys) => value != null && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const validBinding = receipt => /^[A-Za-z0-9-]{8,128}$/.test(receipt.task ?? '') &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(receipt.lane ?? '') && receipt.lane.length <= 40 &&
  /^opc\/[a-z0-9-]+-[0-9a-f]{16}$/.test(receipt.placement ?? '');
function validReceipt(source, receipt, kind) {
  if (source === DEVIN_FIRST_SOURCE) {
    return exactKeys(receipt, BACKUP_RECEIPT_KEYS) && validBinding(receipt);
  }
  if (source === 'pace-backup') {
    const bound = exactKeys(receipt, BOUND_BACKUP_RECEIPT_KEYS) && isTargetId(receipt.target) && validBinding(receipt);
    return kind === 'code'
      ? (exactKeys(receipt, BACKUP_RECEIPT_KEYS) && validBinding(receipt)) || bound
      : bound;
  }
  const provider = source === CURSOR_OVERFLOW_SOURCE ? CURSOR_OVERFLOW_RUNTIME.provider : REPLACEMENT_RUNTIME.provider;
  return exactKeys(receipt, RECEIPT_KEYS) && receipt.provider === provider &&
    typeof receipt.mode === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(receipt.mode) &&
    isTargetId(receipt.target) && validBinding(receipt);
}
// A recorded off-pace or devin-first route is checked for shape, like any record, so it stays readable;
// a launch also requires it to be exactly its approved runtime (validateLaunchedWorkerRoute).
function validateRecordedOffPace(route) {
  const cursor = route?.source === CURSOR_OVERFLOW_SOURCE;
  const allowedClasses = route?.source === DEVIN_FIRST_SOURCE ? DEVIN_FIRST_CLASSES : cursor ? ['code'] : LEGACY_OFF_PACE_CLASSES;
  if (!exactKeys(route, ['role', 'source', 'kind', 'model', 'effort', 'fastMode', 'reason', 'receipt']) ||
      route.role !== 'worker' || !allowedClasses.includes(route.kind) || !isValidModelId(route.model) ||
      !(cursor ? route.effort === null : efforts.has(route.effort)) ||
      route.fastMode !== false || typeof route.reason !== 'string' || !route.reason.trim() || /[\r\n]/.test(route.reason) ||
      !validReceipt(route.source, route.receipt, route.kind)) {
    throw Error(`recorded ${route?.source} route required for worker`);
  }
  return Object.freeze({ model: route.model, effort: route.effort, fastMode: false, source: route.source, kind: route.kind,
    reason: route.reason, receipt: Object.freeze({ ...route.receipt }) });
}

// A recorded replacement rebuilds on the same runtime as the target serves it now, never by the routing.json state: the
// launch target is the recorded local Mac target and is the server the managed workspace was created on (its serverId),
// capabilities are MCP inspect_provider's for exactly the replacement provider with MCP list_models rows as models, and
// they serve exactly the recorded model at its thinking and advertise the pinned mode. Otherwise the lane stops.
function replacementMode(route, capabilities, target, serverId, remote = null, workspace = null) {
  const { receipt } = route;
  if (!isTargetId(serverId) || serverId !== receipt.target) {
    throw Error('the managed workspace is not on the recorded target server; the replacement lane stops');
  }
  if (target?.local === false) {
    // A remote target (decision 359): only a fresh attestation read just now on that target's authenticated connection,
    // for this managed workspace, stands in for capabilities; a caller's plain capabilities are refused.
    if (capabilities != null) throw Error('a remote replacement launch takes no caller capabilities; read the target with readRemoteNeonTarget');
    if (!verifiedRemote(remote, target) || target.daemon !== receipt.target || remote.workspace == null ||
        remote.workspace.workspaceId !== workspace?.workspaceId || remote.workspace.cwd !== workspace?.cwd ||
        remote.workspace.branchName !== receipt.placement) {
      throw Error('no fresh verified attestation of the recorded remote target and its managed workspace; the replacement lane stops');
    }
    capabilities = remote.capabilities;
  } else if (!exactKeys(target, ['daemon', 'local', 'platform']) || target.daemon !== receipt.target || target.local !== true ||
      target.platform !== 'darwin' || remote != null || isMappedServer(target.daemon)) {
    throw Error('replacement launch target is not the recorded local Mac target; the lane stops');
  } else {
    // Local capabilities are the inspect_provider read of this launch, stamped with when it was read: an old matching
    // object never stands in for the target's current state.
    const readAt = Date.parse(typeof capabilities?.checked_at === 'string' && /Z$/.test(capabilities.checked_at) ? capabilities.checked_at : '');
    const now = Date.now();
    if (!Number.isFinite(readAt) || readAt > now + 60_000 || now - readAt > LOCAL_CAPABILITIES_MAX_AGE_MS) {
      throw Error('local replacement capabilities need a fresh checked_at (inspect_provider read for this launch); the lane stops');
    }
  }
  if (capabilities?.provider !== receipt.provider || capabilities.enabled !== true || capabilities.status !== 'available' ||
      !Array.isArray(capabilities.models) || !Array.isArray(capabilities.modes)) {
    throw Error('available inspect_provider capabilities of the replacement provider required; the lane stops');
  }
  const rows = capabilities.models.filter(row => row?.id === route.model);
  if (rows.length !== 1 || !Array.isArray(rows[0].thinkingOptions) || !rows[0].thinkingOptions.some(option => option?.id === route.effort)) {
    throw Error(`the target does not serve exactly ${route.model} at ${route.effort} thinking; the replacement lane stops`);
  }
  // Only the pinned mode, advertised exactly once by the target.
  const modes = capabilities.modes.filter(mode => mode?.id === receipt.mode);
  if (!isReplacementMode(receipt.mode) || modes.length !== 1) {
    throw Error(`the target does not advertise the pinned ${REPLACEMENT_RUNTIME.mode} mode for this record; the replacement lane stops`);
  }
  // The capabilities are the inspect_provider draft of exactly these settings: its selected model, and each fixed feature
  // advertised once as a toggle holding the fixed value.
  const fixed = replacementSettings().features;
  if (capabilities.selectedModel !== route.model || !Array.isArray(capabilities.features) ||
      Object.entries(fixed).some(([id, value]) => {
        const advertised = capabilities.features.filter(feature => feature?.id === id);
        return advertised.length !== 1 || advertised[0].type !== 'toggle' || advertised[0].value !== value;
      })) {
    throw Error('the target\'s inspect_provider draft does not advertise the fixed replacement settings; the replacement lane stops');
  }
  return receipt.mode;
}

const routeText = route => `model=${route.model ?? route.label}; effort=${route.effort ?? 'model-fixed'}; Fast=${route.fastMode ? 'on' : 'off'}`;

// A recorded Worker route comes from the owner or from a task-class default with its reason.
// A recorded route is checked for shape only, so a later class-table change never strands its task. A task default
// recorded before OPC 7.66 also carries a retired key, which is read and ignored.
const RETIRED_DEFAULT_KEY = 'pace';
export function validateRecordedWorkerRoute(route) {
  requireWorkerModel(route?.model);
  if (offPaceRoute(route) || devinFirstRoute(route)) return validateRecordedOffPace(route);
  const taskDefault = route?.source === 'task-default';
  const retired = taskDefault && Object.hasOwn(route, RETIRED_DEFAULT_KEY) ? [RETIRED_DEFAULT_KEY] : [];
  const keys = ['role', 'source', 'model', 'effort', 'fastMode', ...(taskDefault ? ['kind', 'reason', ...retired] : [])];
  if (!route || typeof route !== 'object' || Array.isArray(route) || route.role !== 'worker' ||
      Object.keys(route).length !== keys.length || keys.some(key => !Object.hasOwn(route, key)) ||
      (route.source !== 'owner-explicit' && !taskDefault) || !isValidModelId(route.model) ||
      !efforts.has(route.effort) || typeof route.fastMode !== 'boolean' ||
      (taskDefault && (typeof route.kind !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.kind) ||
        typeof route.reason !== 'string' || !route.reason.trim() || /[\r\n]/.test(route.reason)))) {
    throw Error('recorded owner or task-default route required for worker');
  }
  return Object.freeze({ model: route.model, effort: route.effort, fastMode: route.fastMode, source: route.source,
    ...(taskDefault ? { kind: route.kind, reason: route.reason } : {}) });
}

// A route being recorded or launched must also match today's class table: class, Fast, and level, with no retired key.
// Fable at high with Fast off is checked on every new and launched route, not on reads, so a record stays readable.
function validateWorkerRoute(route) {
  const valid = validateRecordedWorkerRoute(route);
  requireFableRule(route);
  if (offPaceRoute(route)) {
    if (unapprovedOffPace(route)) throw Error(`a new ${route.source} route must be exactly its approved runtime`);
    return valid;
  }
  if (devinFirstRoute(route)) {
    if (unapprovedDevinFirst(route)) throw Error(`a new ${route.source} route must be exactly its approved runtime`);
    return valid;
  }
  const rule = workerRule(route.kind);
  if (route.source === 'task-default' && (!rule || route.fastMode !== rule.fastMode ||
      Object.hasOwn(route, RETIRED_DEFAULT_KEY) || route.effort !== rule.effort)) {
    throw Error('recorded owner or task-default route required for worker; a recorded lane rebuilds only with its ' +
      'destination task, lane, and class');
  }
  return valid;
}

// A recorded route rebuilds (repair, restart) only inside the owner's hard rules for the lane's class, whatever its source.
// A task default must also still be today's class: the class's catalog label (never a GPT or web model for a Claude
// class), the class's Fast, and, as the allowances for what a class-table change left behind, either Fast for a GPT
// class (Fast on recorded before GPT defaults went Fast off, Fast off recorded before decision 327 turned review and
// browser Fast on; a review-security Sol default, which only ever ran Fast on, keeps no other) and any effort from the class minimum up to its ceiling, which the Pi catalog must still serve, or
// exactly a former default of the class (FORMER_CLASS_ROUTES). A Luna class lane recorded with Fast off is refused
// (owner 2026-11-17).
function validateRebuild(route, taskClass, rows) {
  taskClass = canonicalWorkerClass(taskClass);
  const valid = validateRecordedWorkerRoute(route);
  const rule = WORKER_DEFAULT_ROUTES[taskClass];
  const ceiling = rule && (rule.ceiling ?? rule.effort);
  const former = recordedFormerDefault(route, taskClass, rows);
  const problem = laneProblem(route, taskClass, rows, true) ?? (route.source !== 'task-default' || former ? null
    : route.fastMode !== rule.fastMode && (!GPT_WEB_LABELS.includes(rule.label) || FAST_EXACT_CLASSES.includes(taskClass)) ? `Fast ${route.fastMode ? 'on' : 'off'} does not match the ${taskClass} class`
      : effortOrder.indexOf(route.effort) > effortOrder.indexOf(ceiling) ? `effort ${route.effort} is above the ${taskClass} ceiling ${ceiling}`
        : claudeClassOnGptModel(rule, route) ? `${route.model} is a GPT or web model and the ${taskClass} class runs ${rule.label}`
          : null);
  if (problem) throw Error(`recorded ${taskClass} Worker route cannot rebuild: ${problem}`);
  if (route.source !== 'task-default' || former) return valid;
  if (!rows) {
    const unnamed = defaultIdentityProblem(route, null);
    if (unnamed) throw Error(`recorded ${taskClass} Worker route cannot rebuild: ${unnamed}`);
    return valid;
  }
  const candidates = rows.filter(row => namesRow(row, route.model) ||
    (browserClass(taskClass) && nativeModelId(row.id) === nativeModelId(route.model)));
  if (!candidates.some(row => row.thinkingOptions?.some(option => option.id === route.effort))) {
    throw Error(`recorded ${route.kind} Worker route is no longer served: the Pi catalog ` +
      `${candidates.length ? `serves ${route.model} but not at ${route.effort} thinking` : `has no ${route.model}`}; ` +
      'this lane cannot relaunch on its recorded route, so resolve a route for a new lane');
  }
  if (classModelId(taskClass, resolveCatalogLabel(rows, rule.label).id) !== classModelId(taskClass, route.model)) {
    throw Error(`recorded ${route.kind} Worker route cannot rebuild: ${route.model} is not the ${route.kind} class's ${rule.label} model`);
  }
  return valid;
}

// GPT classes whose task default only ever ran with today's Fast, so a recorded default must match it: review-security
// on Sol, Fast on since decision 332.
const FAST_EXACT_CLASSES = Object.freeze(['review-security']);

// A recorded task default of the lane's class that is exactly a former default of that class (FORMER_CLASS_ROUTES),
// still served at its effort when a catalog is given. Only a lane with a recorded route may pass it. Like any recorded
// GPT default, a former GPT default recorded with Fast on keeps it.
function recordedFormerDefault(route, taskClass, rows) {
  const kind = canonicalWorkerClass(taskClass);
  return route?.source === 'task-default' && canonicalWorkerClass(route.kind) === kind &&
    formerClassRoutes(route, kind, rows).some(former => route.effort === former.effort &&
      (route.fastMode === former.fastMode || (route.fastMode === true && GPT_WEB_LABELS.includes(former.label))) &&
      (!rows || rows.some(row => row.label === former.label && namesRow(row, route.model) &&
        row.thinkingOptions?.some(option => option.id === route.effort))));
}

// The Worker route a brief or request is built from, bound to its destination task (as readTask returns it), lane, and
// intended class when given. Task records are bookkeeping, not routing authority, so the class comes from the caller: a
// UI task's lanes are ui-design (the default) or ui-check, and any other bound lane names its taskClass. A lane with a recorded route takes only that route
// and rebuilds under validateRebuild; a fresh lane is checked as new and against its class.
function validateLaunchedWorkerRoute(route, { task = null, lane = null, taskClass = null, catalog = null, target = null, serverId = null } = {}) {
  requireWorkerModel(route?.model, catalog);
  if (task != null && (typeof task !== 'object' || Array.isArray(task))) throw Error('destination task must be a task record');
  if (taskClass != null && !knownClass(taskClass)) throw workerRouteUnresolved();
  const laneClass = uiTaskLaneClass(task, taskClass);
  if (task != null && task.ui !== true && taskClass == null) throw Error('a Worker bound to a task record needs its lane class (taskClass)');
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  if (offPaceRoute(route)) {
    const { receipt, kind } = validateRecordedWorkerRoute(route);
    if (task == null || canonicalWorkerClass(laneClass) !== kind || receipt.task !== task.id || receipt.lane !== lane ||
        !recordedLaneEntry(task, lane, route)) throw Error(`a ${route.source} route launches only from its own recorded ${kind} lane`);
    if (!offPaceLaunchAllowed()) {
      throw Error(`no ${route.source} launch: the launcher is excluded, or the excluded-launcher list or launcher chain is unreadable`);
    }
    if (unapprovedOffPace(route)) throw Error(`recorded ${route.source} is not its approved runtime; the lane stops`);
    if (route.source === 'replacement' &&
        (isParityReason(route.reason) || kind !== 'code' || route.model === OPUS_REPLACEMENT_RUNTIME.model) &&
        !isMappedServer(route.receipt.target) && localServerId() !== route.receipt.target) {
      throw Error(isParityReason(route.reason)
        ? 'the local daemon is not the parity agy receipt target, or its status is unreadable; the lane stops'
        : 'the local daemon is not the Neon receipt target, or its status is unreadable; the lane stops');
    }
    if (route.source === CURSOR_OVERFLOW_SOURCE) {
      if (!isArmedServer(route.receipt.target)) throw Error('the Cursor overflow receipt target is not an armed remote host; the lane stops');
      if (cursorEligibilityProblem({ task, lane, kind, targetDaemon: route.receipt.target })) {
        throw Error('payment-data sensitivity or project exclusion blocks Cursor (decision 398a); the lane stops');
      }
    }
    if (route.source === 'pace-backup' && route.receipt.target != null) {
      const mapped = isMappedServer(route.receipt.target);
      if ((mapped && !isArmedServer(route.receipt.target)) || (!mapped && localServerId() !== route.receipt.target)) {
        throw Error('the local daemon is not the backup receipt target, or its status is unreadable; the lane stops');
      }
    }
  } else if (devinFirstRoute(route)) {
    const { receipt, kind } = validateRecordedWorkerRoute(route);
    if (task == null || canonicalWorkerClass(laneClass) !== kind || receipt.task !== task.id || receipt.lane !== lane ||
        !recordedLaneEntry(task, lane, route)) throw Error(`a ${route.source} route launches only from its own recorded ${kind} lane`);
    if (unapprovedDevinFirst(route)) throw Error(`recorded ${route.source} is not its approved runtime; the lane stops`);
  } else {
    if (task?.ui === true && !isUiRoute(route, rows)) {
      throw Error(`UI task: a ${laneClass} lane launches only Fable high, Fast off (owner rule); the build goes to a code task`);
    }
    requireFableRule(route, rows);
  }
  if (recordedLaneEntry(task, lane, route)) return validateRebuild(route, laneClass, rows);
  const valid = validateWorkerRoute(route);
  if (laneClass != null) validateLaneClass(route, laneClass, rows);
  else if (route.source === 'task-default') {
    const problem = defaultIdentityProblem(route, rows);
    if (problem) throw Error(`task-default Worker route must match its Pi catalog label (${problem})`);
  }
  // Every fresh class default (unrecorded lane, bound or unbound brief and surface) and every fresh bound UI-class route
  // must carry a fresh live resolution from resolveWorkerRoute bound to this exact task, lane, class, target, and current
  // live policy. An owner-named route is the owner's own and is never adjusted.
  if (route.source === 'task-default' || (task != null && uiClass(laneClass))) {
    assertLiveResolution(route, { task, lane, taskClass: laneClass ?? route.kind ?? null, target, serverId });
  }
  return valid;
}

// A UI task holds only the read-only Fable lanes: ui-design (the default) and ui-check. The build, copy, and logic go to a
// normal code task (owner rule). Returns the lane's canonical class.
export function uiTaskLaneClass(task, taskClass) {
  if (task?.ui !== true) return taskClass;
  const laneClass = canonicalWorkerClass(taskClass ?? 'ui-design');
  if (!uiClass(laneClass)) throw Error('UI task: its lanes take ui-design or ui-check (owner rule); the build goes to a code task');
  return laneClass;
}

export const workerRouteUnresolved = () => Error('Worker route unresolved; ask the owner for the exact model and effort ' +
  `(task classes: ${[...Object.keys(WORKER_DEFAULT_ROUTES), ...Object.keys(OWNER_RULE_ROUTES)].join(', ')})`);

// An owner-named model and effort always win unadjusted; otherwise the task class selects a catalog label and runs it
// at the class default.
export function selectWorkerRoute({ ownerRoute = null, taskKind = null, catalog } = {}) {
  taskKind = canonicalWorkerClass(taskKind);
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  if (ownerRoute) {
    if (ownerRoute.source !== 'owner-explicit') throw Error('owner Worker route must have source owner-explicit');
    requireWorkerModel(ownerRoute.model, rows);
    validateWorkerRoute(ownerRoute);
    requireFableRule(ownerRoute, rows);
    if (uiClass(taskKind) && isGptOrWebRoute(ownerRoute, rows)) {
      throw Error(`${taskKind} work never uses a GPT or web model (owner rule); name a Claude model or use the ${taskKind} class route`);
    }
    const fast = classFastProblem(ownerRoute, taskKind, rows);
    if (fast) throw Error(`${fast}; name the route with Fast on or use the class route`);
    // A standalone review-security resolution refuses what recording and launching it would refuse (its minimum).
    if (taskKind === 'review-security') validateLaneClass(ownerRoute, taskKind, rows);
    return Object.freeze({ ...ownerRoute });
  }
  if (Object.hasOwn(OWNER_RULE_ROUTES, taskKind ?? '')) {
    const rule = OWNER_RULE_ROUTES[taskKind];
    const row = resolveCatalogLabel(rows, rule.label);
    if (!row.thinkingOptions?.some(option => option.id === rule.effort)) {
      throw Error(`${rule.label} does not serve required thinking ${rule.effort}; the Worker lane stops`);
    }
    return Object.freeze({ role: 'worker', source: 'owner-explicit', model: row.id, effort: rule.effort, fastMode: rule.fastMode });
  }
  if (!Object.hasOwn(WORKER_DEFAULT_ROUTES, taskKind ?? '')) throw workerRouteUnresolved();
  const rule = WORKER_DEFAULT_ROUTES[taskKind];
  const row = resolveCatalogLabel(rows, rule.label);
  const effort = rule.effort;
  if (!row.thinkingOptions?.some(option => option.id === effort)) {
    throw Error(`${rule.label} does not serve required thinking ${effort}; the Worker lane stops`);
  }
  return Object.freeze({ role: 'worker', source: 'task-default', kind: taskKind, model: classModelId(taskKind, row.id),
    effort, fastMode: rule.fastMode, reason: classReason(taskKind, rule) +
      (browserClass(taskKind) ? `, native Codex authorized by ${NATIVE_CLASS_AUTHORIZATION[canonicalWorkerClass(taskKind)]}` : '') });
}

function validateFixedRoute(role, route) {
  const keys = ['label', 'fallbackProvider', 'effort', 'fastMode'];
  const matches = rule => route && typeof route === 'object' && !Array.isArray(route) &&
    Object.keys(route).length === keys.length && keys.every(key => route[key] === rule[key]);
  const fixed = [FIXED_ROLE_ROUTES[role], ...(Object.hasOwn(FORMER_FIXED_ROLE_ROUTES, role) ? FORMER_FIXED_ROLE_ROUTES[role] : [])]
    .find(rule => rule && matches(rule));
  if (!fixed) throw Error(`${role} must use the exact fixed OPC role route`);
  return fixed;
}

// Recording a lane (route.mjs) checks a Worker route as new. With no catalog at hand it also refuses a
// GPT or web model for a Claude class, which a launch refuses by catalog label.
export function validateRoleRoute(role, route) {
  if (role === 'worker') {
    const valid = validateWorkerRoute(route);
    if (route.source === 'task-default' && claudeClassOnGptModel(workerRule(route.kind), route)) {
      throw Error('recorded owner or task-default route required for worker; a Claude class never runs a GPT or web model');
    }
    return valid;
  }
  if (!Object.hasOwn(FIXED_ROLE_ROUTES, role)) throw Error(`unknown OPC role: ${role}`);
  return validateFixedRoute(role, route);
}

export function resolveAgentRoute(role, { explicitRoute = null, taskKind = null, catalog = null } = {}) {
  if (explicitRoute) {
    if (role !== 'worker') throw Error(`${role} must use the exact fixed OPC role route`);
    return validateWorkerRoute(explicitRoute);
  }
  if (role === 'worker') return validateWorkerRoute(selectWorkerRoute({ taskKind, catalog }));
  const route = FIXED_ROLE_ROUTES[role];
  if (!route) throw Error(`unknown OPC role: ${role}`);
  return route;
}

// Owner testing rule: tests a Worker writes for itself restate its own reading of intent.
const WORKER_TESTING_RULE = 'Testing rule: do not write new unit, integration, or end-to-end tests, and do not use test-driven development, unless the PM specifies the test cases. ' +
  'Verify against the acceptance checks, run the existing suites and keep them green, and keep existing tests unless the PM asks to remove them.';

const READ_ONLY_CLASSES = Object.freeze(['plan', 'research', 'review', 'review-security', ...UI_CLASSES]);
const READ_ONLY_BRIEFS = Object.freeze({
  // Owner item 111: research runs on Terra and asks Fable for judgment, never runs on Fable by default.
  research: 'Return findings with their sources. For a judgment call (which option to take, whether evidence settles a question), ask Fable through $ask-fable: write the question and every fact it needs to a file in your scratch folder and run python3 ~/.local/bin/fable-ask <question-file>. ',
  review: 'Review the exact PR head using references/simplifier-review.md as the brief. ',
  'review-security': 'Correctness review of the exact PR head: report concrete defects with file, line, and what breaks. ',
  'ui-design': 'From the current screens (screenshots and code), return a short design spec and a static mockup (HTML/CSS or images) at the scratch path the PM names. No repository edits, no PR. ',
  'ui-check': 'Compare the after-screenshots to the mockup once and return a fix list for the code lane. No repository edits, no PR. ',
});

// For a Worker, task, lane, and taskClass bind the brief to its destination (see validateLaunchedWorkerRoute); catalog,
// the Pi catalog rows, checks a task default's model by its row instead of by name.
export function buildDelegatedBrief({ role, route, brief, reason = null, task = null, lane = null, taskClass = null,
  catalog = null }) {
  if (typeof role !== 'string' || !role || typeof brief !== 'string' || !brief.trim()) {
    throw Error('delegated role and nonempty brief required');
  }
  if (reason != null && (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason))) throw Error('route reason must be one line');
  const resolved = route == null ? resolveAgentRoute(role)
    : role === 'worker' ? validateLaunchedWorkerRoute(route, { task, lane, taskClass, catalog }) : validateRoleRoute(role, route);
  if ((offPaceRoute(resolved) || devinFirstRoute(resolved)) && reason != null && reason !== resolved.reason) {
    throw Error(`a ${resolved.source} lane takes only its recorded reason`);
  }
  // A UI task's lane is ui-design or ui-check even when the caller names no class and the route carries no kind.
  const kind = canonicalWorkerClass((role === 'worker' ? uiTaskLaneClass(task, taskClass) : taskClass) ?? route?.kind);
  if (role === 'worker' && READ_ONLY_CLASSES.includes(kind)) {
    brief = `Read-only lane: do not edit, implement, or publish. ${READ_ONLY_BRIEFS[kind] ?? ''}\n\n${brief}`;
  } else if (role === 'worker' && resolved?.source === CURSOR_OVERFLOW_SOURCE) {
    brief = 'One bounded Cursor overflow task (300k context, Fast off, no Max or Auto). If you changed the model in ' +
      `~/.cursor/cli-config.json, restore it to default when done. On "Upgrade your plan to continue", stop and do not retry.\n\n${brief}`;
  } else if (role === 'worker' && isFableModel(resolved?.model, Array.isArray(catalog) ? catalog : catalog?.pi)) {
    // Anthropic's Fable 5.2 prompting guidance: an ownership sentence makes Fable merge duplicated code.
    brief = `You are the owner and long-term maintainer of this codebase, and its design is up to you, within the permitted changes of this brief.\n\n${brief}`;
  }
  const line = role === 'worker' ? `${routeText(resolved)}; route: ${reason ?? routeReason(resolved)}` : routeText(resolved);
  return `Fixed route for this ${role} lane: ${line}. This route is not a suggestion. You cannot delegate, launch another agent, choose another route, or substitute a model or effort. If this route fails, stop this lane and report the failure to the PM.\n\n${role === 'worker' ? `${WORKER_TESTING_RULE}\n\n` : ''}${brief}`;
}

export function selectTopology({ scale, independentQuestions = 0, browserReview = false, ui = false } = {}) {
  if (!['trivial', 'normal', 'cross-cutting'].includes(scale)) throw Error('task scale must be trivial, normal, or cross-cutting');
  if (!Number.isSafeInteger(independentQuestions) || independentQuestions < 0) throw Error('independent question count must be a nonnegative integer');
  if ([browserReview, ui].some(value => typeof value !== 'boolean')) {
    throw Error('topology decisions must be explicit booleans');
  }
  if (ui && browserReview) throw Error('UI work never uses the web reviewer (owner rule)');
  // UI work runs no GPT scouts (owner rule); the PM explores itself.
  const cap = scale === 'trivial' || ui ? 0 : scale === 'normal' ? 2 : 3;
  const scoutCount = Math.min(cap, independentQuestions);
  return Object.freeze({
    scoutCount,
    scoutRoute: scoutCount ? FIXED_ROLE_ROUTES.scout : null,
  });
}

// Model and thinking rules above remain authoritative. Workers run on Pi; a native route (explicit codex or claude
// surface, or a model/effort Pi does not serve) needs the owner's authorization. The claude surface takes only a model
// its catalog (the target's catalog rows) serves at the route's thinking, and has no Fast setting.
export const NATIVE_WORKER_SURFACES = Object.freeze(['codex', 'claude']);
export function mapRouteToPi(route, catalog, options = {}) {
  return mapRoute(route, catalog, options, false);
}
// recordedFormer: the route is a lane's recorded former class default, already checked by validateRebuild.
function mapRoute(route, catalog, { fallbackProvider = 'codex', surface = 'pi', nativeAuthorization = null, taskClass = null } = {},
  recordedFormer) {
  if (!route || !isValidModelId(route.model)) throw Error('selected OPC route required');
  if (offPaceRoute(route)) throw Error(`a ${route.source} route maps only from its recorded lane (resolveWorkerSurface)`);
  requireWorkerModel(route.model, catalog);
  if (!Array.isArray(catalog)) throw Error('target Pi catalog required');
  const originalProvider = route.provider?.split('/')[0] ?? fallbackProvider;
  const original = { ...route, provider: route.provider ?? `${originalProvider}/${route.model}` };
  if (surface !== 'pi' && !NATIVE_WORKER_SURFACES.includes(surface)) throw Error('surface must be pi, codex, or claude');
  if (route.source === 'task-default' && !recordedFormer && (!workerRule(route.kind) ||
      classModelId(route.kind, resolveCatalogLabel(catalog, workerRule(route.kind).label).id) !== classModelId(route.kind, route.model))) {
    throw Error('task-default Worker route must match its Pi catalog label');
  }
  if (browserClass(routeClass(route, taskClass)) && surface !== 'claude') {
    const id = nativeModelId(route.model);
    const served = catalog.filter(row => nativeModelId(row.id) === id &&
      row.thinkingOptions?.some(option => option.id === route.effort));
    if (served.length !== 1) throw Error(`native Codex catalog must serve exactly one ${id} at ${route.effort} thinking`);
    return { ...route, model: id, provider: `codex/${id}` };
  }
  if (surface === 'codex') {
    requireNativeAuthorization(original.provider, nativeAuthorization, 'native surface requested');
    return original;
  }
  const candidates = catalog.filter(row => row.id === route.model ||
    row.id?.slice(row.id.indexOf('/') + 1) === route.model);
  const supported = candidates.filter(row => route.effort == null ||
    row.thinkingOptions?.some(option => option.id === route.effort));
  if (surface === 'claude') {
    requireNativeAuthorization(`claude/${route.model}`, nativeAuthorization, 'native surface requested');
    if (route.fastMode) throw Error('a native Claude Code Worker has no Fast setting; its route must have Fast off');
    if (!supported.some(row => row.id === route.model)) {
      throw Error(`Claude Code catalog does not serve ${route.model} at ${route.effort ?? 'model-fixed'} thinking`);
    }
    return { ...route, provider: `claude/${route.model}` };
  }
  if (!supported.length) {
    requireNativeAuthorization(original.provider, nativeAuthorization,
      `Pi catalog does not serve ${route.model} at ${route.effort ?? 'model-fixed'} thinking`);
    return original;
  }
  if (supported.length !== 1) throw Error('ambiguous Pi catalog model mapping');
  return { ...route, provider: `pi/${supported[0].id}` };
}

export function resolveAgentSurface(role, options = {}, catalog, surface = 'pi') {
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const route = resolveAgentRoute(role, role === 'worker' ? { ...options, catalog: rows } : options);
  return role === 'worker' ? mapRouteToPi(route, rows, { surface, nativeAuthorization: options.nativeAuthorization, taskClass: options.taskKind })
    : materializeFixedRoute(role, catalog, surface);
}

const CLAUDE_LABELS = Object.keys(LABEL_POOLS).filter(label => LABEL_POOLS[label] === 'claude');
const isClaudeModel = model => /(?:^|\/)claude-/i.test(model ?? '') || CLAUDE_LABELS.some(label => namesLabel(model, label));

// A Worker bound to a task record is validated in full (binding, class, rebuild rules, UI rule, minimum) before any
// explicit provider, which must then be exactly the provider its validated route maps to, with that route's settings.
// An explicit native provider (codex/ or claude/) selects that native surface for the mapping.
// A replacement route (source replacement) also needs capabilities, the target's capabilities for the replacement
// provider, target, the launch target {daemon, local, platform}, and serverId, the managed workspace's server; it maps to
// that provider and returns its modeId.
export function resolveWorkerSurface({ provider, agentSettings = {}, role = 'worker', route, catalog, surface = 'pi',
  nativeAuthorization = null, task = null, lane = null, taskClass = null, capabilities = null, target = null,
  serverId = null, remote = null, workspace = null, inPlace = false } = {}) {
  if (isOpnBrowserRoute(route)) {
    throw Error('an opn-browser route launches only in place with taskClass opn-browser (buildInPlaceWorkerRequest)');
  }
  const replacement = role === 'worker' && route?.source === 'replacement';
  const backup = role === 'worker' && route?.source === 'pace-backup';
  const devinFirst = role === 'worker' && route?.source === DEVIN_FIRST_SOURCE;
  const cursor = role === 'worker' && route?.source === CURSOR_OVERFLOW_SOURCE;
  if (role === 'worker') {
    requireWorkerModel(route?.model, catalog);
    requireWorkerModel(String(provider ?? '').replace(/^(?:pi|codex|claude)\//, ''), catalog);
  }
  const bound = role === 'worker' && task != null;
  const standingBrowser = role === 'worker' && browserClass(routeClass(route, taskClass)) && route != null;
  if (provider && !String(provider).startsWith('pi/') && role === 'worker' &&
      !(standingBrowser && String(provider).startsWith('codex/')) &&
      !(replacement && String(provider).startsWith(`${REPLACEMENT_RUNTIME.provider}/`)) &&
      !(cursor && provider === `${CURSOR_OVERFLOW_RUNTIME.provider}/${CURSOR_OVERFLOW_RUNTIME.model}`)) {
    requireNativeAuthorization(String(provider), nativeAuthorization, `explicit provider ${provider}`);
  }
  // A fixed role passed with its route is validated and mapped like a bound Worker; with no route it passes through.
  const fixedWithRoute = role !== 'worker' && route != null;
  // An in-place Worker never passes a caller's provider through: it must equal its validated route's mapping, thinking included.
  if (provider && !bound && !inPlace && !standingBrowser && !fixedWithRoute && !replacement && !backup && !devinFirst && !cursor) {
    return { provider, agentSettings };
  }
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const selected = role === 'worker' ? validateLaunchedWorkerRoute(route, { task, lane, taskClass, catalog: rows, target, serverId })
    : validateRoleRoute(role, route);
  if (selected.source === DEVIN_FIRST_SOURCE) {
    const served = (rows ?? []).filter(row => row?.id === selected.model && row.label === DEVIN_FIRST_RUNTIME.label &&
      row.thinkingOptions?.some(option => option?.id === selected.effort));
    if (served.length !== 1) throw Error(`the Pi catalog does not serve exactly ${selected.model} at ${selected.effort}; the devin-first lane stops`);
    const mapped = `pi/${selected.model}`, settings = { thinkingOptionId: selected.effort };
    if (provider && (provider !== mapped || (Object.keys(agentSettings).length && !isDeepStrictEqual(agentSettings, settings)))) {
      throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped})`);
    }
    if (!provider && Object.keys(agentSettings).length) throw Error('materialize settings from the selected rule or pass an explicit provider');
    return { provider: mapped, agentSettings: settings };
  }
  if (selected.source === 'replacement') {
    const modeId = replacementMode(selected, capabilities, target, serverId, remote, workspace);
    const mapped = `${selected.receipt.provider}/${selected.model}`, settings = replacementSettings();
    if (provider && (provider !== mapped || (Object.keys(agentSettings).length && !isDeepStrictEqual(agentSettings, settings)))) {
      throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped})`);
    }
    if (!provider && Object.keys(agentSettings).length) throw Error('materialize settings from the selected rule or pass an explicit provider');
    return { provider: mapped, agentSettings: settings, modeId };
  }
  // Decision 398a: Cursor overflow launches only on its recorded armed remote target from a fresh authenticated
  // cursorLaunch attestation of that managed workspace (no caller capabilities or settings), on the one unattended mode
  // recorded at admission, with the model served exactly.
  if (selected.source === CURSOR_OVERFLOW_SOURCE) {
    const { receipt } = selected;
    if (capabilities != null) throw Error('a Cursor overflow launch takes no caller capabilities; read the target with readRemoteAgyTarget({cursorLaunch: true})');
    if (target?.local !== false || !isTargetId(serverId) || serverId !== receipt.target || target.daemon !== receipt.target) {
      throw Error('the managed workspace is not on the recorded remote Cursor target; the Cursor lane stops');
    }
    if (!verifiedRemote(remote, target) || remote.agyStatus !== 'cursor-launch' || remote.workspace == null ||
        remote.workspace.workspaceId !== workspace?.workspaceId || remote.workspace.cwd !== workspace?.cwd ||
        remote.workspace.branchName !== receipt.placement) {
      throw Error('no fresh verified Cursor launch attestation of the recorded remote target and managed workspace; the Cursor lane stops');
    }
    if (cursorRemoteWorkspaceProblem(task, remote.workspace)) {
      throw Error('the Cursor host worktree is not the task\'s project, or its origin or path is excluded or unreadable (decision 398a); the Cursor lane stops');
    }
    if (remoteCursorUnattendedMode(remote) !== receipt.mode) {
      throw Error(`the configured Cursor host does not serve exactly cursor/${selected.model} with its recorded unattended mode and a passing quota preflight; the Cursor lane stops`);
    }
    const mapped = `${CURSOR_OVERFLOW_RUNTIME.provider}/${selected.model}`;
    if (provider && provider !== mapped) throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped})`);
    if (Object.keys(agentSettings).length) throw Error('a Cursor overflow launch takes no caller settings');
    return { provider: mapped, agentSettings: {}, modeId: receipt.mode, capabilities: remote.cursorCapabilities };
  }
  // The off-pace backup runs only on Pi, on its exact catalog row at its thinking; never native or unserved.
  // Bound backup lanes (plan, ui-design, ui-check, or remote code) bind target and workspace to either the admitted
  // local daemon or a fresh authenticated remote attestation (no caller capabilities). Legacy local code backup
  // receipts (no target key) stay unchanged and local-only.
  if (selected.source === 'pace-backup') {
    let effectiveRows = rows, remotePiCaps = null;
    if (target?.local === false) {
      if (capabilities != null) {
        throw Error('a remote backup launch takes no caller capabilities; read the target with readRemoteAgyTarget');
      }
      if (!selected.receipt.target || !isTargetId(serverId) || serverId !== selected.receipt.target) {
        throw Error('the managed workspace is not on the recorded target server; the backup lane stops');
      }
      if (!verifiedRemote(remote, target) || target.daemon !== selected.receipt.target || remote.workspace == null ||
          remote.workspace.workspaceId !== workspace?.workspaceId || remote.workspace.cwd !== workspace?.cwd ||
          remote.workspace.branchName !== selected.receipt.placement || remote.piCapabilities?.enabled !== true ||
          remote.piCapabilities.status !== 'available' || !Array.isArray(remote.piCapabilities.modes) ||
          remote.piCapabilities.modes.length !== 0 || !Array.isArray(remote.piCapabilities.models)) {
        throw Error('no fresh verified attestation of the recorded remote target, Pi catalog, and managed workspace; the backup lane stops');
      }
      remotePiCaps = remote.piCapabilities;
      effectiveRows = remotePiCaps.models;
    } else {
      if (remote != null) throw Error('backup launch target is not the recorded local Mac target; the lane stops');
      if (selected.receipt.target != null) {
        if (!isTargetId(serverId) || serverId !== selected.receipt.target) {
          throw Error('the managed workspace is not on the recorded target server; the backup lane stops');
        }
        if (!exactKeys(target, ['daemon', 'local', 'platform']) || target.daemon !== selected.receipt.target ||
            target.local !== true || target.platform !== 'darwin' || isMappedServer(target.daemon)) {
          throw Error('backup launch target is not the recorded local Mac target; the lane stops');
        }
      }
    }
    const served = (effectiveRows ?? []).filter(row => row?.id === selected.model && row.label === PACE_BACKUP_RUNTIME.label &&
      row.thinkingOptions?.some(option => option?.id === selected.effort));
    if (served.length !== 1) throw Error(`the Pi catalog does not serve exactly ${selected.model} at ${selected.effort}; the backup lane stops`);
    const mapped = `pi/${selected.model}`, settings = { thinkingOptionId: selected.effort };
    if (provider && (provider !== mapped || (Object.keys(agentSettings).length && !isDeepStrictEqual(agentSettings, settings)))) {
      throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped})`);
    }
    if (!provider && Object.keys(agentSettings).length) throw Error('materialize settings from the selected rule or pass an explicit provider');
    return { provider: mapped, agentSettings: settings, ...(remotePiCaps ? { capabilities: remotePiCaps } : {}) };
  }
  const native = String(provider ?? '').split('/')[0];
  const nativeSurface = surface === 'pi' && NATIVE_WORKER_SURFACES.includes(native) ? native : surface;
  const recordedFormer = bound && recordedLaneEntry(task, lane, route) != null &&
    recordedFormerDefault(selected, uiTaskLaneClass(task, taskClass), rows);
  const mapped = role === 'worker' ? mapRoute(selected, rows, { surface: nativeSurface, nativeAuthorization, taskClass }, recordedFormer)
    : materializeRule(selected, catalog, surface);
  if (role === 'worker' && mapped.provider.startsWith('codex/') && isClaudeModel(mapped.model)) {
    throw Error(`${mapped.model} is a Claude model and never runs as a native Codex Worker; an authorized native Claude ` +
      'Code Worker takes the claude surface');
  }
  const settings = {
    ...(mapped.effort ? { thinkingOptionId: mapped.effort } : {}),
    ...(mapped.provider.startsWith('codex/') ? { features: { fast_mode: mapped.fastMode } } : {}),
  };
  if (provider) {
    if (provider !== mapped.provider || (Object.keys(agentSettings).length && !isDeepStrictEqual(agentSettings, settings))) {
      throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped.provider})`);
    }
    return { provider, agentSettings: settings };
  }
  if (Object.keys(agentSettings).length) throw Error('materialize settings from the selected rule or pass an explicit provider');
  return { provider: mapped.provider, agentSettings: settings };
}

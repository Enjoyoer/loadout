import { isDeepStrictEqual } from 'node:util';
import { describePace, paceLevel, POOL_NAMES, poolPace, ROUTING_DEFAULTS, validPace } from './quota-pace.mjs';

const effortOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const efforts = new Set(effortOrder);
const model = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[[A-Za-z0-9][A-Za-z0-9._-]{0,31}\])?$/;

export const MAX_CHATGPT_BROWSER_TABS = 5;

export function isValidModelId(value) {
  return typeof value === 'string' && model.test(value);
}

export const FIXED_ROLE_ROUTES = Object.freeze({
  scout: Object.freeze({ label: 'Luna', fallbackProvider: 'codex', effort: 'max', fastMode: true }),
  planner: Object.freeze({ label: 'Web Pro', fallbackProvider: 'codex', effort: null, fastMode: false }),
  planner_fallback: Object.freeze({ label: 'Opus', fallbackProvider: 'claude', effort: 'xhigh', fastMode: false }),
  reviewer: Object.freeze({ label: 'Web Pro', fallbackProvider: 'codex', effort: null, fastMode: false }),
});

// Worker task classes when the owner names no model. Labels resolve through the target Pi catalog. range is the
// [floor, ceiling] the quota pace may move the default within (medium < high < xhigh); null means fixed.
const workerClass = (label, effort, range, fastMode = false) =>
  Object.freeze({ label, effort, range: range && Object.freeze(range), fastMode });
// Local code lanes default to Opus medium (owner rule); the cloud lane and ui stay Opus xhigh. Routes are the minimum
// (owner rule): every range starts at its default, so the pace can raise a level but never lower one.
export const WORKER_DEFAULT_ROUTES = Object.freeze({
  code: workerClass('Opus', 'medium', ['medium', 'high']),
  'code-bounded': workerClass('Opus', 'medium', ['medium', 'high']),
  'test-fix': workerClass('Opus', 'medium', ['medium', 'high']),
  'review-critical': workerClass('Sol', 'xhigh', null),
  'review-general': workerClass('Sol', 'xhigh', null),
  automation: workerClass('Opus', 'medium', ['medium', 'high']),
  browser: workerClass('Astra', 'medium', ['medium', 'high'], true),
  research: workerClass('Luna', 'xhigh', null, true),
  mechanical: workerClass('Opus', 'medium', null),
  smoke: workerClass('Sonnet', 'low', null),
  watcher: workerClass('Luna', 'xhigh', null, true),
});
// Each label draws on one provider's quota pool.
export const LABEL_POOLS = Object.freeze({ Opus: 'claude', Sonnet: 'claude', Fable: 'claude', Sol: 'codex', Luna: 'codex', Astra: 'codex' });
// Owner rules that hold whatever the quota says. They resolve to owner-explicit routes, so nothing adjusts them.
export const OWNER_RULE_ROUTES = Object.freeze({
  ui: Object.freeze({ label: 'Opus', effort: 'xhigh', fastMode: false, reason: 'ui: owner rule, Opus xhigh, no GPT' }),
});
// UI work never uses GPT models or the ChatGPT web lane (owner rule).
export const GPT_WEB_LABELS = Object.freeze(['Sol', 'Luna', 'Astra', 'Web Pro', 'Web Extra']);
const GPT_WEB_MODEL = /(?:^|\/)(?:gpt-|chatgpt-web\/)/i;
export function isGptOrWebRoute(route, catalog = null) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const label = route?.label ?? (route?.source === 'task-default' ? WORKER_DEFAULT_ROUTES[route.kind]?.label
    : rows?.find(row => row.id === route?.model || row.id?.slice(row.id.indexOf('/') + 1) === route?.model)?.label);
  return GPT_WEB_LABELS.includes(label) || GPT_WEB_MODEL.test(route?.model ?? '');
}

// A class whose label is a Claude model never runs a GPT or web model, whatever a route claims.
const claudeClassOnGptModel = (rule, route) => !GPT_WEB_LABELS.includes(rule.label) && GPT_WEB_MODEL.test(route.model);
// A catalog row serves a model named by its full id or by its id without the provider prefix.
const namesRow = (row, model) => row.id === model || row.id?.slice(row.id.indexOf('/') + 1) === model;

// A model id names a catalog label as one of its tokens, as fleet/claude-opus-5-5 and claude-opus-5-5[1m] name Opus.
const namesLabel = (model, label) => new RegExp(`(?:^|[/._-])${label.toLowerCase()}(?:$|[/._[-])`, 'i').test(model ?? '');
// A GPT or web model by its name or, with a catalog, by its row's label; never by a class table.
const isGptOrWebModel = (model, rows) => GPT_WEB_MODEL.test(model ?? '') ||
  GPT_WEB_LABELS.includes(rows?.find(row => namesRow(row, model))?.label);

// A UI lane records and launches only the ui route: Opus xhigh, Fast off, never a GPT or web model (owner rule). With a
// catalog the model must be its Opus row; without one (a brief, a record) the model id must name Opus.
export function isUiRoute(route, catalog = null) {
  const rule = OWNER_RULE_ROUTES.ui, rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  return route?.effort === rule.effort && route.fastMode === rule.fastMode && !isGptOrWebModel(route.model, rows) &&
    (rows ? namesRow(resolveCatalogLabel(rows, rule.label), route.model) : namesLabel(route.model, rule.label));
}

// The owner's hard rules for a lane class bind every route, whatever its source says: ui is exactly the ui route, these
// classes never run a GPT or web model, and no route runs below its class minimum. Inside them an owner-named route keeps
// its model and effort.
const CLAUDE_ONLY_CLASSES = Object.freeze(['code', 'code-bounded', 'test-fix', 'automation']);
function laneProblem(route, taskClass, rows) {
  if (route.source === 'task-default' && route.kind !== taskClass) return `it is a ${route.kind} route`;
  if (taskClass === 'ui') return isUiRoute(route, rows) ? null : 'a ui lane runs only Opus xhigh, Fast off';
  const rule = WORKER_DEFAULT_ROUTES[taskClass];
  if (CLAUDE_ONLY_CLASSES.includes(taskClass) && isGptOrWebModel(route.model, rows)) {
    return `${route.model} is a GPT or web model and the ${taskClass} class runs ${rule.label}`;
  }
  return effortOrder.indexOf(route.effort) < effortOrder.indexOf(rule.effort)
    ? `effort ${route.effort} is below the ${taskClass} minimum ${rule.effort}` : null;
}
const knownClass = taskClass => Object.hasOwn(WORKER_DEFAULT_ROUTES, taskClass ?? '') || Object.hasOwn(OWNER_RULE_ROUTES, taskClass ?? '');
// A task default runs its class's own model: with a catalog exactly the class's row, without one a model id that names
// the class's label (the name rule of the UI check), failing closed.
function defaultIdentityProblem(route, rows) {
  const rule = WORKER_DEFAULT_ROUTES[route.kind];
  if (rows) return resolveCatalogLabel(rows, rule.label).id === route.model ? null : `${route.model} is not the ${route.kind} class's ${rule.label} model`;
  return namesLabel(route.model, rule.label) ? null : `${route.model} does not name the ${route.kind} class's ${rule.label} model`;
}

// A fresh lane's route checked against its intended class (recording, and a launch with no recorded route).
export function validateLaneClass(route, taskClass, catalog = null) {
  if (!knownClass(taskClass)) throw workerRouteUnresolved();
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const problem = laneProblem(route, taskClass, rows) ?? (route.source === 'task-default' ? defaultIdentityProblem(route, rows) : null);
  if (problem) throw Error(`${taskClass} lane refuses this Worker route: ${problem}`);
}

// One route per lane: once a lane has a recorded route, the request, brief, and recording paths take only that route.
// Returns the lane's record entry, or null for a fresh lane.
export function recordedLaneEntry(task, lane, route) {
  const entry = task?.routes && Object.hasOwn(task.routes, lane ?? '') ? task.routes[lane] : null;
  if (entry && !isDeepStrictEqual(entry.route, route)) throw Error(`lane ${lane} already has a recorded route; repairs and resumes reuse it`);
  return entry;
}

const classLevel = (rule, pace) => (rule.range ? paceLevel(rule.effort, pace?.step ?? 0, rule.range) : rule.effort);

function classReason(kind, rule, pace, effort) {
  if (!rule.range) return `${kind} fixed at ${rule.label} ${rule.effort}`;
  const outcome = pace.stale ? null : pace.step > 0 ? (effort === rule.effort ? `already at ceiling ${effort}` : `up to ${effort}`)
    : pace.step < 0 ? (effort === rule.effort ? `already at floor ${effort}` : `down to ${effort}`)
      : pace.weekly > 0 ? 'no level up' : `kept ${effort}`;
  return [`${kind} default ${rule.effort}`, describePace(pace), ...(outcome ? [outcome] : [])].join(', ');
}

// The one-line reason recorded with a Worker route and shown in its brief.
export const routeReason = route => route.reason ?? 'owner-named, never adjusted';

// Workers run on Pi. A native Worker needs this recorded owner decision for the task.
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
  const rule = FIXED_ROLE_ROUTES[role];
  if (!rule) throw Error(`unknown fixed role: ${role}`);
  const provider = surface === 'pi' ? 'pi' : rule.fallbackProvider;
  const rows = Array.isArray(catalog) && surface === 'pi' ? catalog : catalog?.[provider];
  const row = resolveCatalogLabel(rows, rule.label);
  if (rule.effort && !row.thinkingOptions?.some(option => option.id === rule.effort)) {
    throw Error(`${rule.label} does not serve required thinking ${rule.effort}; use an explicitly selected fallback catalog`);
  }
  return { ...rule, model: row.id, provider: `${provider}/${row.id}` };
}

const routeText = route => `model=${route.model ?? route.label}; effort=${route.effort ?? 'model-fixed'}; Fast=${route.fastMode ? 'on' : 'off'}`;

// A recorded Worker route comes from the owner or from a task-class default with its pace inputs and reason.
// A recorded route is checked for shape only, so a later class-table change never strands its task.
export function validateRecordedWorkerRoute(route) {
  const taskDefault = route?.source === 'task-default';
  const keys = ['role', 'source', 'model', 'effort', 'fastMode', ...(taskDefault ? ['kind', 'pace', 'reason'] : [])];
  if (!route || typeof route !== 'object' || Array.isArray(route) || route.role !== 'worker' ||
      Object.keys(route).length !== keys.length || keys.some(key => !Object.hasOwn(route, key)) ||
      (route.source !== 'owner-explicit' && !taskDefault) || !isValidModelId(route.model) ||
      !efforts.has(route.effort) || typeof route.fastMode !== 'boolean' ||
      (taskDefault && (typeof route.kind !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.kind) ||
        (route.pace !== null && !(Object.hasOwn(POOL_NAMES, route.pace?.pool ?? '') && validPace(route.pace, route.pace.pool))) ||
        typeof route.reason !== 'string' || !route.reason.trim() || /[\r\n]/.test(route.reason)))) {
    throw Error('recorded owner or task-default route required for worker');
  }
  return Object.freeze({ model: route.model, effort: route.effort, fastMode: route.fastMode, source: route.source,
    ...(taskDefault ? { kind: route.kind, pace: route.pace, reason: route.reason } : {}) });
}

// A route being recorded or launched must also match today's class table: class, Fast, pace pool, and level.
function validateWorkerRoute(route) {
  const valid = validateRecordedWorkerRoute(route);
  const rule = Object.hasOwn(WORKER_DEFAULT_ROUTES, route.kind ?? '') ? WORKER_DEFAULT_ROUTES[route.kind] : null;
  if (route.source === 'task-default' && (!rule || route.fastMode !== rule.fastMode ||
      (rule.range ? route.pace?.pool !== LABEL_POOLS[rule.label] : route.pace !== null) ||
      route.effort !== classLevel(rule, route.pace))) {
    throw Error('recorded owner or task-default route required for worker; a recorded lane rebuilds only with its ' +
      'destination task, lane, and class');
  }
  return valid;
}

// Before 7.30 the code classes ran up to xhigh, so a lane of theirs recorded then rebuilds at that level. Other classes
// rebuild up to their range ceiling or fixed level.
const RECORDED_CEILINGS = Object.freeze({ code: 'xhigh', 'code-bounded': 'xhigh', 'test-fix': 'xhigh', automation: 'xhigh' });

// A recorded route rebuilds (repair, restart) only inside the owner's hard rules for the lane's class, whatever its source.
// A task default must also still be today's class: the class's catalog label (never a GPT or web model for a Claude
// class), the class's Fast, and, as the one allowance for levels a class-table change left behind, any effort from the
// class minimum up to its ceiling, which the Pi catalog must still serve.
function validateRebuild(route, taskClass, rows) {
  const valid = validateRecordedWorkerRoute(route);
  const rule = WORKER_DEFAULT_ROUTES[taskClass];
  const ceiling = rule && (RECORDED_CEILINGS[taskClass] ?? rule.range?.[1] ?? rule.effort);
  const problem = laneProblem(route, taskClass, rows) ?? (route.source !== 'task-default' ? null
    : route.fastMode !== rule.fastMode ? `Fast ${route.fastMode ? 'on' : 'off'} does not match the ${taskClass} class`
      : effortOrder.indexOf(route.effort) > effortOrder.indexOf(ceiling) ? `effort ${route.effort} is above the ${taskClass} ceiling ${ceiling}`
        : claudeClassOnGptModel(rule, route) ? `${route.model} is a GPT or web model and the ${taskClass} class runs ${rule.label}`
          : null);
  if (problem) throw Error(`recorded ${taskClass} Worker route cannot rebuild: ${problem}`);
  if (route.source !== 'task-default') return valid;
  if (!rows) {
    const unnamed = defaultIdentityProblem(route, null);
    if (unnamed) throw Error(`recorded ${taskClass} Worker route cannot rebuild: ${unnamed}`);
    return valid;
  }
  const candidates = rows.filter(row => namesRow(row, route.model));
  if (!candidates.some(row => row.thinkingOptions?.some(option => option.id === route.effort))) {
    throw Error(`recorded ${route.kind} Worker route is no longer served: the Pi catalog ` +
      `${candidates.length ? `serves ${route.model} but not at ${route.effort} thinking` : `has no ${route.model}`}; ` +
      'this lane cannot relaunch on its recorded route, so resolve a route for a new lane');
  }
  if (resolveCatalogLabel(rows, rule.label).id !== route.model) {
    throw Error(`recorded ${route.kind} Worker route cannot rebuild: ${route.model} is not the ${route.kind} class's ${rule.label} model`);
  }
  return valid;
}

// The Worker route a brief or request is built from, bound to its destination task (as readTask returns it), lane, and
// intended class when given. Task records are bookkeeping, not routing authority, so the class comes from the caller: a
// UI task's lanes are ui, and any other bound lane names its taskClass. A lane with a recorded route takes only that route
// and rebuilds under validateRebuild; a fresh lane is checked as new and against its class.
function validateLaunchedWorkerRoute(route, { task = null, lane = null, taskClass = null, catalog = null } = {}) {
  if (task != null && (typeof task !== 'object' || Array.isArray(task))) throw Error('destination task must be a task record');
  if (taskClass != null && !knownClass(taskClass)) throw workerRouteUnresolved();
  if (task?.ui === true && taskClass != null && taskClass !== 'ui') throw Error('UI task: its lanes take the ui class (owner rule)');
  if (task != null && task.ui !== true && taskClass == null) throw Error('a Worker bound to a task record needs its lane class (taskClass)');
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi, laneClass = task?.ui === true ? 'ui' : taskClass;
  if (task?.ui === true && !isUiRoute(route, rows)) {
    throw Error('UI task: only the ui route (Opus xhigh, Fast off) can launch (owner rule); use the ui class');
  }
  if (recordedLaneEntry(task, lane, route)) return validateRebuild(route, laneClass, rows);
  const valid = validateWorkerRoute(route);
  if (laneClass != null) validateLaneClass(route, laneClass, rows);
  else if (route.source === 'task-default') {
    const problem = defaultIdentityProblem(route, rows);
    if (problem) throw Error(`task-default Worker route must match its Pi catalog label (${problem})`);
  }
  return valid;
}

export const workerRouteUnresolved = () => Error('Worker route unresolved; ask the owner for the exact model and effort ' +
  `(task classes: ${[...Object.keys(WORKER_DEFAULT_ROUTES), ...Object.keys(OWNER_RULE_ROUTES)].join(', ')})`);

// An owner-named model and effort always win unadjusted; otherwise the task class selects a catalog label,
// and the class's quota pool pace may move its level within the class range. quota is a readQuota result.
export function selectWorkerRoute({ ownerRoute = null, taskKind = null, catalog, quota = null,
  settings = ROUTING_DEFAULTS } = {}) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  if (ownerRoute) {
    if (ownerRoute.source !== 'owner-explicit') throw Error('owner Worker route must have source owner-explicit');
    validateWorkerRoute(ownerRoute);
    if (taskKind === 'ui' && isGptOrWebRoute(ownerRoute, rows)) {
      throw Error('ui work never uses a GPT or web model (owner rule); name a Claude model or use the ui class route');
    }
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
  const pace = rule.range ? poolPace(quota, LABEL_POOLS[rule.label], settings) : null;
  const effort = classLevel(rule, pace);
  if (!row.thinkingOptions?.some(option => option.id === effort)) {
    throw Error(`${rule.label} does not serve required thinking ${effort}; the Worker lane stops`);
  }
  return Object.freeze({ role: 'worker', source: 'task-default', kind: taskKind, model: row.id,
    effort, fastMode: rule.fastMode, pace, reason: classReason(taskKind, rule, pace, effort) });
}

function validateFixedRoute(role, route) {
  const fixed = FIXED_ROLE_ROUTES[role];
  const keys = ['label', 'fallbackProvider', 'effort', 'fastMode'];
  if (!fixed || !route || typeof route !== 'object' || Array.isArray(route) ||
      Object.keys(route).length !== keys.length || keys.some(key => route[key] !== fixed[key])) {
    throw Error(`${role} must use the exact fixed OPC role route`);
  }
  return fixed;
}

// Recording a lane (route.mjs, cloud-lane.mjs) checks a Worker route as new. With no catalog at hand it also refuses a
// GPT or web model for a Claude class, which a launch refuses by catalog label.
export function validateRoleRoute(role, route) {
  if (role === 'worker') {
    const valid = validateWorkerRoute(route);
    if (route.source === 'task-default' && claudeClassOnGptModel(WORKER_DEFAULT_ROUTES[route.kind], route)) {
      throw Error('recorded owner or task-default route required for worker; a Claude class never runs a GPT or web model');
    }
    return valid;
  }
  if (!Object.hasOwn(FIXED_ROLE_ROUTES, role)) throw Error(`unknown OPC role: ${role}`);
  return validateFixedRoute(role, route);
}

export function resolveAgentRoute(role, { explicitRoute = null, taskKind = null, catalog = null,
  plannerFailure = null, fallbackAuthorization = null } = {}) {
  if (explicitRoute) {
    if (role !== 'worker') throw Error(`${role} must use the exact fixed OPC role route`);
    return validateWorkerRoute(explicitRoute);
  }
  if (role === 'worker') return validateWorkerRoute(selectWorkerRoute({ taskKind, catalog }));
  if (role === 'planner_fallback') {
    if (!plannerFailure?.id || plannerFailure.status !== 'failed' ||
        fallbackAuthorization?.answer !== 'yes' || fallbackAuthorization?.after_round !== plannerFailure.id) {
      throw Error('planner fallback requires recorded explicit owner yes after the Pro failure');
    }
  }
  const route = FIXED_ROLE_ROUTES[role];
  if (!route) throw Error(`unknown OPC role: ${role}`);
  return route;
}

// Owner testing rule: tests a Worker writes for itself restate its own reading of intent.
const WORKER_TESTING_RULE = 'Testing rule: do not write new unit, integration, or end-to-end tests, and do not use test-driven development, unless the PM specifies the test cases. ' +
  'Verify against the acceptance checks, run the existing suites and keep them green, and keep existing tests unless the PM asks to remove them.';

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
  const line = role === 'worker' ? `${routeText(resolved)}; route: ${reason ?? routeReason(resolved)}` : routeText(resolved);
  return `Fixed route for this ${role} lane: ${line}. This route is not a suggestion. You cannot delegate, launch another agent, choose another route, or substitute a model or effort. If this route fails, stop this lane and report the failure to the PM.\n\n${role === 'worker' ? `${WORKER_TESTING_RULE}\n\n` : ''}${brief}`;
}

export function selectTopology({ scale, independentQuestions = 0, findingsConverged = false,
  materialAmbiguity = false, crossLaneDecision = false, browserReview = false, ui = false } = {}) {
  if (!['trivial', 'normal', 'cross-cutting'].includes(scale)) throw Error('task scale must be trivial, normal, or cross-cutting');
  if (!Number.isSafeInteger(independentQuestions) || independentQuestions < 0) throw Error('independent question count must be a nonnegative integer');
  if ([findingsConverged, materialAmbiguity, crossLaneDecision, browserReview, ui].some(value => typeof value !== 'boolean')) {
    throw Error('topology decisions must be explicit booleans');
  }
  if (ui && browserReview) throw Error('UI work never uses the web reviewer (owner rule)');
  // UI work runs no Luna scouts and no web planner (owner rule); the PM explores and plans itself.
  const cap = scale === 'trivial' || ui ? 0 : scale === 'normal' ? 2 : 3;
  const scoutCount = Math.min(cap, independentQuestions);
  const plannerNeeded = scale !== 'trivial' && !findingsConverged && (materialAmbiguity || crossLaneDecision);
  const planner = plannerNeeded && !browserReview && !ui;
  return Object.freeze({
    scoutCount,
    scoutRoute: scoutCount ? FIXED_ROLE_ROUTES.scout : null,
    planner,
    plannerRoute: planner ? FIXED_ROLE_ROUTES.planner : null,
    plannerSkipReason: planner ? null : ui && plannerNeeded ? 'UI work never uses the web planner' : browserReview && plannerNeeded ? 'reviewer reserves the one OPC web lane'
      : findingsConverged ? 'scout findings converge into an implementable plan'
        : scale === 'trivial' ? 'trivial or localized work' : 'no material synthesis ambiguity',
  });
}

// Model and thinking rules above remain authoritative. Workers run on Pi; a native route (explicit codex or claude
// surface, or a model/effort Pi does not serve) needs the owner's authorization. The claude surface takes only a model
// its catalog (the target's catalog rows) serves at the route's thinking, and has no Fast setting.
export const NATIVE_WORKER_SURFACES = Object.freeze(['codex', 'claude']);
export function mapRouteToPi(route, catalog, { fallbackProvider = 'codex', surface = 'pi', nativeAuthorization = null } = {}) {
  if (!route || !isValidModelId(route.model)) throw Error('selected OPC route required');
  if (!Array.isArray(catalog)) throw Error('target Pi catalog required');
  const originalProvider = route.provider?.split('/')[0] ?? fallbackProvider;
  const original = { ...route, provider: route.provider ?? `${originalProvider}/${route.model}` };
  if (surface !== 'pi' && !NATIVE_WORKER_SURFACES.includes(surface)) throw Error('surface must be pi, codex, or claude');
  if (route.source === 'task-default' && (!Object.hasOwn(WORKER_DEFAULT_ROUTES, route.kind) ||
      resolveCatalogLabel(catalog, WORKER_DEFAULT_ROUTES[route.kind].label).id !== route.model)) {
    throw Error('task-default Worker route must match its Pi catalog label');
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
  return role === 'worker' ? mapRouteToPi(route, rows, { surface, nativeAuthorization: options.nativeAuthorization })
    : materializeFixedRoute(role, catalog, surface);
}

const CLAUDE_LABELS = Object.keys(LABEL_POOLS).filter(label => LABEL_POOLS[label] === 'claude');
const isClaudeModel = model => /(?:^|\/)claude-/i.test(model ?? '') || CLAUDE_LABELS.some(label => namesLabel(model, label));

// A Worker bound to a task record is validated in full (binding, class, rebuild rules, UI rule, minimum) before any
// explicit provider, which must then be exactly the provider its validated route maps to, with that route's settings.
// An explicit native provider (codex/ or claude/) selects that native surface for the mapping.
export function resolveWorkerSurface({ provider, agentSettings = {}, role = 'worker', route, catalog, surface = 'pi',
  nativeAuthorization = null, task = null, lane = null, taskClass = null } = {}) {
  const bound = role === 'worker' && task != null;
  if (provider && !String(provider).startsWith('pi/') && role === 'worker') {
    requireNativeAuthorization(String(provider), nativeAuthorization, `explicit provider ${provider}`);
  }
  if (provider && !bound) return { provider, agentSettings };
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const selected = role === 'worker' ? validateLaunchedWorkerRoute(route, { task, lane, taskClass, catalog: rows })
    : validateRoleRoute(role, route);
  const native = String(provider ?? '').split('/')[0];
  const target = surface === 'pi' && NATIVE_WORKER_SURFACES.includes(native) ? native : surface;
  const mapped = role === 'worker' ? mapRouteToPi(selected, rows, { surface: target, nativeAuthorization })
    : materializeFixedRoute(role, catalog, surface);
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

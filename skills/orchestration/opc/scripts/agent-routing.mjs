import { describePace, paceLevel, poolPace, ROUTING_DEFAULTS, validPace } from './quota-pace.mjs';

const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
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
export const WORKER_DEFAULT_ROUTES = Object.freeze({
  code: workerClass('Opus', 'xhigh', ['high', 'xhigh']),
  'code-bounded': workerClass('Opus', 'high', ['medium', 'xhigh']),
  'test-fix': workerClass('Opus', 'high', ['medium', 'xhigh']),
  'review-critical': workerClass('Opus', 'xhigh', ['high', 'xhigh']),
  'review-general': workerClass('Opus', 'high', ['medium', 'xhigh']),
  automation: workerClass('Opus', 'xhigh', ['high', 'xhigh']),
  browser: workerClass('Sol', 'medium', ['medium', 'high'], true),
  research: workerClass('Luna', 'xhigh', ['medium', 'xhigh'], true),
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
export function isGptOrWebRoute(route, catalog = null) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const label = route?.label ?? (route?.source === 'task-default' ? WORKER_DEFAULT_ROUTES[route.kind]?.label
    : rows?.find(row => row.id === route?.model || row.id?.slice(row.id.indexOf('/') + 1) === route?.model)?.label);
  return GPT_WEB_LABELS.includes(label) || /(?:^|\/)(?:gpt-|chatgpt-web\/)/i.test(route?.model ?? '');
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
function validateWorkerRoute(route) {
  const rule = route?.source === 'task-default' && Object.hasOwn(WORKER_DEFAULT_ROUTES, route.kind)
    ? WORKER_DEFAULT_ROUTES[route.kind] : null;
  const keys = ['role', 'source', 'model', 'effort', 'fastMode', ...(rule ? ['kind', 'pace', 'reason'] : [])];
  if (!route || typeof route !== 'object' || Array.isArray(route) || route.role !== 'worker' ||
      Object.keys(route).length !== keys.length || keys.some(key => !Object.hasOwn(route, key)) ||
      (route.source !== 'owner-explicit' && !rule) || !isValidModelId(route.model) ||
      !efforts.has(route.effort) || typeof route.fastMode !== 'boolean' ||
      (rule && (route.fastMode !== rule.fastMode ||
        (rule.range ? !validPace(route.pace, LABEL_POOLS[rule.label]) : route.pace !== null) ||
        route.effort !== classLevel(rule, route.pace) ||
        typeof route.reason !== 'string' || !route.reason.trim() || /[\r\n]/.test(route.reason)))) {
    throw Error('recorded owner or task-default route required for worker');
  }
  return Object.freeze({ model: route.model, effort: route.effort, fastMode: route.fastMode, source: route.source,
    ...(rule ? { kind: route.kind, pace: route.pace, reason: route.reason } : {}) });
}

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
  if (!Object.hasOwn(WORKER_DEFAULT_ROUTES, taskKind ?? '')) {
    throw Error(`Worker route unresolved; ask the owner for the exact model and effort (task classes: ${[...Object.keys(WORKER_DEFAULT_ROUTES), ...Object.keys(OWNER_RULE_ROUTES)].join(', ')})`);
  }
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

export function validateRoleRoute(role, route) {
  if (role === 'worker') return validateWorkerRoute(route);
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

export function buildDelegatedBrief({ role, route, brief, reason = null }) {
  if (typeof role !== 'string' || !role || typeof brief !== 'string' || !brief.trim()) {
    throw Error('delegated role and nonempty brief required');
  }
  if (reason != null && (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason))) throw Error('route reason must be one line');
  const resolved = route == null ? resolveAgentRoute(role) : validateRoleRoute(role, route);
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

// Model and thinking rules above remain authoritative. Workers run on Pi; a native route
// (explicit codex surface or a model/effort Pi does not serve) needs the owner's authorization.
export function mapRouteToPi(route, catalog, { fallbackProvider = 'codex', surface = 'pi', nativeAuthorization = null } = {}) {
  if (!route || !isValidModelId(route.model)) throw Error('selected OPC route required');
  if (!Array.isArray(catalog)) throw Error('target Pi catalog required');
  const originalProvider = route.provider?.split('/')[0] ?? fallbackProvider;
  const original = { ...route, provider: route.provider ?? `${originalProvider}/${route.model}` };
  if (surface !== 'pi' && surface !== 'codex') throw Error('surface must be pi or codex');
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

export function resolveWorkerSurface({ provider, agentSettings = {}, role = 'worker', route, catalog, surface = 'pi',
  nativeAuthorization = null } = {}) {
  if (provider) {
    if (role === 'worker' && !String(provider).startsWith('pi/')) {
      requireNativeAuthorization(String(provider), nativeAuthorization, `explicit provider ${provider}`);
    }
    return { provider, agentSettings };
  }
  const selected = validateRoleRoute(role, route);
  const mapped = role === 'worker'
    ? mapRouteToPi(selected, Array.isArray(catalog) ? catalog : catalog?.pi, { surface, nativeAuthorization })
    : materializeFixedRoute(role, catalog, surface);
  if (Object.keys(agentSettings).length) throw Error('materialize settings from the selected rule or pass an explicit provider');
  return { provider: mapped.provider, agentSettings: {
    ...(mapped.effort ? { thinkingOptionId: mapped.effort } : {}),
    ...(mapped.provider.startsWith('codex/') ? { features: { fast_mode: mapped.fastMode } } : {}),
  } };
}

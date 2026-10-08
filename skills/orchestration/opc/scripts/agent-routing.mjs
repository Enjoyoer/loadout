const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const model = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[[A-Za-z0-9][A-Za-z0-9._-]{0,31}\])?$/;

export const MAX_CHATGPT_BROWSER_TABS = 5;

export function isValidModelId(value) {
  return typeof value === 'string' && model.test(value);
}

export const FIXED_ROLE_ROUTES = Object.freeze({
  scout: Object.freeze({ label: 'Luna', fallbackProvider: 'codex', effort: 'max', fastMode: true }),
  planner: Object.freeze({ label: 'Web Pro', fallbackProvider: 'codex', effort: null, fastMode: false }),
  planner_fallback: Object.freeze({ label: 'Fable', fallbackProvider: 'claude', effort: 'high', fastMode: false }),
  reviewer: Object.freeze({ label: 'Web Pro', fallbackProvider: 'codex', effort: null, fastMode: false }),
});

// Worker defaults when the owner names no model. Labels resolve through the target Pi catalog.
export const WORKER_DEFAULT_ROUTES = Object.freeze({
  code: Object.freeze({ label: 'Opus', effort: 'xhigh', fastMode: false }),
  browser: Object.freeze({ label: 'Sol', effort: 'medium', fastMode: false }),
});

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

// A recorded Worker route comes from the owner or from a task-kind default.
function validateWorkerRoute(route) {
  const fallback = route?.source === 'task-default' && Object.hasOwn(WORKER_DEFAULT_ROUTES, route.kind)
    ? WORKER_DEFAULT_ROUTES[route.kind] : null;
  const keys = ['role', 'source', 'model', 'effort', 'fastMode', ...(fallback ? ['kind'] : [])];
  if (!route || typeof route !== 'object' || Array.isArray(route) || route.role !== 'worker' ||
      Object.keys(route).length !== keys.length || keys.some(key => !Object.hasOwn(route, key)) ||
      (route.source !== 'owner-explicit' && !fallback) || !isValidModelId(route.model) ||
      !efforts.has(route.effort) || typeof route.fastMode !== 'boolean' ||
      (fallback && (route.effort !== fallback.effort || route.fastMode !== fallback.fastMode))) {
    throw Error('recorded owner or task-default route required for worker');
  }
  return Object.freeze({ model: route.model, effort: route.effort, fastMode: route.fastMode, source: route.source,
    ...(fallback ? { kind: route.kind } : {}) });
}

// An owner-named model and effort always win; otherwise the task kind selects a catalog label.
export function selectWorkerRoute({ ownerRoute = null, taskKind = null, catalog } = {}) {
  if (ownerRoute) {
    if (ownerRoute.source !== 'owner-explicit') throw Error('owner Worker route must have source owner-explicit');
    validateWorkerRoute(ownerRoute);
    return Object.freeze({ ...ownerRoute });
  }
  if (!Object.hasOwn(WORKER_DEFAULT_ROUTES, taskKind ?? '')) {
    throw Error('Worker route unresolved; ask the owner for the exact model and effort (task defaults cover code and browser)');
  }
  const rule = WORKER_DEFAULT_ROUTES[taskKind];
  const row = resolveCatalogLabel(Array.isArray(catalog) ? catalog : catalog?.pi, rule.label);
  if (!row.thinkingOptions?.some(option => option.id === rule.effort)) {
    throw Error(`${rule.label} does not serve required thinking ${rule.effort}; the Worker lane stops`);
  }
  return Object.freeze({ role: 'worker', source: 'task-default', kind: taskKind, model: row.id,
    effort: rule.effort, fastMode: rule.fastMode });
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

export function buildDelegatedBrief({ role, route, brief }) {
  if (typeof role !== 'string' || !role || typeof brief !== 'string' || !brief.trim()) {
    throw Error('delegated role and nonempty brief required');
  }
  const resolved = route == null ? resolveAgentRoute(role) : validateRoleRoute(role, route);
  return `Fixed route for this ${role} lane: ${routeText(resolved)}. This route is not a suggestion. You cannot delegate, launch another agent, choose another route, or substitute a model or effort. If this route fails, stop this lane and report the failure to the PM.\n\n${role === 'worker' ? `${WORKER_TESTING_RULE}\n\n` : ''}${brief}`;
}

export function selectTopology({ scale, independentQuestions = 0, findingsConverged = false,
  materialAmbiguity = false, crossLaneDecision = false, browserReview = false } = {}) {
  if (!['trivial', 'normal', 'cross-cutting'].includes(scale)) throw Error('task scale must be trivial, normal, or cross-cutting');
  if (!Number.isSafeInteger(independentQuestions) || independentQuestions < 0) throw Error('independent question count must be a nonnegative integer');
  if ([findingsConverged, materialAmbiguity, crossLaneDecision, browserReview].some(value => typeof value !== 'boolean')) {
    throw Error('topology decisions must be explicit booleans');
  }
  const cap = scale === 'trivial' ? 0 : scale === 'normal' ? 2 : 3;
  const scoutCount = Math.min(cap, independentQuestions);
  const plannerNeeded = scale !== 'trivial' && !findingsConverged && (materialAmbiguity || crossLaneDecision);
  const planner = plannerNeeded && !browserReview;
  return Object.freeze({
    scoutCount,
    scoutRoute: scoutCount ? FIXED_ROLE_ROUTES.scout : null,
    planner,
    plannerRoute: planner ? FIXED_ROLE_ROUTES.planner : null,
    plannerSkipReason: planner ? null : browserReview && plannerNeeded ? 'reviewer reserves the one OPC web lane'
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

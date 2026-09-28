const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const model = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[[A-Za-z0-9][A-Za-z0-9._-]{0,31}\])?$/;

export const MAX_CHATGPT_BROWSER_TABS = 5;

export function isValidModelId(value) {
  return typeof value === 'string' && model.test(value);
}

export const FIXED_ROLE_ROUTES = Object.freeze({
  scout: Object.freeze({ provider: 'codex/gpt-5.6-luna', model: 'gpt-5.6-luna', effort: 'max', fastMode: true }),
  planner: Object.freeze({ provider: 'codex/chatgpt-web/pro', model: 'chatgpt-web/pro', effort: null, fastMode: false }),
  planner_fallback: Object.freeze({ provider: 'claude/claude-fable-5-1[1m]', model: 'claude-fable-5-1[1m]', effort: 'high', fastMode: false }),
  reviewer: Object.freeze({ provider: 'codex/chatgpt-web/pro', model: 'chatgpt-web/pro', effort: null, fastMode: false }),
});

const routeText = route => `model=${route.model}; effort=${route.effort ?? 'model-fixed'}; Fast=${route.fastMode ? 'on' : 'off'}`;

function validateExplicitRoute(role, route) {
  const keys = ['role', 'source', 'model', 'effort', 'fastMode'];
  if (!route || typeof route !== 'object' || Array.isArray(route) || route.role !== role ||
      Object.keys(route).length !== keys.length || keys.some(key => !Object.hasOwn(route, key)) ||
      route.source !== 'owner-explicit' || !isValidModelId(route.model) ||
      !efforts.has(route.effort) || typeof route.fastMode !== 'boolean') {
    throw Error(`recorded explicit owner route required for ${role}`);
  }
  return Object.freeze({ model: route.model, effort: route.effort, fastMode: route.fastMode, source: route.source });
}

function validateFixedRoute(role, route) {
  const fixed = FIXED_ROLE_ROUTES[role];
  const keys = ['provider', 'model', 'effort', 'fastMode'];
  if (!fixed || !route || typeof route !== 'object' || Array.isArray(route) ||
      Object.keys(route).length !== keys.length || keys.some(key => route[key] !== fixed[key])) {
    throw Error(`${role} must use the exact fixed OPC role route`);
  }
  return fixed;
}

export function validateRoleRoute(role, route) {
  if (role === 'worker') return validateExplicitRoute(role, route);
  if (!Object.hasOwn(FIXED_ROLE_ROUTES, role)) throw Error(`unknown OPC role: ${role}`);
  return validateFixedRoute(role, route);
}

export function resolveAgentRoute(role, { explicitRoute = null, plannerFailure = null, fallbackAuthorization = null } = {}) {
  if (explicitRoute) {
    if (role !== 'worker') throw Error(`${role} must use the exact fixed OPC role route`);
    return validateExplicitRoute(role, explicitRoute);
  }
  if (role === 'worker') throw Error('Worker route unresolved; ask the owner for the exact model and effort');
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

export function buildDelegatedBrief({ role, route, brief }) {
  if (typeof role !== 'string' || !role || typeof brief !== 'string' || !brief.trim()) {
    throw Error('delegated role and nonempty brief required');
  }
  const resolved = route == null ? resolveAgentRoute(role) : validateRoleRoute(role, route);
  return `Fixed route for this ${role} lane: ${routeText(resolved)}. This route is not a suggestion. You cannot delegate, launch another agent, choose another route, or substitute a model or effort. If this route fails, stop this lane and report the failure to the PM.\n\n${brief}`;
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

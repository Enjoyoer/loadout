import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const effortOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const efforts = new Set(effortOrder);
const model = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[[A-Za-z0-9][A-Za-z0-9._-]{0,31}\])?$/;

export const MAX_CHATGPT_BROWSER_TABS = 5;

export function isValidModelId(value) {
  return typeof value === 'string' && model.test(value);
}

export const FIXED_ROLE_ROUTES = Object.freeze({
  // Owner decision 277a: a one-week scout trial on Terra high, Fast off, until 2026-11-26.
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
// Local code lanes default to Opus high (owner 2026-11-18); plan, ui-design and ui-check run Fable high. Routes are the minimum
// (owner rule): nothing lowers a route. Every class runs Fast off (owner 2026-11-07) except the Luna classes, which run
// Fast on (owner 2026-11-17), and review, browser and browser-hard, which run Fast on by default (owner decision 327,
// 2026-11-22); otherwise Fast is an owner-named exception per task.
export const WORKER_DEFAULT_ROUTES = Object.freeze({
  // Owner 2026-11-18: code runs at Opus high; ceiling xhigh keeps earlier xhigh lanes rebuildable.
  code: workerClass('Opus', 'high', 'xhigh'),
  review: workerClass('Sol', 'high', null, true),
  // Security, credential and data-loss reviews run on Opus, never GPT (owner rule): GPT trips the cyber-safety filter.
  // Owner 2026-11-18: Opus high; ceiling xhigh keeps earlier xhigh lanes rebuildable.
  'review-security': workerClass('Opus', 'high', 'xhigh'),
  // Owner 2026-11-18 (decision 244): plan and research run read-only on Fable high, Fast off; FORMER_CLASS_ROUTES keeps
  // earlier Sol high lanes rebuildable.
  plan: workerClass('Fable', 'high'),
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
  research: 'plan', 'review-critical': 'review', 'review-general': 'review', security: 'review-security',
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
  const label = route?.label ?? (route?.source === 'task-default' ? workerRule(route.kind)?.label
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
const formerClassRoute = (route, taskClass, rows) => {
  const kind = canonicalWorkerClass(taskClass);
  return (Object.hasOwn(FORMER_CLASS_ROUTES, kind ?? '') ? FORMER_CLASS_ROUTES[kind] : [])
    .find(former => labelModel(route?.model, former.label, rows));
};
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
// effort.
const CLAUDE_ONLY_CLASSES = Object.freeze(['code', 'review-security']);
function laneProblem(route, taskClass, rows) {
  taskClass = canonicalWorkerClass(taskClass);
  if (route.source === 'task-default' && canonicalWorkerClass(route.kind) !== taskClass) return `it is a ${route.kind} route`;
  if (uiClass(taskClass)) return isUiRoute(route, rows) ? null : `a ${taskClass} lane runs only Fable high, Fast off`;
  const ownerRule = fableProblem(route, rows) ?? classFastProblem(route, taskClass, rows);
  if (ownerRule) return ownerRule;
  const rule = WORKER_DEFAULT_ROUTES[taskClass];
  // The one GPT exception: the exact off-pace backup in a code lane, which records only while off pace and launches only
  // from its own recorded lane (owner decisions 310 and 316). Reviews, review-security and every other class never take it.
  const backup = route.source === 'pace-backup' && taskClass === 'code' && !unapprovedBackup(route);
  if (CLAUDE_ONLY_CLASSES.includes(taskClass) && isGptOrWebModel(route.model, rows) && !backup) {
    return `${route.model} is a GPT or web model and the ${taskClass} class runs ${rule.label}`;
  }
  // The backup's medium is the owner's own level for it (2026-11-21), below the code minimum by decision.
  return !backup && effortOrder.indexOf(route.effort) < effortOrder.indexOf(rule.effort)
    ? `effort ${route.effort} is below the ${taskClass} minimum ${rule.effort}` : null;
}
const knownClass = taskClass => Object.hasOwn(WORKER_DEFAULT_ROUTES, canonicalWorkerClass(taskClass) ?? '') || uiClass(taskClass);
// A task default runs its class's own model: with a catalog exactly the class's row, without one a model id that names
// the class's label (the name rule of the UI check), failing closed.
function defaultIdentityProblem(route, rows) {
  const rule = workerRule(route.kind);
  if (rows) return classModelId(route.kind, resolveCatalogLabel(rows, rule.label).id) === classModelId(route.kind, route.model) ? null : `${route.model} is not the ${route.kind} class's ${rule.label} model`;
  return namesLabel(route.model, rule.label) ? null : `${route.model} does not name the ${route.kind} class's ${rule.label} model`;
}

// A fresh lane's route checked against its intended class (recording, and a launch with no recorded route).
export function validateLaneClass(route, taskClass, catalog = null) {
  taskClass = canonicalWorkerClass(taskClass);
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

// While Claude is off pace (owner decision 314a, 2026-11-21), a new code Worker lane on the Opus high, Fast off default
// runs instead on the generic ACP provider Config names agy-opc, on exactly this model and thinking, in agy's native auto
// mode with the generic ACP auto_accept feature on, the unattended equivalent the owner authorized; never default,
// accept-edits, plan, another mode or another feature. route.mjs admits it; a lane records it with a receipt binding
// task, lane, target and placement, never the routing.json state; it launches only from that recorded lane, and only
// while the record is exactly this runtime.
export const REPLACEMENT_RUNTIME = Object.freeze({ provider: 'agy-opc', extends: 'acp', model: 'gemini-4-neon-high',
  effort: 'high', fastMode: false, mode: 'auto' });
export const REPLACEMENT_REASON = 'code replacement for Opus high, Fast off while Claude is off pace: Neon high on the verified ACP runtime';
const RECEIPT_KEYS = ['provider', 'mode', 'target', 'task', 'lane', 'placement'];
// The off-pace backup when Neon cannot launch (owner decisions 310 and 316, medium per owner 2026-11-21): Pi Sol medium, Fast off, the one GPT route a
// code lane may run, and only as a lane recorded with this source and reason while off pace (route.mjs).
export const PACE_BACKUP_RUNTIME = Object.freeze({ model: 'fleet/gpt-6.2-sol', label: 'Sol', effort: 'medium', fastMode: false });
export const PACE_BACKUP_REASON = 'code backup while Claude is off pace and Neon cannot launch: Sol medium, Fast off';
const BACKUP_RECEIPT_KEYS = ['task', 'lane', 'placement'];
// Whether already-parsed JSON text repeats a key in any object, with escaped spellings decoded.
function repeatsKey(text) {
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
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return null;
  const path = join(homedir(), '.config', 'opc', 'routing.json');
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
function launcherChain() {
  const env = { ...process.env };
  delete env.PASEO_HOST;
  const chain = [];
  for (let id = process.env.PASEO_AGENT_ID; chain.length < MAX_LAUNCHER_CHAIN;) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(id)) return null;
    chain.push(id);
    let agent;
    try {
      agent = JSON.parse(execFileSync('paseo', ['inspect', id, '--json'],
        { env, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 16 << 20 }));
    } catch { return null; } // probe-ok: fails closed, an unreadable launcher chain allows no off-pace route; expires 2027-05-22
    if (agent?.Id !== id) return null;
    if (agent.ParentAgentId === '' || agent.ParentAgentId === null) return chain;
    id = agent.ParentAgentId;
  }
  return null;
}
export function offPaceLaunchAllowed(doc = readLocalRouting()) {
  const prefixes = doc?.replacementExcludedLaunchers;
  if (!Array.isArray(prefixes) || prefixes.some(prefix => typeof prefix !== 'string' || !prefix || prefix.length > 128)) return false;
  const chain = launcherChain();
  return chain != null && !chain.some(id => prefixes.some(prefix => id.startsWith(prefix)));
}
export const isReplacementMode = mode => mode === REPLACEMENT_RUNTIME.mode;
// The request settings of every replacement launch, fixed: thinking and the one generic ACP feature, auto_accept, set
// explicitly so nothing depends on what the launching parent would pass on; a caller cannot change or add to them.
export const replacementSettings = () => ({ thinkingOptionId: REPLACEMENT_RUNTIME.effort, features: { auto_accept: true } });
// A record or route that is not exactly the approved runtime (provider, model, thinking, Fast, reason, mode).
const unapprovedReplacement = route => route.model !== REPLACEMENT_RUNTIME.model || route.effort !== REPLACEMENT_RUNTIME.effort ||
  route.fastMode !== REPLACEMENT_RUNTIME.fastMode || route.reason !== REPLACEMENT_REASON ||
  route.receipt?.provider !== REPLACEMENT_RUNTIME.provider || !isReplacementMode(route.receipt?.mode);
// A record or route that is not exactly the off-pace backup (model, thinking, Fast, reason).
const unapprovedBackup = route => route.model !== PACE_BACKUP_RUNTIME.model || route.effort !== PACE_BACKUP_RUNTIME.effort ||
  route.fastMode !== PACE_BACKUP_RUNTIME.fastMode || route.reason !== PACE_BACKUP_REASON;
const unapprovedOffPace = route => route.source === 'replacement' ? unapprovedReplacement(route) : unapprovedBackup(route);
export const OFF_PACE_SOURCES = Object.freeze(['replacement', 'pace-backup']);
const offPaceRoute = route => OFF_PACE_SOURCES.includes(route?.source);
export const isTargetId = value => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
const exactKeys = (value, keys) => value != null && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const validBinding = receipt => /^[A-Za-z0-9-]{8,128}$/.test(receipt.task ?? '') &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(receipt.lane ?? '') && receipt.lane.length <= 40 &&
  /^opc\/[a-z0-9-]+-[0-9a-f]{16}$/.test(receipt.placement ?? '');
function validReceipt(source, receipt) {
  if (source === 'pace-backup') return exactKeys(receipt, BACKUP_RECEIPT_KEYS) && validBinding(receipt);
  return exactKeys(receipt, RECEIPT_KEYS) && receipt.provider === REPLACEMENT_RUNTIME.provider &&
    typeof receipt.mode === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(receipt.mode) &&
    isTargetId(receipt.target) && validBinding(receipt);
}
// A recorded off-pace route (the replacement or the backup) is checked for shape, like any record, so it stays readable;
// a launch also requires it to be exactly its approved runtime (validateLaunchedWorkerRoute).
function validateRecordedOffPace(route) {
  if (!exactKeys(route, ['role', 'source', 'kind', 'model', 'effort', 'fastMode', 'reason', 'receipt']) ||
      route.role !== 'worker' || route.kind !== 'code' || !isValidModelId(route.model) || !efforts.has(route.effort) ||
      route.fastMode !== false || typeof route.reason !== 'string' || !route.reason.trim() || /[\r\n]/.test(route.reason) ||
      !validReceipt(route.source, route.receipt)) {
    throw Error(`recorded ${route?.source} route required for worker`);
  }
  return Object.freeze({ model: route.model, effort: route.effort, fastMode: false, source: route.source, kind: 'code',
    reason: route.reason, receipt: Object.freeze({ ...route.receipt }) });
}

// A recorded replacement rebuilds on the same runtime as the target serves it now, never by the routing.json state: the
// launch target is the recorded local Mac target and is the server the managed workspace was created on (its serverId),
// capabilities are MCP inspect_provider's for exactly the replacement provider with MCP list_models rows as models, and
// they serve exactly the recorded model at its thinking and advertise the pinned mode. Otherwise the lane stops.
function replacementMode(route, capabilities, target, serverId) {
  const { receipt } = route;
  if (!exactKeys(target, ['daemon', 'local', 'platform']) || target.daemon !== receipt.target || target.local !== true ||
      target.platform !== 'darwin') throw Error('replacement launch target is not the recorded local Mac target; the lane stops');
  if (!isTargetId(serverId) || serverId !== receipt.target) {
    throw Error('the managed workspace is not on the recorded target server; the replacement lane stops');
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
  if (offPaceRoute(route)) return validateRecordedOffPace(route);
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
// browser Fast on) and any effort from the class minimum up to its ceiling, which the Pi catalog must still serve, or
// exactly a former default of the class (FORMER_CLASS_ROUTES). A Luna class lane recorded with Fast off is refused
// (owner 2026-11-17).
function validateRebuild(route, taskClass, rows) {
  taskClass = canonicalWorkerClass(taskClass);
  const valid = validateRecordedWorkerRoute(route);
  const rule = WORKER_DEFAULT_ROUTES[taskClass];
  const ceiling = rule && (rule.ceiling ?? rule.effort);
  const former = recordedFormerDefault(route, taskClass, rows);
  const problem = laneProblem(route, taskClass, rows) ?? (route.source !== 'task-default' || former ? null
    : route.fastMode !== rule.fastMode && !GPT_WEB_LABELS.includes(rule.label) ? `Fast ${route.fastMode ? 'on' : 'off'} does not match the ${taskClass} class`
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

// A recorded task default of the lane's class that is exactly a former default of that class (FORMER_CLASS_ROUTES),
// still served at its effort when a catalog is given. Only a lane with a recorded route may pass it. Like any recorded
// GPT default, a former GPT default recorded with Fast on keeps it.
function recordedFormerDefault(route, taskClass, rows) {
  const kind = canonicalWorkerClass(taskClass), former = formerClassRoute(route, kind, rows);
  return Boolean(route?.source === 'task-default' && former && canonicalWorkerClass(route.kind) === kind &&
    route.effort === former.effort &&
    (route.fastMode === former.fastMode || (route.fastMode === true && GPT_WEB_LABELS.includes(former.label))) &&
    (!rows || rows.some(row => row.label === former.label && namesRow(row, route.model) &&
      row.thinkingOptions?.some(option => option.id === route.effort))));
}

// The Worker route a brief or request is built from, bound to its destination task (as readTask returns it), lane, and
// intended class when given. Task records are bookkeeping, not routing authority, so the class comes from the caller: a
// UI task's lanes are ui-design (the default) or ui-check, and any other bound lane names its taskClass. A lane with a recorded route takes only that route
// and rebuilds under validateRebuild; a fresh lane is checked as new and against its class.
function validateLaunchedWorkerRoute(route, { task = null, lane = null, taskClass = null, catalog = null } = {}) {
  requireWorkerModel(route?.model, catalog);
  if (task != null && (typeof task !== 'object' || Array.isArray(task))) throw Error('destination task must be a task record');
  if (taskClass != null && !knownClass(taskClass)) throw workerRouteUnresolved();
  const laneClass = uiTaskLaneClass(task, taskClass);
  if (task != null && task.ui !== true && taskClass == null) throw Error('a Worker bound to a task record needs its lane class (taskClass)');
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  if (task?.ui === true && !isUiRoute(route, rows)) {
    throw Error(`UI task: a ${laneClass} lane launches only Fable high, Fast off (owner rule); the build goes to a code task`);
  }
  requireFableRule(route, rows);
  if (offPaceRoute(route)) {
    const { receipt } = validateRecordedWorkerRoute(route);
    if (task == null || canonicalWorkerClass(laneClass) !== 'code' || receipt.task !== task.id || receipt.lane !== lane ||
        !recordedLaneEntry(task, lane, route)) throw Error(`a ${route.source} route launches only from its own recorded code lane`);
    if (!offPaceLaunchAllowed()) {
      throw Error(`no ${route.source} launch: the launcher is excluded, or the excluded-launcher list or launcher chain is unreadable`);
    }
    // Every launch and rebuild: the record must still be exactly its approved runtime, or the lane stops (no switch).
    if (unapprovedOffPace(route)) throw Error(`recorded ${route.source} is not its approved runtime; the lane stops`);
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
    if (taskKind === 'review-security' && isGptOrWebRoute(ownerRoute, rows)) {
      throw Error('review-security never runs a GPT or web model (owner rule); name a Claude model or use the class route');
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

const READ_ONLY_BRIEFS = Object.freeze({
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
  if (offPaceRoute(resolved) && reason != null && reason !== resolved.reason) {
    throw Error(`a ${resolved.source} lane takes only its recorded reason`);
  }
  // A UI task's lane is ui-design or ui-check even when the caller names no class and the route carries no kind.
  const kind = canonicalWorkerClass((role === 'worker' ? uiTaskLaneClass(task, taskClass) : taskClass) ?? route?.kind);
  if (role === 'worker' && ['plan', 'review', 'review-security', ...UI_CLASSES].includes(kind)) {
    brief = `Read-only lane: do not edit, implement, or publish. ${READ_ONLY_BRIEFS[kind] ?? ''}\n\n${brief}`;
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
  serverId = null } = {}) {
  const replacement = role === 'worker' && route?.source === 'replacement';
  const backup = role === 'worker' && route?.source === 'pace-backup';
  if (role === 'worker') {
    requireWorkerModel(route?.model, catalog);
    requireWorkerModel(String(provider ?? '').replace(/^(?:pi|codex|claude)\//, ''), catalog);
  }
  const bound = role === 'worker' && task != null;
  const standingBrowser = role === 'worker' && browserClass(routeClass(route, taskClass)) && route != null;
  if (provider && !String(provider).startsWith('pi/') && role === 'worker' &&
      !(standingBrowser && String(provider).startsWith('codex/')) &&
      !(replacement && String(provider).startsWith(`${REPLACEMENT_RUNTIME.provider}/`))) {
    requireNativeAuthorization(String(provider), nativeAuthorization, `explicit provider ${provider}`);
  }
  // A fixed role passed with its route is validated and mapped like a bound Worker; with no route it passes through.
  const fixedWithRoute = role !== 'worker' && route != null;
  if (provider && !bound && !standingBrowser && !fixedWithRoute && !replacement && !backup) return { provider, agentSettings };
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  const selected = role === 'worker' ? validateLaunchedWorkerRoute(route, { task, lane, taskClass, catalog: rows })
    : validateRoleRoute(role, route);
  if (selected.source === 'replacement') {
    const modeId = replacementMode(selected, capabilities, target, serverId);
    const mapped = `${selected.receipt.provider}/${selected.model}`, settings = replacementSettings();
    if (provider && (provider !== mapped || (Object.keys(agentSettings).length && !isDeepStrictEqual(agentSettings, settings)))) {
      throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped})`);
    }
    if (!provider && Object.keys(agentSettings).length) throw Error('materialize settings from the selected rule or pass an explicit provider');
    return { provider: mapped, agentSettings: settings, modeId };
  }
  // The off-pace backup runs only on Pi, on its exact catalog row at its thinking; never native or unserved.
  if (selected.source === 'pace-backup') {
    const served = (rows ?? []).filter(row => row?.id === selected.model && row.label === PACE_BACKUP_RUNTIME.label &&
      row.thinkingOptions?.some(option => option?.id === selected.effort));
    if (served.length !== 1) throw Error(`the Pi catalog does not serve exactly ${selected.model} at ${selected.effort}; the backup lane stops`);
    const mapped = `pi/${selected.model}`, settings = { thinkingOptionId: selected.effort };
    if (provider && (provider !== mapped || (Object.keys(agentSettings).length && !isDeepStrictEqual(agentSettings, settings)))) {
      throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped})`);
    }
    if (!provider && Object.keys(agentSettings).length) throw Error('materialize settings from the selected rule or pass an explicit provider');
    return { provider: mapped, agentSettings: settings };
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

#!/usr/bin/env node
// Worker route resolver. A PM launch and `node scripts/route.mjs` share resolveWorkerRoute, so the task record,
// the Worker brief, and the CLI all carry the same route and one-line reason.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonicalWorkerClass, isUiRoute, materializeFixedRoute, OWNER_RULE_ROUTES, recordedLaneEntry, routeReason, selectWorkerRoute,
  uiTaskLaneClass, validateLaneClass, validateRoleRoute, WORKER_DEFAULT_ROUTES, workerRouteUnresolved } from './agent-routing.mjs';
import { defaultRoutingPath, readQuota, readRoutingSettings, ROUTING_DEFAULTS } from './quota-pace.mjs';
import { readTask, updateTask } from './task-state.mjs';

const usage = 'usage: route.mjs --class <class> [--pq-file FILE] [--catalog FILE] ' +
  '[--owner-model ID --owner-effort LEVEL [--owner-fast on|off]] [--task TASK_JSON --lane SLUG]';

// An owner route is returned unchanged; owner-rule classes (ui-design, ui-check) skip the pace; routing.json and quota are read only
// for classes the pace may adjust, and a bad routing.json falls back to the defaults.
export async function resolveWorkerRoute({ taskClass = null, ownerRoute = null, catalog, pqFile = null,
  settings = null, home } = {}) {
  taskClass = canonicalWorkerClass(taskClass);
  if (ownerRoute) {
    const route = selectWorkerRoute({ ownerRoute, taskKind: taskClass, catalog });
    return Object.freeze({ route, reason: routeReason(route) });
  }
  if (Object.hasOwn(OWNER_RULE_ROUTES, taskClass ?? '')) {
    return Object.freeze({ route: selectWorkerRoute({ taskKind: taskClass, catalog }), reason: OWNER_RULE_ROUTES[taskClass].reason });
  }
  const rule = Object.hasOwn(WORKER_DEFAULT_ROUTES, taskClass ?? '') ? WORKER_DEFAULT_ROUTES[taskClass] : null;
  if (!rule) throw workerRouteUnresolved();
  let routing = settings ?? ROUTING_DEFAULTS, invalid = '';
  if (rule.range && !settings) {
    const path = defaultRoutingPath();
    try { routing = readRoutingSettings({ path }); } catch (error) {
      const detail = error.message.replace(path, '').replace(/^:?\s*(?:is\s+)?/, '').replace(/ \(allowed: [^)]*\)$/, '');
      invalid = `routing.json invalid (${detail.replace(/\s+/g, ' ')}), defaults used, `;
    }
  }
  const quota = rule.range ? await readQuota({ settings: routing, pqFile, home }) : null;
  const route = selectWorkerRoute({ taskKind: taskClass, catalog, quota, settings: routing });
  return Object.freeze({ route, reason: `${invalid}${routeReason(route)}`,
    ...(['browser', 'browser-hard'].includes(taskClass) ? { provider: `codex/${route.model}` } : {}) });
}

// One route per lane. Repairs and resumes reuse the recorded entry; a different route for the lane is refused, as the
// Worker request and brief refuse it. A new entry is checked against today's class table and against its lane's class
// (taskClass, or a task default's own class): the owner rules, and a task default's model by its catalog row when a
// catalog is given, else by name. That happens here, once; later reads check only its shape. A UI task records only its
// ui-design and ui-check lanes, on Fable high, Fast off.
function recordLane(task, { lane, route, reason, taskClass = null, catalog = null }) {
  if (task.ui) {
    taskClass = uiTaskLaneClass(task, taskClass);
    if (!isUiRoute(route)) throw Error(`UI task: a ${taskClass} lane records only Fable high, Fast off (owner rule); the build goes to a code task`);
  }
  const recorded = recordedLaneEntry(task, lane, route);
  if (recorded) {
    if (recorded.reason !== reason) throw Error(`lane ${lane} already has a recorded route; repairs and resumes reuse it`);
    return recorded;
  }
  validateRoleRoute('worker', route);
  const laneClass = taskClass ?? (route.source === 'task-default' ? route.kind : null);
  if (laneClass != null) validateLaneClass(route, laneClass, catalog);
  task.routes = { ...(task.routes ?? {}), [lane]: { route: structuredClone(route), reason, recorded_at: new Date().toISOString() } };
  return task.routes[lane];
}

export function recordWorkerRoute(taskPath, { lane, route, reason, taskClass = null, catalog = null }) {
  let entry;
  updateTask(taskPath, task => { entry = recordLane(task, { lane, route, reason, taskClass, catalog }); });
  return entry;
}

// The route-selection flags (--class, --owner-model, --owner-effort, --owner-fast) given for a lane that already has a
// recorded route that they would not select. A task default records its class; an owner-named route must keep the named
// class's owner rules, and a class alone selects an owner-named route only for ui-design and ui-check.
function differingLaneFlags(stored, flags, ownerRoute) {
  const differ = [];
  if (ownerRoute) {
    if (stored.source !== 'owner-explicit' || ownerRoute.model !== stored.model) differ.push('owner-model');
    if (ownerRoute.effort !== stored.effort) differ.push('owner-effort');
    if (ownerRoute.fastMode !== stored.fastMode) differ.push('owner-fast');
  }
  if (flags.class != null) {
    let fits = stored.source === 'task-default' ? canonicalWorkerClass(stored.kind) === canonicalWorkerClass(flags.class) : ownerRoute != null || Object.hasOwn(OWNER_RULE_ROUTES, canonicalWorkerClass(flags.class));
    if (fits && stored.source !== 'task-default') {
      try { validateLaneClass(stored, flags.class); } catch { fits = false; }
    }
    if (!fits) differ.push('class');
  }
  return differ;
}

// Catalog rows from Paseo capabilities ({id, label, thinkingOptions}) or `paseo provider models pi --json`.
export function catalogRows(rows) {
  if (!Array.isArray(rows)) throw Error('Pi catalog must be a JSON array of model rows');
  return rows.map(row => ({ id: row.id, label: row.label ?? row.model,
    thinkingOptions: Array.isArray(row.thinkingOptions) ? row.thinkingOptions : (row.thinkingOptionIds ?? []).map(id => ({ id })) }));
}

const readJson = (path, what) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw Error(`${what} ${path} unreadable (${error.message})`); }
};

async function readCatalog(path) {
  if (path) return catalogRows(readJson(path, 'catalog'));
  // On Windows the paseo CLI is an npm .cmd shim, which only cmd.exe can start. The words are fixed, so cmd.exe gets
  // them as one quoted command line, as shell: true would build it; arguments plus shell: true is deprecated (DEP0190).
  const [file, args, verbatim] = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"paseo provider models pi --json"'], true]
    : ['paseo', ['provider', 'models', 'pi', '--json'], false];
  const { stdout } = await promisify(execFile)(file, args,
    { timeout: 60000, maxBuffer: 16 << 20, encoding: 'utf8', windowsVerbatimArguments: verbatim });
  return catalogRows(JSON.parse(stdout));
}

async function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw Error(usage);
    flags[argv[i].slice(2)] = argv[++i];
  }
  const known = ['class', 'pq-file', 'catalog', 'owner-model', 'owner-effort', 'owner-fast', 'task', 'lane'];
  const unknown = Object.keys(flags).find(key => !known.includes(key));
  if (unknown) throw Error(`unknown option --${unknown}; ${usage}`);
  if (!!flags['owner-model'] !== !!flags['owner-effort'] || !!flags.task !== !!flags.lane ||
      (flags['owner-fast'] && !['on', 'off'].includes(flags['owner-fast']))) throw Error(usage);
  const ownerRoute = flags['owner-model'] ? { role: 'worker', source: 'owner-explicit', model: flags['owner-model'],
    effort: flags['owner-effort'], fastMode: flags['owner-fast'] === 'on' } : null;
  // A recorded lane resumes on its route: plainly, or with route flags that select exactly that route.
  const recorded = flags.task && flags.lane ? readTask(resolve(flags.task)).routes?.[flags.lane] : null;
  if (recorded) {
    const differ = differingLaneFlags(recorded.route, flags, ownerRoute);
    if (differ.length) {
      throw Error(`lane ${flags.lane} already has a recorded route that --${differ.join(', --')} would not select; resume it ` +
        'without route flags, or resolve a new lane');
    }
    return { route: recorded.route, reason: recorded.reason };
  }
  if (flags.class === 'planner' && !flags['owner-model']) {
    if (flags.task) throw Error('planner rounds are recorded by planner.mjs, not as a Worker lane');
    const catalog = await readCatalog(flags.catalog);
    return { route: materializeFixedRoute('planner', catalog),
      reason: 'planner fixed: Sol xhigh, Fast on, read-only Pi lane' };
  }
  if (!ownerRoute && !flags.class) throw Error(usage);
  const catalog = ownerRoute ? null : await readCatalog(flags.catalog);
  const resolved = await resolveWorkerRoute({ taskClass: flags.class ?? null, ownerRoute, catalog,
    pqFile: flags['pq-file'] ?? null });
  if (flags.task) recordWorkerRoute(resolve(flags.task), { lane: flags.lane, ...resolved, taskClass: flags.class ?? null, catalog });
  return resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

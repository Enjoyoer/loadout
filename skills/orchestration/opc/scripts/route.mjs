#!/usr/bin/env node
// Worker route resolver. A PM launch and `node scripts/route.mjs` share resolveWorkerRoute, so the task record,
// the Worker brief, and the CLI all carry the same route and one-line reason.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { isGptOrWebRoute, materializeFixedRoute, OWNER_RULE_ROUTES, routeReason, selectWorkerRoute, validateRoleRoute,
  WORKER_DEFAULT_ROUTES, workerRouteUnresolved } from './agent-routing.mjs';
import { authorizeCloudFallback, checkCloudEligibility, CLOUD_ALL_CLASSES, cloudClasses, readCloudToggle,
  resolveCloudWorkerRoute } from './cloud-lane.mjs';
import { defaultRoutingPath, readQuota, readRoutingSettings, ROUTING_DEFAULTS } from './quota-pace.mjs';
import { readTask, updateTask } from './task-state.mjs';

const usage = 'usage: route.mjs --class <class> [--pq-file FILE] [--catalog FILE] [--cloud-facts FILE] ' +
  '[--owner-model ID --owner-effort LEVEL [--owner-fast on|off]] [--task TASK_JSON --lane SLUG [--cloud-fallback]]';

// cloud is { toggle, eligibility } from readCloudToggle and checkCloudEligibility, or null when not checked.
// An owner route is returned unchanged; owner-rule classes (ui) skip the pace, and the cloud lane unless its toggle is all; routing.json and
// quota are read only for classes the pace may adjust, and a bad routing.json falls back to the defaults.
export async function resolveWorkerRoute({ taskClass = null, ownerRoute = null, catalog, cloud = null, pqFile = null,
  settings = null, home } = {}) {
  if (ownerRoute) {
    const route = selectWorkerRoute({ ownerRoute, taskKind: taskClass, catalog });
    return Object.freeze({ route, reason: routeReason(route) });
  }
  if (Object.hasOwn(OWNER_RULE_ROUTES, taskClass ?? '')) {
    const cloudRoute = cloud?.toggle === 'all' ? resolveCloudWorkerRoute({ ...cloud, taskClass }) : null;
    if (cloudRoute) return Object.freeze({ route: cloudRoute, reason: `${taskClass} on the cloud lane (toggle all, eligible), Opus xhigh on cloud credits` });
    return Object.freeze({ route: selectWorkerRoute({ taskKind: taskClass, catalog }), reason: OWNER_RULE_ROUTES[taskClass].reason });
  }
  const rule = Object.hasOwn(WORKER_DEFAULT_ROUTES, taskClass ?? '') ? WORKER_DEFAULT_ROUTES[taskClass] : null;
  if (!rule) throw workerRouteUnresolved();
  const cloudRoute = cloud ? resolveCloudWorkerRoute({ ...cloud, taskClass }) : null;
  if (cloudRoute) {
    return Object.freeze({ route: cloudRoute,
      reason: `${taskClass} on the cloud lane (toggle ${cloud.toggle}, eligible), ${cloudRoute.effort} on cloud credits` });
  }
  const relevant = cloud && (['on', 'all'].includes(cloud.toggle) ? cloudClasses(cloud.toggle).includes(taskClass) : taskClass === 'code');
  const note = !relevant ? '' : cloud.toggle === 'off' ? 'cloud lane off, '
    : `cloud lane ineligible (${cloud.eligibility?.reasons?.join('; ') || 'no eligibility facts'}), `;
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
  return Object.freeze({ route, reason: `${note}${invalid}${routeReason(route)}` });
}

// After a dead cloud lane, its one local fallback Worker resolves like any local route for the lane's class
// (default ui for a UI task, else code; a UI task refuses any other class, so the ui owner rule holds): Pi catalog label, quota pace, and reason, or an owner-named route. It is recorded under the lane
// <lane>-fallback, never over the lane's cloud route, and cloud.fallback and that route are written in one task update.
export async function resolveCloudFallback(taskPath, { lane, taskClass = null, ownerRoute = null, catalog, pqFile = null,
  settings = null, home } = {}) {
  const task = readTask(taskPath);
  taskClass ??= task.ui ? 'ui' : 'code';
  if (task.ui && taskClass !== 'ui') throw Error('UI task: the cloud fallback must use the ui class (owner rule)');
  if (!CLOUD_ALL_CLASSES.includes(taskClass)) throw Error(`cloud fallback class must be one of ${CLOUD_ALL_CLASSES.join(', ')}`);
  // A Worker lane slug is at most 40 characters, so <lane>-fallback must fit.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lane ?? '') || lane.length > 31) {
    throw Error('cloud fallback needs the cloud Worker lane slug (at most 31 characters)');
  }
  const cloud = task.cloud;
  if (cloud?.status !== 'dead') throw Error('cloud fallback requires a heartbeat-recorded dead cloud lane');
  const local = await resolveWorkerRoute({ taskClass, ownerRoute, catalog, pqFile, settings, home });
  const fallback = { lane: `${lane}-fallback`, route: local.route, reason: `cloud lane dead (${cloud.reason}), local fallback: ${local.reason}` };
  authorizeCloudFallback(taskPath, { route: fallback.route, reason: fallback.reason, record: task => recordLane(task, fallback) });
  return Object.freeze(fallback);
}

// One route per lane. Repairs and resumes reuse the recorded entry; a different route for the lane is refused.
// A new entry is checked against today's class table here, once; later reads check only its shape.
function recordLane(task, { lane, route, reason }) {
  if (task.ui && isGptOrWebRoute(route)) throw Error('UI task: GPT and web routes are refused (owner rule); use the ui class');
  const recorded = task.routes?.[lane];
  if (recorded) {
    if (JSON.stringify(recorded.route) !== JSON.stringify(route) || recorded.reason !== reason) {
      throw Error(`lane ${lane} already has a recorded route; repairs and resumes reuse it`);
    }
    return recorded;
  }
  validateRoleRoute('worker', route);
  task.routes = { ...(task.routes ?? {}), [lane]: { route: structuredClone(route), reason, recorded_at: new Date().toISOString() } };
  return task.routes[lane];
}

export function recordWorkerRoute(taskPath, { lane, route, reason }) {
  let entry;
  updateTask(taskPath, task => { entry = recordLane(task, { lane, route, reason }); });
  return entry;
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
    if (argv[i] === '--cloud-fallback') { flags['cloud-fallback'] = true; continue; }
    if (!argv[i].startsWith('--') || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw Error(usage);
    flags[argv[i].slice(2)] = argv[++i];
  }
  const known = ['class', 'pq-file', 'catalog', 'cloud-facts', 'owner-model', 'owner-effort', 'owner-fast', 'task', 'lane',
    'cloud-fallback'];
  const unknown = Object.keys(flags).find(key => !known.includes(key));
  if (unknown) throw Error(`unknown option --${unknown}; ${usage}`);
  if (!!flags['owner-model'] !== !!flags['owner-effort'] || !!flags.task !== !!flags.lane ||
      (flags['owner-fast'] && !['on', 'off'].includes(flags['owner-fast']))) throw Error(usage);
  const ownerRoute = flags['owner-model'] ? { role: 'worker', source: 'owner-explicit', model: flags['owner-model'],
    effort: flags['owner-effort'], fastMode: flags['owner-fast'] === 'on' } : null;
  // Before the recorded-lane shortcut: the cloud lane's own record is the dead cloud route.
  if (flags['cloud-fallback']) {
    if (!flags.task) throw Error('--cloud-fallback needs --task and --lane');
    return resolveCloudFallback(resolve(flags.task), { lane: flags.lane, taskClass: flags.class ?? null, ownerRoute,
      catalog: await readCatalog(flags.catalog), pqFile: flags['pq-file'] ?? null });
  }
  if (flags.task && flags.lane && readTask(resolve(flags.task)).routes?.[flags.lane]) {
    const { route, reason } = readTask(resolve(flags.task)).routes[flags.lane];
    return { route, reason };
  }
  if (flags.class === 'planner' && !flags['owner-model']) {
    if (flags.task) throw Error('planner rounds are recorded by planner.mjs, not as a Worker lane');
    const catalog = await readCatalog(flags.catalog);
    return { route: materializeFixedRoute('planner', catalog), fallback: materializeFixedRoute('planner_fallback', catalog),
      reason: 'planner fixed: Web Pro; fallback only after an owner yes following a Pro failure' };
  }
  if (!ownerRoute && !flags.class) throw Error(usage);
  const catalog = ownerRoute ? null : await readCatalog(flags.catalog);
  const cloud = flags['cloud-facts'] ? { toggle: readCloudToggle(),
    eligibility: checkCloudEligibility(readJson(flags['cloud-facts'], 'cloud facts')) } : null;
  const resolved = await resolveWorkerRoute({ taskClass: flags.class ?? null, ownerRoute, catalog, cloud,
    pqFile: flags['pq-file'] ?? null });
  if (flags.task) recordWorkerRoute(resolve(flags.task), { lane: flags.lane, ...resolved });
  return resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

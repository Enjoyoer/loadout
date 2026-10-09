#!/usr/bin/env node
// Worker route resolver. A PM launch and `node scripts/route.mjs` share resolveWorkerRoute, so the task record,
// the Worker brief, and the CLI all carry the same route and one-line reason.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { isGptOrWebRoute, materializeFixedRoute, OWNER_RULE_ROUTES, routeReason, selectWorkerRoute,
  WORKER_DEFAULT_ROUTES } from './agent-routing.mjs';
import { checkCloudEligibility, CLOUD_EDITING_CLASSES, readCloudToggle, resolveCloudWorkerRoute } from './cloud-lane.mjs';
import { readQuota, readRoutingSettings } from './quota-pace.mjs';
import { readTask, updateTask } from './task-state.mjs';

const usage = 'usage: route.mjs --class <class> [--pq-file FILE] [--catalog FILE] [--cloud-facts FILE] ' +
  '[--owner-model ID --owner-effort LEVEL [--owner-fast on|off]] [--task TASK_JSON --lane SLUG]';

// cloud is { toggle, eligibility } from readCloudToggle and checkCloudEligibility, or null when not checked.
// An owner route is returned unchanged; owner-rule classes (ui) skip the cloud lane and the pace; quota is read
// only for classes the pace may adjust.
export async function resolveWorkerRoute({ taskClass = null, ownerRoute = null, catalog, cloud = null, pqFile = null,
  settings = null, home } = {}) {
  if (ownerRoute) {
    const route = selectWorkerRoute({ ownerRoute, taskKind: taskClass, catalog });
    return Object.freeze({ route, reason: routeReason(route) });
  }
  if (Object.hasOwn(OWNER_RULE_ROUTES, taskClass ?? '')) {
    return Object.freeze({ route: selectWorkerRoute({ taskKind: taskClass, catalog }), reason: OWNER_RULE_ROUTES[taskClass].reason });
  }
  const rule = Object.hasOwn(WORKER_DEFAULT_ROUTES, taskClass ?? '') ? WORKER_DEFAULT_ROUTES[taskClass] : null;
  if (!rule) selectWorkerRoute({ taskKind: taskClass, catalog });
  const cloudRoute = cloud ? resolveCloudWorkerRoute({ ...cloud, taskClass }) : null;
  if (cloudRoute) {
    return Object.freeze({ route: cloudRoute,
      reason: `${taskClass} on the cloud lane (toggle ${cloud.toggle}, eligible), ${cloudRoute.effort} on cloud credits` });
  }
  const relevant = cloud && (cloud.toggle === 'on' ? CLOUD_EDITING_CLASSES.includes(taskClass) : taskClass === 'code');
  const note = !relevant ? '' : cloud.toggle === 'off' ? 'cloud lane off, '
    : `cloud lane ineligible (${cloud.eligibility?.reasons?.join('; ') || 'no eligibility facts'}), `;
  const routing = settings ?? readRoutingSettings();
  const quota = rule.range ? await readQuota({ settings: routing, pqFile, home }) : null;
  const route = selectWorkerRoute({ taskKind: taskClass, catalog, quota, settings: routing });
  return Object.freeze({ route, reason: `${note}${routeReason(route)}` });
}

// One route per lane. Repairs and resumes reuse the recorded entry; a different route for the lane is refused.
export function recordWorkerRoute(taskPath, { lane, route, reason }) {
  let entry;
  updateTask(taskPath, task => {
    if (task.ui && isGptOrWebRoute(route)) throw Error('UI task: GPT and web routes are refused (owner rule); use the ui class');
    const recorded = task.routes?.[lane];
    if (recorded) {
      if (JSON.stringify(recorded.route) !== JSON.stringify(route) || recorded.reason !== reason) {
        throw Error(`lane ${lane} already has a recorded route; repairs and resumes reuse it`);
      }
      entry = recorded;
      return;
    }
    task.routes = { ...(task.routes ?? {}), [lane]: { route: structuredClone(route), reason, recorded_at: new Date().toISOString() } };
    entry = task.routes[lane];
  });
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
  const { stdout } = await promisify(execFile)('paseo', ['provider', 'models', 'pi', '--json'],
    { timeout: 60000, maxBuffer: 16 << 20, encoding: 'utf8' });
  return catalogRows(JSON.parse(stdout));
}

async function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw Error(usage);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  const known = ['class', 'pq-file', 'catalog', 'cloud-facts', 'owner-model', 'owner-effort', 'owner-fast', 'task', 'lane'];
  const unknown = Object.keys(flags).find(key => !known.includes(key));
  if (unknown) throw Error(`unknown option --${unknown}; ${usage}`);
  if (!!flags['owner-model'] !== !!flags['owner-effort'] || !!flags.task !== !!flags.lane ||
      (flags['owner-fast'] && !['on', 'off'].includes(flags['owner-fast']))) throw Error(usage);
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
  const ownerRoute = flags['owner-model'] ? { role: 'worker', source: 'owner-explicit', model: flags['owner-model'],
    effort: flags['owner-effort'], fastMode: flags['owner-fast'] === 'on' } : null;
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

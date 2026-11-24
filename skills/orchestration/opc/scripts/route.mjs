#!/usr/bin/env node
// Worker route resolver. A PM launch and `node scripts/route.mjs` share resolveWorkerRoute, so the task record,
// the Worker brief, and the CLI all carry the same route and one-line reason.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { canonicalWorkerClass, isReplacementMode, isTargetId, isUiRoute, OFF_PACE_SOURCES, offPaceLaunchAllowed, OWNER_RULE_ROUTES,
  PACE_BACKUP_REASON, PACE_BACKUP_RUNTIME, PARITY_BACKUP_REASON, PARITY_REASON, recordedLaneEntry, REPLACEMENT_REASON,
  REPLACEMENT_RUNTIME, routeReason, selectWorkerRoute, uiTaskLaneClass, validateLaneClass, readLocalRouting, validateRoleRoute,
  WORKER_DEFAULT_ROUTES, workerRouteUnresolved } from './agent-routing.mjs';
import { managedWorkerNames } from './paseo-worker.mjs';
import { readTask, updateTask, withFileLock } from './task-state.mjs';

const usage = 'usage: route.mjs --class <class> [--catalog FILE] ' +
  '[--owner-model ID --owner-effort LEVEL [--owner-fast on|off]] [--task TASK_JSON --lane SLUG]';

// Replacement opt-in: the antigravityFallback namespace of the user's ~/.config/opc/routing.json, written only by Config's
// pace job and read strictly (readLocalRouting), never reported. Other keys (pq) are not read.
const RFC3339_UTC = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z$/;
function utcTime(value) {
  const m = typeof value === 'string' ? RFC3339_UTC.exec(value) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute, second, Number((m[7] ?? '0').padEnd(3, '0')));
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? time : null;
}
const exactKeys = (value, keys) => value != null && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
// The switch, from the strictly read local routing file (readLocalRouting): exactly {enabled, state: {off_pace, as_of,
// expires_at}} with RFC 3339 UTC times and as_of <= now < expires_at, and enabled and off_pace the same boolean. 'forced'
// when both are true (off pace, decision 314a), 'parity' when both are false (not forced: decision 359 alternation; it
// proves nothing about quota), null for anything else: absent, stale, malformed, unsafe or contradictory, which stays Opus.
function switchMode(doc, now) {
  const fallback = doc?.antigravityFallback;
  if (!exactKeys(fallback, ['enabled', 'state']) || typeof fallback.enabled !== 'boolean') return null;
  const { state } = fallback;
  if (!exactKeys(state, ['off_pace', 'as_of', 'expires_at']) || state.off_pace !== fallback.enabled) return null;
  const asOf = utcTime(state.as_of), expiresAt = utcTime(state.expires_at);
  if (asOf == null || expiresAt == null || !(asOf < expiresAt && asOf <= now && now < expiresAt)) return null;
  return fallback.enabled ? 'forced' : 'parity';
}

// Decision 359 alternation state: per launching agent (PASEO_AGENT_ID), the number of eligible code lanes admitted while
// the switch said not forced. An even count gives an Opus turn, an odd one a Neon turn. It lives beside routing.json, which
// it never touches, in an owner-only file read as strictly as that file: absent is an empty state, anything unreadable,
// unsafe or malformed is null and keeps every lane on Opus without consuming a turn. Only recordWorkerRoute writes it,
// under its lock, after the lane's record is written.
const alternationPath = () => join(homedir(), '.config', 'opc', 'code-alternation.json');
const MAX_LAUNCHERS = 256;
const launcherId = id => typeof id === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(id);
function readAlternation(path = alternationPath()) {
  let text;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd), link = lstatSync(path);
      if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev || stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 || stat.size > 1 << 20) return null;
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (error) { return error.code === 'ENOENT' ? { launchers: {} } : null; }
  // An empty file is an empty state: recordWorkerRoute creates the file empty before it first takes the lock.
  if (text === '') return { launchers: {} };
  try {
    const doc = JSON.parse(text), launchers = doc?.launchers;
    if (!exactKeys(doc, ['launchers']) || launchers == null || typeof launchers !== 'object' || Array.isArray(launchers) ||
        Object.keys(launchers).length > MAX_LAUNCHERS || Object.entries(launchers).some(([id, entry]) => !launcherId(id) ||
          !exactKeys(entry, ['admitted', 'at']) || !Number.isSafeInteger(entry.admitted) || entry.admitted < 0 || utcTime(entry.at) == null)) {
      return null;
    }
    return doc;
  } catch { return null; } // probe-ok: fails closed, a malformed alternation state keeps every lane on Opus; expires 2027-05-22
}
// Writes the state through a synced owner-only temporary file renamed over it, keeping the most recently admitted launchers.
function writeAlternation(path, doc) {
  const entries = Object.entries(doc.launchers).sort(([, a], [, b]) => utcTime(b.at) - utcTime(a.at)).slice(0, MAX_LAUNCHERS);
  const temporary = join(resolve(path, '..'), `.code-alternation-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ launchers: Object.fromEntries(entries) }, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  const dir = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

// The runtime proof the PM verified on the target, independent of the opt-in, may be at most this old.
const REPLACEMENT_PROOF_MAX_AGE_MS = 60 * 60 * 1000;
// Whether proof and target show the replacement runtime verified on the local Mac target within the window.
function neonReady(proof, target, now) {
  const runtime = REPLACEMENT_RUNTIME, verifiedAt = utcTime(proof?.verified_at);
  return exactKeys(target, ['daemon', 'local', 'platform']) && isTargetId(target.daemon) && target.local === true &&
    target.platform === 'darwin' &&
    exactKeys(proof, ['provider', 'extends', 'model', 'thinking', 'mode', 'sandboxed', 'write', 'target', 'verified_at']) &&
    proof.provider === runtime.provider && proof.extends === runtime.extends && proof.model === runtime.model &&
    proof.thinking === runtime.effort && isReplacementMode(proof.mode) && proof.sandboxed === true && proof.write === true &&
    isDeepStrictEqual(proof.target, target) && verifiedAt != null && verifiedAt <= now &&
    now - verifiedAt <= REPLACEMENT_PROOF_MAX_AGE_MS;
}
// The off-pace route for a code Worker lane, or null to keep the class default. context is the PM's structured launch
// context, never prompt text, a label, an alias, or a record: task (readTask) and lane, and, for Neon, target
// {daemon, local: true, platform: 'darwin'}, the local daemon it will launch on, and proof {provider, extends, model,
// thinking, mode, sandboxed: true, write: true, target, verified_at}, the PM-verified capability on that target.
// Only a Worker lane of the code class on the Opus high, Fast off default is eligible (never a review, review-security,
// another class or a PM), never one from an excluded launcher (offPaceLaunchAllowed), and only a fresh lane (a recorded lane keeps its route). With
// unavailable, the PM's evidence that Neon cannot launch on the target (newer than any fresh proof), it takes the Sol
// backup when the catalog serves it; else with a fresh proof it takes Neon; else (no proof, no evidence) the Opus default. The opt-in is read last.
const REPLACEMENT_CONTEXT_KEYS = ['task', 'lane', 'proof', 'target', 'unavailable'];
// unavailable {provider: 'agy-opc', target, checked_at, finding}: what MCP inspect_provider (with list_models) showed on
// the same local target within the last hour: agy-opc missing, disabled, not available, or not serving the model at
// high with mode auto.
const UNAVAILABLE_FINDINGS = ['missing', 'disabled', 'not-available', 'not-serving'];
const validTarget = target => exactKeys(target, ['daemon', 'local', 'platform']) && isTargetId(target.daemon) &&
  target.local === true && target.platform === 'darwin';
const recent = (value, now) => { const at = utcTime(value); return at != null && at <= now && now - at <= REPLACEMENT_PROOF_MAX_AGE_MS; };
function neonUnavailable(unavailable, target, now) {
  return validTarget(target) && exactKeys(unavailable, ['provider', 'target', 'checked_at', 'finding']) &&
    unavailable.provider === REPLACEMENT_RUNTIME.provider && isDeepStrictEqual(unavailable.target, target) &&
    UNAVAILABLE_FINDINGS.includes(unavailable.finding) && recent(unavailable.checked_at, now);
}
// The admission of a fresh code lane: null when no off-pace rule applies (the plain class default), else {route, parity}.
// route is the off-pace route (Neon or the Sol backup) or null for the Opus default. Forced (switch true, decision 314a):
// Neon with a fresh proof, the backup with newer fresh unavailable evidence, else null. Not forced (a valid fresh false,
// decision 359): parity {launcher, admitted, consumes} from the launcher's alternation state; an even admitted count is an
// Opus turn (route null, consumes), an odd one a Neon turn that takes Neon or, with that evidence, the backup (consumes),
// and with neither stays Opus without consuming. state is the alternation state already read under its lock; omitted, it
// is read now (a resolve, which writes nothing); null (unreadable or malformed) admits nothing.
const ALTERNATION_SOURCES = Object.freeze(['task-default', ...OFF_PACE_SOURCES]);
function codeAdmission(context, { taskClass, catalog }, state) {
  try {
    const { task, lane, proof, target, unavailable } = context ?? {};
    const rule = WORKER_DEFAULT_ROUTES.code, now = Date.now();
    if (context == null || typeof context !== 'object' || Object.keys(context).some(key => !REPLACEMENT_CONTEXT_KEYS.includes(key)) ||
        canonicalWorkerClass(taskClass) !== 'code' ||
        rule.label !== 'Opus' || rule.effort !== 'high' || rule.fastMode !== false) return null;
    const base = selectWorkerRoute({ taskKind: 'code', catalog });
    if (base.effort !== 'high' || base.fastMode !== false || !task || typeof task !== 'object' || task.ui === true ||
        typeof task.id !== 'string' || typeof lane !== 'string' || (task.routes && Object.hasOwn(task.routes, lane))) return null;
    // Only the local Mac target is supported; any other target keeps the Opus default and consumes nothing.
    if (!validTarget(target)) return null;
    const ready = neonReady(proof, target, now);
    // Both fresh: the newer one decides.
    const down = neonUnavailable(unavailable, target, now) &&
      (!ready || utcTime(unavailable.checked_at) > utcTime(proof.verified_at));
    const neon = !down && ready;
    const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
    const backup = down && rows?.filter(row => row?.id === PACE_BACKUP_RUNTIME.model && row.label === PACE_BACKUP_RUNTIME.label &&
      row.thinkingOptions?.some(option => option?.id === PACE_BACKUP_RUNTIME.effort)).length === 1;
    const { branchName } = managedWorkerNames({ taskId: task.id, lane });
    const doc = readLocalRouting(), mode = switchMode(doc, now);
    if (mode == null || (mode === 'forced' && !neon && !backup) || !offPaceLaunchAllowed(doc)) return null;
    const offPace = (forced) => {
      const runtime = neon ? REPLACEMENT_RUNTIME : PACE_BACKUP_RUNTIME;
      return Object.freeze({ role: 'worker', source: neon ? 'replacement' : 'pace-backup', kind: 'code', model: runtime.model,
        effort: runtime.effort, fastMode: runtime.fastMode,
        reason: neon ? (forced ? REPLACEMENT_REASON : PARITY_REASON) : (forced ? PACE_BACKUP_REASON : PARITY_BACKUP_REASON),
        receipt: Object.freeze(neon ? { provider: runtime.provider, mode: proof.mode, target: target.daemon, task: task.id, lane,
          placement: branchName } : { task: task.id, lane, placement: branchName }) });
    };
    if (mode === 'forced') return Object.freeze({ route: offPace(true), parity: null });
    const launcher = process.env.PASEO_AGENT_ID, alternation = state === undefined ? readAlternation() : state;
    if (!launcherId(launcher) || alternation == null) return null;
    const admitted = Object.hasOwn(alternation.launchers, launcher) ? alternation.launchers[launcher].admitted : 0;
    const neonTurn = admitted % 2 === 1, taken = neonTurn && (neon || backup);
    return Object.freeze({ route: taken ? offPace(false) : null,
      parity: Object.freeze({ launcher, admitted, consumes: !neonTurn || taken }) });
  } catch { return null; } // probe-ok: fails closed, any error resolves no off-pace route; expires 2027-05-22
}

// An owner route is returned unchanged; owner-rule classes (ui-design, ui-check) carry their rule's reason, and every
// other class runs at its table default. With a replacement context a code lane may resolve to an off-pace route
// (codeAdmission); every other case returns exactly what it returns without one. A resolve writes nothing, so it consumes
// no alternation turn.
export async function resolveWorkerRoute({ taskClass = null, ownerRoute = null, catalog, replacement = null } = {}) {
  taskClass = canonicalWorkerClass(taskClass);
  if (ownerRoute) {
    const route = selectWorkerRoute({ ownerRoute, taskKind: taskClass, catalog });
    return Object.freeze({ route, reason: routeReason(route) });
  }
  if (Object.hasOwn(OWNER_RULE_ROUTES, taskClass ?? '')) {
    return Object.freeze({ route: selectWorkerRoute({ taskKind: taskClass, catalog }), reason: OWNER_RULE_ROUTES[taskClass].reason });
  }
  if (!Object.hasOwn(WORKER_DEFAULT_ROUTES, taskClass ?? '')) throw workerRouteUnresolved();
  const route = selectWorkerRoute({ taskKind: taskClass, catalog });
  const resolved = Object.freeze({ route, reason: routeReason(route),
    ...(['browser', 'browser-hard', 'sites'].includes(taskClass) ? { provider: `codex/${route.model}` } : {}) });
  const replaced = replacement == null ? null : codeAdmission(replacement, { taskClass, catalog })?.route;
  return replaced ? Object.freeze({ route: replaced, reason: replaced.reason }) : resolved;
}

// One route per lane. Repairs and resumes reuse the recorded entry; a different route for the lane is refused, as the
// Worker request and brief refuse it. A new entry is checked against today's class table and against its lane's class
// (taskClass, or a task default's own class): the owner rules, and a task default's model by its catalog row when a
// catalog is given, else by name. That happens here, once; later reads check only its shape. A UI task records only its
// ui-design and ui-check lanes, on Fable high, Fast off.
function recordLane(task, { lane, route, reason, taskClass = null, catalog = null, replacement = null }, state) {
  if (task.ui) {
    taskClass = uiTaskLaneClass(task, taskClass);
    if (!isUiRoute(route)) throw Error(`UI task: a ${taskClass} lane records only Fable high, Fast off (owner rule); the build goes to a code task`);
  }
  const recorded = recordedLaneEntry(task, lane, route);
  if (recorded) {
    if (recorded.reason !== reason) throw Error(`lane ${lane} already has a recorded route; repairs and resumes reuse it`);
    return { entry: recorded, admission: null };
  }
  // A fresh off-pace route records only as its admission resolves now, against this locked record (and, not forced, the
  // locked alternation state). An owner-named route is never admitted and consumes nothing.
  const admission = replacement != null && ALTERNATION_SOURCES.includes(route?.source)
    ? codeAdmission({ ...replacement, task, lane }, { taskClass, catalog }, state) : null;
  if (OFF_PACE_SOURCES.includes(route?.source) && (reason !== route.reason || !isDeepStrictEqual(admission?.route, route))) {
    throw Error(`a ${route.source} route records only through its admitted resolution for this task and lane`);
  }
  // Not forced, an eligible task default records only on the turn it resolved for: when a competing admission of the same
  // launcher took that turn first, the lane is refused and may be resolved again.
  if (admission?.parity && route.source === 'task-default' && admission.route != null) {
    throw Error(`lane ${lane}: the launcher's alternation turn changed since this route was resolved; resolve the lane again`);
  }
  validateRoleRoute('worker', route);
  const laneClass = taskClass ?? (route.source === 'task-default' ? route.kind : null);
  if (laneClass != null) validateLaneClass(route, laneClass, catalog);
  task.routes = { ...(task.routes ?? {}), [lane]: { route: structuredClone(route), reason, recorded_at: new Date().toISOString() } };
  return { entry: task.routes[lane], admission };
}

// Records a lane's route. While the switch says not forced (decision 359) an eligible code lane (a fresh bound code lane
// with a Mac target in its replacement context, from a launcher that is not excluded) records under the alternation lock:
// its admission is decided against the locked state, the task record is written, and only then is the launcher's
// admitted count raised, once, when the lane took its turn. A replayed lane, a refused one, an owner-named route and a
// forced lane write no alternation state.
export function recordWorkerRoute(taskPath, { lane, route, reason, taskClass = null, catalog = null, replacement = null }) {
  const write = state => {
    let result;
    updateTask(taskPath, task => { result = recordLane(task, { lane, route, reason, taskClass, catalog, replacement }, state); });
    return result;
  };
  if (replacement == null || !ALTERNATION_SOURCES.includes(route?.source) || !validTarget(replacement.target) ||
      switchMode(readLocalRouting(), Date.now()) !== 'parity') return write(undefined).entry;
  const path = alternationPath();
  mkdirSync(join(homedir(), '.config', 'opc'), { recursive: true, mode: 0o700 });
  // The file exists before its lock is taken, so a writer that crashed holding the lock leaves a path that unlock takes.
  try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return withFileLock(path, held => {
    // Unreadable or malformed (null) admits nothing.
    const current = readAlternation(path);
    const { entry, admission } = write(current);
    if (admission?.parity?.consumes) {
      if (!held()) throw Error(`lane ${lane} recorded, but the alternation lock was lost; its turn was not counted`);
      const { launcher, admitted } = admission.parity;
      writeAlternation(path, { launchers: { ...current.launchers, [launcher]: { admitted: admitted + 1, at: new Date().toISOString() } } });
    }
    return entry;
  }, 'alternation lock');
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
    // An off-pace record (replacement or pace-backup) is a code lane's, so --class code resumes it.
    let fits = stored.source === 'task-default' ? canonicalWorkerClass(stored.kind) === canonicalWorkerClass(flags.class)
      : OFF_PACE_SOURCES.includes(stored.source) ? canonicalWorkerClass(flags.class) === 'code'
        : ownerRoute != null || Object.hasOwn(OWNER_RULE_ROUTES, canonicalWorkerClass(flags.class));
    if (fits && stored.source !== 'task-default') {
      try { validateLaneClass(stored, flags.class, null, { recorded: true }); } catch { fits = false; }
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
  const known = ['class', 'catalog', 'owner-model', 'owner-effort', 'owner-fast', 'task', 'lane'];
  const unknown = Object.keys(flags).find(key => !known.includes(key));
  if (unknown) throw Error(`unknown option --${unknown}; ${usage}`);
  if (!!flags['owner-model'] !== !!flags['owner-effort'] || !!flags.task !== !!flags.lane ||
      (flags['owner-fast'] && !['on', 'off'].includes(flags['owner-fast']))) throw Error(usage);
  const ownerRoute = flags['owner-model'] ? { role: 'worker', source: 'owner-explicit', model: flags['owner-model'],
    effort: flags['owner-effort'], fastMode: flags['owner-fast'] === 'on' } : null;
  // A recorded lane resumes on its route: plainly, or with route flags that select exactly that route.
  const task = flags.task && flags.lane ? readTask(resolve(flags.task)) : null;
  const recorded = task?.routes?.[flags.lane] ?? null;
  if (recorded) {
    const differ = differingLaneFlags(recorded.route, flags, ownerRoute);
    if (differ.length) {
      throw Error(`lane ${flags.lane} already has a recorded route that --${differ.join(', --')} would not select; resume it ` +
        'without route flags, or resolve a new lane');
    }
    return { route: recorded.route, reason: recorded.reason };
  }
  if (!ownerRoute && !flags.class) throw Error(usage);
  const catalog = ownerRoute ? null : await readCatalog(flags.catalog);
  // A task lane carries its task and lane as off-pace context; with no proof or evidence it stays on the default.
  const replacement = task ? { task, lane: flags.lane } : null;
  const resolved = await resolveWorkerRoute({ taskClass: flags.class ?? null, ownerRoute, catalog, replacement });
  if (flags.task) recordWorkerRoute(resolve(flags.task), { lane: flags.lane, ...resolved, taskClass: flags.class ?? null, catalog, replacement });
  return resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

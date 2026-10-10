import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateRecordedWorkerRoute } from './agent-routing.mjs';

// Recorded routes and planner rounds are checked for shape only; the routing tables apply once, when they are recorded.
const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const identity = task => JSON.stringify([
  task.schema, task.id, task.owner, task.repository, task.contract_version, task.delivery, task.browser_review, task.ui ?? false,
]);

export function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') || [
      'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT',
    ].includes(key)));
}

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: gitEnvironment(),
}).trim();

export function canonicalPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw Error('ordinary canonical absolute path required');
  const absolute = resolve(value);
  const real = realpathSync(absolute);
  if (absolute !== value || real !== value || lstatSync(value).isSymbolicLink()) {
    throw Error('ordinary canonical absolute path required');
  }
  return value;
}

// Signal 0 only probes existence; EPERM means the process exists under another user.
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A process's start time as an exact token in one fixed format, compared as text and never parsed: ps lstart under
// LC_ALL=C and TZ=UTC on POSIX, the creation time as UTC round-trip text on Windows. null when it cannot be read.
const START_FORMAT = process.platform === 'win32' ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/
  : /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/;
export function processStartTime(pid) {
  if (!processAlive(pid)) return null;
  try {
    const options = { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
    const output = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('o')`], options)
      : execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { ...options, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const start = output.trim().replace(/\s+/g, ' ');
    return START_FORMAT.test(start) ? start : null;
  } catch { return null; }
}

let ownStart;
export const ownStartTime = () => (ownStart === undefined ? (ownStart = processStartTime(process.pid)) : ownStart);

// Whether pid is still the process recorded with start: 'same'; 'other' when it is gone or the pid now names a
// process with a different start; 'unknown' when it is alive but either start time is missing or unreadable.
export function processIdentity(pid, start) {
  if (!processAlive(pid)) return 'other';
  const now = typeof start === 'string' && START_FORMAT.test(start) ? processStartTime(pid) : null;
  return now === null ? 'unknown' : now === start ? 'same' : 'other';
}

export function within(child, parent) {
  const path = relative(parent, child);
  return !path || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}

function catalogRound(round, label, role) {
  return round.role === role && round.catalog_label === label && typeof round.catalog_model_id === 'string' &&
    round.catalog_model_id.length > 0 && ['pi', 'codex', 'claude'].some(provider => round.provider === `${provider}/${round.catalog_model_id}`);
}

function validatePlanner(planner) {
  if (planner == null) return;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
  if (!object(planner) || !Array.isArray(planner.rounds) || planner.rounds.length > 2) throw Error('invalid planner record');
  const authorization = planner.fallback_authorization;
  if (authorization != null && (!object(authorization) || authorization.answer !== 'yes' || !uuid(authorization.after_round))) {
    throw Error('invalid planner fallback authorization');
  }
  const ids = new Set(), agents = new Set();
  for (const [index, round] of planner.rounds.entries()) {
    if (!object(round) || !uuid(round.id) ||
        !(catalogRound(round, 'Web Pro', 'planner') || (text(round.catalog_label) && catalogRound(round, round.catalog_label, 'planner_fallback')) ||
          (round.role === undefined && ['codex/chatgpt-web/pro', 'claude/claude-fable-5-1[1m]'].includes(round.provider))) ||
        !['launching', 'running', 'uncertain', 'failed', 'planned'].includes(round.status)) {
      throw Error('invalid planner round');
    }
    if (ids.has(round.id)) throw Error('duplicate planner round identity');
    ids.add(round.id);
    if (round.role === 'planner' || round.provider === 'codex/chatgpt-web/pro') {
      if (index !== 0 || Object.hasOwn(round, 'effort')) throw Error('invalid Pro planner route');
    } else if (index !== 1 || !efforts.includes(round.effort) ||
        planner.rounds[0]?.status !== 'failed' || authorization?.after_round !== planner.rounds[0].id) {
      throw Error('planner fallback requires recorded explicit owner yes after Pro failure');
    }
    const terminal = ['failed', 'planned'].includes(round.status);
    const active = !terminal;
    if (active && index !== planner.rounds.length - 1) throw Error('only the latest planner round may be nonterminal');
    if (!Object.hasOwn(round, 'agent_id') || (round.agent_id !== null && !text(round.agent_id)) ||
        ((round.status === 'running' || round.status === 'planned') && !text(round.agent_id)) ||
        (['launching', 'uncertain'].includes(round.status) && round.agent_id !== null)) {
      throw Error('invalid planner agent identity for state');
    }
    if (round.agent_id !== null) {
      if (agents.has(round.agent_id)) throw Error('duplicate planner agent identity');
      agents.add(round.agent_id);
    }
    if (round.status === 'failed' && !text(round.failure)) throw Error('failed planner round requires a reason');
    if (round.status === 'planned' && !text(round.plan)) throw Error('completed planner round requires a plan');
    if (!terminal && ['failure', 'plan'].some(key => Object.hasOwn(round, key))) throw Error('nonterminal planner round carries terminal fields');
  }
  if (authorization && (planner.rounds[0]?.status !== 'failed' || authorization.after_round !== planner.rounds[0].id)) {
    throw Error('planner fallback authorization must follow the recorded Pro failure');
  }
}

// Structural bookkeeping checks, not a tamper-resistance boundary. GitHub remains authoritative.
function validateReviewer(reviewer, task) {
  if (reviewer == null) return;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
  if (!object(reviewer)) throw Error('invalid reviewer record');
  if (!Object.hasOwn(reviewer, 'rounds')) throw Error('incompatible reviewer record; create a fresh task for new review');
  if (!task.browser_review || !Array.isArray(reviewer.rounds)) throw Error('invalid reviewer rounds or review opt-in');
  const roundIds = new Set(), agentIds = new Set();
  for (const [index, round] of reviewer.rounds.entries()) {
    if (!object(round) || !uuid(round.id) || !positive(round.pr) ||
        typeof round.head !== 'string' || !/^[0-9a-f]{40}$/.test(round.head) ||
        !(catalogRound(round, 'Web Pro', 'reviewer') || (round.role === undefined && round.provider === 'codex/chatgpt-web/pro')) ||
        !['launching', 'running', 'uncertain', 'failed', 'approved', 'changes_requested'].includes(round.status)) {
      throw Error('invalid reviewer round');
    }
    if (roundIds.has(round.id)) throw Error('duplicate reviewer round identity');
    roundIds.add(round.id);
    const verdict = ['approved', 'changes_requested'].includes(round.status);
    const active = ['launching', 'running', 'uncertain'].includes(round.status);
    if (active && index !== reviewer.rounds.length - 1) throw Error('only the latest reviewer round may be nonterminal');
    if (!Object.hasOwn(round, 'agent_id') ||
        (round.agent_id !== null && !text(round.agent_id)) ||
        ((round.status === 'running' || verdict) && !text(round.agent_id)) ||
        (['launching', 'uncertain'].includes(round.status) && round.agent_id !== null)) {
      throw Error('invalid reviewer agent identity for state');
    }
    if (round.agent_id !== null) {
      if (agentIds.has(round.agent_id)) throw Error('duplicate reviewer agent identity');
      agentIds.add(round.agent_id);
    }
    if (Object.hasOwn(round, 'effort')) throw Error('invalid reviewer effort');
    if (verdict) {
      if (!positive(round.review_id) || !text(round.reviewer_login) ||
          typeof round.review_url !== 'string' ||
          !new RegExp(`^https://github\\.com/[^/]+/[^/]+/pull/${round.pr}#pullrequestreview-${round.review_id}$`).test(round.review_url)) {
        throw Error('invalid reviewer formal verdict fields');
      }
    } else if (['review_id', 'reviewer_login', 'review_url'].some(key => Object.hasOwn(round, key))) {
      throw Error('non-verdict reviewer round carries formal verdict fields');
    }
    if (round.status === 'failed' && (!text(round.failure) || round.unavailable !== true)) {
      throw Error('failed reviewer round must record review unavailable and a reason');
    }
    if (round.status !== 'failed' && Object.hasOwn(round, 'unavailable')) throw Error('only failed review may be unavailable');
    if (Object.hasOwn(round, 'fallback')) throw Error('reviewer fallback is not permitted');
  }
}

// One cloud lane per task; the heartbeat, not the PM, moves it out of running. CLOUD_MOVES lists each status's allowed
// next statuses. no_session (a launch reconciled as never started) permits a new launch, which replaces the record.
const CLOUD_MOVES = Object.freeze({
  launching: ['launching', 'uncertain', 'running', 'no_session'], uncertain: ['uncertain', 'running', 'no_session'],
  running: ['running', 'ready', 'dead'], ready: ['ready'], dead: ['dead'], no_session: ['no_session', 'launching'],
});
function validateCloud(cloud) {
  if (cloud == null) return;
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(cloud) || !Object.hasOwn(CLOUD_MOVES, cloud.status) ||
      !['branch', 'repo', 'launched_at'].every(key => text(cloud[key])) ||
      (['running', 'ready', 'dead'].includes(cloud.status) && !['session_id', 'url'].every(key => text(cloud[key]))) ||
      (['launching', 'uncertain', 'no_session'].includes(cloud.status) && (cloud.session_id !== null || cloud.url !== null)) ||
      (cloud.attempt != null && (!Number.isSafeInteger(cloud.attempt) || cloud.attempt < 1)) ||
      (cloud.heartbeat_id !== null && !text(cloud.heartbeat_id)) ||
      !/^opc\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cloud.branch) ||
      !object(cloud.route) || cloud.route.model !== 'claude-opus-5-5[1m]' || cloud.route.effort !== 'xhigh') {
    throw Error('invalid cloud lane record');
  }
  if ((['running', 'launching'].includes(cloud.status)) !== (cloud.reason == null)) throw Error('cloud lane reason must accompany an uncertain or terminal state');
  if (cloud.fallback != null && (cloud.status !== 'dead' || !object(cloud.fallback) ||
      cloud.fallback.authorized_by !== 'cloud-toggle')) {
    throw Error('cloud fallback requires a dead cloud lane and the cloud toggle');
  }
}

// Recorded Worker routes, one per lane: the resolved route and its one-line reason, kept through repairs and resumes
// even after a routing class changes.
function validateRoutes(routes) {
  if (routes == null) return;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(routes)) throw Error('invalid Worker route records');
  for (const [lane, entry] of Object.entries(routes)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lane) || !object(entry) || Object.keys(entry).length !== 3 ||
        !['route', 'reason', 'recorded_at'].every(key => Object.hasOwn(entry, key)) ||
        typeof entry.reason !== 'string' || !entry.reason.trim() || /[\r\n]/.test(entry.reason) ||
        typeof entry.recorded_at !== 'string' || Number.isNaN(Date.parse(entry.recorded_at))) {
      throw Error(`invalid Worker route record for lane ${lane}`);
    }
    validateRecordedWorkerRoute(entry.route);
  }
}

function validate(task, path) {
  if (task.schema !== 'opc_task_v2' || task.contract_version !== 2) {
    throw Error('incompatible task contract; create a fresh task');
  }
  if (!/^[0-9a-f-]{36}$/.test(task.id) || typeof task.owner !== 'string' || !task.owner.trim()) {
    throw Error('invalid task identity');
  }
  if (!task.repository || typeof task.repository !== 'object') throw Error('invalid repository record');
  if(typeof task.repository.working_directory!=='string'||!isAbsolute(task.repository.working_directory))throw Error('absolute repository path required');
  if (within(path, task.repository.working_directory)) throw Error('task evidence must be outside worktree');
  if (!['local', 'pr', 'merge'].includes(task.delivery)) throw Error('invalid task delivery target');
  if (typeof task.browser_review !== 'boolean') throw Error('browser review choice required');
  if (typeof (task.ui ?? false) !== 'boolean') throw Error('UI choice must be boolean');
  if (task.ui && task.browser_review) throw Error('UI work never uses the web reviewer (owner rule)');
  if (!['ready', 'cancelled'].includes(task.status)) throw Error('invalid task status');
  // Only the native CLI Worker (worker.mjs, removed in OPC 7.28) wrote task.worker; a leftover record is refused, never read or dropped.
  if (task.worker != null) {
    throw Error('task.worker holds a native CLI Worker record, which OPC 7.28 removed; create a fresh task');
  }
  validatePlanner(task.planner);
  validateReviewer(task.reviewer, task);
  validateCloud(task.cloud);
  validateRoutes(task.routes);
  return task;
}

export function assertRepository(task) {
  const repository = task.repository;
  const cwd = repository.working_directory;
  canonicalPath(cwd);
  // Compared as the file system resolves them: on Windows git can spell the same top level differently (an 8.3 short
  // name expanded, a different case).
  if (realpathSync.native(resolve(git(cwd, 'rev-parse', '--show-toplevel'))) !== realpathSync.native(cwd) ||
      git(cwd, 'remote', 'get-url', 'origin') !== repository.remote ||
      git(cwd, 'remote', 'get-url', '--push', 'origin') !== repository.remote ||
      git(cwd, 'branch', '--show-current') !== repository.branch) {
    throw Error('repository ownership/configuration drift; create a fresh task');
  }
}

export function readTask(taskPath) {
  canonicalPath(taskPath);
  const task = validate(JSON.parse(readFileSync(taskPath, 'utf8')), taskPath);
  return task;
}

// ui marks UI work: Opus xhigh only, never a GPT or web lane (owner rule). It is immutable like browserReview.
export function createTask({ workingDirectory, runDirectory, owner, baseRef = 'HEAD', delivery = 'local', browserReview = false, ui = false }) {
  canonicalPath(workingDirectory);
  canonicalPath(runDirectory);
  if (within(runDirectory, workingDirectory) || within(workingDirectory, runDirectory)) {
    throw Error('run directory must be separate from worktree');
  }
  let baseBranch = null;
  if (delivery !== 'local') {
    if (baseRef === 'HEAD') throw Error('PR/merge delivery requires an explicit base branch ref');
    const symbolic = git(workingDirectory, 'rev-parse', '--symbolic-full-name', baseRef);
    if (!/^refs\/(?:heads\/|remotes\/origin\/).+/.test(symbolic)) {
      throw Error('baseRef must identify a local or origin branch');
    }
    baseBranch = symbolic.replace(/^refs\/(?:heads\/|remotes\/origin\/)/, '');
  }
  const task = {
    schema: 'opc_task_v2', id: randomUUID(), owner, delivery, browser_review: browserReview, ui,
    repository: {
      working_directory: workingDirectory,
      remote: git(workingDirectory, 'remote', 'get-url', 'origin'),
      branch: git(workingDirectory, 'branch', '--show-current'),
      base_sha: git(workingDirectory, 'rev-parse', `${baseRef}^{commit}`),
      base_branch: baseBranch,
      assigned_head_sha: git(workingDirectory, 'rev-parse', 'HEAD'),
    },
    contract_version: 2,
    status: 'ready',
    planner: null,
    tests: null,
    merge: null,
    reviewer: null,
    cloud: null,
  };
  if (!task.repository.branch) throw Error('detached worktree cannot own a task');
  const taskPath = join(runDirectory, 'task.json');
  validate(task, taskPath);
  assertRepository(task);
  writeFileSync(taskPath, JSON.stringify(task, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { taskPath, task };
}

// A lock file holds its writer's pid, then on a second line that process's start time when it could be read.
// lockOwner returns the owner pid and whether the lock is stale: its pid is dead or now names a process with another
// start time, or it is empty and over 10 s old (its writer crashed between open and write). A younger empty lock is
// still being written, and a live pid whose start time is missing or unreadable keeps its lock. null when gone.
function lockOwner(path) {
  try {
    const [owner = '', start = null] = readFileSync(path, 'utf8').trim().split(/\r?\n/).map(line => line.trim());
    const age = Date.now() - statSync(path).mtimeMs;
    return { owner, age, stale: /^\d+$/.test(owner) ? processIdentity(Number(owner), start) === 'other' : owner === '' && age > 10000 };
  } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function releaseOwn(path) {
  if (lockOwner(path)?.owner === String(process.pid)) unlinkSync(path);
}

// beforeReclaim is a test seam that runs after a stale lock is read and before it is reclaimed.
export function updateTask(taskPath, mutator, { beforeReclaim } = {}) {
  canonicalPath(taskPath);
  const lock = `${taskPath}.lock`, reclaim = `${lock}.reclaim`;
  const holder = [process.pid, ownStartTime()].filter(value => value !== null).join('\n');
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      writeFileSync(lock, holder, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const seen = lockOwner(lock);
      if (seen?.stale) {
        beforeReclaim?.(lock);
        // One reclaimer at a time. While we hold the reclaim marker no one else removes the task lock, its dead or
        // crashed owner cannot release it, and an existing lock cannot be replaced (wx), so a lock that still reads
        // stale here is the same file we judged and unlinking it removes no live holder's lock. A different owner
        // means the lock changed hands since we read it: fail closed and touch nothing.
        let marked = false;
        try { writeFileSync(reclaim, String(process.pid), { flag: 'wx', mode: 0o600 }); marked = true; }
        catch (markError) {
          if (markError.code !== 'EEXIST') throw markError;
          // A reclaim takes microseconds; a marker over 10 s old whose writer is gone is left by a crash.
          const marker = lockOwner(reclaim);
          if (marker && marker.age > 10000 && (marker.owner === '' || !processAlive(Number(marker.owner)))) {
            try { unlinkSync(reclaim); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
          }
        }
        if (marked) {
          try {
            const now = lockOwner(lock);
            if (now && (!now.stale || now.owner !== seen.owner)) throw Error('task lock contention; another process took the lock during reclaim');
            if (now) unlinkSync(lock);
          } finally { releaseOwn(reclaim); }
          continue;
        }
      }
      if (Date.now() >= deadline) throw Error('task lock busy; do not remove ownership-uncertain lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  let temporary;
  try {
    const old = readTask(taskPath), task = structuredClone(old);
    const result = mutator(task);
    if (result?.then) throw Error('task mutation must be synchronous');
    if (identity(old) !== identity(task)) throw Error('immutable task identity changed');
    if (old.cloud) {
      if (!CLOUD_MOVES[old.cloud.status].includes(task.cloud?.status)) {
        throw Error(`cloud lane cannot move from ${old.cloud.status} to ${task.cloud?.status ?? 'no record'}`);
      }
      // The one launch a no_session lane permits keeps its marker, repo, and route under a new launch time.
      const relaunch = old.cloud.status === 'no_session' && task.cloud.status === 'launching';
      for (const key of ['session_id', 'url', 'branch', 'repo', 'launched_at', 'heartbeat_id', 'route']) {
        if (key === 'heartbeat_id' && old.cloud.heartbeat_id === null) continue; // bound once, after the launch record
        if (['session_id', 'url'].includes(key) && ['launching', 'uncertain'].includes(old.cloud.status) && old.cloud[key] === null) continue;
        if (key === 'launched_at' && relaunch) continue;
        if (JSON.stringify(old.cloud[key]) !== JSON.stringify(task.cloud[key])) throw Error(`immutable cloud ${key} changed`);
      }
      if ((task.cloud.attempt ?? 1) !== (old.cloud.attempt ?? 1) + (relaunch ? 1 : 0)) throw Error('cloud launch attempt changed');
      if (old.cloud.fallback && JSON.stringify(old.cloud.fallback) !== JSON.stringify(task.cloud.fallback)) {
        throw Error('immutable cloud fallback changed');
      }
    }
    for (const [lane, entry] of Object.entries(old.routes ?? {})) {
      if (JSON.stringify(entry) !== JSON.stringify(task.routes?.[lane])) throw Error(`immutable Worker route for lane ${lane} changed`);
    }
    if (old.planner?.fallback_authorization &&
        JSON.stringify(old.planner.fallback_authorization) !== JSON.stringify(task.planner?.fallback_authorization)) {
      throw Error('immutable planner fallback authorization changed');
    }
    validate(task, taskPath);
    temporary = join(dirname(taskPath), `.task-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(task, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, taskPath);
    return task;
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    // Release only our own lock; a lock holding another pid belongs to someone else.
    releaseOwn(lock);
  }
}

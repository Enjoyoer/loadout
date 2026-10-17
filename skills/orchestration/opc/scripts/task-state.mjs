import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRecordedWorkerRoute } from './agent-routing.mjs';

// Recorded routes and planner rounds are checked for shape only; the routing tables apply once, when they are recorded.
const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const identity = task => JSON.stringify([
  task.schema, task.id, task.owner, task.repository, task.contract_version, task.delivery, task.browser_review, task.ui ?? false,
]);

const SCRIPT = fileURLToPath(import.meta.url);

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

// Whether pid is still the process recorded with start: 'same'; 'gone' when no process has that pid; 'reused' when
// the pid names a process with a different start; 'unknown' when it is alive but either start time is missing or
// unreadable.
export function processIdentity(pid, start) {
  if (!processAlive(pid)) return 'gone';
  const now = typeof start === 'string' && START_FORMAT.test(start) ? processStartTime(pid) : null;
  return now === null ? 'unknown' : now === start ? 'same' : 'reused';
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
  if (!object(planner) || !Array.isArray(planner.rounds) || planner.rounds.length > 1) throw Error('invalid planner record');
  const ids = new Set(), agents = new Set();
  for (const [index, round] of planner.rounds.entries()) {
    if (!object(round) || !uuid(round.id) ||
        !(catalogRound(round, 'Sol', 'planner') && round.provider.startsWith('pi/')) ||
        !['launching', 'running', 'uncertain', 'failed', 'planned'].includes(round.status)) {
      throw Error('invalid planner round');
    }
    if (ids.has(round.id)) throw Error('duplicate planner round identity');
    ids.add(round.id);
    if (index !== 0 || round.effort !== 'xhigh') throw Error('invalid Sol planner route');
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
  // task.cloud is a lane record from OPC 7.40 and earlier. Nothing reads or checks it; an update carries it unchanged.
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

// ui marks UI work: only read-only ui-design and ui-check lanes on Fable high, never a GPT or web lane (owner rule). It is immutable like browserReview.
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
  };
  if (!task.repository.branch) throw Error('detached worktree cannot own a task');
  const taskPath = join(runDirectory, 'task.json');
  validate(task, taskPath);
  assertRepository(task);
  writeFileSync(taskPath, JSON.stringify(task, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { taskPath, task };
}

// A lock file holds its writer's pid, that process's start time when it could be read (else an empty line), and a
// token unique to the acquisition. It is published whole (publish below), so a live writer's lock is never empty.
// Nothing removes another writer's lock implicitly: a writer that finds one waits, then fails naming its holder, and
// only unlockTask removes a lock whose holder is confirmed gone.
const lockLines = text => text.trim().split(/\r?\n/).map(line => line.trim());

// The lock's text and its holder: pid, start time, and whether that process is the same one (processIdentity), or
// 'no recorded pid'. null when there is no lock.
function lockHolder(lock) {
  let content;
  try { content = readFileSync(lock, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  const [pid = '', start = ''] = lockLines(content);
  return { content, pid, start, state: /^\d+$/.test(pid) ? processIdentity(Number(pid), start) : 'no recorded pid' };
}
const holderText = ({ pid, start, state }) =>
  `pid ${pid || 'none'}${start ? ` started ${start}` : ''} (${state === 'same' ? 'running' : state})`;

function lockToken(path) {
  try { return lockLines(readFileSync(path, 'utf8'))[2] ?? null; } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

// Creates path holding content, or fails with EEXIST when path exists, like an exclusive write; but the content is
// written to a private file first and then hard-linked to path, so path never exists empty or partly written. The link
// alone decides: a draft Windows briefly reports busy is left behind rather than failing a lock already taken.
function publish(path, content) {
  const draft = join(dirname(path), `.lock-${randomUUID()}.tmp`);
  writeFileSync(draft, content, { flag: 'wx', mode: 0o600 });
  try { linkSync(draft, path); } finally { try { unlinkSync(draft); } catch { /* inert leftover */ } }
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function releaseOwn(path, token) {
  if (lockToken(path) === token) unlinkSync(path);
}

// Removes the lock a crashed writer left, only when its recorded pid is gone or now names a process with another start
// time. A running or unknown holder, or a lock with no pid, is refused. Nothing calls this implicitly.
export function unlockTask(taskPath) {
  canonicalPath(taskPath);
  const lock = `${taskPath}.lock`, held = lockHolder(lock);
  if (!held) return 'no task lock';
  if (!['gone', 'reused'].includes(held.state)) throw Error(`task lock kept: held by ${holderText(held)}`);
  // Writers never remove another's lock, so only a concurrent unlock could have changed it since it was read.
  if (readFileSync(lock, 'utf8') !== held.content) throw Error('task lock changed while it was checked; nothing removed');
  unlinkSync(lock);
  return `task lock removed: held by ${holderText(held)}`;
}

export function updateTask(taskPath, mutator) {
  canonicalPath(taskPath);
  const lock = `${taskPath}.lock`, token = randomUUID();
  const holder = `${process.pid}\n${ownStartTime() ?? ''}\n${token}`;
  const deadline = Date.now() + 2000;
  while (true) {
    try { publish(lock, holder); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (Date.now() >= deadline) {
      const held = lockHolder(lock);
      if (held) throw Error(`task lock busy: held by ${holderText(held)}; if that writer is no longer running, ` +
        `run node ${SCRIPT} unlock ${taskPath}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  let temporary;
  try {
    const old = readTask(taskPath), task = structuredClone(old);
    const result = mutator(task);
    if (result?.then) throw Error('task mutation must be synchronous');
    if (identity(old) !== identity(task)) throw Error('immutable task identity changed');
    for (const [lane, entry] of Object.entries(old.routes ?? {})) {
      if (JSON.stringify(entry) !== JSON.stringify(task.routes?.[lane])) throw Error(`immutable Worker route for lane ${lane} changed`);
    }
    validate(task, taskPath);
    temporary = join(dirname(taskPath), `.task-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(task, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    if (lockToken(lock) !== token) throw Error('task lock lost; it no longer holds this writer\'s token');
    renameSync(temporary, taskPath);
    // POSIX syncs the file and then the directory entry the rename wrote, so an update it returned survives an OS crash or power loss. Node cannot sync a directory on Windows: there an update gets
    // a flushed file and an atomic rename only.
    if (process.platform !== 'win32') syncDirectory(dirname(taskPath));
    return task;
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    // Release only our own lock; a lock holding another token belongs to someone else.
    releaseOwn(lock, token);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, path, ...rest] = process.argv.slice(2);
    if (command !== 'unlock' || !path || rest.length) throw Error('usage: task-state.mjs unlock <task.json>');
    console.log(unlockTask(path));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

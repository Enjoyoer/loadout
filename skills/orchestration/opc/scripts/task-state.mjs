import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const identity = task => JSON.stringify([
  task.schema, task.id, task.owner, task.repository, task.contract_version, task.delivery, task.browser_review,
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

export function within(child, parent) {
  const path = relative(parent, child);
  return !path || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}

function validateWorker(worker, task) {
  if (worker == null) return;
  if (typeof worker !== 'object' || worker.run_id !== task.id || worker.owner !== task.owner ||
      !['running', 'finished', 'blocked'].includes(worker.status) || !Array.isArray(worker.turns) ||
      worker.route_source !== 'owner-explicit' || typeof worker.model !== 'string' || !worker.model ||
      !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(worker.effort) ||
      typeof worker.fast_mode !== 'boolean' ||
      (worker.native_authorization != null && worker.native_authorization !== 'owner-explicit')) {
    throw Error('invalid Worker record');
  }
  if (worker.status === 'finished' && !worker.thread_id) throw Error('finished Worker lacks thread identity');
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
        !(catalogRound(round, index === 0 ? 'Web Pro' : 'Fable', index === 0 ? 'planner' : 'planner_fallback') ||
          (round.role === undefined && ['codex/chatgpt-web/pro', 'claude/claude-fable-5-1[1m]'].includes(round.provider))) ||
        !['launching', 'running', 'uncertain', 'failed', 'planned'].includes(round.status)) {
      throw Error('invalid planner round');
    }
    if (ids.has(round.id)) throw Error('duplicate planner round identity');
    ids.add(round.id);
    if (round.role === 'planner' || round.provider === 'codex/chatgpt-web/pro') {
      if (index !== 0 || Object.hasOwn(round, 'effort')) throw Error('invalid Pro planner route');
    } else if (index !== 1 || round.effort !== 'high' ||
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

// One cloud lane per task; the heartbeat, not the PM, moves it out of running.
function validateCloud(cloud) {
  if (cloud == null) return;
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(cloud) || !['running', 'ready', 'dead'].includes(cloud.status) ||
      !['session_id', 'url', 'branch', 'repo', 'launched_at', 'heartbeat_id'].every(key => text(cloud[key])) ||
      !/^opc\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cloud.branch) ||
      !object(cloud.route) || cloud.route.model !== 'claude-opus-5-5[1m]' || cloud.route.effort !== 'xhigh') {
    throw Error('invalid cloud lane record');
  }
  if ((cloud.status === 'running') !== (cloud.reason == null)) throw Error('cloud lane reason must accompany a terminal state');
  if (cloud.fallback != null && (cloud.status !== 'dead' || !object(cloud.fallback) ||
      cloud.fallback.authorized_by !== 'cloud-toggle')) {
    throw Error('cloud fallback requires a dead cloud lane and the cloud toggle');
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
  if (!['ready', 'cancelled'].includes(task.status)) throw Error('invalid task status');
  validateWorker(task.worker, task);
  validatePlanner(task.planner);
  validateReviewer(task.reviewer, task);
  validateCloud(task.cloud);
  return task;
}

export function assertRepository(task) {
  const repository = task.repository;
  const cwd = repository.working_directory;
  canonicalPath(cwd);
  if (resolve(git(cwd, 'rev-parse', '--show-toplevel')) !== cwd ||
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

export function createTask({ workingDirectory, runDirectory, owner, baseRef = 'HEAD', delivery = 'local', browserReview = false }) {
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
    schema: 'opc_task_v2', id: randomUUID(), owner, delivery, browser_review: browserReview,
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
    worker: null,
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

export function updateTask(taskPath, mutator) {
  canonicalPath(taskPath);
  const lock = `${taskPath}.lock`;
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
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
    if (old.worker) {
      for (const key of ['run_id', 'owner', 'model', 'effort', 'fast_mode', 'route_source', 'native_authorization', 'thread_id']) {
        if (old.worker[key] != null && JSON.stringify(old.worker[key]) !== JSON.stringify(task.worker?.[key])) {
          throw Error(`immutable Worker ${key} changed`);
        }
      }
    }
    if (old.cloud) {
      for (const key of ['session_id', 'url', 'branch', 'repo', 'launched_at', 'heartbeat_id', 'route']) {
        if (JSON.stringify(old.cloud[key]) !== JSON.stringify(task.cloud?.[key])) throw Error(`immutable cloud ${key} changed`);
      }
      if (old.cloud.status !== 'running' && task.cloud.status !== old.cloud.status) throw Error('terminal cloud lane cannot change state');
      if (old.cloud.fallback && JSON.stringify(old.cloud.fallback) !== JSON.stringify(task.cloud.fallback)) {
        throw Error('immutable cloud fallback changed');
      }
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
    if (existsSync(lock)) unlinkSync(lock);
  }
}

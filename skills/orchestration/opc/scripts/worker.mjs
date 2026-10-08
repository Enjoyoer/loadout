#!/usr/bin/env node
// One task, one native Codex thread. The host owns permissions and CODEX_HOME.
// Workers run on Pi; this native launcher needs the owner's recorded authorization for the task.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { delimiter } from 'node:path';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDelegatedBrief, isValidModelId, NATIVE_WORKER_AUTHORIZATION, resolveAgentRoute } from './agent-routing.mjs';
import { assertRepository, canonicalPath, gitEnvironment, readTask, updateTask } from './task-state.mjs';

const MAX_PROMPT = 64 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const live = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');

function fail(message) { throw Error(message); }

function requireLauncherContext() {
  if (process.env.OPC_WORKER_CONTEXT === 'worker') fail('Nested OPC Worker invocation is not permitted');
}

function allowed(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      Object.keys(object).some(key => !keys.includes(key))) fail('unsupported Worker request field');
}

function promptBytes(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') ||
      Buffer.byteLength(prompt) > MAX_PROMPT) {
    fail('Worker prompt must be nonempty and at most 64 KiB');
  }
  return prompt;
}

function validateOptions(route) {
  const resolved = resolveAgentRoute('worker', { explicitRoute: route });
  if (!isValidModelId(resolved.model)) fail('invalid Worker model');
  if (resolved.source !== 'owner-explicit') fail('native Worker requires an owner-named route; task defaults run on Pi');
  return { role: 'worker', ...resolved };
}

function executable() {
  const requested = process.env.OPC_CODEX_BIN;
  const candidates = requested
    ? (isAbsolute(requested)
      ? [requested]
      : (process.env.PATH ?? '').split(delimiter).map(path => join(path, requested)))
    : (process.env.PATH ?? '').split(delimiter).map(path => join(path, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  const found = candidates.find(path => {
    try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
  });
  if (!found) fail('native Codex executable unavailable; set OPC_CODEX_BIN to an absolute executable path');
  const path = realpathSync(found);
  if (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe')) {
    fail('Windows Worker requires native codex.exe, not a shell wrapper');
  }
  return path;
}

function toml(value) {
  return JSON.stringify(value);
}

// Native CLI flags are deliberately small. Provider TOML, CODEX_HOME, auth,
// approvals, and permissions remain the user's configured native settings.
export function workerArgs(task, route, threadId = null) {
  const options = validateOptions(route);
  const args = ['exec'];
  if (threadId) args.push('resume', threadId);
  args.push('--json');
  if (!threadId) args.push('--cd', task.repository.working_directory);
  args.push('--model', options.model);
  // These are per-turn user choices, not a provider/config projection.
  args.push('--config', `model_reasoning_effort=${toml(options.effort)}`);
  args.push('--config', `features.fast_mode=${options.fastMode}`);
  args.push('-');
  return args;
}

function workerEnvironment() {
  // Do not reconstruct or copy provider credentials. Native Codex applies its
  // own shell-environment policy; logs redact obvious secret-valued variables.
  return { ...gitEnvironment(), OPC_WORKER_CONTEXT: 'worker' };
}

function secretValues(environment) {
  return Object.entries(environment)
    .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTH|COOKIE|CREDENTIAL)/i.test(key) &&
      typeof value === 'string' && value.length > 2 && !/[\r\n]/.test(value))
    .map(([, value]) => value);
}

function redactor(environment) {
  const values = [...new Set(secretValues(environment))].sort((a, b) => b.length - a.length);
  return text => values.reduce((result, value) => result.split(value).join('[REDACTED]'), text);
}

function logRedactor(environment) {
  const redact = redactor(environment);
  return text => redact(text.replace(/"(?:[^"\\\r\n]|\\[^\r\n])*"/g, token => {
    // Decode JSON string tokens (including keys) before matching secrets.
    // Keep non-JSON diagnostics intact for the ordinary literal redactor.
    try { return JSON.stringify(redact(JSON.parse(token))); }
    catch { return token; }
  }));
}

function streamLog(path, environment) {
  const fd = openSync(path, 'wx', 0o600);
  const redact = logRedactor(environment);
  let pending = '';
  return {
    append(chunk) {
      pending += chunk;
      const cut = pending.lastIndexOf('\n') + 1;
      writeSync(fd, redact(pending.slice(0, cut)));
      pending = pending.slice(cut);
      fsyncSync(fd);
    },
    close() {
      writeSync(fd, redact(pending));
      fsyncSync(fd);
      closeSync(fd);
    },
  };
}

export function eventReader(expectedThread = null) {
  let thread = null;
  let completed = false;
  let failed = false;
  let result = null;
  return {
    line(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { fail('malformed Codex JSON event'); }
      if (!event || typeof event.type !== 'string') fail('missing Codex event type');
      if (event.type === 'thread.started') {
        if (thread || completed || typeof event.thread_id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.thread_id) ||
            (expectedThread && event.thread_id !== expectedThread)) {
          fail('Codex thread identity mismatch');
        }
        thread = event.thread_id;
      } else if (event.type === 'turn.completed') {
        if (!thread || completed || failed) fail('unexpected Codex terminal event');
        completed = true;
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        failed = true;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (!thread || completed || typeof event.item.text !== 'string') fail('unexpected Codex assistant message');
        result = event.item.text;
      }
      return thread;
    },
    finish(exitCode) {
      if (exitCode !== 0 || !thread || !completed || failed || !result?.trim()) {
        fail('Codex turn did not complete');
      }
      return { thread_id: thread, result };
    },
  };
}

function assertTaskIdle(task) {
  if (task.status === 'cancelled') fail('task cancelled');
  if (task.worker?.status === 'running') fail('Worker already running');
  if (task.tests?.status === 'running') fail('tests are running; wait before Worker launch or resume');
  if (task.merge?.status === 'pending') fail('merge outcome is pending; reconcile before Worker launch or resume');
}

// Native Codex owns its tool lifecycle. OPC observes only its actual CLI handle.
export async function stopProcess(child, { timeoutMs = 10_000 } = {}) {
  const scope = { process: 'native-cli', descendants: 'not-inspected-by-opc' };
  if (!child?.pid) return { status: 'not-started', ...scope };
  if (child.exitCode != null || child.signalCode != null) return { status: 'exited', ...scope };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error('positive interrupt timeout required');
  return new Promise(resolveStop => {
    let timer, settled = false;
    const finish = (status, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolveStop({ status, ...scope, ...(reason ? { reason } : {}) });
    };
    const onClose = () => finish('exited');
    child.once('close', onClose);
    timer = setTimeout(() => finish('incomplete', 'native CLI did not exit after interrupt'), timeoutMs);
    try { child.kill('SIGINT'); }
    catch (error) { finish('incomplete', `native CLI interrupt failed: ${error.code ?? 'unknown'}`); }
  });
}

function staleWorker(taskPath) {
  const task = readTask(taskPath);
  if (task.worker?.status === 'running' && !live.has(taskPath)) {
    fail('Worker is still marked running; inspect its process before resuming');
  }
  return task;
}

async function runWorker(taskPath, request, resume) {
  requireLauncherContext();
  allowed(request, resume ? ['prompt'] : ['prompt', 'route', 'nativeAuthorization']);
  const requestedPrompt = promptBytes(request.prompt);
  const task = staleWorker(taskPath);
  assertRepository(task);
  assertTaskIdle(task);
  if ((resume ? task.worker?.native_authorization : request.nativeAuthorization) !== NATIVE_WORKER_AUTHORIZATION) {
    fail('Workers run on Pi only; a native Codex Worker needs an explicit owner authorization for this task');
  }
  if (!resume && task.worker) fail('one Worker lineage per task; use resume for the existing thread');
  if (resume && (!task.worker?.thread_id || task.worker.status === 'running')) {
    fail('resume requires an existing harvested Worker thread');
  }
  const options = resume
    ? validateOptions({ role: 'worker', source: task.worker.route_source, model: task.worker.model,
      effort: task.worker.effort, fastMode: task.worker.fast_mode })
    : validateOptions(request.route);
  const prompt = promptBytes(buildDelegatedBrief({ role: 'worker', route: options, brief: requestedPrompt }));
  const binary = executable();
  const thread = resume ? task.worker.thread_id : null;
  const turnId = randomUUID();
  const runDirectory = dirname(taskPath);
  const stdoutPath = join(runDirectory, `worker-${turnId}.stdout.log`);
  const stderrPath = join(runDirectory, `worker-${turnId}.stderr.log`);
  const environment = workerEnvironment();
  const redact = redactor(environment);
  const redactLog = logRedactor(environment);
  let stdoutLog;
  let stderrLog;
  let child;
  let problem = null;
  let outcome = null;
  let exit = null;
  let claimed = false;
  let stopping = false;
  let pending = '';
  let stdout = '';
  let stderr = '';
  let total = 0;
  let stopPromise = null;
  let cleanup = null;
  let poll;
  let captured = thread;
  const events = eventReader(thread);

  try {
    updateTask(taskPath, current => {
      assertTaskIdle(current);
      if (current.status === 'cancelled' || (!resume && current.worker) ||
          (resume && current.worker?.thread_id !== task.worker.thread_id)) {
        fail('Worker ownership changed before launch');
      }
      if (!resume) {
        current.worker = {
          run_id: current.id,
          owner: current.owner,
          status: 'running',
          thread_id: null,
          model: options.model,
          effort: options.effort,
          fast_mode: options.fastMode,
          route_source: options.source,
          native_authorization: NATIVE_WORKER_AUTHORIZATION,
          turns: [],
          error: null,
          cancel_requested: false,
          process: null,
        };
      } else {
        current.worker.status = 'running';
        current.worker.error = null;
        current.worker.cancel_requested = false;
        current.worker.process = null;
      }
      current.worker.turns.push({ id: turnId, status: 'running', thread_id: thread,
        stdout_path: stdoutPath, stderr_path: stderrPath });
    });
    claimed = true;
    stdoutLog = streamLog(stdoutPath, environment);
    stderrLog = streamLog(stderrPath, environment);
    const args = workerArgs(task, options, thread);
    child = spawn(binary, args, {
      cwd: task.repository.working_directory,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    live.set(taskPath, { child, stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = stopProcess(child).then(result => { cleanup = result; return result; });
      return stopPromise;
    } });
    updateTask(taskPath, current => { current.worker.process = { pid: child.pid }; });
    poll = setInterval(() => {
      try {
        const current = readTask(taskPath);
        if (current.status === 'cancelled' || current.worker?.cancel_requested) {
          problem ??= Error('Worker cancelled');
          void live.get(taskPath)?.stop();
        }
      } catch (error) {
        problem ??= error;
        void live.get(taskPath)?.stop();
      }
    }, 100);
    child.once('error', error => { problem ??= Error(`native Codex spawn failed: ${error.message}`); });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      let index;
      try {
        total += Buffer.byteLength(chunk);
        stdout += chunk;
        stdoutLog.append(chunk);
        if (total > MAX_OUTPUT) {
          problem ??= Error('Worker output limit exceeded');
          void live.get(taskPath)?.stop();
          return;
        }
        while ((index = pending.indexOf('\n')) >= 0) {
          const startedThread = events.line(pending.slice(0, index));
          if (startedThread && !captured) {
            captured = startedThread;
            updateTask(taskPath, current => { current.worker.thread_id = startedThread; });
          }
          pending = pending.slice(index + 1);
        }
      } catch (error) {
        problem ??= error;
        void live.get(taskPath)?.stop();
      }
    });
    child.stderr.on('data', chunk => {
      try {
        total += Buffer.byteLength(chunk);
        stderr += chunk;
        stderrLog.append(chunk);
        if (total > MAX_OUTPUT) {
          problem ??= Error('Worker output limit exceeded');
          void live.get(taskPath)?.stop();
        }
      } catch (error) {
        problem ??= error;
        void live.get(taskPath)?.stop();
      }
    });
    const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
    child.stdin.on('error', error => { problem ??= Error(`Worker stdin failed: ${error.code}`); });
    child.stdin.end(prompt);
    exit = await closed;
    if (pending.trim()) {
      const startedThread = events.line(pending);
      if (startedThread && !captured) {
        captured = startedThread;
        updateTask(taskPath, current => { current.worker.thread_id = startedThread; });
      }
    }
    if (problem) throw problem;
    outcome = events.finish(exit.code);
  } catch (error) {
    problem = error;
  } finally {
    clearInterval(poll);
    try {assertRepository(readTask(taskPath));}catch(error){problem??=error;}
    live.delete(taskPath);
    if (child && !stopping) {
      stopping = true;
      try { cleanup = await (stopPromise ?? stopProcess(child)); }
      catch (error) { problem ??= error; }
    }
    if (cleanup?.status !== 'exited' && !problem) problem = Error('process cleanup incomplete');
    stdoutLog?.close();
    stderrLog?.close();
    if (claimed) {
      try {
        updateTask(taskPath, current => {
          const worker = current.worker;
          const turn = worker?.turns.at(-1);
          if (!worker || !turn || turn.id !== turnId) fail('Worker turn ownership changed');
          const cancelled = current.status === 'cancelled' || worker.cancel_requested;
          const successful = !problem && !cancelled && exit?.code === 0 && outcome && cleanup?.status === 'exited';
          worker.status = successful ? 'finished' : 'blocked';
          worker.error = problem?.message ?? (cancelled ? 'Worker cancelled' : successful ? null : 'Worker turn failed');
          worker.process = null;
          if (outcome) worker.result = redact(outcome.result);
          Object.assign(turn, {
            status: worker.status,
            thread_id: outcome?.thread_id ?? captured,
            exit_code: exit?.code ?? null,
            signal: exit?.signal ?? null,
            stdout_sha256: sha(redactLog(stdout)),
            stderr_sha256: sha(redactLog(stderr)),
            cleanup: cleanup ?? { status: 'incomplete' },
          });
          if (!worker.thread_id && outcome?.thread_id) worker.thread_id = outcome.thread_id;
        });
      } catch (error) {
        problem ??= error;
      }
    }
  }
  if (!claimed) throw problem;
  return readTask(taskPath).worker;
}

export const launchWorker = (taskPath, request) => runWorker(taskPath, request, false);
export const resumeWorker = (taskPath, request) => runWorker(taskPath, request, true);

export async function cancelWorker(taskPath) {
  requireLauncherContext();
  const task = updateTask(taskPath, current => {
    if (current.status === 'cancelled') return;
    current.status = 'cancelled';
    if (current.worker) current.worker.cancel_requested = true;
  });
  const owned = live.get(taskPath);
  const cleanup = owned ? await owned.stop() : null;
  const current = readTask(taskPath);
  return {
    status: current.worker?.status === 'running' ? 'cancellation_requested' : 'cancelled',
    task_id: task.id,
    cleanup: cleanup ?? current.worker?.turns.at(-1)?.cleanup ?? null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...argv] = process.argv.slice(2);
    const flags = {};
    for (let index = 0; index < argv.length; index += 2) {
      if (!['--task', '--prompt-file', '--model', '--effort', '--fast', '--native-authorization'].includes(argv[index]) ||
          !argv[index + 1] || argv[index] in flags) fail('invalid Worker CLI option');
      flags[argv[index]] = argv[index + 1];
    }
    const taskPath = flags['--task'];
    if (!taskPath) fail('--task required');
    let result;
    if (mode === 'cancel') {
      if (Object.keys(flags).length !== 1) fail('cancel accepts only --task');
      result = await cancelWorker(taskPath);
    } else {
      if (!['launch', 'resume'].includes(mode) || !flags['--prompt-file']) {
        fail('usage: worker.mjs launch --task PATH --prompt-file PATH --model MODEL --effort EFFORT --fast on|off --native-authorization owner-explicit; worker.mjs resume --task PATH --prompt-file PATH; or cancel --task PATH');
      }
      const promptFile = canonicalPath(flags['--prompt-file']);
      const task = readTask(taskPath);
      if (promptFile.startsWith(task.repository.working_directory + '/') ||
          statSync(promptFile).size > MAX_PROMPT) fail('prompt must be a bounded file outside the worktree');
      const request = { prompt: readFileSync(promptFile, 'utf8') };
      if (mode === 'launch') {
        if (!flags['--model'] || !flags['--effort'] || !flags['--fast']) {
          fail('launch requires the recorded explicit owner route: --model, --effort, and --fast');
        }
        if (!['on', 'off'].includes(flags['--fast'])) fail('--fast must be on or off');
        request.route = { role: 'worker', source: 'owner-explicit', model: flags['--model'],
          effort: flags['--effort'], fastMode: flags['--fast'] === 'on' };
        request.nativeAuthorization = flags['--native-authorization'];
      } else if (flags['--model'] || flags['--effort'] || flags['--fast'] || flags['--native-authorization']) {
        fail('resume uses the locked Worker route and authorization and accepts no route flags');
      }
      result = await (mode === 'launch' ? launchWorker : resumeWorker)(taskPath, request);
    }
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

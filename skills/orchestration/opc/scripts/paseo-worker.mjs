import {
  assertLiveResolution, CURSOR_OVERFLOW_LABEL, CURSOR_OVERFLOW_SOURCE, DEVIN_FIRST_SOURCE, isGptOrWebRoute, OFF_PACE_SOURCES, OPN_BROWSER_EXCEPTION,
  replacementSettings, resolveOpnBrowserRow, resolveWorkerSurface,
} from './agent-routing.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readTask, recordWorkerLaunch } from './task-state.mjs';

const lanePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idPattern = /^[A-Za-z0-9-]{8,128}$/;

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${name} required`);
  return value.trim();
}

function adapter(value, name) {
  if (typeof value !== 'function') throw Error(`${name} adapter required`);
  return value;
}

// Labels the builder derives from the validated route: the Pi Fast toggle tier, its legacy form, and the route source.
// Caller labels are descriptive only, so a reused label set can never turn Fast on for a Fast-off route.
const ROUTE_LABELS = Object.freeze(['opc.service-tier', 'opc.fast-requested', 'opc.route-source']);

function labels(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.values(value).some(item => typeof item !== 'string')) {
    throw Error('Worker labels must be string values');
  }
  const reserved = ROUTE_LABELS.find(key => Object.hasOwn(value, key));
  if (reserved) throw Error(`Worker labels cannot set ${reserved}; the Worker's validated route decides it`);
  return { ...value };
}

function settings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['thinkingOptionId', 'features'].includes(key)) ||
      (value.thinkingOptionId != null && (typeof value.thinkingOptionId !== 'string' || !value.thinkingOptionId)) ||
      (value.features != null && (typeof value.features !== 'object' || Array.isArray(value.features) ||
        Object.keys(value.features).some(key => key !== 'fast_mode') ||
        Object.values(value.features).some(item => typeof item !== 'boolean')))) {
    throw Error('Worker settings may contain only thinkingOptionId and boolean fast_mode');
  }
  return structuredClone(value);
}
// A replacement launch's settings are exactly its fixed ones (agent-routing.mjs replacementSettings), nothing added.
function replacementRequestSettings(value) {
  if (!isDeepStrictEqual(value, replacementSettings())) throw Error('replacement Worker settings must be exactly its fixed settings');
  return structuredClone(value);
}

export function managedWorkerNames({ taskId, lane }) {
  const id = required(taskId, 'task id');
  const laneSlug = required(lane, 'Worker lane');
  if (!idPattern.test(id)) throw Error('task id must provide a stable unique token');
  if (!lanePattern.test(laneSlug) || laneSlug.length > 40) {
    throw Error('Worker lane must be a lowercase hyphenated slug');
  }
  if (id.replaceAll('-', '').length < 8) throw Error('task id must provide a stable unique token');
  const unique = createHash('sha256').update(id).digest('hex').slice(0, 16);
  const stem = `${laneSlug}-${unique}`;
  return Object.freeze({ branchName: `opc/${stem}`, worktreeSlug: `opc-${stem}` });
}

export function selectUnattendedMode(capabilities) {
  if (!capabilities || capabilities.enabled !== true || capabilities.status !== 'available' ||
      !Array.isArray(capabilities.modes)) {
    throw Error('available Paseo provider capabilities required');
  }
  const unattended = capabilities.modes.filter(mode => mode?.isUnattended === true &&
    typeof mode.id === 'string' && mode.id);
  if (unattended.length !== 1) {
    throw Error('provider must advertise exactly one unattended full-permission mode');
  }
  return unattended[0].id;
}

export function selectPiMode(capabilities) {
  if (capabilities?.enabled !== true || capabilities.status !== 'available' ||
      !Array.isArray(capabilities.modes) || capabilities.modes.length !== 0) {
    throw Error('available Pi with no selectable modes required');
  }
  return null;
}

function managedPrompt(initialPrompt, { workspaceId, worktreePath, branchName }) {
  const prompt = required(initialPrompt, 'initial prompt');
  return `${prompt}\n\nManaged Worker placement:\n` +
    `- Workspace ID: ${workspaceId}\n- Worktree path: ${worktreePath}\n- Branch: ${branchName}\n\n` +
    'Commit only the owned changes in this branch. In the final report include the branch, workspace ID, ' +
    'worktree path, commit SHA(s), validation results, remaining issues, and exact integration instructions for the coordinator.';
}

export function buildManagedWorkspaceRequest({ taskId, lane, sourcePath, baseBranch, title }) {
  const names = managedWorkerNames({ taskId, lane });
  const source = required(sourcePath, 'source checkout path');
  const base = required(baseBranch, 'committed base ref');
  const agentTitle = required(title, 'Worker title');
  return Object.freeze({
    ...names,
    request: Object.freeze({
      isolation: 'worktree', mode: 'branch-off', path: source, baseBranch: base,
      branchName: names.branchName, worktreeSlug: names.worktreeSlug, title: agentTitle,
    }),
  });
}

// task is the destination task record (readTask) whose id is taskId, and taskClass the lane's intended class; with them
// a recorded lane takes only its recorded route and every route meets the class's owner rules (agent-routing.mjs
// validateLaunchedWorkerRoute). The request always creates a Worker, so it is routed and gated only as one. A replacement
// lane (route source replacement, recorded by route.mjs) also takes target, the launch target {daemon, local, platform},
// whose daemon is the create_workspace result's serverId, and capabilities, MCP inspect_provider's result for the
// replacement provider on it with MCP list_models rows as models. An off-pace lane runs only on its recorded branch.
export function buildManagedWorkerRequest({ taskId, lane, title, provider, initialPrompt,
  agentSettings = {}, workerLabels = {}, workspace, capabilities, role = 'worker', route, surface = 'pi',
  nativeAuthorization = null, task = null, taskClass = null, target = null, remote = null }) {
  if (role !== 'worker') throw Error(`buildManagedWorkerRequest builds only Workers (role worker), not ${String(role)}`);
  // A remote target is only a recorded off-pace lane's (replacement or bound pace-backup), with a fresh attestation
  // readRemoteAgyTarget / readRemoteNeonTarget returned.
  const remoteLaunch = target?.local === false;
  if ((remote != null || remoteLaunch) && !OFF_PACE_SOURCES.includes(route?.source)) {
    throw Error('only a recorded off-pace lane launches on a remote target');
  }
  const names = managedWorkerNames({ taskId, lane });
  const agentTitle = required(title, 'Worker title');
  // Every managed Worker is bound to its task record, so a live route resolved for one task never launches for another.
  if (task == null || typeof task !== 'object') throw Error('a managed Worker launch takes task: readTask(taskPath), whose id is taskId');
  if (task.id !== taskId) throw Error('Worker task id must be the bound task record id');
  const mappedRoute = resolveWorkerSurface({ provider, agentSettings, role, route, surface, nativeAuthorization,
    catalog: capabilities?.models, task, lane, taskClass, capabilities, target, serverId: workspace?.serverId, remote, workspace });
  const replacement = route?.source === 'replacement';
  const cursorOverflow = route?.source === CURSOR_OVERFLOW_SOURCE;
  if ((OFF_PACE_SOURCES.includes(route?.source) || route?.source === DEVIN_FIRST_SOURCE) &&
      route.receipt?.placement !== names.branchName) {
    throw Error(`${route.source} receipt placement is not this lane's branch`);
  }
  const agentProvider = mappedRoute.provider;
  const requestedSettings = replacement ? replacementRequestSettings(mappedRoute.agentSettings) : settings(mappedRoute.agentSettings);
  if (!workspace?.workspaceId || typeof workspace.workspaceId !== 'string' ||
      !workspace.cwd || typeof workspace.cwd !== 'string') {
    throw Error('Paseo create_workspace returned no managed workspace identity');
  }
  // Pi exposes no modes and executes its tools without a permission-mode selector.
  // This exception applies only to advertised, available Pi, never other providers.
  const effectiveCapabilities = mappedRoute.capabilities ?? capabilities;
  const pi = agentProvider.split('/')[0] === 'pi';
  const modeId = replacement || cursorOverflow ? mappedRoute.modeId : pi ? selectPiMode(effectiveCapabilities) : selectUnattendedMode(effectiveCapabilities);
  const prompt = managedPrompt(initialPrompt, { workspaceId: workspace.workspaceId, worktreePath: workspace.cwd, branchName: names.branchName });
  return Object.freeze({
    workspaceId: workspace.workspaceId,
    worktreePath: workspace.cwd,
    branchName: names.branchName,
    worktreeSlug: names.worktreeSlug,
    modeId,
    request: Object.freeze({
      title: agentTitle,
      provider: agentProvider,
      workspaceId: workspace.workspaceId,
      initialPrompt: prompt,
      notifyOnFinish: true,
      // MCP create_agent on exactly the verified remote server; a local launch names none.
      ...(remoteLaunch ? { serverId: remote.serverId } : {}),
      settings: { ...requestedSettings, ...(modeId ? { modeId } : {}) },
      // Fast is the Pi Fast toggle label. A GPT route with no label runs Standard (Fast is off by default), and Off
      // on a GPT route is still an explicit Standard; other routes have no service tier and get no label.
      labels: { ...labels(workerLabels), ...(cursorOverflow ? { lane: CURSOR_OVERFLOW_LABEL } : {}), role: 'worker',
        'opc.worker-task': taskId, 'opc.worker-lane': lane,
        ...(pi && route?.fastMode === true ? { 'opc.service-tier': 'fast' }
          : pi && isGptOrWebRoute(route, effectiveCapabilities?.models) ? { 'opc.service-tier': 'standard' } : {}),
        ...(role === 'worker' && typeof route?.source === 'string' ? { 'opc.route-source': route.source } : {}) },
    }),
  });
}

// Launch-boundary builder for in-place PM-workspace Workers (OPN non-managed workers and read-only lanes, including
// opn-browser): enforces a fresh live route from resolveWorkerRoute bound to exact lane, class, target, and current
// live policy/daemon state. Rejects pasted/remembered routes, stale local runtime, and routes requiring managed placement.
export function buildInPlaceWorkerRequest({ title, initialPrompt, route, taskClass, capabilities, lane,
  workerLabels = {}, target = null, provider, agentSettings = {}, surface = 'pi', nativeAuthorization = null, ...extra }) {
  const agentTitle = required(title, 'Worker title');
  const prompt = required(initialPrompt, 'initial prompt');
  const laneSlug = required(lane, 'Worker lane');
  if (!lanePattern.test(laneSlug) || laneSlug.length > 40) throw Error('Worker lane must be a lowercase hyphenated slug');
  if (target?.local === false) throw Error('in-place Worker launches stay in the local PM workspace');
  // An in-place Worker runs its validated route's own mapping: no caller surface or native authorization moves it off Pi.
  if (surface !== 'pi' || nativeAuthorization != null) {
    throw Error('an in-place Worker takes no surface or nativeAuthorization; it runs its validated route\'s own mapping');
  }
  if (OFF_PACE_SOURCES.includes(route?.source) || route?.source === DEVIN_FIRST_SOURCE) {
    throw Error(`a ${route.source} route requires managed worktree placement (buildManagedWorkerRequest)`);
  }
  assertLiveResolution(route, { lane: laneSlug, taskClass, target, inPlace: true });
  if (taskClass === 'opn-browser') {
    // Owner decision 412a: native Codex gpt-6.2-sol, thinking low, Fast on, in the PM's own workspace (no workspaceId, so
    // create_agent starts it beside the PM and its Paseo browser). capabilities is native Codex inspect_provider's result
    // with list_models rows as models. No caller provider, settings, or placement changes it.
    const unknown = Object.keys(extra);
    if (unknown.length) throw Error(`an opn-browser Worker takes no ${unknown.join(', ')}; it runs in the PM's own workspace`);
    const { provider: codex, model, effort, fastMode } = OPN_BROWSER_EXCEPTION;
    if (route.source !== 'owner-explicit' || route.model !== model || route.effort !== effort || route.fastMode !== fastMode) {
      throw Error(`opn-browser route is not the validated native Codex ${model} ${effort}, Fast on route`);
    }
    resolveOpnBrowserRow(capabilities?.models);
    const mapped = `${codex}/${model}`, requested = { thinkingOptionId: effort, features: { fast_mode: fastMode } };
    if (provider != null && provider !== mapped) {
      throw Error(`explicit provider ${provider} is not what this lane's validated route maps to (${mapped})`);
    }
    if (Object.keys(agentSettings ?? {}).length && !isDeepStrictEqual(agentSettings, requested)) {
      throw Error(`opn-browser settings must be exactly ${effort} thinking with Fast on; no caller override changes them`);
    }
    const modeId = selectUnattendedMode(capabilities);
    return Object.freeze({
      modeId,
      request: Object.freeze({
        title: agentTitle,
        provider: mapped,
        initialPrompt: prompt,
        notifyOnFinish: true,
        settings: { ...requested, modeId },
        labels: { ...labels(workerLabels), role: 'worker', 'opc.worker-lane': laneSlug, 'opc.route-source': 'opn-browser' },
      }),
    });
  }
  const mappedRoute = resolveWorkerSurface({ provider, agentSettings, role: 'worker', route, surface, nativeAuthorization,
    catalog: capabilities?.models, lane: laneSlug, taskClass, capabilities, target, inPlace: true });
  const agentProvider = mappedRoute.provider;
  const requestedSettings = settings(mappedRoute.agentSettings);
  const pi = agentProvider.split('/')[0] === 'pi';
  const modeId = pi ? selectPiMode(capabilities) : selectUnattendedMode(capabilities);
  return Object.freeze({
    modeId,
    request: Object.freeze({
      title: agentTitle,
      provider: agentProvider,
      initialPrompt: prompt,
      notifyOnFinish: true,
      settings: { ...requestedSettings, ...(modeId ? { modeId } : {}) },
      labels: { ...labels(workerLabels), role: 'worker', 'opc.worker-lane': laneSlug,
        ...(pi && route?.fastMode === true ? { 'opc.service-tier': 'fast' }
          : pi && isGptOrWebRoute(route, capabilities?.models) ? { 'opc.service-tier': 'standard' } : {}),
        ...(typeof route?.source === 'string' ? { 'opc.route-source': route.source } : {}) },
    }),
  });
}

// With taskPath (the documented launch workflow), an agy-opc replacement lane's created Worker agent and workspace ids are
// recorded on that lane for the error backstop (agy-holds.mjs record-terminal); other lanes record nothing.
export function validateManagedWorkerLaunch(prepared, created, taskPath = undefined) {
  if (!prepared?.workspaceId || !prepared?.request || prepared.request.notifyOnFinish !== true) {
    throw Error('prepared MCP create_agent request required');
  }
  if (!created?.agentId || typeof created.agentId !== 'string') {
    throw Error('Paseo create_agent returned no Worker identity; retain the workspace for reconciliation');
  }
  if (created.workspaceId != null && created.workspaceId !== prepared.workspaceId) {
    throw Error('Paseo created the Worker in the wrong workspace; retain both for reconciliation');
  }
  if (prepared.request.serverId != null && created.serverId !== prepared.request.serverId) {
    throw Error('Paseo did not report the Worker on the verified remote server; retain both for reconciliation');
  }
  if (taskPath !== undefined) {
    const lane = prepared.request.labels?.['opc.worker-lane'], task = readTask(taskPath);
    if (task.id !== prepared.request.labels?.['opc.worker-task']) throw Error('the prepared Worker is not this task\'s');
    if (typeof lane === 'string' && task.routes && Object.hasOwn(task.routes, lane) && task.routes[lane].route?.source === 'replacement') {
      recordWorkerLaunch(taskPath, { lane, agentId: created.agentId, workspaceId: prepared.workspaceId });
    }
  }
  return Object.freeze({
    agentId: created.agentId,
    workspaceId: prepared.workspaceId,
    worktreePath: prepared.worktreePath,
    branchName: prepared.branchName,
    worktreeSlug: prepared.worktreeSlug,
    modeId: prepared.modeId,
  });
}

// The arguments a follow-up may send, read from send_agent_prompt's advertised input schema (MCP tools/list
// inputSchema). Paseo 0.11 lists background (async for agent callers); 0.13 removed it and queues every agent send.
// A strict schema refuses unknown arguments (the Pi MCP bridge does), so background goes only where it is advertised.
function followupArguments(inputSchema) {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw Error('advertised send_agent_prompt inputSchema required: its tools/list inputSchema, ' +
      'or {properties} keyed by the argument names its declaration lists');
  }
  const missing = ['agentId', 'prompt', 'notifyOnFinish'].find(name => !Object.hasOwn(properties, name));
  if (missing) throw Error(`send_agent_prompt advertises no ${missing}; a notified follow-up cannot be sent`);
  const background = Object.hasOwn(properties, 'background');
  const supplied = ['agentId', 'prompt', 'notifyOnFinish', ...(background ? ['background'] : [])];
  const requiredNames = inputSchema.required ?? [];
  if (!Array.isArray(requiredNames)) throw Error('send_agent_prompt inputSchema required must be a list');
  const unsupplied = requiredNames.filter(name => !supplied.includes(name));
  if (unsupplied.length) throw Error(`send_agent_prompt requires unsupported argument(s): ${unsupplied.join(', ')}`);
  return { background };
}

export function buildManagedWorkerFollowupRequest({ agentId, prompt, inputSchema,
  fireAndForget = false, fireAndForgetAuthorization = null }) {
  const id = required(agentId, 'Worker agent id');
  const message = required(prompt, 'Worker follow-up prompt');
  if (typeof fireAndForget !== 'boolean') throw Error('fireAndForget must be boolean');
  if (fireAndForget && fireAndForgetAuthorization !== 'owner-explicit') {
    throw Error('fire-and-forget requires an explicit owner request');
  }
  const { background } = followupArguments(inputSchema);
  return Object.freeze({
    agentId: id,
    prompt: message,
    ...(background ? { background: true } : {}),
    notifyOnFinish: !fireAndForget,
  });
}

// Accepted means Paseo took the follow-up for delivery: 0.13 answers an agent caller with deliveryStatus queued before
// any dispatch, 0.11 once the turn is sent. Neither proves the Worker started or finished; the finish callback does.
export function validateManagedWorkerFollowup(prepared, sent) {
  if (!prepared?.agentId || typeof prepared.notifyOnFinish !== 'boolean') {
    throw Error('prepared MCP send_agent_prompt request required');
  }
  if (sent?.isError === true) throw Error('Paseo send_agent_prompt refused the follow-up');
  const result = sent?.structuredContent ?? sent;
  if (result?.success !== true) throw Error('Paseo send_agent_prompt did not accept the follow-up');
  if (result.deliveryStatus != null && result.deliveryStatus !== 'queued') {
    throw Error(`Paseo send_agent_prompt returned unknown deliveryStatus ${String(result.deliveryStatus)}`);
  }
  return Object.freeze({
    agentId: prepared.agentId,
    delivery: result.deliveryStatus === 'queued' ? 'queued' : 'sent',
    messageId: typeof result.messageId === 'string' ? result.messageId : null,
    notifyOnFinish: prepared.notifyOnFinish,
  });
}

export async function archiveManagedWorkerWorkspace({ workspaceId, disposition, evidence, archiveWorkspace }) {
  const id = required(workspaceId, 'Worker workspace id');
  const reason = required(evidence, 'integration or abandonment evidence');
  adapter(archiveWorkspace, 'Paseo archive_workspace');
  if (!['integrated', 'abandoned'].includes(disposition)) {
    throw Error('workspace disposition must be integrated or abandoned');
  }
  const result = await archiveWorkspace({ workspaceId: id });
  return Object.freeze({ workspaceId: id, disposition, evidence: reason, result });
}

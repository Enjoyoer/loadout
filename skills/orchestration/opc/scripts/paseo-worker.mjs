import { resolveWorkerSurface } from './agent-routing.mjs';
import { createHash } from 'node:crypto';

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

function labels(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.values(value).some(item => typeof item !== 'string')) {
    throw Error('Worker labels must be string values');
  }
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

export function buildManagedWorkerRequest({ taskId, lane, title, provider, initialPrompt,
  agentSettings = {}, workerLabels = {}, workspace, capabilities, role = 'worker', route, surface = 'pi',
  nativeAuthorization = null }) {
  const names = managedWorkerNames({ taskId, lane });
  const agentTitle = required(title, 'Worker title');
  const mappedRoute = resolveWorkerSurface({ provider, agentSettings, role, route, surface, nativeAuthorization,
    catalog: capabilities?.models });
  const agentProvider = mappedRoute.provider;
  const requestedSettings = settings(mappedRoute.agentSettings);
  if (!workspace?.workspaceId || typeof workspace.workspaceId !== 'string' ||
      !workspace.cwd || typeof workspace.cwd !== 'string') {
    throw Error('Paseo create_workspace returned no managed workspace identity');
  }
  // Pi exposes no modes and executes its tools without a permission-mode selector.
  // This exception applies only to advertised, available Pi, never other providers.
  const pi = agentProvider.split('/')[0] === 'pi';
  const modeId = pi ? selectPiMode(capabilities) : selectUnattendedMode(capabilities);
  const prompt = managedPrompt(initialPrompt, {
    workspaceId: workspace.workspaceId, worktreePath: workspace.cwd, branchName: names.branchName,
  });
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
      settings: { ...requestedSettings, ...(modeId ? { modeId } : {}) },
      // Fast is the Pi Fast toggle label; Off leaves it absent, as the toggle shows Off.
      // An explicit Standard label would refuse every turn on a route without service tiers.
      labels: { ...labels(workerLabels), role: 'worker', 'opc.worker-task': taskId, 'opc.worker-lane': lane,
        ...(pi && route?.fastMode === true ? { 'opc.service-tier': 'fast' } : {}),
        ...(role === 'worker' && typeof route?.source === 'string' ? { 'opc.route-source': route.source } : {}) },
    }),
  });
}

export function validateManagedWorkerLaunch(prepared, created) {
  if (!prepared?.workspaceId || !prepared?.request || prepared.request.notifyOnFinish !== true) {
    throw Error('prepared MCP create_agent request required');
  }
  if (!created?.agentId || typeof created.agentId !== 'string') {
    throw Error('Paseo create_agent returned no Worker identity; retain the workspace for reconciliation');
  }
  if (created.workspaceId != null && created.workspaceId !== prepared.workspaceId) {
    throw Error('Paseo created the Worker in the wrong workspace; retain both for reconciliation');
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

export function buildManagedWorkerFollowupRequest({ agentId, prompt,
  fireAndForget = false, fireAndForgetAuthorization = null }) {
  const id = required(agentId, 'Worker agent id');
  const message = required(prompt, 'Worker follow-up prompt');
  if (typeof fireAndForget !== 'boolean') throw Error('fireAndForget must be boolean');
  if (fireAndForget && fireAndForgetAuthorization !== 'owner-explicit') {
    throw Error('fire-and-forget requires an explicit owner request');
  }
  return Object.freeze({
    agentId: id,
    prompt: message,
    background: true,
    notifyOnFinish: !fireAndForget,
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

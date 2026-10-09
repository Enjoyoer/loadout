import { randomUUID } from 'node:crypto';
import { buildDelegatedBrief, FIXED_ROLE_ROUTES, MAX_CHATGPT_BROWSER_TABS, resolveAgentSurface } from './agent-routing.mjs';
import { selectUnattendedMode, selectPiMode } from './paseo-worker.mjs';
import { recoverTests } from './delivery.mjs';
import { assertRepository, readTask, updateTask } from './task-state.mjs';

export { MAX_CHATGPT_BROWSER_TABS };

const terminal = new Set(['failed', 'planned']);
const latest = task => task.planner?.rounds?.at(-1);

function validateContextPack(contextPack) {
  const fields = ['outcome', 'scope', 'constraints', 'exploration', 'ambiguities', 'checks'];
  if (!contextPack || typeof contextPack !== 'object' || Array.isArray(contextPack) ||
      Object.keys(contextPack).some(key => !fields.includes(key))) throw Error('planner context pack has unsupported fields');
  for (const field of fields) {
    if (typeof contextPack[field] !== 'string' || !contextPack[field].trim()) throw Error(`planner context pack requires ${field}`);
  }
  return fields.map(field => `${field}:\n${contextPack[field]}`).join('\n\n');
}

export function buildPlannerPrompt({ contextPack, route }) {
  const body = `${validateContextPack(contextPack)}\n\nReturn one concise, implementable plan covering lane ownership, integration order, required behavior, checks, and material risks. This is a one-shot planning turn. Read only the assigned repository and linked context. Do not edit, implement, publish, review, merge, or steer another agent.`;
  return buildDelegatedBrief({ role: route === FIXED_ROLE_ROUTES.planner_fallback ? 'planner_fallback' : 'planner', route, brief: body });
}

function available(task) {
  assertRepository(task);
  if (task.browser_review) throw Error('reviewer reserves the one OPC web lane; skip the planner');
  if (task.ui) throw Error('UI work never uses the web planner or its fallback (owner rule); the PM plans');
  if (task.status !== 'ready' || task.worker?.status === 'running' || task.tests?.status === 'running' || task.merge) {
    throw Error('task is busy, cancelled, or already delivering');
  }
  const previous = latest(task);
  if (previous && !terminal.has(previous.status)) throw Error('planner lane is active or uncertain');
  if (previous?.status === 'planned') throw Error('planner is one-shot and already completed');
  if ((previous?.role === 'planner_fallback' || previous?.provider?.startsWith('claude/'))) throw Error('planner fallback is terminal; ask the owner how to proceed');
}

export function authorizePlannerFallback(taskPath, { answer }) {
  if (answer !== 'yes') throw Error('planner fallback requires the owner to explicitly answer yes');
  return updateTask(taskPath, task => {
    const failed = latest(task);
    if (!failed || (failed.role !== 'planner' && !failed.provider?.startsWith('codex/')) || failed.status !== 'failed') {
      throw Error('owner approval may be recorded only after the Pro planner failure');
    }
    task.planner.fallback_authorization = { answer: 'yes', after_round: failed.id };
  }).planner.fallback_authorization;
}

// Prepare the exact MCP create_agent request. The PM calls that tool directly,
// then binds its response below. Planner rounds are never steered.
export function preparePlannerLaunch(taskPath, { contextPack, capabilities, surface = 'pi' }) {
  recoverTests(taskPath); // a dead 'running' test is interrupted, not busy
  const task = readTask(taskPath);
  available(task);
  const previous = latest(task);
  const fallback = previous?.status === 'failed';
  const role = fallback ? 'planner_fallback' : 'planner';
  const route = resolveAgentSurface(role, fallback ? { plannerFailure: previous, fallbackAuthorization: task.planner?.fallback_authorization } : {}, capabilities.models, surface);
  const requestedSettings = fallback ? { thinkingOptionId: route.effort } : {};
  const modeId = route.provider.startsWith('pi/') ? selectPiMode(capabilities) : selectUnattendedMode(capabilities);
  const round = {
    id: randomUUID(), role, catalog_label: route.label, catalog_model_id: route.model, provider: route.provider, status: 'launching', agent_id: null,
    ...(fallback ? { effort: route.effort } : {}),
  };
  const initialPrompt = buildPlannerPrompt({ contextPack, route: FIXED_ROLE_ROUTES[role] });
  updateTask(taskPath, current => {
    available(current);
    if (latest(current)?.id !== previous?.id) throw Error('planner round changed during launch');
    current.planner ??= { rounds: [] };
    current.planner.rounds.push(round);
  });
  return Object.freeze({
    round: structuredClone(round),
    request: Object.freeze({
      title: `OPC ${fallback ? 'fallback ' : ''}planner`,
      provider: route.provider,
      initialPrompt,
      notifyOnFinish: true,
      labels: { role: 'worker', 'opc.planner-round': round.id, 'opc.run': task.id },
      settings: { ...requestedSettings, ...(modeId ? { modeId } : {}) },
    }),
  });
}

export function bindPlannerAgent(taskPath, { roundId, result }) {
  if (!result?.agentId || typeof result.agentId !== 'string') throw Error('Paseo launch returned no agent identity');
  return updateTask(taskPath, current => {
    const round = latest(current);
    if (!round || round.id !== roundId || round.status !== 'launching') throw Error('planner round changed during launch');
    if (current.planner.rounds.some(item => item.agent_id === result.agentId)) throw Error('fresh planner agent required');
    Object.assign(round, { agent_id: result.agentId, status: 'running' });
  }).planner.rounds.at(-1);
}

export function recordPlannerLaunchFailure(taskPath, { roundId, error, terminal = false }) {
  const message = error instanceof Error ? error.message : String(error || 'Paseo create_agent failed');
  return updateTask(taskPath, current => {
    const round = latest(current);
    if (!round || round.id !== roundId || round.status !== 'launching') throw Error('planner round changed during launch');
    Object.assign(round, {
      status: terminal ? 'failed' : 'uncertain',
      ...(terminal ? { failure: message } : {}),
    });
  }).planner.rounds.at(-1);
}

export function collectPlanner(taskPath, { agentId, status, plan, reason, labels }) {
  let task = readTask(taskPath), round = latest(task);
  if (round?.status === 'uncertain' && typeof agentId === 'string' && agentId &&
      labels?.['opc.planner-round'] === round.id && labels?.['opc.run'] === task.id &&
      ['finished', 'failed'].includes(status)) {
    task = updateTask(taskPath, current => {
      if (latest(current)?.id !== round.id || latest(current).status !== 'uncertain') throw Error('planner round changed during reconciliation');
      if (current.planner.rounds.some(item => item.agent_id === agentId)) throw Error('fresh planner agent required');
      Object.assign(latest(current), { agent_id: agentId, status: 'running' });
    });
    round = latest(task);
  }
  if (!round?.agent_id || round.agent_id !== agentId) throw Error('planner agent identity mismatch');
  if (terminal.has(round.status)) return round;
  if (round.status !== 'running' || !['finished', 'failed'].includes(status)) {
    throw Error('wait for terminal Paseo status; never steer the planner');
  }
  const result = status === 'finished' && typeof plan === 'string' && plan.trim()
    ? { status: 'planned', plan }
    : { status: 'failed', failure: reason || 'planner did not return an implementable plan' };
  return updateTask(taskPath, current => {
    if (latest(current)?.id !== round.id || latest(current).status !== 'running') throw Error('planner round changed during collection');
    Object.assign(latest(current), result);
  }).planner.rounds.at(-1);
}

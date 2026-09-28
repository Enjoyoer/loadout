#!/usr/bin/env node
// Owner cloud toggle: route eligible editing Workers to one Claude Code cloud session.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateTask } from './task-state.mjs';

export const CLOUD_ROUTE = Object.freeze({ model: 'claude-opus-5-5[1m]', effort: 'xhigh', fastMode: false });
export const CLOUD_LIMITS = Object.freeze({ draftPrMinutes: 20, idleMinutes: 90, hardCapMinutes: 360, followUps: 1 });
// What the session page shows when a stall is suspected; unknown (page unreadable) is treated like waiting.
export const SESSION_PAGE_STATES = Object.freeze(['working', 'waiting', 'unknown', 'failed']);
export const NO_CREDITS = 'no cloud credits on this account';
export const CLOUD_HEARTBEAT_CRON = '*/20 * * * *';
export const defaultTogglePath = () => join(homedir(), '.config', 'opc', 'cloud');
export const defaultReposPath = () => join(homedir(), '.config', 'opc', 'cloud-repos');

// The lane marker reuses the managed opc/<slug> name. Cloud sessions push only to their own claude/... branch,
// so the marker goes in the PR title, never in a branch name.
const branchPattern = /^opc\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const minutes = (from, to) => (Date.parse(to) - Date.parse(from)) / 60000;

export function readCloudToggle({ path = defaultTogglePath() } = {}) {
  if (!existsSync(path)) return 'off';
  const value = readFileSync(path, 'utf8').trim();
  if (value !== 'on' && value !== 'off') throw Error(`cloud toggle must contain on or off: ${path}`);
  return value;
}

// GitHub gives user tokens no way to list App installations, so the owner confirms each repository.
export function readCloudRepos({ path = defaultReposPath() } = {}) {
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean));
}

export function setCloudRepo(repo, allowed, { path = defaultReposPath() } = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) throw Error('owner/repo required');
  const repos = readCloudRepos({ path });
  if (allowed) repos.add(repo); else repos.delete(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...repos].sort().map(item => `${item}\n`).join(''));
  return repos;
}

export function setCloudToggle(state, { path = defaultTogglePath(), authStatus = null } = {}) {
  if (state !== 'on' && state !== 'off') throw Error('cloud toggle state must be on or off');
  if (state === 'on' && authStatus?.authMethod !== 'claude.ai') {
    throw Error('cloud toggle on requires a claude.ai login on this host');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${state}\n`);
  return state;
}

// Launch or session text that means the account cannot run cloud sessions; the owner must hear about it.
export function classifyCloudFailure(output) {
  if (typeof output !== 'string') return null;
  if (/\bcredits?\b|billing|insufficient|out of (?:usage|quota)|usage limit|payment/i.test(output)) return 'no-credits';
  // "Attaching ... is not enabled for your account" is a follow-up sent without -p, not an unavailable account.
  if (/disabled by your organization's policy|Cloud sessions aren't available with/i.test(output)) return 'unavailable';
  return null;
}

export function checkCloudEligibility({ githubRemote, claudeAppInstalled, selfContained, authStatus }) {
  const reasons = [];
  if (githubRemote !== true) reasons.push('no GitHub remote');
  if (claudeAppInstalled !== true) reasons.push('Claude GitHub App not installed on the repository (whole local repo would upload)');
  if (selfContained !== true) reasons.push('task needs local-only files, services, secrets, or hosts');
  if (authStatus?.authMethod !== 'claude.ai') reasons.push('CLI is not logged in to claude.ai');
  return Object.freeze({ eligible: reasons.length === 0, reasons });
}

// The toggle is the owner's standing explicit Worker route choice; off or ineligible means ask as usual.
export function resolveCloudWorkerRoute({ toggle, eligibility }) {
  if (toggle !== 'on' || eligibility?.eligible !== true) return null;
  return Object.freeze({ role: 'worker', source: 'owner-explicit', ...CLOUD_ROUTE });
}

export function buildCloudBrief({ brief, branch, baseRef }) {
  if (!text(brief) || !branchPattern.test(branch ?? '') || !text(baseRef)) {
    throw Error('cloud brief, opc/<slug> lane marker, and base ref required');
  }
  return `${brief.trim()}\n\nCloud session rules (the launcher cannot answer questions):\n` +
    `- Base your work on ${baseRef}. Push only to this session's own working branch; pushes to any other branch name are rejected.\n` +
    `- Immediately open a draft PR from that branch against ${baseRef.replace(/^origin\//, '')}, titled "[${branch}] <short summary>". Keep the title prefix exactly.\n` +
    '- Commit and push after every milestone so progress is visible on the remote.\n' +
    '- When done and checks pass, mark the PR ready for review. Leave it unmerged.\n' +
    '- Do not edit project memory files (STATUS.html, LESSONS.md).\n';
}

export function buildCloudLaunchCommand({ briefPath }) {
  if (!text(briefPath) || /["$`\\]/.test(briefPath)) throw Error('plain brief file path required');
  return `claude --cloud "$(cat "${briefPath}")" --model '${CLOUD_ROUTE.model}' --effort ${CLOUD_ROUTE.effort}`;
}

export function buildCloudHeartbeatRequest({ taskPath, repo, branch }) {
  if (!text(taskPath) || !/^[^/\s]+\/[^/\s]+$/.test(repo ?? '') || !branchPattern.test(branch ?? '')) {
    throw Error('task path, owner/repo, and cloud lane marker required');
  }
  return Object.freeze({
    name: `opc-cloud-${branch.slice(4)}`,
    cron: CLOUD_HEARTBEAT_CRON,
    prompt: `OPC cloud lane check for ${repo} marker [${branch}] (task ${taskPath}). Read the remote once: ` +
      `\`gh pr list --repo ${repo} --state all --limit 100 --json number,title,isDraft,state,headRefName\`, keep only the PR whose ` +
      `title starts with "[${branch}]", and if it exists read \`gh api repos/${repo}/pulls/<number>/commits\` ` +
      '(commit count and newest committer date). ' +
      'Pass that observation to recordCloudProgress (set noCredits when the session reports exhausted credits or billing). ' +
      'If it returns tellOwner, tell the owner the account has no cloud credits. If it returns suspect, open the recorded session URL ' +
      'in the browser, read the page, and pass working, waiting, unknown, or failed to recordCloudSessionCheck; if that returns ' +
      'followUp, send buildCloudFollowUpCommand from a shell. If either call returns terminal, delete this heartbeat and continue OPC ' +
      'integration or the recorded fallback. Otherwise end your turn with no message. Never relaunch from this check.',
  });
}

// Pure decision: running, ready (PR marked ready), suspect (quiet remote; check the session before judging), or dead.
export function assessCloudProgress({ launchedAt, now, pr = null, lastPushAt = null, activeAt = null, unavailable = false,
  noCredits = false, limits = CLOUD_LIMITS }) {
  if (!text(launchedAt) || !text(now) || Number.isNaN(Date.parse(launchedAt)) || Number.isNaN(Date.parse(now))) {
    throw Error('ISO launch and observation times required');
  }
  if (noCredits) return { state: 'dead', reason: NO_CREDITS };
  if (unavailable) return { state: 'dead', reason: 'cloud sessions unavailable for this login' };
  if (pr && pr.state === 'MERGED') return { state: 'dead', reason: 'cloud PR was merged outside the PM' };
  if (pr && pr.state === 'OPEN' && pr.isDraft === false) return { state: 'ready', reason: 'PR marked ready' };
  const age = minutes(launchedAt, now);
  if (age >= limits.hardCapMinutes) return { state: 'dead', reason: `hard cap ${limits.hardCapMinutes} minutes reached` };
  // A confirmed-active session page or a follow-up restarts both quiet clocks.
  const quietSince = [launchedAt, lastPushAt, activeAt].filter(text).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  if (!pr && minutes(activeAt ?? launchedAt, now) >= limits.draftPrMinutes) {
    return { state: 'suspect', reason: `no draft PR within ${limits.draftPrMinutes} minutes` };
  }
  if (minutes(quietSince, now) >= limits.idleMinutes) return { state: 'suspect', reason: `no push for ${limits.idleMinutes} minutes` };
  return { state: 'running', reason: null };
}

export function recordCloudLaunch(taskPath, { sessionId, url, branch, repo, launchedAt, heartbeatId }) {
  if (![sessionId, url, repo, launchedAt, heartbeatId].every(text) || !branchPattern.test(branch ?? '')) {
    throw Error('cloud session id, URL, branch, repo, launch time, and heartbeat id required');
  }
  return updateTask(taskPath, task => {
    if (task.cloud) throw Error('cloud lane already recorded; reconcile it, never launch a second session');
    task.cloud = { status: 'running', session_id: sessionId, url, branch, repo, launched_at: launchedAt,
      heartbeat_id: heartbeatId, route: { ...CLOUD_ROUTE }, progress: null, reason: null, fallback: null,
      suspect: null, active_at: null, follow_ups: 0 };
  }).cloud;
}

export function recordCloudProgress(taskPath, { now, pr = null, commits = 0, lastPushAt = null, unavailable = false, noCredits = false }) {
  let decision;
  const task = updateTask(taskPath, task => {
    if (task.cloud?.status !== 'running') throw Error('no running cloud lane to observe');
    decision = assessCloudProgress({ launchedAt: task.cloud.launched_at, now, pr, lastPushAt,
      activeAt: task.cloud.active_at ?? null, unavailable, noCredits });
    task.cloud.progress = { checked_at: now, commits, last_push_at: lastPushAt,
      pr: pr ? { number: pr.number, draft: pr.isDraft, state: pr.state } : null };
    task.cloud.suspect = decision.state === 'suspect' ? { reason: decision.reason, at: now } : null;
    if (decision.state === 'ready' || decision.state === 'dead') { task.cloud.status = decision.state; task.cloud.reason = decision.reason; }
  });
  return cloudResult(decision, task);
}

const cloudResult = (decision, task, extra = {}) => Object.freeze({ ...decision, ...extra,
  terminal: decision.state === 'ready' || decision.state === 'dead', heartbeatId: task.cloud.heartbeat_id,
  tellOwner: decision.reason === NO_CREDITS });

// A quiet remote is only suspect. The session page decides: working keeps waiting, waiting or unreadable gets one
// follow-up, and only failed or still quiet after the follow-up is dead, which is when a local Worker may take over.
export function recordCloudSessionCheck(taskPath, { now, page, noCredits = false }) {
  if (!SESSION_PAGE_STATES.includes(page) || !text(now)) throw Error(`session page must be ${SESSION_PAGE_STATES.join(', ')}`);
  let decision, followUp = false;
  const task = updateTask(taskPath, task => {
    if (task.cloud?.status !== 'running' || !task.cloud.suspect) throw Error('no suspect cloud lane to check');
    const suspect = task.cloud.suspect;
    task.cloud.suspect = null;
    if (noCredits) decision = { state: 'dead', reason: NO_CREDITS };
    else if (page === 'failed') decision = { state: 'dead', reason: `session page shows failure after ${suspect.reason}` };
    else if (page === 'working') decision = { state: 'running', reason: null };
    else if ((task.cloud.follow_ups ?? 0) < CLOUD_LIMITS.followUps) {
      task.cloud.follow_ups = (task.cloud.follow_ups ?? 0) + 1;
      decision = { state: 'running', reason: null };
      followUp = true;
    } else decision = { state: 'dead', reason: `${suspect.reason}, still quiet after a follow-up` };
    if (decision.state === 'dead') { task.cloud.status = 'dead'; task.cloud.reason = decision.reason; }
    else task.cloud.active_at = now;
  });
  return cloudResult(decision, task, { followUp });
}

export function buildCloudFollowUp({ branch }) {
  if (!branchPattern.test(branch ?? '')) throw Error('cloud lane marker required');
  return 'Launcher check-in: nothing has reached the remote recently. Commit and push your current work to your own ' +
    `working branch now, keep the draft PR titled "[${branch}] ..." open (open it now if missing), and continue. ` +
    'If you are blocked, write the blocker in the PR description, then push.';
}

// Print mode queues a follow-up into the existing session; without -p the CLI reports attaching as not enabled.
export function buildCloudFollowUpCommand({ sessionId, messagePath }) {
  if (!/^session_[A-Za-z0-9_-]+$/.test(sessionId ?? '') || !text(messagePath) || /["$`\\]/.test(messagePath)) {
    throw Error('cloud session id and plain message file path required');
  }
  return `claude -p "$(cat "${messagePath}")" --cloud ${sessionId}`;
}

// Pre-authorized by the toggle: one local managed Worker on the same model and effort, then stop.
export function authorizeCloudFallback(taskPath) {
  let route;
  updateTask(taskPath, task => {
    if (task.cloud?.status !== 'dead') throw Error('cloud fallback requires a heartbeat-recorded dead cloud lane');
    if (task.cloud.fallback) throw Error('cloud fallback already used; stop and report to the owner');
    if (task.cloud.reason === NO_CREDITS) throw Error('no cloud credits: tell the owner; a local fallback needs their decision');
    task.cloud.fallback = { authorized_by: 'cloud-toggle', route: { ...CLOUD_ROUTE } };
    route = Object.freeze({ role: 'worker', source: 'owner-explicit', ...CLOUD_ROUTE });
  });
  return route;
}

function readAuthStatus() {
  return JSON.parse(execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8' }));
}

function main(argv) {
  const [state, ...rest] = argv;
  const flag = name => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1]; };
  if (state === 'status') { console.log(`${readCloudToggle()}; repos: ${[...readCloudRepos()].join(', ') || 'none'}`); return; }
  if (state === 'allow' || state === 'disallow') {
    console.log(`repos: ${[...setCloudRepo(rest[0], state === 'allow')].join(', ') || 'none'}`); return;
  }
  if (state !== 'on' && state !== 'off') {
    throw Error('usage: cloud-lane.mjs on|off|status [--fleet host,...] | allow|disallow <owner/repo>');
  }
  setCloudToggle(state, { authStatus: state === 'on' ? readAuthStatus() : null });
  console.log(`local: ${state}`);
  const fleet = flag('--fleet');
  if (!fleet) return;
  const script = '.codex/skills/opc/scripts/cloud-lane.mjs';
  for (const host of fleet.split(',').filter(Boolean)) {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'node', script, state];
    try { console.log(`${host}: ${execFileSync('ssh', args, { encoding: 'utf8' }).trim()}`); }
    catch (error) { console.log(`${host}: FAILED ${(error.stderr || error.message).toString().trim().split('\n').at(-1)}`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

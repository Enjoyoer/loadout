#!/usr/bin/env node
// Owner cloud toggle: route eligible editing Workers to one Claude Code cloud session.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isGptOrWebRoute, validateRoleRoute } from './agent-routing.mjs';
import { readTask, updateTask } from './task-state.mjs';

// Owner rule: every cloud session runs Opus 5.5 at xhigh, whatever the lane's class or route. Launch and follow-up
// commands always pass this pair and take no model or effort from callers.
export const CLOUD_ROUTE = Object.freeze({ model: 'claude-opus-5-5[1m]', effort: 'xhigh', fastMode: false });
const cloudModelFlags = `--model '${CLOUD_ROUTE.model}' --effort ${CLOUD_ROUTE.effort}`;
export const CLOUD_LIMITS = Object.freeze({ draftPrMinutes: 20, idleMinutes: 90, hardCapMinutes: 360, followUps: 1, relaunches: 1 });
// What the session page shows when a stall is suspected; unknown (page unreadable) is treated like waiting.
export const SESSION_PAGE_STATES = Object.freeze(['working', 'waiting', 'unknown', 'failed']);
export const NO_CREDITS = 'no cloud credits on this account';
export const CLOUD_HEARTBEAT_CRON = '*/20 * * * *';
export const defaultTogglePath = () => join(homedir(), '.config', 'opc', 'cloud');
export const defaultReposPath = () => join(homedir(), '.config', 'opc', 'cloud-repos');
export const defaultProfilePath = () => join(homedir(), '.config', 'opc', 'cloud-profile');

// The lane marker reuses the managed opc/<slug> name. Cloud sessions push only to their own claude/... branch,
// so the marker goes in the PR title, never in a branch name.
const branchPattern = /^opc\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
// GitHub owner and repository names only; the value reaches ssh, which runs it through the remote shell.
const repoPart = '[A-Za-z0-9._-]+';
const repoPattern = new RegExp(`^${repoPart}/${repoPart}$`);
const text = value => typeof value === 'string' && value.trim().length > 0;
const minutes = (from, to) => (Date.parse(to) - Date.parse(from)) / 60000;

// Missing means default: on for eligible code-class Workers only. on covers any eligible editing class; all also covers
// ui (the cloud route is Opus xhigh, which meets the ui rule); off disables.
export function readCloudToggle({ path = defaultTogglePath() } = {}) {
  if (!existsSync(path)) return 'default';
  const value = readFileSync(path, 'utf8').trim();
  if (!['on', 'off', 'all'].includes(value)) throw Error(`cloud toggle must contain on, off, or all: ${path}`);
  return value;
}

// GitHub gives user tokens no way to list App installations, so the owner confirms repositories:
// owner/repo for one, owner/* when the App is installed on every repository of that account.
export function readCloudRepos({ path = defaultReposPath() } = {}) {
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean));
}

export function isCloudRepo(repo, { path = defaultReposPath() } = {}) {
  if (!repoPattern.test(repo ?? '')) return false;
  const repos = new Set([...readCloudRepos({ path })].map(item => item.toLowerCase()));
  const name = repo.toLowerCase();
  return repos.has(name) || repos.has(`${name.split('/')[0]}/*`);
}

export function setCloudRepo(repo, allowed, { path = defaultReposPath() } = {}) {
  if (!new RegExp(`^${repoPart}/(?:\\*|${repoPart})$`).test(repo ?? '')) throw Error('owner/repo or owner/* required');
  const repos = readCloudRepos({ path });
  if (allowed) repos.add(repo); else repos.delete(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...repos].sort().map(item => `${item}\n`).join(''));
  return repos;
}

// Optional cloud profile: a second Claude Code config directory (CLAUDE_CONFIG_DIR) whose claude.ai login holds the
// cloud credits, while the host's default login stays as it is. Missing means the default login. On POSIX the launch
// and follow-up commands set it as an sh prefix; on Windows they run this script's launch and follow-up subcommands,
// which pass it in the environment of a claude started without a shell.
const WINDOWS = process.platform === 'win32';
// Characters a path may not hold: quotes and shell expansion, plus backslash on POSIX and % and ! on Windows.
const UNSAFE_PATH = WINDOWS ? /['"$`%!\r\n]/ : /['"$`\\\r\n]/;
function profileDir(value) {
  const dir = (value ?? '').trim().replace(/^~(?=$|[\\/])/, homedir());
  if (!isAbsolute(dir) || UNSAFE_PATH.test(dir)) throw Error('cloud profile must be one absolute directory path without quotes');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw Error(`cloud profile directory missing: ${dir}`);
  return dir;
}

// Only a confirmed-absent file means the default login; any other error (unreadable, dangling link) fails closed,
// so a broken profile can never bill the default account silently.
export function readCloudProfile({ path = defaultProfilePath() } = {}) {
  try { lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  return profileDir(readFileSync(path, 'utf8'));
}

// Setting a profile requires that directory's claude.ai login (readAuthStatus with the new profile); none clears it.
export function setCloudProfile(value, { path = defaultProfilePath(), authStatus = readAuthStatus } = {}) {
  if (value === 'none') { rmSync(path, { force: true }); return null; }
  const dir = profileDir(value);
  const status = typeof authStatus === 'function' ? authStatus(dir) : authStatus;
  if (status?.authMethod !== 'claude.ai') throw Error(`cloud profile ${dir} is not logged in to claude.ai`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${dir}\n`);
  return dir;
}

const profilePrefix = profile => profile ? `CLAUDE_CONFIG_DIR='${profileDir(profile)}' ` : '';

export function setCloudToggle(state, { path = defaultTogglePath(), authStatus = null } = {}) {
  if (!['on', 'off', 'all'].includes(state)) throw Error('cloud toggle state must be on, off, or all');
  if (state !== 'off' && authStatus?.authMethod !== 'claude.ai') {
    throw Error(`cloud toggle ${state} requires a claude.ai login on this host`);
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

// The toggle is the owner's standing explicit Worker route choice; off, ineligible, or another class returns null
// and the task takes its local route. A class-less call with the toggle on is the PM's own editing-lane judgment.
export const CLOUD_EDITING_CLASSES = Object.freeze(['code', 'code-bounded', 'test-fix', 'mechanical', 'automation']);
export const CLOUD_ALL_CLASSES = Object.freeze([...CLOUD_EDITING_CLASSES, 'ui']);
export const cloudClasses = toggle => toggle === 'all' ? CLOUD_ALL_CLASSES : toggle === 'on' ? CLOUD_EDITING_CLASSES
  : toggle === 'default' ? ['code'] : [];
export function resolveCloudWorkerRoute({ toggle, eligibility, taskClass = null }) {
  if (!['on', 'off', 'all', 'default'].includes(toggle)) throw Error('cloud toggle must be on, off, all, or default');
  if (toggle === 'off' || eligibility?.eligible !== true) return null;
  if (toggle === 'default' ? taskClass !== 'code' : taskClass != null && !cloudClasses(toggle).includes(taskClass)) return null;
  return Object.freeze({ role: 'worker', source: 'owner-explicit', ...CLOUD_ROUTE });
}

export function buildCloudBrief({ brief, branch, baseRef }) {
  if (!text(brief) || !branchPattern.test(branch ?? '') || !text(baseRef)) {
    throw Error('cloud brief, opc/<slug> lane marker, and base ref required');
  }
  return `${brief.trim()}\n\nCloud session rules (the launcher cannot answer questions):\n` +
    `- Base your work on ${baseRef}. Push only to this session's own working branch; pushes to any other branch name are rejected.\n` +
    '- The session container can restart without warning, and a restart loses every commit not yet pushed.\n' +
    `- Before any other work, push a first small commit (for example a short plan file or the first trivial change) and open a draft PR from that branch against ${baseRef.replace(/^origin\//, '')}, titled "[${branch}] <short summary>". Keep the title prefix exactly.\n` +
    '- Then commit and push after each completed fix or step, so a restart loses at most one step. Never hold more than one step unpushed.\n' +
    '- When done and checks pass, mark the PR ready for review. Leave it unmerged.\n' +
    '- Do not edit project memory files (STATUS.html, LESSONS.md).\n';
}

// Windows: PowerShell 5.1 and cmd.exe mangle a brief's quotes on a native command line, so the command runs this
// script, which reads the file and starts claude with an argv array and the profile in its environment.
const SCRIPT = fileURLToPath(import.meta.url);
const CLOUD_MODEL_ARGS = ['--model', CLOUD_ROUTE.model, '--effort', CLOUD_ROUTE.effort];
const plainPath = path => text(path) && !(WINDOWS ? /["$`%!\r\n]/ : /["$`\\]/).test(path);
const windowsProfileArg = profile => `--profile "${profile ? profileDir(profile) : 'none'}"`;

export function buildCloudLaunchCommand({ briefPath, profile = readCloudProfile() }) {
  if (!plainPath(briefPath)) throw Error('plain brief file path required');
  if (WINDOWS) return `node "${SCRIPT}" launch "${briefPath}" ${windowsProfileArg(profile)}`;
  return `${profilePrefix(profile)}claude --cloud "$(cat "${briefPath}")" ${cloudModelFlags}`;
}

export function buildCloudHeartbeatRequest({ taskPath, repo, branch }) {
  if (!text(taskPath) || !repoPattern.test(repo ?? '') || !branchPattern.test(branch ?? '')) {
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

// Persist intent before sending the session command. An interrupted command remains uncertain, never retry blindly.
// The only launch after the first is one on a lane reconciled as no_session, with the same marker and repo.
export function beginCloudLaunch(taskPath, { branch, repo, launchedAt = new Date().toISOString() }) {
  if (!branchPattern.test(branch ?? '') || !repoPattern.test(repo ?? '') || !text(launchedAt)) throw Error('cloud lane marker, repo, and launch time required');
  return updateTask(taskPath, task => {
    const prior = task.cloud;
    if (prior && prior.status !== 'no_session') throw Error('cloud lane already recorded; reconcile it, never launch a second session');
    if (prior && (prior.branch !== branch || prior.repo !== repo)) throw Error('a relaunch keeps the recorded lane marker and repo');
    const attempt = prior ? (prior.attempt ?? 1) + 1 : 1;
    if (attempt > 1 + CLOUD_LIMITS.relaunches) throw Error('cloud lane already relaunched once with no session; report to the owner');
    task.cloud = { status: 'launching', session_id: null, url: null, branch, repo, launched_at: launchedAt,
      heartbeat_id: null, route: { ...CLOUD_ROUTE }, progress: null, reason: null, fallback: null,
      suspect: null, active_at: null, follow_ups: 0, attempt };
  }).cloud;
}

export function recordCloudLaunchFailure(taskPath, reason) {
  if (!text(reason)) throw Error('launch uncertainty reason required');
  return updateTask(taskPath, task => {
    if (task.cloud?.status !== 'launching') throw Error('no launching cloud lane');
    task.cloud.status = 'uncertain'; task.cloud.reason = reason;
  }).cloud;
}

// Complete the intent beginCloudLaunch recorded, right after the capture; then create and bind the heartbeat.
export function recordCloudLaunch(taskPath, { sessionId, url, branch, repo }) {
  if (![sessionId, url, repo].every(text) || !branchPattern.test(branch ?? '')) {
    throw Error('cloud session id, URL, branch, and repo required');
  }
  return updateTask(taskPath, task => {
    if (task.cloud?.status !== 'launching') throw Error('no launching cloud lane; call beginCloudLaunch before the session command');
    if (task.cloud.branch !== branch || task.cloud.repo !== repo) throw Error('session does not match the launching lane marker and repo');
    Object.assign(task.cloud, { status: 'running', session_id: sessionId, url });
  }).cloud;
}

// Settle a launching or uncertain lane once the PM has checked for its session: a found session makes it running
// (then create and bind the heartbeat); { noSession: true, reason } records that none exists, which permits one new
// launch. One task update either way, so a lane is never left half settled.
export function reconcileCloudLaunch(taskPath, outcome = {}) {
  const { sessionId, url, branch, repo, noSession = false, reason } = outcome;
  if (noSession === true) {
    if (!text(reason) || /[\r\n]/.test(reason) || sessionId != null || url != null) {
      throw Error('noSession takes a one-line reason and no session id or URL');
    }
  } else if (![sessionId, url, repo].every(text) || !branchPattern.test(branch ?? '')) {
    throw Error('cloud session id, URL, branch, and repo required, or noSession with a reason');
  }
  return updateTask(taskPath, task => {
    if (!['launching', 'uncertain'].includes(task.cloud?.status)) throw Error('no launching or uncertain cloud lane to reconcile');
    if (noSession === true) { Object.assign(task.cloud, { status: 'no_session', reason }); return; }
    if (task.cloud.branch !== branch || task.cloud.repo !== repo) throw Error('session does not match the recorded lane marker and repo');
    Object.assign(task.cloud, { status: 'running', session_id: sessionId, url, reason: null });
  }).cloud;
}

// A recorded lane without a heartbeat id needs a heartbeat, never a second session.
export function recordCloudHeartbeat(taskPath, { heartbeatId }) {
  if (!text(heartbeatId)) throw Error('heartbeat id required');
  return updateTask(taskPath, task => {
    if (task.cloud?.status !== 'running' || task.cloud.heartbeat_id) throw Error('no running cloud lane awaiting a heartbeat');
    task.cloud.heartbeat_id = heartbeatId;
  }).cloud;
}

export function recordCloudProgress(taskPath, { now, pr = null, commits = 0, lastPushAt = null, unavailable = false, noCredits = false }) {
  // With no running lane the heartbeat has nothing to observe: report terminal so it deletes itself.
  const current = readTask(taskPath);
  if (current.cloud?.status !== 'running') {
    return cloudResult({ state: current.cloud?.status ?? 'dead', reason: current.cloud?.reason ?? 'no cloud lane recorded' }, current);
  }
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
  terminal: decision.state === 'ready' || decision.state === 'dead', heartbeatId: task.cloud?.heartbeat_id ?? null,
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
    'If the session restarted and nothing was pushed, start again from the base, push a first small commit, open the draft PR, ' +
    'and push after each step. If you are blocked, write the blocker in the PR description, then push.';
}

// Print mode queues a follow-up into the existing session; without -p the CLI reports attaching as not enabled.
export function buildCloudFollowUpCommand({ sessionId, messagePath, profile = readCloudProfile() }) {
  if (!/^session_[A-Za-z0-9_-]+$/.test(sessionId ?? '') || !plainPath(messagePath)) {
    throw Error('cloud session id and plain message file path required');
  }
  if (WINDOWS) return `node "${SCRIPT}" follow-up ${sessionId} "${messagePath}" ${windowsProfileArg(profile)}`;
  return `${profilePrefix(profile)}claude -p "$(cat "${messagePath}")" --cloud ${sessionId} ${cloudModelFlags}`;
}

// Pre-authorized by the toggle: one local managed Worker, then stop.
// The local route comes from route.mjs resolveCloudFallback: the lane's class through the Pi catalog with its quota
// pace, or an owner-named route, so the fallback runs on Pi without native authorization. record(task), when given,
// writes the fallback's lane route in the same task update, so a failure leaves neither the fallback nor the route.
export function authorizeCloudFallback(taskPath, { route, reason, record = null } = {}) {
  validateRoleRoute('worker', route);
  if (isGptOrWebRoute(route)) throw Error('cloud fallback stays on a Claude route');
  if (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason)) throw Error('cloud fallback reason must be one line');
  updateTask(taskPath, task => {
    if (task.cloud?.status !== 'dead') throw Error('cloud fallback requires a heartbeat-recorded dead cloud lane');
    if (task.cloud.fallback) throw Error('cloud fallback already used; stop and report to the owner');
    if (task.cloud.reason === NO_CREDITS) throw Error('no cloud credits: tell the owner; a local fallback needs their decision');
    task.cloud.fallback = { authorized_by: 'cloud-toggle', route: structuredClone(route), reason };
    record?.(task);
  });
  return Object.freeze({ route, reason });
}

// The login cloud sessions use: the cloud profile's when one is set, else the host's default login.
export function readAuthStatus(profile = readCloudProfile()) {
  const env = profile ? { ...process.env, CLAUDE_CONFIG_DIR: profileDir(profile) } : process.env;
  return JSON.parse(execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30000, env }));
}

// Same pattern as HOST_NAME in personal-skills fleet.py: a host can never start with '-' and become an ssh option.
const HOST_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function fleetHosts(fleet) {
  const hosts = (fleet ?? '').split(',').filter(Boolean);
  for (const host of hosts) if (!HOST_NAME.test(host)) throw Error(`invalid fleet host name: ${JSON.stringify(host)}`);
  return hosts;
}

// ssh hands the remote command to sh on POSIX hosts and to cmd.exe on Windows OpenSSH, which quote differently
// (cmd.exe keeps single quotes). So the command is the bare words `node -`, read the same by both, and the arguments
// travel as JSON inside the program on stdin, which no shell parses and which cannot glob owner/*. The program runs
// the host's own installed copy: the Pi skill root from its Paseo pi provider, then ~/.claude/skills, then Codex.
export function buildFleetCommand(args) {
  const program = `const fs = require('fs'), path = require('path'), home = require('os').homedir();
const args = ${JSON.stringify(args)}, roots = [];
try {
  const command = JSON.parse(fs.readFileSync(path.join(home, '.paseo', 'config.json'), 'utf8')).agents?.providers?.pi?.command ?? [];
  const launcher = command.find(arg => path.basename(arg) === 'launch.mjs');
  if (launcher) roots.push(path.join(path.dirname(launcher.replace(/^~(?=$|[\\\\/])/, home)), 'agent', 'skills'));
} catch {}
roots.push(path.join(home, '.claude', 'skills'), path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills'));
const script = roots.map(root => path.join(root, 'opc', 'scripts', 'cloud-lane.mjs')).find(file => fs.existsSync(file));
if (!script) { console.error('OPC cloud-lane.mjs not installed under ' + roots.join(', ')); process.exit(1); }
const done = require('child_process').spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
process.exitCode = done.status ?? 1;
`;
  return Object.freeze({ command: 'node -', input: program });
}

function pushToFleet(hosts, args) {
  const { command, input } = buildFleetCommand(args);
  for (const host of hosts) {
    const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, command];
    try { console.log(`${host}: ${execFileSync('ssh', ssh, { encoding: 'utf8', input, timeout: 60000 }).trim()}`); }
    catch (error) {
      console.log(`${host}: FAILED ${(error.stderr || error.message).toString().trim().split('\n').at(-1)}`);
      process.exitCode = 1;
    }
  }
}

// Start claude without a shell: the file's text is one argv element, and the profile travels in the environment.
function runClaude(args, profileArg) {
  if (profileArg == null) throw Error('--profile <dir>|none required');
  const profile = profileArg === 'none' ? null : profileDir(profileArg);
  const env = { ...process.env };
  if (profile) env.CLAUDE_CONFIG_DIR = profile; else delete env.CLAUDE_CONFIG_DIR;
  const done = spawnSync('claude', [...args, ...CLOUD_MODEL_ARGS], { stdio: 'inherit', env });
  if (done.error) throw done.error;
  process.exitCode = done.status ?? 1;
}

function main(argv) {
  const [state, ...rest] = argv;
  // Without flags, list the lanes a resuming PM must settle; with flags, settle one task's lane.
  if (state === 'reconcile') {
    const usage = 'usage: cloud-lane.mjs reconcile <task.json> [task.json...] | reconcile <task.json> --session <id> --url <url>' +
      ' | reconcile <task.json> --no-session --reason <text>';
    const [path, ...flags] = rest;
    if (!path || path.startsWith('--')) throw Error(usage);
    if (!rest.some(arg => arg.startsWith('--'))) {
      for (const task of rest) {
        const cloud = readTask(task).cloud;
        if (cloud && ['launching', 'uncertain', 'running'].includes(cloud.status) && !cloud.heartbeat_id)
          console.log(JSON.stringify({ task, status: cloud.status, branch: cloud.branch, session_id: cloud.session_id, url: cloud.url }));
      }
      return;
    }
    const named = {};
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--no-session') named.noSession = true;
      else if (['--session', '--url', '--reason'].includes(flags[i]) && flags[i + 1] && !flags[i + 1].startsWith('--')) named[flags[i].slice(2)] = flags[++i];
      else throw Error(usage);
    }
    if (!named.noSession && named.reason) throw Error(usage);
    // The session form settles the lane the task records, so its marker and repo come from the record.
    const cloud = readTask(path).cloud;
    if (!cloud) throw Error('no cloud lane recorded in this task; nothing to reconcile');
    console.log(JSON.stringify(reconcileCloudLaunch(path, named.noSession
      ? { noSession: true, reason: named.reason, sessionId: named.session, url: named.url }
      : { sessionId: named.session, url: named.url, branch: cloud?.branch, repo: cloud?.repo })));
    return;
  }
  const flag = name => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1]; };
  if (state === 'launch') {
    if (!plainPath(rest[0])) throw Error('usage: cloud-lane.mjs launch <brief file> --profile <dir>|none');
    return runClaude(['--cloud', readFileSync(rest[0], 'utf8')], flag('--profile'));
  }
  if (state === 'follow-up') {
    if (!/^session_[A-Za-z0-9_-]+$/.test(rest[0] ?? '') || !plainPath(rest[1])) {
      throw Error('usage: cloud-lane.mjs follow-up <session id> <message file> --profile <dir>|none');
    }
    return runClaude(['-p', readFileSync(rest[1], 'utf8'), '--cloud', rest[0]], flag('--profile'));
  }
  // Refuse a bad host before any local change or ssh call.
  const hosts = fleetHosts(flag('--fleet'));
  if (state === 'status') {
    // Each host prints its own effective toggle: on, off, or default (code class only).
    const profile = readCloudProfile();
    let login = 'unknown';
    try { const auth = readAuthStatus(profile); login = `${auth.authMethod ?? 'none'} ${auth.email ?? ''}`.trim(); } catch {}
    console.log(`${hosts.length ? 'local: ' : ''}${readCloudToggle().replace(/^default$/, 'default (code class only)').replace(/^all$/, 'all (editing classes and ui)')}; repos: ${[...readCloudRepos()].join(', ') || 'none'}; ` +
      `login: ${profile ? `profile ${profile}` : 'default'} (${login})`);
    pushToFleet(hosts, ['status']);
    return;
  }
  // Host-local only: a profile names a directory on this host, so it never travels with --fleet.
  if (state === 'profile') {
    if (hosts.length) throw Error('cloud profile is host-local; run it on each host without --fleet');
    const dir = setCloudProfile(rest[0]);
    console.log(`local profile: ${dir ?? 'none (default login)'}`);
    return;
  }
  if (state === 'allow' || state === 'disallow') {
    console.log(`local repos: ${[...setCloudRepo(rest[0], state === 'allow')].join(', ') || 'none'}`);
    pushToFleet(hosts, [state, rest[0]]);
    return;
  }
  if (!['on', 'off', 'all'].includes(state)) {
    throw Error('usage: cloud-lane.mjs on|off|all|status | allow|disallow <owner/repo|owner/*> [--fleet host,...] | profile <dir>|none' +
      ' | launch <brief file> --profile <dir>|none | follow-up <session id> <message file> --profile <dir>|none' +
      ' | reconcile <task.json>... [--session <id> --url <url> | --no-session --reason <text>]');
  }
  setCloudToggle(state, { authStatus: state === 'off' ? null : readAuthStatus() });
  console.log(`local: ${state}`);
  pushToFleet(hosts, [state]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

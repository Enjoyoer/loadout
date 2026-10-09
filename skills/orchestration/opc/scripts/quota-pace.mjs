// Quota pace for Worker routing. Reads Paceline's `pq --json` (schemaVersion 1) and turns one provider
// pool into a level step: weekly pace first, then the 5-hour window. Stale or missing data never adjusts.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PACE_LEVELS = Object.freeze(['medium', 'high', 'xhigh']);
export const PQ_TIMEOUT_MS = 15000;
// Owner-tunable in ~/.config/opc/routing.json; pq is an argv run without a shell (a leading ~ is expanded here).
export const ROUTING_DEFAULTS = Object.freeze({
  behindPoints: 10, aheadPoints: 10, resetSoonHours: 24, resetSoonLeftPct: 15,
  fiveHourNoUpPct: 75, fiveHourDownPct: 90, pq: Object.freeze(['~/.local/bin/pq', '--json']),
});
export const defaultRoutingPath = () => join(homedir(), '.config', 'opc', 'routing.json');
export const POOL_NAMES = Object.freeze({ claude: 'Claude', codex: 'Codex' });

const ranges = { behindPoints: [0, 100], aheadPoints: [0, 100], resetSoonHours: [0, 168], resetSoonLeftPct: [0, 100],
  fiveHourNoUpPct: [0, 100], fiveHourDownPct: [0, 100] };
const num = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const shown = value => String(Math.round(value * 10) / 10);
const firstLine = value => String(value ?? '').trim().split(/\r?\n/)[0];

export function validateRoutingSettings(value, source = 'routing settings') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${source} must be a JSON object`);
  const settings = { ...ROUTING_DEFAULTS };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'pq') {
      if (!Array.isArray(item) || !item.length || item.some(arg => typeof arg !== 'string' || !arg)) {
        throw Error(`${source}: pq must be a nonempty argv array of strings`);
      }
      settings.pq = Object.freeze([...item]);
    } else if (Object.hasOwn(ranges, key)) {
      const [min, max] = ranges[key];
      if (!num(item) || item < min || item > max) throw Error(`${source}: ${key} must be a number from ${min} to ${max}`);
      settings[key] = item;
    } else {
      throw Error(`${source}: unknown key ${key} (allowed: ${Object.keys(ROUTING_DEFAULTS).join(', ')})`);
    }
  }
  if (settings.fiveHourNoUpPct > settings.fiveHourDownPct) throw Error(`${source}: fiveHourNoUpPct must not exceed fiveHourDownPct`);
  return Object.freeze(settings);
}

export function readRoutingSettings({ path = defaultRoutingPath() } = {}) {
  if (!existsSync(path)) return ROUTING_DEFAULTS;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw Error(`${path} is not valid JSON (${error.message})`); }
  return validateRoutingSettings(value, path);
}

// A quota reading is { snapshot } or { stale: why }; only a snapshot can move a level.
export function parseQuota(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { stale: 'pq output unparseable' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { stale: 'pq output unparseable' };
  if (data.schemaVersion !== 1) return { stale: `pq schemaVersion ${data.schemaVersion ?? 'missing'}, need 1` };
  if (!Array.isArray(data.accounts)) return { stale: 'pq output has no accounts' };
  return { snapshot: data };
}

export async function readQuota({ settings = ROUTING_DEFAULTS, pqFile = null, home = homedir() } = {}) {
  if (pqFile) {
    try { return parseQuota(readFileSync(pqFile, 'utf8')); }
    catch (error) { return { stale: `pq file unreadable (${error.code ?? error.message})` }; }
  }
  const [command, ...args] = settings.pq;
  const file = command === '~' || command.startsWith('~/') ? join(home, command.slice(1)) : command;
  const result = await runPq(file, args);
  if (result.json) return parseQuota(result.json);
  if (result.code === 'ENOENT') return { stale: `pq unavailable (${command} not found)` };
  if (result.timedOut) return { stale: `pq unavailable (no answer in ${PQ_TIMEOUT_MS / 1000}s)` };
  return { stale: `pq unavailable (${firstLine(result.stderr) || firstLine(result.error) || `exit ${result.exit}`})` };
}

// Settle on the first complete JSON document, not on process exit: on Windows, ssh.exe run without a
// console can keep running after the remote pq has printed everything. stdin is closed so ssh never waits on it.
function runPq(file, args) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      // A grandchild can still hold the pipes open; release them so the caller is not kept waiting.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve(result);
    };
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => finish({ timedOut: true, stderr }), PQ_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 16 << 20) return finish({ error: 'pq output too large', stderr });
      try { JSON.parse(stdout); finish({ json: stdout }); } catch { /* not complete yet */ }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ code: error.code, error: error.message, stderr }));
    child.on('close', exit => finish(exit === 0 && stdout.trim() ? { json: stdout } : { exit, stderr }));
  });
}

// Pool values for one provider. Weekly gap is pq's plan-weighted pool pace; 5-hour use and reset-soon
// come from the pool's fresh accounts, since the pool field carries only the weekly pace.
export function poolPace(quota, pool, settings = ROUTING_DEFAULTS) {
  const name = POOL_NAMES[pool];
  if (!name) throw Error(`unknown quota pool ${pool}`);
  const pace = { pool, step: 0, weekly: null, stale: null, gapPct: null, fiveHourUsedPct: null, resetSoon: null,
    accounts: null, staleAccounts: null, ageSeconds: null };
  const stale = why => Object.freeze({ ...pace, stale: why });
  if (!quota) return stale('no quota reading supplied');
  if (!quota.snapshot) return stale(quota.stale || 'no quota reading');
  const { snapshot } = quota;
  if (snapshot.snapshotStale !== false) return stale('pq snapshot is stale');
  const entry = Array.isArray(snapshot.pools) ? snapshot.pools.find(item => item?.provider === pool) : null;
  if (!entry) return stale(`pq shows no ${name} pool`);
  if (!num(entry.pace?.gapPct)) return stale(`${name} pool has no weekly pace yet`);
  if (!count(entry.accounts) || entry.accounts === 0 || !count(entry.staleAccounts)) return stale(`${name} pool counts no accounts`);
  Object.assign(pace, { accounts: entry.accounts, staleAccounts: entry.staleAccounts });
  if (entry.staleAccounts > entry.accounts / 2) return stale(`${name} pool mostly stale (${entry.staleAccounts} of ${entry.accounts})`);
  const fresh = snapshot.accounts.filter(account => account?.provider === pool && account.fresh === true &&
    Array.isArray(account.windows));
  const windows = id => fresh.flatMap(account => account.windows.filter(window => window?.id === id && window.fresh !== false));
  const fiveHour = windows('five_hour').map(window => window.usedPct).filter(num);
  if (!fiveHour.length) return stale(`${name} pool has no fresh 5h reading`);
  const ages = fresh.map(account => account.ageSeconds).filter(num);
  const gapPct = entry.pace.gapPct;
  const fiveHourUsedPct = Math.round(fiveHour.reduce((sum, value) => sum + value, 0) / fiveHour.length * 10) / 10;
  const resetSoon = windows('seven_day').some(window => num(window.resetInSeconds) && num(window.leftPct) &&
    window.resetInSeconds <= settings.resetSoonHours * 3600 && window.leftPct > settings.resetSoonLeftPct);
  // Weekly first (ahead wins over behind or reset-soon), then the 5-hour window can only hold or lower it.
  const weekly = gapPct <= -settings.aheadPoints ? -1 : gapPct >= settings.behindPoints || resetSoon ? 1 : 0;
  const step = fiveHourUsedPct >= settings.fiveHourDownPct ? -1
    : fiveHourUsedPct >= settings.fiveHourNoUpPct && weekly === 1 ? 0 : weekly;
  return Object.freeze({ ...pace, step, weekly, gapPct, fiveHourUsedPct, resetSoon,
    ageSeconds: ages.length ? Math.max(...ages) : null });
}

// Apply a step to a default level, then clamp it to the class range [floor, ceiling].
export function paceLevel(level, step, [floor, ceiling]) {
  const index = PACE_LEVELS.indexOf(level) + step;
  return PACE_LEVELS[Math.min(PACE_LEVELS.indexOf(ceiling), Math.max(PACE_LEVELS.indexOf(floor), index))];
}

export function describePace(pace) {
  if (pace.stale) return `no adjustment, ${pace.stale}`;
  const gap = pace.gapPct > 0 ? `${shown(pace.gapPct)} behind` : pace.gapPct < 0 ? `${shown(-pace.gapPct)} ahead` : 'on pace';
  return [`${POOL_NAMES[pace.pool]} pool ${gap} weekly`, ...(pace.staleAccounts ? [`${pace.staleAccounts} of ${pace.accounts} stale`] : []),
    ...(pace.resetSoon ? ['weekly reset soon'] : []), `5h ${shown(pace.fiveHourUsedPct)}% used`].join(', ');
}

export function validPace(pace, pool) {
  const keys = ['pool', 'step', 'weekly', 'stale', 'gapPct', 'fiveHourUsedPct', 'resetSoon', 'accounts', 'staleAccounts', 'ageSeconds'];
  const nullable = (value, check) => value === null || check(value);
  return !!pace && typeof pace === 'object' && !Array.isArray(pace) && Object.keys(pace).length === keys.length &&
    keys.every(key => Object.hasOwn(pace, key)) && pace.pool === pool && [-1, 0, 1].includes(pace.step) &&
    nullable(pace.weekly, value => [-1, 0, 1].includes(value)) &&
    nullable(pace.stale, value => typeof value === 'string' && value.trim() && !/[\r\n]/.test(value)) &&
    (pace.stale === null ? num(pace.gapPct) && num(pace.fiveHourUsedPct) && typeof pace.resetSoon === 'boolean' && pace.weekly !== null
      : pace.step === 0) &&
    ['gapPct', 'fiveHourUsedPct', 'ageSeconds'].every(key => nullable(pace[key], num)) &&
    nullable(pace.resetSoon, value => typeof value === 'boolean') &&
    ['accounts', 'staleAccounts'].every(key => nullable(pace[key], count));
}

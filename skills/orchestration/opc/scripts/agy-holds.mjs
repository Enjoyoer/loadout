// Mac-only, owner-only per-model quota holds (authenticated terminal daemon events only), Config-owned readiness and
// quota projections (399a/397c), and bounded first-occurrence opposite-model probe state.
// Never accepts self-labelled caller quota events. Never stores, logs, or echoes raw error text, quota/reset figures,
// retry_at, account labels, or pace values.
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  isTargetId, localServerId, OPUS_REPLACEMENT_RUNTIME, readOwnerJson, repeatsKey, REPLACEMENT_RUNTIME,
} from './agent-routing.mjs';
import {
  isMappedServer, readAuthenticatedAgentTerminal, readRemoteTargets, verifiedAgentTerminalError, verifiedRemote,
} from './remote-target.mjs';
import { readTask, withFileLock } from './task-state.mjs';

export const AGY_HOLDS_SCHEMA = 1;
export const MAX_HOLD_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEVIN_READY_WINDOW_MS = 180 * 1000;
export const AGY_QUOTA_HOLD_THRESHOLD = 0.02;

const MAX_HOLD_TARGETS = 16;
const MAX_MESSAGE_CHARS = 1024;
const HOLDS_LOCK_WAIT_MS = 10000;

const ALLOWED_MODELS = Object.freeze([REPLACEMENT_RUNTIME.model, OPUS_REPLACEMENT_RUNTIME.model]);
const PROBE_DIRECTIONS = Object.freeze(['nh_to_oh', 'oh_to_nh']);
const TARGET_KEYS = Object.freeze(['daemon', 'local', 'platform']);
const DEVIN_READY_KEYS = Object.freeze(['ready', 'as_of', 'expires_at', 'retry_at']);
// Exact Config producer group labels in ~/.config/opc/agy-quota.json (Decision 399a).
const AGY_QUOTA_BUCKETS = Object.freeze({
  [REPLACEMENT_RUNTIME.model]: Object.freeze({ group: 'Gemini Models', keys: Object.freeze(['gemini-5h', 'gemini-weekly']) }),
  [OPUS_REPLACEMENT_RUNTIME.model]: Object.freeze({ group: 'Claude and GPT models', keys: Object.freeze(['3p-5h', '3p-weekly']) }),
});

const RFC3339_UTC = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z$/;
const RFC3339_OFFSET = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|([+-])(\d\d):(\d\d))$/;
const RFC3339_EMBEDDED = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)/g;
const INDIVIDUAL_QUOTA_PHRASE = /\bIndividual quota reached\b/;

const exactKeys = (value, keys) => value != null && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

function parseRfc3339Utc(value) {
  const m = typeof value === 'string' ? RFC3339_UTC.exec(value) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const ms = Number((m[7] ?? '0').padEnd(3, '0'));
  const time = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? time : null;
}

export function parseRfc3339WithOffset(value) {
  const m = typeof value === 'string' ? RFC3339_OFFSET.exec(value) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const ms = Number((m[7] ?? '0').padEnd(3, '0'));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    return null;
  }
  if (m[8] === 'Z') return wall;
  const sign = m[9] === '+' ? 1 : -1;
  const offH = Number(m[10]), offM = Number(m[11]);
  if (offH > 23 || offM > 59) return null;
  return wall - sign * (offH * 60 + offM) * 60 * 1000;
}

const isMacOwnerHost = () => process.platform === 'darwin' && typeof process.getuid === 'function';
export const agyHoldsPath = () => join(homedir(), '.config', 'opc', 'agy-model-holds.json');
export const devinReadyPath = () => join(homedir(), '.config', 'opc', 'devin-ready.json');
export const agyQuotaPath = () => join(homedir(), '.config', 'opc', 'agy-quota.json');

// Decision 399a / 397c: validates the Config-owned devin-ready.json projection strictly.
// Exact root {ready: boolean, as_of: RFC3339Z, expires_at: RFC3339Z, retry_at: string|null}, exact 180s window,
// ready === true only while as_of <= now < expires_at. Never emits retry_at or raw quota values.
export function isDevinReadyProjection(doc, now = Date.now()) {
  if (!exactKeys(doc, DEVIN_READY_KEYS) || typeof doc.ready !== 'boolean') return false;
  if (doc.retry_at !== null && parseRfc3339Utc(doc.retry_at) == null) return false;
  const asOf = parseRfc3339Utc(doc.as_of), expiresAt = parseRfc3339Utc(doc.expires_at);
  if (asOf == null || expiresAt == null || expiresAt - asOf !== DEVIN_READY_WINDOW_MS) return false;
  return doc.ready === true && asOf <= now && now < expiresAt;
}

export function readDevinReady(now = Date.now(), path = devinReadyPath()) {
  const doc = readOwnerJson(path);
  return isDevinReadyProjection(doc, now);
}

// Decision 399a: validates the Config-owned agy-quota.json projection strictly and reduces it to per-model booleans only.
// Exact root {ok: boolean, as_of: RFC3339Z, expires_at: RFC3339Z, reason?: string, buckets: Record<string, {group, left, reset}>}.
// Exact producer group labels: 'Gemini Models' (gemini-5h, gemini-weekly) for Neon; 'Claude and GPT models' (3p-5h,
// 3p-weekly) for agy Opus. A model is held iff either of its own buckets has left <= 0.02 and now < reset (past reset
// cannot hold). A full bucket (left === 1) may have reset: null until its window starts, and never holds.
// Unreadable, stale, ok !== true, or invalid projection is ignored cleanly (error holds remain active).
export function evaluateAgyQuotaProjection(doc, now = Date.now()) {
  const none = Object.freeze({ [REPLACEMENT_RUNTIME.model]: false, [OPUS_REPLACEMENT_RUNTIME.model]: false });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return none;
  const validRoot = exactKeys(doc, ['ok', 'as_of', 'expires_at', 'buckets']) ||
    (exactKeys(doc, ['ok', 'as_of', 'expires_at', 'reason', 'buckets']) && typeof doc.reason === 'string');
  if (!validRoot || typeof doc.ok !== 'boolean' || !doc.buckets || typeof doc.buckets !== 'object' || Array.isArray(doc.buckets)) {
    return none;
  }
  const asOf = parseRfc3339Utc(doc.as_of), expiresAt = parseRfc3339Utc(doc.expires_at);
  if (asOf == null || expiresAt == null || !(asOf < expiresAt)) return none;
  for (const bucket of Object.values(doc.buckets)) {
    if (!exactKeys(bucket, ['group', 'left', 'reset']) || typeof bucket.group !== 'string' || !bucket.group ||
        typeof bucket.left !== 'number' || !Number.isFinite(bucket.left) || bucket.left < 0 || bucket.left > 1 ||
        (!(bucket.left === 1 && bucket.reset === null) && parseRfc3339Utc(bucket.reset) == null)) {
      return none;
    }
  }
  if (doc.ok !== true || !(asOf <= now && now < expiresAt)) return none;
  const held = {};
  for (const [modelId, spec] of Object.entries(AGY_QUOTA_BUCKETS)) {
    let modelHeld = false;
    for (const bucketKey of spec.keys) {
      if (!Object.hasOwn(doc.buckets, bucketKey)) continue;
      const bucket = doc.buckets[bucketKey];
      if (bucket.group !== spec.group) return none;
      const resetMs = parseRfc3339Utc(bucket.reset);
      if (resetMs != null && bucket.left <= AGY_QUOTA_HOLD_THRESHOLD && now < resetMs) modelHeld = true;
    }
    held[modelId] = modelHeld;
  }
  return Object.freeze(held);
}

export function readAgyQuotaProjectionHolds(now = Date.now(), path = agyQuotaPath()) {
  const doc = readOwnerJson(path);
  return evaluateAgyQuotaProjection(doc, now);
}

export const oppositeAgyModel = model => model === OPUS_REPLACEMENT_RUNTIME.model
  ? REPLACEMENT_RUNTIME.model
  : model === REPLACEMENT_RUNTIME.model ? OPUS_REPLACEMENT_RUNTIME.model : null;

export const probeDirectionFor = fromModel => fromModel === OPUS_REPLACEMENT_RUNTIME.model
  ? 'oh_to_nh'
  : fromModel === REPLACEMENT_RUNTIME.model ? 'nh_to_oh' : null;

const emptyDoc = () => ({ schema: AGY_HOLDS_SCHEMA, holds: {}, probes: {} });

function validHoldEntry(entry) {
  if (!exactKeys(entry, ['recorded_at', 'until'])) return false;
  const recorded = parseRfc3339Utc(entry.recorded_at), until = parseRfc3339Utc(entry.until);
  return recorded != null && until != null && recorded < until && until - recorded <= MAX_HOLD_DURATION_MS;
}

function validProbeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const keys = entry.completed === true
    ? ['started_at', 'settled_at', 'completed', 'opposite_quota_reached', 'opposite_succeeded']
    : ['started_at', 'completed', 'opposite_quota_reached', 'opposite_succeeded'];
  if (!exactKeys(entry, keys) || typeof entry.completed !== 'boolean' ||
      typeof entry.opposite_quota_reached !== 'boolean' || typeof entry.opposite_succeeded !== 'boolean') {
    return false;
  }
  if (entry.opposite_quota_reached && entry.opposite_succeeded) return false;
  const started = parseRfc3339Utc(entry.started_at);
  if (started == null) return false;
  if (!entry.completed) return !entry.opposite_quota_reached && !entry.opposite_succeeded;
  const settled = parseRfc3339Utc(entry.settled_at);
  return settled != null && settled >= started;
}

function validDoc(doc) {
  if (!exactKeys(doc, ['schema', 'holds', 'probes']) || doc.schema !== AGY_HOLDS_SCHEMA) return false;
  if (!doc.holds || typeof doc.holds !== 'object' || Array.isArray(doc.holds) ||
      !doc.probes || typeof doc.probes !== 'object' || Array.isArray(doc.probes)) return false;
  const targetIds = new Set([...Object.keys(doc.holds), ...Object.keys(doc.probes)]);
  if (targetIds.size > MAX_HOLD_TARGETS) return false;
  for (const [targetId, models] of Object.entries(doc.holds)) {
    if (!isTargetId(targetId) || !models || typeof models !== 'object' || Array.isArray(models)) return false;
    for (const [model, entry] of Object.entries(models)) {
      if (!ALLOWED_MODELS.includes(model) || !validHoldEntry(entry)) return false;
    }
  }
  for (const [targetId, dirs] of Object.entries(doc.probes)) {
    if (!isTargetId(targetId) || !dirs || typeof dirs !== 'object' || Array.isArray(dirs)) return false;
    for (const [dir, entry] of Object.entries(dirs)) {
      if (!PROBE_DIRECTIONS.includes(dir) || !validProbeEntry(entry)) return false;
    }
  }
  return true;
}

// Strict Mac-only, owner-only (0600, no symlink, no repeated keys) reader.
// Absent (ENOENT) or empty (freshly created before lock) returns an empty state.
// Anything unreadable, unsafe, malformed, or off macOS returns null (fail closed).
export function readModelHolds(path = agyHoldsPath()) {
  if (!isMacOwnerHost()) return null;
  let text;
  try {
    const link = lstatSync(path);
    if (!link.isFile()) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev || stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 || stat.size > 1 << 20) return null;
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (error) {
    return error?.code === 'ENOENT' ? emptyDoc() : null;
  }
  if (text === '') return emptyDoc();
  try {
    if (repeatsKey(text)) return null;
    const doc = JSON.parse(text);
    return validDoc(doc) ? doc : null;
  } catch { return null; } // probe-ok: fails closed, malformed hold file admits no off-pace route; expires 2027-05-22
}

function writeModelHolds(path, doc) {
  const targetStamp = id => {
    const stamps = [
      ...Object.values(doc.holds[id] ?? {}).map(e => parseRfc3339Utc(e.recorded_at) ?? 0),
      ...Object.values(doc.probes[id] ?? {}).map(e => parseRfc3339Utc(e.settled_at ?? e.started_at) ?? 0),
    ];
    return stamps.length ? Math.max(...stamps) : 0;
  };
  const allIds = [...new Set([...Object.keys(doc.holds), ...Object.keys(doc.probes)])]
    .filter(id => Object.keys(doc.holds[id] ?? {}).length > 0 || Object.keys(doc.probes[id] ?? {}).length > 0)
    .sort((a, b) => targetStamp(b) - targetStamp(a))
    .slice(0, MAX_HOLD_TARGETS);
  const holds = {}, probes = {};
  for (const id of allIds) {
    if (doc.holds[id] && Object.keys(doc.holds[id]).length) holds[id] = doc.holds[id];
    if (doc.probes[id] && Object.keys(doc.probes[id]).length) probes[id] = doc.probes[id];
  }
  const normalized = { schema: AGY_HOLDS_SCHEMA, holds, probes };
  const temporary = join(resolve(path, '..'), `.agy-model-holds-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(normalized, null, 2) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  const dir = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function activeModelHold(doc, targetId, model, now = Date.now()) {
  if (!doc || !isTargetId(targetId) || !ALLOWED_MODELS.includes(model)) return null;
  const entry = Object.hasOwn(doc.holds, targetId) && Object.hasOwn(doc.holds[targetId], model)
    ? doc.holds[targetId][model] : null;
  if (!entry || !validHoldEntry(entry)) return null;
  const recorded = parseRfc3339Utc(entry.recorded_at), until = parseRfc3339Utc(entry.until);
  return recorded <= now && now < until ? Object.freeze({ recorded_at: entry.recorded_at, until: entry.until }) : null;
}

export function probePoolRelation(entry) {
  if (!entry || !validProbeEntry(entry) || entry.completed !== true) return 'unknown';
  if (entry.opposite_quota_reached === true && entry.opposite_succeeded === false) return 'shared';
  if (entry.opposite_succeeded === true && entry.opposite_quota_reached === false) return 'separate';
  return 'unknown';
}

export function readOppositeModelProbe(targetId, direction, doc = readModelHolds()) {
  if (!doc || !isTargetId(targetId) || !PROBE_DIRECTIONS.includes(direction)) return 'unknown';
  const entry = Object.hasOwn(doc.probes, targetId) && Object.hasOwn(doc.probes[targetId], direction)
    ? doc.probes[targetId][direction] : null;
  return probePoolRelation(entry);
}

function verifyProbeTarget(target, remote, localServer = undefined) {
  if (!exactKeys(target, TARGET_KEYS) || !isTargetId(target.daemon) || typeof target.local !== 'boolean') {
    throw Error('unsafe or invalid probe target');
  }
  if (target.local === false) {
    if (!verifiedRemote(remote, target)) throw Error('unverified remote target for probe');
    return target.daemon;
  }
  if (target.platform !== 'darwin' || remote != null || isMappedServer(target.daemon)) {
    throw Error('unsafe or invalid local Mac target for probe');
  }
  const actual = localServer === undefined ? localServerId() : localServer;
  if (actual !== target.daemon) throw Error('local daemon does not match probe target');
  return target.daemon;
}

// Validates an authenticated daemon terminal agent error attestation (from readAuthenticatedAgentTerminal in
// remote-target.mjs) for an exact launched agy-opc agent/model. Never accepts a self-labelled caller object.
// requireLane (default for recordAgyQuotaHold): the erroring agent must be the exact launched Worker of a recorded
// replacement lane (daemon-reported model/provider/labels/serverId all match the lane receipt, and its agent and workspace
// ids are a launch recorded on that lane by validateManagedWorkerLaunch), so an arbitrary agy-opc agent on the daemon, one
// that only copies the lane's labels, or one whose labels name another lane or route, can never write a hold.
function normalizeAuthenticatedTerminalQuota({ target, terminal, task = null, lane = null }, now, { requireLane = true } = {}) {
  if (!isMacOwnerHost()) throw Error('agy model holds are macOS-only; no hold recorded');
  const verified = verifiedAgentTerminalError(terminal, target, now);
  if (!verified) {
    throw Error('authenticated daemon terminal error attestation required; self-labelled caller objects are refused');
  }
  const { handle, lastError } = verified;
  if (handle.provider !== REPLACEMENT_RUNTIME.provider || !ALLOWED_MODELS.includes(handle.model)) {
    throw Error('launched agent is not on an approved agy-opc model; no hold recorded');
  }
  if (requireLane || task != null || lane != null) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string' || typeof lane !== 'string' || !lane) {
      throw Error('both task record and lane required when binding terminal quota hold; no hold recorded');
    }
    const recorded = task.routes && Object.hasOwn(task.routes, lane) ? task.routes[lane]?.route : null;
    if (!recorded || recorded.source !== 'replacement' || recorded.model !== handle.model ||
        recorded.receipt?.provider !== handle.provider || recorded.receipt?.target !== handle.serverId ||
        recorded.receipt?.task !== task.id || recorded.receipt?.lane !== lane ||
        handle.labels['opc.worker-task'] !== task.id || handle.labels['opc.worker-lane'] !== lane ||
        handle.labels['opc.route-source'] !== 'replacement') {
      throw Error('launched agent identity, labels, or model do not match recorded task lane; no hold recorded');
    }
    const launches = task.launches && Object.hasOwn(task.launches, lane) && Array.isArray(task.launches[lane]) ? task.launches[lane] : [];
    if (!launches.some(entry => entry?.agent_id === handle.agentId && typeof handle.workspaceId === 'string' &&
        entry.workspace_id === handle.workspaceId)) {
      throw Error('the agent is not a Worker launch recorded on this lane (agent and workspace ids); no hold recorded');
    }
  }
  if (typeof lastError !== 'string' || !lastError || lastError.length > MAX_MESSAGE_CHARS ||
      !INDIVIDUAL_QUOTA_PHRASE.test(lastError)) {
    throw Error('authenticated terminal error is not an exact Individual quota reached event; no hold recorded');
  }
  const matches = lastError.match(RFC3339_EMBEDDED) ?? [];
  const parsed = [];
  for (const token of matches) {
    const ms = parseRfc3339WithOffset(token);
    if (ms == null) throw Error('invalid reset timestamp in authenticated terminal error; no hold recorded');
    parsed.push(ms);
  }
  const distinct = [...new Set(parsed)];
  if (distinct.length !== 1) {
    throw Error('missing or ambiguous reset timestamp in authenticated terminal error; no hold recorded');
  }
  const untilMs = distinct[0];
  if (!(untilMs > now && untilMs - now <= MAX_HOLD_DURATION_MS)) {
    throw Error('unbounded or expired reset timestamp in authenticated terminal error; no hold recorded');
  }
  return Object.freeze({
    targetId: handle.serverId,
    model: handle.model,
    recordedAt: new Date(now).toISOString(),
    until: new Date(untilMs).toISOString(),
  });
}

function withHoldsLock(path, fn) {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return withFileLock(path, held => {
    const current = readModelHolds(path);
    if (current == null) throw Error('agy model holds file is unsafe or malformed; no update written');
    return fn(current, held);
  }, 'model-holds lock', HOLDS_LOCK_WAIT_MS);
}

function pruneExpiredHolds(holds, now) {
  const next = {};
  for (const [targetId, models] of Object.entries(holds)) {
    const kept = {};
    for (const [model, entry] of Object.entries(models)) {
      const until = parseRfc3339Utc(entry.until);
      if (until != null && until > now) kept[model] = entry;
    }
    if (Object.keys(kept).length) next[targetId] = kept;
  }
  return next;
}

// Records a normalized Mac-only owner-only per-model hold strictly from an authenticated daemon terminal error
// attestation (readAuthenticatedAgentTerminal) for an exact launched agy-opc agent/model.
export function recordAgyQuotaHold({ target, terminal, task = null, lane = null } = {},
  { now = Date.now(), path = agyHoldsPath() } = {}) {
  const normalized = normalizeAuthenticatedTerminalQuota({ target, terminal, task, lane }, now);
  const direction = probeDirectionFor(normalized.model);
  const oppositeModel = oppositeAgyModel(normalized.model);
  return withHoldsLock(path, (current, held) => {
    const holds = pruneExpiredHolds(current.holds, now);
    holds[normalized.targetId] = {
      ...(holds[normalized.targetId] ?? {}),
      [normalized.model]: { recorded_at: normalized.recordedAt, until: normalized.until },
    };
    const probes = structuredClone(current.probes);
    if (!held()) throw Error('model-holds lock lost; hold not written');
    writeModelHolds(path, { schema: AGY_HOLDS_SCHEMA, holds, probes });
    const probeEligible = direction != null &&
      !(Object.hasOwn(probes, normalized.targetId) && Object.hasOwn(probes[normalized.targetId], direction));
    return Object.freeze({
      recorded: true,
      target: normalized.targetId,
      model: normalized.model,
      active: true,
      probeEligible,
      probeDirection: direction,
      oppositeModel,
    });
  });
}

export function beginOppositeModelProbe({ target, fromModel, remote = null } = {},
  { now = Date.now(), path = agyHoldsPath(), localServer = undefined } = {}) {
  if (!isMacOwnerHost()) throw Error('agy model probes are macOS-only');
  const direction = probeDirectionFor(fromModel), oppositeModel = oppositeAgyModel(fromModel);
  if (!direction || !oppositeModel) throw Error('unknown agy source model for opposite-model probe');
  const targetId = verifyProbeTarget(target, remote, localServer);
  return withHoldsLock(path, (current, held) => {
    if (!activeModelHold(current, targetId, fromModel, now)) {
      return Object.freeze({ allowed: false, reason: 'no-active-source-hold', target: targetId, direction, oppositeModel });
    }
    const existing = Object.hasOwn(current.probes, targetId) && Object.hasOwn(current.probes[targetId], direction)
      ? current.probes[targetId][direction] : null;
    if (existing) {
      return Object.freeze({
        allowed: false, reason: 'already-probed', target: targetId, direction, oppositeModel,
        relation: probePoolRelation(existing),
      });
    }
    const holds = pruneExpiredHolds(current.holds, now);
    const probes = structuredClone(current.probes);
    probes[targetId] = {
      ...(probes[targetId] ?? {}),
      [direction]: {
        started_at: new Date(now).toISOString(),
        completed: false,
        opposite_quota_reached: false,
        opposite_succeeded: false,
      },
    };
    if (!held()) throw Error('model-holds lock lost; probe state not written');
    writeModelHolds(path, { schema: AGY_HOLDS_SCHEMA, holds, probes });
    return Object.freeze({ allowed: true, target: targetId, direction, fromModel, oppositeModel });
  });
}

export function settleOppositeModelProbe({ target, fromModel, outcome, terminal = null, remote = null } = {},
  { now = Date.now(), path = agyHoldsPath(), localServer = undefined } = {}) {
  if (!isMacOwnerHost()) throw Error('agy model probes are macOS-only');
  const direction = probeDirectionFor(fromModel), oppositeModel = oppositeAgyModel(fromModel);
  if (!direction || !oppositeModel) throw Error('unknown agy source model for opposite-model probe');
  if (!['succeeded', 'quota_reached', 'unknown'].includes(outcome)) {
    throw Error('opposite-model probe outcome must be succeeded, quota_reached, or unknown');
  }
  const targetId = verifyProbeTarget(target, remote, localServer);
  let oppositeHold = null;
  if (outcome === 'quota_reached') {
    oppositeHold = normalizeAuthenticatedTerminalQuota({ target, terminal }, now, { requireLane: false });
    if (oppositeHold.targetId !== targetId || oppositeHold.model !== oppositeModel) {
      throw Error('authenticated opposite-model terminal error does not match probe target and model');
    }
  } else if (terminal != null) {
    throw Error('terminal attestation is allowed only for quota_reached probe outcome');
  }
  return withHoldsLock(path, (current, held) => {
    const existing = Object.hasOwn(current.probes, targetId) && Object.hasOwn(current.probes[targetId], direction)
      ? current.probes[targetId][direction] : null;
    if (!existing) throw Error('no started opposite-model probe for this target and direction');
    if (existing.completed) throw Error('opposite-model probe is already settled; no retries');
    const startedMs = parseRfc3339Utc(existing.started_at);
    const settledMs = Math.max(now, startedMs);
    const holds = pruneExpiredHolds(current.holds, now);
    if (oppositeHold) {
      holds[targetId] = {
        ...(holds[targetId] ?? {}),
        [oppositeHold.model]: { recorded_at: oppositeHold.recordedAt, until: oppositeHold.until },
      };
    }
    const settled = {
      started_at: existing.started_at,
      settled_at: new Date(settledMs).toISOString(),
      completed: true,
      opposite_quota_reached: outcome === 'quota_reached',
      opposite_succeeded: outcome === 'succeeded',
    };
    const probes = structuredClone(current.probes);
    probes[targetId] = { ...(probes[targetId] ?? {}), [direction]: settled };
    if (!held()) throw Error('model-holds lock lost; probe settlement not written');
    writeModelHolds(path, { schema: AGY_HOLDS_SCHEMA, holds, probes });
    return Object.freeze({
      recorded: true,
      target: targetId,
      direction,
      oppositeModel,
      relation: probePoolRelation(settled),
    });
  });
}

// The error backstop of the documented OPC and OPN launch workflow: when a launched agy-opc replacement Worker of a
// recorded lane finishes in error, the PM runs `node scripts/agy-holds.mjs record-terminal --task TASK_JSON --lane SLUG
// --agent AGENT_ID`. The target is the lane's own recorded receipt target (never a caller's), the failure is read from
// that daemon's own agent snapshot over the authenticated SDK, and recordAgyQuotaHold binds it to the lane's Worker.
// Prints only booleans, the model, and the probe direction; anything not an exact quota event records nothing.
export async function recordLaunchedWorkerQuotaHold({ taskPath, lane, agentId } = {}, { now = undefined } = {}) {
  const task = readTask(taskPath);
  const recorded = typeof lane === 'string' && task.routes && Object.hasOwn(task.routes, lane) ? task.routes[lane].route : null;
  if (recorded?.source !== 'replacement' || !isTargetId(recorded.receipt?.target)) {
    throw Error('the lane has no recorded agy-opc replacement route; no hold recorded');
  }
  const daemon = recorded.receipt.target;
  let target;
  if (isMappedServer(daemon)) {
    const entry = readRemoteTargets()?.targets?.[daemon];
    if (!entry || entry.state !== 'armed') throw Error('the recorded remote target is not armed; no hold recorded');
    target = { daemon, local: false, platform: entry.platform };
  } else {
    target = { daemon, local: true, platform: 'darwin' };
  }
  const terminal = await readAuthenticatedAgentTerminal({ target, agentId });
  return recordAgyQuotaHold({ target, terminal, task, lane }, now === undefined ? {} : { now });
}

async function main(argv) {
  const usage = 'usage: agy-holds.mjs record-terminal --task TASK_JSON --lane SLUG --agent AGENT_ID';
  if (argv[0] !== 'record-terminal' || argv.length !== 7) throw Error(usage);
  const flags = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--task', '--lane', '--agent'].includes(key) || Object.hasOwn(flags, key)) throw Error(usage);
    flags[key] = argv[i + 1];
  }
  const result = await recordLaunchedWorkerQuotaHold({ taskPath: flags['--task'], lane: flags['--lane'], agentId: flags['--agent'] });
  console.log(JSON.stringify({ recorded: result.recorded, model: result.model, probeEligible: result.probeEligible,
    probeDirection: result.probeDirection }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

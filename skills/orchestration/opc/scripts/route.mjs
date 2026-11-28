#!/usr/bin/env node
// Single deterministic Worker/policy route resolver. A PM launch (managed or in-place) and `node scripts/route.mjs`
// share resolveWorkerRoute, binding every fresh launch to the exact lane, target, and live Mac policy/projections.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  assertLiveResolution, canonicalWorkerClass, CURSOR_OVERFLOW_REASON, CURSOR_OVERFLOW_RUNTIME, CURSOR_OVERFLOW_SOURCE,
  cursorEligibilityProblem, DEVIN_FIRST_CLASSES, DEVIN_FIRST_RUNTIME, DEVIN_FIRST_SOURCE,
  devinFirstReason, isReplacementMode, isTargetId, isUiRoute, launcherChain, LEGACY_OFF_PACE_CLASSES,
  isOpnBrowserRoute, localServerId, MAIN_PM_POLICY, OFF_PACE_CLASSES, OFF_PACE_SOURCES, offPaceLaunchAllowed, OPN_BROWSER_EXCEPTION,
  OPUS_REPLACEMENT_RUNTIME, OWNER_RULE_ROUTES, PACE_BACKUP_RUNTIME, paceBackupReason, PARITY_BACKUP_REASON,
  parityReason, readLocalRouting, readOwnerJsonFile, recordedLaneEntry, replacementReason, REPLACEMENT_RUNTIME,
  replacementRuntimeForModel, resolveOpnBrowserRow, routeReason, selectWorkerRoute, stampLiveResolution, UI_CLASSES,
  uiTaskLaneClass, validateLaneClass, validateRoleRoute, WORKER_DEFAULT_ROUTES, workerRouteUnresolved,
} from './agent-routing.mjs';
import {
  activeModelHold, isDevinReadyProjection, readAgyQuotaProjectionHolds, readDevinReady, readModelHolds,
} from './agy-holds.mjs';
import { managedWorkerNames } from './paseo-worker.mjs';
import {
  isMappedServer, remoteAgyProviderUnavailable, remoteCursorStep, remoteServesBackup, remoteServesModel, remoteServesNeon,
  remoteServesOpus, verifiedRemote,
} from './remote-target.mjs';
import { readTask, updateTask, withFileLock } from './task-state.mjs';

const usage = 'usage: route.mjs --class <class|main-pm|opn-browser> [--catalog FILE] ' +
  '[--owner-model ID --owner-effort LEVEL [--owner-fast on|off]] [--task TASK_JSON --lane SLUG]';

const RFC3339_UTC = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z$/;
function utcTime(value) {
  const m = typeof value === 'string' ? RFC3339_UTC.exec(value) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute, second, Number((m[7] ?? '0').padEnd(3, '0')));
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? time : null;
}
const exactKeys = (value, keys) => value != null && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

function switchMode(doc, now) {
  const fallback = doc?.antigravityFallback;
  if (!exactKeys(fallback, ['enabled', 'state']) || typeof fallback.enabled !== 'boolean') return null;
  const { state } = fallback;
  if (!exactKeys(state, ['off_pace', 'as_of', 'expires_at']) || state.off_pace !== fallback.enabled) return null;
  const asOf = utcTime(state.as_of), expiresAt = utcTime(state.expires_at);
  if (asOf == null || expiresAt == null || !(asOf < expiresAt && asOf <= now && now < expiresAt)) return null;
  return fallback.enabled ? 'forced' : 'parity';
}

// Owner decision 435a: the Config-published Linux copy of routing.json, read with the same strict owner-file checks as
// the Mac file, and only its antigravityFallback key; every other key is dropped unread. 'forced' (fresh, both true)
// sends the route CLI to the Mac; anything else (missing, stale, unsafe, parity) keeps the current Linux local policy.
function linuxSwitchMode(now = Date.now()) {
  if (process.platform !== 'linux') return null;
  const doc = readOwnerJsonFile(join(homedir(), '.config', 'opc', 'routing.json'));
  return doc ? switchMode({ antigravityFallback: doc.antigravityFallback }, now) : null;
}
const linuxForcedRefusal = () => Error('fresh off pace on Linux: a code lane is decided on the Mac, and no Linux code ' +
  'route is admitted locally; resolve it with route.mjs, which asks the Mac, or wait until the Linux switch is not forced');

// Decision 399a / 397c: exported pure validator for Config-owned devin-ready.json; live resolution always reads the
// Mac file directly (no caller override).
export const isDevinFirstReady = (signal, now = Date.now()) => isDevinReadyProjection(signal, now);

// Live local policy snapshot used to verify at launch time that routing.json, devin-ready.json, agy-quota.json,
// agy-model-holds.json, the launcher and Cursor exclusion lists, and the local daemon have not drifted since resolveWorkerRoute ran.
function liveLocalPolicySnapshot(taskClass, now = Date.now()) {
  if (process.platform !== 'darwin') return 'non-darwin';
  const localSrv = localServerId();
  const doc = readLocalRouting();
  const mode = switchMode(doc, now);
  const devin = readDevinReady(now);
  const proj = readAgyQuotaProjectionHolds(now);
  const holds = readModelHolds();
  const holdsOk = holds != null;
  const heldNH = holdsOk && localSrv ? activeModelHold(holds, localSrv, REPLACEMENT_RUNTIME.model, now) != null : false;
  const heldOH = holdsOk && localSrv ? activeModelHold(holds, localSrv, OPUS_REPLACEMENT_RUNTIME.model, now) != null : false;
  const exclusions = [doc?.replacementExcludedLaunchers ?? null, doc?.cursorExcludedProjects ?? null];
  return JSON.stringify([taskClass, localSrv, mode, devin, proj, holdsOk, heldNH, heldOH, exclusions]);
}

const alternationPath = () => join(homedir(), '.config', 'opc', 'code-alternation.json');
const MAX_LAUNCHERS = 256;
const launcherId = id => typeof id === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(id);
function readAlternation(path = alternationPath()) {
  let text;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd), link = lstatSync(path);
      if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev || stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 || stat.size > 1 << 20) return null;
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (error) { return error.code === 'ENOENT' ? { launchers: {} } : null; }
  if (text === '') return { launchers: {} };
  try {
    const doc = JSON.parse(text), launchers = doc?.launchers;
    if (!exactKeys(doc, ['launchers']) || launchers == null || typeof launchers !== 'object' || Array.isArray(launchers) ||
        Object.keys(launchers).length > MAX_LAUNCHERS || Object.entries(launchers).some(([id, entry]) => !launcherId(id) ||
          !exactKeys(entry, ['admitted', 'at']) || !Number.isSafeInteger(entry.admitted) || entry.admitted < 0 || utcTime(entry.at) == null)) {
      return null;
    }
    return doc;
  } catch { return null; } // probe-ok: fails closed, a malformed alternation state keeps every lane on Opus; expires 2027-05-22
}
function writeAlternation(path, doc) {
  const entries = Object.entries(doc.launchers).sort(([, a], [, b]) => utcTime(b.at) - utcTime(a.at)).slice(0, MAX_LAUNCHERS);
  const temporary = join(resolve(path, '..'), `.code-alternation-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ launchers: Object.fromEntries(entries) }, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  const dir = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

const REPLACEMENT_PROOF_MAX_AGE_MS = 60 * 60 * 1000;
const recent = (value, now) => { const at = utcTime(value); return at != null && at <= now && now - at <= REPLACEMENT_PROOF_MAX_AGE_MS; };

const validTarget = target => exactKeys(target, ['daemon', 'local', 'platform']) && isTargetId(target.daemon) &&
  target.local === true && target.platform === 'darwin';

// Resolve/record only accepts resolve-time remote attestations (workspace === null), never launch-only attestations.
const admissibleTarget = context => context?.target?.local === false
  ? verifiedRemote(context.remote, context.target) && context.remote.workspace === null && context.unavailable === undefined &&
    (remoteServesNeon(context.remote) || remoteServesOpus(context.remote) ||
      (remoteAgyProviderUnavailable(context.remote) && remoteServesBackup(context.remote)))
  : validTarget(context?.target) && context?.remote === undefined && !isMappedServer(context.target.daemon);

const PROOF_KEYS = ['provider', 'extends', 'model', 'thinking', 'mode', 'sandboxed', 'write', 'target', 'verified_at'];
function parseProofs(proof, target, now) {
  const byModel = new Map();
  if (proof === undefined) return { valid: true, byModel };
  const list = Array.isArray(proof) ? proof : [proof];
  if (list.length === 0 || list.length > 2) return { valid: false, byModel };
  const seen = new Set();
  for (const item of list) {
    if (!exactKeys(item, PROOF_KEYS)) return { valid: false, byModel };
    const runtime = replacementRuntimeForModel(item.model);
    if (!runtime || item.provider !== runtime.provider || item.extends !== runtime.extends ||
        item.thinking !== runtime.effort || !isReplacementMode(item.mode) || item.sandboxed !== true ||
        item.write !== true || !isDeepStrictEqual(item.target, target) || seen.has(runtime.model)) {
      return { valid: false, byModel };
    }
    seen.add(runtime.model);
    const verifiedAt = utcTime(item.verified_at);
    if (verifiedAt == null) return { valid: false, byModel };
    if (verifiedAt <= now && now - verifiedAt <= REPLACEMENT_PROOF_MAX_AGE_MS) {
      byModel.set(runtime.model, { verifiedAt, mode: item.mode });
    }
  }
  return { valid: true, byModel };
}

const UNAVAILABLE_FINDINGS = ['missing', 'disabled', 'not-available', 'not-serving'];
const PROVIDER_UNAVAILABLE_KEYS = ['provider', 'target', 'checked_at', 'finding'];
const MODEL_UNAVAILABLE_KEYS = ['provider', 'target', 'checked_at', 'finding', 'model'];
function parseUnavailable(unavailable, target, now) {
  const byModel = new Map();
  if (unavailable === undefined) return { valid: true, byModel };
  if (!validTarget(target)) return { valid: false, byModel };
  const list = Array.isArray(unavailable) ? unavailable : [unavailable];
  if (list.length === 0 || list.length > 2) return { valid: false, byModel };
  const record = (modelId, at) => {
    const prev = byModel.get(modelId);
    if (prev == null || at > prev) byModel.set(modelId, at);
  };
  for (const item of list) {
    const isProviderWide = exactKeys(item, PROVIDER_UNAVAILABLE_KEYS);
    const isModelScoped = !isProviderWide && exactKeys(item, MODEL_UNAVAILABLE_KEYS);
    if (!isProviderWide && !isModelScoped) return { valid: false, byModel };
    if (item.provider !== REPLACEMENT_RUNTIME.provider || !isDeepStrictEqual(item.target, target)) {
      return { valid: false, byModel };
    }
    const checkedAt = utcTime(item.checked_at);
    if (checkedAt == null) return { valid: false, byModel };
    if (isProviderWide) {
      if (!UNAVAILABLE_FINDINGS.includes(item.finding)) return { valid: false, byModel };
      if (checkedAt <= now && now - checkedAt <= REPLACEMENT_PROOF_MAX_AGE_MS) {
        record(REPLACEMENT_RUNTIME.model, checkedAt);
        record(OPUS_REPLACEMENT_RUNTIME.model, checkedAt);
      }
    } else {
      const runtime = replacementRuntimeForModel(item.model);
      if (!runtime || item.finding !== 'not-serving') return { valid: false, byModel };
      if (checkedAt <= now && now - checkedAt <= REPLACEMENT_PROOF_MAX_AGE_MS) {
        record(runtime.model, checkedAt);
      }
    }
  }
  return { valid: true, byModel };
}

const FABLE_UNAVAILABLE_KEYS = ['provider', 'model', 'target', 'checked_at', 'finding'];
const FABLE_UNAVAILABLE_FINDINGS = ['not-serving', 'quota-exhausted', 'unavailable'];
function fableCannotServe(evidence, target, now) {
  if (evidence === undefined) return false;
  if (!exactKeys(evidence, FABLE_UNAVAILABLE_KEYS)) return false;
  return evidence.provider === 'pi' && typeof evidence.model === 'string' &&
    /(?:^|[/._-])fable(?:$|[/._[-])/i.test(evidence.model) &&
    isDeepStrictEqual(evidence.target, target) &&
    FABLE_UNAVAILABLE_FINDINGS.includes(evidence.finding) && recent(evidence.checked_at, now);
}

const piServesRow = (catalog, expected) => {
  const rows = Array.isArray(catalog) ? catalog : catalog?.pi;
  return rows?.filter(row => row?.id === expected.model && row.label === expected.label &&
    row.thinkingOptions?.some(option => option?.id === expected.effort)).length === 1;
};

// Decision 393a / 398a / 399a ladder evaluation: agy Neon High -> agy Opus High -> (eligible bounded code lane on the
// configured Cursor host only: Cursor Neon) -> Sol Medium Fast off.
// On remote targets, partial model capability subsets NEVER prove agy unavailable: the steps past agy require EITHER
// provider-level positive unavailability on a resolve read of that target (agy-opc missing or disabled) OR both NH and OH
// served by remote agy-opc and both covered by active authentic Mac error holds. cursorEligible is the caller's
// cursorEligibilityProblem() === null for this task, lane, and target; Cursor that is unknown fails closed, and only
// ineligible or positively unavailable Cursor passes to Sol.
function evaluateAgyLadder({ targetId, isRemote, remote, proof, unavailable, target, catalog, holdsDoc, projectionHolds, now,
  cursorEligible = false }) {
  const nhModel = REPLACEMENT_RUNTIME.model, ohModel = OPUS_REPLACEMENT_RUNTIME.model;
  const heldNH = (targetId != null && activeModelHold(holdsDoc, targetId, nhModel, now) != null) ||
    (!isRemote && projectionHolds?.[nhModel] === true);
  const heldOH = (targetId != null && activeModelHold(holdsDoc, targetId, ohModel, now) != null) ||
    (!isRemote && projectionHolds?.[ohModel] === true);
  const proofs = target ? parseProofs(proof, target, now) : { valid: true, byModel: new Map() };
  const unavails = target && !isRemote ? parseUnavailable(unavailable, target, now) : { valid: true, byModel: new Map() };
  if (!proofs.valid || !unavails.valid) return { status: 'invalid-evidence' };
  const proofNH = proofs.byModel.get(nhModel) ?? null, proofOH = proofs.byModel.get(ohModel) ?? null;
  const solServed = isRemote ? remoteServesBackup(remote) : piServesRow(catalog, PACE_BACKUP_RUNTIME);

  if (isRemote) {
    const providerDown = remoteAgyProviderUnavailable(remote);
    const servesNH = remoteServesModel(remote, nhModel);
    const servesOH = remoteServesModel(remote, ohModel);
    const cursor = cursorEligible ? remoteCursorStep(remote) : { status: 'unavailable' };
    const solProvider = solServed ? `pi/${PACE_BACKUP_RUNTIME.model}` : null;
    const pastAgy = () => {
      if (cursor.status === 'available') {
        return { status: 'admitted', kind: 'cursor', runtime: CURSOR_OVERFLOW_RUNTIME, mode: cursor.mode, nextFallback: solProvider };
      }
      if (cursor.status !== 'unavailable') return { status: 'proof-required', runtime: CURSOR_OVERFLOW_RUNTIME, nextFallback: solProvider };
      return solServed
        ? { status: 'admitted', kind: 'backup', runtime: PACE_BACKUP_RUNTIME, nextFallback: null }
        : { status: 'unavailable' };
    };
    if (providerDown) return pastAgy();
    const nextAfterOH = cursor.status === 'available' ? `${CURSOR_OVERFLOW_RUNTIME.provider}/${CURSOR_OVERFLOW_RUNTIME.model}` : solProvider;
    const nextAfterNH = servesOH ? `${OPUS_REPLACEMENT_RUNTIME.provider}/${OPUS_REPLACEMENT_RUNTIME.model}` : null;
    if (servesNH && !heldNH) {
      return proofNH
        ? { status: 'admitted', kind: 'replacement', runtime: REPLACEMENT_RUNTIME, mode: proofNH.mode, nextFallback: nextAfterNH }
        : { status: 'proof-required', runtime: REPLACEMENT_RUNTIME, nextFallback: nextAfterNH };
    }
    // Capability subset (e.g. NH missing while agy-opc is ready, or OH missing while NH is held) never unlocks remote Sol!
    if (servesOH && !heldOH) {
      if (!servesNH && !heldNH) {
        // Remote agy-opc serves OH only without NH: allow OH only with OH proof (never unlocks Sol if OH later fails).
        return proofOH
          ? { status: 'admitted', kind: 'replacement', runtime: OPUS_REPLACEMENT_RUNTIME, mode: proofOH.mode, nextFallback: null }
          : { status: 'proof-required', runtime: OPUS_REPLACEMENT_RUNTIME, nextFallback: null };
      }
      return proofOH
        ? { status: 'admitted', kind: 'replacement', runtime: OPUS_REPLACEMENT_RUNTIME, mode: proofOH.mode, nextFallback: nextAfterOH }
        : { status: 'proof-required', runtime: OPUS_REPLACEMENT_RUNTIME, nextFallback: nextAfterOH };
    }
    // Only when BOTH NH and OH are genuinely served and BOTH have active authentic Mac holds may remote Cursor or Sol admit.
    if (servesNH && servesOH && heldNH && heldOH) return pastAgy();
    return { status: 'subset-unproven' };
  }

  const unavailNH = unavails.byModel.has(nhModel) && (!proofNH || unavails.byModel.get(nhModel) > proofNH.verifiedAt);
  const unavailOH = unavails.byModel.has(ohModel) && (!proofOH || unavails.byModel.get(ohModel) > proofOH.verifiedAt);
  const blockedNH = heldNH || unavailNH, blockedOH = heldOH || unavailOH;
  const readyNH = !blockedNH && proofNH != null, readyOH = !blockedOH && proofOH != null;
  const nextAfterOH = solServed ? `pi/${PACE_BACKUP_RUNTIME.model}` : null;
  const nextAfterNH = blockedOH ? nextAfterOH : `${OPUS_REPLACEMENT_RUNTIME.provider}/${OPUS_REPLACEMENT_RUNTIME.model}`;

  if (readyNH) {
    return { status: 'admitted', kind: 'replacement', runtime: REPLACEMENT_RUNTIME, mode: proofNH.mode, nextFallback: nextAfterNH };
  }
  if (!blockedNH) {
    return { status: 'proof-required', runtime: REPLACEMENT_RUNTIME, nextFallback: nextAfterNH };
  }
  if (readyOH) {
    return { status: 'admitted', kind: 'replacement', runtime: OPUS_REPLACEMENT_RUNTIME, mode: proofOH.mode, nextFallback: nextAfterOH };
  }
  if (!blockedOH) {
    return { status: 'proof-required', runtime: OPUS_REPLACEMENT_RUNTIME, nextFallback: nextAfterOH };
  }
  if (solServed) {
    return { status: 'admitted', kind: 'backup', runtime: PACE_BACKUP_RUNTIME, nextFallback: null };
  }
  return { status: 'unavailable' };
}

const REPLACEMENT_CONTEXT_KEYS = ['task', 'lane', 'proof', 'target', 'unavailable', 'remote', 'fableUnavailable'];
const SPECIAL_SOURCES = Object.freeze([...OFF_PACE_SOURCES, DEVIN_FIRST_SOURCE]);  // OFF_PACE_SOURCES includes cursor-overflow
const ALTERNATION_SOURCES = Object.freeze(['task-default', ...OFF_PACE_SOURCES]);
const offPaceRule = kind => kind === 'code' ? WORKER_DEFAULT_ROUTES.code
  : kind === 'plan' ? WORKER_DEFAULT_ROUTES.plan
    : Object.hasOwn(OWNER_RULE_ROUTES, kind ?? '') ? OWNER_RULE_ROUTES[kind] : null;

function providerForRoute(route, taskClass) {
  if (route.source === 'replacement') return `${route.receipt?.provider ?? REPLACEMENT_RUNTIME.provider}/${route.model}`;
  if (route.source === CURSOR_OVERFLOW_SOURCE) return `${CURSOR_OVERFLOW_RUNTIME.provider}/${route.model}`;
  if (['browser', 'browser-hard', 'sites'].includes(canonicalWorkerClass(taskClass ?? route.kind))) return `codex/${route.model}`;
  return `pi/${route.model}`;
}

function decisionEnvelope({ route, reason, provider, host = 'local', nextFallback = null, proofRequired = false,
  fallbackChain = null, taskClass = null, taskId = null, lane = null, launchable = true, inPlaceAllowed = false,
  verifyLive = null }) {
  if (route?.role === 'worker' && launchable) {
    const boundClass = taskClass === 'opn-browser' ? 'opn-browser' : (canonicalWorkerClass(taskClass ?? route.kind) ?? null);
    stampLiveResolution(route, {
      taskId, lane, taskClass: boundClass, targetDaemon: host, launchable: true, inPlaceAllowed, verifyLive,
    });
  }
  return Object.freeze({
    route,
    reason,
    provider,
    model: route.model,
    effort: route.effort,
    fast: route.fastMode,
    host,
    nextFallback,
    proofRequired,
    ...(fallbackChain ? { fallbackChain } : {}),
  });
}

// Bound admission for fresh eligible lanes (397c/399a Devin-first Pi Opus High; forced 393a code NH -> OH -> Sol;
// 390a plan/ui Fable High with agy ladder ONLY on positive fresh Fable cannot-serve evidence; 359 code parity).
// Evaluates Devin-first and positive Fable unavailability BEFORE requiring Fable in the Pi catalog.
function offPaceAdmission(context, { taskClass, catalog }, state, pre = null) {
  const { task, lane, proof, target, unavailable, remote, fableUnavailable } = context ?? {};
  const kind = canonicalWorkerClass(taskClass), rule = offPaceRule(kind), now = Date.now();
  const expectedLabel = kind === 'code' ? 'Opus' : 'Fable';
  if (context == null || typeof context !== 'object' || Object.keys(context).some(key => !REPLACEMENT_CONTEXT_KEYS.includes(key)) ||
      !LEGACY_OFF_PACE_CLASSES.includes(kind) || !rule ||
      rule.label !== expectedLabel || rule.effort !== 'high' || rule.fastMode !== false) return null;
  if (!task || typeof task !== 'object' || (!UI_CLASSES.includes(kind) && task.ui === true) ||
      typeof task.id !== 'string' || typeof lane !== 'string' || (task.routes && Object.hasOwn(task.routes, lane))) return null;

  const { branchName } = managedWorkerNames({ taskId: task.id, lane });

  // 1. Settled precedence (397c/399a): positive fresh Mac devin-ready.json FIRST (before Fable catalog lookup!).
  if (DEVIN_FIRST_CLASSES.includes(kind) && readDevinReady(now) && piServesRow(catalog, DEVIN_FIRST_RUNTIME)) {
    const route = Object.freeze({
      role: 'worker', source: DEVIN_FIRST_SOURCE, kind, model: DEVIN_FIRST_RUNTIME.model,
      effort: DEVIN_FIRST_RUNTIME.effort, fastMode: DEVIN_FIRST_RUNTIME.fastMode,
      reason: devinFirstReason(kind),
      receipt: Object.freeze({ task: task.id, lane, placement: branchName }),
    });
    return Object.freeze({ route, parity: null, host: target?.daemon ?? 'local', nextFallback: null });
  }

  const doc = readLocalRouting(), mode = switchMode(doc, now);
  const allowed = offPaceLaunchAllowed(doc, pre ? pre.chain : undefined);
  const projectionHolds = readAgyQuotaProjectionHolds(now);

  // 2. Decision 390a: plan / ui-design / ui-check enter the agy ladder ONLY with positive fresh Fable cannot-serve
  // evidence (checked BEFORE falling back to Fable in the Pi catalog!).
  if (!OFF_PACE_CLASSES.includes(kind)) {
    if (!allowed || !admissibleTarget(context) || !fableCannotServe(fableUnavailable, target, now)) return null;
    if (target.local !== false && (pre ? pre.localServer : localServerId()) !== target.daemon) return null;
    const holdsDoc = readModelHolds();
    if (holdsDoc == null) throw Error('agy model holds file is unsafe or malformed; refusing to route lane');
    const step = evaluateAgyLadder({
      targetId: target.daemon, isRemote: target.local === false, remote, proof, unavailable, target, catalog,
      holdsDoc, projectionHolds, now,
    });
    if (step.status === 'proof-required') {
      throw Error(`live policy selected ${step.runtime.provider}/${step.runtime.model}, but fresh verified proof is missing or stale; refusing to fall back or invent Sol`);
    }
    if (step.status === 'subset-unproven') {
      throw Error('remote agy capability subset does not prove agy unavailable for Sol backup; failing closed');
    }
    if (step.status !== 'admitted') {
      throw Error('fable-unavailable agy ladder failed closed: invalid evidence or Sol backup unavailable');
    }
    const isRep = step.kind === 'replacement';
    const route = Object.freeze({
      role: 'worker', source: isRep ? 'replacement' : 'pace-backup', kind, model: step.runtime.model,
      effort: step.runtime.effort, fastMode: step.runtime.fastMode,
      reason: isRep ? replacementReason(kind, step.runtime.model) : paceBackupReason(kind),
      receipt: Object.freeze(isRep
        ? { provider: step.runtime.provider, mode: step.mode, target: target.daemon, task: task.id, lane, placement: branchName }
        : { target: target.daemon, task: task.id, lane, placement: branchName }),
    });
    return Object.freeze({ route, parity: null, host: target.daemon, nextFallback: step.nextFallback });
  }

  // 3. Code class: requires valid fresh switch (forced or parity) and allowed launcher.
  if (mode == null || !allowed) return null;
  if (!admissibleTarget(context)) {
    if (mode === 'forced') {
      throw Error('forced code off-pace route requires a verified local Mac or armed remote target; refusing to silently substitute Opus or Sol');
    }
    return null;
  }
  const localSrv = target.local === false ? null : (pre ? pre.localServer : localServerId());
  if (mode === 'parity' && target.local !== false && localSrv !== target.daemon) return null;

  const holdsDoc = readModelHolds();
  if (holdsDoc == null) {
    if (mode === 'forced') throw Error('agy model holds file is unsafe or malformed; refusing to route off-pace code lane');
    return null;
  }

  // Decision 398a: Cursor is considered only for an eligible bounded code lane on the configured Cursor host.
  const cursorEligible = target.local === false &&
    cursorEligibilityProblem({ task, lane, kind, targetDaemon: target.daemon, doc }) === null;
  const buildCodeRoute = (step, forced) => {
    if (step.kind === 'cursor') {
      return Object.freeze({
        role: 'worker', source: CURSOR_OVERFLOW_SOURCE, kind: 'code', model: step.runtime.model, effort: null, fastMode: false,
        reason: CURSOR_OVERFLOW_REASON,
        receipt: Object.freeze({ provider: step.runtime.provider, mode: step.mode, target: target.daemon, task: task.id, lane, placement: branchName }),
      });
    }
    const isRep = step.kind === 'replacement';
    return Object.freeze({
      role: 'worker', source: isRep ? 'replacement' : 'pace-backup', kind, model: step.runtime.model,
      effort: step.runtime.effort, fastMode: step.runtime.fastMode,
      reason: isRep
        ? (forced ? replacementReason(kind, step.runtime.model) : parityReason(step.runtime.model))
        : (forced ? paceBackupReason(kind) : PARITY_BACKUP_REASON),
      receipt: Object.freeze(isRep
        ? { provider: step.runtime.provider, mode: step.mode, target: target.daemon, task: task.id, lane, placement: branchName }
        : { ...(target.local === false ? { target: target.daemon } : {}), task: task.id, lane, placement: branchName }),
    });
  };

  if (mode === 'forced') {
    const step = evaluateAgyLadder({
      targetId: target.daemon, isRemote: target.local === false, remote, proof, unavailable, target, catalog,
      holdsDoc, projectionHolds, now, cursorEligible,
    });
    if (step.status === 'proof-required') {
      throw Error(`live policy selected ${step.runtime.provider}/${step.runtime.model}, but fresh verified proof is missing or stale; refusing to fall back or invent Sol`);
    }
    if (step.status === 'subset-unproven') {
      throw Error('remote agy capability subset does not prove agy unavailable for Sol backup; failing closed');
    }
    if (step.status !== 'admitted') {
      throw Error('forced off-pace code route failed closed: invalid evidence or Sol backup unavailable');
    }
    if (step.kind === 'replacement' && step.runtime.model === OPUS_REPLACEMENT_RUNTIME.model &&
        target.local !== false && localSrv !== target.daemon) {
      throw Error('forced agy Opus high route requires the local daemon serverId; refusing to route');
    }
    return Object.freeze({ route: buildCodeRoute(step, true), parity: null, host: target.daemon, nextFallback: step.nextFallback });
  }

  // 4. Decision 359 code parity (not forced: false/false): alternates subscription Opus vs agy side per launcher.
  const launcher = process.env.PASEO_AGENT_ID, alternation = state === undefined ? readAlternation() : state;
  if (!launcherId(launcher) || alternation == null) return null;
  const admitted = Object.hasOwn(alternation.launchers, launcher) ? alternation.launchers[launcher].admitted : 0;
  const agyTurn = admitted % 2 === 1;
  if (!agyTurn) {
    return Object.freeze({
      route: null, host: target.daemon, nextFallback: null,
      parity: Object.freeze({ launcher, admitted, consumes: true }),
    });
  }
  const step = evaluateAgyLadder({
    targetId: target.daemon, isRemote: target.local === false, remote, proof, unavailable, target, catalog,
    holdsDoc, projectionHolds, now, cursorEligible,
  });
  if (step.status === 'proof-required') {
    throw Error(`parity agy turn selected ${step.runtime.provider}/${step.runtime.model}, but fresh verified proof is missing or stale; turn not consumed`);
  }
  if (step.status === 'subset-unproven') {
    throw Error('parity agy turn failed closed: remote agy capability subset does not prove agy unavailable; turn not consumed');
  }
  if (step.status !== 'admitted') {
    throw Error('parity agy turn failed closed: invalid evidence or Sol backup unavailable; turn not consumed');
  }
  return Object.freeze({
    route: buildCodeRoute(step, false), host: target.daemon, nextFallback: step.nextFallback,
    parity: Object.freeze({ launcher, admitted, consumes: true }),
  });
}

// Read-only live policy preview (for bare `route.mjs --class <class>` or `resolveWorkerRoute` without replacement
// context): applies Config-owned devin-ready.json and agy-quota.json projections, fresh trusted forcing switch,
// live Mac error holds, and read-only alternation peek without writing any file or consuming any turn.
function liveReadOnlyDecision({ taskClass, catalog, task = null, lane = null, now = Date.now() }) {
  const localSrv = process.platform === 'darwin' ? localServerId() : null;
  const host = localSrv ?? 'local';
  const holdsDoc = process.platform === 'darwin' ? readModelHolds() : { holds: {}, probes: {} };
  const projectionHolds = readAgyQuotaProjectionHolds(now);
  const snapshot = liveLocalPolicySnapshot(taskClass, now);
  const verifyLive = () => liveLocalPolicySnapshot(taskClass, Date.now()) === snapshot;

  if (taskClass === 'main-pm') {
    const chain = MAIN_PM_POLICY.fallbackChain.map(step => {
      const held = step.standIn && (
        (localSrv && holdsDoc && activeModelHold(holdsDoc, localSrv, step.model, now) != null) ||
        projectionHolds[step.model] === true
      );
      return Object.freeze({ ...step, skipped: Boolean(held) });
    });
    const next = chain.find(step => !step.skipped)?.provider ?? null;
    const def = MAIN_PM_POLICY.defaultRoute;
    return decisionEnvelope({
      route: def, reason: def.reason, provider: `pi/${def.model}`, host, nextFallback: next,
      proofRequired: false, fallbackChain: Object.freeze(chain), launchable: false,
    });
  }

  if (taskClass === 'opn-browser') {
    // Owner decision 412a: native Codex gpt-6.2-sol low, Fast on, in the PM's own workspace; the native Codex catalog
    // (`paseo provider models codex`) must serve it, and a Pi catalog never does.
    resolveOpnBrowserRow(Array.isArray(catalog) ? catalog : catalog?.codex);
    const { provider, model, effort, fastMode, reason } = OPN_BROWSER_EXCEPTION;
    const route = Object.freeze({ role: 'worker', source: 'owner-explicit', model, effort, fastMode, policy: 'opn-browser' });
    return decisionEnvelope({
      route, reason, provider: `${provider}/${model}`, host, nextFallback: null,
      proofRequired: false, taskClass: 'opn-browser', taskId: null, lane, launchable: true, inPlaceAllowed: true, verifyLive,
    });
  }

  const kind = canonicalWorkerClass(taskClass);

  // Devin-first Pi Opus High (397c/399a) checked BEFORE Fable catalog default!
  if (DEVIN_FIRST_CLASSES.includes(kind) && readDevinReady(now) && piServesRow(catalog, DEVIN_FIRST_RUNTIME)) {
    const preview = Object.freeze({
      role: 'worker', source: DEVIN_FIRST_SOURCE, kind, model: DEVIN_FIRST_RUNTIME.model,
      effort: DEVIN_FIRST_RUNTIME.effort, fastMode: DEVIN_FIRST_RUNTIME.fastMode, reason: devinFirstReason(kind),
    });
    return decisionEnvelope({
      route: preview, reason: preview.reason, provider: `pi/${preview.model}`, host, nextFallback: null,
      proofRequired: false, taskClass: kind, taskId: task?.id ?? null, lane, launchable: false, inPlaceAllowed: false,
    });
  }

  if (Object.hasOwn(OWNER_RULE_ROUTES, kind ?? '')) {
    const route = selectWorkerRoute({ taskKind: kind, catalog });
    return decisionEnvelope({
      route, reason: OWNER_RULE_ROUTES[kind].reason, provider: `pi/${route.model}`, host, nextFallback: null,
      proofRequired: false, taskClass: kind, taskId: task?.id ?? null, lane, launchable: true, inPlaceAllowed: true, verifyLive,
    });
  }
  if (!Object.hasOwn(WORKER_DEFAULT_ROUTES, kind ?? '')) throw workerRouteUnresolved();

  const baseRoute = selectWorkerRoute({ taskKind: kind, catalog });
  const baseProvider = providerForRoute(baseRoute, kind);

  if (kind !== 'code') {
    return decisionEnvelope({
      route: baseRoute, reason: routeReason(baseRoute), provider: baseProvider, host, nextFallback: null,
      proofRequired: false, taskClass: kind, taskId: task?.id ?? null, lane, launchable: true, inPlaceAllowed: true, verifyLive,
    });
  }

  const doc = readLocalRouting(), mode = switchMode(doc, now);
  if (mode == null || !offPaceLaunchAllowed(doc)) {
    return decisionEnvelope({
      route: baseRoute, reason: routeReason(baseRoute), provider: baseProvider, host, nextFallback: null,
      proofRequired: false, taskClass: kind, taskId: task?.id ?? null, lane, launchable: true, inPlaceAllowed: true, verifyLive,
    });
  }
  if (holdsDoc == null) {
    throw Error('agy model holds file is unsafe or malformed; refusing live off-pace decision');
  }

  const evalLadderPreview = (forced) => {
    const step = evaluateAgyLadder({
      targetId: localSrv, isRemote: false, remote: null, proof: undefined, unavailable: undefined,
      target: null, catalog, holdsDoc, projectionHolds, now,
    });
    if (step.status === 'proof-required') {
      const reason = forced ? replacementReason('code', step.runtime.model) : parityReason(step.runtime.model);
      const preview = Object.freeze({
        role: 'worker', source: 'replacement', kind: 'code', model: step.runtime.model,
        effort: step.runtime.effort, fastMode: step.runtime.fastMode, reason,
      });
      return decisionEnvelope({
        route: preview, reason, provider: `${step.runtime.provider}/${step.runtime.model}`, host,
        nextFallback: step.nextFallback, proofRequired: true, taskClass: 'code', taskId: task?.id ?? null, lane,
        launchable: false, inPlaceAllowed: false,
      });
    }
    if (step.status === 'admitted' && step.kind === 'backup') {
      const reason = forced ? paceBackupReason('code') : PARITY_BACKUP_REASON;
      const preview = Object.freeze({
        role: 'worker', source: 'pace-backup', kind: 'code', model: step.runtime.model,
        effort: step.runtime.effort, fastMode: step.runtime.fastMode, reason,
      });
      return decisionEnvelope({
        route: preview, reason, provider: `pi/${step.runtime.model}`, host,
        nextFallback: null, proofRequired: false, taskClass: 'code', taskId: task?.id ?? null, lane,
        launchable: false, inPlaceAllowed: false,
      });
    }
    throw Error('live off-pace code decision failed closed: both agy models held and Sol medium backup unavailable');
  };

  if (mode === 'forced') return evalLadderPreview(true);

  const launcher = process.env.PASEO_AGENT_ID, alternation = readAlternation();
  if (!launcherId(launcher) || alternation == null) {
    return decisionEnvelope({
      route: baseRoute, reason: routeReason(baseRoute), provider: baseProvider, host, nextFallback: null,
      proofRequired: false, taskClass: kind, taskId: task?.id ?? null, lane, launchable: true, inPlaceAllowed: true, verifyLive,
    });
  }
  const admitted = Object.hasOwn(alternation.launchers, launcher) ? alternation.launchers[launcher].admitted : 0;
  if (admitted % 2 === 1) return evalLadderPreview(false);
  return decisionEnvelope({
    route: baseRoute, reason: routeReason(baseRoute), provider: baseProvider, host, nextFallback: null,
    proofRequired: false, taskClass: kind, taskId: task?.id ?? null, lane, launchable: true, inPlaceAllowed: false, verifyLive,
  });
}

// Single live resolver. Owner routes always win unadjusted. Never accepts a caller Devin override (always reads Mac
// devin-ready.json). Stamps every launchable route with exact task/lane/target/live-policy verification.
export async function resolveWorkerRoute({ taskClass = null, ownerRoute = null, catalog, task = null, lane = null, replacement = null } = {}) {
  const now = Date.now();
  if (taskClass === 'opn-browser' && ownerRoute != null) {
    throw Error('opn-browser takes no owner-named route; owner decision 412a fixes its model, thinking, and Fast');
  }
  if (ownerRoute) {
    const kind = canonicalWorkerClass(taskClass);
    const route = selectWorkerRoute({ ownerRoute, taskKind: kind, catalog });
    const host = process.platform === 'darwin' ? (localServerId() ?? 'local') : 'local';
    const snapshot = liveLocalPolicySnapshot(kind ?? 'owner', now);
    return decisionEnvelope({
      route, reason: routeReason(route), provider: providerForRoute(route, kind), host, nextFallback: null,
      proofRequired: false, taskClass: kind, taskId: task?.id ?? replacement?.task?.id ?? null,
      lane: lane ?? replacement?.lane ?? null, launchable: true, inPlaceAllowed: true,
      verifyLive: () => liveLocalPolicySnapshot(kind ?? 'owner', Date.now()) === snapshot,
    });
  }
  if (taskClass === 'main-pm' || taskClass === 'opn-browser') {
    if (replacement != null) throw Error(`${taskClass} is a resolver-only policy and takes no managed replacement context`);
    return liveReadOnlyDecision({ taskClass, catalog, task, lane, now });
  }
  const kind = canonicalWorkerClass(taskClass);
  // Decision 435a: under the fresh forced Linux switch a managed Linux code lane never silently takes the class default.
  if (kind === 'code' && linuxSwitchMode(now) === 'forced') throw linuxForcedRefusal();
  if (replacement != null) {
    if (!Object.hasOwn(OWNER_RULE_ROUTES, kind ?? '') && !Object.hasOwn(WORKER_DEFAULT_ROUTES, kind ?? '')) {
      throw workerRouteUnresolved();
    }
    const admitted = offPaceAdmission(replacement, { taskClass: kind, catalog });
    const boundTaskId = replacement.task?.id ?? task?.id ?? null;
    const boundLane = replacement.lane ?? lane ?? null;
    const snapshot = liveLocalPolicySnapshot(kind, now);
    const verifyLive = () => liveLocalPolicySnapshot(kind, Date.now()) === snapshot;
    if (admitted?.route) {
      return decisionEnvelope({
        route: admitted.route, reason: admitted.route.reason, provider: providerForRoute(admitted.route, kind),
        host: admitted.host ?? 'local', nextFallback: admitted.nextFallback ?? null, proofRequired: false,
        taskClass: kind, taskId: boundTaskId, lane: boundLane, launchable: true, inPlaceAllowed: false, verifyLive,
      });
    }
    const baseRoute = selectWorkerRoute({ taskKind: kind, catalog });
    const reason = Object.hasOwn(OWNER_RULE_ROUTES, kind ?? '') ? OWNER_RULE_ROUTES[kind].reason : routeReason(baseRoute);
    return decisionEnvelope({
      route: baseRoute, reason, provider: providerForRoute(baseRoute, kind),
      host: admitted?.host ?? (replacement.target?.daemon ?? 'local'), nextFallback: null, proofRequired: false,
      taskClass: kind, taskId: boundTaskId, lane: boundLane, launchable: true, inPlaceAllowed: !admitted?.parity, verifyLive,
    });
  }
  return liveReadOnlyDecision({ taskClass: kind, catalog, task, lane, now });
}

function recordLane(task, { lane, route, reason, taskClass = null, catalog = null, replacement = null },
  state, pre = null, counting = false) {
  if (task.ui) {
    taskClass = uiTaskLaneClass(task, taskClass);
    if (!isUiRoute(route) && !((OFF_PACE_SOURCES.includes(route?.source) || route?.source === DEVIN_FIRST_SOURCE) && route.kind === taskClass)) {
      throw Error(`UI task: a ${taskClass} lane records only Fable high, Fast off (owner rule); the build goes to a code task`);
    }
  }
  const recorded = recordedLaneEntry(task, lane, route);
  if (recorded) {
    if (recorded.reason !== reason) throw Error(`lane ${lane} already has a recorded route; repairs and resumes reuse it`);
    return { entry: recorded, admission: null };
  }
  const specialSource = SPECIAL_SOURCES.includes(route?.source);
  const needsAdmission = (replacement != null || route?.source === DEVIN_FIRST_SOURCE) &&
    (ALTERNATION_SOURCES.includes(route?.source) || route?.source === DEVIN_FIRST_SOURCE);
  const admission = needsAdmission
    ? offPaceAdmission({ ...(replacement ?? {}), task, lane }, { taskClass, catalog }, state, pre) : null;
  if (specialSource && (reason !== route.reason || !isDeepStrictEqual(admission?.route, route))) {
    throw Error(`a ${route.source} route records only through its admitted resolution for this task and lane`);
  }
  if ((admission?.parity && route.source === 'task-default' && admission.route != null) || (admission?.parity?.consumes && !counting)) {
    throw Error(`lane ${lane}: the launcher's alternation turn changed since this route was resolved; resolve the lane again`);
  }
  validateRoleRoute('worker', route);
  const laneClass = taskClass ?? (route.source === 'task-default' ? route.kind : null);
  if (laneClass != null) validateLaneClass(route, laneClass, catalog);
  if (route.source === 'task-default' || UI_CLASSES.includes(canonicalWorkerClass(laneClass))) {
    assertLiveResolution(route, { task, lane, taskClass: laneClass, target: replacement?.target ?? null });
  }
  task.routes = { ...(task.routes ?? {}), [lane]: { route: structuredClone(route), reason, recorded_at: new Date().toISOString() } };
  return { entry: task.routes[lane], admission };
}

const ALTERNATION_LOCK_WAIT_MS = 10000;
export function recordWorkerRoute(taskPath, { lane, route, reason, taskClass = null, catalog = null, replacement = null }) {
  if (taskClass === 'opn-browser' || isOpnBrowserRoute(route)) {
    throw Error('opn-browser is a resolver-only policy and cannot be recorded as a managed Worker lane');
  }
  const options = { lane, route, reason, taskClass, catalog, replacement };
  const write = (state, pre, counting) => {
    let result;
    updateTask(taskPath, task => { result = recordLane(task, options, state, pre, counting); });
    return result;
  };
  const candidate = replacement != null && !readDevinReady(Date.now()) &&
    ALTERNATION_SOURCES.includes(route?.source) &&
    canonicalWorkerClass(taskClass ?? route.kind) === 'code' && admissibleTarget(replacement) &&
    !Object.hasOwn(readTask(taskPath).routes ?? {}, lane ?? '') && switchMode(readLocalRouting(), Date.now()) === 'parity';
  if (!candidate) return write(undefined, null, false).entry;
  const pre = { chain: launcherChain(), localServer: localServerId() };
  const dry = offPaceAdmission({ ...replacement, task: readTask(taskPath), lane }, { taskClass, catalog }, undefined, pre);
  if (!dry?.parity?.consumes) return write(undefined, pre, false).entry;
  const path = alternationPath();
  mkdirSync(join(homedir(), '.config', 'opc'), { recursive: true, mode: 0o700 });
  try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return withFileLock(path, held => {
    const current = readAlternation(path);
    const { entry, admission } = write(current, pre, true);
    if (admission?.parity?.consumes) {
      if (!held()) throw Error(`lane ${lane} recorded, but the alternation lock was lost; its turn was not counted`);
      const { launcher, admitted } = admission.parity;
      writeAlternation(path, { launchers: { ...current.launchers, [launcher]: { admitted: admitted + 1, at: new Date().toISOString() } } });
    }
    return entry;
  }, 'alternation lock', ALTERNATION_LOCK_WAIT_MS);
}

function differingLaneFlags(stored, flags, ownerRoute) {
  const differ = [];
  if (ownerRoute) {
    if (stored.source !== 'owner-explicit' || ownerRoute.model !== stored.model) differ.push('owner-model');
    if (ownerRoute.effort !== stored.effort) differ.push('owner-effort');
    if (ownerRoute.fastMode !== stored.fastMode) differ.push('owner-fast');
  }
  if (flags.class != null) {
    let fits = stored.source === 'task-default' ? canonicalWorkerClass(stored.kind) === canonicalWorkerClass(flags.class)
      : SPECIAL_SOURCES.includes(stored.source)
        ? canonicalWorkerClass(stored.kind) === canonicalWorkerClass(flags.class)
        : ownerRoute != null || Object.hasOwn(OWNER_RULE_ROUTES, canonicalWorkerClass(flags.class));
    if (fits && stored.source !== 'task-default') {
      try { validateLaneClass(stored, flags.class, null, { recorded: true }); } catch { fits = false; }
    }
    if (!fits) differ.push('class');
  }
  return differ;
}

export function catalogRows(rows) {
  if (!Array.isArray(rows)) throw Error('Pi catalog must be a JSON array of model rows');
  return rows.map(row => ({ id: row.id, label: row.label ?? row.model,
    thinkingOptions: Array.isArray(row.thinkingOptions) ? row.thinkingOptions : (row.thinkingOptionIds ?? []).map(id => ({ id })) }));
}

const readJson = (path, what) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw Error(`${what} ${path} unreadable (${error.message})`); }
};

// provider is pi, or codex for opn-browser, whose --catalog FILE holds native Codex rows.
async function readCatalog(path, provider = 'pi') {
  if (path) return catalogRows(readJson(path, 'catalog'));
  const [file, args, verbatim] = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"paseo provider models ${provider} --json"`], true]
    : ['paseo', ['provider', 'models', provider, '--json'], false];
  const { stdout } = await promisify(execFile)(file, args,
    { timeout: 60000, maxBuffer: 16 << 20, encoding: 'utf8', windowsVerbatimArguments: verbatim });
  return catalogRows(JSON.parse(stdout));
}

// Owner decision 435a: under the fresh forced Linux switch the route CLI asks the Mac route.mjs (the same install under
// the Mac home) over noninteractive `ssh mac` with the same safe routing args, and prints the Mac's decision once it
// validates. The answer is a policy preview only: it is never stamped as an in-process resolution, never recorded into a
// Linux task, and any transport failure or unexpected answer refuses with no local fallback.
const MAC_SSH_TIMEOUT_MS = 150000;
const SAFE_FORWARD = /^[A-Za-z0-9._/[\]-]{1,128}$/;
const SAFE_SCRIPT = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const printable = text => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean).at(-1)
  ?.replace(/[^\x20-\x7e]/g, '?').slice(0, 300) ?? '';

function macRouteArgs(flags) {
  if (flags.catalog != null) {
    throw Error('fresh off pace on Linux: --catalog names a Linux file the Mac cannot read; resolve without --catalog ' +
      'so the Mac reads its own catalog');
  }
  if (flags.task != null) {
    throw Error('fresh off pace on Linux: the Mac decision is a policy preview, not Linux launch authority, so an ' +
      'unrecorded --task lane is not recorded (recorded lanes replay unchanged); refusing rather than defaulting locally');
  }
  if (!SAFE_FORWARD.test(flags.class) || flags.class.startsWith('-')) {
    throw Error('fresh off pace on Linux: --class is not a plain class name; refusing to forward it to the Mac');
  }
  return ['--class', flags.class];
}

async function askMacRoute(args) {
  // The Mac runs the same install at the same path under its own home; the remote login shell supplies node, and the
  // values reach node as positional words ("$0" "$@"), never re-parsed by a shell.
  const script = relative(homedir(), fileURLToPath(import.meta.url));
  if (isAbsolute(script) || script.split('/').includes('..') || !SAFE_SCRIPT.test(script)) {
    throw Error('fresh off pace on Linux: route.mjs is not installed under this home, so no Mac install path matches; refusing');
  }
  const words = [script, ...args].map(word => `'${word}'`).join(' ');
  const command = `exec "$SHELL" -lc 'exec node "$0" "$@"' ${words}`;
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('ssh', ['-n', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', 'mac', command],
      { timeout: MAC_SSH_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: 'utf8' }));
  } catch (error) {
    const why = error.killed ? 'timed out' : error.code === 'ENOENT' ? 'ssh is not installed'
      : `${error.code === 255 ? 'ssh failed' : 'Mac route.mjs refused'} (exit ${error.code}): ${printable(error.stderr)}`;
    throw Error(`fresh off pace on Linux: no Mac route decision, ${why}; refusing with no local fallback`);
  }
  try { return JSON.parse(stdout); } catch {
    throw Error('fresh off pace on Linux: the Mac route answer is not JSON; refusing with no local fallback');
  }
}

const DECISION_KEYS = ['route', 'reason', 'provider', 'model', 'effort', 'fast', 'host', 'nextFallback', 'proofRequired'];
const plainObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
// The decision the Mac answer must equal, apart from what only the Mac knows (host, catalog model id, holds); or a reason
// to refuse. A code class default is refused: Mac route.mjs over SSH has no PASEO_AGENT_ID on its own daemon, so its
// launcher check (offPaceLaunchAllowed) fails and it can only answer the class default, never a fresh off-pace route.
function macDecisionProblem(out, taskClass) {
  const mainPm = taskClass === 'main-pm';
  if (!exactKeys(out, mainPm ? [...DECISION_KEYS, 'fallbackChain'] : DECISION_KEYS)) return 'unexpected answer keys';
  const { route } = out;
  if (!plainObject(route) || out.model !== route.model || out.effort !== route.effort || out.fast !== route.fastMode ||
      typeof out.fast !== 'boolean' || !isTargetId(out.host) || typeof out.proofRequired !== 'boolean') {
    return 'inconsistent answer';
  }
  const kind = canonicalWorkerClass(taskClass);
  const expect = (reason, provider, { nextFallback = [null], proofRequired = false } = {}) =>
    out.reason !== reason ? 'unexpected reason' : out.provider !== provider ? 'unexpected provider'
      : !nextFallback.includes(out.nextFallback) || out.nextFallback === out.provider ? 'unexpected next fallback'
        : out.proofRequired !== proofRequired ? 'unexpected proof flag' : null;
  if (mainPm) {
    const def = MAIN_PM_POLICY.defaultRoute, chain = out.fallbackChain, steps = MAIN_PM_POLICY.fallbackChain;
    if (!isDeepStrictEqual(route, def) || !Array.isArray(chain) || chain.length !== steps.length ||
        chain.some((step, i) => !plainObject(step) || typeof step.skipped !== 'boolean' ||
          !isDeepStrictEqual(step, { ...steps[i], skipped: step.skipped }))) return 'unexpected main-pm policy';
    return expect(def.reason, `pi/${def.model}`, { nextFallback: [chain.find(step => !step.skipped)?.provider ?? null] });
  }
  if (taskClass === 'opn-browser') {
    const { provider, model, effort, fastMode, reason } = OPN_BROWSER_EXCEPTION;
    return isDeepStrictEqual(route, { role: 'worker', source: 'owner-explicit', model, effort, fastMode, policy: 'opn-browser' })
      ? expect(reason, `${provider}/${model}`) : 'unexpected opn-browser route';
  }
  if (route.source === DEVIN_FIRST_SOURCE) {
    const { model, effort, fastMode } = DEVIN_FIRST_RUNTIME, reason = devinFirstReason(kind);
    return DEVIN_FIRST_CLASSES.includes(kind) &&
      isDeepStrictEqual(route, { role: 'worker', source: DEVIN_FIRST_SOURCE, kind, model, effort, fastMode, reason })
      ? expect(reason, `pi/${model}`) : 'unexpected devin-first route';
  }
  if (kind === 'code' && (route.source === 'replacement' || route.source === 'pace-backup')) {
    // A fresh forced ladder preview, exactly as liveReadOnlyDecision builds it.
    const backup = route.source === 'pace-backup';
    const runtime = backup ? PACE_BACKUP_RUNTIME : replacementRuntimeForModel(route.model);
    const reason = !runtime ? null : backup ? paceBackupReason('code') : replacementReason('code', runtime.model);
    if (!runtime || !isDeepStrictEqual(route, { role: 'worker', source: route.source, kind: 'code', model: runtime.model,
      effort: runtime.effort, fastMode: runtime.fastMode, reason })) return 'unexpected off-pace code route';
    const sol = `pi/${PACE_BACKUP_RUNTIME.model}`;
    return backup ? expect(reason, sol)
      : expect(reason, `${runtime.provider}/${runtime.model}`, { proofRequired: true,
        nextFallback: [null, sol, `${OPUS_REPLACEMENT_RUNTIME.provider}/${OPUS_REPLACEMENT_RUNTIME.model}`] });
  }
  if (kind === 'code') {
    return 'the Mac answered the code class default: over SSH Mac route.mjs cannot read the Linux launcher on its own ' +
      'daemon, so it never admits an off-pace code route; refusing rather than substituting Opus';
  }
  try { validateRoleRoute('worker', route); } catch (error) { return error.message; }
  if (Object.hasOwn(OWNER_RULE_ROUTES, kind ?? '')) {
    const rule = OWNER_RULE_ROUTES[kind];
    return exactKeys(route, ['role', 'source', 'model', 'effort', 'fastMode']) && route.source === 'owner-explicit' &&
      route.effort === rule.effort && route.fastMode === rule.fastMode
      ? expect(rule.reason, providerForRoute(route, kind)) : 'unexpected class route';
  }
  return route.source === 'task-default' && route.kind === kind && Object.hasOwn(WORKER_DEFAULT_ROUTES, kind ?? '')
    ? expect(routeReason(route), providerForRoute(route, kind)) : 'unexpected class route';
}

function humanSummaryLine(label, resolved, recorded = false) {
  const suffix = resolved.proofRequired ? ' (proof required)' : '';
  const tag = recorded ? ' (recorded)' : '';
  return `route ${label}${tag}: ${resolved.provider} effort=${resolved.effort ?? 'model-fixed'} fast=${resolved.fast ? 'on' : 'off'} host=${resolved.host} next=${resolved.nextFallback ?? 'none'}${suffix}`;
}

async function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw Error(usage);
    flags[argv[i].slice(2)] = argv[++i];
  }
  const known = ['class', 'catalog', 'owner-model', 'owner-effort', 'owner-fast', 'task', 'lane'];
  const unknown = Object.keys(flags).find(key => !known.includes(key));
  if (unknown) throw Error(`unknown option --${unknown}; ${usage}`);
  if (!!flags['owner-model'] !== !!flags['owner-effort'] || !!flags.task !== !!flags.lane ||
      (flags['owner-fast'] && !['on', 'off'].includes(flags['owner-fast']))) throw Error(usage);
  const ownerRoute = flags['owner-model'] ? { role: 'worker', source: 'owner-explicit', model: flags['owner-model'],
    effort: flags['owner-effort'], fastMode: flags['owner-fast'] === 'on' } : null;
  if (flags.class === 'opn-browser' && ['owner-model', 'owner-effort', 'owner-fast'].some(key => flags[key] != null)) {
    throw Error('opn-browser takes no --owner-model, --owner-effort, or --owner-fast; owner decision 412a fixes its route');
  }
  const task = flags.task && flags.lane ? readTask(resolve(flags.task)) : null;
  const recorded = task?.routes?.[flags.lane] ?? null;
  if (recorded) {
    const differ = differingLaneFlags(recorded.route, flags, ownerRoute);
    if (differ.length) {
      throw Error(`lane ${flags.lane} already has a recorded route that --${differ.join(', --')} would not select; resume it ` +
        'without route flags, or resolve a new lane');
    }
    const provider = providerForRoute(recorded.route, recorded.route.kind);
    const out = {
      route: recorded.route, reason: recorded.reason, provider, model: recorded.route.model,
      effort: recorded.route.effort, fast: recorded.route.fastMode,
      host: recorded.route.receipt?.target ?? 'local', nextFallback: null, proofRequired: false,
    };
    return { out, summary: humanSummaryLine(flags.lane, out, true) };
  }
  if (!ownerRoute && !flags.class) throw Error(usage);
  if (flags.task && (flags.class === 'main-pm' || flags.class === 'opn-browser')) {
    throw Error(`${flags.class} is a resolver-only policy and cannot be recorded as a managed Worker lane`);
  }
  // Owner-named routes never move with pace, so they stay local; every class resolution goes to the Mac.
  if (!ownerRoute && linuxSwitchMode() === 'forced') {
    const out = await askMacRoute(macRouteArgs(flags));
    const problem = macDecisionProblem(out, flags.class);
    if (problem) throw Error(`fresh off pace on Linux: refusing the Mac route answer (${problem}); no local fallback`);
    return { out, summary: humanSummaryLine(`${flags.class} via mac`, out, false) };
  }
  const catalog = ownerRoute || flags.class === 'main-pm' ? null
    : await readCatalog(flags.catalog, flags.class === 'opn-browser' ? 'codex' : 'pi');
  const resolved = await resolveWorkerRoute({ taskClass: flags.class ?? null, ownerRoute, catalog, task, lane: flags.lane ?? null });
  if (flags.task) {
    if (resolved.proofRequired || SPECIAL_SOURCES.includes(resolved.route?.source)) {
      throw Error(`live policy selected ${resolved.provider}, which requires exact bound target/workspace admission via resolveWorkerRoute before recording`);
    }
    recordWorkerRoute(resolve(flags.task), { lane: flags.lane, ...resolved, taskClass: flags.class ?? null, catalog });
  }
  const label = flags.class ?? 'owner';
  return { out: resolved, summary: humanSummaryLine(label, resolved, false) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { out, summary } = await main(process.argv.slice(2));
    console.error(summary);
    console.log(JSON.stringify(out, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

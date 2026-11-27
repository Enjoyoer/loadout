// Authenticated stock Paseo 0.15.3 SDK reader for remote targets (resolve, launch, and remote Sol backup) and
// authenticated terminal agent error snapshots (both local Mac and armed remote hosts).
// Every attestation is frozen and verified via module-private WeakSets/WeakMaps so callers cannot forge remote state,
// capability subsets, or self-labelled provider terminal events.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  CURSOR_OVERFLOW_RUNTIME, CURSOR_USAGE_MAX_AGE_MS, CURSOR_USAGE_MAX_USED_PCT, CURSOR_USAGE_SOURCE, CURSOR_USAGE_WINDOW,
  CURSOR_HOST_PLATFORM, isTargetId, localServerId, OPUS_REPLACEMENT_RUNTIME, PACE_BACKUP_RUNTIME,
  readOwnerJson, REPLACEMENT_RUNTIME, replacementRuntimeForModel, replacementSettings,
} from './agent-routing.mjs';

export const REMOTE_SDK_VERSION = '0.15.3';
export const REMOTE_ATTESTATION_MAX_AGE_MS = 2 * 60 * 1000;
const REMOTE_PLATFORMS = Object.freeze(['linux', 'win32']);
const ENTRY_STATES = Object.freeze(['armed', 'held']);
const MAX_TARGETS = 8;
const ENDPOINT = /^ssh:\/\/[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const SERVER_ID = /^[\x21-\x7e]{1,256}$/;
const AGENT_ID = /^[A-Za-z0-9-]{8,128}$/;

export function readRemoteTargets() {
  const doc = readOwnerJson(join(homedir(), '.config', 'opc', 'neon-remote-targets.json'));
  const targets = doc?.targets;
  if (!doc || Object.keys(doc).length !== 1 || targets == null || typeof targets !== 'object' || Array.isArray(targets) ||
      Object.keys(targets).length > MAX_TARGETS) return null;
  for (const [id, entry] of Object.entries(targets)) {
    if (!SERVER_ID.test(id) || entry == null || typeof entry !== 'object' || Array.isArray(entry) ||
        !(isDeepStrictEqual(Object.keys(entry).sort(), ['endpoint', 'platform', 'state']) ||
          (isDeepStrictEqual(Object.keys(entry).sort(), ['cursorOverflow', 'endpoint', 'platform', 'state']) && entry.cursorOverflow === true)) ||
        typeof entry.endpoint !== 'string' ||
        !ENDPOINT.test(entry.endpoint) || !REMOTE_PLATFORMS.includes(entry.platform) || !ENTRY_STATES.includes(entry.state)) return null;
  }
  return doc;
}
export const isMappedServer = serverId => {
  const targets = readRemoteTargets()?.targets;
  return typeof serverId === 'string' && targets != null && Object.hasOwn(targets, serverId);
};
const armedEntry = serverId => {
  const targets = readRemoteTargets()?.targets;
  return typeof serverId === 'string' && targets && Object.hasOwn(targets, serverId) && targets[serverId].state === 'armed'
    ? targets[serverId] : null;
};
export const isArmedServer = serverId => armedEntry(serverId) != null;
// Decision 398a: Cursor overflow is pinned to the existing bounded native Cursor host (319b/320a), named only in the private
// mapping: the single entry with "cursorOverflow": true, which must also be armed and linux. Zero or several such entries,
// or one that is not armed linux, mean no Cursor host (fails closed); every other remote, including win32, is refused.
export function cursorHostServerId() {
  const targets = readRemoteTargets()?.targets;
  const flagged = targets ? Object.entries(targets).filter(([, entry]) => entry.cursorOverflow === true) : [];
  if (flagged.length !== 1) return null;
  const [id, entry] = flagged[0];
  return entry.state === 'armed' && entry.platform === CURSOR_HOST_PLATFORM ? id : null;
}
export const isCursorHostServer = serverId => typeof serverId === 'string' && serverId === cursorHostServerId();

async function loadSdk() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, 'paseo');
    let real;
    try { if (!lstatSync(bin).isFile() && !lstatSync(bin).isSymbolicLink()) continue; real = realpathSync(bin); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    const root = dirname(dirname(real));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg?.name !== '@getpaseo/cli' || pkg.version !== REMOTE_SDK_VERSION) {
      throw Error(`the installed paseo CLI is not @getpaseo/cli ${REMOTE_SDK_VERSION}; no remote Neon target`);
    }
    const sdk = await import(pathToFileURL(join(root, 'dist', 'utils', 'client.js')).href);
    if (typeof sdk.connectToDaemon !== 'function') throw Error('the installed paseo CLI has no connectToDaemon; no remote Neon target');
    return sdk;
  }
  throw Error('no installed paseo CLI on PATH; no remote Neon target');
}

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const attestations = new WeakSet();
// Private WeakMap holding raw lastError only in memory for verified terminal agent attestations (never serialized/logged).
const terminalAttestations = new WeakMap();

const answered = (payload, what) => {
  if (payload == null || typeof payload !== 'object' || (payload.error != null && payload.error !== '')) {
    throw Error(`the remote daemon refused ${what}; no remote Neon target`);
  }
  return payload;
};

// Decision 398a quota preflight, read on the same authenticated connection (the stock `paseo usage` report, cached, no
// prompt or refresh): exactly one available `cursor` report whose last success is fresh, with exactly one numeric
// `plan_usage` window. 'ok' below the policy maximum, 'spent' at or above it (positive unavailability), else 'unknown'.
// Only this code and the report's last-success time (`at`, re-checked for age wherever the reading is used) leave here;
// no figure, reset, or account label does.
const UNKNOWN_USAGE = Object.freeze({ state: 'unknown', at: null });
async function cursorUsageState(client) {
  if (client.getLastServerInfoMessage?.()?.features?.usageSources !== true || typeof client.listUsageReports !== 'function') return UNKNOWN_USAGE;
  let reports;
  try { reports = (await client.listUsageReports())?.reports; } catch { return UNKNOWN_USAGE; } // probe-ok: fails closed, an unreadable usage report admits no Cursor lane; expires 2027-05-22
  if (!Array.isArray(reports)) return UNKNOWN_USAGE;
  const rows = reports.filter(entry => entry?.sourceId === CURSOR_USAGE_SOURCE);
  if (rows.length !== 1 || rows[0].report?.status !== 'available' || !Array.isArray(rows[0].report.windows)) return UNKNOWN_USAGE;
  const at = Date.parse(rows[0].successfulAt ?? '');
  if (!cursorUsageFresh(at)) return UNKNOWN_USAGE;
  const windows = rows[0].report.windows.filter(window => window?.id === CURSOR_USAGE_WINDOW);
  if (windows.length !== 1 || typeof windows[0].usedPct !== 'number' || !Number.isFinite(windows[0].usedPct) || windows[0].usedPct < 0) {
    return UNKNOWN_USAGE;
  }
  return { state: windows[0].usedPct < CURSOR_USAGE_MAX_USED_PCT ? 'ok' : 'spent', at };
}
// A usage reading counts only while its last success is within the max age, at read, resolve, and launch time alike.
function cursorUsageFresh(at, now = Date.now()) {
  return Number.isFinite(at) && at <= now + 60_000 && now - at <= CURSOR_USAGE_MAX_AGE_MS;
}

async function remoteWorkspace(client, workspaceId) {
  let cursor;
  for (let page = 0; page < 20; page++) {
    const result = answered(await client.fetchWorkspaces({ filter: { includeBackground: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) } }), 'the workspace list');
    const found = (result.entries ?? []).filter(entry => entry?.id === workspaceId);
    if (found.length) return found.length === 1 ? found[0] : null;
    if (!result.pageInfo?.hasMore || !result.pageInfo.nextCursor) return null;
    cursor = result.pageInfo.nextCursor;
  }
  return null;
}

// Reads one armed remote target now over the authenticated stock Paseo 0.15.3 SDK.
// Without workspace (resolve/record): reads identity, agy-opc status/models/modes, and Pi status/models/modes when ready.
// With workspace (launch/rebuild): reads that managed worktree plus either agy-opc draft features for model or (with
// allowBackup: true) remote Pi capabilities for a recorded remote Sol backup, or (with cursorLaunch: true, the configured Cursor host
// only) remote Cursor capabilities and the fresh quota preflight for a recorded Cursor overflow lane.
// On the configured Cursor host a resolve read also carries its Cursor capabilities and a boolean quota preflight.
export async function readRemoteAgyTarget({ serverId, workspace = null, model = null, allowBackup = false, cursorLaunch = false } = {}) {
  const entry = armedEntry(serverId);
  if (!entry) throw Error('the serverId is not an armed entry of the private remote target mapping; no remote Neon target');
  if (typeof cursorLaunch !== 'boolean') throw Error('cursorLaunch must be boolean');
  if (cursorLaunch && (!workspace || allowBackup || model != null)) {
    throw Error('a Cursor launch attestation reads one managed workspace and takes no agy model or backup');
  }
  if (cursorLaunch && !isCursorHostServer(serverId)) {
    throw Error('Cursor overflow runs only on the configured Cursor host entry (armed linux); the Cursor lane stops');
  }
  if (workspace != null && (typeof workspace !== 'object' || !isDeepStrictEqual(Object.keys(workspace).sort(), ['branchName', 'workspaceId', 'worktreeSlug']) ||
      Object.values(workspace).some(value => typeof value !== 'string' || !value))) {
    throw Error('a remote workspace is {workspaceId, worktreeSlug, branchName}');
  }
  if (typeof allowBackup !== 'boolean') throw Error('allowBackup must be boolean');
  if (workspace && allowBackup && model != null) {
    throw Error('remote backup launch attestation takes no agy model');
  }
  const selectedModel = workspace && !allowBackup ? (model ?? REPLACEMENT_RUNTIME.model) : model;
  if (selectedModel != null && !replacementRuntimeForModel(selectedModel)) {
    throw Error('remote target model must be an approved agy replacement model');
  }
  const sdk = await loadSdk();
  const client = await sdk.connectToDaemon({ target: { kind: 'endpoint', host: entry.endpoint }, timeout: 20000 });
  try {
    const info = client.getLastServerInfoMessage?.();
    if (info?.serverId !== serverId) throw Error('the endpoint\'s authenticated server_info is not this serverId; no remote Neon target');
    if (info.version !== REMOTE_SDK_VERSION) throw Error(`the remote daemon is not Paseo ${REMOTE_SDK_VERSION}; no remote Neon target`);
    let bound = null;
    if (workspace) {
      const found = await remoteWorkspace(client, workspace.workspaceId);
      if (!found || found.workspaceKind !== 'worktree' || found.worktreeSlug !== workspace.worktreeSlug ||
          found.gitRuntime?.currentBranch !== workspace.branchName || typeof found.workspaceDirectory !== 'string' ||
          !found.workspaceDirectory || found.archivingAt != null) {
        throw Error('the remote daemon has no managed worktree with this id, slug and branch; the remote lane stops');
      }
      bound = { workspaceId: found.id, cwd: found.workspaceDirectory, worktreeSlug: found.worktreeSlug, branchName: workspace.branchName };
      // Decision 398a: a Cursor launch also carries the Cursor host worktree's own origin and project root, read on this
      // authenticated connection, so its project exclusion is checked on the checkout Cursor runs in (fails closed).
      if (cursorLaunch) {
        const origin = found.gitRuntime?.remoteUrl, projectRoot = found.projectRootPath;
        if (typeof origin !== 'string' || !origin.trim() || typeof projectRoot !== 'string' || !projectRoot.startsWith('/') ||
            !found.workspaceDirectory.startsWith('/')) {
          throw Error('the remote daemon reports no origin or project path for this worktree; the Cursor lane stops');
        }
        bound = { ...bound, origin, projectRoot };
      }
    }
    const { provider, effort, mode } = REPLACEMENT_RUNTIME;
    const options = bound ? { cwd: bound.cwd } : {};
    const snapshot = answered(await client.getProvidersSnapshot(options), 'the provider snapshot');
    const entries = snapshot.entries ?? [];
    const readPi = async () => {
      const piRows = entries.filter(row => row?.provider === 'pi');
      if (piRows.length !== 1 || piRows[0].enabled !== true || piRows[0].status !== 'ready') return null;
      const piModels = answered(await client.listProviderModels('pi', options), 'the Pi model list').models;
      const piModes = answered(await client.listProviderModes('pi', options), 'the Pi mode list').modes;
      if (!Array.isArray(piModels) || !Array.isArray(piModes)) return null;
      return { provider: 'pi', enabled: true, status: 'available', models: structuredClone(piModels), modes: structuredClone(piModes) };
    };
    const cursorRows = entries.filter(row => row?.provider === CURSOR_OVERFLOW_RUNTIME.provider);
    // Positive Cursor unavailability is only a provider row that is absent or disabled; any other not-ready state is unknown.
    const cursorStatus = cursorRows.length === 0 ? 'missing' : cursorRows.length > 1 ? 'unknown'
      : cursorRows[0].enabled !== true ? 'disabled' : cursorRows[0].status === 'ready' ? 'ready' : 'unknown';
    const readCursor = async () => {
      if (cursorStatus !== 'ready') return null;
      const cModels = answered(await client.listProviderModels(CURSOR_OVERFLOW_RUNTIME.provider, options), 'the Cursor model list').models;
      const cModes = answered(await client.listProviderModes(CURSOR_OVERFLOW_RUNTIME.provider, options), 'the Cursor mode list').modes;
      if (!Array.isArray(cModels) || !Array.isArray(cModes)) return null;
      return { provider: CURSOR_OVERFLOW_RUNTIME.provider, enabled: true, status: 'available',
        models: structuredClone(cModels), modes: structuredClone(cModes) };
    };
    if (bound && cursorLaunch) {
      const cursorCapabilities = await readCursor();
      if (!cursorCapabilities) throw Error('the remote daemon does not report cursor enabled and ready; the Cursor lane stops');
      const attestation = deepFreeze({
        serverId, platform: entry.platform, version: info.version, readAt: Date.now(), workspace: bound,
        agyStatus: 'cursor-launch', capabilities: null, piCapabilities: null, cursorCapabilities, cursorStatus: 'ready',
        ...usageFields(await cursorUsageState(client)),
      });
      attestations.add(attestation);
      return attestation;
    }
    if (bound && allowBackup) {
      const piCapabilities = await readPi();
      if (!piCapabilities) throw Error('the remote daemon does not report pi enabled and ready; the remote backup lane stops');
      const attestation = deepFreeze({
        serverId, platform: entry.platform, version: info.version, readAt: Date.now(),
        workspace: bound, agyStatus: 'backup-launch', capabilities: null, piCapabilities, cursorCapabilities: null,
        cursorStatus: null, ...usageFields(UNKNOWN_USAGE),
      });
      attestations.add(attestation);
      return attestation;
    }
    const rows = entries.filter(row => row?.provider === provider);
    const agyReady = rows.length === 1 && rows[0].enabled === true && rows[0].status === 'ready';
    let agyStatus = 'ready', capabilities = null;
    if (agyReady) {
      const models = answered(await client.listProviderModels(provider, options), 'the model list').models;
      const modes = answered(await client.listProviderModes(provider, options), 'the mode list').modes;
      if (!Array.isArray(models) || !Array.isArray(modes)) throw Error('the remote daemon listed no models or modes; no remote Neon target');
      let features = null;
      if (bound) {
        features = answered(await client.listProviderFeatures({
          provider, cwd: bound.cwd, modeId: mode, model: selectedModel, thinkingOptionId: effort,
          featureValues: replacementSettings().features,
        }), 'the feature draft').features;
        if (!Array.isArray(features)) throw Error('the remote daemon listed no draft features; the remote lane stops');
      }
      capabilities = {
        provider, enabled: true, status: 'available', models: structuredClone(models), modes: structuredClone(modes),
        ...(bound ? { selectedModel, features: structuredClone(features) } : {}),
      };
    } else if (!bound && (allowBackup || isCursorHostServer(serverId))) {
      agyStatus = rows.length === 0 ? 'missing' : rows[0].enabled !== true ? 'disabled' : 'not-available';
    } else {
      throw Error(`the remote daemon does not report ${provider} enabled and ready; no remote Neon target`);
    }
    const piCapabilities = !bound ? await readPi() : null;
    const onCursorHost = !bound && isCursorHostServer(serverId);
    const cursorCapabilities = onCursorHost ? await readCursor() : null;
    const attestation = deepFreeze({
      serverId, platform: entry.platform, version: info.version, readAt: Date.now(),
      workspace: bound, agyStatus, capabilities, piCapabilities, cursorCapabilities,
      cursorStatus: onCursorHost ? (cursorStatus === 'ready' && !cursorCapabilities ? 'unknown' : cursorStatus) : null,
      ...usageFields(cursorCapabilities ? await cursorUsageState(client) : UNKNOWN_USAGE),
    });
    attestations.add(attestation);
    return attestation;
  } finally { await client.close?.(); }
}

const usageFields = usage => ({ cursorUsage: usage.state, cursorUsageAt: usage.at });

export const readRemoteNeonTarget = readRemoteAgyTarget;

// Reads an authenticated terminal provider error snapshot for an exact launched agy-opc agent directly from the local
// Mac daemon or an armed remote daemon via the stock Paseo 0.15.3 SDK (never trusts caller-supplied error text,
// provider, or model). Raw lastError is stored only in module-private memory and never exposed on the returned object.
export async function readAuthenticatedAgentTerminal({ target, agentId } = {}) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw Error('authenticated terminal quota reads are macOS-only');
  }
  if (!target || typeof target !== 'object' || Array.isArray(target) ||
      !isDeepStrictEqual(Object.keys(target).sort(), ['daemon', 'local', 'platform']) ||
      !isTargetId(target.daemon) || typeof target.local !== 'boolean' || !AGENT_ID.test(agentId ?? '')) {
    throw Error('valid target and launched agentId required for authenticated terminal error read');
  }
  let connectTarget, expectedPlatform;
  if (target.local === false) {
    const entry = armedEntry(target.daemon);
    if (!entry || entry.platform !== target.platform) {
      throw Error('target is not an armed remote entry; cannot read authenticated agent terminal error');
    }
    connectTarget = { kind: 'endpoint', host: entry.endpoint };
    expectedPlatform = entry.platform;
  } else {
    if (target.platform !== 'darwin' || isMappedServer(target.daemon) || localServerId() !== target.daemon) {
      throw Error('target does not match the local Mac daemon; cannot read authenticated agent terminal error');
    }
    // The stock SDK's own local target: this Mac's Paseo home instance (PASEO_HOME, default ~/.paseo), never PASEO_HOST.
    connectTarget = { kind: 'instance', home: resolve(homedir(), (process.env.PASEO_HOME ?? '~/.paseo').replace(/^~(?=$|\/)/, homedir())) };
    expectedPlatform = 'darwin';
  }
  const sdk = await loadSdk();
  const client = await sdk.connectToDaemon({ target: connectTarget, timeout: 20000 });
  try {
    const info = client.getLastServerInfoMessage?.();
    if (info?.serverId !== target.daemon) throw Error('daemon server_info does not match target; terminal read refused');
    if (info.version !== REMOTE_SDK_VERSION) throw Error(`daemon is not Paseo ${REMOTE_SDK_VERSION}; terminal read refused`);
    if (typeof client.fetchAgent !== 'function') {
      throw Error('installed paseo CLI SDK does not expose fetchAgent; cannot authenticate terminal error');
    }
    // Stock SDK shape: fetchAgent({ agentId }) -> { agent, project } | null (throws on daemon error). Only the
    // daemon-built `agent` snapshot is trusted; a bare/unwrapped payload is never accepted as an agent.
    const fetched = answered(await client.fetchAgent({ agentId }), 'the agent snapshot');
    const agent = fetched.agent;
    if (!agent || typeof agent !== 'object' || Array.isArray(agent) || agent.id !== agentId) {
      throw Error('authenticated daemon returned no matching agent snapshot');
    }
    if (agent.status !== 'error' || typeof agent.lastError !== 'string' || !agent.lastError.trim()) {
      throw Error('launched agent is not in a terminal error state');
    }
    const runtime = replacementRuntimeForModel(agent.model);
    if (agent.provider !== REPLACEMENT_RUNTIME.provider || !runtime) {
      throw Error('launched agent is not running an approved agy-opc model');
    }
    const labels = agent.labels && typeof agent.labels === 'object' && !Array.isArray(agent.labels)
      ? Object.fromEntries(Object.entries(agent.labels).filter(([, v]) => typeof v === 'string')) : {};
    const handle = deepFreeze({
      serverId: target.daemon,
      local: target.local,
      platform: expectedPlatform,
      agentId: agent.id,
      provider: agent.provider,
      model: runtime.model,
      workspaceId: typeof agent.workspaceId === 'string' ? agent.workspaceId : null,
      labels,
      readAt: Date.now(),
    });
    terminalAttestations.set(handle, Object.freeze({ handle, lastError: agent.lastError }));
    return handle;
  } finally { await client.close?.(); }
}

// Internal verifier consumed by agy-holds.mjs: verifies WeakMap provenance, freshness, and target binding.
export function verifiedAgentTerminalError(handle, target, now = Date.now()) {
  const record = handle && typeof handle === 'object' ? terminalAttestations.get(handle) : null;
  if (!record) return null;
  if (!(handle.readAt <= now && now - handle.readAt <= REMOTE_ATTESTATION_MAX_AGE_MS)) return null;
  if (!target || typeof target !== 'object' || Array.isArray(target) ||
      !isDeepStrictEqual(Object.keys(target).sort(), ['daemon', 'local', 'platform'])) return null;
  if (handle.serverId !== target.daemon || handle.local !== target.local || handle.platform !== target.platform) return null;
  if (target.local === false) {
    const entry = armedEntry(target.daemon);
    if (!entry || entry.platform !== target.platform) return null;
  } else if (target.platform !== 'darwin' || isMappedServer(target.daemon) || localServerId() !== target.daemon) {
    return null;
  }
  return record;
}

export function verifiedRemote(value, target) {
  const now = Date.now(), entry = armedEntry(target?.daemon);
  return attestations.has(value) && value.readAt <= now && now - value.readAt <= REMOTE_ATTESTATION_MAX_AGE_MS &&
    entry != null && target.local === false && value.serverId === target.daemon && value.platform === target.platform &&
    entry.platform === target.platform && isDeepStrictEqual(Object.keys(target).sort(), ['daemon', 'local', 'platform']);
}

export function remoteServesModel(value, modelId) {
  const runtime = replacementRuntimeForModel(modelId);
  if (!runtime || value?.agyStatus !== 'ready') return false;
  const { models, modes } = value?.capabilities ?? {};
  const rows = (models ?? []).filter(row => row?.id === runtime.model);
  return rows.length === 1 && Array.isArray(rows[0].thinkingOptions) &&
    rows[0].thinkingOptions.some(option => option?.id === runtime.effort) &&
    (modes ?? []).filter(row => row?.id === runtime.mode).length === 1;
}
export const remoteServesNeon = value => remoteServesModel(value, REPLACEMENT_RUNTIME.model);
export const remoteServesOpus = value => remoteServesModel(value, OPUS_REPLACEMENT_RUNTIME.model);

// Remote agy provider-level positive unavailability: only a resolve read (workspace null) of this target whose provider
// snapshot positively shows agy-opc missing or disabled. Never inferred from a launch-only, Pi-only, or Cursor-only
// attestation, a transient not-ready status, or a partial model or mode subset.
export function remoteAgyProviderUnavailable(value) {
  return value != null && value.workspace === null && ['missing', 'disabled'].includes(value.agyStatus);
}
// Decision 398a: the Cursor step on a verified resolve or Cursor launch attestation of the configured Cursor host. 'available' with
// the one unattended mode when it serves explicit cursor/gemini-4-neon, exactly one unattended mode, and a passing fresh
// quota preflight; 'unavailable' when the Cursor host positively shows Cursor missing, disabled, unserved, or spent; else 'unknown' (an
// unreadable preflight or ambiguous mode never unlocks Sol). The preflight's age is re-checked now: a reading past the max
// age is unknown, whether it said ok or spent.
export function remoteCursorStep(value) {
  if (!value || !isCursorHostServer(value.serverId) || value.platform !== CURSOR_HOST_PLATFORM) return { status: 'unknown' };
  if (['missing', 'disabled'].includes(value.cursorStatus)) return { status: 'unavailable' };
  const cur = value.cursorCapabilities;
  if (!cur) return { status: 'unknown' };
  if (cur.enabled !== true || cur.status !== 'available' || !Array.isArray(cur.models) || !Array.isArray(cur.modes)) {
    return { status: 'unknown' };
  }
  const rows = cur.models.filter(row => row?.id === CURSOR_OVERFLOW_RUNTIME.model);
  const unattended = cur.modes.filter(mode => mode?.isUnattended === true && typeof mode.id === 'string' && mode.id);
  const usage = cursorUsageFresh(value.cursorUsageAt) ? value.cursorUsage : 'unknown';
  if (rows.length !== 1 || usage === 'spent') return { status: 'unavailable' };
  if (unattended.length !== 1 || usage !== 'ok') return { status: 'unknown' };
  return { status: 'available', mode: unattended[0].id };
}
export const remoteCursorUnattendedMode = value => {
  const step = remoteCursorStep(value);
  return step.status === 'available' ? step.mode : null;
};

export function remoteServesBackup(value) {
  const pi = value?.piCapabilities;
  if (!pi || pi.enabled !== true || pi.status !== 'available' || !Array.isArray(pi.modes) || pi.modes.length !== 0 ||
      !Array.isArray(pi.models)) return false;
  const rows = pi.models.filter(row => row?.id === PACE_BACKUP_RUNTIME.model && row.label === PACE_BACKUP_RUNTIME.label &&
    Array.isArray(row.thinkingOptions) && row.thinkingOptions.some(option => option?.id === PACE_BACKUP_RUNTIME.effort));
  return rows.length === 1;
}

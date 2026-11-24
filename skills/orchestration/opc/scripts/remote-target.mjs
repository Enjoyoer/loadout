// Decision 359 remote Neon targets: one narrow async reader in front of the pure local builders. A remote daemon is a
// Neon target only when the owner's private mapping lists its exact serverId as armed, with a fixed ssh endpoint, and the
// installed stock Paseo CLI SDK at the one verified version reaches it on that endpoint and its authenticated server_info
// names that serverId. Everything the launch needs (identity, the managed workspace, provider, model, mode and the
// auto_accept toggle) is read on that one connection and returned as a frozen attestation that only this module can
// make. Nothing else proves a remote: not a caller's plain capabilities, a native provider row, a proof alone, or a
// time a caller supplies. Any failure throws, and the lane keeps the Opus default.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readOwnerJson, REPLACEMENT_RUNTIME, replacementSettings } from './agent-routing.mjs';

// The one Paseo version whose CLI SDK and server_info this reader was checked against; any other fails closed.
export const REMOTE_SDK_VERSION = '0.15.3';
// An attestation is usable only this long after it was read, by this process's clock.
export const REMOTE_ATTESTATION_MAX_AGE_MS = 2 * 60 * 1000;
// Remote platforms a mapping entry may declare. server_info carries no platform, so the platform is the owner's
// declaration in the private mapping, bound to the exact serverId.
const REMOTE_PLATFORMS = Object.freeze(['linux', 'win32']);
const ENTRY_STATES = Object.freeze(['armed', 'held']);
const MAX_TARGETS = 8;
// A fixed ssh alias from the owner's ssh config: no user, port, option or path, so no caller text reaches ssh.
const ENDPOINT = /^ssh:\/\/[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const SERVER_ID = /^[\x21-\x7e]{1,256}$/;

// The private mapping, ~/.config/opc/neon-remote-targets.json, read like routing.json (readOwnerJson): exactly
// {targets: {<serverId>: {endpoint, platform, state}}}. Absent, unsafe or malformed is null: no remote target at all.
export function readRemoteTargets() {
  const doc = readOwnerJson(join(homedir(), '.config', 'opc', 'neon-remote-targets.json'));
  const targets = doc?.targets;
  if (!doc || Object.keys(doc).length !== 1 || targets == null || typeof targets !== 'object' || Array.isArray(targets) ||
      Object.keys(targets).length > MAX_TARGETS) return null;
  for (const [id, entry] of Object.entries(targets)) {
    if (!SERVER_ID.test(id) || entry == null || typeof entry !== 'object' || Array.isArray(entry) ||
        !isDeepStrictEqual(Object.keys(entry).sort(), ['endpoint', 'platform', 'state']) || typeof entry.endpoint !== 'string' ||
        !ENDPOINT.test(entry.endpoint) || !REMOTE_PLATFORMS.includes(entry.platform) || !ENTRY_STATES.includes(entry.state)) return null;
  }
  return doc;
}
// Whether serverId is any entry of the mapping, armed or held: such a daemon is never a local target, so a caller cannot
// skip the attestation by calling a mapped remote local.
export const isMappedServer = serverId => {
  const targets = readRemoteTargets()?.targets;
  return typeof serverId === 'string' && targets != null && Object.hasOwn(targets, serverId);
};
// The armed entry for exactly this serverId, or null; a held entry never admits.
const armedEntry = serverId => {
  const targets = readRemoteTargets()?.targets;
  return typeof serverId === 'string' && targets && Object.hasOwn(targets, serverId) && targets[serverId].state === 'armed'
    ? targets[serverId] : null;
};

// The installed stock CLI: the first `paseo` on PATH, resolved to its package, which must be @getpaseo/cli at the verified
// version. Nothing is installed or downloaded.
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
const answered = (payload, what) => {
  if (payload == null || typeof payload !== 'object' || (payload.error != null && payload.error !== '')) {
    throw Error(`the remote daemon refused ${what}; no remote Neon target`);
  }
  return payload;
};
// Every page of the remote daemon's workspaces, background ones included, at most 20 pages.
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

// Reads one remote target now. serverId is the create_workspace serverId (and the receipt target). With workspace
// {workspaceId, worktreeSlug, branchName}, the managed workspace the lane launches in, it also reads that workspace on the
// same connection and the provider's draft features for exactly the replacement settings in its directory; without it
// (resolve and record, before the workspace exists) it reads identity, provider, models and modes only.
export async function readRemoteNeonTarget({ serverId, workspace = null } = {}) {
  const entry = armedEntry(serverId);
  if (!entry) throw Error('the serverId is not an armed entry of the private remote target mapping; no remote Neon target');
  if (workspace != null && (typeof workspace !== 'object' || !isDeepStrictEqual(Object.keys(workspace).sort(), ['branchName', 'workspaceId', 'worktreeSlug']) ||
      Object.values(workspace).some(value => typeof value !== 'string' || !value))) {
    throw Error('a remote workspace is {workspaceId, worktreeSlug, branchName}');
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
    }
    const { provider, model, effort, mode } = REPLACEMENT_RUNTIME;
    const options = bound ? { cwd: bound.cwd } : {};
    const snapshot = answered(await client.getProvidersSnapshot(options), 'the provider snapshot');
    const rows = (snapshot.entries ?? []).filter(row => row?.provider === provider);
    if (rows.length !== 1 || rows[0].enabled !== true || rows[0].status !== 'ready') {
      throw Error(`the remote daemon does not report ${provider} enabled and ready; no remote Neon target`);
    }
    const models = answered(await client.listProviderModels(provider, options), 'the model list').models;
    const modes = answered(await client.listProviderModes(provider, options), 'the mode list').modes;
    if (!Array.isArray(models) || !Array.isArray(modes)) throw Error('the remote daemon listed no models or modes; no remote Neon target');
    let features = null;
    if (bound) {
      features = answered(await client.listProviderFeatures({ provider, cwd: bound.cwd, modeId: mode, model, thinkingOptionId: effort,
        featureValues: replacementSettings().features }), 'the feature draft').features;
      if (!Array.isArray(features)) throw Error('the remote daemon listed no draft features; the remote lane stops');
    }
    const attestation = deepFreeze({ serverId, platform: entry.platform, version: info.version, readAt: Date.now(),
      workspace: bound, capabilities: { provider, enabled: true, status: 'available', models: structuredClone(models),
        modes: structuredClone(modes), ...(bound ? { selectedModel: model, features: structuredClone(features) } : {}) } });
    attestations.add(attestation);
    return attestation;
  } finally { await client.close?.(); }
}

// Whether value is an attestation this module read, still fresh by this process's clock, for this target, whose mapping
// entry is still armed with the same platform. Every resolve, record, launch and rebuild checks it.
export function verifiedRemote(value, target) {
  const now = Date.now(), entry = armedEntry(target?.daemon);
  return attestations.has(value) && value.readAt <= now && now - value.readAt <= REMOTE_ATTESTATION_MAX_AGE_MS &&
    entry != null && target.local === false && value.serverId === target.daemon && value.platform === target.platform &&
    entry.platform === target.platform && isDeepStrictEqual(Object.keys(target).sort(), ['daemon', 'local', 'platform']);
}
// Whether a verified attestation shows the replacement model at its thinking and the pinned mode, each exactly once.
export function remoteServesNeon(value) {
  const { models, modes } = value?.capabilities ?? {};
  const rows = (models ?? []).filter(row => row?.id === REPLACEMENT_RUNTIME.model);
  return rows.length === 1 && Array.isArray(rows[0].thinkingOptions) &&
    rows[0].thinkingOptions.some(option => option?.id === REPLACEMENT_RUNTIME.effort) &&
    (modes ?? []).filter(row => row?.id === REPLACEMENT_RUNTIME.mode).length === 1;
}

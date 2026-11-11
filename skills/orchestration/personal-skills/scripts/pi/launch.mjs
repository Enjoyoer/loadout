// Stock Paseo 0.10.3 interim: each real agent gets a private, scoped mcp.json.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync, lstatSync, accessSync, constants, realpathSync,
  openSync, closeSync, fstatSync, fchmodSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// One clear stderr line and a non-zero exit, before any Pi process starts.
function refuse(message) {
  process.stderr.write(`Pi launch refused: ${message}\n`);
  process.exit(1);
}

// Read an overlay from an agent home, which the agent itself may write: opened without following a link (a symbolic
// link refuses, so the launcher never reads another file through it), and only a regular file. Null when missing.
function readOverlay(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    if (error.code === 'ELOOP') refuse(`${path} is a symlink`);
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) refuse(`${path} is not a regular file`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
// Write a file in an agent home that the agent itself can write: remove what is there first (a symbolic link the agent
// planted included) and create the file exclusively ('wx'), so the launcher never writes through a link.
function writeFresh(path, data) {
  rmSync(path, { force: true });
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
}
const root = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'));
const requireCodemode = settings => {
  if (settings.codemode?.mode !== 'on' || JSON.stringify(settings.defaultTools) !== '["+codemode"]'
      || !settings.extensions?.includes(join(root, 'fleet-routing.mjs')))
    throw Error('Pi requires fixed Codemode on');
};
requireCodemode(JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8')));
// Per-agent overlays: the owner or a PM may write models.overlay.json or settings.overlay.json into agents/<id>/.
// Every launch rebuilds that agent's models.json and settings.json from the shared agent/ copies and applies the
// overlay on top, so deleting an overlay restores the shared values. Only this allowlist is accepted; any other key
// or JSON type refuses the launch. Every object and list needs at least one entry, n is a positive integer, and each
// model id is a non-empty string and each modelOverrides key has the form "<provider>/<model id>":
//   models.overlay.json    {"providers": {"<provider>": {"models": [{"id": "<model id>", "contextWindow"?: n, "maxTokens"?: n}]}}}
//   settings.overlay.json  {"compaction"?: {"enabled"?: true|false, "reserveTokens"?: n, "keepRecentTokens"?: n,
//                           "modelOverrides"?: {"<provider>/<model id>": {"reserveTokens"?: n, "keepRecentTokens"?: n}}},
//                          "skillsExclude"?: ["<skill name>"]}
// Each skillsExclude entry is unique and names a skill directory directly under exactly one root Pi loads skills from
// (skillRoots); the launcher appends Pi's exact exclusion "-<that directory>" to skills, so only that skill leaves the
// agent's index and commands. A name in two roots refuses the launch. A name in no root (a skill since retired or never
// installed) excludes nothing, so the launch prints one warning line naming it and continues. Likewise a models entry
// or modelOverrides key naming a model not in the shared models.json (a model since retired from the catalog, or its
// whole provider) is checked like any other entry, then skipped with one warning line, so that model keeps the shared
// values and the launch continues.
// For example, a 1M window for one model with a 40960-token compaction reserve:
//   {"providers": {"fleet": {"models": [{"id": "<model id>", "contextWindow": 1000000}]}}}
//   {"compaction": {"modelOverrides": {"fleet/<model id>": {"reserveTokens": 40960}}}}
// Probes and launches without a caller never read overlays.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value, keys, where) {
  if (!isObject(value) || !Object.keys(value).length) throw Error(`${where} must be a non-empty object`);
  const other = Object.keys(value).find(key => !keys.includes(key));
  if (other !== undefined) throw Error(`${where} does not allow "${other}"`);
  return value;
}
function counts(value, keys, where) {
  for (const key of keys)
    if (Object.hasOwn(value, key) && !(Number.isSafeInteger(value[key]) && value[key] > 0))
      throw Error(`${where}.${key} must be a positive integer`);
}
// A model the shared models.json lacks gets this one stderr line and is skipped; its shared values stay.
const skipModel = key => process.stderr.write(`Pi launch: model override "${key}" not in models.json, using default\n`);
function overlayModels(models, overlay) {
  const providers = only(only(overlay, ['providers'], 'the overlay').providers, Object.keys(overlay.providers ?? {}), 'providers');
  for (const [name, provider] of Object.entries(providers)) {
    const where = `providers.${name}.models`, list = only(provider, ['models'], `providers.${name}`).models;
    if (!Array.isArray(list) || !list.length) throw Error(`${where} must be a non-empty list`);
    for (const entry of list) {
      only(entry, ['id', 'contextWindow', 'maxTokens'], `${where} entry`);
      if (typeof entry.id !== 'string' || !entry.id) throw Error(`${where} entry id must be a non-empty string`);
      if (Object.keys(entry).length < 2) throw Error(`${where} entry "${entry.id}" changes nothing`);
      counts(entry, ['contextWindow', 'maxTokens'], `${where} entry "${entry.id}"`);
      const shared = Object.hasOwn(models.providers, name) ? models.providers[name].models ?? [] : [];
      const model = shared.find(row => row.id === entry.id);
      if (!model) { skipModel(`${name}/${entry.id}`); continue; }
      Object.assign(model, entry);
    }
  }
  return models;
}
// Pi 1.0.0 loads skills from its settings' skills entries (the shared agent/skills), its agent dir's skills/ (here the
// agent home) and ~/.agents/skills, where Paseo installs its own skills (HOME, else the OS home, as Pi resolves it).
// Project .pi/skills and .agents/skills load only for a trusted project; RPC mode never asks and the fleet's
// defaultProjectTrust is "never", so they are not roots here.
const skillRoots = home => [join(root, 'agent', 'skills'), join(home, 'skills'),
  join(process.env.HOME || homedir(), '.agents', 'skills')];
function overlaySettings(settings, overlay, models, home) {
  only(overlay, ['compaction', 'skillsExclude'], 'the overlay');
  if (Object.hasOwn(overlay, 'skillsExclude')) {
    const names = overlay.skillsExclude, roots = skillRoots(home);
    if (!Array.isArray(names) || !names.length) throw Error('skillsExclude must be a non-empty list');
    if (!settings.skills?.includes(roots[0])) throw Error(`the shared settings do not load ${roots[0]}`);
    const dirs = names.flatMap(name => {
      // A plain skill name only: no separators, globs, dots or Pi pattern prefixes.
      if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        throw Error(`skillsExclude entry ${JSON.stringify(name)} must be a skill directory name`);
      if (names.indexOf(name) !== names.lastIndexOf(name)) throw Error(`skillsExclude lists "${name}" twice`);
      const found = roots.map(dir => join(dir, name))
        .filter(dir => statSync(join(dir, 'SKILL.md'), { throwIfNoEntry: false })?.isFile());
      if (found.length > 1) throw Error(`skillsExclude "${name}" is ambiguous: ${found.join(' and ')}`);
      if (!found.length) process.stderr.write(`Pi launch: skillsExclude skips "${name}": no such skill is installed\n`);
      return found;
    });
    settings = { ...settings, skills: [...settings.skills, ...dirs.map(dir => '-' + dir)] };
  }
  if (!Object.hasOwn(overlay, 'compaction')) return settings;
  const compaction = only(overlay.compaction,
    ['enabled', 'reserveTokens', 'keepRecentTokens', 'modelOverrides'], 'compaction');
  if (Object.hasOwn(compaction, 'enabled') && typeof compaction.enabled !== 'boolean')
    throw Error('compaction.enabled must be true or false');
  counts(compaction, ['reserveTokens', 'keepRecentTokens'], 'compaction');
  const { modelOverrides: overrides, ...rest } = compaction;
  const merged = { ...settings.compaction, ...rest };
  let changed = Object.keys(rest).length > 0;
  if (Object.hasOwn(compaction, 'modelOverrides')) {
    const ids = Object.entries(models.providers)
      .flatMap(([name, provider]) => (provider.models ?? []).map(row => `${name}/${row.id}`));
    const applied = { ...settings.compaction?.modelOverrides };
    for (const [key, override] of Object.entries(only(overrides, Object.keys(overrides ?? {}), 'compaction.modelOverrides'))) {
      const where = `compaction.modelOverrides["${key}"]`;
      if (!/^[^/]+\/./.test(key)) throw Error(`${where} must be "<provider>/<model id>"`);
      counts(only(override, ['reserveTokens', 'keepRecentTokens'], where), ['reserveTokens', 'keepRecentTokens'], where);
      if (!ids.includes(key)) { skipModel(key); continue; }
      applied[key] = { ...applied[key], ...override };
      merged.modelOverrides = applied; changed = true;
    }
  }
  // An overlay whose every entry was skipped leaves the shared settings exactly as they were.
  return changed ? { ...settings, compaction: merged } : settings;
}
if (process.argv.slice(2).some(arg => /^(--(?:no-)?codemode|--no-extensions)(=|$)/.test(arg)))
  throw Error('Pi Codemode cannot be overridden per agent');
// The isolated provider row's command carries its markers right after launch.mjs:
//   launch.mjs --loadout-isolated [--loadout-sandbox-profile <absolute path> | --loadout-sandbox-root <absolute dir>]
//     <Paseo's args>
// Paseo lets a per-agent request change a provider's env but never its command, so isolation and the sandbox come
// only from these markers, never from env. Only with --loadout-sandbox-root does the launcher read one env var, the
// agent's own profile (LOADOUT_PI_SANDBOX_PROFILE), and only a regular file under that root passes. The two
// --loadout-test-* markers are fixture-only seams for the platform and the sandbox-exec path; a real macOS launch
// refuses them.
const rawArgs = process.argv.slice(2);
let isolated = false, sandboxProfile = null, sandboxRoot = null, testPlatform = null, testSandboxExec = null, lead = 0;
for (; lead < rawArgs.length; lead++) {
  const arg = rawArgs[lead], value = rawArgs[lead + 1];
  if (arg === '--loadout-isolated') isolated = true;
  else if (arg === '--loadout-sandbox-profile' && value !== undefined) { sandboxProfile = value; lead++; }
  else if (arg === '--loadout-sandbox-root' && value !== undefined) { sandboxRoot = value; lead++; }
  else if (arg === '--loadout-test-platform' && value !== undefined) { testPlatform = value; lead++; }
  else if (arg === '--loadout-test-sandbox-exec' && value !== undefined) { testSandboxExec = value; lead++; }
  else break;
}
const args = rawArgs.slice(lead);
if (args.some(arg => arg.startsWith('--loadout-'))) refuse('loadout markers go only at the start of the provider command');
if (!isolated && (sandboxProfile !== null || sandboxRoot !== null || testPlatform !== null || testSandboxExec !== null))
  refuse('--loadout-sandbox-profile, --loadout-sandbox-root and the test markers need --loadout-isolated');
if (sandboxProfile !== null && sandboxRoot !== null)
  refuse('--loadout-sandbox-profile and --loadout-sandbox-root are exclusive');
if (isolated) {
  // LOADOUT_PI_SANDBOX_PROFILE is read only on a row with --loadout-sandbox-root; anywhere else it refuses.
  const flag = ['LOADOUT_PI_ISOLATED', ...(sandboxRoot === null ? ['LOADOUT_PI_SANDBOX_PROFILE'] : [])]
    .find(key => Object.hasOwn(process.env, key));
  if (flag) refuse(`remove ${flag} from the env: isolation comes from the provider command`);
}
if ((testPlatform !== null || testSandboxExec !== null) && process.platform === 'darwin')
  refuse('the --loadout-test-* markers are for test fixtures, never a macOS launch');
// Variables the isolated row's command clears through /usr/bin/env before Node starts (ISOLATED_SCRUBBED_ENV in
// paseo_providers.py, the same set), so a per-agent env cannot load code, modules, config or data files, or change
// module resolution. Any still set, or any other LD_*, DYLD_*, OPENSSL_* or JITI_* variable, refuses an isolated launch.
const ISOLATED_SCRUBBED_ENV = [
  // Node.js 24 and 26 (doc/api/cli.md, Environment variables): code, module resolution, ICU data, compile cache, CA files.
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_ICU_DATA', 'NODE_COMPILE_CACHE',
  'NODE_COMPILE_CACHE_PORTABLE', 'NODE_COMPILE_CACHE_READONLY', 'NODE_EXTRA_CA_CERTS', 'NODE_PRESERVE_SYMLINKS',
  // ICU, which Node embeds: its time-zone data override.
  'ICU_TIMEZONE_FILES_DIR',
  // OpenSSL 3.5 (openssl-env(7)), which Node reads at startup: config, providers, engines, data files.
  'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_CONFIG', 'OPENSSL_ENGINES', 'OPENSSL_MODULES', 'CTLOG_FILE',
  'RANDFILE', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  // glibc ld.so(8), every LD_* it reads, and glibc's module, tunable, locale and resolver files.
  'LD_ASSUME_KERNEL', 'LD_AUDIT', 'LD_BIND_NOT', 'LD_BIND_NOW', 'LD_DEBUG', 'LD_DEBUG_OUTPUT', 'LD_DYNAMIC_WEAK',
  'LD_HWCAP_MASK', 'LD_LIBRARY_PATH', 'LD_ORIGIN_PATH', 'LD_POINTER_GUARD', 'LD_PREFER_MAP_32BIT_EXEC',
  'LD_PRELOAD', 'LD_PROFILE', 'LD_PROFILE_OUTPUT', 'LD_SHOW_AUXV', 'LD_TRACE_LOADED_OBJECTS', 'LD_TRACE_PRELINKING',
  'LD_USE_LOAD_BIAS', 'LD_VERBOSE', 'LD_WARN', 'GCONV_PATH', 'GLIBC_TUNABLES', 'LOCPATH', 'NLSPATH', 'HOSTALIASES',
  // macOS dyld(1) library and framework loading (running through /usr/bin/env also purges every DYLD_*).
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH', 'DYLD_VERSIONED_LIBRARY_PATH', 'DYLD_VERSIONED_FRAMEWORK_PATH',
  'DYLD_IMAGE_SUFFIX', 'DYLD_SHARED_CACHE_DIR', 'DYLD_SHARED_REGION', 'DYLD_ROOT_PATH',
  // jiti, Pi's extension loader: every JITI_* in Pi 1.0.0's installed packages.
  'JITI_ALIAS', 'JITI_CACHE', 'JITI_DEBUG', 'JITI_ESM_EVAL_TEMP_FILE', 'JITI_EXTENSIONS', 'JITI_FS_CACHE',
  'JITI_INTEROP_DEFAULT', 'JITI_JSX', 'JITI_MODULE_CACHE', 'JITI_NATIVE_MODULES', 'JITI_REBUILD_FS_CACHE',
  'JITI_REQUIRE_CACHE', 'JITI_RESPECT_TMPDIR_ENV', 'JITI_SOURCE_MAPS', 'JITI_TRANSFORM_MODULES', 'JITI_TRY_NATIVE',
  'JITI_TSCONFIG_PATHS',
  // Pi 1.0.0 (docs/environment-variables.md): its package and session directories.
  'PI_PACKAGE_DIR', 'PI_CODING_AGENT_SESSION_DIR',
];
// Isolation is macOS only: elsewhere /usr/bin/env is dynamically linked, so a per-agent LD_PRELOAD runs inside it before
// the scrub. The test-platform marker stands in for macOS in fixtures; a real macOS launch refuses it above.
if (isolated && (testPlatform ?? process.platform) !== 'darwin') refuse('the isolated Pi provider needs macOS');
// A per-agent env still reaches this process; the isolated row's scrub is the fix, this refusal its backstop.
if (isolated) {
  const preload = Object.keys(process.env)
    .find(key => ISOLATED_SCRUBBED_ENV.includes(key) || /^(LD_|DYLD_|OPENSSL_|JITI_)/.test(key));
  if (preload) refuse(`remove ${preload} from the env: the isolated Pi provider takes no preload or loader variables`);
}
const cli = join(root, 'app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const piPackage = JSON.parse(readFileSync(join(dirname(dirname(cli)), '../package.json'), 'utf8'));
if (piPackage.version !== '1.0.0') throw Error('official Pi 1.0.0 required');
const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent') };
env.LOADOUT_PI_MCP_URL = spec.paseoMcp.url;
env.LOADOUT_PI_PARENT_MODEL = '';
env.LOADOUT_PI_PARENT_THINKING = spec.settings?.defaultThinkingLevel || '';
const caller = env.PASEO_AGENT_ID;
// Paseo 0.11 probes Pi (model catalog, MCP support) with only --mode rpc. A catalog probe's PASEO_AGENT_ID is
// inherited from whoever started the daemon, so a probe runs like an uncalled launch and writes no agent home.
const probe = args.length === 2 && args[0] === '--mode' && args[1] === 'rpc';
// Without a caller there is no agent home, so Pi would read the shared agent dir and its mcp.json.
if (isolated && !caller && !probe) refuse('the isolated Pi provider needs a Paseo caller (PASEO_AGENT_ID)');
// The sandbox, decided before anything is written or run. With --loadout-sandbox-root, every agent launch (resume
// included) needs its own profile in LOADOUT_PI_SANDBOX_PROFILE: an absolute path with no symbolic link at any level,
// naming a regular file under the root, outside the agent's working directory and outside the Pi root (which holds
// every agent home). Missing, empty or anything else refuses. Paseo's catalog probe carries no per-agent env, so a
// probe without one runs under PROBE_PROFILE: no network, no AppleEvents or keychain service, writes only to the agent
// dir it reads (sessions), and no reads under the user's home, the temp folders or /Volumes except the cwd itself, the
// Node install (NODE_PREFIX), PI_ROOT/app, fleet-routing.mjs and that agent dir without its mcp.json. HOME is the
// account's home from the user database, never the env, which a per-agent env sets on Paseo's MCP probe.
const PROBE_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny appleevent-send)
(deny mach-lookup (global-name "com.apple.SecurityServer"))
(deny file-write*)
(allow file-write* (subpath (param "PI_HOME")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))
(deny file-read* (subpath (param "HOME")) (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/Volumes"))
(allow file-read-metadata)
(allow file-read* (literal (param "CWD")) (subpath (param "NODE_PREFIX")) (subpath (string-append (param "PI_ROOT") "/app")) (literal (string-append (param "PI_ROOT") "/fleet-routing.mjs")) (subpath (param "PI_HOME")))
(deny file-read* (literal (string-append (param "PI_HOME") "/mcp.json")))
`;
// A path's real path as stored on disk (realpathSync.native: the on-disk letter case and Unicode form, so a case or
// normalization variant never compares as a different path on a case-insensitive volume), or null when it does not
// exist; any other error propagates.
const realPath = path => {
  try { return realpathSync.native(path); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
};
// Whether child is dir or inside it (a dir of / included).
const inside = (child, dir) => child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
let probeProfile = false;
if (sandboxRoot !== null) {
  if (!isAbsolute(sandboxRoot)) refuse('--loadout-sandbox-root must be an absolute path');
  const realRoot = realPath(sandboxRoot);
  if (realRoot === null || !statSync(realRoot).isDirectory())
    refuse(`sandbox profile root ${sandboxRoot} is not an existing directory`);
  const named = process.env.LOADOUT_PI_SANDBOX_PROFILE;
  delete env.LOADOUT_PI_SANDBOX_PROFILE;  // Pi gets only the checked path, as sandbox-exec's -f
  if (named === undefined && probe) probeProfile = true;
  else {
    if (!named) refuse('the isolated Pi provider needs LOADOUT_PI_SANDBOX_PROFILE, the agent\'s profile under its sandbox root');
    const where = `sandbox profile ${JSON.stringify(named)}`;
    if (!isAbsolute(named) || resolve(named) !== named) refuse(`${where} must be an absolute path without . or .. parts`);
    const real = realPath(named);
    if (real === null) refuse(`${where} is missing`);
    if (real !== named) refuse(`${where} is not its own real path: a symbolic link, or another letter case or Unicode form`);
    if (real === realRoot || !inside(real, realRoot)) refuse(`${where} is not under the sandbox profile root ${realRoot}`);
    const cwd = realPath(process.cwd()), piRoot = realPath(root);
    if (inside(real, cwd)) refuse(`${where} is under the agent's working directory`);
    if (inside(real, piRoot)) refuse(`${where} is under the Pi root`);
    sandboxProfile = real;
  }
}
// The probe profile's HOME is the account's home from the user database, as stored on disk, and its NODE_PREFIX (the
// Node install it may read, which wins over the home deny) must not reopen what that deny closes.
let probeHome = null, nodePrefix = null;
if (probeProfile) {
  probeHome = realPath(userInfo().homedir);
  nodePrefix = realPath(dirname(dirname(process.execPath)));
  if (probeHome === null || nodePrefix === null) refuse('the probe profile needs an existing home and Node install');
  const reopened = [['the home folder', probeHome], ['the Pi root', realPath(root)],
    ...['.config', '.ssh', '.codex'].map(name => [`~/${name}`, join(probeHome, name)])]
    .find(([, path]) => inside(path, nodePrefix));
  if (reopened) refuse(`the Node install prefix ${nodePrefix} contains ${reopened[0]}, which the probe profile must not `
    + 'read: install Node outside the home folder or in its own folder (for example ~/.local/node)');
}
const sandboxed = sandboxProfile !== null || probeProfile;
const sandboxExec = testSandboxExec ?? '/usr/bin/sandbox-exec';
if (sandboxed) {
  // Every launch with a profile runs inside sandbox-exec, the probe included; never unsandboxed.
  if (sandboxProfile !== null && !isAbsolute(sandboxProfile)) refuse('--loadout-sandbox-profile must be an absolute path');
  try {
    accessSync(sandboxExec, constants.X_OK);
  } catch {
    refuse(`${sandboxExec} is missing or not executable`);
  }
  if (sandboxProfile !== null) {
    let regular = false;
    try {
      regular = lstatSync(sandboxProfile).isFile();
      accessSync(sandboxProfile, constants.R_OK);
    } catch {
      refuse(`sandbox profile ${sandboxProfile} is missing or unreadable`);
    }
    if (!regular) refuse(`sandbox profile ${sandboxProfile} is not a regular file`);
  }
}
// A profile lets Pi read only PI_ROOT/app and fleet-routing.mjs of the Pi root, so every extension the sandboxed Pi
// loads must be a built-in or resolve to one of those; Pi packages are refused.
function readableExtensions(settings) {
  if (settings.packages !== undefined && !(Array.isArray(settings.packages) && !settings.packages.length))
    refuse('a sandboxed isolated Pi loads no Pi packages: remove packages from the Pi settings');
  const app = realPath(join(root, 'app')), routing = realPath(join(root, 'fleet-routing.mjs'));
  for (const entry of settings.extensions ?? []) {
    if (typeof entry === 'string' && /^[-!]/.test(entry)) continue;  // an exclusion loads nothing
    const path = typeof entry === 'string' ? entry.replace(/^\+/, '') : '';
    if (/^builtin:[a-z0-9.-]+$/.test(path)) continue;  // built into the Pi package under app/
    const target = isAbsolute(path) && !/[*?]/.test(path) ? realPath(path) : null;
    if (target === null || !(target === routing || (app !== null && target !== app && inside(target, app))))
      refuse(`extension ${JSON.stringify(entry)} is outside what a sandbox profile lets Pi read: `
        + `${join(root, 'app')}/ and ${join(root, 'fleet-routing.mjs')}`);
  }
}
// The router key of a sandboxed agent: the launcher reads it and Pi takes it from this variable.
const ROUTER_KEY_ENV = 'LOADOUT_PI_ROUTER_KEY';
if (caller && !probe) {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(caller)) throw Error('invalid Paseo caller identity');
  const home = join(root, 'agents', caller);
  if (isolated) {
    // Pi 1.0.0 takes MCP servers from <agent dir>/mcp.json, a trusted project's .pi/mcp.json, servers extensions
    // register (Paseo's integration extension does when it detects built-in MCP), and an MCP extension's
    // --mcp-config flag (Paseo passes one when it detects pi-mcp-adapter). Refuse what Paseo could pass to reopen one.
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (/^--mcp-config(=|$)/.test(arg)) refuse('the isolated Pi provider takes no --mcp-config');
      if (arg === '--approve' || arg === '-a') refuse('the isolated Pi provider never trusts project files');
      if ((arg === '--extension' || arg === '-e') && args[i + 1] === 'builtin:mcp')
        refuse('the isolated Pi provider never loads built-in MCP');
    }
    // An auto-discovered extension in the agent home could register its own MCP support.
    try {
      lstatSync(join(home, 'extensions'));
      refuse(`remove ${join(home, 'extensions')}: the isolated Pi provider loads no agent-home extensions`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Keep sessions stable across resumes, without shared settings or MCP identity.
  const shared = Object.fromEntries(['models.json', 'settings.json']
    .map(file => [file, readFileSync(join(root, 'agent', file))]));
  const files = { ...shared };
  for (const [file, apply] of [['models.json', overlayModels], ['settings.json', overlaySettings]]) {
    const path = join(home, file.replace(/json$/, 'overlay.json'));
    // Only a missing overlay is absent; an unreadable one refuses the launch.
    const text = readOverlay(path);
    if (text === null) continue;
    let overlay;
    // The parser's message quotes the input, so it never reaches the error.
    try { overlay = JSON.parse(text); } catch { refuse(`${path}: invalid JSON`); }
    const sharedFile = JSON.parse(shared[file]), sharedModels = JSON.parse(shared['models.json']);
    try {
      const merged = apply(sharedFile, overlay, sharedModels, home);
      if (file === 'settings.json') requireCodemode(merged);
      files[file] = JSON.stringify(merged, null, 2) + '\n';
    } catch (error) { throw Error(`invalid ${path}: ${error.message}`); }
  }
  if (isolated) {
    // Built-in MCP off: nothing reads mcp.json or connects a registered server, so Codemode sees no MCP namespace.
    const own = JSON.parse(files['settings.json']);
    files['settings.json'] = JSON.stringify({ ...own, extensions: [...own.extensions, '-builtin:mcp'] }, null, 2) + '\n';
  }
  if (sandboxed) {
    readableExtensions(JSON.parse(files['settings.json']));
    // A profile denies Pi the credential files and its own !command, so the launcher runs the router's credential
    // helper here, outside the sandbox: the argv fleet-routing.mjs derives, with its timeout and retries, without a
    // shell. Pi gets the value only in its env, and the agent's models.json names that variable instead of the command.
    // No value, no launch.
    const models = JSON.parse(files['models.json']);
    const { credentialHelper, readCredential, CREDENTIAL } = await import(new URL('./fleet-routing.mjs', import.meta.url));
    const found = credentialHelper(models, root);
    if (!found) refuse('a sandboxed isolated Pi needs the router credential helper in models.json');
    if (!isAbsolute(found.argv[0]))
      refuse(`the credential helper program ${JSON.stringify(found.argv[0])} must be an absolute path: set the Pi runtime's python`);
    // The helper runs unsandboxed, so it never sees the per-agent env (HOME would pick a user-site .pth, DEVELOPER_DIR
    // the program behind the xcrun shim): a fixed PATH, the account's home from the user database, and, for an env
    // credential source only, that one named variable (credential.py reads it from its environment). Python runs in
    // isolated mode (-I): no user site, no PYTHON* variables, no script or cwd directory on sys.path.
    const helperEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userInfo().homedir };
    const source = spec.credential;
    if (source?.kind === 'env' && typeof source.name === 'string' && Object.hasOwn(process.env, source.name))
      helperEnv[source.name] = process.env[source.name];
    const helperArgv = [found.argv[0], '-I', ...found.argv.slice(1)];
    let value = null;
    for (const delay of [0, ...CREDENTIAL.retryDelaysMs]) {
      if (delay) await new Promise(done => setTimeout(done, delay));
      if ((value = await readCredential(helperArgv, { timeoutMs: CREDENTIAL.timeoutMs, env: helperEnv }))) break;
    }
    if (!value) refuse('the router credential helper failed, and a sandboxed Pi cannot read the key itself');
    const row = models.providers[found.provider];
    row.apiKey = '$' + ROUTER_KEY_ENV;
    for (const name of found.headers) row.headers[name] = '$' + ROUTER_KEY_ENV;
    files['models.json'] = JSON.stringify(models, null, 2) + '\n';
    env[ROUTER_KEY_ENV] = value;
  }
  for (const [file, data] of Object.entries(files)) writeFresh(join(home, file), data);
  if (existsSync(join(root, 'agent/AGENTS.md'))) writeFresh(join(home, 'AGENTS.md'), readFileSync(join(root, 'agent/AGENTS.md')));
  const modelIndex = args.lastIndexOf('--model');
  // Paseo 0.11 resumes with --session and applies the model over RPC; mcp_bridge reads the live model.
  if (modelIndex >= 0 && args[modelIndex + 1]) env.LOADOUT_PI_PARENT_MODEL = args[modelIndex + 1];
  else if (!args.includes('--session')) throw Error('Paseo must resolve a concrete catalog model');
  const thinkingIndex = args.lastIndexOf('--thinking');
  env.LOADOUT_PI_PARENT_THINKING = thinkingIndex < 0 ? spec.settings?.defaultThinkingLevel || '' : args[thinkingIndex + 1];
  if (isolated) {
    // No MCP config at all, and a stale one from an earlier launch goes before Pi starts. Without the Paseo MCP URL
    // the routing extension reads no agent labels, so Fast labels are ignored.
    rmSync(join(home, 'mcp.json'), { force: true });
    delete env.LOADOUT_PI_MCP_URL;
    // First, so no flag still waiting for its value can take it.
    args.unshift('--no-approve');
  } else {
    const url = new URL(spec.paseoMcp.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Paseo MCP must use loopback');
    url.searchParams.set('callerAgentId', caller);
    const mcp = JSON.parse(readFileSync(join(root, 'agent/mcp.json'), 'utf8'));
    env.LOADOUT_PI_MCP_URL = url.href;
    // Pi treats an empty ${VAR} as missing and drops the server, so omit empty parent values (resume has no --model).
    const bridgeEnv = mcp.mcpServers?.paseo?.env;
    if (bridgeEnv) for (const key of ['LOADOUT_PI_PARENT_MODEL', 'LOADOUT_PI_PARENT_THINKING'])
      if (!env[key]) delete bridgeEnv[key];
    writeFresh(join(home, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  }
  env.PI_CODING_AGENT_DIR = home;
}
if (isolated && probe) {
  // The isolated row's probe (model catalog, and Paseo's MCP-support check) loads every extension but built-in MCP,
  // so Paseo sees no MCP support and refuses MCP servers requested for an isolated agent; no project files either.
  const shared = JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8'));
  if (sandboxed) readableExtensions(shared);
  const own = settings => settings.extensions.filter(entry => !/^[-+!]/.test(entry)).flatMap(entry => ['-e', entry]);
  args.unshift('--no-approve', '--no-extensions', '-e', 'builtin:codemode', '-e', 'builtin:tool-search',
    '-e', 'builtin:llama.cpp', ...own(shared));
}
let command = process.execPath, argv = [cli, ...args];
if (sandboxed) {
  // A profile lets Pi write only under PI_HOME and CWD, so its temp files go to PI_HOME/tmp, owner-only. An existing
  // tmp that is not a plain directory (a link the agent left) refuses.
  // The mode is set through a descriptor opened without following a link, so a link swapped in meanwhile is refused.
  const tmp = join(env.PI_CODING_AGENT_DIR, 'tmp');
  try { mkdirSync(tmp, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let fd;
  try { fd = openSync(tmp, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { if (['ELOOP', 'ENOTDIR'].includes(error.code)) refuse(`${tmp} must be a directory`); throw error; }
  try {
    if (!fstatSync(fd).isDirectory()) refuse(`${tmp} must be a directory`);
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  env.TMPDIR = env.TMP = env.TEMP = tmp;
  const params = probeProfile
    ? ['-D', `HOME=${probeHome}`, '-D', `NODE_PREFIX=${nodePrefix}`] : [];
  argv = [...(probeProfile ? ['-p', PROBE_PROFILE] : ['-f', sandboxProfile]), '-D', `CWD=${resolve(process.cwd())}`,
    '-D', `PI_HOME=${env.PI_CODING_AGENT_DIR}`, '-D', `PI_ROOT=${root}`, ...params, process.execPath, ...argv];
  command = sandboxExec;
}
const child = spawn(command, argv, { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Pi launch failed\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

// Stock Paseo 0.10.3 interim: each real agent gets a private, scoped mcp.json.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync, lstatSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// One clear stderr line and a non-zero exit, before any Pi process starts.
function refuse(message) {
  process.stderr.write(`Pi launch refused: ${message}\n`);
  process.exit(1);
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
//   launch.mjs --loadout-isolated [--loadout-sandbox-profile <absolute path>] <Paseo's args>
// Paseo lets a per-agent request change a provider's env but never its command, so isolation and the sandbox come
// only from these markers, never from env. The two --loadout-test-* markers are fixture-only seams for the platform
// and the sandbox-exec path; a real macOS launch refuses them.
const rawArgs = process.argv.slice(2);
let isolated = false, sandboxProfile = null, testPlatform = null, testSandboxExec = null, lead = 0;
for (; lead < rawArgs.length; lead++) {
  const arg = rawArgs[lead], value = rawArgs[lead + 1];
  if (arg === '--loadout-isolated') isolated = true;
  else if (arg === '--loadout-sandbox-profile' && value !== undefined) { sandboxProfile = value; lead++; }
  else if (arg === '--loadout-test-platform' && value !== undefined) { testPlatform = value; lead++; }
  else if (arg === '--loadout-test-sandbox-exec' && value !== undefined) { testSandboxExec = value; lead++; }
  else break;
}
const args = rawArgs.slice(lead);
if (args.some(arg => arg.startsWith('--loadout-'))) refuse('loadout markers go only at the start of the provider command');
if (!isolated && (sandboxProfile !== null || testPlatform !== null || testSandboxExec !== null))
  refuse('--loadout-sandbox-profile and the test markers need --loadout-isolated');
if (isolated && ['LOADOUT_PI_ISOLATED', 'LOADOUT_PI_SANDBOX_PROFILE'].some(key => Object.hasOwn(process.env, key)))
  refuse('remove LOADOUT_PI_ISOLATED and LOADOUT_PI_SANDBOX_PROFILE from the env: isolation comes from the provider command');
if ((testPlatform !== null || testSandboxExec !== null) && process.platform === 'darwin')
  refuse('the --loadout-test-* markers are for test fixtures, never a macOS launch');
// A per-agent env still reaches this process. The isolated row's command clears the known preload variables through
// /usr/bin/env before Node starts; any that remain (or a JITI_* var, which Pi's extension loader reads) refuse.
if (isolated) {
  const preload = Object.keys(process.env).find(key => key === 'NODE_OPTIONS' || /^(JITI_|LD_|DYLD_)/.test(key));
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
    let text;
    // Only a missing overlay is absent; an unreadable one refuses the launch.
    try { text = readFileSync(path, 'utf8'); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    try {
      const merged = apply(JSON.parse(shared[file]), JSON.parse(text), JSON.parse(shared['models.json']), home);
      if (file === 'settings.json') requireCodemode(merged);
      files[file] = JSON.stringify(merged, null, 2) + '\n';
    } catch (error) { throw Error(`invalid ${path}: ${error.message}`); }
  }
  if (isolated) {
    // Built-in MCP off: nothing reads mcp.json or connects a registered server, so Codemode sees no MCP namespace.
    const own = JSON.parse(files['settings.json']);
    files['settings.json'] = JSON.stringify({ ...own, extensions: [...own.extensions, '-builtin:mcp'] }, null, 2) + '\n';
  }
  for (const [file, data] of Object.entries(files)) writeFileSync(join(home, file), data, { mode: 0o600 });
  if (existsSync(join(root, 'agent/AGENTS.md')))
    writeFileSync(join(home, 'AGENTS.md'), readFileSync(join(root, 'agent/AGENTS.md')), { mode: 0o600 });
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
    writeFileSync(join(home, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600 });
  }
  env.PI_CODING_AGENT_DIR = home;
}
if (isolated && probe) {
  // The isolated row's probe (model catalog, and Paseo's MCP-support check) loads every extension but built-in MCP,
  // so Paseo sees no MCP support and refuses MCP servers requested for an isolated agent; no project files either.
  const own = settings => settings.extensions.filter(entry => !/^[-+!]/.test(entry)).flatMap(entry => ['-e', entry]);
  args.unshift('--no-approve', '--no-extensions', '-e', 'builtin:codemode', '-e', 'builtin:tool-search',
    '-e', 'builtin:llama.cpp', ...own(JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8'))));
}
let command = process.execPath, argv = [cli, ...args];
if (sandboxProfile !== null) {
  // Every launch with a profile runs inside sandbox-exec, the probe included; never unsandboxed.
  const platform = testPlatform ?? process.platform;
  const sandboxExec = testSandboxExec ?? '/usr/bin/sandbox-exec';
  if (platform !== 'darwin') refuse('the Pi sandbox profile needs macOS sandbox-exec');
  if (!isAbsolute(sandboxProfile)) refuse('--loadout-sandbox-profile must be an absolute path');
  try {
    accessSync(sandboxExec, constants.X_OK);
  } catch {
    refuse(`${sandboxExec} is missing or not executable`);
  }
  let regular = false;
  try {
    regular = lstatSync(sandboxProfile).isFile();
    accessSync(sandboxProfile, constants.R_OK);
  } catch {
    refuse(`sandbox profile ${sandboxProfile} is missing or unreadable`);
  }
  if (!regular) refuse(`sandbox profile ${sandboxProfile} is not a regular file`);
  argv = ['-f', sandboxProfile, '-D', `CWD=${resolve(process.cwd())}`, '-D', `PI_HOME=${env.PI_CODING_AGENT_DIR}`,
    '-D', `PI_ROOT=${root}`, process.execPath, ...argv];
  command = sandboxExec;
}
const child = spawn(command, argv, { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Pi launch failed\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

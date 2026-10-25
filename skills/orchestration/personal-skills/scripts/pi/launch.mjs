// Stock Paseo 0.10.3 interim: each real agent gets a private, scoped mcp.json.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// overlay on top, so deleting an overlay restores the shared values. Only this allowlist is accepted; any other key,
// JSON type, provider or model refuses the launch. Every object and list needs at least one entry, n is a positive
// integer, and each provider, model id and "<provider>/<model id>" key must exist in the shared models.json:
//   models.overlay.json    {"providers": {"<provider>": {"models": [{"id": "<model id>", "contextWindow"?: n, "maxTokens"?: n}]}}}
//   settings.overlay.json  {"compaction"?: {"enabled"?: true|false, "reserveTokens"?: n, "keepRecentTokens"?: n,
//                           "modelOverrides"?: {"<provider>/<model id>": {"reserveTokens"?: n, "keepRecentTokens"?: n}}},
//                          "skillsExclude"?: ["<skill name>"]}
// Each skillsExclude entry is unique and names a skill directory directly under the shared agent/skills; the launcher
// appends Pi's exact exclusion "-<that directory>" to skills, so only that skill leaves the agent's index and commands.
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
function overlayModels(models, overlay) {
  const providers = only(only(overlay, ['providers'], 'the overlay').providers, Object.keys(models.providers), 'providers');
  for (const [name, provider] of Object.entries(providers)) {
    const where = `providers.${name}.models`, list = only(provider, ['models'], `providers.${name}`).models;
    if (!Array.isArray(list) || !list.length) throw Error(`${where} must be a non-empty list`);
    for (const entry of list) {
      only(entry, ['id', 'contextWindow', 'maxTokens'], `${where} entry`);
      const model = (models.providers[name].models ?? []).find(row => row.id === entry.id);
      if (!model) throw Error(`${where} has no shared model "${entry.id}"`);
      if (Object.keys(entry).length < 2) throw Error(`${where} entry "${entry.id}" changes nothing`);
      counts(entry, ['contextWindow', 'maxTokens'], `${where} entry "${entry.id}"`);
      Object.assign(model, entry);
    }
  }
  return models;
}
function overlaySettings(settings, overlay, models) {
  only(overlay, ['compaction', 'skillsExclude'], 'the overlay');
  if (Object.hasOwn(overlay, 'skillsExclude')) {
    const names = overlay.skillsExclude, dir = join(root, 'agent', 'skills');
    if (!Array.isArray(names) || !names.length) throw Error('skillsExclude must be a non-empty list');
    if (!settings.skills?.includes(dir)) throw Error(`the shared settings do not load ${dir}`);
    for (const name of names) {
      // A plain skill name only: no separators, globs, dots or Pi pattern prefixes.
      if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        throw Error(`skillsExclude entry ${JSON.stringify(name)} must be a skill directory name`);
      if (names.indexOf(name) !== names.lastIndexOf(name)) throw Error(`skillsExclude lists "${name}" twice`);
      if (!statSync(join(dir, name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile())
        throw Error(`skillsExclude has no shared skill "${name}"`);
    }
    settings = { ...settings, skills: [...settings.skills, ...names.map(name => '-' + join(dir, name))] };
  }
  if (!Object.hasOwn(overlay, 'compaction')) return settings;
  const compaction = only(overlay.compaction,
    ['enabled', 'reserveTokens', 'keepRecentTokens', 'modelOverrides'], 'compaction');
  if (Object.hasOwn(compaction, 'enabled') && typeof compaction.enabled !== 'boolean')
    throw Error('compaction.enabled must be true or false');
  counts(compaction, ['reserveTokens', 'keepRecentTokens'], 'compaction');
  const merged = { ...settings.compaction, ...compaction };
  if (Object.hasOwn(compaction, 'modelOverrides')) {
    const ids = Object.entries(models.providers)
      .flatMap(([name, provider]) => (provider.models ?? []).map(row => `${name}/${row.id}`));
    merged.modelOverrides = { ...settings.compaction?.modelOverrides };
    for (const [key, override] of Object.entries(only(compaction.modelOverrides, ids, 'compaction.modelOverrides'))) {
      const where = `compaction.modelOverrides["${key}"]`;
      counts(only(override, ['reserveTokens', 'keepRecentTokens'], where), ['reserveTokens', 'keepRecentTokens'], where);
      merged.modelOverrides[key] = { ...merged.modelOverrides[key], ...override };
    }
  }
  return { ...settings, compaction: merged };
}
if (process.argv.slice(2).some(arg => /^(--(?:no-)?codemode|--no-extensions)(=|$)/.test(arg)))
  throw Error('Pi Codemode cannot be overridden per agent');
const cli = join(root, 'app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const piPackage = JSON.parse(readFileSync(join(dirname(dirname(cli)), '../package.json'), 'utf8'));
if (piPackage.version !== '1.0.0') throw Error('official Pi 1.0.0 required');
const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent') };
env.LOADOUT_PI_MCP_URL = spec.paseoMcp.url;
env.LOADOUT_PI_PARENT_MODEL = '';
env.LOADOUT_PI_PARENT_THINKING = spec.settings?.defaultThinkingLevel || '';
const caller = env.PASEO_AGENT_ID;
const args = process.argv.slice(2);
// Paseo 0.11 probes Pi (model catalog, MCP support) with only --mode rpc. A catalog probe's PASEO_AGENT_ID is
// inherited from whoever started the daemon, so a probe runs like an uncalled launch and writes no agent home.
const probe = args.length === 2 && args[0] === '--mode' && args[1] === 'rpc';
if (caller && !probe) {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(caller)) throw Error('invalid Paseo caller identity');
  const home = join(root, 'agents', caller);
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
      const merged = apply(JSON.parse(shared[file]), JSON.parse(text), JSON.parse(shared['models.json']));
      if (file === 'settings.json') requireCodemode(merged);
      files[file] = JSON.stringify(merged, null, 2) + '\n';
    } catch (error) { throw Error(`invalid ${path}: ${error.message}`); }
  }
  for (const [file, data] of Object.entries(files)) writeFileSync(join(home, file), data, { mode: 0o600 });
  if (existsSync(join(root, 'agent/AGENTS.md')))
    writeFileSync(join(home, 'AGENTS.md'), readFileSync(join(root, 'agent/AGENTS.md')), { mode: 0o600 });
  const url = new URL(spec.paseoMcp.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Paseo MCP must use loopback');
  url.searchParams.set('callerAgentId', caller);
  const mcp = JSON.parse(readFileSync(join(root, 'agent/mcp.json'), 'utf8'));
  env.LOADOUT_PI_MCP_URL = url.href;
  const modelIndex = args.lastIndexOf('--model');
  // Paseo 0.11 resumes with --session and applies the model over RPC; mcp_bridge reads the live model.
  if (modelIndex >= 0 && args[modelIndex + 1]) env.LOADOUT_PI_PARENT_MODEL = args[modelIndex + 1];
  else if (!args.includes('--session')) throw Error('Paseo must resolve a concrete catalog model');
  const thinkingIndex = args.lastIndexOf('--thinking');
  env.LOADOUT_PI_PARENT_THINKING = thinkingIndex < 0 ? spec.settings?.defaultThinkingLevel || '' : args[thinkingIndex + 1];
  // Pi treats an empty ${VAR} as missing and drops the server, so omit empty parent values (resume has no --model).
  const bridgeEnv = mcp.mcpServers?.paseo?.env;
  if (bridgeEnv) for (const key of ['LOADOUT_PI_PARENT_MODEL', 'LOADOUT_PI_PARENT_THINKING'])
    if (!env[key]) delete bridgeEnv[key];
  writeFileSync(join(home, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600 });
  env.PI_CODING_AGENT_DIR = home;
}
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Pi launch failed\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

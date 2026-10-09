// Stock Paseo 0.10.3 interim: each real agent gets a private, scoped mcp.json.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'));
const settings = JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8'));
if (settings.codemode?.mode !== 'on' || JSON.stringify(settings.defaultTools) !== '["+codemode"]'
    || !settings.extensions?.includes(join(root, 'fleet-routing.mjs')))
  throw Error('Pi requires fixed Codemode on');
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
if (caller) {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(caller)) throw Error('invalid Paseo caller identity');
  const home = join(root, 'agents', caller);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Keep sessions stable across resumes, without shared settings or MCP identity.
  for (const file of ['models.json', 'settings.json']) {
    writeFileSync(join(home, file), readFileSync(join(root, 'agent', file)), { mode: 0o600 });
  }
  if (existsSync(join(root, 'agent/AGENTS.md')))
    writeFileSync(join(home, 'AGENTS.md'), readFileSync(join(root, 'agent/AGENTS.md')), { mode: 0o600 });
  const url = new URL(spec.paseoMcp.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Paseo MCP must use loopback');
  url.searchParams.set('callerAgentId', caller);
  const mcp = JSON.parse(readFileSync(join(root, 'agent/mcp.json'), 'utf8'));
  env.LOADOUT_PI_MCP_URL = url.href;
  const args = process.argv.slice(2);
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
  // Workers read untrusted text, so role=worker agents get no Gmail. An unknown role keeps today's Gmail.
  if (mcp.mcpServers?.gmail) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'launch-labels', method: 'tools/call', params: { name: 'get_agent_status', arguments: { agentId: caller } } }),
        signal: AbortSignal.timeout(3000) });
      const text = await response.text();
      const value = response.headers.get('content-type')?.includes('text/event-stream')
        ? JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(text);
      const labels = value.result?.structuredContent?.snapshot?.labels;
      if (!response.ok || value.error || value.result?.isError || !labels) throw Error('agent snapshot unavailable');
      if (labels.role === 'worker') delete mcp.mcpServers.gmail;
    } catch (error) {
      process.stderr.write(`Pi Gmail kept: agent label lookup failed (${String(error?.message ?? error).slice(0, 80)})\n`);
    }
  }
  writeFileSync(join(home, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600 });
  env.PI_CODING_AGENT_DIR = home;
}
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Pi launch failed\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });

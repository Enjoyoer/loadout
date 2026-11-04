// Windows only. playwright_cli.sh runs this through the pinned playwright-core, with the arguments it
// is about to pass to the CLI, before every `open`, `attach` and `show`. It works out what the CLI's
// session daemon will do with them, using the CLI's own argument parser and config resolver, and lets
// a command through only when it starts no Chrome or Edge, or starts one on a profile whose Local
// State it has just seeded with seed_local_state.ps1. Chrome's blank-password check then logs no
// failed Windows logon. It never launches a browser. On success it prints the argument to add, if
// any, on stdout. Anything it cannot prove stops the command with exit 2.
//
// `open`, in the daemon's own order (createBrowser):
// - A remote or CDP endpoint from the config: the daemon only connects. Let through.
// - Extension mode: the daemon's relay starts Chrome on a profile the wrapper does not seed. Refused.
// - Firefox or WebKit: no blank-password check. Let through.
// - `--profile <dir>`, `browser.userDataDir` from the config files or PLAYWRIGHT_MCP_USER_DATA_DIR, or the
//   CLI's own dir for `--persistent`: that dir is seeded and, unless given with `--profile`, passed
//   back as `--profile=<dir>`.
// - Otherwise the CLI would start Chrome on a temporary profile it creates at launch, which cannot be
//   seeded. The session gets a new seeded dir of its own instead, under the CLI's session folder. Dirs
//   of earlier opens are removed only when they are older than 30 minutes, hold no browser lock, and
//   no session file or running process names them.
// - An explicitly isolated config (`browser.isolated: true` or PLAYWRIGHT_MCP_ISOLATED): refused.
// Then the final argument list is parsed and resolved again, exactly as the CLI will, and must name
// the seeded dir.
// `attach`: let through only when it connects to an endpoint or CDP; extension mode is refused.
// `show`: only `--kill` and `--port` start no Chrome; anything else opens the dashboard in Chrome on
// a temporary profile and is refused.
// PWDEBUG (the Inspector starts Chrome on a temporary profile) is refused for `open` and `attach`, and
// the wrapper exports PW_CODEGEN_NO_INSPECTOR=1, which keeps a paused headed session from opening it.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PINNED = '1.64.1';
const LAST_CHANGED = '9223372036854775807';
const KEEP_MS = 30 * 60 * 1000;

function stop(message) {
  process.stderr.write(`playwright_cli.sh: ${message}\n`);
  process.exit(2);
}

function isAbsent(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

// npx puts the pinned package's node_modules/.bin first on PATH.
function packageRoot() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (path.basename(dir) !== '.bin' || path.basename(path.dirname(dir)) !== 'node_modules')
      continue;
    const root = path.join(path.dirname(dir), 'playwright-core');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch (error) {
      if (isAbsent(error))
        continue;
      throw error;
    }
    if (manifest.version === PINNED)
      return root;
  }
  stop(`playwright-core@${PINNED} is not on PATH; run this through npx --package playwright-core@${PINNED}.`);
}

let minimist, help, registry, tools, clientInfo;

// The pinned CLI's own argument parser, registry and config resolver.
function load() {
  const root = packageRoot();
  const lib = (...parts) => path.join(root, 'lib', ...parts);
  ({ minimist } = require(lib('tools', 'cli-client', 'minimist.js')));
  help = require(lib('tools', 'cli-client', 'help.json'));
  registry = require(lib('tools', 'cli-client', 'registry.js'));
  ({ tools } = require(lib('coreBundle.js')));
  clientInfo = registry.createClientInfo();
}

// Parsed exactly as the CLI's program.js parses its arguments.
function parse(argv) {
  const args = minimist(argv, { boolean: [...help.booleanOptions, 'all', 'g', 'help', 'json', 'raw', 'version'], string: ['_'] });
  if (args.s) {
    args.session = args.s;
    delete args.s;
  }
  return args;
}

// The options the session daemon receives for `open` or `attach` (program.js, then Session.startDaemon).
function daemonOptions(command, input) {
  const args = { ...input };
  if (command === 'attach') {
    if (args._[1])
      args.endpoint = args._[1];
    if (typeof args.extension === 'string') {
      args.browser = args.extension;
      args.extension = true;
    }
  }
  const options = {};
  for (const key of ['headed', 'mobile', 'persistent'])
    if (args[key])
      options[key] = true;
  for (const key of ['device', 'browser', 'profile', 'config'])
    if (args[key])
      options[key] = `${args[key]}`;
  if (args.extension)
    options.extension = true;
  else if (args.cdp)
    options.cdp = `${args.cdp}`;
  else if (args.endpoint)
    options.endpoint = `${args.endpoint}`;
  return options;
}

async function resolve(session, options) {
  try {
    return await tools.resolveCLIConfigForCLI(clientInfo.daemonProfilesDir, session, options);
  } catch (error) {
    return { error };
  }
}

// What the daemon's createBrowser will do with a resolved config, in its own order.
function classify(config) {
  const browser = config.browser;
  if (browser.remoteEndpoint || browser.cdpEndpoint)
    return { kind: 'connect' };
  if (config.extension)
    return { kind: 'extension' };
  if (browser.browserName !== 'chromium')
    return { kind: 'other-browser' };
  if (browser.isolated)
    return { kind: 'temporary' };
  if (browser.userDataDir)
    return { kind: 'profile', dir: path.resolve(browser.userDataDir) };
  return { kind: 'unknown' };
}

function powershell() {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  const full = systemRoot && path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return full && fs.existsSync(full) ? full : 'powershell.exe';
}

function seed(dir) {
  const script = path.join(__dirname, 'seed_local_state.ps1');
  const run = spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', dir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const file = path.join(dir, 'Local State');
  if (run.error || run.status !== 0) {
    process.stderr.write(`${run.stdout || ''}${run.stderr || ''}`);
    stop(`could not seed ${file} (${run.error ? run.error.message : `exit ${run.status}`}); the browser was not started.`);
  }
  // Read it back independently of the helper.
  let state;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    state = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    stop(`could not read back ${file}: ${error.message}; the browser was not started.`);
  }
  const manager = state && state.password_manager;
  if (!manager || manager.os_password_blank !== false || manager.os_password_last_changed !== LAST_CHANGED)
    stop(`${file} does not hold the seeded values after seeding; the browser was not started.`);
}

// Command lines of the running processes, lowercased, or null when they cannot be read.
function processCommandLines() {
  if (process.platform === 'win32') {
    const run = spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error || run.status !== 0)
      return null;
    return run.stdout.split(/\r?\n/).map(line => line.toLowerCase());
  }
  if (process.platform === 'linux') {
    const lines = [];
    for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        lines.push(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').toLowerCase());
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH' && error.code !== 'EACCES')
          return null;
      }
    }
    return lines;
  }
  return null;
}

function holdsBrowserLock(dir) {
  // Chrome holds <dir>\lockfile open while it runs on Windows; <dir>/SingletonLock is a symlink elsewhere.
  for (const name of ['lockfile', 'SingletonLock']) {
    try {
      fs.lstatSync(path.join(dir, name));
      return true;
    } catch (error) {
      if (!isAbsent(error))
        return true;
    }
  }
  return false;
}

// Remove this session's seeded dirs of earlier opens, but only those older than KEEP_MS that hold no
// browser lock and that no session file and no running process names. Any doubt keeps every dir.
function removeOld(prefix) {
  const daemonDir = clientInfo.daemonProfilesDir;
  let names;
  try {
    names = fs.readdirSync(daemonDir);
  } catch (error) {
    if (isAbsent(error))
      return;
    throw error;
  }
  const now = Date.now();
  const candidates = [];
  for (const name of names) {
    const match = name.startsWith(prefix) && /^(\d+)-\d+$/.exec(name.slice(prefix.length));
    if (!match)
      continue;
    const dir = path.join(daemonDir, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    const newest = Math.max(Number(match[1]), stat.mtimeMs);
    if (!stat.isDirectory() || !(now - newest > KEEP_MS) || holdsBrowserLock(dir))
      continue;
    candidates.push(dir);
  }
  if (!candidates.length)
    return;
  // Every session file of every workspace may name a dir.
  const named = new Set();
  const base = path.dirname(daemonDir);
  try {
    for (const hash of fs.readdirSync(base)) {
      const hashDir = path.join(base, hash);
      if (!fs.statSync(hashDir).isDirectory())
        continue;
      for (const file of fs.readdirSync(hashDir).filter(n => n.endsWith('.session'))) {
        const config = JSON.parse(fs.readFileSync(path.join(hashDir, file), 'utf8'));
        if (config && config.browser && typeof config.browser.userDataDir === 'string')
          named.add(path.resolve(config.browser.userDataDir).toLowerCase());
      }
    }
  } catch {
    return;
  }
  const commandLines = processCommandLines();
  if (!commandLines)
    return;
  for (const dir of candidates) {
    const key = dir.toLowerCase();
    if (named.has(key) || commandLines.some(line => line.includes(key)))
      continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`playwright_cli.sh: left ${dir} in place: ${error.message}\n`);
    }
  }
}

const safeName = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

function oneString(args, key, flag) {
  if (key in args && !(typeof args[key] === 'string' && args[key] !== ''))
    stop(`${flag} needs exactly one non-empty value here; the browser was not started.`);
}

async function main() {
  load();
  const argv = process.argv.slice(2);
  const args = parse(argv);
  const command = args._ && args._[0];
  if (args.version || args.v || args.help || args.h || !command)
    return;

  if (command === 'show') {
    // program.js: --kill first, then --annotate, then --port.
    if (args.kill)
      return;
    if (!args.annotate && args.port !== undefined)
      return;
    stop('`show` and `show --annotate` open the dashboard in Chrome on a temporary profile that cannot be seeded, and on Windows that logs a failed logon; the wrapper runs only `show --port <n>` and `show --kill` there.');
  }
  if (command !== 'open' && command !== 'attach')
    return;

  const debug = process.env.PWDEBUG;
  if (debug && debug !== '0' && debug !== 'false')
    stop('PWDEBUG opens the Playwright Inspector in Chrome on a temporary profile that cannot be seeded; unset it.');
  if (!process.env.PW_CODEGEN_NO_INSPECTOR)
    stop('PW_CODEGEN_NO_INSPECTOR is not set; run the CLI through playwright_cli.sh.');
  oneString(args, 'profile', '--profile');
  oneString(args, 'session', '--session');

  const session = registry.resolveSessionName(args.session);
  const config = await resolve(session, daemonOptions(command, args));
  if (config.error)
    stop(`could not resolve the browser config: ${config.error.message}`);
  const plan = classify(config);
  if (plan.kind === 'connect' || plan.kind === 'other-browser')
    return;
  if (plan.kind === 'extension')
    stop('extension mode starts Chrome or Edge on a profile the wrapper does not seed; on Windows it is not supported through the wrapper.');
  if (command === 'attach')
    stop('on Windows the wrapper runs `attach` only to a running browser (`attach <name>`, `--endpoint` or `--cdp`).');

  let dir;
  let prefix;
  if (plan.kind === 'temporary') {
    if (config.browser.isolated !== true || 'profile' in args)
      stop('could not tell which profile the browser would start on; pass --profile <dir>.');
    const token = (config.browser.launchOptions && config.browser.launchOptions.channel) || config.browser.browserName;
    const key = crypto.createHash('sha1').update(`${session}\0${token}`).digest('hex').slice(0, 8);
    prefix = `ud-${safeName(session)}-${safeName(token)}-seeded-${key}-`;
    dir = path.join(clientInfo.daemonProfilesDir, `${prefix}${Date.now()}-${process.pid}`);
  } else if (plan.kind === 'profile') {
    dir = plan.dir;
  } else {
    stop('could not tell which profile the browser would start on; pass --profile <dir>.');
  }

  // Prove it on the final arguments, parsed and resolved as the CLI and its daemon will.
  const inject = !('profile' in args);
  const finalArgs = parse(inject ? [`--profile=${dir}`, ...argv] : argv);
  const finalSession = registry.resolveSessionName(finalArgs.session);
  const finalOptions = daemonOptions(command, finalArgs);
  const final = await resolve(finalSession, finalOptions);
  if (final.error)
    stop(`${final.error.message} On Windows the wrapper does not start Chrome on a temporary profile: remove \`browser.isolated: true\` from the config (or unset PLAYWRIGHT_MCP_ISOLATED), and each \`open\` gets a fresh seeded profile instead.`);
  const check = classify(final);
  if (finalArgs._[0] !== command || finalSession !== session || typeof finalArgs.profile !== 'string' ||
      path.resolve(finalOptions.profile || '') !== dir || check.kind !== 'profile' || check.dir !== dir)
    stop(`the CLI would not start the browser on ${dir}; the browser was not started.`);

  if (prefix) {
    fs.mkdirSync(clientInfo.daemonProfilesDir, { recursive: true });
    fs.mkdirSync(dir); // Fails if it exists: the dir is new.
    removeOld(prefix);
  }
  seed(dir);
  if (inject)
    process.stdout.write(`--profile=${dir}\n`);
}

main().catch(error => stop(error && error.stack ? error.stack : String(error)));

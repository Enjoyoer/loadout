// Windows only. playwright_cli.sh runs this through the pinned playwright-core, with the arguments it
// is about to pass to the CLI, before every `open`. It finds the user-data dir that `open` will start
// Chrome or Edge on, the way the CLI's own session daemon does, and seeds its Local State with
// seed_local_state.ps1, so Chrome's blank-password check never logs a failed Windows logon.
//
// - `--profile <dir>`: that dir is seeded.
// - Otherwise the dir the CLI would use (`browser.userDataDir` from the config files or
//   PLAYWRIGHT_MCP_USER_DATA_DIR, or the CLI's own dir for `--persistent`) is seeded and passed back
//   as `--profile=<dir>`, so the CLI starts exactly the dir that was seeded.
// - With none of those, the CLI would start Chrome on a temporary profile it creates at launch, which
//   cannot be seeded. That session gets a fresh seeded dir of its own instead, a new one at each
//   `open`, under the CLI's session folder; dirs of earlier opens are removed once no session uses them.
// - Attaching to a running browser (CDP, remote endpoint, extension), and Firefox or WebKit, need nothing.
// - `show` starts Chrome on a temporary profile, so it is refused.
// On success it prints the argument to add, if any, on stdout; it never launches a browser. Anything
// it cannot settle stops the launch with exit 2.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PINNED = '1.64.1';
const LAST_CHANGED = '9223372036854775807';

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

const safeName = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

// Remove fresh dirs of earlier opens of this session that no session file names and no browser holds.
function removeUnused(baseDir, prefix) {
  let names;
  try {
    names = fs.readdirSync(baseDir);
  } catch (error) {
    if (isAbsent(error))
      return;
    throw error;
  }
  const inUse = new Set();
  for (const name of names.filter(n => n.endsWith('.session'))) {
    let config;
    try {
      config = JSON.parse(fs.readFileSync(path.join(baseDir, name), 'utf8'));
    } catch {
      return; // A session file that cannot be read might name any dir: remove nothing.
    }
    if (config && config.browser && typeof config.browser.userDataDir === 'string')
      inUse.add(path.resolve(config.browser.userDataDir).toLowerCase());
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d+-\d+$/.test(name.slice(prefix.length)))
      continue;
    const dir = path.join(baseDir, name);
    // Chrome holds <dir>\lockfile open while it runs.
    if (inUse.has(dir.toLowerCase()) || fs.existsSync(path.join(dir, 'lockfile')))
      continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`playwright_cli.sh: left ${dir} in place: ${error.message}\n`);
    }
  }
}

async function main() {
  const root = packageRoot();
  const lib = (...parts) => path.join(root, 'lib', ...parts);
  const { minimist } = require(lib('tools', 'cli-client', 'minimist.js'));
  const help = require(lib('tools', 'cli-client', 'help.json'));
  const registry = require(lib('tools', 'cli-client', 'registry.js'));

  // Parsed as the CLI's program.js parses its arguments.
  const args = minimist(process.argv.slice(2), { boolean: [...help.booleanOptions, 'all', 'g', 'help', 'json', 'raw', 'version'], string: ['_'] });
  if (args.s)
    args.session = args.s;
  const command = args._ && args._[0];
  if (args.version || args.v || args.help || args.h || !command)
    return;
  if (command === 'show') {
    if (!args.kill && !args.annotate)
      stop('`show` opens its dashboard in Chrome on a temporary profile that cannot be seeded, and on Windows that logs a failed logon; the wrapper does not run it there.');
    return;
  }
  if (command !== 'open')
    return;

  // The options the CLI passes to its session daemon for `open` that decide the browser and profile.
  const options = {};
  for (const key of ['browser', 'config', 'device', 'profile'])
    if (args[key])
      options[key] = `${args[key]}`;
  for (const key of ['headed', 'mobile', 'persistent'])
    if (args[key])
      options[key] = true;

  const { tools } = require(lib('coreBundle.js'));
  const clientInfo = registry.createClientInfo();
  const session = registry.resolveSessionName(args.session);
  const resolve = extra => tools.resolveCLIConfigForCLI(clientInfo.daemonProfilesDir, session, { ...options, ...extra });
  let config;
  try {
    config = await resolve({});
  } catch (error) {
    stop(`could not resolve the browser config: ${error.message}`);
  }
  const browser = config.browser;
  if (browser.browserName !== 'chromium' || browser.remoteEndpoint || browser.cdpEndpoint || config.extension)
    return;

  if (options.profile) {
    seed(path.resolve(options.profile));
    return;
  }

  let dir;
  let prefix;
  if (browser.isolated) {
    const token = (browser.launchOptions && browser.launchOptions.channel) || browser.browserName;
    const key = crypto.createHash('sha1').update(`${session}\0${token}`).digest('hex').slice(0, 8);
    prefix = `ud-${safeName(session)}-${safeName(token)}-seeded-${key}-`;
    dir = path.join(clientInfo.daemonProfilesDir, `${prefix}${Date.now()}-${process.pid}`);
  } else if (browser.userDataDir) {
    dir = path.resolve(browser.userDataDir);
  } else {
    stop('could not tell which profile the browser would start on; pass --profile <dir>.');
  }

  // The CLI must take exactly this dir once it is passed as --profile.
  let check;
  try {
    check = await resolve({ profile: dir });
  } catch (error) {
    stop(`${error.message} On Windows the wrapper does not start Chrome on a temporary profile: remove \`browser.isolated: true\` from the config (or unset PLAYWRIGHT_MCP_ISOLATED), and each \`open\` gets a fresh seeded profile instead.`);
  }
  if (check.browser.isolated || path.resolve(check.browser.userDataDir) !== dir)
    stop(`the CLI would not start the browser on ${dir}; pass --profile <dir>.`);

  if (prefix)
    removeUnused(clientInfo.daemonProfilesDir, prefix);
  seed(dir);
  process.stdout.write(`--profile=${dir}\n`);
}

main().catch(error => stop(error && error.stack ? error.stack : String(error)));

// Merge pinned Paseo provider fields into this host's Paseo config.
// Shipped gzip+base64 by paseo_providers.py; argv[2] is the gzip+base64 JSON payload:
// {host, providers, disabled, env, required_env, launch, stamp, dry_run, config_path, paseo_home}.
// It ships without whole-line comments and indentation (merge_program), so it holds no multiline string.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const p = JSON.parse(zlib.gunzipSync(Buffer.from(process.argv[2], "base64")).toString());
// wrote: this run changed, or may have changed, the host (its config or its Pi runtime), so a reload is owed.
const disabled = p.disabled || [];
const result = { host: p.host, changed: false, wrote: false, backup: null, preserved: [], disabled, verified: false, error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
// A disabled provider reads back as enabled:false with no models key, so its picker shows nothing.
function labelsMatch(providers) {
  if (!disabled.every(k => providers[k] && providers[k].enabled === false && !('models' in providers[k]))) return false;
  return Object.keys(p.providers).every(k => {
    const want = p.providers[k].models, got = (providers[k] || {}).models || [];
    return !want || want.length === got.length && want.every((m, i) => got[i].id === m.id && got[i].label === m.label);
  });
}
try {
  // paseo_providers.py refuses these first; the merge never trusts its payload alone.
  for (const k of disabled) {
    if (['pi', 'claude', 'codex'].includes(k)) throw Error('refusing to disable protected provider ' + k);
    if (k in p.providers) throw Error('provider ' + k + ' is both pinned and disabled');
  }
  // The host's paseo_home from hosts.json, ~ expanded here, or the default home; never an inherited PASEO_HOME.
  const home = p.paseo_home ? p.paseo_home.replace(/^~(?=[/\\]|$)/, os.homedir()) : path.join(os.homedir(), ".paseo");
  const cfgPath = p.config_path || path.join(home, "config.json");
  // Standalone relay payload: mirror remote_common's home/root ancestor and regular-file checks.
  const check = (target = cfgPath) => {
    const root = path.dirname(path.resolve(target)), rel = path.relative(os.homedir(), root);
    const base = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? os.homedir() : root;
    const dirs = path.relative(base, root).split(path.sep).filter(Boolean);
    let cur = base;
    for (const part of ["", ...dirs]) {
      cur = path.join(cur, part);
      let st;
      try { st = fs.lstatSync(cur); } catch (e) { if (e.code === "ENOENT") return; throw e; }
      if (!st.isDirectory() || st.isSymbolicLink()) throw Error("not a real directory: " + cur);
    }
    let st;
    try { st = fs.lstatSync(target); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (!st.isFile() || st.isSymbolicLink()) throw Error("not a regular config file: " + target);
  };
  const read = () => { check(); return fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "{}"; };
  const expand = value => value.replace(/^~(?=[/\\]|$)/, os.homedir())
    .replace(/%([^%]+)%/g, (_, key) => {
      // A host value lands in config.json and its backups in plain text, so never copy a secret.
      // PAT, PASSWD and PWD only as a whole _ part, so PATH and LOCALAPPDATA pass.
      if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(^|_)(PAT|PASSWD|PWD)(_|$)/i.test(key)) throw Error('refusing secret-looking host env ' + key);
      return process.env[key] || (() => { throw Error('missing host env ' + key); })();
    });
  for (const env of Object.values(p.env)) for (const key of Object.keys(env)) env[key] = expand(env[key]);
  const visit = value => typeof value === 'string' ? value.replace(/\$\{([A-Z_]+)\}/g,
    (_, key) => p.env.pi?.[key] || (() => { throw Error('missing provider env ' + key); })())
    : Array.isArray(value) ? value.map(visit) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)])) : value;
  p.providers = visit(p.providers);
  const servers = p.mcpServers || [];
  const envRoot = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'loadout')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'loadout');
  const launcher = path.join(envRoot, 'mcp-env.cjs');
  const envServers = servers.filter(s => s.envFile);
  // Per provider launch settings, read by the launcher for the harness it names: token files and leading args.
  const launch = p.launch || {};
  if (Object.keys(launch).length && process.platform === 'win32') throw Error('provider launch settings need a POSIX host');
  const providerWrapped = raw => Object.values((JSON.parse(raw).agents || {}).providers || {}).some(row =>
    Array.isArray(row.command) && row.command[1] === launcher && row.command[2] === '--provider');
  // Wiring stays managed while a provider still launches with --provider, so dropping its settings unwraps it.
  const manageLaunch = envServers.length > 0 || Object.keys(launch).length > 0 || providerWrapped(read());
  const envPlans = [];
  if (manageLaunch) {
    // Without MCP servers or launch settings the payload carries no launcher; the one on the host stays.
    if (p.mcp_env_launcher) envPlans.push([launcher, p.mcp_env_launcher]);
    envPlans.push([path.join(envRoot, 'mcp-env.json'), JSON.stringify({ servers: envServers, providers: launch }, null, 2) + '\n']);
    for (const [file] of envPlans) check(file);
  }
  // Reported only when set, so a result without launch settings keeps its earlier shape.
  if (Object.keys(launch).length) result.launch = [];
  for (const [id, settings] of Object.entries(launch)) {
    if (settings.args) result.launch.push(id + ' args ' + settings.args.join(' '));
    for (const [key, tokenFile] of Object.entries(settings.tokenFiles || {})) {
      const file = tokenFile.replace(/^~\//, os.homedir() + '/');
      check(file);
      // Size and mode only; the launcher reads the value at launch time.
      const st = probe(fs, file, true);
      const ready = st && st.size > 0 && (st.mode & 0o777) === 0o600 && st.uid === process.getuid();
      result.launch.push(id + ' ' + key + ' tokenFile ' + tokenFile + (ready ? ' present, owner-only' : ' missing or unsafe'));
      if (!ready && !p.dry_run) throw Error('token file missing or unsafe for ' + id + ' ' + key);
    }
  }
  result.mcp = [];
  for (const s of servers) {
    result.mcp.push(s.name + ' ' + (s.enabled ? s.url + ' bearer env ' + s.bearerTokenEnvVar : 'disabled'));
    if (!s.enabled) continue;
    if (s.envFile) {
      const file = s.envFile.replace(/^~\//, os.homedir() + '/');
      check(file);
      // probe() from remote_common.js, not existsSync: an unreadable env file throws instead of reading as absent.
      const st = probe(fs, file, true);
      const ready = st && st.size > s.bearerTokenEnvVar.length + 1 && (st.mode & 0o777) === 0o600 && st.uid === process.getuid();
      result.mcp.push(s.bearerTokenEnvVar + ' envFile ' + s.envFile + (ready ? ' present, owner-only' : ' missing or unsafe'));
      if (!ready && !p.dry_run) throw Error('MCP envFile missing or unsafe for ' + s.bearerTokenEnvVar);
    } else {
      // Windows user environment, not this already-running daemon's stale inherited environment.
      const {execFileSync} = require('child_process');
      const script = '$v=[Environment]::GetEnvironmentVariable(' + JSON.stringify(s.bearerTokenEnvVar) + ',"User"); if($null -eq $v){0}else{$v.Length}';
      const length = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());
      result.mcp.push(s.bearerTokenEnvVar + ' user env length=' + length + '; restart earlier daemons to inherit');
      if (!length && !p.dry_run) throw Error('MCP user env missing for ' + s.bearerTokenEnvVar);
    }
  }
  // The pinned rows merged into one config revision, with the required env checked on the result. It changes
  // nothing, so it runs before the Pi runtime is touched, and again on any newer revision before publishing.
  const merge = raw => {
    const cfg = JSON.parse(raw), agents = cfg.agents || {}, prev = agents.providers || {};
    const merged = Object.assign({}, prev);
    for (const k of Object.keys(p.providers)) merged[k] = Object.assign({}, prev[k] || {}, p.providers[k]);
    for (const k of Object.keys(p.env)) {
      merged[k] = Object.assign({}, merged[k] || {});
      merged[k].env = Object.assign({}, (prev[k] || {}).env || {}, p.env[k]);
    }
    // Turned off: keep every other existing field, drop the models.
    for (const k of disabled) {
      const { models, ...rest } = merged[k] || {};
      merged[k] = { ...rest, enabled: false };
    }
    if (manageLaunch) for (const provider of ['codex', 'claude', 'pi']) {
      if (!merged[provider] || merged[provider].enabled === false) continue;
      const rawCommand = merged[provider].command || [provider];
      const command = typeof rawCommand === 'string' ? [rawCommand] : rawCommand;
      if (!Array.isArray(command) || !command.length || !command.every(arg => typeof arg === 'string'))
        throw Error('unsupported MCP provider command for ' + provider);
      const named = command[1] === launcher && command[2] === '--provider' && command[4] === '--';
      const wasWrapped = named || command[1] === launcher && command[2] === '--';
      const original = wasWrapped ? command.slice(named ? 5 : 3) : command;
      const own = launch[provider];
      if (own && own.args && original.length !== 1)
        throw Error('launch args for ' + provider + ' need a command that is the executable alone');
      merged[provider] = { ...merged[provider], command: own || envServers.some(s => s.enabled)
        ? [process.execPath, launcher, ...(own ? ['--provider', provider] : []), '--', ...original] : original };
    }
    const missing = [];
    for (const k of Object.keys(p.required_env))
      for (const key of p.required_env[k]) if (!((merged[k] || {}).env || {})[key]) missing.push(k + "." + key);
    if (missing.length) throw new Error("required env missing: " + missing.join(", "));
    return { raw, prev, merged, rows: JSON.stringify(prev) !== JSON.stringify(merged),
             text: JSON.stringify({ ...cfg, agents: { ...agents, providers: merged } }, null, 2) };
  };
  let m = merge(read());
  const envChanged = envPlans.filter(([file, data]) => !probe(fs, file, true) || fs.readFileSync(file, 'utf8') !== data);
  if (!p.dry_run) for (const [file, data] of envChanged) {
    check(file);
    fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
    check(file);
    const before = probe(fs, file, true) ? fs.readFileSync(file) : null;
    const tag = p.stamp + '-' + crypto.randomBytes(8).toString('hex');
    if (before) {
      const backup = file + '.bak-loadout-' + tag;
      replaceFile(fs, backup, before, 0o600, undefined, () => {
        check(backup); if (probe(fs, backup, true)) throw Error('MCP backup already exists');
      });
      if (!fs.readFileSync(backup).equals(before)) throw Error('MCP backup failed');
    }
    // An uncertain replacement also owes a reload through the existing provider debt record.
    result.wrote = true;
    replaceFile(fs, file, data, 0o600, fd => fs.fsyncSync(fd), () => {
      check(file);
      const now = probe(fs, file, true) ? fs.readFileSync(file) : null;
      if (before === null ? now !== null : now === null || !now.equals(before))
        throw Error('MCP launcher changed during merge, left as is');
    });
    if (fs.readFileSync(file, 'utf8') !== data) throw Error('MCP launcher write failed');
  }
  if (envChanged.length) result.mcp.push('env loader ' + envChanged.map(([file]) => path.basename(file)).join(', '));
  if (p.pi) {
    const {spawnSync} = require('child_process');
    const runtimeRoot = expand(p.pi.root);
    if (!p.dry_run) {
      const env={...process.env};for(const key of ['PASEO_HOME','PASEO_HOST','PASEO_AGENT_ID','PASEO_AGENT_CWD']) delete env[key];
      if(p.paseo_home) env.PASEO_HOME=home;
      // Windows ships the CLI as an npm .cmd shim, which only runs through a shell. The command is a
      // constant; one string avoids Node's DEP0190 warning for args with shell:true.
      const status=process.platform==='win32'
        ? spawnSync('paseo daemon status --json',{env,encoding:'utf8',shell:true})
        : spawnSync('paseo',['daemon','status','--json'],{env,encoding:'utf8'});
      const daemon=status.status===0 ? JSON.parse(status.stdout) : {};
      // >=0.10.3 <0.12.0, release versions only.
      const got=/^(\d+)\.(\d+)\.(\d+)$/.exec(typeof daemon.daemonVersion==='string'?daemon.daemonVersion:'');
      const v=got?got.slice(1).map(Number):null, cmp=(a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2];
      if(!v||cmp(v,[0,10,3])<0||cmp(v,[0,12,0])>=0||daemon.connectedDaemon!=='reachable') throw Error('reachable stock Paseo >=0.10.3 <0.12.0 required for Pi sync');
    }
    const pkg = path.join(runtimeRoot, 'app/node_modules/@earendil-works/pi-coding-agent/package.json');
    if (!p.dry_run && (!fs.existsSync(pkg) || JSON.parse(fs.readFileSync(pkg)).version !== '1.0.0'))
      throw Error('install official Pi 1.0.0 with the reviewed apply script first');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-pi-provider-'));
    try {
      for (const [name, content] of Object.entries(p.pi_files)) fs.writeFileSync(path.join(temp, name), content, {mode:0o600});
      const spec = path.join(temp, 'spec.json');fs.writeFileSync(spec, JSON.stringify(p.pi.runtime), {mode:0o600});
      const args=[path.join(temp,'configure.py'),'--spec',spec,'--root',runtimeRoot];
      if(p.dry_run) args.push('--dry-run');
      const configured=spawnSync(p.pi.runtime.python || (process.platform==='win32'?'python':'python3'),args,{encoding:'utf8'});
      let report=null;
      try { report=configured.status===0 ? JSON.parse(configured.stdout) : null; } catch (e) { /* below */ }
      if(!report) {
        // configure.py backs up and replaces runtime files one by one, so unless it never started, a failure can
        // leave some written: they count as written, and the reload they need stays owed.
        if(!p.dry_run && !configured.error) result.wrote=true;
        throw Error('Pi runtime configuration failed'+(result.wrote?'; runtime files may have changed':''));
      }
      result.pi=report;
      if(!p.dry_run && report.changed.length) result.wrote=true;
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
  }
  let published = false;
  if (!p.dry_run) {
    // Replace the config only while it still holds the revision this merge read. A change another writer (the
    // daemon, an editor) made since then is merged again, never overwritten, and the backup is the revision
    // replaced, under a name no other run uses.
    for (let attempt = 1; ; attempt++) {
      const raw = read();
      if (raw !== m.raw) m = merge(raw);
      if (!m.rows) break;
      if (attempt > 3) throw new Error("config.json kept changing during the merge; it was not replaced");
      const tag = p.stamp + "-" + crypto.randomBytes(4).toString("hex");
      const bak = cfgPath + ".bak-loadout-" + tag, next = cfgPath + ".loadout-next-" + tag;
      check();
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      check();
      fs.writeFileSync(bak, m.raw, { mode: 0o600, flag: "wx" });
      if (fs.readFileSync(bak, "utf8") !== m.raw) throw new Error("backup failed: " + bak);
      check();
      fs.writeFileSync(next, m.text, { mode: 0o600, flag: "wx" });
      if (read() === m.raw) {
        check();
        fs.renameSync(next, cfgPath);
        result.backup = path.basename(bak);
        result.wrote = published = true;
        break;
      }
      fs.rmSync(next, { force: true });
      fs.rmSync(bak, { force: true });
    }
  }
  if (servers.length || Object.keys(launch).length) {
    const fields = Object.entries(m.merged).flatMap(([provider, row]) => Object.keys(row).filter(key =>
      JSON.stringify(row[key]) !== JSON.stringify(m.prev[provider]?.[key])).map(key => provider + '.' + key));
    (servers.length ? result.mcp : result.launch).push('provider fields: ' + (fields.join(', ') || 'unchanged'));
    if (result.pi) result.mcp.push('Pi runtime files: ' + (result.pi.changed.join(', ') || 'unchanged'));
  }
  result.preserved = Object.keys(m.prev).filter(k => !(k in p.providers) && !(k in p.env) && !disabled.includes(k));
  result.changed = Boolean(result.pi?.changed?.length) || m.rows || envChanged.length > 0;
  const now = published ? JSON.parse(read()).agents.providers : m.merged;
  result.verified = labelsMatch(now);
  done(result.verified ? 0 : 4);
} catch (e) {
  result.error = String(e && e.message || e);
  done(3);
}

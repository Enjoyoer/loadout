// Merge pinned Paseo provider fields into this host's Paseo config.
// Shipped gzip+base64 by paseo_providers.py; argv[2] is the gzip+base64 JSON payload:
// {host, providers, env, required_env, stamp, dry_run, config_path}.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const p = JSON.parse(zlib.gunzipSync(Buffer.from(process.argv[2], "base64")).toString());
const result = { host: p.host, changed: false, wrote: false, backup: null, preserved: [], verified: false, error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
function labelsMatch(providers) {
  return Object.keys(p.providers).every(k => {
    const want = p.providers[k].models, got = (providers[k] || {}).models || [];
    return !want || want.length === got.length && want.every((m, i) => got[i].id === m.id && got[i].label === m.label);
  });
}
try {
  const cfgPath = p.config_path || path.join(os.homedir(), ".paseo", "config.json");
  const raw = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "{}";
  const expand = value => value.replace(/^~(?=[/\\]|$)/, os.homedir())
    .replace(/%([^%]+)%/g, (_, key) => process.env[key] || (() => { throw Error('missing host env ' + key); })());
  for (const env of Object.values(p.env)) for (const key of Object.keys(env)) env[key] = expand(env[key]);
  const visit = value => typeof value === 'string' ? value.replace(/\$\{([A-Z_]+)\}/g,
    (_, key) => p.env.pi?.[key] || (() => { throw Error('missing provider env ' + key); })())
    : Array.isArray(value) ? value.map(visit) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)])) : value;
  p.providers = visit(p.providers);
  p.agentProfiles = visit(p.agentProfiles);
  if (p.pi) {
    const {spawnSync} = require('child_process');
    const runtimeRoot = expand(p.pi.root);
    if (!p.dry_run) {
      const env={...process.env};for(const key of ['PASEO_HOME','PASEO_HOST','PASEO_AGENT_ID','PASEO_AGENT_CWD']) delete env[key];
      const status=spawnSync('paseo',['daemon','status','--json'],{env,encoding:'utf8'});
      const daemon=status.status===0 ? JSON.parse(status.stdout) : {};
      if(daemon.daemonVersion!=='0.10.3'||daemon.connectedDaemon!=='reachable') throw Error('reachable stock Paseo 0.10.3 required for Pi sync');
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
      if(configured.status!==0) throw Error('Pi runtime configuration failed');
      result.pi=JSON.parse(configured.stdout);
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
  }
  const cfg = JSON.parse(raw);
  cfg.agents = cfg.agents || {};
  const prev = cfg.agents.providers || {};
  const merged = Object.assign({}, prev);
  for (const k of Object.keys(p.providers)) merged[k] = Object.assign({}, prev[k] || {}, p.providers[k]);
  for (const k of Object.keys(p.env)) {
    merged[k] = Object.assign({}, merged[k] || {});
    merged[k].env = Object.assign({}, (prev[k] || {}).env || {}, p.env[k]);
  }
  const missing = [];
  for (const k of Object.keys(p.required_env))
    for (const key of p.required_env[k]) if (!((merged[k] || {}).env || {})[key]) missing.push(k + "." + key);
  if (missing.length) throw new Error("required env missing: " + missing.join(", "));
  result.preserved = Object.keys(prev).filter(k => !(k in p.providers) && !(k in p.env));
  const previousProfiles = cfg.daemon?.agentProfiles || [];
  const profiles = p.agentProfiles ? [...previousProfiles.filter(row => !p.agentProfiles.some(want => want.id === row.id)), ...p.agentProfiles] : previousProfiles;
  result.changed = Boolean(result.pi?.changed?.length) || JSON.stringify(prev) !== JSON.stringify(merged) || JSON.stringify(profiles) !== JSON.stringify(previousProfiles);
  if (result.changed && !p.dry_run) {
    const bak = cfgPath + ".bak-loadout-" + p.stamp;
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(bak, raw, { mode: 0o600 });
    if (fs.readFileSync(bak, "utf8") !== raw) throw new Error("backup failed: " + bak);
    result.backup = path.basename(bak);
    cfg.agents.providers = merged;
    if (p.agentProfiles) { cfg.daemon ||= {}; cfg.daemon.agentProfiles = profiles; }
    const next = cfgPath + ".loadout-next";
    fs.writeFileSync(next, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(next, cfgPath);
    result.wrote = true;
  }
  const now = result.wrote ? JSON.parse(fs.readFileSync(cfgPath, "utf8")).agents.providers : merged;
  result.verified = labelsMatch(now);
  done(result.verified ? 0 : 4);
} catch (e) {
  result.error = String(e && e.message || e);
  done(3);
}

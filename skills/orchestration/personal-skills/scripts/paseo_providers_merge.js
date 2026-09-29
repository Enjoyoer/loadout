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
    return want.length === got.length && want.every((m, i) => got[i].id === m.id && got[i].label === m.label);
  });
}
try {
  const cfgPath = p.config_path || path.join(os.homedir(), ".paseo", "config.json");
  const raw = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "{}";
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
  result.changed = JSON.stringify(prev) !== JSON.stringify(merged);
  if (result.changed && !p.dry_run) {
    const bak = cfgPath + ".bak-loadout-" + p.stamp;
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(bak, raw, { mode: 0o600 });
    if (fs.readFileSync(bak, "utf8") !== raw) throw new Error("backup failed: " + bak);
    result.backup = path.basename(bak);
    cfg.agents.providers = merged;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    result.wrote = true;
  }
  const now = result.wrote ? JSON.parse(fs.readFileSync(cfgPath, "utf8")).agents.providers : merged;
  result.verified = labelsMatch(now);
  done(result.verified ? 0 : 4);
} catch (e) {
  result.error = String(e && e.message || e);
  done(3);
}

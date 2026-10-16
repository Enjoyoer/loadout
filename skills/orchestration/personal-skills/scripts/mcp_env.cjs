// Launch a harness with fleet MCP credentials in memory only. Never source shell code.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const file = path.join(__dirname, 'mcp-env.json');
function loadEnv(servers, env = process.env) {
  const out = { ...env };
  for (const s of servers.filter(s => s.enabled && s.envFile)) {
    const key = s.bearerTokenEnvVar;
    try {
      const target = s.envFile.replace(/^~\//, os.homedir() + '/');
      if (!path.isAbsolute(target)) throw Error();
      for (const part of [target, ...parents(path.dirname(target))]) {
        const st = fs.lstatSync(part);
        if (st.isSymbolicLink() || (part === target ? !st.isFile() : !st.isDirectory())) throw Error();
      }
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let raw;
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid() || st.size > 65536) throw Error();
        raw = fs.readFileSync(fd, 'utf8');
      } finally { fs.closeSync(fd); }
      const lines = raw.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
      if (lines.length !== 1 || !lines[0].startsWith(key + '=')) throw Error();
      const value = lines[0].slice(key.length + 1);
      if (!value || /[\x00-\x1f\x7f]/.test(value)) throw Error();
      out[key] = value;
    } catch { throw Error('MCP env file unavailable or unsafe for ' + key + ' (requires owner-only 0600 VAR= line)'); }
  }
  return out;
}
function parents(dir) {
  const out = [];
  for (;;) { out.push(dir); const next = path.dirname(dir); if (next === dir) return out; dir = next; }
}
module.exports = { loadEnv };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.shift() !== '--' || !args.length) throw Error('usage: node mcp-env.cjs -- <harness> [args]');
    const env = loadEnv(JSON.parse(fs.readFileSync(file, 'utf8')));
    const child = spawn(args[0], args.slice(1), { env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', () => { process.stderr.write('MCP harness launch failed\n'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

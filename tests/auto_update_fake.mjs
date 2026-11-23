// Fake tool, probe and paseo for tests/test_auto_update.py. Every behavior comes from <dir>/behavior.json.
//   auto_update_fake.mjs <dir> <component> version|stage|precheck|apply|health|rollback [version]
//   auto_update_fake.mjs <dir> probe
//   auto_update_fake.mjs <dir> paseo ls ... | paseo send --no-wait [--host h] <id> <line>
import fs from "node:fs";
import path from "node:path";

const [dir, what, step, ...rest] = process.argv.slice(2);
const behavior = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
const log = (line) => fs.appendFileSync(path.join(dir, "calls.log"), line + "\n");
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);

if (what === "paseo") {
  if (step === "ls") { process.stdout.write(JSON.stringify(behavior.pm_matches ?? [{ id: "pm-1" }])); process.exit(0); }
  if (step === "send") { fs.appendFileSync(path.join(dir, "sent.log"), rest[rest.length - 1] + "\n"); process.exit(behavior.send_exit ?? 0); }
  process.exit(2);
}
if (what === "probe") {
  log("probe");
  if (behavior.probe_exit) process.exit(behavior.probe_exit);
  process.stdout.write(JSON.stringify(behavior.probe) + "\n");
  process.exit(0);
}

const file = path.join(dir, `${what}.installed`);
const b = (behavior.components && behavior.components[what]) || {};
log(`${what} ${step} ${rest.join(" ")}`);
if (step === "version") { process.stdout.write(`${what} ${fs.readFileSync(file, "utf8").trim()}\n`); process.exit(0); }
if (b[`${step}_sleep`]) sleep(b[`${step}_sleep`]);
const code = b[`${step}_exit`] ?? 0;
if (code !== 0 && step !== "apply") process.exit(code);
if (step === "apply") {
  if (code === 75) process.exit(75);
  fs.writeFileSync(path.join(dir, `${what}.previous`), fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, rest[0]);
  process.exit(code);
}
if (step === "rollback") {
  const prev = path.join(dir, `${what}.previous`);
  if (fs.existsSync(prev)) fs.writeFileSync(file, fs.readFileSync(prev, "utf8"));
}
process.exit(0);

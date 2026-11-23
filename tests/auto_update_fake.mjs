// Fake tool, probe and paseo for tests/test_auto_update.py. Every behavior comes from <dir>/behavior.json.
//   auto_update_fake.mjs <dir> <component> version|stage|precheck|apply|health|rollback [version] [txn dir]
//   auto_update_fake.mjs <dir> probe [name]       behavior.probes[name] (else behavior.probe), exit probe_exits[name]
//   auto_update_fake.mjs <dir> paseo ls ... | paseo send --no-wait [--host h] <id> <line>
import fs from "node:fs";
import { spawn } from "node:child_process";
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
  log(`probe ${step || ""}`.trim());
  const code = step ? (behavior.probe_exits || {})[step] : behavior.probe_exit;
  if (step && (behavior.probe_sleeps || {})[step]) sleep(behavior.probe_sleeps[step]);
  if (code) process.exit(code);
  process.stdout.write(JSON.stringify((step && (behavior.probes || {})[step]) || behavior.probe) + "\n");
  process.exit(0);
}

const file = path.join(dir, `${what}.installed`);
const b = (behavior.components && behavior.components[what]) || {};
log(`${what} ${step} ${rest.join(" ")}`);
if (step === "version") { process.stdout.write(`${what} ${fs.readFileSync(file, "utf8").trim()}\n`); process.exit(0); }
// Side effects a step can have: a staged download in the transaction directory, files written or copied.
if (step === "stage" && b.stage_artifact && rest[1]) fs.writeFileSync(path.join(rest[1], "staged.bin"), "x".repeat(4096));
for (const [from, to] of b[`${step}_copy`] || []) fs.copyFileSync(from, to);
for (const [to, text] of b[`${step}_write`] || []) fs.writeFileSync(to, text);
// A child the step leaves running in its process group, which changes the tool later (a slow installer, say).
for (const [to, text, after] of b[`${step}_late_write`] || []) {
  spawn(process.execPath, ["-e", `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(to)}, ${JSON.stringify(text)}), ${after * 1000})`],
        { stdio: "ignore" }).unref();
}
if (b[`${step}_sleep`]) sleep(b[`${step}_sleep`]);
if (b[`${step}_probes`]) { // the host gets busy while this step runs
  behavior.probes = { ...(behavior.probes || {}), ...b[`${step}_probes`] };
  fs.writeFileSync(path.join(dir, "behavior.json"), JSON.stringify(behavior));
}
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

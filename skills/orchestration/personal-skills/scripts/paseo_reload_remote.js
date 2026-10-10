// Reload this host's Paseo daemon for the provider sync: the one its paseo_home names, or the default home's.
// Shipped by paseo_providers.py through fleet.run_node, whose prelude has already set that daemon target. The
// payload is empty.
const { spawnSync } = require("child_process");
// Test-only hook: LOADOUT_TEST_PASEO is a JSON [interpreter, fake script] run in place of paseo, as argv without a
// shell. It is never set outside tests.
const testPaseo = process.env.LOADOUT_TEST_PASEO;
const options = { encoding: "utf8", timeout: 85000 };
// Windows ships the CLI as an npm .cmd shim, which only runs through a shell; the command is a constant.
const done = testPaseo ? spawnSync(JSON.parse(testPaseo)[0], [JSON.parse(testPaseo)[1], "reload"], options)
  : process.platform === "win32" ? spawnSync("paseo reload", { ...options, shell: true })
  : spawnSync("paseo", ["reload"], options);
const error = done.status === 0 ? null : String(done.stderr || "").trim() || String(done.stdout || "").trim()
  || String(done.error || "exit " + done.status);
process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify({ error }) + " @@END\n");

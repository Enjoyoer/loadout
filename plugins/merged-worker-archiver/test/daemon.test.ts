import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { it } from "node:test";
import { resolveDaemonTarget } from "../server/daemon.ts";
const url = (env: NodeJS.ProcessEnv) => resolveDaemonTarget(env).url;
it("fails closed for an explicit non-default home and invalid metadata or host", async () => {
  const root = path.resolve("node_modules/.cache"); await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "daemon-test-"));
  try {
    const env = { PASEO_HOME: home };
    assert.throws(() => url(env), /Refusing default-daemon fallback/);
    for (const value of ["invalid JSON", '{"listen":null}', '{"listen":"unix:/socket"}']) {
      await writeFile(path.join(home, "paseo.pid"), value);
      assert.throws(() => url(env), /Refusing default-daemon fallback/);
    }
    await writeFile(path.join(home, "paseo.pid"), '{"listen":"127.0.0.1:7788"}');
    assert.equal(url(env), "ws://127.0.0.1:7788/ws");
    assert.equal(url({ ...env, PASEO_HOST: "127.0.0.1:7789" }), "ws://127.0.0.1:7789/ws");
    assert.throws(() => url({ ...env, PASEO_HOST: "unsupported" }), /Invalid PASEO_HOST/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("permits legacy fallback only for unset or explicit default home", async () => {
  const root = path.resolve("node_modules/.cache"); await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "default-home-test-"));
  try {
    const script = `import { resolveDaemonTarget } from ${JSON.stringify(new URL("../server/daemon.ts", import.meta.url).href)};
      import { homedir } from "node:os";
      import path from "node:path";
      console.log(JSON.stringify([resolveDaemonTarget({}), resolveDaemonTarget({ PASEO_HOME: path.join(homedir(), ".paseo") })]));`;
    const targets = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home }, encoding: "utf8" }));
    for (const target of targets) assert.equal(typeof target === "string" ? target : target.url, "ws://127.0.0.1:6767/ws");
  } finally { await rm(home, { recursive: true, force: true }); }
});

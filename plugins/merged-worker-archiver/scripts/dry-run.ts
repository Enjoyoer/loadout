import { readFile } from "node:fs/promises";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { ConfigSchema, defaultConfig, type ArchiverConfig } from "../server/config.ts";
import { openDaemonClient, resolveDaemonTarget } from "../server/daemon.ts";
import { createCommonDirResolver, nodeFileSystem, runCommand } from "../server/io.ts";
import { Sweeper, type ArchiverApi } from "../server/sweeper.ts";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function readConfig(path: string | null, graceOverride: number | null): Promise<ArchiverConfig> {
  let raw: Record<string, unknown> = {};
  if (path) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be an object");
    raw = parsed as Record<string, unknown>;
  }
  if (graceOverride !== null) raw.graceMinutes = graceOverride;
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new Error(`invalid config: ${result.error.message}`);
  return result.data;
}

function clientApi(client: PaseoClient): ArchiverApi {
  return client as unknown as ArchiverApi;
}

async function run(): Promise<void> {
  const host = argValue("--host");
  if (host) process.env.PASEO_HOST = host;
  const graceText = argValue("--grace");
  const grace = graceText === null ? null : Number(graceText);
  if (grace !== null && (!Number.isFinite(grace) || grace < 0)) throw new Error("--grace must be a non-negative number");
  const config = await readConfig(argValue("--config"), grace);
  const target = resolveDaemonTarget();
  const client = host ? await openDaemonClient() : await openDaemonClient();
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api: clientApi(client), release: async () => client.close() }),
    log: (line) => console.log(line),
    merge: { run: runCommand, fs: nodeFileSystem },
    fs: nodeFileSystem,
    now: () => Date.now(),
    resolveCommonDir: createCommonDirResolver(runCommand, () => config.commandTimeoutSeconds * 1000),
  });
  try {
    const result = await sweeper.sweep({ ...config, armed: false }, { trigger: "cli-dry-run", forceDryRun: true });
    if (result.error) {
      console.error(`dry-run failed: ${result.error}`);
      process.exitCode = 1;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

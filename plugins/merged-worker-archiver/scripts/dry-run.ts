import { readFile } from "node:fs/promises";
import { ConfigSchema, type ArchiverConfig } from "../server/config.ts";
import { openDaemonClient } from "../server/daemon.ts";
import { createCommonDirResolver, nodeFileSystem, runCommand } from "../server/io.ts";
import { NotifyStore, type NotifyStateStore } from "../server/notify-store.ts";
import { ReceiptReader } from "../server/receipts.ts";
import { Sweeper, type ArchiverApi } from "../server/sweeper.ts";

// Read-only preview of one full sweep. Nothing is archived, sent, or written: the sweep runs with
// forceDryRun, and the API and state store it gets refuse every write as a second guard.
//   npm run dry-run -- [--host <host:port>] [--config <values.json>] [--grace <minutes>] [--cleanup-only]

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

function readOnly(api: ArchiverApi): ArchiverApi {
  return {
    ...api,
    workspaces: { list: (options) => api.workspaces.list(options), archive: async () => { throw new Error("dry-run never archives"); } },
    sendAgentMessage: async () => { throw new Error("dry-run never sends"); },
  };
}

async function run(): Promise<void> {
  const host = argValue("--host");
  if (host) process.env.PASEO_HOST = host;
  const graceText = argValue("--grace");
  const grace = graceText === null ? null : Number(graceText);
  if (grace !== null && (!Number.isFinite(grace) || grace < 0)) throw new Error("--grace must be a non-negative number");
  const cleanupOnly = process.argv.includes("--cleanup-only");
  const config = await readConfig(argValue("--config"), grace);
  const connection = await openDaemonClient();
  const store = new NotifyStore();
  const notifyStore: NotifyStateStore = { read: () => store.read(), write: async () => { throw new Error("dry-run never writes state"); } };
  const sweeper = new Sweeper({
    acquireApi: async () => ({ api: readOnly(connection.api), release: async () => undefined }),
    log: (line) => {
      if (!cleanupOnly || line.includes('"cleanup":"') || line.includes("sweep-done") || line.includes("sweep-aborted") || line.includes("notify-state")) console.log(line);
    },
    merge: { run: runCommand, fs: nodeFileSystem },
    fs: nodeFileSystem,
    now: () => Date.now(),
    resolveCommonDir: createCommonDirResolver(runCommand, () => config.commandTimeoutSeconds * 1000),
    notifyStore,
    deliveries: new ReceiptReader(),
  });
  try {
    const result = await sweeper.sweep({ ...config, armed: false, armWorkspaceCleanup: false }, { trigger: "cli-dry-run", forceDryRun: true });
    if (result.error) {
      console.error(`dry-run failed: ${result.error}`);
      process.exitCode = 1;
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import { readFile } from "node:fs/promises";
import { readConfig } from "../server/config.ts";
import { OrphanProjectSweeper } from "../server/sweeper.ts";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function run(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run dry-run -- [--host <host:port>] [--config <values.json>]");
    console.log("Preview one local daemon sweep. Always dry-run, even when config has armed=true.");
    return;
  }
  const host = argValue("--host");
  if (host) process.env.PASEO_HOST = host;
  const configPath = argValue("--config");
  const values: unknown = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
  const log = (line: string) => console.log(line);
  const config = readConfig(values, log);
  const sweeper = new OrphanProjectSweeper({ log, error: (line) => console.error(line) }, {
    config: async () => config,
  });
  try {
    await sweeper.sweep({ forceDryRun: true, source: "cli-dry-run" });
  } finally {
    sweeper.stop();
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

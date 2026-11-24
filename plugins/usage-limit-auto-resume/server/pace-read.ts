// Host-local tri-state pace CLI for remote ULR callers over existing authenticated SSH.
// Bundled by `npm run build` to `dist/pace-read.mjs` (self-contained ESM with no runtime node_modules dependency)
// so it runs directly with absolute Node from an installed plugin layout under a bare environment. Validates this
// host's own ULR settings (auto-resume-config.json) with the exact full ConfigSchema, reuses QuotaReader.pace /
// paceOf, and prints exactly one strictly validated JSON line ({schemaVersion, state, reason, asOf}) to stdout. Never
// prints raw pq, account labels, quota/reset data, or error details.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type Config } from "./config.ts";
import { formatRemotePace, QuotaReader, repeatsKey, type RemotePacePayload } from "./quota.ts";
import { paseoHome } from "./vendor/daemon-target.ts";

export function settingsPath(home = paseoHome()): string {
  return path.join(home, "plugin-settings", "usage-limit-auto-resume", `${SETTINGS_ID}.json`);
}

type ParsedLocalPaceConfig = { ok: true; config: Config } | { ok: false };

function parseLocalPaceConfig(text: string): ParsedLocalPaceConfig {
  const invalid: ParsedLocalPaceConfig = { ok: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || repeatsKey(text)) return invalid;
  const file = raw as Record<string, unknown>;
  if (file.version !== SETTINGS_VERSION) return invalid;
  if (!file.values || typeof file.values !== "object" || Array.isArray(file.values)) return invalid;
  const parsed = ConfigSchema.safeParse(file.values);
  if (!parsed.success) return invalid;
  // A host-local pace producer never chains to another remote host.
  if (parsed.data.paceRemoteHost !== null || parsed.data.paceRemoteCommand !== null) return invalid;
  return { ok: true, config: parsed.data };
}

/**
 * Computes this host's tri-state pace verdict from its local ULR settings file and QuotaReader.pace.
 * Missing, unreadable, invalid, or remote-configured settings fail closed as undecided.
 */
export async function readLocalHostPace(options: {
  home?: string;
  quota?: QuotaReader;
  clock?: () => number;
} = {}): Promise<RemotePacePayload> {
  const clock = options.clock ?? (() => Date.now());
  const quota = options.quota ?? new QuotaReader(undefined, clock);
  const fail = (reason: string) => formatRemotePace({ state: "undecided", reason }, clock());
  let text: string;
  try {
    text = await readFile(settingsPath(options.home), "utf8");
  } catch {
    return fail("config-invalid");
  }
  const parsed = parseLocalPaceConfig(text);
  if (!parsed.ok) return fail("config-invalid");
  const { config } = parsed;
  if (!config.quotaAware) return fail("quotaAware-off");
  const pace = await quota.pace(config.pacePoolAccounts, { ttlMs: 0, timeoutMs: config.pqTimeoutSeconds * 1000 });
  return formatRemotePace(pace, clock());
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

async function main(): Promise<void> {
  const payload = process.argv.length > 2
    ? formatRemotePace({ state: "undecided", reason: "config-invalid" })
    : await readLocalHostPace().catch(() => formatRemotePace({ state: "undecided", reason: "pq-unavailable" }));
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (isDirectEntry()) {
  void main();
}

// Host-local tri-state pace CLI for remote ULR callers over existing authenticated SSH.
// Zero external npm dependencies so it runs directly with absolute Node from an installed or staged plugin layout
// under a bare environment. Reuses this host's own ULR host settings (auto-resume-config.json) and QuotaReader.pace /
// paceOf, and prints exactly one strictly validated JSON line ({schemaVersion, state, reason, asOf}) to stdout. Never
// prints raw pq, account labels, quota/reset data, or error details.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatRemotePace, QuotaReader, repeatsKey, type RemotePacePayload } from "./quota.ts";
import { paseoHome } from "./vendor/daemon-target.ts";

const SETTINGS_ID = "auto-resume-config";
const SETTINGS_VERSION = 2;

// Kept in lockstep with ConfigSchema.shape in config.ts (verified in test/model.test.ts) without importing zod.
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "armed",
  "transientBackoffSeconds",
  "baseDelaySeconds",
  "maxDelaySeconds",
  "pollIntervalSeconds",
  "resetBufferSeconds",
  "verificationTimeoutSeconds",
  "excludedProviders",
  "quotaAware",
  "quotaResetBufferSeconds",
  "quotaCacheSeconds",
  "pqTimeoutSeconds",
  "excludedLabels",
  "pmFallback",
  "pmFallbackModel",
  "pmFallbackThinking",
  "pmFallbackServiceTier",
  "pmFallbackFirst",
  "pmFallbackEnroll",
  "pmFallbackCancel",
  "paceFallback",
  "paceFallbackModel",
  "paceFallbackThinking",
  "paceFallbackServiceTier",
  "pacePoolAccounts",
  "paceFallbackExcludedProjects",
  "paceFallbackExcludedAgents",
  "paceRemoteHost",
  "paceRemoteCommand",
  "paceRemoteTimeoutSeconds",
  "paceRemoteMaxAgeSeconds",
]);

export function settingsPath(home = paseoHome()): string {
  return path.join(home, "plugin-settings", "usage-limit-auto-resume", `${SETTINGS_ID}.json`);
}

type LocalPaceConfig = { quotaAware: boolean; pacePoolAccounts: string[]; pqTimeoutSeconds: number };
type ParsedLocalPaceConfig = { ok: true; config: LocalPaceConfig } | { ok: false };

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
  const values = file.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return invalid;
  const v = values as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) return invalid;
  }
  const quotaAware = v.quotaAware === undefined ? true : v.quotaAware;
  if (typeof quotaAware !== "boolean") return invalid;
  // A host-local pace producer never chains to another remote host.
  if (v.paceRemoteHost !== undefined && v.paceRemoteHost !== null) return invalid;
  if (v.paceRemoteCommand !== undefined && v.paceRemoteCommand !== null) return invalid;
  const pqTimeoutSeconds = v.pqTimeoutSeconds === undefined ? 5 : v.pqTimeoutSeconds;
  if (typeof pqTimeoutSeconds !== "number" || !Number.isSafeInteger(pqTimeoutSeconds) || pqTimeoutSeconds < 1 || pqTimeoutSeconds > 15) return invalid;
  const accountsRaw = v.pacePoolAccounts === undefined ? [] : v.pacePoolAccounts;
  if (!Array.isArray(accountsRaw) || accountsRaw.length > 50 || !accountsRaw.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) return invalid;
  return { ok: true, config: { quotaAware, pacePoolAccounts: accountsRaw, pqTimeoutSeconds } };
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

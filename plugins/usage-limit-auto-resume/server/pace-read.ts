// Host-local tri-state pace CLI for remote ULR callers over existing authenticated SSH.
// Bundled by `npm run build` to `dist/pace-read.mjs` (self-contained ESM with no runtime node_modules dependency)
// so it runs directly with absolute Node from an installed plugin layout under a bare environment. Requires one
// explicit absolute path to the host's auto-resume-config.json as argv[2] (never derives a daemon home), validates
// owner/regular-file/symlink/size safety and the exact full ConfigSchema, reuses QuotaReader.pace / paceOf, and prints
// exactly one strictly validated JSON line ({schemaVersion, state, reason, asOf}) to stdout. Never prints file
// contents, raw pq, account labels, quota/reset data, or error details.
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, SETTINGS_ID, SETTINGS_VERSION, type Config } from "./config.ts";
import { formatRemotePace, QuotaReader, repeatsKey, type RemotePacePayload } from "./quota.ts";

const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 4096;
const SETTINGS_FILENAME = `${SETTINGS_ID}.json`;

type SafeSettingsRead = { ok: true; text: string } | { ok: false };

async function readSafeSettingsFile(filePath: string): Promise<SafeSettingsRead> {
  const invalid: SafeSettingsRead = { ok: false };
  if (!filePath || filePath.length > MAX_PATH_CHARS || /[\0\r\n]/.test(filePath) || !path.isAbsolute(filePath)) {
    return invalid;
  }
  if (path.basename(filePath) !== SETTINGS_FILENAME) return invalid;
  const parentDir = path.dirname(filePath);
  try {
    const [dirStat, fileStat] = await Promise.all([lstat(parentDir), lstat(filePath)]);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return invalid;
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return invalid;
    if (fileStat.size <= 0 || fileStat.size > MAX_SETTINGS_BYTES) return invalid;
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      if (dirStat.uid !== uid || (dirStat.mode & 0o022) !== 0) return invalid;
      if (fileStat.uid !== uid || (fileStat.mode & 0o022) !== 0) return invalid;
    }
    const [realDir, realFile] = await Promise.all([realpath(parentDir), realpath(filePath)]);
    if (realFile !== path.join(realDir, SETTINGS_FILENAME)) return invalid;
    const raw = await readFile(realFile);
    if (raw.byteLength <= 0 || raw.byteLength > MAX_SETTINGS_BYTES) return invalid;
    const afterStat = await lstat(filePath);
    if (!afterStat.isFile() || afterStat.isSymbolicLink() || afterStat.ino !== fileStat.ino || afterStat.dev !== fileStat.dev) {
      return invalid;
    }
    return { ok: true, text: raw.toString("utf8") };
  } catch {
    return invalid;
  }
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
 * Computes this host's tri-state pace verdict from an explicit absolute ULR settings file and QuotaReader.pace.
 * Missing, unsafe, unreadable, invalid, or remote-configured settings fail closed as undecided.
 */
export async function readLocalHostPace(options: {
  settingsFile?: string;
  quota?: QuotaReader;
  clock?: () => number;
} = {}): Promise<RemotePacePayload> {
  const clock = options.clock ?? (() => Date.now());
  const quota = options.quota ?? new QuotaReader(undefined, clock);
  const fail = (reason: string) => formatRemotePace({ state: "undecided", reason }, clock());
  if (!options.settingsFile) return fail("config-invalid");
  const read = await readSafeSettingsFile(options.settingsFile);
  if (!read.ok) return fail("config-invalid");
  const parsed = parseLocalPaceConfig(read.text);
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
  const payload = process.argv.length !== 3
    ? formatRemotePace({ state: "undecided", reason: "config-invalid" })
    : await readLocalHostPace({ settingsFile: process.argv[2] }).catch(() => formatRemotePace({ state: "undecided", reason: "pq-unavailable" }));
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (isDirectEntry()) {
  void main();
}

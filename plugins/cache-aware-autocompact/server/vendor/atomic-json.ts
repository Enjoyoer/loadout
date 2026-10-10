// Canonical atomic JSON state writer for the Loadout plugins.
//
// Every plugin is staged and installed on its own, so none can import this file at
// runtime. Each one carries a byte-identical copy in server/vendor/atomic-json.ts.
// Edit plugins/_shared/atomic-json.ts only, copy it over every vendored copy, and
// run python3 scripts/check_vendored.py, which CI also runs.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface WriteJsonOptions {
  /** Permission bits for the new file, such as 0o600; Windows honors only the read-only bit. */
  mode?: number;
}

/** A failed write whose temp file could not be removed either; the message names the temp file. */
export interface LeftTempError extends Error {
  tempFile: string;
  tempCleanupError: unknown;
}

// Windows refuses to replace or remove a file that another process, often a virus scanner
// or an indexer, briefly holds open, and reports EPERM or EBUSY. Node does not retry, so this does.
const BUSY_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];

async function retryWhileBusy(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const wait = BUSY_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || wait === undefined) throw error;
      await delay(wait);
    }
  }
}

async function syncDirectory(directory: string): Promise<string> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
    const { dev, ino } = await handle.stat();
    return `${dev}:${ino}`;
  } finally {
    await handle.close();
  }
}

// Each directory this process has flushed up the tree, by path, with the identity it had then.
const flushedTrees = new Map<string, string>();

/**
 * Make a rename into filePath's directory survive a host crash on POSIX: flush that
 * directory. The first time this process writes there, or after the directory was
 * replaced, the directory itself may be new (callers create it just before writing), so
 * also flush each parent up to the first one this process cannot write to, which holds no
 * entry it could have created. Windows has no directory flush in Node; nothing is done.
 */
async function flushDirectory(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = path.dirname(path.resolve(filePath));
  const identity = await syncDirectory(directory);
  if (flushedTrees.get(directory) === identity) return;
  let current = directory;
  while (path.dirname(current) !== current) {
    current = path.dirname(current);
    try {
      await access(current, constants.W_OK);
    } catch {
      break;
    }
    await syncDirectory(current);
  }
  flushedTrees.set(directory, identity);
}

function withLeftTemp(error: unknown, tempFile: string, tempCleanupError: unknown): LeftTempError {
  const failure = (error instanceof Error ? error : new Error(String(error))) as LeftTempError;
  const reason = tempCleanupError instanceof Error ? tempCleanupError.message : String(tempCleanupError);
  failure.message += `; temp file ${tempFile} was left behind: ${reason}`;
  failure.tempFile = tempFile;
  failure.tempCleanupError = tempCleanupError;
  return failure;
}

/**
 * Replace filePath with value as two-space indented JSON and a trailing newline. A reader
 * sees the old file or the new one, never a partial write. The text goes to a uniquely
 * named temp file in the same directory, created exclusively so an existing file or link
 * at that name is never followed, then flushed to disk and renamed over filePath. The
 * temp file is removed on any failure; if that fails too, the write's error is thrown as
 * a LeftTempError. The directory must already exist.
 *
 * On POSIX the promise resolves only once the rename is flushed too (see flushDirectory),
 * so the new file survives a host crash or power loss; if that flush fails it rejects,
 * although readers may already see the new file. On Windows the replacement is atomic and
 * the contents are flushed, but the rename is not: a host crash soon after the promise
 * resolves can bring back the previous file.
 */
export async function writeJsonAtomically(filePath: string, value: unknown, options: WriteJsonOptions = {}): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError(`cannot write ${typeof value} as JSON to ${filePath}`);
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let created = false;
  try {
    const handle = await open(temp, "wx", options.mode ?? 0o666);
    created = true;
    try {
      await handle.writeFile(`${text}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await retryWhileBusy(() => rename(temp, filePath));
    await flushDirectory(filePath);
  } catch (error) {
    if (created) {
      try {
        await retryWhileBusy(() => rm(temp, { force: true }));
      } catch (cleanupError) {
        throw withLeftTemp(error, temp, cleanupError);
      }
    }
    throw error;
  }
}

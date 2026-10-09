// Canonical atomic JSON state writer for the Loadout plugins.
//
// Every plugin is staged and installed on its own, so none can import this file at
// runtime. Each one carries a byte-identical copy in server/vendor/atomic-json.ts.
// Edit plugins/_shared/atomic-json.ts only, copy it over every vendored copy, and
// run python3 scripts/check_vendored.py, which CI also runs.

import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export interface WriteJsonOptions {
  /** Permission bits for the new file, such as 0o600; Windows honors only the read-only bit. */
  mode?: number;
}

// Windows refuses to replace a file that another process, often a virus scanner or an
// indexer, briefly holds open, and reports EPERM or EBUSY. Node does not retry, so this does.
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const wait = RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || wait === undefined) throw error;
      await delay(wait);
    }
  }
}

/**
 * Replace filePath with value as two-space indented JSON and a trailing newline. A reader
 * sees the old file or the new one, never a partial write. The text goes to a uniquely
 * named temp file in the same directory, created exclusively so an existing file or link
 * at that name is never followed, then flushed to disk and renamed over filePath. The
 * temp file is removed on any failure. The directory must already exist.
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
    await renameOver(temp, filePath);
  } catch (error) {
    if (created) await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

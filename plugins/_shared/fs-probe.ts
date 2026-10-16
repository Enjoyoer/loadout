// Absence is only ENOENT or ENOTDIR. Any other error (EACCES, EPERM, EIO, ELOOP, ...) leaves the state unknown,
// so it is thrown: a caller never reads it as absent, empty, or a default. existsSync, and a catch that only
// returns false, read every error as absence.
import type { Stats } from "node:fs";
import { lstat, stat } from "node:fs/promises";

/** Whether an fs error means nothing is at the path: ENOENT or ENOTDIR, and nothing else. */
export function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** What is at path: its lstat (its stat with follow), or null when it is absent. Any other error is thrown. */
export async function probe(path: string, options: { follow?: boolean } = {}): Promise<Stats | null> {
  try {
    return options.follow ? await stat(path) : await lstat(path);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

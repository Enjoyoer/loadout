import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import type { CommandResult, CommandRunner, CommonDirResolver, FileSystem } from "./types.ts";

const MAX_BUFFER = 4 * 1024 * 1024;

// Read-only environment for every git/gh call: no optional index lock/refresh writes,
// no credential or editor prompts, no pager.
const COMMAND_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};

export const runCommand: CommandRunner = (command, args, cwd, timeoutMs) =>
  new Promise<CommandResult>((resolve) => {
    execFile(
      command,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: COMMAND_ENV, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false, notFound: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        const notFound = failure.code === "ENOENT";
        const timedOut = Boolean(failure.killed) && !notFound;
        const code = typeof failure.code === "number" ? failure.code : null;
        resolve({ code, stdout: out, stderr: err, timedOut, notFound });
      },
    );
  });

// Paths whose unexpected access() error was already logged, so a persistent one logs once.
const loggedExistsErrors = new Set<string>();

export const nodeFileSystem: FileSystem = {
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? false : null;
    }
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      // Fail closed: a path we cannot check (EACCES, EPERM, ...) counts as present, never as gone.
      if (!loggedExistsErrors.has(path)) {
        loggedExistsErrors.add(path);
        console.log(`[merged-worker-archiver] exists-error treated-as-present ${JSON.stringify({ path, code: code ?? String(error) })}`);
      }
      return true;
    }
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
};

/**
 * Cached `git rev-parse --path-format=absolute --git-common-dir`, realpath-normalized so
 * /tmp and /private/tmp spellings match. Every worktree of one repository shares it.
 * Failures (not a git directory, timeout) are not cached.
 */
export function createCommonDirResolver(run: CommandRunner, timeoutMs: () => number, maxEntries = 512): CommonDirResolver {
  const cache = new Map<string, string>();
  return async (directory) => {
    const cached = cache.get(directory);
    if (cached) return cached;
    const result = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], directory, timeoutMs());
    const raw = result.code === 0 ? result.stdout.trim() : "";
    if (!raw) return null;
    let resolved = raw;
    try {
      resolved = await realpath(raw);
    } catch {
      return null;
    }
    if (cache.size >= maxEntries) cache.clear();
    cache.set(directory, resolved);
    return resolved;
  };
}

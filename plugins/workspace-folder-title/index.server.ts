import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const execFileAsync = promisify(execFile);
const BRANCH_NAMES = new Set(["main", "master", "trunk", "develop"]);

function basenamePortable(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.includes("\\") ? path.win32.basename(normalized) : path.posix.basename(normalized);
}

function sourceDirectory(source: { kind: string; path?: string }): string | null {
  return source.kind === "directory" ? source.path ?? null : null;
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const branch = result.stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

function shouldReplace(name: string | null, branch: string | null): boolean {
  if (!name?.trim()) return true;
  return name === branch || BRANCH_NAMES.has(name);
}

export default function contribute(server: PluginServerContext) {
  const removeBefore = server.before("workspace.create", ({ request }) => {
    if (request.title !== undefined && request.title !== null && request.title !== "") return;
    const directory = sourceDirectory(request.source);
    const title = directory ? basenamePortable(directory) : null;
    return title ? { ...request, title } : undefined;
  });

  const removeCreated = server.on("workspace.created", async (event, context) => {
    const workspace = event.workspace;
    if (!shouldReplace(workspace.name, await currentBranch(workspace.cwd))) return;
    const title = basenamePortable(workspace.cwd);
    if (!title) return;
    await context.paseo.workspaces.ref(workspace.id).setTitle(title);
    console.log(`[workspace-folder-title] renamed workspace=${workspace.id} title=${JSON.stringify(title)}`);
  });

  return () => {
    removeBefore();
    removeCreated();
  };
}

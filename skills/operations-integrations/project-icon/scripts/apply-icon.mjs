#!/usr/bin/env node
// Use the installed Paseo CLI client and its transport/auth, not a second API stack.
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: "boolean" }, force: { type: "boolean" },
    "allow-scratch": { type: "boolean" },
    host: { type: "string" }, "scratch-root": { type: "string" },
  },
});
const [cliDist, projectId, file] = positionals;
if (!cliDist || !projectId || positionals.length > 3 || (!values.check && !file)) {
  console.error("usage: node apply-icon.mjs <cli-dist> <project-id> [icon.png] [--check] [--force] [--allow-scratch] [--host endpoint --scratch-root daemon-path]");
  process.exit(2);
}
// Do not infer a remote daemon's home from this machine's home.
if (values.host && !values["scratch-root"]) throw new Error("--host requires --scratch-root on the daemon");
const load = (rel) => import(pathToFileURL(path.resolve(cliDist, rel)).href);
const { connectToDaemon } = await load("utils/client.js");
const { selectDaemonTarget } = await load("utils/daemon-target.js");
const target = selectDaemonTarget(values.host ? { host: values.host } : { home: process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo") });
const client = await connectToDaemon({ target });
try {
  const inspect = async () => {
    const { projects } = await client.listProjects();
    const project = projects.find((p) => p.projectId === projectId);
    if (!project) throw new Error("Project not found");
    // The CLI's formatted project ls output omits this daemon record field.
    const revision = project.projectCustomIconRevision;
    if (revision !== null && (typeof revision !== "string" || !revision.trim())) throw new Error("Unknown custom icon state; refusing to write");
    if (typeof project.projectRootPath !== "string") throw new Error("Missing project root");
    const remote = Boolean(values.host);
    const paths = remote ? (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(project.projectRootPath) ? path.win32 : path.posix) : path;
    const scratchRoot = values["scratch-root"] ?? path.join(os.homedir(), ".cache", "fleet-scratch");
    if (!paths.isAbsolute(scratchRoot) || !paths.isAbsolute(project.projectRootPath)) throw new Error("Roots must be absolute daemon paths");
    const canonical = async (p) => {
      if (remote) return paths.resolve(p); // Remote paths must already be canonical.
      try { return await realpath(p); } catch (e) {
        if (e.code === "ENOENT" && p === scratchRoot) return paths.resolve(p);
        throw e;
      }
    };
    const relative = paths.relative(await canonical(scratchRoot), await canonical(project.projectRootPath));
    const scratch = relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
    return { projectId, hasCustomIcon: Boolean(revision), scratch, status: revision ? "custom icon" : "no icon" };
  };
  const state = await inspect();
  if (values.check) {
    console.log(JSON.stringify(state));
  } else {
    const bytes = await readFile(file);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.length < 24 || bytes.readUInt32BE(16) !== 512 || bytes.readUInt32BE(20) !== 512) {
      throw new Error("Expected a 512x512 PNG");
    }
    // Re-read immediately before writing. Paseo has no conditional icon-set RPC;
    // serialize icon writers for this project to avoid a concurrent overwrite.
    const current = await inspect();
    if (current.scratch && !values["allow-scratch"]) throw new Error("Skipped scratch project; use --allow-scratch only for an explicit check");
    if (current.hasCustomIcon && !values.force) throw new Error("Refusing to overwrite custom icon without --force");
    const data = bytes.toString("base64");
    await client.setProjectIcon(projectId, { type: "upload", data });
    const got = await client.getProjectIcon(projectId);
    if (got?.icon?.data !== data) throw new Error("Icon read-back differs from upload");
    const after = await inspect();
    if (!after.hasCustomIcon) throw new Error("Custom icon revision missing after upload");
    console.log(JSON.stringify({ ...after, bytes: bytes.length, verified: true }));
  }
} finally {
  await client.close().catch(() => undefined);
}

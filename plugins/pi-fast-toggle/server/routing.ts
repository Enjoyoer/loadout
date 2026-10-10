import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestedState, tierCapable, LABEL } from "../shared/model";
import { resolveDaemonTarget } from "./vendor/daemon-target";
const exec = promisify(execFile);
export async function runtime(root: string, selection: string) {
  if (!root) throw Error("Configure the Pi runtime root first");
  const spec = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
  const models = JSON.parse(await readFile(join(root, "agent/models.json"), "utf8"));
  const slash = selection.indexOf("/");
  const provider = models.providers?.[selection.slice(0, slash)];
  const model = provider?.models?.find((row: { id: string }) => row.id === selection.slice(slash + 1));
  if (!model) throw Error("Selected Pi model is absent from the runtime catalog");
  return { spec, model: { ...model, api: model.api ?? provider.api }, baseUrl: model.baseUrl ?? provider.baseUrl };
}
const catalogs = new Map<string, { at: number; rows: Promise<Array<{ id?: string; slug?: string; service_tiers?: Array<{ id: string }> }>> }>();
export async function catalog(root: string, route: Awaited<ReturnType<typeof runtime>>, fresh = false) {
  if (route.model.api !== "openai-responses" || route.model.id.startsWith("chatgpt-web/")) return [];
  const key = root + ":" + route.baseUrl;
  const cached = catalogs.get(key);
  if (!fresh && cached && Date.now() - cached.at < 10 * 60_000) return cached.rows;
  const rows = fetchCatalog(root, route);
  catalogs.set(key, { at: Date.now(), rows });
  try { return await rows; } catch (error) {
    if (catalogs.get(key)?.rows === rows) catalogs.delete(key);
    throw error;
  }
}
async function fetchCatalog(root: string, route: Awaited<ReturnType<typeof runtime>>) {
  // Same credential helper and router endpoint used by fleet-routing.mjs. Never log either.
  const { stdout } = await exec(route.spec.python ?? (process.platform === "win32" ? "python" : "python3"), [join(root, "credential.py"), join(root, "runtime.json")], { timeout: 10000, maxBuffer: 65536 });
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${stdout.trim()}` };
  for (const name of route.spec.credentialHeaders ?? []) headers[name] = stdout.trim();
  const response = await fetch(`${route.baseUrl.replace(/\/$/, "")}/models?client_version=0.160.0`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error("Router catalog unavailable");
  const value = await response.json() as { models?: unknown };
  if (!Array.isArray(value.models)) throw Error("Router catalog malformed");
  return value.models as Array<{ id?: string; slug?: string; service_tiers?: Array<{ id: string }> }>;
}
// The update goes only to the daemon this plugin runs in, the one the shared resolver finds
// (PASEO_HOST, then the daemon's paseo.pid), at the address it listens on. Anything else fails before any request.
function daemonMcpEndpoint(url: string, env: NodeJS.ProcessEnv): URL {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:") throw Error("Pi MCP must use http");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw Error("Pi MCP must use loopback");
  if (endpoint.hostname === "localhost") endpoint.hostname = "127.0.0.1";
  if (endpoint.host !== new URL(resolveDaemonTarget(env).url).host) throw Error("Pi MCP is not this plugin's daemon");
  return endpoint;
}
export async function writeTier(url: string, agentId: string, fast: boolean, env: NodeJS.ProcessEnv = process.env) {
  const endpoint = daemonMcpEndpoint(url, env);
  // A redirect could carry the update to another destination; refuse it.
  const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "fast-toggle", method: "tools/call", params: { name: "update_agent", arguments: { agentId, labels: { [LABEL]: fast ? "fast" : "standard" } } } }), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  const value = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").find(line => line.startsWith("data:"))!.slice(5)) : JSON.parse(text);
  if (!response.ok || value.error || value.result?.isError) throw Error("Agent tier update failed");
}
export { requestedState, tierCapable };

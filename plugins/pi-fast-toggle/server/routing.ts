import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestedState, tierCapable, LABEL } from "../shared/model";
import { withDaemon } from "./daemon";
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
  let url = new URL(`${route.baseUrl.replace(/\/$/, "")}/models?client_version=0.160.0`);
  const origin = url.origin;
  const signal = AbortSignal.timeout(10000);
  let response: Response;
  for (let redirects = 0; ; redirects++) {
    // Fetch only validated destinations so every credential header stays on this origin.
    response = await fetch(url, { headers, redirect: "manual", signal });
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || location === null) break;
    await response.body?.cancel();
    const next = new URL(location, url);
    if (next.origin !== origin) throw Error("Router catalog redirected to a different origin");
    if (redirects >= 20) throw Error("Router catalog redirect limit exceeded");
    url = next;
  }
  if (!response.ok) throw Error("Router catalog unavailable");
  const value = await response.json() as { models?: unknown };
  if (!Array.isArray(value.models)) throw Error("Router catalog malformed");
  return value.models as Array<{ id?: string; slug?: string; service_tiers?: Array<{ id: string }> }>;
}
export async function writeTier(agentId: string, fast: boolean) {
  try { await withDaemon(client => client.updateAgent(agentId, { labels: { [LABEL]: fast ? "fast" : "standard" } })); }
  catch { throw Error("Agent tier update failed"); }
}
export { requestedState, tierCapable };

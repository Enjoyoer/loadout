export const LABEL = "opc.service-tier";
const LEGACY = "opc.fast-requested";
// The tier the fleet routing serves on a route whose catalog lists priority, the only routes that show Fast:
// opc.service-tier wins, then the legacy opc.fast-requested label, and no choice (absent, empty or inherit) is the
// fleet default, Standard. An unsupported value is not Fast (the routing refuses that turn).
export function requestedState(labels: Record<string, string> = {}) {
  const raw = (labels[LABEL] ?? "").trim().toLowerCase();
  const tier = raw || (labels[LEGACY] === "true" ? "fast" : labels[LEGACY] === "false" ? "standard" : "inherit");
  return { fast: ["fast", "priority", "ultrafast"].includes(tier), tier };
}
// Luna runs Fast on every turn on a route that shows Fast (owner 2026-11-17), as fleet-routing.mjs sends it, so its
// pill is fixed on.
export function lunaModel(model: { id: string }) {
  return /(?:^|\/)gpt-[0-9.]+-luna$/i.test(model.id);
}
export function tierCapable(model: { id: string; api?: string }, rows: Array<{ id?: string; slug?: string; service_tiers?: Array<{ id: string }> }>) {
  return model.api === "openai-responses" && !model.id.startsWith("chatgpt-web/") &&
    !!rows.find(row => (row.slug ?? row.id) === model.id)?.service_tiers?.some(tier => tier.id === "priority");
}

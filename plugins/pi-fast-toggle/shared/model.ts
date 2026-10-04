export const LABEL = "opc.service-tier";
export function requestedState(labels: Record<string, string> = {}) {
  const tier = (labels[LABEL] ?? "standard").trim().toLowerCase() || "standard";
  return { fast: tier === "fast" || tier === "priority" || tier === "ultrafast", tier };
}
export function tierCapable(model: { id: string; api?: string }, rows: Array<{ id?: string; slug?: string; service_tiers?: Array<{ id: string }> }>) {
  return model.api === "openai-responses" && !model.id.startsWith("chatgpt-web/") &&
    !!rows.find(row => (row.slug ?? row.id) === model.id)?.service_tiers?.some(tier => tier.id === "priority");
}

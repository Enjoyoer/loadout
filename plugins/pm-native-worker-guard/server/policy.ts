import type { GuardConfig } from "./config.ts";

export const PLUGIN_ID = "pm-native-worker-guard";

/** Label Paseo 0.10.3 sets on MCP create_agent and agent-run children (PARENT_AGENT_ID_LABEL). */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** Snapshot statuses that mean the agent is mid-turn or about to be. */
const BUSY_STATUSES = new Set(["running", "initializing"]);

/** True for `codex`, `claude`, `codex/<model>`, `claude/<model>` (by default); Pi agents report `pi`. */
export function isNativeProvider(provider: string, nativeProviders: readonly string[]): boolean {
  const value = provider.trim().toLowerCase();
  if (!value) return false;
  return nativeProviders.some((id) => {
    const native = id.trim().toLowerCase();
    return native.length > 0 && (value === native || value.startsWith(`${native}/`));
  });
}

export function isPmAgent(labels: Readonly<Record<string, string>> | undefined, config: Pick<GuardConfig, "pmLabelKey" | "pmLabelValue">): boolean {
  const value = labels?.[config.pmLabelKey];
  return typeof value === "string" && value.trim().toLowerCase() === config.pmLabelValue.trim().toLowerCase();
}

export function isBusy(agent: { status: string; activeTurn?: unknown }): boolean {
  return BUSY_STATUSES.has(agent.status) || Boolean(agent.activeTurn);
}

/** Owner allowlist from the settings file. Labels set by the creating PM are never consulted. */
export function allowlistReason(childId: string, parentId: string, config: Pick<GuardConfig, "allowAgentIds" | "allowParentIds">): string | null {
  if (config.allowAgentIds.includes(childId)) return "allowlisted-agent";
  if (config.allowParentIds.includes(parentId)) return "allowlisted-parent";
  return null;
}

export function noticeText(childId: string, provider: string, notice: string): string {
  return `${PLUGIN_ID} archived ${childId} (${provider}): ${notice}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

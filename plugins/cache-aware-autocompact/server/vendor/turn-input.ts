// Canonical "what started a turn" helper for the Loadout plugins.
//
// Every plugin is staged and installed on its own, so none can import this file at
// runtime. Each one carries a byte-identical copy in server/vendor/turn-input.ts.
// Edit plugins/_shared/turn-input.ts only, copy it over every vendored copy, and
// run python3 scripts/check_vendored.py, which CI also runs.
//
// Paseo 0.11 records every prompt as a user_message row. Paseo 0.13 records a prompt from another agent (create_agent's
// initial prompt, send_agent_prompt) and an agent notification (a child that finished, errored, needs permission or
// closed) as a completed tool_call row named agent_message instead: the message's own ID is in its callId, its sender,
// event and text in agentMessage. Paseo 0.14 also projects scheduled system prompts as completed heartbeat tool rows,
// with a stable content hash in callId and the unwrapped body in detail.text. These rows are turn inputs too.

import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export type UserRow = Extract<AgentTimelineItem, { type: "user_message" }>;
/** Where a projected input row came from. A user row has none. */
export type InputSource = "agent-message" | "agent-notification" | "system-message";
/** A turn input, seen as a user row; projected rows have a stable ID and `source`. */
export type TurnInput = UserRow & { source?: InputSource };

const AGENT_MESSAGE_CALL = "paseo-agent-message:";

/**
 * The item as a turn input, or null. A user row is returned as it is. An agent-message row becomes a user row with the
 * message's text and its ID as both messageId and clientMessageId: after a daemon restart Paseo rebuilds a user row with
 * a new ID and no clientMessageId, but an agent-message row keeps its ID, so it is never taken for a rebuilt row. Only
 * Paseo's own row counts: named agent_message, completed, with the callId Paseo derives from the message ID and the
 * agentMessage text, or the completed heartbeat row with Paseo's system call ID and plain-text detail.
 */
export function turnInput(item: AgentTimelineItem): TurnInput | null {
  if (item.type === "user_message") return item;
  if (item.type !== "tool_call" || item.status !== "completed") return null;
  if (item.name === "heartbeat" && /^paseo-system:[a-f0-9]{64}$/.test(item.callId)) {
    const detail = item.detail;
    if (detail?.type !== "plain_text" || typeof detail.text !== "string") return null;
    return { type: "user_message", text: detail.text, messageId: item.callId, clientMessageId: item.callId, source: "system-message" };
  }
  if (item.name !== "agent_message" || !item.callId.startsWith(AGENT_MESSAGE_CALL)) return null;
  const id = item.callId.slice(AGENT_MESSAGE_CALL.length);
  const message = item.agentMessage as { event?: unknown; text?: unknown } | null | undefined;
  if (!id || typeof message !== "object" || message === null || typeof message.text !== "string") return null;
  return { type: "user_message", text: message.text, messageId: id, clientMessageId: id, source: message.event === "message" ? "agent-message" : "agent-notification" };
}

/** The newest turn input of a timeline, or null. */
export function lastInput(timeline: readonly AgentTimelineItem[]): TurnInput | null {
  for (let at = timeline.length - 1; at >= 0; at--) {
    const input = turnInput(timeline[at]!);
    if (input) return input;
  }
  return null;
}

/** The index of the newest timeline entry that is a turn input, or -1. */
export function lastInputIndex(entries: readonly { item: AgentTimelineItem }[]): number {
  return entries.findLastIndex((entry) => turnInput(entry.item) !== null);
}

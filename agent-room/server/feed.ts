import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

import type { FeedEvent, SeatRecord } from "../shared/room";

/**
 * Every signal and disposition the protocol defines, in the order the protocol
 * lists them. `labelFor` only recognises these; a message that opens with any
 * other word is labelled by direction instead.
 */
export const SIGNALS: readonly string[] = [
  "CANDIDATE",
  "REVIEW",
  "REOPEN_REQUEST",
  "DEPENDENCY_REQUEST",
  "BLOCKED",
  "QUESTION",
  "ACK",
  "ACCEPT",
  "REJECT",
  "REVISED BRIEF",
  "HOLD",
  "ANSWER",
  "DEFER",
  "DONE",
  "STATUS",
  "DECISION_NEEDED",
];

export type FeedDraft = Pick<FeedEvent, "kind" | "from" | "to" | "label" | "text">;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest first so `REVISED BRIEF` wins over any shorter prefix match. */
const SIGNAL_PATTERNS = [...SIGNALS]
  .sort((a, b) => b.length - a.length)
  .map((signal) => ({
    signal,
    pattern: new RegExp(
      `^${signal.split(/\s+/).map(escapeRegExp).join("\\s+")}(?![A-Za-z0-9_])`,
      "i",
    ),
  }));

/**
 * Label a message by the protocol signal on its first line. The signal must open
 * the line and stand alone, so `STATUSES are mixed` is not `STATUS`. Anything
 * else falls back to the caller's direction word (`instruction`, `brief`,
 * `task`, `reply`).
 */
export function labelFor(text: string, fallback: string): string {
  const firstLine = text.split("\n", 1)[0].trim();
  for (const { signal, pattern } of SIGNAL_PATTERNS) {
    if (pattern.test(firstLine)) return signal;
  }
  return fallback;
}

/** The child whose agent id appears in `text`, or `null` when none does. */
function childNamedIn(text: string, childIds: readonly string[]): string | null {
  for (const childId of childIds) {
    if (childId !== "" && text.includes(childId)) return childId;
  }
  return null;
}

/**
 * The Supervisor protocol mandates a 2-minute heartbeat named `supervisor: room`,
 * whose prompt opens with this tag. A long room writes hundreds of those prompt
 * turns, and each one is a `user_message` in the timeline: emitted as feed rows
 * they would evict the room's real history at the 500-row cap, so a heartbeat
 * wake is not a room turn and contributes no user row.
 */
const HEARTBEAT_TAG = "[supervisor-heartbeat]";

/** True for the synthetic user message a scheduled heartbeat delivers. */
function isHeartbeatWake(item: AgentTimelineItem): boolean {
  if (item.type !== "user_message") return false;
  return item.text.trimStart().startsWith(HEARTBEAT_TAG);
}

/**
 * Strip a 40-item tail down to the current turn. The last `user_message` marks
 * the turn's instruction, so anything up to and including the `assistant_message`
 * before it is history. With no user message the tail holds only the final
 * reply, and only the last `assistant_message` is news.
 *
 * The boundary is found in the *unfiltered* tail and the heartbeat wakes are
 * dropped only from the window that survives it. Filtering first would move the
 * boundary backwards: on a heartbeat turn the tail ends
 * `real task, reply, heartbeat, heartbeat reply`, so the last surviving user
 * message would be the previous turn's real task and the slice would re-emit it
 * on every heartbeat wake until it aged out of the tail.
 */
function currentTurn(timeline: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const isUser = (item: AgentTimelineItem): boolean => item.type === "user_message";
  const isAssistant = (item: AgentTimelineItem): boolean => item.type === "assistant_message";

  const lastUser = timeline.map(isUser).lastIndexOf(true);
  let window: readonly AgentTimelineItem[];
  if (lastUser === -1) {
    const lastAssistant = timeline.map(isAssistant).lastIndexOf(true);
    window = lastAssistant === -1 ? [] : timeline.slice(lastAssistant);
  } else {
    const assistantBeforeUser = timeline.slice(0, lastUser).map(isAssistant).lastIndexOf(true);
    window = timeline.slice(assistantBeforeUser + 1);
  }

  // A heartbeat wake is not a room turn, so it contributes no user row — but it
  // stays in the boundary scan above, where it is what marks the turn as current.
  return window.filter((item) => !isHeartbeatWake(item));
}

/**
 * Turn one agent turn into feed lines. Pure: the caller fetches the timeline and
 * passes the items, so this can be read (and tested) as a rule table.
 *
 * A user message is attributed to the child whose id it mentions, else to the
 * agent's parent (`null` is the user, so a Supervisor's task comes from them).
 * The turn's last assistant message is the agent's reply, addressed to its parent.
 */
export function feedFromTurn(input: {
  agent: SeatRecord;
  childIds: readonly string[];
  timeline: readonly AgentTimelineItem[];
}): FeedDraft[] {
  const { agent, childIds, timeline } = input;
  const items = currentTurn(timeline);

  const lastAssistant = items.map((item) => item.type === "assistant_message").lastIndexOf(true);
  const drafts: FeedDraft[] = [];

  items.forEach((item, index) => {
    if (item.type === "user_message") {
      const from = childNamedIn(item.text, childIds) ?? agent.parentId;
      const label =
        from === null && agent.marker.seat === "supervisor" ? "task" : "instruction";
      drafts.push({ kind: "message", from, to: agent.agentId, label: labelFor(item.text, label), text: item.text });
      return;
    }

    if (item.type === "assistant_message" && index === lastAssistant) {
      drafts.push({
        kind: "message",
        from: agent.agentId,
        to: agent.parentId,
        label: labelFor(item.text, "reply"),
        text: item.text,
      });
    }
  });

  return drafts;
}

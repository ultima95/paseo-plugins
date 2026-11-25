import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/** A conversation row: what was said, not the work the agent did to get there. */
export type TimelineRowKind = "user" | "assistant" | "error";

export interface TimelineRow {
  readonly key: string;
  readonly kind: TimelineRowKind;
  readonly text: string;
  /** The provider's id for a streaming message, so its chunks update one row. */
  readonly streamId?: string;
}

/** A page of timeline entries, as `timeline.refetch` returns them. */
export interface TimelineEntry {
  readonly item: AgentTimelineItem;
  readonly turnId?: string;
  readonly seqStart: number;
}

/** How many rows the preview keeps: enough to read a turn, bounded so a long session stays light. */
export const ROW_LIMIT = 300;

/**
 * The row an item contributes, or null for everything the preview leaves out: reasoning, tool
 * calls, todos, compaction, and notices. A preview reads the conversation, not the work behind it.
 */
function itemRow(item: AgentTimelineItem, key: string): TimelineRow | null {
  switch (item.type) {
    case "user_message":
      return { key, kind: "user", text: item.text };
    case "assistant_message":
      return { key, kind: "assistant", text: item.text, streamId: item.messageId };
    case "error":
      return { key, kind: "error", text: item.message };
    default:
      return null;
  }
}

/** Every conversation row from a fetched page, oldest first. */
export function rowsFromEntries(entries: readonly TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const [index, entry] of entries.entries()) {
    const row = itemRow(entry.item, `${entry.seqStart}:${index}`);
    if (row !== null) rows.push(row);
  }
  return rows.slice(-ROW_LIMIT);
}

/**
 * One assistant chunk joined with what the row already shows. Providers stream deltas, so a chunk
 * is usually only the new text; some resend the whole message so far, which is already contained.
 */
function mergeStreamText(shown: string, chunk: string): string {
  return chunk.startsWith(shown) ? chunk : shown + chunk;
}

/**
 * One live timeline item merged into the rows on screen. Only assistant text streams: providers
 * send chunks of the same message under a message id, so a chunk grows the row it belongs to.
 * User prompts and errors always append, and an item the preview leaves out changes nothing.
 */
export function appendLiveItem(
  rows: readonly TimelineRow[],
  item: AgentTimelineItem,
  key: string,
): readonly TimelineRow[] {
  const row = itemRow(item, key);
  if (row === null) return rows;
  if (row.kind !== "assistant") return [...rows, row].slice(-ROW_LIMIT);

  const at =
    row.streamId === undefined
      ? rows.length - 1
      : rows.findIndex((existing) => existing.streamId === row.streamId);
  const target = at === -1 ? undefined : rows[at];
  if (at === -1 || target === undefined || target.kind !== "assistant") {
    return [...rows, row].slice(-ROW_LIMIT);
  }
  const next = [...rows];
  next[at] = { ...row, key: target.key, text: mergeStreamText(target.text, row.text) };
  return next;
}

/** The state a provider reports for a subagent session it runs on the agent's behalf. */
export type SubagentState = "running" | "completed" | "failed" | "canceled";

/** One subagent the previewed agent delegated work to. */
export interface SubagentRow {
  readonly id: string;
  readonly label: string;
  readonly state: SubagentState;
}

/** The subagent a timeline item is about, or null for everything else the agent did itself. */
export function subagentFromItem(item: AgentTimelineItem): SubagentRow | null {
  if (item.type !== "tool_call" || item.detail.type !== "sub_agent") return null;
  const detail = item.detail;
  return {
    id: item.callId,
    label: detail.subAgentType ?? detail.description ?? item.name,
    state: item.status,
  };
}

/** A chat bubble's text, trimmed of the blank lines providers pad their output with. */
export function displayText(row: TimelineRow): string {
  return row.kind === "error" ? row.text : row.text.trim();
}

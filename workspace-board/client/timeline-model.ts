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
 * One live timeline item merged into the rows on screen. Only assistant text streams: providers
 * send its full accumulated text on each update, under a message id when they have one, so a
 * chunk grows the row it belongs to. User prompts and errors always append, and an item the
 * preview leaves out changes nothing.
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
  next[at] = { ...row, key: target.key };
  return next;
}

/** A chat bubble's text, trimmed of the blank lines providers pad their output with. */
export function displayText(row: TimelineRow): string {
  return row.kind === "error" ? row.text : row.text.trim();
}

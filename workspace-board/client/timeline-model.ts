import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/** A preview row: something said, or a one-line tally of the work behind the conversation. */
export type TimelineRowKind = "user" | "assistant" | "error" | "activity";

/** What one activity line has counted so far, so a live tool call can grow the same line. */
export interface ActivityCount {
  readonly commands: number;
  readonly tools: number;
}

export interface TimelineRow {
  readonly key: string;
  readonly kind: TimelineRowKind;
  readonly text: string;
  /** The provider's id for a streaming message, so its chunks update one row. */
  readonly streamId?: string;
  /** On an activity row, its tally; other rows leave it out. */
  readonly activity?: ActivityCount;
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

/**
 * What one item adds to an activity line. Shell calls read as commands and every other tool call
 * as a tool, so a burst of work between two messages folds into one line like
 * "Ran 6 commands and used 2 other tools". Reasoning, todos, and notices add nothing.
 */
function activityCount(item: AgentTimelineItem): ActivityCount | null {
  if (item.type !== "tool_call") return null;
  return item.detail.type === "shell"
    ? { commands: 1, tools: 0 }
    : { commands: 0, tools: 1 };
}

function addActivity(left: ActivityCount, right: ActivityCount): ActivityCount {
  return { commands: left.commands + right.commands, tools: left.tools + right.tools };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The one line that stands in for a run of tool calls, counting each kind only when it has one. */
export function activityText(count: ActivityCount): string {
  const commands =
    count.commands === 0
      ? null
      : `Ran ${count.commands} ${plural(count.commands, "command", "commands")}`;
  const tools =
    count.tools === 0
      ? null
      : `${count.commands === 0 ? "Used" : "used"} ${count.tools} ${plural(
          count.tools,
          count.commands === 0 ? "tool" : "other tool",
          count.commands === 0 ? "tools" : "other tools",
        )}`;
  return [commands, tools].filter((part) => part !== null).join(" and ");
}

/** An activity row grown by one more call; its key stays so the line does not flicker. */
function grownActivity(row: TimelineRow, count: ActivityCount): TimelineRow {
  const activity = addActivity(row.activity ?? { commands: 0, tools: 0 }, count);
  return { ...row, text: activityText(activity), activity };
}

function newActivity(key: string, count: ActivityCount): TimelineRow {
  return { key, kind: "activity", text: activityText(count), activity: count };
}

/** Every conversation row from a fetched page, oldest first, with work folded into activity rows. */
export function rowsFromEntries(entries: readonly TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  // The activity row a following tool call may still grow; -1 once a spoken row closes the run.
  let open = -1;
  for (const [index, entry] of entries.entries()) {
    const key = `${entry.seqStart}:${index}`;
    const row = itemRow(entry.item, key);
    if (row !== null) {
      rows.push(row);
      open = -1;
      continue;
    }
    const count = activityCount(entry.item);
    if (count === null) continue;
    if (open >= 0 && rows[open]?.kind === "activity") {
      rows[open] = grownActivity(rows[open], count);
      continue;
    }
    open = rows.length;
    rows.push(newActivity(key, count));
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
 * A tool call grows the activity row below the last message, and a spoken row always appends.
 */
export function appendLiveItem(
  rows: readonly TimelineRow[],
  item: AgentTimelineItem,
  key: string,
): readonly TimelineRow[] {
  const row = itemRow(item, key);
  if (row === null) {
    const count = activityCount(item);
    if (count === null) return rows;
    const last = rows[rows.length - 1];
    if (last?.kind === "activity") {
      const next = [...rows];
      next[next.length - 1] = grownActivity(last, count);
      return next;
    }
    return [...rows, newActivity(key, count)].slice(-ROW_LIMIT);
  }
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

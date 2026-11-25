import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/** A preview row: something said, or a one-line tally of the work behind the conversation. */
export type TimelineRowKind = "user" | "assistant" | "error" | "activity";

/** One tool call folded into an activity line: what kind it was, and whether it failed. */
export interface ActivityCall {
  readonly id: string;
  readonly kind: "command" | "tool";
  readonly failed: boolean;
}

export interface TimelineRow {
  readonly key: string;
  readonly kind: TimelineRowKind;
  readonly text: string;
  /** The provider's id for a streaming message, so its chunks update one row. */
  readonly streamId?: string;
  /** On an activity row, the calls it stands for; other rows leave it out. */
  readonly calls?: readonly ActivityCall[];
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
 * The call an item contributes to an activity line, or null for everything else: reasoning, todos,
 * notices, and subagents (which the preview shows above the reply box instead). A shell call reads
 * as a command and any other tool as a tool.
 */
function activityCall(item: AgentTimelineItem): ActivityCall | null {
  if (item.type !== "tool_call" || item.detail.type === "sub_agent") return null;
  return {
    id: item.callId,
    kind: item.detail.type === "shell" ? "command" : "tool",
    failed: item.status === "failed" || item.status === "canceled",
  };
}

/**
 * One call folded into the calls already counted. A provider may report the same call as running
 * and then as finished, so the id decides: the later report replaces the earlier one rather than
 * counting a second time.
 */
function foldCall(calls: readonly ActivityCall[], call: ActivityCall): readonly ActivityCall[] {
  const at = calls.findIndex((existing) => existing.id === call.id);
  if (at === -1) return [...calls, call];
  const next = [...calls];
  next[at] = call;
  return next;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The one line that stands in for a run of tool calls, naming each kind only when it has one. */
export function activityText(calls: readonly ActivityCall[]): string {
  const commands = calls.filter((call) => call.kind === "command").length;
  const tools = calls.length - commands;
  const failed = calls.filter((call) => call.failed).length;
  const parts: string[] = [];
  if (commands > 0) parts.push(`Ran ${commands} ${plural(commands, "command", "commands")}`);
  if (tools > 0) {
    const verb = commands === 0 ? "Used" : "used";
    parts.push(
      `${verb} ${tools} ${plural(
        tools,
        commands === 0 ? "tool" : "other tool",
        commands === 0 ? "tools" : "other tools",
      )}`,
    );
  }
  const text = parts.join(" and ");
  return failed === 0 ? text : `${text} · ${failed} failed`;
}

/** An activity row for a fresh run of calls. */
function newActivity(key: string, call: ActivityCall): TimelineRow {
  return { key, kind: "activity", text: activityText([call]), calls: [call] };
}

/** An activity row rebuilt from the calls it holds; its key stays so the line does not flicker. */
function activityRow(row: TimelineRow, calls: readonly ActivityCall[]): TimelineRow {
  return { ...row, text: activityText(calls), calls };
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
    const call = activityCall(entry.item);
    if (call === null) continue;
    if (open >= 0 && rows[open]?.kind === "activity") {
      rows[open] = activityRow(rows[open], foldCall(rows[open].calls ?? [], call));
      continue;
    }
    open = rows.length;
    rows.push(newActivity(key, call));
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
    const call = activityCall(item);
    if (call === null) return rows;
    const last = rows[rows.length - 1];
    if (last?.kind !== "activity") {
      return [...rows, newActivity(key, call)].slice(-ROW_LIMIT);
    }
    const next = [...rows];
    next[next.length - 1] = activityRow(last, foldCall(last.calls ?? [], call));
    return next;
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

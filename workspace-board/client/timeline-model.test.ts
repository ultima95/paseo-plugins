import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  ROW_LIMIT,
  appendLiveItem,
  displayText,
  rowsFromEntries,
  subagentFromItem,
  type TimelineRow,
} from "./timeline-model";

function entry(item: AgentTimelineItem, seqStart = 0) {
  return { item, seqStart };
}

const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const assistant = (text: string, messageId?: string): AgentTimelineItem => ({
  type: "assistant_message",
  text,
  messageId,
});

const toolCall: AgentTimelineItem = {
  type: "tool_call",
  callId: "call-1",
  name: "shell",
  status: "completed",
  error: null,
  detail: { type: "shell", command: "npm test" },
};

describe("rowsFromEntries", () => {
  it("keeps only the conversation, oldest first", () => {
    const rows = rowsFromEntries([
      entry(user("fix the login bug"), 1),
      entry({ type: "reasoning", text: "checking middleware" }, 2),
      entry(toolCall, 3),
      entry(assistant("Looking at it."), 4),
      entry({ type: "todo", items: [{ text: "a", completed: false }] }, 5),
      entry({ type: "notification", level: "warning", message: "heads up" }, 6),
      entry({ type: "compaction", status: "completed" }, 7),
      entry({ type: "error", message: "boom" }, 8),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "error"]);
    expect(rows.map((row) => row.text)).toEqual(["fix the login bug", "Looking at it.", "boom"]);
  });

  it("leaves out reasoning and tool calls entirely", () => {
    const rows = rowsFromEntries([
      entry(toolCall, 1),
      entry({ type: "reasoning", text: "hmm" }, 2),
    ]);
    expect(rows).toEqual([]);
  });

  it("carries the provider message id so its chunks merge", () => {
    const rows = rowsFromEntries([entry(assistant("Hi", "m1"), 1)]);
    expect(rows[0]).toMatchObject({ kind: "assistant", streamId: "m1" });
  });

  it("skips items the preview cannot draw", () => {
    const rows = rowsFromEntries([
      entry(user("hi"), 1),
      entry(
        {
          type: "plugin",
          id: "x",
          pluginId: "p",
          kind: "k",
          version: 1,
          data: null,
        } as AgentTimelineItem,
        2,
      ),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["1:0"]);
  });

  it("keeps only the newest rows once a page is longer than the limit", () => {
    const entries = Array.from({ length: ROW_LIMIT + 5 }, (_, index) =>
      entry(user(`m${index}`), index),
    );
    const rows = rowsFromEntries(entries);
    expect(rows).toHaveLength(ROW_LIMIT);
    expect(rows.at(-1)?.text).toBe(`m${ROW_LIMIT + 4}`);
  });
});

describe("appendLiveItem", () => {
  const base = rowsFromEntries([entry(user("start"), 1)]);

  it("appends a new kind of row", () => {
    const rows = appendLiveItem(base, assistant("Sure."), "live:1");
    expect(rows.map((row) => row.text)).toEqual(["start", "Sure."]);
  });

  it("grows the row of a streaming message by its provider id", () => {
    let rows = appendLiveItem(base, assistant("Hel", "m1"), "live:1");
    rows = appendLiveItem(rows, assistant("Hello", "m1"), "live:2");
    rows = appendLiveItem(rows, assistant("Hello there", "m1"), "live:3");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: "assistant", text: "Hello there", key: "live:1" });
  });

  it("joins the delta chunks a provider streams for one message", () => {
    let rows = appendLiveItem(base, assistant("1. Five", "m1"), "live:1");
    rows = appendLiveItem(rows, assistant(" lines printed", "m1"), "live:2");
    rows = appendLiveItem(rows, assistant(", strict order.", "m1"), "live:3");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.text).toBe("1. Five lines printed, strict order.");
  });

  it("starts a new row when the id changes", () => {
    let rows = appendLiveItem(base, assistant("first", "m1"), "live:1");
    rows = appendLiveItem(rows, assistant("second", "m2"), "live:2");
    expect(rows.map((row) => row.text)).toEqual(["start", "first", "second"]);
  });

  it("grows the last assistant row when the provider sends no id", () => {
    let rows = appendLiveItem(base, assistant("Hel"), "live:1");
    rows = appendLiveItem(rows, assistant("Hello"), "live:2");
    expect(rows.filter((row) => row.kind === "assistant")).toHaveLength(1);
    expect(rows.at(-1)?.text).toBe("Hello");
  });

  it("never merges a reply into the user's message above it", () => {
    const rows = appendLiveItem(base, assistant("reply"), "live:1");
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant"]);
    expect(rows[0].text).toBe("start");
  });

  it("ignores reasoning, tool calls and notes", () => {
    expect(appendLiveItem(base, { type: "reasoning", text: "hmm" }, "live:1")).toBe(base);
    expect(appendLiveItem(base, toolCall, "live:2")).toBe(base);
    expect(
      appendLiveItem(base, { type: "notification", level: "info", message: "note" }, "live:3"),
    ).toBe(base);
    expect(base).toHaveLength(1);
  });

  it("appends an error even when it arrives mid-stream", () => {
    const rows = appendLiveItem(base, { type: "error", message: "turn failed" }, "live:1");
    expect(rows.at(-1)).toMatchObject({ kind: "error", text: "turn failed" });
  });

  it("does not grow past the row limit", () => {
    let rows: readonly TimelineRow[] = [];
    for (let index = 0; index < ROW_LIMIT + 10; index += 1) {
      rows = appendLiveItem(rows, user(`m${index}`), `live:${index}`);
    }
    expect(rows).toHaveLength(ROW_LIMIT);
    expect(rows.at(-1)?.text).toBe(`m${ROW_LIMIT + 9}`);
  });
});

describe("subagentFromItem", () => {
  const task = (status: "running" | "completed", subAgentType?: string): AgentTimelineItem => ({
    type: "tool_call",
    callId: "toolu_1",
    name: "Task",
    status,
    error: null,
    detail: { type: "sub_agent", subAgentType, description: "audit the login flow" },
  });

  it("names a running Task subagent by its type", () => {
    expect(subagentFromItem(task("running", "general-purpose"))).toEqual({
      id: "toolu_1",
      label: "general-purpose",
      state: "running",
    });
  });

  it("falls back to the task description when the provider has no type", () => {
    expect(subagentFromItem(task("completed"))).toMatchObject({
      label: "audit the login flow",
      state: "completed",
    });
  });

  it("leaves every other tool call and item alone", () => {
    expect(subagentFromItem(toolCall)).toBeNull();
    expect(subagentFromItem(user("hi"))).toBeNull();
    expect(subagentFromItem({ type: "reasoning", text: "hmm" })).toBeNull();
  });
});

describe("displayText", () => {
  const row = (kind: TimelineRow["kind"], text: string): TimelineRow => ({ key: "k", kind, text });

  it("trims message prose and leaves an error exact", () => {
    expect(displayText(row("assistant", "\n\nDone.\n\n"))).toBe("Done.");
    expect(displayText(row("user", "  spaced  "))).toBe("spaced");
    expect(displayText(row("error", "  failed: boom\n"))).toBe("  failed: boom\n");
  });
});

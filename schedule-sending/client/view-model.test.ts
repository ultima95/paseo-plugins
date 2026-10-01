import { describe, expect, it } from "vitest";
import type { ScheduledMessage } from "../shared/model";
import { parseWhen } from "./parse-when";
import { canSchedule, describeItem, previewLine, previewText } from "./view-model";

const at = (hour: number, minute = 0, dayOffset = 0): number =>
  new Date(2026, 8, 30 + dayOffset, hour, minute, 0, 0).getTime();
const NOW = at(22, 0);

const base: ScheduledMessage = {
  id: "m1",
  agentId: "agent-1",
  text: "run the tests",
  fireAt: at(3, 0, 1),
  createdAt: at(21, 0),
  status: "pending",
  attempts: 0,
};

describe("previewText", () => {
  it("collapses whitespace and newlines", () => expect(previewText("a\n\n  b\tc")).toBe("a b c"));
  it("truncates long text to 120 characters with an ellipsis", () => {
    const result = previewText("x".repeat(500));
    expect(result).toHaveLength(120);
    expect(result.endsWith("…")).toBe(true);
  });
  it("leaves exactly 120 characters alone", () => expect(previewText("y".repeat(120))).toBe("y".repeat(120)));
});

describe("describeItem", () => {
  it("shows a future pending item with its fire time", () => {
    expect(describeItem(base, NOW)).toEqual({
      id: "m1",
      preview: "run the tests",
      detail: "Tomorrow 03:00",
      tone: "muted",
      cancellable: true,
    });
  });

  it("flags a pending item that is already due", () => {
    const row = describeItem({ ...base, fireAt: NOW - 1 }, NOW);
    expect(row.detail).toBe("Due · waiting to send");
    expect(row.tone).toBe("warning");
    expect(row.cancellable).toBe(true);
  });

  it("shows why an overdue item is still waiting when the agent lookup is failing", () => {
    const row = describeItem({ ...base, fireAt: NOW - 1, lastError: "daemon unreachable" }, NOW);
    expect(row.detail).toBe("Due · waiting to send · daemon unreachable");
    expect(row.tone).toBe("warning");
  });

  it("shows retry progress with the last error", () => {
    const row = describeItem({ ...base, fireAt: NOW - 1, attempts: 2, lastError: "socket closed" }, NOW);
    expect(row.detail).toBe("Retry 2/5 · socket closed");
    expect(row.tone).toBe("warning");
  });

  it("shows a sent item as not cancellable", () => {
    const row = describeItem({ ...base, status: "sent", sentAt: at(3, 0, 1) }, at(8, 0, 1));
    expect(row).toMatchObject({ detail: "Sent Today 03:00", tone: "success", cancellable: false });
  });

  it("shows a failed item with its reason", () => {
    const row = describeItem({ ...base, status: "failed", lastError: "Agent archived" }, NOW);
    expect(row).toMatchObject({ detail: "Failed · Agent archived", tone: "danger", cancellable: false });
  });

  it("falls back when a failed item has no reason", () => {
    expect(describeItem({ ...base, status: "failed" }, NOW).detail).toBe("Failed · unknown error");
  });

  it("shows a canceled item", () => {
    expect(describeItem({ ...base, status: "canceled" }, NOW)).toMatchObject({
      detail: "Canceled",
      tone: "muted",
      cancellable: false,
    });
  });
});

describe("previewLine", () => {
  it("shows a hint for empty input", () => {
    expect(previewLine("", parseWhen("", NOW), NOW)).toEqual({ text: "e.g. 3am, 15:30 or in 5h", isError: false });
  });

  it("shows the resolved time and delta", () => {
    const line = previewLine("in 5h", parseWhen("in 5h", NOW), NOW);
    expect(line).toEqual({ text: "Fires Tomorrow 03:00 · in 5h", isError: false });
  });

  it("shows the parse error", () => {
    const line = previewLine("banana", parseWhen("banana", NOW), NOW);
    expect(line.isError).toBe(true);
    expect(line.text).toMatch(/Can't parse/);
  });
});

describe("canSchedule", () => {
  it("requires non-blank text and a valid time", () => {
    const ok = parseWhen("in 5h", NOW);
    const bad = parseWhen("banana", NOW);
    expect(canSchedule("hello", ok)).toBe(true);
    expect(canSchedule("   ", ok)).toBe(false);
    expect(canSchedule("hello", bad)).toBe(false);
  });
});

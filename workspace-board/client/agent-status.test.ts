import { describe, expect, it } from "vitest";
import type { SubagentRow } from "./timeline-model";
import {
  busyLabel,
  subagentStatusLabel,
  subagentSummary,
  subagentSummaryTone,
} from "./agent-status";

describe("busyLabel", () => {
  it("marks a running agent as working", () => {
    expect(busyLabel("running")).toBe("Working");
  });

  it("marks an agent that has not started its turn yet", () => {
    expect(busyLabel("initializing")).toBe("Starting");
  });

  it("says nothing once the agent is done or stuck", () => {
    expect(busyLabel("idle")).toBeNull();
    expect(busyLabel("error")).toBeNull();
    expect(busyLabel("closed")).toBeNull();
    expect(busyLabel(null)).toBeNull();
  });
});

describe("subagentStatusLabel", () => {
  it("reads as a status after the subagent's name", () => {
    expect(subagentStatusLabel("running")).toBe("working");
    expect(subagentStatusLabel("completed")).toBe("done");
    expect(subagentStatusLabel("failed")).toBe("failed");
    expect(subagentStatusLabel("canceled")).toBe("stopped");
  });
});

function sub(id: string, state: SubagentRow["state"]): SubagentRow {
  return { id, label: id, state };
}

describe("subagentSummary", () => {
  it("says nothing when the agent delegated nothing", () => {
    expect(subagentSummary([])).toBeNull();
  });

  it("counts one subagent in the singular", () => {
    expect(subagentSummary([sub("a", "running")])).toBe("1 subagent · 1 working");
    expect(subagentSummary([sub("a", "completed")])).toBe("1 subagent");
  });

  it("names how many still work", () => {
    expect(subagentSummary([sub("a", "running"), sub("b", "running"), sub("c", "completed")])).toBe(
      "3 subagents · 2 working",
    );
  });

  it("calls out failures", () => {
    expect(subagentSummary([sub("a", "failed"), sub("b", "running")])).toBe(
      "2 subagents · 1 working · 1 failed",
    );
  });
});

describe("subagentSummaryTone", () => {
  it("puts a failure above work in progress", () => {
    expect(subagentSummaryTone([sub("a", "failed"), sub("b", "running")])).toBe("failed");
    expect(subagentSummaryTone([sub("a", "running"), sub("b", "completed")])).toBe("running");
    expect(subagentSummaryTone([sub("a", "completed"), sub("b", "canceled")])).toBe("quiet");
  });
});

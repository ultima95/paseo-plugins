import { describe, expect, it } from "vitest";

import type { SeatRecord } from "../shared/room";
import type { SeatMarker } from "../shared/seats";
import { SIGNALS, feedFromTurn, labelFor } from "./feed";

const seat = (agentId: string, roomId: string, parentId: string | null, marker: SeatMarker): SeatRecord => ({
  agentId,
  roomId,
  parentId,
  marker,
  provider: "claude",
  model: "claude-opus-5-5",
  title: `[room:${marker.seat}] ${agentId}`,
});

const supervisor = seat("S1", "S1", null, { seat: "supervisor" });
const lead = seat("L1", "S1", "S1", { seat: "lead" });
const peer = seat("P1", "S1", "L1", { seat: "peer", tier: "cheap" });

describe("SIGNALS", () => {
  it("covers every protocol signal and disposition", () => {
    expect([...SIGNALS].sort()).toEqual(
      [
        "ACCEPT",
        "ACK",
        "ANSWER",
        "BLOCKED",
        "CANDIDATE",
        "DECISION_NEEDED",
        "DEFER",
        "DONE",
        "HOLD",
        "QUESTION",
        "REJECT",
        "REOPEN_REQUEST",
        "REVIEW",
        "REVISED BRIEF",
        "STATUS",
        "DEPENDENCY_REQUEST",
      ].sort(),
    );
  });
});

describe("labelFor", () => {
  it("reads a one-word signal off the first line", () => {
    expect(labelFor("CANDIDATE abc\nmore", "x")).toBe("CANDIDATE");
  });

  it("reads a two-word signal", () => {
    expect(labelFor("REVISED BRIEF\nthe corrected brief follows", "x")).toBe("REVISED BRIEF");
  });

  it("falls back when the first line carries no signal", () => {
    expect(labelFor("please fix", "instruction")).toBe("instruction");
  });

  it("falls back for an empty message", () => {
    expect(labelFor("", "reply")).toBe("reply");
    expect(labelFor("\n\nDONE", "reply")).toBe("reply");
  });

  it("only looks at the first line", () => {
    expect(labelFor("here is the work\nDONE", "reply")).toBe("reply");
  });

  it("accepts a signal followed by punctuation", () => {
    expect(labelFor("STATUS: 2 of 3 done", "instruction")).toBe("STATUS");
    expect(labelFor("ACCEPT L1-candidate", "instruction")).toBe("ACCEPT");
  });

  it("does not match a word that merely starts with a signal", () => {
    expect(labelFor("STATUSES are mixed", "instruction")).toBe("instruction");
    expect(labelFor("DONEX", "instruction")).toBe("instruction");
  });

  it("matches a lower-case signal and returns the canonical spelling", () => {
    expect(labelFor("done — nothing left", "reply")).toBe("DONE");
  });
});

describe("feedFromTurn", () => {
  it("attributes a user message naming a child to that child", () => {
    const events = feedFromTurn({
      agent: lead,
      childIds: [peer.agentId],
      timeline: [
        { type: "user_message", text: "P1: format the logs" },
        { type: "assistant_message", text: "STATUS waiting on P1" },
      ],
    });

    expect(events[0]).toEqual({
      kind: "message",
      from: "P1",
      to: "L1",
      label: "instruction",
      text: "P1: format the logs",
    });
  });

  it("attributes a plain user message to the agent's parent", () => {
    const events = feedFromTurn({
      agent: lead,
      childIds: [peer.agentId],
      timeline: [{ type: "user_message", text: "brief: split the work" }],
    });

    expect(events).toEqual([
      { kind: "message", from: "S1", to: "L1", label: "instruction", text: "brief: split the work" },
    ]);
  });

  it("labels a supervisor's message from the user as the task", () => {
    const events = feedFromTurn({
      agent: supervisor,
      childIds: ["L1"],
      timeline: [{ type: "user_message", text: "fix the auth retry loop" }],
    });

    expect(events).toEqual([
      { kind: "message", from: null, to: "S1", label: "task", text: "fix the auth retry loop" },
    ]);
  });

  it("attributes the final reply to the agent, addressed to its parent", () => {
    const events = feedFromTurn({
      agent: lead,
      childIds: [peer.agentId],
      timeline: [
        { type: "user_message", text: "status?" },
        { type: "assistant_message", text: "DONE\nall three peers finished" },
      ],
    });

    expect(events.at(-1)).toEqual({
      kind: "message",
      from: "L1",
      to: "S1",
      label: "DONE",
      text: "DONE\nall three peers finished",
    });
  });

  it("falls back to reply when the final message carries no signal", () => {
    const events = feedFromTurn({
      agent: peer,
      childIds: [],
      timeline: [
        { type: "user_message", text: "go" },
        { type: "assistant_message", text: "formatted all the logs" },
      ],
    });

    expect(events.at(-1)).toMatchObject({ from: "P1", to: "L1", label: "reply" });
  });

  it("isolates the current turn from the history the tail refetch returned", () => {
    const events = feedFromTurn({
      agent: lead,
      childIds: [peer.agentId],
      timeline: [
        { type: "user_message", text: "older instruction" },
        { type: "assistant_message", text: "DONE older" },
        { type: "user_message", text: "P1: take the second item" },
        { type: "assistant_message", text: "STATUS on it" },
      ],
    });

    expect(events).toEqual([
      {
        kind: "message",
        from: "P1",
        to: "L1",
        label: "instruction",
        text: "P1: take the second item",
      },
      { kind: "message", from: "L1", to: "S1", label: "STATUS", text: "STATUS on it" },
    ]);
  });

  it("uses only the last assistant message when the tail has no user message", () => {
    const events = feedFromTurn({
      agent: lead,
      childIds: [],
      timeline: [
        { type: "assistant_message", text: "DONE first" },
        { type: "assistant_message", text: "DONE second" },
      ],
    });

    expect(events).toEqual([
      { kind: "message", from: "L1", to: "S1", label: "DONE", text: "DONE second" },
    ]);
  });

  it("emits nothing for a turn with no messages", () => {
    expect(feedFromTurn({ agent: lead, childIds: [], timeline: [] })).toEqual([]);
    expect(
      feedFromTurn({
        agent: lead,
        childIds: [],
        timeline: [{ type: "reasoning", text: "thinking" }, { type: "todo", items: [] }],
      }),
    ).toEqual([]);
  });

  it("ignores other timeline item kinds when isolating the turn", () => {
    const events = feedFromTurn({
      agent: peer,
      childIds: [],
      timeline: [
        { type: "assistant_message", text: "DONE history" },
        { type: "reasoning", text: "thinking" },
        { type: "user_message", text: "continue" },
        { type: "reasoning", text: "more thinking" },
        { type: "assistant_message", text: "CANDIDATE abc123" },
      ],
    });

    expect(events).toEqual([
      { kind: "message", from: "L1", to: "P1", label: "instruction", text: "continue" },
      { kind: "message", from: "P1", to: "L1", label: "CANDIDATE", text: "CANDIDATE abc123" },
    ]);
  });

  it("emits no row for a supervisor heartbeat wake", () => {
    const events = feedFromTurn({
      agent: supervisor,
      childIds: ["L1"],
      timeline: [
        {
          type: "user_message",
          text: "[supervisor-heartbeat] Inspect changed room state since your last checkpoint…",
        },
        { type: "assistant_message", text: "⏳ Working:\n◉ auth · running" },
      ],
    });

    // The heartbeat prompt is synthetic: it is not a room message, so it gets no
    // row — and the reply that ends the turn still does.
    expect(events).toEqual([
      {
        kind: "message",
        from: "S1",
        to: null,
        label: "reply",
        text: "⏳ Working:\n◉ auth · running",
      },
    ]);
  });

  it("keeps a real instruction in the same tail as a heartbeat, still without the heartbeat row", () => {
    const events = feedFromTurn({
      agent: supervisor,
      childIds: ["L1"],
      timeline: [
        { type: "user_message", text: "[supervisor-heartbeat] Inspect changed room state" },
        { type: "assistant_message", text: "⏳ Working:\n◉ auth · running" },
        { type: "user_message", text: "  [supervisor-heartbeat] again, with leading space" },
        { type: "assistant_message", text: "✅ Done: nothing changed" },
        { type: "user_message", text: "now check the billing export" },
        { type: "assistant_message", text: "✅ Done: billing checked" },
      ],
    });

    // Both heartbeat wakes are gone; the person's message and the turn's reply remain.
    expect(events).toEqual([
      {
        kind: "message",
        from: null,
        to: "S1",
        label: "task",
        text: "now check the billing export",
      },
      {
        kind: "message",
        from: "S1",
        to: null,
        label: "reply",
        text: "✅ Done: billing checked",
      },
    ]);
  });

  it("does not treat a heartbeat tag anywhere but the first line as synthetic", () => {
    const events = feedFromTurn({
      agent: supervisor,
      childIds: [],
      timeline: [{ type: "user_message", text: "keep going\n[supervisor-heartbeat] was handled" }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ label: "task" });
  });
});

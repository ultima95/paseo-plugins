import { describe, expect, it } from "vitest";

import type { FeedEvent, SeatMarkerRecord, SeatRecord } from "../shared/room";
import type { TreeNode } from "./view-model";
import { buildTree, feedRows, seatName } from "./view-model";

const SUP: SeatMarkerRecord = { seat: "supervisor" };
const LEAD: SeatMarkerRecord = { seat: "lead" };
const peer = (tier: string): SeatMarkerRecord => ({ seat: "peer", tier });

function seat(
  agentId: string,
  parentId: string | null,
  marker: SeatMarkerRecord = SUP,
  overrides: Partial<SeatRecord> = {},
): SeatRecord {
  return {
    agentId,
    roomId: "room-1",
    parentId,
    marker,
    provider: "claude",
    model: "claude-opus-5-5",
    title: "",
    ...overrides,
  };
}

function event(overrides: Partial<FeedEvent> & Pick<FeedEvent, "id">): FeedEvent {
  return {
    roomId: "room-1",
    at: "2026-10-28T10:02:00.000Z",
    kind: "message",
    from: null,
    to: null,
    label: "instruction",
    text: "hello",
    ...overrides,
  };
}

/** Ids and depths, in row order — the shape a renderer walks. */
function shape(rows: TreeNode[]): [string, number][] {
  return rows.map((row) => [row.seat.agentId, row.depth]);
}

describe("buildTree", () => {
  it("walks Sup → Lead → [PeerA, PeerB] depth-first with depths 0,1,2,2", () => {
    const seats = [
      seat("sup", null),
      seat("lead", "sup", LEAD),
      seat("peerA", "lead", peer("default")),
      seat("peerB", "lead", peer("cheap")),
    ];

    const rows = buildTree(seats);

    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2]);
    expect(rows.map((row) => row.seat.agentId)).toEqual(["sup", "lead", "peerA", "peerB"]);
  });

  it("keeps each seat's record on its row", () => {
    const seats = [seat("sup", null), seat("lead", "sup", LEAD)];

    const rows = buildTree(seats);

    expect(rows[1]?.seat).toBe(seats[1]);
  });

  it("puts the root first even when it is last in the seat list", () => {
    const seats = [seat("peerA", "lead", peer("default")), seat("lead", "sup", LEAD), seat("sup", null)];

    expect(shape(buildTree(seats))).toEqual([
      ["sup", 0],
      ["lead", 1],
      ["peerA", 2],
    ]);
  });

  it("places a seat whose parent is missing at depth 0 after the root", () => {
    const seats = [seat("sup", null), seat("lead", "sup", LEAD), seat("orphan", "gone", peer("cheap"))];

    expect(shape(buildTree(seats))).toEqual([
      ["sup", 0],
      ["lead", 1],
      ["orphan", 0],
    ]);
  });

  it("keeps the root first even when an orphan is recorded before it", () => {
    const seats = [seat("orphan", "gone", peer("cheap")), seat("sup", null), seat("lead", "sup", LEAD)];

    expect(shape(buildTree(seats))).toEqual([
      ["sup", 0],
      ["lead", 1],
      ["orphan", 0],
    ]);
  });

  it("keeps an orphan's own children under it", () => {
    const seats = [
      seat("sup", null),
      seat("orphan", "gone", LEAD),
      seat("grandchild", "orphan", peer("default")),
    ];

    expect(shape(buildTree(seats))).toEqual([
      ["sup", 0],
      ["orphan", 0],
      ["grandchild", 1],
    ]);
  });

  it("keeps siblings in insertion order", () => {
    const seats = [
      seat("sup", null),
      seat("lead", "sup", LEAD),
      seat("second", "sup", LEAD),
      seat("peerB", "lead", peer("cheap")),
      seat("peerA", "lead", peer("default")),
    ];

    expect(shape(buildTree(seats))).toEqual([
      ["sup", 0],
      ["lead", 1],
      ["peerB", 2],
      ["peerA", 2],
      ["second", 1],
    ]);
  });

  it("returns the rows in tree order, not the seat order", () => {
    const seats = [
      seat("sup", null),
      seat("a", "sup", LEAD),
      seat("b", "sup", LEAD),
      seat("a1", "a", peer("default")),
    ];

    expect(shape(buildTree(seats))).toEqual([
      ["sup", 0],
      ["a", 1],
      ["a1", 2],
      ["b", 1],
    ]);
  });

  it("survives a parent cycle without dropping or repeating a seat", () => {
    const seats = [seat("sup", null), seat("x", "y", LEAD), seat("y", "x", LEAD)];

    const rows = buildTree(seats);

    expect(rows.map((row) => row.seat.agentId).sort()).toEqual(["sup", "x", "y"]);
    expect(rows).toHaveLength(3);
  });

  it("handles a forest with no root at all", () => {
    const seats = [seat("x", "gone", LEAD), seat("y", "gone", LEAD)];

    expect(shape(buildTree(seats))).toEqual([
      ["x", 0],
      ["y", 0],
    ]);
  });

  it("has nothing to draw for an empty room", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("does not mutate the seats it is given", () => {
    const seats = [seat("sup", null), seat("lead", "sup", LEAD)];
    const before = JSON.stringify(seats);

    buildTree(seats);

    expect(JSON.stringify(seats)).toBe(before);
  });
});

describe("seatName", () => {
  it("names each seat in full, by its marker", () => {
    expect(seatName(SUP)).toBe("Supervisor");
    expect(seatName(LEAD)).toBe("Lead");
    expect(seatName(peer("cheap"))).toBe("Peer:cheap");
  });
});

describe("feedRows", () => {
  const seats = [
    seat("sup", null),
    seat("lead", "sup", LEAD),
    seat("peer-cheap", "lead", peer("cheap")),
  ];

  it("labels the supervisor, the lead and a peer by their markers", () => {
    const rows = feedRows(
      [
        event({ id: "e1", from: "sup", to: "lead" }),
        event({ id: "e2", from: "lead", to: "peer-cheap" }),
        event({ id: "e3", from: "peer-cheap", to: "lead", label: "CANDIDATE" }),
      ],
      seats,
    );

    expect(rows.map((row) => row.fromLabel)).toEqual(["Sup", "Lead", "Peer:cheap"]);
    expect(rows.map((row) => row.toLabel)).toEqual(["Lead", "Peer:cheap", "Lead"]);
  });

  it("maps a null sender to You, and a null recipient to You too", () => {
    const rows = feedRows([event({ id: "e1", from: null, to: "sup" }), event({ id: "e2", from: "lead", to: null })], seats);

    expect(rows[0]?.fromLabel).toBe("You");
    expect(rows[0]?.toLabel).toBe("Sup");
    expect(rows[1]?.toLabel).toBe("You");
  });

  it("falls back to the first 8 characters of an id with no seat", () => {
    const rows = feedRows([event({ id: "e1", from: "0123456789abcdef", to: "fedcba9876543210" })], seats);

    expect(rows[0]?.fromLabel).toBe("01234567");
    expect(rows[0]?.toLabel).toBe("fedcba98");
  });

  it("rewrites a room-status fence as plain lines", () => {
    const text = [
      "Answer first.",
      "",
      "```room-status",
      "**auth refactor** — `running`",
      "  reviewing token store diff · peers: token store",
      "```",
    ].join("\n");
    const rows = feedRows([event({ id: "e1", from: "sup", to: null, text })], seats);

    expect(rows[0]?.text).toBe(
      "Answer first.\nauth refactor · running · reviewing token store diff · peers: token store",
    );
  });

  it("formats at as local HH:MM, padding both fields", () => {
    const morning = new Date(2026, 9, 28, 10, 2, 0);
    const early = new Date(2026, 9, 28, 9, 5, 0);
    const midnight = new Date(2026, 9, 28, 0, 0, 0);

    const rows = feedRows(
      [
        event({ id: "e1", at: morning.toISOString() }),
        event({ id: "e2", at: early.toISOString() }),
        event({ id: "e3", at: midnight.toISOString() }),
      ],
      seats,
    );

    expect(rows.map((row) => row.time)).toEqual(["10:02", "09:05", "00:00"]);
  });

  it("passes the label, the text and the kind through unchanged", () => {
    const guard = event({
      id: "e1",
      kind: "guard",
      from: "peer-cheap",
      to: "lead",
      label: "archived",
      text: "a [room:peer:cheap] creates no agents",
    });

    expect(feedRows([guard], seats)[0]).toMatchObject({
      id: "e1",
      label: "archived",
      text: "a [room:peer:cheap] creates no agents",
      kind: "guard",
    });
  });

  it("keeps the feed's chronological order", () => {
    const rows = feedRows([event({ id: "e1" }), event({ id: "e2" }), event({ id: "e3" })], seats);

    expect(rows.map((row) => row.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("has nothing to draw for an empty feed", () => {
    expect(feedRows([], seats)).toEqual([]);
  });

  it("keeps a row readable when at is not a date", () => {
    const rows = feedRows([event({ id: "e1", at: "not a timestamp" })], seats);

    expect(rows[0]?.time).toBe("not a timestamp");
  });
});

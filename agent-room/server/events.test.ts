import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedEvent, RoomRecord, SeatRecord } from "../shared/room";
import { DEFAULT_SETTINGS, type SeatMarker } from "../shared/seats";
import { createRoomEvents, lookupTitle } from "./events";
import type { Logger } from "./logger";
import type { RoomStore } from "./store";

type FakeHandle = {
  id: string;
  refresh: ReturnType<typeof vi.fn>;
  current: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
  timeline: { append: ReturnType<typeof vi.fn>; refetch: ReturnType<typeof vi.fn> };
};

function fakePaseo(titles: Record<string, string> = {}, timeline: unknown[] = []) {
  const handles = new Map<string, FakeHandle>();

  const handleFor = (id: string): FakeHandle => {
    const existing = handles.get(id);
    if (existing) return existing;
    const handle: FakeHandle = {
      id,
      refresh: vi.fn(async () => null),
      current: vi.fn(() => ({ id, title: titles[id] ?? null })),
      send: vi.fn(async () => undefined),
      archive: vi.fn(async () => ({ archivedAt: "2026-10-28T10:00:00.000Z" })),
      timeline: {
        append: vi.fn(async () => ({ seq: 1, epoch: "epoch-1" })),
        refetch: vi.fn(async () => ({ entries: timeline })),
      },
    };
    handles.set(id, handle);
    return handle;
  };

  const paseo = { agents: { ref: (id: string) => handleFor(id) } } as unknown as PaseoApi;
  return { paseo, handleFor };
}

function fakeStore(seed: { rooms?: RoomRecord[]; seats?: SeatRecord[] } = {}) {
  const rooms = [...(seed.rooms ?? [])];
  const seats = [...(seed.seats ?? [])];
  const feed: FeedEvent[] = [];
  let seq = 0;

  const addRoom = vi.fn((room: RoomRecord) => {
    rooms.push(room);
  });
  const addSeat = vi.fn((seat: SeatRecord) => {
    seats.push(seat);
  });
  const appendFeed = vi.fn((event: Omit<FeedEvent, "id" | "at"> & { at?: string }): FeedEvent => {
    const stored: FeedEvent = {
      ...event,
      id: `e${(seq += 1)}`,
      at: event.at ?? "2026-10-28T10:00:00.000Z",
    };
    feed.push(stored);
    return stored;
  });
  const endRoom = vi.fn((roomId: string) => {
    const room = rooms.find((candidate) => candidate.id === roomId);
    if (room !== undefined) room.endedAt ??= "2026-10-28T10:00:00.000Z";
  });

  const store: RoomStore = {
    load: async () => undefined,
    addRoom,
    addSeat,
    seat: (agentId) => seats.find((candidate) => candidate.agentId === agentId),
    children: (agentId) => seats.filter((candidate) => candidate.parentId === agentId),
    appendFeed,
    endRoom,
    listRooms: () =>
      [...rooms].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    room: (roomId) => {
      const room = rooms.find((candidate) => candidate.id === roomId);
      if (room === undefined) return undefined;
      return {
        room,
        seats: seats.filter((candidate) => candidate.roomId === roomId),
        feed: feed.filter((event) => event.roomId === roomId),
      };
    },
    flush: async () => undefined,
  };

  return { store, addRoom, addSeat, appendFeed, endRoom, rooms, seats, feed };
}

const room = (id: string): RoomRecord => ({
  id,
  task: "fix auth",
  cwd: "/repo",
  workspaceId: "W1",
  createdAt: "2026-10-28T09:00:00.000Z",
});

const seat = (
  agentId: string,
  roomId: string,
  parentId: string | null,
  marker: SeatMarker,
  title = `[room:${marker.seat}] ${agentId}`,
): SeatRecord => ({
  agentId,
  roomId,
  parentId,
  marker,
  provider: "claude",
  model: "claude-opus-5-5",
  title,
});

const agent = (over: Partial<PluginHookAgent> & { id: string }): PluginHookAgent => ({
  id: over.id,
  workspaceId: over.workspaceId ?? "W1",
  parentAgentId: over.parentAgentId ?? null,
  provider: over.provider ?? "claude",
  cwd: over.cwd ?? "/repo",
  title: over.title ?? null,
});

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// One shared logger: reset its spies so a warning from another test cannot leak in.
beforeEach(() => {
  vi.clearAllMocks();
});

function eventsWith(
  paseo: PaseoApi,
  store: RoomStore,
  titles: (paseo: PaseoApi, agentId: string) => Promise<string | null> = async () => null,
) {
  const created = createRoomEvents({
    store,
    readSettings: async () => DEFAULT_SETTINGS,
    lookupTitle: titles,
    log,
  });
  const ctx: PluginHookContext = { paseo, signal: new AbortController().signal };
  return { created, ctx };
}

/** A stored Supervisor S1 with one Lead L1, ready for a child of either. */
function storedRoom() {
  return fakeStore({
    rooms: [room("S1")],
    seats: [
      seat("S1", "S1", null, { seat: "supervisor" }),
      seat("L1", "S1", "S1", { seat: "lead" }),
    ],
  });
}

describe("onCreated — membership", () => {
  it("opens a room for a parentless supervisor", async () => {
    const { store, addRoom, addSeat } = fakeStore();
    const { paseo } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "S1", title: "[room:supervisor] fix auth retry" }) },
      ctx,
    );

    expect(addRoom).toHaveBeenCalledTimes(1);
    expect(addRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "S1",
        task: "fix auth retry",
        cwd: "/repo",
        workspaceId: "W1",
      }),
    );
    expect(addSeat).toHaveBeenCalledTimes(1);
    expect(addSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "S1",
        roomId: "S1",
        parentId: null,
        marker: { seat: "supervisor" },
        provider: "claude",
        model: "claude-opus-5-5",
        title: "[room:supervisor] fix auth retry",
      }),
    );
  });

  it("adds a lead to the supervisor's room without archiving it", async () => {
    const { store, addRoom, addSeat } = storedRoom();
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "L2", parentAgentId: "S1", title: "[room:lead] api workstream" }) },
      ctx,
    );

    expect(addRoom).not.toHaveBeenCalled();
    expect(addSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "L2",
        roomId: "S1",
        parentId: "S1",
        marker: { seat: "lead" },
        model: "claude-opus-5-5",
      }),
    );
    expect(handleFor("L2").archive).not.toHaveBeenCalled();
  });

  it("places a peer the lead created in the same room", async () => {
    const { store, addSeat } = storedRoom();
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "P1", parentAgentId: "L1", title: "[room:peer:cheap] format logs" }) },
      ctx,
    );

    expect(addSeat).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "P1", roomId: "S1", parentId: "L1", model: "claude-haiku-4-5" }),
    );
    expect(handleFor("P1").archive).not.toHaveBeenCalled();
  });

  it("stores an unknown tier as parsed, seats the default model and notes the fallback", async () => {
    const { store, addSeat, appendFeed } = storedRoom();
    const { paseo } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "P2", parentAgentId: "L1", title: "[room:peer:zzz] extract tables" }) },
      ctx,
    );

    expect(addSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "P2",
        roomId: "S1",
        marker: { seat: "peer", tier: "zzz" },
        model: "claude-sonnet-5-5",
      }),
    );
    expect(appendFeed).toHaveBeenCalledTimes(1);
    expect(appendFeed).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "S1", kind: "note", label: "tier fallback", to: "P2" }),
    );
    const text = appendFeed.mock.calls[0][0].text;
    expect(text).toContain("zzz");
    expect(text).toContain("default");
  });

  it("records no fallback note when the tier exists", async () => {
    const { store, appendFeed } = storedRoom();
    const { paseo } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "P1", parentAgentId: "L1", title: "[room:peer:cheap] x" }) },
      ctx,
    );

    expect(appendFeed).not.toHaveBeenCalled();
  });

  it("places a lead under an unstored supervisor titled parent in that parent's room", async () => {
    const { store, addSeat } = fakeStore();
    const { paseo, handleFor } = fakePaseo({ S9: "[room:supervisor] detached run" });
    const { created, ctx } = eventsWith(paseo, store, lookupTitle);

    await created.onCreated(
      { agent: agent({ id: "L9", parentAgentId: "S9", title: "[room:lead] api" }) },
      ctx,
    );

    expect(addSeat).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "L9", roomId: "S9", parentId: "S9" }),
    );
    expect(handleFor("L9").archive).not.toHaveBeenCalled();
  });

  it("skips the seat record when a marked agent's unstored parent is not a supervisor", async () => {
    const { store, addSeat } = fakeStore();
    const { paseo, handleFor } = fakePaseo({ L9: "[room:lead] api" });
    const { created, ctx } = eventsWith(paseo, store, lookupTitle);

    await created.onCreated(
      { agent: agent({ id: "P9", parentAgentId: "L9", title: "[room:peer:cheap] x" }) },
      ctx,
    );

    expect(addSeat).not.toHaveBeenCalled();
    expect(handleFor("P9").archive).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "cannot place seat: parent has no room",
      expect.objectContaining({ agentId: "P9", parentId: "L9" }),
    );
  });

  it("ignores an unmarked agent created by an unmarked parent", async () => {
    const { store, addRoom, addSeat, appendFeed, endRoom } = fakeStore();
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "X1", parentAgentId: "U1", title: "Fix the tests" }) },
      ctx,
    );

    expect(addRoom).not.toHaveBeenCalled();
    expect(addSeat).not.toHaveBeenCalled();
    expect(appendFeed).not.toHaveBeenCalled();
    expect(endRoom).not.toHaveBeenCalled();
    expect(handleFor("X1").archive).not.toHaveBeenCalled();
    expect(handleFor("U1").send).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("still opens a room for a supervisor created by an unmarked parent", async () => {
    const { store, addRoom } = fakeStore();
    const { paseo } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "S2", parentAgentId: "U1", title: "[room:supervisor] second room" }) },
      ctx,
    );

    expect(addRoom).toHaveBeenCalledWith(expect.objectContaining({ id: "S2", task: "second room" }));
  });
});

describe("onCreated — guard", () => {
  const guardCases: Array<[string, SeatRecord, PluginHookAgent]> = [
    [
      "a peer that spawns a peer",
      seat("P1", "S1", "L1", { seat: "peer", tier: "default" }),
      agent({ id: "P9", parentAgentId: "P1", title: "[room:peer:default] nested work" }),
    ],
    [
      "a lead that spawns an unmarked agent",
      seat("L1", "S1", "S1", { seat: "lead" }),
      agent({ id: "X9", parentAgentId: "L1", title: "format the logs" }),
    ],
  ];

  it.each(guardCases)("archives the child when %s", async (_name, violator, child) => {
    const seeded = storedRoom();
    const { store, addSeat, appendFeed } = seeded;
    // Seeded directly so the store spy records only what the handler does.
    if (store.seat(violator.agentId) === undefined) seeded.seats.push(violator);
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated({ agent: child }, ctx);

    expect(handleFor(child.id).archive).toHaveBeenCalledTimes(1);
    expect(addSeat).not.toHaveBeenCalled();
    expect(appendFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "S1",
        kind: "guard",
        from: violator.agentId,
        to: child.id,
      }),
    );

    const message = handleFor(violator.agentId).send.mock.calls[0][0] as string;
    expect(handleFor(violator.agentId).send).toHaveBeenCalledTimes(1);
    expect(message).toContain(child.id);
    expect(message).toContain(child.title!);
    expect(message).toContain("archived");
    expect(message).toContain("[room:");
  });

  it("tells the peer's lead with a room-guard timeline row", async () => {
    const { store, seats } = storedRoom();
    seats.push(seat("P1", "S1", "L1", { seat: "peer", tier: "default" }));
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "P9", parentAgentId: "P1", title: "[room:peer:cheap] nested" }) },
      ctx,
    );

    const leadHandle = handleFor("L1");
    expect(leadHandle.timeline.append).toHaveBeenCalledTimes(1);
    expect(leadHandle.timeline.append).toHaveBeenCalledWith({
      type: "plugin",
      id: "room-guard-P9",
      kind: "room-guard",
      version: 1,
      data: {
        childId: "P9",
        childTitle: "[room:peer:cheap] nested",
        violatorId: "P1",
        rule: expect.stringContaining("[room:peer"),
      },
    });
    // The violating peer itself gets the message, not a timeline row.
    expect(handleFor("P1").timeline.append).not.toHaveBeenCalled();
  });

  it("names the peer marker rule when a lead spawns an unmarked agent", async () => {
    const { store } = storedRoom();
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "X9", parentAgentId: "L1", title: "format the logs" }) },
      ctx,
    );

    const message = handleFor("L1").send.mock.calls[0][0] as string;
    expect(message).toContain("[room:peer:<tier>]");
    expect(message).toContain("[room:peer:default]");
    expect(handleFor("L1").timeline.append).not.toHaveBeenCalled();
  });

  it("archives an unmarked child of a supervisor", async () => {
    const { store } = storedRoom();
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "X9", parentAgentId: "S1", title: "something" }) },
      ctx,
    );

    expect(handleFor("X9").archive).toHaveBeenCalledTimes(1);
    expect(handleFor("S1").send.mock.calls[0][0]).toContain("[room:lead]");
  });

  it("archives a lead a supervisor should not have created", async () => {
    const { store } = storedRoom();
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onCreated(
      { agent: agent({ id: "P9", parentAgentId: "S1", title: "[room:peer:default] direct" }) },
      ctx,
    );

    expect(handleFor("P9").archive).toHaveBeenCalledTimes(1);
    expect(handleFor("S1").send).toHaveBeenCalledTimes(1);
  });

  it("still archives when the parent is missing from the store but its title is a peer", async () => {
    const { store, addSeat, appendFeed } = fakeStore();
    const { paseo, handleFor } = fakePaseo({ P5: "[room:peer:cheap] logs" });
    const { created, ctx } = eventsWith(paseo, store, lookupTitle);

    await created.onCreated(
      { agent: agent({ id: "X9", parentAgentId: "P5", title: "nested unmarked work" }) },
      ctx,
    );

    expect(handleFor("X9").archive).toHaveBeenCalledTimes(1);
    expect(handleFor("P5").send).toHaveBeenCalledTimes(1);
    expect(addSeat).not.toHaveBeenCalled();
    // The peer's room is unknown, so there is nowhere to put the feed event.
    expect(appendFeed).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "guard violation outside a known room",
      expect.objectContaining({ childId: "X9", violatorId: "P5" }),
    );
  });

  it("never archives a marked agent because its parent is unknown", async () => {
    const { store } = fakeStore();
    const { paseo, handleFor } = fakePaseo({ Z1: "an agent with no marker" });
    const { created, ctx } = eventsWith(paseo, store, lookupTitle);

    await created.onCreated(
      { agent: agent({ id: "P9", parentAgentId: "Z1", title: "[room:peer:default] work" }) },
      ctx,
    );

    expect(handleFor("P9").archive).not.toHaveBeenCalled();
  });
});

describe("onTurnEnded", () => {
  const storedPeer = seat("P1", "S1", "L1", { seat: "peer", tier: "cheap" }, "[room:peer:cheap] logs");

  it("appends the turn's feed events for a stored seat", async () => {
    const { store, appendFeed } = fakeStore({
      rooms: [room("S1")],
      seats: [seat("S1", "S1", null, { seat: "supervisor" }), seat("L1", "S1", "S1", { seat: "lead" }), storedPeer],
    });
    const { paseo, handleFor } = fakePaseo({}, [
      { item: { type: "user_message", text: "P1: take the second item" } },
      { item: { type: "assistant_message", text: "STATUS working" } },
    ]);
    const { created, ctx } = eventsWith(paseo, store);

    await created.onTurnEnded(
      { agent: agent({ id: "L1", parentAgentId: "S1" }), turnId: "t1", outcome: { kind: "completed" }, timeline: [] },
      ctx,
    );

    expect(handleFor("L1").timeline.refetch).toHaveBeenCalledWith({ direction: "tail", limit: 40 });
    expect(appendFeed).toHaveBeenCalledTimes(2);
    expect(appendFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "S1",
        kind: "message",
        from: "P1",
        to: "L1",
        label: "instruction",
        text: "P1: take the second item",
      }),
    );
    expect(appendFeed).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "S1", from: "L1", to: "S1", label: "STATUS" }),
    );
  });

  it("does nothing for an agent that holds no seat", async () => {
    const { store, appendFeed } = fakeStore();
    const { paseo, handleFor } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onTurnEnded(
      { agent: agent({ id: "X1" }), turnId: null, outcome: { kind: "canceled", reason: "user" }, timeline: [] },
      ctx,
    );

    expect(handleFor("X1").timeline.refetch).not.toHaveBeenCalled();
    expect(appendFeed).not.toHaveBeenCalled();
  });

  it("logs and swallows a failing timeline refetch", async () => {
    const { store } = fakeStore({ rooms: [room("S1")], seats: [seat("S1", "S1", null, { seat: "supervisor" })] });
    const { paseo, handleFor } = fakePaseo();
    handleFor("S1").timeline.refetch.mockRejectedValueOnce(new Error("daemon gone"));
    const { created, ctx } = eventsWith(paseo, store);

    await expect(
      created.onTurnEnded(
        { agent: agent({ id: "S1" }), turnId: "t1", outcome: { kind: "completed" }, timeline: [] },
        ctx,
      ),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      "agent.turn_ended handling failed",
      expect.objectContaining({ agentId: "S1" }),
    );
  });
});

describe("onArchived", () => {
  it("ends the room when its root is archived", async () => {
    const { store, endRoom } = storedRoom();
    const { paseo } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onArchived({ agent: agent({ id: "S1" }), archivedAt: "2026-10-28T11:00:00.000Z" }, ctx);

    expect(endRoom).toHaveBeenCalledWith("S1");
  });

  it("ignores a non-root agent", async () => {
    const { store, endRoom } = storedRoom();
    const { paseo } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);

    await created.onArchived({ agent: agent({ id: "L1" }), archivedAt: "2026-10-28T11:00:00.000Z" }, ctx);

    expect(endRoom).not.toHaveBeenCalled();
  });
});

describe("handler safety", () => {
  it("never throws when the store rejects a write", async () => {
    const { store } = storedRoom();
    const { paseo } = fakePaseo();
    const { created, ctx } = eventsWith(paseo, store);
    (store.addSeat as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(
      created.onCreated({ agent: agent({ id: "L2", parentAgentId: "S1", title: "[room:lead] x" }) }, ctx),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      "agent.created handling failed",
      expect.objectContaining({ agentId: "L2" }),
    );
  });

  it("archives the child even when the violator message cannot be sent", async () => {
    const { store } = storedRoom();
    const { paseo, handleFor } = fakePaseo();
    handleFor("L1").send.mockRejectedValueOnce(new Error("closed"));
    const { created, ctx } = eventsWith(paseo, store);

    await expect(
      created.onCreated({ agent: agent({ id: "X9", parentAgentId: "L1", title: "no marker" }) }, ctx),
    ).resolves.toBeUndefined();
    expect(handleFor("X9").archive).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "guard: could not notify the violator",
      expect.objectContaining({ violatorId: "L1" }),
    );
  });
});

describe("lookupTitle", () => {
  it("refreshes the handle and reads its current title", async () => {
    const { paseo, handleFor } = fakePaseo({ P1: "[room:peer:cheap] logs" });
    await expect(lookupTitle(paseo, "P1")).resolves.toBe("[room:peer:cheap] logs");
    expect(handleFor("P1").refresh).toHaveBeenCalledTimes(1);
  });

  it("returns null for a handle with no snapshot title", async () => {
    const { paseo, handleFor } = fakePaseo();
    handleFor("P2").current.mockReturnValueOnce(null);
    await expect(lookupTitle(paseo, "P2")).resolves.toBeNull();
  });

  it("returns null instead of throwing when the refresh fails", async () => {
    const { paseo, handleFor } = fakePaseo({ P3: "[room:lead] x" });
    handleFor("P3").refresh.mockRejectedValueOnce(new Error("unknown agent"));
    await expect(lookupTitle(paseo, "P3")).resolves.toBeNull();
  });
});

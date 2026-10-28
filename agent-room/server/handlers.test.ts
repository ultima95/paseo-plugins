import type { PaseoAgentCreateOptions, PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";

import type { FeedEvent, RoomRecord, SeatRecord } from "../shared/room";
import { adoptRoomRpc, getRoomRpc, launchRoomRpc, listRoomsRpc } from "../shared/rpc";
import { DEFAULT_SETTINGS, seatTitle, type RoomSettings } from "../shared/seats";
import { createHandlers } from "./handlers";
import { PROMPTS } from "./prompts/generated";
import { renderSystemPrompt } from "./render";
import { SEAT_SETTINGS_UNLOADED } from "./settings";
import type { RoomStore } from "./store";

interface CreateCall {
  via: "agents" | "workspace";
  workspaceId?: string;
  options: PaseoAgentCreateOptions;
}

/** A daemon stub that records every create and hands back sequential agent ids. */
function fakePaseo(
  workspaceEntries: Array<{ id: string; workspaceDirectory: string }> = [],
  adoptAgent: unknown = null,
) {
  const created: CreateCall[] = [];
  const refs: string[] = [];
  const sent: string[] = [];
  let next = 0;
  const newHandle = () => ({ id: `A${(next += 1)}` });

  const paseo = {
    agents: {
      create: vi.fn(async (options: PaseoAgentCreateOptions) => {
        created.push({ via: "agents", options });
        return newHandle();
      }),
      ref: vi.fn((agentId: string) => ({
        id: agentId,
        refresh: vi.fn(async () => adoptAgent),
        current: () => adoptAgent,
        send: vi.fn(async (text: string) => {
          sent.push(text);
        }),
      })),
    },
    workspaces: {
      list: vi.fn(async () => ({ entries: workspaceEntries })),
      ref: vi.fn((workspaceId: string) => {
        refs.push(workspaceId);
        return {
          id: workspaceId,
          agents: {
            create: vi.fn(async (options: Omit<PaseoAgentCreateOptions, "cwd">) => {
              created.push({ via: "workspace", workspaceId, options: options as PaseoAgentCreateOptions });
              return newHandle();
            }),
          },
        };
      }),
    },
  } as unknown as PaseoApi;

  return { paseo, created, refs, sent };
}

type RoomDetail = { room: RoomRecord; seats: SeatRecord[]; feed: FeedEvent[] };

function fakeStore(deps: { rooms?: RoomRecord[]; found?: RoomDetail; seat?: SeatRecord } = {}) {
  const listRooms = vi.fn(() => deps.rooms ?? []);
  const room = vi.fn((_roomId: string) => deps.found);
  const seat = vi.fn((_agentId: string) => deps.seat);
  const addRoom = vi.fn();
  const addSeat = vi.fn();
  const appendFeed = vi.fn();
  const flush = vi.fn(async () => undefined);
  return {
    store: { listRooms, room, seat, addRoom, addSeat, appendFeed, flush } as unknown as RoomStore,
    listRooms,
    room,
    seat,
    addRoom,
    addSeat,
    appendFeed,
    flush,
  };
}

function handlersFor(settings: RoomSettings = DEFAULT_SETTINGS, storeDeps: Parameters<typeof fakeStore>[0] = {}) {
  const fake = fakeStore(storeDeps);
  const handlers = createHandlers({ store: fake.store, readSettings: async () => settings });
  return { ...fake, handlers };
}

const roomRecord = (id: string, createdAt: string): RoomRecord => ({
  id,
  task: "Fix the room",
  cwd: "/repo",
  workspaceId: null,
  createdAt,
});

describe("launch", () => {
  it("creates the Supervisor in the given workspace and returns its id as roomId", async () => {
    const { paseo, created, refs } = fakePaseo();
    const { handlers } = handlersFor();

    const out = await handlers.launch({ task: "Fix the room", workspaceId: "W1" }, paseo);

    expect(refs).toEqual(["W1"]);
    expect(created).toHaveLength(1);
    expect(created[0]?.via).toBe("workspace");
    expect(created[0]?.options).toMatchObject({
      title: seatTitle({ seat: "supervisor" }, "Fix the room"),
      prompt: "Fix the room",
      config: {
        provider: "claude/claude-opus-5-5",
        modeId: "bypassPermissions",
        thinkingOptionId: "xhigh",
      },
    });
    // A workspace create omits `cwd`: the workspace owns the directory.
    expect("cwd" in created[0]!.options).toBe(false);
    // A Supervisor is a root agent: no parent seat owns it.
    expect("parent" in created[0]!.options).toBe(false);
    expect(out).toEqual({ roomId: "A1" });
  });

  it("creates the Supervisor in a bare cwd when no workspace is given", async () => {
    const { paseo, created, refs } = fakePaseo();
    const { handlers } = handlersFor();

    const out = await handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo);

    expect(refs).toEqual([]);
    expect(created).toHaveLength(1);
    expect(created[0]?.via).toBe("agents");
    expect(created[0]?.options).toMatchObject({ cwd: "/repo", prompt: "Fix the room" });
    expect(out).toEqual({ roomId: "A1" });
  });

  it("reuses the workspace that already owns the cwd", async () => {
    const { paseo, created, refs } = fakePaseo([{ id: "W9", workspaceDirectory: "/repo/" }]);
    const { handlers } = handlersFor();

    const out = await handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo);

    expect(refs).toEqual(["W9"]);
    expect(created).toHaveLength(1);
    expect(created[0]?.via).toBe("workspace");
    expect(created[0]?.workspaceId).toBe("W9");
    expect(out).toEqual({ roomId: "A1" });
  });

  it("caps the title at 60 characters but sends the task prompt untruncated", async () => {
    const { paseo, created } = fakePaseo();
    const { handlers } = handlersFor();
    const task = "Rewrite the feed renderer so long messages wrap cleanly. ".repeat(10).slice(0, 300);

    await handlers.launch({ task, cwd: "/repo" }, paseo);

    const options = created[0]!.options;
    expect(options.title).toHaveLength(60);
    expect(options.title?.startsWith("[room:supervisor] ")).toBe(true);
    expect(options.prompt).toBe(task);
    expect(options.prompt).toHaveLength(300);
  });

  it("takes the seat and its feature values from the stored settings", async () => {
    const { paseo, created } = fakePaseo();
    const settings: RoomSettings = {
      ...DEFAULT_SETTINGS,
      supervisor: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modeId: "full-access",
        thinkingOptionId: "medium",
        features: { fastMode: true },
      },
    };
    const { handlers } = handlersFor(settings);

    await handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo);

    expect(created[0]?.options.config).toMatchObject({
      provider: "codex/gpt-5.6-sol",
      modeId: "full-access",
      thinkingOptionId: "medium",
      featureValues: { fastMode: true },
    });
  });

  it("omits the controls the seat does not define", async () => {
    const { paseo, created } = fakePaseo();
    const { handlers } = handlersFor({ ...DEFAULT_SETTINGS, supervisor: { provider: "claude", model: "claude-opus-5-5" } });

    await handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo);

    const config = created[0]!.options.config;
    expect(config.provider).toBe("claude/claude-opus-5-5");
    expect(config.modeId).toBeUndefined();
    expect(config.thinkingOptionId).toBeUndefined();
    expect(config.featureValues).toBeUndefined();
  });

  it("gives the Supervisor its role prompt instead of relying on the create hook", async () => {
    const { paseo, created } = fakePaseo();
    const { handlers } = handlersFor();

    await handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo);

    // The whole supervisor prompt: protocol, then role, then the seat table.
    expect(created[0]?.options.config.systemPrompt).toBe(
      renderSystemPrompt({ seat: "supervisor" }, DEFAULT_SETTINGS),
    );
    expect(created[0]?.options.config.systemPrompt).toContain(PROMPTS.protocol);
    expect(created[0]?.options.config.systemPrompt).toContain("## Room seats");
  });

  it("refuses to launch without a workspace or a cwd", async () => {
    const { paseo, created } = fakePaseo();
    const { handlers } = handlersFor();

    await expect(handlers.launch({ task: "Fix the room" }, paseo)).rejects.toThrow(/workspaceId or cwd/);
    expect(created).toHaveLength(0);
  });

  it("fails the launch instead of creating a default Supervisor when the seats do not load", async () => {
    const { paseo, created } = fakePaseo();
    const fake = fakeStore();
    const handlers = createHandlers({
      store: fake.store,
      readSettings: async () => {
        throw new Error(SEAT_SETTINGS_UNLOADED);
      },
    });

    await expect(handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo)).rejects.toThrow(
      SEAT_SETTINGS_UNLOADED,
    );
    expect(created).toHaveLength(0);
  });

  it("does not create a room record itself: onCreated owns that", async () => {
    const { paseo } = fakePaseo();
    const { handlers, listRooms } = handlersFor();

    await handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo);

    expect(listRooms).not.toHaveBeenCalled();
    expect(handlers.list()).toEqual({ rooms: [] });
  });
});

describe("get", () => {
  it("returns the store's room, seats and feed", async () => {
    const found: RoomDetail = {
      room: roomRecord("A1", "2026-10-28T10:00:00.000Z"),
      seats: [
        {
          agentId: "A1",
          roomId: "A1",
          parentId: null,
          marker: { seat: "supervisor" },
          provider: "claude",
          model: "claude-opus-5-5",
          title: "[room:supervisor] Fix the room",
        },
      ],
      feed: [],
    };
    const { handlers, room } = handlersFor(DEFAULT_SETTINGS, { found });

    expect(handlers.get({ roomId: "A1" })).toBe(found);
    expect(room).toHaveBeenCalledWith("A1");
    expect(getRoomRpc.output.safeParse(found).success).toBe(true);
  });

  it("reports an unknown room as missing", async () => {
    const { handlers } = handlersFor();

    expect(handlers.get({ roomId: "nope" })).toEqual({ missing: true });
    expect(getRoomRpc.output.safeParse({ missing: true }).success).toBe(true);
    expect(getRoomRpc.output.safeParse({}).success).toBe(false);
  });
});

describe("list", () => {
  it("returns the store's rooms in the store's order", async () => {
    const rooms = [roomRecord("A2", "2026-10-28T11:00:00.000Z"), roomRecord("A1", "2026-10-28T10:00:00.000Z")];
    const { handlers, listRooms } = handlersFor(DEFAULT_SETTINGS, { rooms });

    expect(handlers.list()).toEqual({ rooms });
    expect(listRooms).toHaveBeenCalledTimes(1);
  });
});

describe("adopt", () => {
  const chat = {
    id: "S1",
    title: "New chat",
    provider: "claude",
    model: "claude-opus-5-5",
    cwd: "/repo",
    workspaceId: "W1",
    createdAt: "2026-10-28T10:00:00.000Z",
  };

  it("records the chat as the Supervisor and sends the protocol", async () => {
    const { paseo, sent } = fakePaseo([], chat);
    const { handlers, addRoom, addSeat, appendFeed, flush } = handlersFor();

    const out = await handlers.adopt({ agentId: "S1" }, paseo);

    expect(out).toEqual({ roomId: "S1" });
    expect(addRoom).toHaveBeenCalledWith({
      id: "S1",
      task: "New chat",
      cwd: "/repo",
      workspaceId: "W1",
      createdAt: "2026-10-28T10:00:00.000Z",
    });
    expect(addSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "S1",
        roomId: "S1",
        parentId: null,
        marker: { seat: "supervisor" },
        provider: "claude",
        model: "claude-opus-5-5",
      }),
    );
    expect(appendFeed).toHaveBeenCalledWith(expect.objectContaining({ kind: "note", label: "adopted" }));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(PROMPTS.protocol);
    expect(sent[0]).toContain("[room:lead]");
  });

  it("returns the recorded room without sending again", async () => {
    const found = { room: roomRecord("S1", "2026-10-28T10:00:00.000Z"), seats: [], feed: [] };
    const { paseo, sent } = fakePaseo([], chat);
    const { handlers, addRoom } = handlersFor(DEFAULT_SETTINGS, { found });

    expect(await handlers.adopt({ agentId: "S1" }, paseo)).toEqual({ roomId: "S1" });
    expect(addRoom).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses an agent that already holds a seat", async () => {
    const { paseo, sent } = fakePaseo([], chat);
    const seat: SeatRecord = {
      agentId: "S1",
      roomId: "R1",
      parentId: "P1",
      marker: { seat: "peer", tier: "default" },
      provider: "claude",
      model: "claude-sonnet-5-5",
      title: "[room:peer:default] work",
    };
    const { handlers } = handlersFor(DEFAULT_SETTINGS, { seat });

    await expect(handlers.adopt({ agentId: "S1" }, paseo)).rejects.toThrow(/already holds a room seat/);
    expect(sent).toEqual([]);
  });

  it("refuses when the agent is not in the daemon", async () => {
    const { paseo } = fakePaseo([], null);
    const { handlers } = handlersFor();

    await expect(handlers.adopt({ agentId: "missing" }, paseo)).rejects.toThrow(/agent not found/);
  });
});

describe("contracts", () => {
  it("names the RPCs the client calls", () => {
    expect([launchRoomRpc.name, adoptRoomRpc.name, listRoomsRpc.name, getRoomRpc.name]).toEqual([
      "room.launch",
      "room.adopt",
      "room.list",
      "room.get",
    ]);
  });

  it("requires one of workspaceId or cwd on launch", () => {
    expect(launchRoomRpc.input.safeParse({ task: "Fix it" }).success).toBe(false);
    expect(launchRoomRpc.input.safeParse({ task: "Fix it", workspaceId: "W1" }).success).toBe(true);
    expect(launchRoomRpc.input.safeParse({ task: "Fix it", cwd: "/repo" }).success).toBe(true);
    expect(launchRoomRpc.input.safeParse({ task: "", cwd: "/repo" }).success).toBe(false);
  });
});

import type { PaseoAgentCreateOptions, PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";

import type { FeedEvent, RoomRecord, SeatRecord } from "../shared/room";
import { getRoomRpc, launchRoomRpc, listRoomsRpc } from "../shared/rpc";
import { DEFAULT_SETTINGS, seatTitle, type RoomSettings } from "../shared/seats";
import { createHandlers } from "./handlers";
import type { RoomStore } from "./store";

interface CreateCall {
  via: "agents" | "workspace";
  workspaceId?: string;
  options: PaseoAgentCreateOptions;
}

/** A daemon stub that records every create and hands back sequential agent ids. */
function fakePaseo() {
  const created: CreateCall[] = [];
  const refs: string[] = [];
  let next = 0;
  const newHandle = () => ({ id: `A${(next += 1)}` });

  const paseo = {
    agents: {
      create: vi.fn(async (options: PaseoAgentCreateOptions) => {
        created.push({ via: "agents", options });
        return newHandle();
      }),
    },
    workspaces: {
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

  return { paseo, created, refs };
}

type RoomDetail = { room: RoomRecord; seats: SeatRecord[]; feed: FeedEvent[] };

function fakeStore(deps: { rooms?: RoomRecord[]; found?: RoomDetail } = {}) {
  const listRooms = vi.fn(() => deps.rooms ?? []);
  const room = vi.fn((_roomId: string) => deps.found);
  return { store: { listRooms, room } as unknown as RoomStore, listRooms, room };
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

    expect(created[0]?.options.config).toEqual({
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

    expect(created[0]?.options.config).toEqual({ provider: "claude/claude-opus-5-5" });
  });

  it("refuses to launch without a workspace or a cwd", async () => {
    const { paseo, created } = fakePaseo();
    const { handlers } = handlersFor();

    await expect(handlers.launch({ task: "Fix the room" }, paseo)).rejects.toThrow(/workspaceId or cwd/);
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

describe("contracts", () => {
  it("names the RPCs the client calls", () => {
    expect([launchRoomRpc.name, listRoomsRpc.name, getRoomRpc.name]).toEqual(["room.launch", "room.list", "room.get"]);
  });

  it("requires one of workspaceId or cwd on launch", () => {
    expect(launchRoomRpc.input.safeParse({ task: "Fix it" }).success).toBe(false);
    expect(launchRoomRpc.input.safeParse({ task: "Fix it", workspaceId: "W1" }).success).toBe(true);
    expect(launchRoomRpc.input.safeParse({ task: "Fix it", cwd: "/repo" }).success).toBe(true);
    expect(launchRoomRpc.input.safeParse({ task: "", cwd: "/repo" }).success).toBe(false);
  });
});

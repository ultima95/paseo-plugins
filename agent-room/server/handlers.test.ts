import type { PaseoAgentCreateOptions, PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";

import { CHARTER_PROMPT_CAP, memberRecordSchema, type Lesson } from "../shared/member";
import { DEFAULT_SETTINGS, type Role, type RoomSettings } from "../shared/roles";
import { seatRecordSchema, type FeedEvent, type RoomRecord, type SeatRecord } from "../shared/room";
import { adoptRoomRpc, getRoomRpc, launchRoomRpc, listRoomsRpc } from "../shared/rpc";
import { createHandlers } from "./handlers";
import { PROMPTS } from "./prompts/generated";
import { renderSystemPrompt } from "./render";
import { SEAT_SETTINGS_UNLOADED } from "./settings";
import type { MemberStore } from "./member-store";
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
  const bindRoomMembers = vi.fn();
  return {
    store: { listRooms, room, seat, addRoom, addSeat, appendFeed, flush, bindRoomMembers } as unknown as RoomStore,
    listRooms,
    room,
    seat,
    addRoom,
    addSeat,
    appendFeed,
    flush,
    bindRoomMembers,
  };
}

const member = (over: Record<string, unknown> = {}) =>
  memberRecordSchema.parse({
    id: "sup-1",
    name: "Supervisor",
    role: "supervisor",
    provider: "codex",
    model: "gpt-5.6-sol",
    modeId: "full-access",
    thinkingOptionId: "medium",
    memory: { promotion: "human" },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...over,
  });

function fakeMembers(
  records = [member()],
  options: {
    charter?: string;
    lessons?: Lesson[];
    /** Observe the scopes the handler asks the store for. */
    onScopes?: (scopes: readonly string[]) => void;
  } = {},
) {
  return {
    list: () => records,
    get: (id: string) => records.find((record) => record.id === id),
    charter: () => options.charter ?? "Use pnpm.",
    lessonsFor: (_id: string, scopes: readonly string[]) => {
      options.onScopes?.(scopes);
      return options.lessons ?? [];
    },
    pending: () => [],
  } as unknown as MemberStore;
}

function handlersFor(settings: RoomSettings = DEFAULT_SETTINGS, storeDeps: Parameters<typeof fakeStore>[0] = {}) {
  const fake = fakeStore(storeDeps);
  const handlers = createHandlers({
    store: fake.store,
    readSettings: async () => settings,
    members: fakeMembers(),
    repoIdFor: async () => null,
  });
  return { ...fake, handlers };
}

/** The default Supervisor role, so a test can vary one field without inventing a seat. */
const supervisorSeat = (): Role => {
  const role = DEFAULT_SETTINGS.roles.find((candidate) => candidate.kind === "supervisor");
  if (role === undefined) throw new Error("test catalog has no supervisor role");
  return role;
};

/** The defaults with one role replaced wholesale, so a test controls every seat field. */
const withRole = (id: string, role: Role): RoomSettings => ({
  roles: DEFAULT_SETTINGS.roles.map((candidate) => (candidate.id === id ? role : candidate)),
});

const withoutSupervisor = (): RoomSettings => ({
  roles: DEFAULT_SETTINGS.roles.filter((role) => role.kind !== "supervisor"),
});

const roomRecord = (id: string, createdAt: string): RoomRecord => ({
  id,
  task: "Fix the room",
  cwd: "/repo",
  workspaceId: null,
  supervisorMemberId: null,
  leadMemberId: null,
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
      title: "Supervisor: Fix the room",
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
    expect(options.title?.startsWith("Supervisor: ")).toBe(true);
    expect(options.prompt).toBe(task);
    expect(options.prompt).toHaveLength(300);
  });

  it("titles the Supervisor with the configured role's name", async () => {
    const { paseo, created } = fakePaseo();
    const { handlers } = handlersFor(withRole("supervisor", { ...supervisorSeat(), name: "Foreman" }));

    await handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo);

    // The role catalog, not a hardcoded word, decides the routing token.
    expect(created[0]?.options.title).toBe("Foreman: Fix the room");
  });

  it("takes the seat and its feature values from the stored settings", async () => {
    const { paseo, created } = fakePaseo();
    const settings = withRole("supervisor", {
      ...supervisorSeat(),
      provider: "codex",
      model: "gpt-5.6-sol",
      modeId: "full-access",
      thinkingOptionId: "medium",
      features: { fastMode: true },
    });
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
    const bare: Role = {
      id: "supervisor",
      name: "Supervisor",
      kind: "supervisor",
      provider: "claude",
      model: "claude-opus-5-5",
      useFor: "Talks to the user",
    };
    const { handlers } = handlersFor(withRole("supervisor", bare));

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

    // The whole supervisor prompt: protocol, then role, then the role table.
    expect(created[0]?.options.config.systemPrompt).toBe(
      renderSystemPrompt(supervisorSeat(), DEFAULT_SETTINGS),
    );
    expect(created[0]?.options.config.systemPrompt).toContain(PROMPTS.protocol);
    expect(created[0]?.options.config.systemPrompt).toContain("## Room roles");
    // Room prompts route by role name: the Supervisor's table names its Lead.
    expect(created[0]?.options.config.systemPrompt).toContain("Lead: <workstream>");
  });

  it("refuses to launch when the catalog has no supervisor role", async () => {
    const { paseo, created } = fakePaseo();
    const { handlers } = handlersFor(withoutSupervisor());

    await expect(handlers.launch({ task: "Fix the room", cwd: "/repo" }, paseo)).rejects.toThrow(
      "no supervisor role configured",
    );
    expect(created).toHaveLength(0);
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
      members: fakeMembers(),
      repoIdFor: async () => null,
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
  // Deliberately not the Supervisor role's own provider/model: the seat must
  // record what actually runs, not the catalog defaults it could be copying.
  const chat = {
    id: "S1",
    title: "New chat",
    provider: "codex",
    model: "gpt-5.6-sol",
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
      supervisorMemberId: null,
      leadMemberId: null,
      createdAt: "2026-10-28T10:00:00.000Z",
    });
    expect(addSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "S1",
        roomId: "S1",
        parentId: null,
        roleId: "supervisor",
        roleName: "Supervisor",
        roleKind: "supervisor",
        provider: "codex",
        model: "gpt-5.6-sol",
        title: "New chat",
      }),
    );
    // A complete role seat, not the legacy marker: the seat must survive a reload.
    const written = addSeat.mock.calls[0]?.[0] as SeatRecord | undefined;
    expect(written?.marker).toBeUndefined();
    expect(seatRecordSchema.safeParse(written).success).toBe(true);
    expect(appendFeed).toHaveBeenCalledWith(expect.objectContaining({ kind: "note", label: "adopted" }));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(PROMPTS.protocol);
    expect(sent[0]).toContain("Lead: <workstream>");
  });

  it("falls back to the role's model when the adopted chat has none", async () => {
    const { paseo } = fakePaseo([], { ...chat, model: undefined });
    const { handlers, addSeat } = handlersFor();

    await handlers.adopt({ agentId: "S1" }, paseo);

    // An empty `model` fails `nonEmptyText`, which would make the whole rooms
    // file unloadable on the next start — so the seat takes the role's model.
    const written = addSeat.mock.calls[0]?.[0] as SeatRecord | undefined;
    expect(written?.model).toBe(supervisorSeat().model);
    expect(seatRecordSchema.safeParse(written).success).toBe(true);
  });

  it("fails the adopt before recording anything when the catalog has no supervisor", async () => {
    const { paseo, sent } = fakePaseo([], chat);
    const { handlers, addRoom, addSeat } = handlersFor(withoutSupervisor());

    await expect(handlers.adopt({ agentId: "S1" }, paseo)).rejects.toThrow(
      "no supervisor role configured",
    );
    expect(addRoom).not.toHaveBeenCalled();
    expect(addSeat).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
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
      roleId: "implementer",
      roleName: "Implementer",
      roleKind: "worker",
      provider: "claude",
      model: "claude-sonnet-5-5",
      title: "Implementer: work",
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

describe("launch with members", () => {
  it("launches the Supervisor on the selected member's seat and renders its memory", async () => {
    const { paseo, created } = fakePaseo();
    const fake = fakeStore();
    const handlers = createHandlers({
      store: fake.store,
      readSettings: async () => DEFAULT_SETTINGS,
      members: fakeMembers(),
      repoIdFor: async () => null,
    });

    const out = await handlers.launch(
      { task: "Fix the room", cwd: "/repo", supervisorMemberId: "sup-1" },
      paseo,
    );

    expect(out).toEqual({ roomId: "A1" });
    expect(created[0]?.options.config).toMatchObject({
      provider: "codex/gpt-5.6-sol",
      modeId: "full-access",
      thinkingOptionId: "medium",
    });
    expect(created[0]?.options.config.systemPrompt).toContain("## Member\n");
    expect(created[0]?.options.config.systemPrompt).toContain("Use pnpm.");
    // The member's own seat travels with the binding: `agent.created` may have
    // written the Supervisor's seat from the catalog before this bind lands.
    expect(fake.bindRoomMembers).toHaveBeenCalledWith("A1", {
      supervisorMemberId: "sup-1",
      leadMemberId: null,
      supervisorSeat: { provider: "codex", model: "gpt-5.6-sol" },
    });
    // Nothing truncated, so the feed stays clean.
    expect(fake.appendFeed).not.toHaveBeenCalled();
  });

  it("scopes the Supervisor's memory to the room's repository and workspace", async () => {
    const { paseo, created } = fakePaseo();
    const seen: string[][] = [];
    const repoIdFor = vi.fn(async () => "abcd1234");
    const handlers = createHandlers({
      store: fakeStore().store,
      readSettings: async () => DEFAULT_SETTINGS,
      members: fakeMembers(undefined, {
        onScopes: (scopes) => seen.push([...scopes]),
        lessons: [
          {
            at: "2026-11-02T00:00:00.000Z",
            scope: "repo:abcd1234",
            text: "Run the room's own tests first.",
            sourceRoomId: "R0",
            promotedBy: "human",
          },
        ],
      }),
      repoIdFor,
    });

    await handlers.launch(
      { task: "Fix the room", cwd: "/repo/", supervisorMemberId: "sup-1" },
      paseo,
    );

    expect(repoIdFor).toHaveBeenCalledWith("/repo/");
    // A trailing slash must not fork the workspace scope.
    expect(seen).toEqual([["global", "repo:abcd1234", "workspace:/repo"]]);
    expect(created[0]?.options.config.systemPrompt).toContain("Run the room's own tests first.");
  });

  it("reads the member scope from the workspace directory when only a workspace is given", async () => {
    const { paseo, created } = fakePaseo([{ id: "W1", workspaceDirectory: "/repo/" }]);
    const seen: string[][] = [];
    const repoIdFor = vi.fn(async () => null);
    const handlers = createHandlers({
      store: fakeStore().store,
      readSettings: async () => DEFAULT_SETTINGS,
      members: fakeMembers(undefined, { onScopes: (scopes) => seen.push([...scopes]) }),
      repoIdFor,
    });

    await handlers.launch(
      { task: "Fix the room", workspaceId: "W1", supervisorMemberId: "sup-1" },
      paseo,
    );

    // A workspace owns the directory, so the scope comes from the workspace.
    expect(repoIdFor).toHaveBeenCalledWith("/repo/");
    expect(seen).toEqual([["global", "workspace:/repo"]]);
    expect(created[0]?.options.config.systemPrompt).toContain("## Member\n");
  });

  it("notes a truncated member section in the room feed", async () => {
    const { paseo } = fakePaseo();
    const fake = fakeStore();
    const handlers = createHandlers({
      store: fake.store,
      readSettings: async () => DEFAULT_SETTINGS,
      members: fakeMembers(undefined, { charter: "x".repeat(CHARTER_PROMPT_CAP + 1) }),
      repoIdFor: async () => null,
    });

    await handlers.launch(
      { task: "Fix the room", cwd: "/repo", supervisorMemberId: "sup-1" },
      paseo,
    );

    expect(fake.bindRoomMembers).toHaveBeenCalledWith("A1", {
      supervisorMemberId: "sup-1",
      leadMemberId: null,
      supervisorSeat: { provider: "codex", model: "gpt-5.6-sol" },
    });
    expect(fake.appendFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "A1",
        kind: "note",
        from: null,
        to: "A1",
        label: "member note",
      }),
    );
  });

  it("shows the bound Lead member's seat in the Supervisor's role table", async () => {
    const lead = member({
      id: "lead-1",
      name: "Lead",
      role: "lead",
      provider: "codex",
      model: "gpt-5.5-lead",
      modeId: undefined,
      thinkingOptionId: undefined,
    });
    const { paseo, created } = fakePaseo();
    const fake = fakeStore();
    const handlers = createHandlers({
      store: fake.store,
      readSettings: async () => DEFAULT_SETTINGS,
      members: fakeMembers([member(), lead]),
      repoIdFor: async () => null,
    });

    await handlers.launch(
      { task: "Fix the room", cwd: "/repo", supervisorMemberId: "sup-1", leadMemberId: "lead-1" },
      paseo,
    );

    const prompt = created[0]?.options.config.systemPrompt ?? "";
    // The Lead row shows the member's seat instead of the Lead role's.
    expect(prompt).toContain("codex/gpt-5.5-lead");
    expect(prompt).not.toContain("claude/claude-opus-5-5");
    // Both slots travel with their own seat, so either order of `agent.created`
    // and this bind leaves a truthful seat behind.
    expect(fake.bindRoomMembers).toHaveBeenCalledWith("A1", {
      supervisorMemberId: "sup-1",
      leadMemberId: "lead-1",
      supervisorSeat: { provider: "codex", model: "gpt-5.6-sol" },
      leadSeat: { provider: "codex", model: "gpt-5.5-lead" },
    });
  });

  it("refuses a member whose role does not match the slot", async () => {
    const { paseo, created } = fakePaseo();
    const handlers = createHandlers({
      store: fakeStore().store,
      readSettings: async () => DEFAULT_SETTINGS,
      members: fakeMembers([member({ role: "lead" })]),
      repoIdFor: async () => null,
    });

    await expect(
      handlers.launch({ task: "Fix", cwd: "/repo", supervisorMemberId: "sup-1" }, paseo),
    ).rejects.toThrow(/not a supervisor member/);
    expect(created).toHaveLength(0);
  });

  it("refuses an unknown member id before creating anything", async () => {
    const { paseo, created } = fakePaseo();
    const handlers = createHandlers({
      store: fakeStore().store,
      readSettings: async () => DEFAULT_SETTINGS,
      members: fakeMembers(),
      repoIdFor: async () => null,
    });

    await expect(
      handlers.launch({ task: "Fix", cwd: "/repo", leadMemberId: "nope" }, paseo),
    ).rejects.toThrow(/member not found/);
    expect(created).toHaveLength(0);
  });

  it("accepts optional member ids on launch", () => {
    expect(
      launchRoomRpc.input.safeParse({
        task: "Fix",
        cwd: "/repo",
        supervisorMemberId: "sup-1",
        leadMemberId: "lead-1",
      }).success,
    ).toBe(true);
    expect(launchRoomRpc.input.safeParse({ task: "Fix", cwd: "/repo", supervisorMemberId: "" }).success).toBe(false);
  });
});

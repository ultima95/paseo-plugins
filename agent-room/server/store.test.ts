import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FEED_CAP_PER_ROOM,
  FEED_TEXT_CAP,
  type FeedEvent,
  type RoomRecord,
  type SeatRecord,
} from "../shared/room";
import type { SeatMarker } from "../shared/seats";
import type { Logger } from "./logger";
import { createRoomStore, resolveDataDir } from "./store";

let dir: string;
let file: string;
let clock: number;
let seq: number;
let log: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-room-store-"));
  file = join(dir, "rooms.json");
  clock = Date.parse("2026-10-28T10:00:00.000Z");
  seq = 0;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  // A store write can still be in flight when a test ends; Node retries the
  // transient ENOTEMPTY instead of failing the test on its own teardown.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function make() {
  return createRoomStore({
    file,
    now: () => (clock += 60_000),
    newId: () => `evt-${++seq}`,
    log,
  });
}

const room = (id: string, createdAt = "2026-10-28T10:00:00.000Z"): RoomRecord => ({
  id,
  task: `task ${id}`,
  cwd: "/repo",
  workspaceId: null,
  supervisorMemberId: null,
  leadMemberId: null,
  createdAt,
});

const seat = (
  agentId: string,
  roomId: string,
  parentId: string | null,
  marker: SeatMarker,
): SeatRecord => ({
  agentId,
  roomId,
  parentId,
  marker,
  provider: "claude",
  model: "claude-opus-5-5",
  title: `[room:${marker.seat}] ${agentId}`,
});

const roleSeat = (
  agentId: string,
  roomId: string,
  parentId: string | null,
  role: { id: string; name: string; kind: "supervisor" | "lead" | "worker" },
): SeatRecord => ({
  agentId,
  roomId,
  parentId,
  roleId: role.id,
  roleName: role.name,
  roleKind: role.kind,
  provider: "claude",
  model: "claude-opus-5-5",
  title: `${role.name}: ${agentId}`,
});

const SUPERVISOR = { id: "supervisor", name: "Supervisor", kind: "supervisor" as const };
const LEAD = { id: "lead", name: "Lead", kind: "lead" as const };
const WORKER = { id: "implementer", name: "Implementer", kind: "worker" as const };

const feedOf = (id: string) => ({
  roomId: "R",
  kind: "message" as const,
  from: null,
  to: "R",
  label: id,
  text: "x",
});

describe("createRoomStore", () => {
  it("persists rooms, seats and feed across instances", async () => {
    const a = make();
    await a.load();
    a.addRoom(room("R"));
    a.addSeat(roleSeat("R", "R", null, SUPERVISOR));
    a.addSeat(roleSeat("L", "R", "R", LEAD));
    a.appendFeed({ roomId: "R", kind: "message", from: "L", to: "R", label: "DONE", text: "ok" });
    await a.flush();

    const b = make();
    await b.load();
    expect(b.room("R")!.seats.map((s) => s.agentId)).toEqual(["R", "L"]);
    expect(b.seat("R")).toMatchObject({
      roleId: "supervisor",
      roleName: "Supervisor",
      roleKind: "supervisor",
    });
    expect(b.seat("R")?.marker).toBeUndefined();
    expect(b.room("R")!.feed[0]).toMatchObject({ label: "DONE", from: "L", to: "R" });
    expect(b.children("R").map((s) => s.agentId)).toEqual(["L"]);
  });

  it("still loads a seat recorded with a legacy marker only", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, rooms: [room("R")], seats: [seat("L", "R", "R", { seat: "lead" })], feed: [] }),
      "utf8",
    );
    const s = make();
    await s.load();

    expect(s.seat("L")?.marker).toEqual({ seat: "lead" });
    expect(s.seat("L")?.roleId).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("accepts a role-only seat and rejects a seat with neither a role nor a marker", () => {
    const s = make();
    s.addSeat({
      agentId: "A1",
      roomId: "R1",
      parentId: null,
      roleId: "supervisor",
      roleName: "Supervisor",
      roleKind: "supervisor",
      provider: "claude",
      model: "claude-opus-5-5",
      title: "Supervisor: x",
    });
    expect(s.seat("A1")?.roleKind).toBe("supervisor");

    s.addSeat({
      agentId: "A2",
      roomId: "R1",
      parentId: null,
      provider: "claude",
      model: "claude-opus-5-5",
      title: "no role",
    } as never);

    expect(s.seat("A2")).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("rejected invalid seat", { error: expect.any(String) });
  });

  it("rejects a seat that carries a roleId without its roleName and roleKind", () => {
    // A hand-edited or half-written record: the readers would have to guess the
    // role, and the guard would treat the parent as unmanaged and stop archiving.
    const s = make();
    s.addSeat({
      agentId: "A3",
      roomId: "R1",
      parentId: null,
      roleId: "supervisor",
      provider: "claude",
      model: "claude-opus-5-5",
      title: "Supervisor: x",
    } as never);

    expect(s.seat("A3")).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("rejected invalid seat", {
      error: expect.stringContaining("a role seat needs roleName and roleKind"),
    });
  });

  it("caps feed per room, dropping the oldest", () => {
    const s = make();
    s.addRoom(room("R"));
    for (let i = 0; i < FEED_CAP_PER_ROOM + 5; i += 1) s.appendFeed(feedOf(`#${i}`));

    expect(s.room("R")!.feed).toHaveLength(FEED_CAP_PER_ROOM);
    expect(s.room("R")!.feed[0].label).toBe("#5");
    expect(s.room("R")!.feed[FEED_CAP_PER_ROOM - 1].label).toBe("#504");
  });

  it("truncates long feed text", () => {
    const s = make();
    const e = s.appendFeed({
      roomId: "R",
      kind: "message",
      from: null,
      to: "R",
      label: "task",
      text: "x".repeat(FEED_TEXT_CAP + 100),
    });
    expect(e.text).toHaveLength(FEED_TEXT_CAP);
    expect(s.room("R")).toBeUndefined();
  });

  it("starts empty when the file is corrupt", async () => {
    await writeFile(file, "{not json", "utf8");
    const s = make();
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.listRooms()).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("starts empty when the file fails validation", async () => {
    await writeFile(file, JSON.stringify({ version: 99, rooms: [], seats: [], feed: [] }), "utf8");
    const s = make();
    await s.load();
    expect(s.listRooms()).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("starts empty and stays quiet when the file is missing", async () => {
    const s = make();
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.listRooms()).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("lists rooms newest first", () => {
    const s = make();
    s.addRoom(room("A", "2026-10-28T10:00:00.000Z"));
    s.addRoom(room("B", "2026-10-28T10:05:00.000Z"));
    expect(s.listRooms().map((r) => r.id)).toEqual(["B", "A"]);
  });

  it("migrates a v1 file to v2 and reports it once", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, rooms: [room("R")], seats: [], feed: [] }),
      "utf8",
    );
    const s = make();
    await s.load();

    expect(s.migratedFromV1()).toBe(true);
    expect(s.room("R")!.room).toMatchObject({ supervisorMemberId: null, leadMemberId: null });

    await s.flush();
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.rooms[0]).toMatchObject({ supervisorMemberId: null, leadMemberId: null });

    // A second load reads v2 and no longer reports a migration.
    const again = make();
    await again.load();
    expect(again.migratedFromV1()).toBe(false);
  });

  it("binds members whether the room is recorded before or after the binding", () => {
    const s = make();

    // Binding first: the pending binding is merged by addRoom.
    s.bindRoomMembers("R", { supervisorMemberId: "sup-1", leadMemberId: "lead-1" });
    s.addRoom(room("R"));
    expect(s.room("R")!.room).toMatchObject({
      supervisorMemberId: "sup-1",
      leadMemberId: "lead-1",
    });

    // Room first: the binding updates it in place.
    s.addRoom(room("X"));
    s.bindRoomMembers("X", { supervisorMemberId: "sup-2" });
    expect(s.room("X")!.room).toMatchObject({
      supervisorMemberId: "sup-2",
      leadMemberId: null,
    });
  });

  it("corrects the supervisor's seat when the binding lands after the seat", async () => {
    const s = make();
    s.addRoom(room("R"));
    // `agent.created` ran first: it has no model for the agent, so the seat
    // carries the catalog role's `claude-opus-5-5`, not the member's model.
    s.addSeat(roleSeat("R", "R", null, SUPERVISOR));

    s.bindRoomMembers("R", {
      supervisorMemberId: "sup-1",
      supervisorSeat: { provider: "claude", model: "claude-opus-5-6" },
    });

    expect(s.seat("R")).toMatchObject({
      roleId: "supervisor",
      provider: "claude",
      model: "claude-opus-5-6",
    });

    // The correction is durable, not only in memory.
    await s.flush();
    const b = make();
    await b.load();
    expect(b.seat("R")?.model).toBe("claude-opus-5-6");
  });

  it("corrects the lead's seat when the binding lands after the seat", () => {
    const s = make();
    s.addRoom(room("R"));
    s.addSeat(roleSeat("R", "R", null, SUPERVISOR));
    s.addSeat(roleSeat("L", "R", "R", LEAD));

    s.bindRoomMembers("R", {
      leadMemberId: "lead-1",
      leadSeat: { provider: "claude", model: "gpt-5.5-lead" },
    });

    expect(s.seat("L")).toMatchObject({ roleKind: "lead", model: "gpt-5.5-lead" });
    // Only the slot that was bound moves: the supervisor keeps the catalog model.
    expect(s.seat("R")?.model).toBe("claude-opus-5-5");
  });

  it("keeps the catalog model on a seat the bound member does not run", () => {
    const s = make();
    s.addRoom(room("R"));
    // The room's lead member runs `codex`; this Lead seat is a catalog `claude`
    // one, so the member's model would be a lie on it.
    s.addSeat(roleSeat("L", "R", "R", LEAD));

    s.bindRoomMembers("R", {
      leadMemberId: "lead-1",
      leadSeat: { provider: "codex", model: "gpt-5.5-lead" },
    });

    expect(s.seat("L")?.model).toBe("claude-opus-5-5");
  });

  it("leaves a seat the room bound no member to alone", () => {
    const s = make();
    s.addRoom(room("R"));
    s.addSeat(roleSeat("R", "R", null, SUPERVISOR));

    // A launch with no member binds nulls and has no seat to offer.
    s.bindRoomMembers("R", { supervisorMemberId: null, leadMemberId: null });

    expect(s.seat("R")?.model).toBe("claude-opus-5-5");
  });

  it("keeps member ids across a reload", async () => {
    const a = make();
    a.addRoom(room("R"));
    a.bindRoomMembers("R", { supervisorMemberId: "sup-1", leadMemberId: "lead-1" });
    await a.flush();

    const b = make();
    await b.load();
    expect(b.room("R")!.room).toMatchObject({
      supervisorMemberId: "sup-1",
      leadMemberId: "lead-1",
    });
  });

  it("writes a versioned file and leaves no temp file behind", async () => {
    const s = make();
    s.addRoom(room("R"));
    await s.flush();

    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.version).toBe(2);
    expect(written.rooms.map((r: RoomRecord) => r.id)).toEqual(["R"]);
    await expect(readFile(`${file}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serialises concurrent writes and keeps every record", async () => {
    const s = make();
    s.addRoom(room("R"));
    for (let i = 0; i < 20; i += 1) {
      s.appendFeed(feedOf(`#${i}`));
      s.addSeat(roleSeat(`P${i}`, "R", "R", WORKER));
    }
    await Promise.all([s.flush(), s.flush()]);

    const b = make();
    await b.load();
    expect(b.room("R")!.feed).toHaveLength(20);
    expect(b.children("R")).toHaveLength(20);
  });

  it("stamps endedAt once and keeps the room listed", async () => {
    const s = make();
    s.addRoom(room("R"));
    const before = clock;
    s.endRoom("R");
    s.endRoom("R");
    expect(s.room("R")!.room.endedAt).toBe(new Date(before + 60_000).toISOString());
    expect(s.listRooms().map((r) => r.id)).toEqual(["R"]);
  });

  it("scopes seats, children and feed to their room", () => {
    const s = make();
    s.addRoom(room("R"));
    s.addRoom(room("X"));
    s.addSeat(roleSeat("R", "R", null, SUPERVISOR));
    s.addSeat(roleSeat("X", "X", null, SUPERVISOR));
    s.appendFeed({ ...feedOf("r"), roomId: "R" });
    s.appendFeed({ ...feedOf("x"), roomId: "X" });

    expect(s.seat("X")).toMatchObject({ agentId: "X", roomId: "X" });
    expect(s.seat("nobody")).toBeUndefined();
    expect(s.room("R")!.feed.map((e) => e.label)).toEqual(["r"]);
    expect(s.room("X")!.seats.map((e) => e.agentId)).toEqual(["X"]);
    expect(s.room("missing")).toBeUndefined();
  });

  it("uses the provided `at` timestamp when the caller supplies one", () => {
    const s = make();
    const e = s.appendFeed({ ...feedOf("old"), at: "2020-01-01T00:00:00.000Z" });
    expect(e.at).toBe("2020-01-01T00:00:00.000Z");
    expect(e.id).toBe("evt-1");
  });
});

describe("createRoomStore load guard", () => {
  it("lands pending writes before reading the file", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, rooms: [room("STALE")], seats: [], feed: [] }),
      "utf8",
    );
    const s = make();
    s.addRoom(room("NEW"));
    await s.load();

    // The scheduled write reached the disk before the read, so the load could
    // not resurrect the stale room.
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.rooms.map((r: RoomRecord) => r.id)).toEqual(["NEW"]);
    expect(s.listRooms().map((r) => r.id)).toEqual(["NEW"]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith("load after mutation; keeping in-memory state", {
      rooms: 1,
      seats: 0,
      feed: 0,
    });
  });

  it("keeps in-memory state when a load runs after a mutation", async () => {
    const s = make();
    await s.load();
    s.addRoom(room("NEW"));
    s.addSeat(roleSeat("NEW", "NEW", null, SUPERVISOR));
    s.appendFeed({ ...feedOf("note"), roomId: "NEW" });
    await s.flush();

    // A stale file: applying it would silently drop the newer records.
    await writeFile(
      file,
      JSON.stringify({ version: 1, rooms: [room("OLD")], seats: [], feed: [] }),
      "utf8",
    );

    await expect(s.load()).resolves.toBeUndefined();

    expect(s.listRooms().map((r) => r.id)).toEqual(["NEW"]);
    expect(s.room("NEW")!.seats.map((x) => x.agentId)).toEqual(["NEW"]);
    expect(s.room("NEW")!.feed.map((e) => e.label)).toEqual(["note"]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith("load after mutation; keeping in-memory state", {
      rooms: 1,
      seats: 1,
      feed: 1,
    });

    // The next write still reflects memory, not the stale file.
    s.appendFeed({ ...feedOf("after"), roomId: "NEW" });
    await s.flush();
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.rooms.map((r: RoomRecord) => r.id)).toEqual(["NEW"]);
    expect(onDisk.feed.map((e: FeedEvent) => e.label)).toEqual(["note", "after"]);
  });

  it("still keeps in-memory state when the file disappears mid-flight", async () => {
    const s = make();
    await s.load();
    s.addRoom(room("NEW"));
    await s.flush();
    await rm(file);

    await s.load();
    expect(s.listRooms().map((r) => r.id)).toEqual(["NEW"]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith("load after mutation; keeping in-memory state", {
      rooms: 1,
      seats: 0,
      feed: 0,
    });
  });
});

describe("createRoomStore validation", () => {
  it("rejects an invalid seat marker without poisoning a later valid write", async () => {
    const s = make();
    s.addRoom(room("R"));
    s.addSeat({
      ...seat("P", "R", "R", { seat: "lead" }),
      marker: { seat: "peer", tier: "Not A Tier" } as unknown as SeatMarker,
    });

    expect(s.children("R")).toEqual([]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("rejected invalid seat", { error: expect.any(String) });

    s.addSeat(seat("P", "R", "R", { seat: "peer", tier: "default" }));
    await s.flush();
    expect(log.error).toHaveBeenCalledOnce();

    const b = make();
    await b.load();
    expect(log.warn).not.toHaveBeenCalled();
    expect(b.room("R")!.seats).toHaveLength(1);
    expect(b.room("R")!.seats[0].marker).toEqual({ seat: "peer", tier: "default" });
  });

  it("rejects an invalid room record and schedules no write", async () => {
    const s = make();
    s.addRoom({ ...room("R"), id: "" });

    expect(s.listRooms()).toEqual([]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("rejected invalid room", { error: expect.any(String) });

    await s.flush();
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid feed event without poisoning a later valid one", async () => {
    const s = make();
    s.addRoom(room("R"));
    const rejected = s.appendFeed({
      ...feedOf("bad"),
      kind: "shout" as unknown as FeedEvent["kind"],
    });

    expect(rejected).toMatchObject({ label: "bad" });
    expect(s.room("R")!.feed).toEqual([]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("rejected invalid feed event", {
      error: expect.any(String),
    });

    s.appendFeed(feedOf("good"));
    await s.flush();

    const b = make();
    await b.load();
    expect(log.warn).not.toHaveBeenCalled();
    expect(b.room("R")!.feed.map((e) => e.label)).toEqual(["good"]);
  });

  it("falls back to now when the supplied `at` is invalid", () => {
    const s = make();
    const e = s.appendFeed({ ...feedOf("x"), at: "" });

    expect(e.at).toBe("2026-10-28T10:01:00.000Z");
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith("feed event `at` invalid; using now", {
      roomId: "R",
      at: "",
    });
  });
});

describe("resolveDataDir", () => {
  it("defaults to ~/.paseo/plugin-data/agent-room", () => {
    expect(resolveDataDir({}, "/home/u")).toBe("/home/u/.paseo/plugin-data/agent-room");
  });

  it("honours PASEO_HOME", () => {
    expect(resolveDataDir({ PASEO_HOME: "/srv/paseo" }, "/home/u")).toBe(
      "/srv/paseo/plugin-data/agent-room",
    );
  });

  it("falls back to the home directory when PASEO_HOME is blank", () => {
    expect(resolveDataDir({ PASEO_HOME: "  " }, "/home/u")).toBe(
      "/home/u/.paseo/plugin-data/agent-room",
    );
  });
});

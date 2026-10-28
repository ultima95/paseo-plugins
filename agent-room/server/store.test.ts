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
  await rm(dir, { recursive: true, force: true });
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
    a.addSeat(seat("R", "R", null, { seat: "supervisor" }));
    a.addSeat(seat("L", "R", "R", { seat: "lead" }));
    a.appendFeed({ roomId: "R", kind: "message", from: "L", to: "R", label: "DONE", text: "ok" });
    await a.flush();

    const b = make();
    await b.load();
    expect(b.room("R")!.seats.map((s) => s.agentId)).toEqual(["R", "L"]);
    expect(b.room("R")!.feed[0]).toMatchObject({ label: "DONE", from: "L", to: "R" });
    expect(b.children("R").map((s) => s.agentId)).toEqual(["L"]);
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

  it("writes a versioned file and leaves no temp file behind", async () => {
    const s = make();
    s.addRoom(room("R"));
    await s.flush();

    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.version).toBe(1);
    expect(written.rooms.map((r: RoomRecord) => r.id)).toEqual(["R"]);
    await expect(readFile(`${file}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serialises concurrent writes and keeps every record", async () => {
    const s = make();
    s.addRoom(room("R"));
    for (let i = 0; i < 20; i += 1) {
      s.appendFeed(feedOf(`#${i}`));
      s.addSeat(seat(`P${i}`, "R", "R", { seat: "peer", tier: "default" }));
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
    s.addSeat(seat("R", "R", null, { seat: "supervisor" }));
    s.addSeat(seat("X", "X", null, { seat: "supervisor" }));
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
    s.addSeat(seat("NEW", "NEW", null, { seat: "supervisor" }));
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

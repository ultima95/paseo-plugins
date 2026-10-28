import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  FEED_CAP_PER_ROOM,
  FEED_TEXT_CAP,
  ROOMS_FILE_VERSION,
  roomsFileSchema,
  truncateFeedText,
  type FeedEvent,
  type RoomRecord,
  type SeatRecord,
} from "../shared/room";
import type { Logger } from "./logger";

export interface RoomStore {
  /** Read `rooms.json`; a missing file is empty, a corrupt one is empty plus one warn. */
  load(): Promise<void>;
  addRoom(room: RoomRecord): void;
  addSeat(seat: SeatRecord): void;
  seat(agentId: string): SeatRecord | undefined;
  children(agentId: string): SeatRecord[];
  appendFeed(event: Omit<FeedEvent, "id" | "at"> & { at?: string }): FeedEvent;
  endRoom(roomId: string): void;
  /** Newest first by `createdAt`. */
  listRooms(): RoomRecord[];
  room(roomId: string): { room: RoomRecord; seats: SeatRecord[]; feed: FeedEvent[] } | undefined;
  /** Resolves once every scheduled write has landed. */
  flush(): Promise<void>;
}

export interface RoomStoreDeps {
  /** Absolute path of `rooms.json`. */
  file: string;
  now: () => number;
  newId: () => string;
  log: Logger;
}

/** Plugin data lives under the Paseo home, next to the daemon's other state. */
export function resolveDataDir(env: Record<string, string | undefined>, home: string): string {
  const configured = env.PASEO_HOME?.trim();
  const paseoHome =
    configured !== undefined && configured !== "" ? configured : join(home, ".paseo");
  return join(paseoHome, "plugin-data", "agent-room");
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Write `contents` to `file` via `file.tmp` so a reader never sees a half file. */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, file);
}

/**
 * In-memory room state backed by one JSON file. Every mutation schedules a
 * write; writes are serialised through a promise chain and coalesce, so a burst
 * of feed appends costs one write. `flush()` drains the chain.
 */
export function createRoomStore(deps: RoomStoreDeps): RoomStore {
  const { file, now, newId, log } = deps;

  let rooms: RoomRecord[] = [];
  let seats: SeatRecord[] = [];
  let feed: FeedEvent[] = [];

  let writing: Promise<void> = Promise.resolve();
  let dirty = false;

  const snapshot = (): string =>
    `${JSON.stringify({ version: ROOMS_FILE_VERSION, rooms, seats, feed }, null, 2)}\n`;

  const scheduleWrite = (): void => {
    dirty = true;
    writing = writing.then(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await writeFileAtomic(file, snapshot());
      } catch (error) {
        // A failed write must not poison the chain: later writes still get a turn.
        log.error("room store write failed", { error: reason(error) });
      }
    });
  };

  const reset = (): void => {
    rooms = [];
    seats = [];
    feed = [];
  };

  /** Drop all but the newest `FEED_CAP_PER_ROOM` events for one room. */
  const trimRoomFeed = (roomId: string): void => {
    const roomFeed = feed.filter((event) => event.roomId === roomId);
    let excess = roomFeed.length - FEED_CAP_PER_ROOM;
    if (excess <= 0) return;

    const drop = new Set<FeedEvent>();
    for (const event of roomFeed) {
      if (excess === 0) break;
      drop.add(event);
      excess -= 1;
    }
    feed = feed.filter((event) => !drop.has(event));
  };

  /** Re-establish the store invariants after loading a hand-edited file. */
  const normalise = (): void => {
    feed = feed.map((event) =>
      event.text.length > FEED_TEXT_CAP ? { ...event, text: truncateFeedText(event.text) } : event,
    );
    for (const roomId of new Set(feed.map((event) => event.roomId))) trimRoomFeed(roomId);
  };

  const load = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      // A fresh install has no file yet; that is not a fault worth warning about.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reset();
        return;
      }
      log.warn("room store unreadable; starting empty", { error: reason(error) });
      reset();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn("room store corrupt; starting empty", { error: reason(error) });
      reset();
      return;
    }

    const result = roomsFileSchema.safeParse(parsed);
    if (!result.success) {
      log.warn("room store corrupt; starting empty", {
        issues: result.error.issues.length,
        error: result.error.issues[0]?.message ?? "invalid room store",
      });
      reset();
      return;
    }

    rooms = result.data.rooms;
    seats = result.data.seats;
    feed = result.data.feed;
    normalise();
  };

  const addRoom = (room: RoomRecord): void => {
    const index = rooms.findIndex((candidate) => candidate.id === room.id);
    if (index === -1) rooms.push(room);
    else rooms[index] = room;
    scheduleWrite();
  };

  const addSeat = (seat: SeatRecord): void => {
    const index = seats.findIndex((candidate) => candidate.agentId === seat.agentId);
    if (index === -1) seats.push(seat);
    else seats[index] = seat;
    scheduleWrite();
  };

  const seat = (agentId: string): SeatRecord | undefined =>
    seats.find((candidate) => candidate.agentId === agentId);

  const children = (agentId: string): SeatRecord[] =>
    seats.filter((candidate) => candidate.parentId === agentId);

  const appendFeed = (event: Omit<FeedEvent, "id" | "at"> & { at?: string }): FeedEvent => {
    const stored: FeedEvent = {
      ...event,
      id: newId(),
      at: event.at ?? new Date(now()).toISOString(),
      text: truncateFeedText(event.text),
    };
    feed.push(stored);
    trimRoomFeed(stored.roomId);
    scheduleWrite();
    return stored;
  };

  const endRoom = (roomId: string): void => {
    const target = rooms.find((candidate) => candidate.id === roomId);
    if (target === undefined || target.endedAt !== undefined) return;
    target.endedAt = new Date(now()).toISOString();
    scheduleWrite();
  };

  const listRooms = (): RoomRecord[] =>
    [...rooms].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const room = (
    roomId: string,
  ): { room: RoomRecord; seats: SeatRecord[]; feed: FeedEvent[] } | undefined => {
    const found = rooms.find((candidate) => candidate.id === roomId);
    if (found === undefined) return undefined;
    return {
      room: found,
      seats: seats.filter((candidate) => candidate.roomId === roomId),
      feed: feed.filter((event) => event.roomId === roomId),
    };
  };

  const flush = async (): Promise<void> => {
    await writing;
  };

  return {
    load,
    addRoom,
    addSeat,
    seat,
    children,
    appendFeed,
    endRoom,
    listRooms,
    room,
    flush,
  };
}

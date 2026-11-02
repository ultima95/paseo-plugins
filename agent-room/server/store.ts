import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  FEED_CAP_PER_ROOM,
  FEED_TEXT_CAP,
  LEGACY_ROOMS_FILE_VERSION,
  ROOMS_FILE_VERSION,
  feedEventSchema,
  roomRecordSchema,
  roomsFileSchema,
  seatRecordSchema,
  timestampSchema,
  truncateFeedText,
  type FeedEvent,
  type RoomRecord,
  type SeatRecord,
} from "../shared/room";
import type { Logger } from "./logger";

/**
 * What a bound member actually runs: the seat the member would be launched on.
 *
 * `agent.created` cannot read an agent's model (`PluginHookAgent` has none), so
 * it records the catalog role's model, and only the launch knows the member's.
 * Passing it here is what lets the store correct a seat the hook wrote before
 * the binding landed.
 */
export interface RoomMemberSeat {
  provider: string;
  model: string;
}

/** One launch's member bindings: the member ids, plus the seats they run. */
export interface RoomMemberBinding {
  supervisorMemberId?: string | null;
  leadMemberId?: string | null;
  /** The bound Supervisor member's seat; absent when the launch bound none. */
  supervisorSeat?: RoomMemberSeat;
  /** The bound Lead member's seat; absent when the launch bound none. */
  leadSeat?: RoomMemberSeat;
}

export interface RoomStore {
  /**
   * Read `rooms.json`; a missing file is empty, a corrupt one is empty plus one
   * warn. Pending writes land first, and a load that would replace newer
   * in-memory state is refused with one warn instead of clobbering it.
   */
  load(): Promise<void>;
  /** Invalid records are rejected with `log.error` and never reach the store. */
  addRoom(room: RoomRecord): void;
  /** Invalid records are rejected with `log.error` and never reach the store. */
  addSeat(seat: SeatRecord): void;
  seat(agentId: string): SeatRecord | undefined;
  children(agentId: string): SeatRecord[];
  /**
   * Invalid events are rejected with `log.error` and not stored; the returned
   * event is the rejected candidate, not a stored record. An invalid `at` is
   * replaced with `now()` plus one warn, so the event is still stored.
   */
  appendFeed(event: Omit<FeedEvent, "id" | "at"> & { at?: string }): FeedEvent;
  endRoom(roomId: string): void;
  /**
   * Bind the room's Supervisor and Lead members. Order-independent in both
   * directions: a call before the room exists is merged by `addRoom`, and a call
   * after the room also corrects the seat `agent.created` already wrote from the
   * catalog, using the bound member's own seat, because `room.launch` cannot know
   * whether the hook has run yet.
   */
  bindRoomMembers(roomId: string, binding: RoomMemberBinding): void;
  /** True when the load migrated a v1 document; drives the one-time member seed. */
  migratedFromV1(): boolean;
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
  let migratedFromV1 = false;
  const pendingBindings = new Map<
    string,
    { supervisorMemberId: string | null; leadMemberId: string | null }
  >();

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
    pendingBindings.clear();
    migratedFromV1 = false;
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

  const hasState = (): boolean => rooms.length > 0 || seats.length > 0 || feed.length > 0;

  /**
   * Refuse to replace state a mutation produced, warning once with the counts.
   * Returns true when memory was kept, so the caller returns without touching it.
   */
  const keepInMemoryState = (): boolean => {
    if (!hasState()) return false;
    log.warn("load after mutation; keeping in-memory state", {
      rooms: rooms.length,
      seats: seats.length,
      feed: feed.length,
    });
    return true;
  };

  const load = async (): Promise<void> => {
    // Anything already scheduled must land before we read, otherwise we would
    // read a file that predates the mutation and then overwrite memory with it.
    await writing;

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      // A mutation can also land while the read is failing; memory still wins.
      if (keepInMemoryState()) return;
      // A fresh install has no file yet; that is not a fault worth warning about.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("room store unreadable; starting empty", { error: reason(error) });
      }
      reset();
      return;
    }

    // The read finished after a mutation: the contents predate it, so applying
    // them would silently drop newer records and clear `dirty`.
    if (keepInMemoryState()) return;

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
    if (result.data.version === LEGACY_ROOMS_FILE_VERSION) {
      migratedFromV1 = true;
      // Write the normalized v2 document through the same atomic path.
      scheduleWrite();
    }
  };

  const addRoom = (room: RoomRecord): void => {
    const parsed = roomRecordSchema.safeParse(room);
    if (!parsed.success) {
      log.error("rejected invalid room", { error: reason(parsed.error) });
      return;
    }
    const record = parsed.data;
    const pending = pendingBindings.get(record.id);
    if (pending !== undefined) {
      record.supervisorMemberId = pending.supervisorMemberId;
      record.leadMemberId = pending.leadMemberId;
      pendingBindings.delete(record.id);
    }
    const index = rooms.findIndex((candidate) => candidate.id === record.id);
    if (index === -1) rooms.push(record);
    else rooms[index] = record;
    scheduleWrite();
  };

  /**
   * Give the room's seat of `kind` the model the bound member actually runs.
   *
   * The seat is written by `agent.created`, which has no model for the agent and
   * therefore records the catalog role's. Whichever of the two lands second must
   * leave the seat describing what runs, so a binding that arrives after the seat
   * fixes it here rather than leaving the member's seat claiming the catalog
   * model forever.
   *
   * The provider check is the one `agent.created` applies when it resolves a
   * seat's model: a launch that names a member runs that member's provider, so a
   * seat on a different provider was created on the catalog role and keeps the
   * catalog model. Only a seat from the member's own provider is corrected.
   */
  const correctSeat = (
    roomId: string,
    kind: "supervisor" | "lead",
    memberId: string | null,
    bound: RoomMemberSeat | undefined,
  ): void => {
    if (memberId === null || bound === undefined) return;
    for (const candidate of seats) {
      if (candidate.roomId !== roomId) continue;
      if (candidate.roleKind !== kind) continue;
      if (candidate.provider !== bound.provider) continue;
      candidate.model = bound.model;
    }
  };

  const bindRoomMembers = (roomId: string, binding: RoomMemberBinding): void => {
    const current = pendingBindings.get(roomId) ?? {
      supervisorMemberId: null,
      leadMemberId: null,
    };
    const next = {
      supervisorMemberId:
        binding.supervisorMemberId !== undefined
          ? binding.supervisorMemberId
          : current.supervisorMemberId,
      leadMemberId:
        binding.leadMemberId !== undefined ? binding.leadMemberId : current.leadMemberId,
    };
    pendingBindings.set(roomId, next);

    const target = rooms.find((candidate) => candidate.id === roomId);
    if (target !== undefined) {
      target.supervisorMemberId = next.supervisorMemberId;
      target.leadMemberId = next.leadMemberId;
      // The seat may already exist: `agent.created` can run before this binding.
      correctSeat(roomId, "supervisor", next.supervisorMemberId, binding.supervisorSeat);
      correctSeat(roomId, "lead", next.leadMemberId, binding.leadSeat);
      scheduleWrite();
    }
  };

  const migrated = (): boolean => migratedFromV1;

  const addSeat = (seat: SeatRecord): void => {
    const parsed = seatRecordSchema.safeParse(seat);
    if (!parsed.success) {
      log.error("rejected invalid seat", { error: reason(parsed.error) });
      return;
    }
    const record = parsed.data;
    const index = seats.findIndex((candidate) => candidate.agentId === record.agentId);
    if (index === -1) seats.push(record);
    else seats[index] = record;
    scheduleWrite();
  };

  const seat = (agentId: string): SeatRecord | undefined =>
    seats.find((candidate) => candidate.agentId === agentId);

  const children = (agentId: string): SeatRecord[] =>
    seats.filter((candidate) => candidate.parentId === agentId);

  /** `now()` as an ISO string; one call per use so a fake clock stays predictable. */
  const stamped = (): string => new Date(now()).toISOString();

  const appendFeed = (event: Omit<FeedEvent, "id" | "at"> & { at?: string }): FeedEvent => {
    let at = event.at;
    if (at === undefined) {
      at = stamped();
    } else if (!timestampSchema.safeParse(at).success) {
      // A bad timestamp is not worth losing the event over: stamp it instead.
      log.warn("feed event `at` invalid; using now", { roomId: event.roomId, at });
      at = stamped();
    }

    const candidate: FeedEvent = {
      ...event,
      id: newId(),
      at,
      text: truncateFeedText(event.text),
    };

    const parsed = feedEventSchema.safeParse(candidate);
    if (!parsed.success) {
      log.error("rejected invalid feed event", { error: reason(parsed.error) });
      return candidate;
    }

    const stored = parsed.data;
    feed.push(stored);
    trimRoomFeed(stored.roomId);
    scheduleWrite();
    return stored;
  };

  const endRoom = (roomId: string): void => {
    const target = rooms.find((candidate) => candidate.id === roomId);
    if (target === undefined || target.endedAt !== undefined) return;
    target.endedAt = stamped();
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
    bindRoomMembers,
    migratedFromV1: migrated,
    listRooms,
    room,
    flush,
  };
}

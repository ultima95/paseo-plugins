import { z } from "zod";

import { peerTierIdSchema, type SeatMarker } from "./seats";

/** Newest N feed events kept per room; older ones are dropped from the store. */
export const FEED_CAP_PER_ROOM = 500;
/** Longest feed text kept; anything longer is truncated before it is stored. */
export const FEED_TEXT_CAP = 4000;
/** Schema version of `rooms.json`; any other version is treated as corrupt. */
export const ROOMS_FILE_VERSION = 1;

/**
 * The timeline row the guard appends to a violator's parent, and the version of
 * its `data`. Both sides read them from here: the server writes the row and the
 * client registers a renderer for it, so a rename on one side must not leave the
 * other silently rendering nothing.
 */
export const GUARD_ROW_KIND = "room-guard";
export const GUARD_ROW_VERSION = 1;

const nonEmptyText = z.string().min(1);

/**
 * Timestamps are non-empty ISO-8601 strings. Exported so the store can validate
 * a caller-supplied `at` at the mutation boundary, before it reaches the file.
 */
export const timestampSchema = z.string().min(1);

/** How to start one agent, exactly as `SeatMarker` describes it. */
export const seatMarkerSchema = z.discriminatedUnion("seat", [
  z.object({ seat: z.literal("supervisor") }),
  z.object({ seat: z.literal("lead") }),
  z.object({ seat: z.literal("peer"), tier: peerTierIdSchema }),
]);

export type SeatMarkerRecord = z.infer<typeof seatMarkerSchema>;

type AssertSameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
// Compile-time proof that the persisted marker is exactly `SeatMarker`.
type _MarkerSchemaMatchesModel = AssertTrue<AssertSameShape<SeatMarkerRecord, SeatMarker>>;

/**
 * One room. `id` is the Supervisor agent id: whoever created the room owns it.
 * `endedAt` is set when the room closes and never moves.
 */
export const roomRecordSchema = z.object({
  id: nonEmptyText,
  task: z.string(),
  cwd: z.string(),
  workspaceId: z.string().nullable(),
  createdAt: timestampSchema,
  endedAt: timestampSchema.optional(),
});

export type RoomRecord = z.infer<typeof roomRecordSchema>;

/**
 * One agent's seat in a room. `parentId` is the agent that spawned it, so the
 * seat table doubles as the room's delegation tree; `null` means the Supervisor.
 */
export const seatRecordSchema = z.object({
  agentId: nonEmptyText,
  roomId: nonEmptyText,
  parentId: z.string().nullable(),
  marker: seatMarkerSchema,
  provider: nonEmptyText,
  model: nonEmptyText,
  title: z.string(),
});

export type SeatRecord = z.infer<typeof seatRecordSchema>;

/** `message` is agent traffic, `guard` is a policy refusal, `note` is anything else. */
export const feedKindSchema = z.enum(["message", "guard", "note"]);

export type FeedKind = z.infer<typeof feedKindSchema>;

/**
 * One line of a room's feed. `from`/`to` are agent ids; `null` means the user,
 * so a message to the user and a message from the user are both representable.
 */
export const feedEventSchema = z.object({
  id: nonEmptyText,
  roomId: nonEmptyText,
  at: timestampSchema,
  kind: feedKindSchema,
  from: z.string().nullable(),
  to: z.string().nullable(),
  label: z.string(),
  text: z.string(),
});

export type FeedEvent = z.infer<typeof feedEventSchema>;

/** The whole `rooms.json` document, versioned so a future format can be refused. */
export const roomsFileSchema = z.object({
  version: z.literal(ROOMS_FILE_VERSION),
  rooms: z.array(roomRecordSchema),
  seats: z.array(seatRecordSchema),
  feed: z.array(feedEventSchema),
});

export type RoomsFile = z.infer<typeof roomsFileSchema>;

/** Clip feed text to `FEED_TEXT_CAP`; the tail is dropped, not summarised. */
export function truncateFeedText(text: string): string {
  return text.length > FEED_TEXT_CAP ? text.slice(0, FEED_TEXT_CAP) : text;
}

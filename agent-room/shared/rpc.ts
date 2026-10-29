import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { gcActionSchema, gcStatusSchema } from "./gc";
import { feedEventSchema, roomRecordSchema, seatRecordSchema } from "./room";

const nonEmptyText = z.string().min(1);

/**
 * Start a room: create its Supervisor and return the new agent id, which is the
 * room id. The room record itself is written by the `agent.created` hook when
 * the Supervisor appears, so a launch that fails to create leaves nothing behind.
 *
 * The task reaches the Supervisor as the full prompt; only the agent title is
 * capped (Paseo titles are 60 characters).
 */
export const launchRoomRpc = defineRpc({
  name: "room.launch",
  input: z
    .object({
      task: z.string().min(1),
      workspaceId: nonEmptyText.optional(),
      cwd: nonEmptyText.optional(),
    })
    .refine((input) => input.workspaceId !== undefined || input.cwd !== undefined, {
      message: "one of workspaceId or cwd is required",
      path: ["workspaceId"],
    }),
  output: z.object({ roomId: nonEmptyText }),
});

/** Every room the store knows, newest first. */
export const listRoomsRpc = defineRpc({
  name: "room.list",
  input: z.object({}),
  output: z.object({ rooms: z.array(roomRecordSchema) }),
});

/**
 * Make an existing chat the room's Supervisor. The chat keeps its provider,
 * model, mode and effort; only the protocol and role are delivered, as a setup
 * message, because Paseo cannot set a system prompt on a live session.
 */
export const adoptRoomRpc = defineRpc({
  name: "room.adopt",
  input: z.object({ agentId: nonEmptyText }),
  output: z.object({ roomId: nonEmptyText }),
});

/**
 * One room with its seat table and feed. A room the store has never recorded —
 * or one that was pruned — reads as `missing` rather than as an error, so the
 * client can navigate away from a stale link.
 */
export const getRoomRpc = defineRpc({
  name: "room.get",
  input: z.object({ roomId: nonEmptyText }),
  output: z.union([
    z.object({
      room: roomRecordSchema,
      seats: z.array(seatRecordSchema),
      feed: z.array(feedEventSchema),
    }),
    z.object({ missing: z.literal(true) }),
  ]),
});

/**
 * The GC screen's read model: the last tick's identification verdict, when it
 * ran, when the next report is due, the settings it acted on, and the process and
 * record candidates it judged. Served from the last tick's captured result, so it
 * never runs a `ps` sample of its own; before the first tick it answers an empty
 * status carrying the settings the next tick would use.
 */
export const gcStatusRpc = defineRpc({
  name: "gc.status",
  input: z.object({}),
  output: gcStatusSchema,
});

/**
 * Run one tick now: `report` writes the sample and (when due) the report without
 * acting, `act` runs the full tick with the rules the settings enable. Neither
 * mode overrides a toggle — `act` cannot delete or signal anything a scheduled
 * tick would have refused, it only moves the tick forward.
 */
export const gcRunRpc = defineRpc({
  name: "gc.run",
  input: z.object({ mode: z.enum(["report", "act"]) }),
  output: z.array(gcActionSchema),
});

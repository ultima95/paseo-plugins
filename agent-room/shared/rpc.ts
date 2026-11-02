import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { gcActionSchema, gcStatusSchema } from "./gc";
import {
  episodeFactSchema,
  lessonSchema,
  memberRecordSchema,
  memberRoleSchema,
  memoryPolicySchema,
  pendingCandidateSchema,
} from "./member";
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
      // Omitted means "use the host seat", so existing callers keep working.
      supervisorMemberId: nonEmptyText.optional(),
      leadMemberId: nonEmptyText.optional(),
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
 * The shape a member is written with. Saving a member is a whole-record write, so
 * the seat fields are required and only the optional provider controls may be
 * omitted; `id` omitted means "create a new one".
 */
export const memberSaveInputSchema = z.object({
  id: nonEmptyText.optional(),
  name: z.string().min(1).max(60),
  role: memberRoleSchema,
  provider: nonEmptyText,
  model: nonEmptyText,
  modeId: nonEmptyText.optional(),
  thinkingOptionId: nonEmptyText.optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  memory: memoryPolicySchema,
});

/** Every member the store knows, in the store's own order (by name). */
export const memberListRpc = defineRpc({
  name: "member.list",
  input: z.object({}),
  output: z.object({ members: z.array(memberRecordSchema) }),
});

/**
 * One member with everything that belongs to it: the charter, the promoted
 * lessons, the candidates still awaiting a human, and the episodes recorded
 * across rooms. An id the store does not know reads as `missing`, like `room.get`.
 */
export const memberGetRpc = defineRpc({
  name: "member.get",
  input: z.object({ memberId: nonEmptyText }),
  output: z.union([
    z.object({
      member: memberRecordSchema,
      charter: z.string(),
      lessons: z.array(lessonSchema),
      pending: z.array(pendingCandidateSchema),
      episodes: z.array(episodeFactSchema.extend({ roomId: nonEmptyText })),
    }),
    z.object({ missing: z.literal(true) }),
  ]),
});

/**
 * Create or update a member. An omitted `id` generates one; an existing `id`
 * keeps its `createdAt` and takes a new `updatedAt`.
 */
export const memberSaveRpc = defineRpc({
  name: "member.save",
  input: memberSaveInputSchema,
  output: z.object({ member: memberRecordSchema }),
});

/** Replace a member's charter. The whole document is written, never patched. */
export const memberCharterRpc = defineRpc({
  name: "member.charter",
  input: z.object({ memberId: nonEmptyText, text: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

/**
 * Settle one pending candidate: `accept` promotes it to a lesson and returns the
 * lesson it wrote, `reject` tombstones it and returns nothing.
 */
export const memberPendingRpc = defineRpc({
  name: "member.pending",
  input: z.object({
    memberId: nonEmptyText,
    candidateId: nonEmptyText,
    action: z.enum(["accept", "reject"]),
  }),
  output: z.object({ ok: z.literal(true), lesson: lessonSchema.optional() }),
});

/**
 * The GC screen's read model: the last tick's identification verdict and daemon
 * (pid, `ps` uptime), the Paseo tree's footprint against the resolved tree warn
 * threshold, when the tick ran, when the last report was written and when the
 * next is due, the settings it acted on, the lineage ledger (row count, the
 * reader's note, and whether it could be read at all), the index verdict, the
 * newest `alerts.log` lines (with whether that file could be read), and the
 * process and record candidates it judged.
 *
 * Served from the last tick's captured result, so it never runs a `ps` sample of
 * its own; before the first tick it answers an empty status carrying the settings
 * the next tick would use, with every unmeasured field (`daemonPid`, `uptimeS`,
 * `tree`, `lastReportAt`) `null` rather than a plausible zero. Nothing in the GC's
 * rules reads this payload: it is the screen's window on a tick that already ran.
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
 *
 * A run that arrives while a tick is still running (the scheduler's, or another
 * `gc.run`) is refused, not queued: the answer is one `refuse` row with
 * `refusedBy` starting `tick-in-progress`, and no tick is started. Both paths
 * share one exclusion primitive (`createTickGate`), so two ticks can never act
 * on the same records at once.
 */
export const gcRunRpc = defineRpc({
  name: "gc.run",
  input: z.object({ mode: z.enum(["report", "act"]) }),
  output: z.array(gcActionSchema),
});

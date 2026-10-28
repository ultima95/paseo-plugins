import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";

import type { SeatRecord } from "../shared/room";
import { GUARD_ROW_KIND } from "../shared/room";
import { parseSeatMarker, seatConfigFor, type RoomSettings, type SeatMarker } from "../shared/seats";
import { feedFromTurn } from "./feed";
import { checkSpawn } from "./guard";
import type { Logger } from "./logger";
import type { RoomStore } from "./store";

/** History one `agent.turn_ended` refetches; enough to cover a turn's messages. */
export const FEED_TAIL_LIMIT = 40;

/** A guard row is also rendered inside the agent timeline (renderer in Task 8). */
export const GUARD_KIND = GUARD_ROW_KIND;

/**
 * The daemon records an agent's parent as a label on the agent
 * (`PARENT_AGENT_ID_LABEL` in `@getpaseo/protocol/agent-labels`), and repeats it
 * as `parentAgentId` in the snapshot it sends.
 */
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

export type TitleLookup = (paseo: PaseoApi, agentId: string) => Promise<string | null>;

export interface RoomEventsDeps {
  store: RoomStore;
  readSettings: () => Promise<RoomSettings>;
  lookupTitle: TitleLookup;
  log: Logger;
}

export interface RoomEvents {
  onCreated(
    event: PluginLifecycleEvents["agent.created"],
    ctx: PluginHookContext,
  ): Promise<void>;
  onTurnEnded(
    event: PluginLifecycleEvents["agent.turn_ended"],
    ctx: PluginHookContext,
  ): Promise<void>;
  onArchived(
    event: PluginLifecycleEvents["agent.archived"],
    ctx: PluginHookContext,
  ): Promise<void>;
}

/** What the parent agent looks like right now: its stored seat, else its title. */
interface ParentContext {
  /** The parent agent id; `null` for a root agent. */
  id: string | null;
  seat?: SeatRecord;
  title: string | null;
  marker: SeatMarker | null;
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Read a title straight from the daemon. Used when the parent predates the store
 * (plugin reload, daemon restart), so the guard still knows what it is talking
 * to. Never throws: an unreadable agent reads as "no title".
 */
export async function lookupTitle(paseo: PaseoApi, agentId: string): Promise<string | null> {
  try {
    const handle = paseo.agents.ref(agentId);
    await handle.refresh();
    return handle.current()?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * The marker a violator's children should have carried, or `null` when the
 * violator is a Peer (which creates no agents at all).
 */
function correctMarker(parent: SeatMarker | null): { label: string; example: string } | null {
  if (parent === null) return null;
  if (parent.seat === "supervisor") {
    return { label: "[room:lead]", example: "[room:lead] <workstream>" };
  }
  if (parent.seat === "lead") {
    return { label: "[room:peer:<tier>]", example: "[room:peer:default] <outcome>" };
  }
  return null;
}

/** One plain-text message: what was archived, the rule, the marker to use next time. */
function violationMessage(
  childId: string,
  childTitle: string,
  rule: string,
  parent: SeatMarker | null,
): string {
  const name = childTitle.trim() === "" ? "(untitled)" : childTitle;
  const lines = [
    `Your child agent "${name}" (${childId}) was archived by the room guard.`,
    `Rule broken: ${rule}.`,
  ];
  const correct = correctMarker(parent);
  lines.push(
    correct === null
      ? "A Peer creates no agents: report to your Lead instead."
      : `Create children with a title that starts with ${correct.label}, for example "${correct.example}".`,
  );
  return lines.join(" ");
}

export function createRoomEvents(deps: RoomEventsDeps): RoomEvents {
  // The object, not its methods: callers may swap a method out (tests do).
  const store = deps.store;
  const log = deps.log;

  const resolveParent = async (agent: PluginHookAgent, paseo: PaseoApi): Promise<ParentContext> => {
    const id = agent.parentAgentId;
    if (id === null) return { id: null, title: null, marker: null };

    const stored = store.seat(id);
    if (stored !== undefined) {
      return { id, seat: stored, title: stored.title, marker: stored.marker };
    }

    const title = await deps.lookupTitle(paseo, id);
    return { id, title, marker: parseSeatMarker(title)?.marker ?? null };
  };

  /**
   * The room a child belongs to. A stored parent seat knows it; a parent whose
   * title says it is a Supervisor roots a room named after itself. A Lead or Peer
   * with no stored room cannot place a child, and the caller skips the record.
   */
  const roomFor = (parent: ParentContext): string | undefined => {
    if (parent.seat !== undefined) return parent.seat.roomId;
    if (parent.marker?.seat === "supervisor" && parent.id !== null) return parent.id;
    return undefined;
  };

  const seatRecord = (
    agent: PluginHookAgent,
    roomId: string,
    marker: SeatMarker,
    model: string,
  ): SeatRecord => ({
    agentId: agent.id,
    roomId,
    parentId: agent.parentAgentId,
    marker,
    provider: agent.provider,
    model,
    title: agent.title ?? "",
  });

  /**
   * The parent the daemon holds for an agent the store never recorded. The
   * client types do not declare `parentAgentId` on a snapshot (0.13.1), so the
   * handle is refreshed and the field read off it, with the label the daemon
   * derives that field from as the fallback. Never throws: an unreadable agent
   * reads as "no known parent".
   */
  const parentIdOf = async (paseo: PaseoApi, agentId: string): Promise<string | null> => {
    try {
      const handle = paseo.agents.ref(agentId);
      await handle.refresh();
      const snapshot = handle.current() as (PaseoAgent & { parentAgentId?: string | null }) | null;
      if (snapshot === null) return null;
      return snapshot.parentAgentId ?? snapshot.labels?.[PARENT_AGENT_LABEL] ?? null;
    } catch (error) {
      log.warn("guard: could not read the violator's parent", {
        agentId,
        error: reason(error),
      });
      return null;
    }
  };

  /**
   * The agent that should see a guard row for this violation. Only a Peer's
   * mistake is its Lead's to notice, and a stored Peer names its Lead directly;
   * a Peer whose seat is missing from the store can still supply its own parent
   * id, which is the Lead. A Lead or Supervisor violator gets no row.
   */
  const leadFor = async (paseo: PaseoApi, parent: ParentContext): Promise<string | null> => {
    if (parent.marker?.seat !== "peer" || parent.id === null) return null;
    if (parent.seat !== undefined) return parent.seat.parentId;
    return parentIdOf(paseo, parent.id);
  };

  /** Archive the child, then tell the violator why and leave a trail in the room. */
  const deny = async (
    agent: PluginHookAgent,
    parent: ParentContext,
    rule: string,
    paseo: PaseoApi,
  ): Promise<void> => {
    const childId = agent.id;
    const childTitle = agent.title ?? "";
    const violatorId = parent.id;

    // `checkSpawn` only denies under a seat, so a root can never reach this.
    if (violatorId === null) {
      log.warn("guard denied a parentless create; nothing to notify", { childId, rule });
      return;
    }

    // Archive first: the message, the feed event and the room-guard row all say
    // the child is gone, so none of them may happen when it is not.
    try {
      await paseo.agents.ref(childId).archive();
    } catch (error) {
      log.error("guard: could not archive the violating agent", {
        childId,
        violatorId,
        error: reason(error),
      });
      return;
    }

    const message = violationMessage(childId, childTitle, rule, parent.marker);

    try {
      await paseo.agents.ref(violatorId).send(message);
    } catch (error) {
      log.error("guard: could not notify the violator", {
        violatorId,
        error: reason(error),
      });
    }

    const roomId = roomFor(parent);
    if (roomId === undefined) {
      // Without a room id there is no feed to append to: the stored seat that
      // would name the room is exactly what this parent is missing.
      log.warn("guard violation outside a known room", { childId, violatorId });
    } else {
      store.appendFeed({
        roomId,
        kind: "guard",
        from: violatorId,
        to: childId,
        label: "archived",
        text: message,
      });
    }

    // A Peer's mistake is its Lead's to notice, so the row lands on the Lead.
    const leadId = await leadFor(paseo, parent);
    if (leadId !== null) {
      try {
        await paseo.agents.ref(leadId).timeline.append({
          type: "plugin",
          id: `room-guard-${childId}`,
          kind: GUARD_KIND,
          version: 1,
          data: { childId, childTitle, violatorId, rule },
        });
      } catch (error) {
        log.error("guard: could not append the room-guard row", {
          leadId,
          childId,
          error: reason(error),
        });
      }
    }
  };

  const handleCreated = async (agent: PluginHookAgent, paseo: PaseoApi): Promise<void> => {
    const parent = await resolveParent(agent, paseo);
    const parsed = parseSeatMarker(agent.title);
    const marker = parsed?.marker ?? null;

    const verdict = checkSpawn(parent.marker, marker);
    if (!verdict.allowed) {
      await deny(agent, parent, verdict.rule, paseo);
      return;
    }

    // Allowed and unmarked: not a room agent, so it is never recorded.
    if (parsed === null || marker === null) return;

    const settings = await deps.readSettings();

    if (marker.seat === "supervisor") {
      // The Supervisor roots the room: it owns the room id.
      const roomId = agent.id;
      store.addRoom({
        id: roomId,
        task: parsed.rest,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        createdAt: new Date().toISOString(),
      });
      store.addSeat(seatRecord(agent, roomId, marker, seatConfigFor(marker, settings).config.model));
      return;
    }

    const roomId = roomFor(parent);
    if (roomId === undefined) {
      log.warn("cannot place seat: parent has no room", {
        agentId: agent.id,
        parentId: parent.id,
      });
      return;
    }

    const { config, fallbackFrom } = seatConfigFor(marker, settings);
    store.addSeat(seatRecord(agent, roomId, marker, config.model));

    if (fallbackFrom !== undefined) {
      // The marker stays as parsed; only the model came from `default`.
      store.appendFeed({
        roomId,
        kind: "note",
        from: null,
        to: agent.id,
        label: "tier fallback",
        text: `Tier "${fallbackFrom}" is not configured; using the "default" tier (${config.provider}/${config.model}).`,
      });
      log.warn("unknown peer tier; seated on the default tier", {
        agentId: agent.id,
        tier: fallbackFrom,
      });
    }
  };

  const handleTurnEnded = async (agent: PluginHookAgent, paseo: PaseoApi): Promise<void> => {
    const seat = store.seat(agent.id);
    if (seat === undefined) return;

    // `event.timeline` is deprecated and always empty in 0.13.1: refetch instead.
    const page = await paseo.agents
      .ref(agent.id)
      .timeline.refetch({ direction: "tail", limit: FEED_TAIL_LIMIT });

    const timeline = (page?.entries ?? []).map((entry) => entry.item);
    const childIds = store.children(agent.id).map((child) => child.agentId);

    for (const draft of feedFromTurn({ agent: seat, childIds, timeline })) {
      store.appendFeed({ roomId: seat.roomId, ...draft });
    }
  };

  const handleArchived = async (agent: PluginHookAgent): Promise<void> => {
    // Only the room's root closes the room; a Lead or Peer leaving does not.
    if (store.room(agent.id) === undefined) return;
    store.endRoom(agent.id);
  };

  return {
    async onCreated(event, ctx) {
      try {
        await handleCreated(event.agent, ctx.paseo);
      } catch (error) {
        log.error("agent.created handling failed", {
          agentId: event.agent.id,
          error: reason(error),
        });
      }
    },

    async onTurnEnded(event, ctx) {
      try {
        await handleTurnEnded(event.agent, ctx.paseo);
      } catch (error) {
        log.error("agent.turn_ended handling failed", {
          agentId: event.agent.id,
          error: reason(error),
        });
      }
    },

    async onArchived(event, ctx) {
      try {
        await handleArchived(event.agent);
      } catch (error) {
        log.error("agent.archived handling failed", {
          agentId: event.agent.id,
          error: reason(error),
        });
      }
    },
  };
}

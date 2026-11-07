import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";

import type { MemberRecord, MemberRole } from "../shared/member";
import type { FeedEvent, SeatRecord } from "../shared/room";
import { GUARD_ROW_KIND, GUARD_ROW_VERSION } from "../shared/room";
import { parseRoleTitle, roleForLegacyMarker, type Role, type RoomSettings } from "../shared/roles";
import { parseSeatMarker, type SeatMarker } from "../shared/seats";
import { candidatesFromFacts, episodeFactFor, redactSecrets } from "./episode";
import { feedFromTurn } from "./feed";
import { checkSpawn } from "./guard";
import type { Logger } from "./logger";
import type { MemberStore } from "./member-store";
import { applyPromotion } from "./promotion";
import { auditAcceptance, verdictsIn, verdictUpgrades } from "./record";
import { renderMemberSection } from "./render";
import { candidateScope, scopesFor } from "./scope";
import type { RoomStore } from "./store";

/** History one `agent.turn_ended` refetches; enough to cover a turn's messages. */
export const FEED_TAIL_LIMIT = 40;

/**
 * How much of the room's task the closing outcome fact keeps. A fact is member
 * memory that is read back for years, so it stays a summary, not a transcript.
 */
export const OUTCOME_TEXT_CAP = 400;

/** A guard row is also rendered inside the agent timeline (renderer in Task 8). */
export const GUARD_KIND = GUARD_ROW_KIND;

/** How a member section that had to drop charter or lessons is recorded. */
export const MEMBER_TRUNCATED_NOTE = "member section truncated";

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
  /** The members a room's seats can be bound to; supplies a seat's real model. */
  members: MemberStore;
  /** The repository identity of a directory, or null outside a repository. */
  repoIdFor: (cwd: string) => Promise<string | null>;
  /** The clock a promoted lesson is stamped with; `Date.now` in production. */
  now?: () => number;
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

/** What the parent agent looks like right now: its stored seat and its role. */
interface ParentContext {
  /** The parent agent id; `null` for a root agent. */
  id: string | null;
  seat?: SeatRecord;
  title: string | null;
  role: Role | null;
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The role a stored id names, or `null` when the catalog no longer lists it. */
function roleById(id: string, roles: readonly Role[]): Role | null {
  return roles.find((role) => role.id === id) ?? null;
}

/**
 * The role a title names: a role title first (`Lead: billing`), then the legacy
 * `[room:…]` marker an in-flight room was created with. `null` for a title that
 * names neither, which is an agent the room does not manage.
 */
function roleFromTitle(title: string | null, settings: RoomSettings): Role | null {
  const parsed = parseRoleTitle(title, settings.roles);
  if (parsed !== null) return parsed.role;
  const legacy = parseSeatMarker(title);
  return legacy === null ? null : roleForLegacyMarker(legacy.marker, settings.roles).role;
}

/**
 * A role rebuilt from the seat that recorded it. The guard must keep enforcing a
 * hierarchy even when the settings stopped listing a role: the seat knows what
 * its agent was, so a parent never silently becomes unmanaged.
 */
function roleFromSeat(seat: SeatRecord): Role | null {
  if (seat.roleId === undefined || seat.roleName === undefined || seat.roleKind === undefined) {
    return null;
  }
  return {
    id: seat.roleId,
    name: seat.roleName,
    kind: seat.roleKind,
    provider: seat.provider,
    model: seat.model,
    useFor: seat.roleName,
  };
}

/**
 * The parent's role: stored role by id, then the role fields the seat recorded,
 * then — last — the role its title names.
 *
 * What the seat recorded outranks its title because the title is what the user
 * sees, not what the agent was launched as: a seat the user retitles
 * `Supervisor: …` must not turn a Lead into a Supervisor, or the guard stops
 * archiving the children a Lead may not have. The title is only the last resort,
 * for a seat recorded before roles existed (a bare legacy marker).
 */
function parentRole(seat: SeatRecord, settings: RoomSettings): Role | null {
  const stored = seat.roleId === undefined ? null : roleById(seat.roleId, settings.roles);
  return stored ?? roleFromSeat(seat) ?? roleFromTitle(seat.title, settings);
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

/** One plain-text message: what was archived and the rule it broke. */
function violationMessage(childId: string, childTitle: string, rule: string): string {
  const name = childTitle.trim() === "" ? "(untitled)" : childTitle;
  // The rule itself names the role the child should have been titled with.
  return `Your child agent "${name}" (${childId}) was archived by the room guard. Rule broken: ${rule}.`;
}

export function createRoomEvents(deps: RoomEventsDeps): RoomEvents {
  // The object, not its methods: callers may swap a method out (tests do).
  const store = deps.store;
  const log = deps.log;
  const now = deps.now ?? (() => Date.now());

  const resolveParent = async (
    agent: PluginHookAgent,
    paseo: PaseoApi,
    settings: RoomSettings,
  ): Promise<ParentContext> => {
    const id = agent.parentAgentId;
    if (id === null) return { id: null, title: null, role: null };

    const stored = store.seat(id);
    if (stored !== undefined) {
      return { id, seat: stored, title: stored.title, role: parentRole(stored, settings) };
    }

    const title = await deps.lookupTitle(paseo, id);
    return { id, title, role: roleFromTitle(title, settings) };
  };

  /**
   * The room a child belongs to. A stored parent seat knows it; a parent whose
   * role says it is a Supervisor roots a room named after itself. A Lead or worker
   * with no stored room cannot place a child, and the caller skips the record.
   */
  const roomFor = (parent: ParentContext): string | undefined => {
    if (parent.seat !== undefined) return parent.seat.roomId;
    if (parent.role?.kind === "supervisor" && parent.id !== null) return parent.id;
    return undefined;
  };

  /**
   * The member whose seat an agent is on, if the room bound one. `agent.created`
   * carries no model (`PluginHookAgent` has none), so a member-seated Supervisor's
   * real model can only come from the member `room.launch` bound to the room.
   *
   * The provider is the check: a launch that names a member runs that member's
   * provider and model, so an agent whose provider differs from the bound
   * member's was created on the catalog role instead, and the member would be a
   * lie. Workers are never members.
   */
  const boundMember = (
    roomId: string,
    kind: Role["kind"],
    provider: string,
  ): MemberRecord | undefined => {
    if (kind !== "supervisor" && kind !== "lead") return undefined;
    const found = store.room(roomId);
    if (found === undefined) return undefined;
    const memberId =
      kind === "supervisor" ? found.room.supervisorMemberId : found.room.leadMemberId;
    if (memberId === null) return undefined;
    const candidate = deps.members.get(memberId);
    if (candidate === undefined || candidate.provider !== provider) return undefined;
    return candidate;
  };

  /** The seat a new agent is recorded with: its role, plus a legacy marker if any. */
  const seatRecord = (
    agent: PluginHookAgent,
    roomId: string,
    role: Role,
    legacy: { marker: SeatMarker } | null,
  ): SeatRecord => ({
    agentId: agent.id,
    roomId,
    parentId: agent.parentAgentId,
    roleId: role.id,
    roleName: role.name,
    roleKind: role.kind,
    ...(legacy !== null ? { marker: legacy.marker } : {}),
    provider: agent.provider,
    // What actually runs: the bound member's seat when there is one, else the
    // catalog role's.
    model: boundMember(roomId, role.kind, agent.provider)?.model ?? role.model,
    title: agent.title ?? "",
  });

  /**
   * Leave one `member note` in the room when the seat's member section had to
   * drop charter or lesson content. `room.launch` renders the same section for a
   * Supervisor and notes it itself; the room keeps one row, not two.
   */
  const noteMemberTruncation = async (
    agent: PluginHookAgent,
    roomId: string,
    role: Role,
  ): Promise<void> => {
    const member = boundMember(roomId, role.kind, agent.provider);
    if (member === undefined) return;
    const found = store.room(roomId);
    if (found === undefined) return;

    const repoId = await deps.repoIdFor(agent.cwd);
    const section = renderMemberSection({
      name: member.name,
      charter: deps.members.charter(member.id),
      lessons: deps.members.lessonsFor(member.id, scopesFor(agent.cwd, repoId)),
    });
    if (!section.truncated) return;

    const noted = found.feed.some(
      (event) => event.label === "member note" && event.text === MEMBER_TRUNCATED_NOTE,
    );
    if (noted) return;

    store.appendFeed({
      roomId,
      kind: "note",
      from: null,
      to: member.id,
      label: "member note",
      text: MEMBER_TRUNCATED_NOTE,
    });
  };

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
   * The agent that should see a guard row for this violation. Only a worker's
   * mistake is its Lead's to notice, and a stored worker names its Lead directly;
   * a worker whose seat is missing from the store can still supply its own parent
   * id, which is the Lead. A Lead or Supervisor violator gets no row.
   */
  const leadFor = async (paseo: PaseoApi, parent: ParentContext): Promise<string | null> => {
    if (parent.role?.kind !== "worker" || parent.id === null) return null;
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

    const message = violationMessage(childId, childTitle, rule);

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
          version: GUARD_ROW_VERSION,
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
    const settings = await deps.readSettings();
    const parent = await resolveParent(agent, paseo, settings);

    // A role title is the grammar; a legacy marker is read for one release so an
    // in-flight room keeps working, and resolves to the role it maps to.
    const parsed = parseRoleTitle(agent.title, settings.roles);
    const legacy = parsed === null ? parseSeatMarker(agent.title) : null;
    const resolved: { role: Role; fallbackFrom?: string } | null =
      parsed !== null
        ? { role: parsed.role }
        : legacy !== null
          ? roleForLegacyMarker(legacy.marker, settings.roles)
          : null;
    const role = resolved?.role ?? null;

    const verdict = checkSpawn(parent.role, role, settings.roles);
    if (!verdict.allowed) {
      await deny(agent, parent, verdict.rule, paseo);
      return;
    }

    // Allowed with no role: not a room agent, so it is never recorded.
    if (role === null) return;

    const task = parsed !== null ? parsed.rest : (legacy?.rest ?? "");

    if (role.kind === "supervisor") {
      // The Supervisor roots the room: it owns the room id.
      const roomId = agent.id;
      store.addRoom({
        id: roomId,
        task,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        supervisorMemberId: null,
        leadMemberId: null,
        createdAt: new Date().toISOString(),
      });
      store.addSeat(seatRecord(agent, roomId, role, legacy));
      await noteMemberTruncation(agent, roomId, role);
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

    store.addSeat(seatRecord(agent, roomId, role, legacy));
    await noteMemberTruncation(agent, roomId, role);

    // Orchestration is visible: a Lead is one task dispatched in parallel, so
    // the room feed gets its own row instead of hiding the dispatch in the
    // role tree. The guard still owns the rule; this is the record of it.
    if (role.kind === "lead") {
      store.appendFeed({
        roomId,
        kind: "note",
        from: parent.id,
        to: agent.id,
        label: "dispatch",
        text: `${role.name}: ${task.trim().length > 0 ? task.trim() : "(untitled)"}`,
      });
    }

    const fallbackFrom = resolved?.fallbackFrom;
    if (fallbackFrom !== undefined) {
      // The legacy marker stays as parsed; only the role came from the fallback.
      store.appendFeed({
        roomId,
        kind: "note",
        from: null,
        to: agent.id,
        label: "tier fallback",
        text: `Legacy tier "${fallbackFrom}" is not a configured role; using the "${role.name}" role (${role.provider}/${role.model}).`,
      });
      log.warn("unknown legacy peer tier; using a worker role", {
        agentId: agent.id,
        tier: fallbackFrom,
        roleId: role.id,
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

    // Only a Supervisor and a Lead keep memory, and only into the member their
    // room bound to that seat. An unbound room (or a worker, which has no slot)
    // records the turn in the feed and leaves member memory alone.
    const room = store.room(seat.roomId)?.room;
    const memberId =
      room === undefined
        ? null
        : seat.roleKind === "supervisor"
          ? room.supervisorMemberId
          : seat.roleKind === "lead"
            ? room.leadMemberId
            : null;

    // A binding can outlive its member: the archive path checks, and so must this
    // one, or the turn leaves an episode in a file nothing will ever read. The
    // lookup is lazy and memoised, so a turn with no signal pays nothing and a
    // missing member costs one warning rather than a feed row per turn.
    let memberPresent: boolean | null = null;
    const memberExists = (id: string): boolean => {
      if (memberPresent === null) {
        memberPresent = deps.members.get(id) !== undefined;
        if (!memberPresent) {
          log.warn("member missing; captured no episode", {
            memberId: id,
            roomId: seat.roomId,
            agentId: agent.id,
          });
        }
      }
      return memberPresent;
    };

    // The room before this turn: an `owner-accepted` claim may only be vouched
    // for by a Human turn the room already recorded, and a verdict change may
    // only be judged against a row that was there before this turn wrote one.
    const feedBefore = store.room(seat.roomId)?.feed ?? [];
    const storedTurn: FeedEvent[] = [];

    for (const draft of feedFromTurn({ agent: seat, childIds, timeline })) {
      const stored = store.appendFeed({ roomId: seat.roomId, ...draft });
      storedTurn.push(stored);
      if (memberId === null) continue;
      // Only the seat's own reply is member memory. A user, task or instruction
      // row can open with a signal word (`REJECT: …`) without being the seat's
      // decision, and a fact taken from it would put the user's words in the
      // member's mouth.
      if (stored.from !== agent.id) continue;
      // The signal decides: only the five the protocol carries become facts.
      const captured = episodeFactFor(stored, seat.roleKind);
      if (captured === null) continue;
      // The room's feed row above is already the record of this turn, so a
      // missing member only skips the memory write.
      if (!memberExists(memberId)) continue;
      if (captured.redactions > 0) {
        log.warn("redacted secrets in member memory", {
          memberId,
          roomId: seat.roomId,
          redactions: captured.redactions,
        });
      }
      await deps.members.appendEpisode(memberId, seat.roomId, captured.fact);
    }

    // Record integrity is the room's job, not the seat's goodwill. A Lead whose
    // goal is a green report can rewrite a row or attribute an acceptance nobody
    // gave; both are caught here and made loud in the feed, without blocking the
    // turn.
    // A seat recorded before roles carries a marker instead of `roleKind`; read
    // it so an in-flight legacy room gets the same audit. A worker is never
    // audited: its claim belongs to its Lead.
    const auditKind =
      seat.roleKind ??
      (seat.marker?.seat === "supervisor" || seat.marker?.seat === "lead"
        ? seat.marker.seat
        : seat.marker?.seat === "peer"
          ? "worker"
          : undefined);
    if (auditKind !== "supervisor" && auditKind !== "lead") return;
    const own = storedTurn.filter((event) => event.from === agent.id).at(-1);
    if (own === undefined) return;

    // The Human's utterance can arrive in the same turn the seat echoes it, so
    // the audit sees this turn's incoming rows too. The seat's own reply is
    // excluded: a claim cannot vouch for itself.
    const auditFeed = [
      ...feedBefore,
      ...storedTurn.filter((event) => event.from !== agent.id),
    ];

    for (const audit of auditAcceptance({
      text: own.text,
      feed: auditFeed,
      role: auditKind,
    })) {
      if (audit.verified) continue;
      const work = audit.work === null ? "the work" : `"${audit.work}"`;
      store.appendFeed({
        roomId: seat.roomId,
        kind: "note",
        from: agent.id,
        to: null,
        label: "attribution",
        text: `owner-accepted is not traceable to a recorded Human turn for ${work}; recorded ${audit.recorded}.`,
      });
    }

    const earlierVerdicts = [...feedBefore]
      .reverse()
      .find(
        (event) =>
          event.kind === "message" && event.from === agent.id && verdictsIn(event.text).length > 0,
      );
    if (earlierVerdicts === undefined) return;

    for (const change of verdictUpgrades(earlierVerdicts.text, own.text)) {
      store.appendFeed({
        roomId: seat.roomId,
        kind: "note",
        from: agent.id,
        to: null,
        label: "verdict change",
        text: `${change.work}: ${change.from} → ${change.to} with no new candidate or walk; record it as ${change.from} with a disposition, never a silent PASS.`,
      });
    }
  };

  /**
   * What a closed room leaves in a member's memory: the task it ended on. The
   * task is the user's own words and memory is read back for years, so an
   * obvious credential is stripped here as strictly as on the turn-end path
   * (spec §9: redaction happens before any memory line is written). Redaction
   * runs first: capping first could cut a token down to a shape no pattern
   * matches, which would leave the front half of a key in memory.
   */
  const outcomeText = (task: string, roomId: string): { text: string; redactions: number } => {
    const named = task.trim().length > 0 ? task.trim() : roomId;
    const redacted = redactSecrets(`room ended: ${named}`);
    return { text: redacted.text.slice(0, OUTCOME_TEXT_CAP), redactions: redacted.redactions };
  };

  const handleArchived = async (agent: PluginHookAgent, archivedAt: string): Promise<void> => {
    // Only the room's root closes the room; a Lead or Peer leaving does not.
    const found = store.room(agent.id);
    if (found === undefined) return;
    store.endRoom(agent.id);

    // One scope for the whole room, derived once: every member it bound promotes
    // into the repository (or workspace) their seats share.
    const repoId = await deps.repoIdFor(found.room.cwd);
    const scope = candidateScope(found.room.cwd, repoId);

    const bindings: Array<[string | null, MemberRole]> = [
      [found.room.supervisorMemberId, "supervisor"],
      [found.room.leadMemberId, "lead"],
    ];

    for (const [memberId, role] of bindings) {
      if (memberId === null) continue;

      const member = deps.members.get(memberId);
      if (member === undefined) {
        // The binding outlived its member: say so in the room rather than write
        // memory nothing will ever read.
        store.appendFeed({
          roomId: found.room.id,
          kind: "note",
          from: null,
          to: memberId,
          label: "member missing",
          text: `member missing: ${memberId} (${role}); memory was not written`,
        });
        continue;
      }

      const outcome = outcomeText(found.room.task, found.room.id);
      if (outcome.redactions > 0) {
        log.warn("redacted secrets in member memory", {
          memberId,
          roomId: found.room.id,
          redactions: outcome.redactions,
        });
      }

      await deps.members.appendEpisode(memberId, found.room.id, {
        at: archivedAt,
        kind: "outcome",
        text: outcome.text,
      });

      // Only this room's facts: a member's memory spans every room it sat in.
      const facts = (await deps.members.episodes(memberId)).filter(
        (fact) => fact.roomId === found.room.id,
      );
      const candidates = candidatesFromFacts(facts, { scope, sourceRoomId: found.room.id });
      await applyPromotion({ members: deps.members, member, candidates, now, log });
    }
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
        await handleArchived(event.agent, event.archivedAt);
      } catch (error) {
        log.error("agent.archived handling failed", {
          agentId: event.agent.id,
          error: reason(error),
        });
      }
    },
  };
}

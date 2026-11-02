import type { MemberRecord } from "../shared/member";
import type { FeedEvent, RoomRecord, SeatRecord } from "../shared/room";
import { parseRoomStatusMessage, roomStatusLine } from "../shared/room-status";

/** One tree row: the seat and how far to indent it from the root. */
export interface TreeNode {
  seat: SeatRecord;
  depth: number;
}

/** One feed row, already labelled and time-stamped for display. */
export interface FeedRow {
  id: string;
  /** Local `HH:MM`, or the raw `at` when it is not a date. */
  time: string;
  fromLabel: string;
  toLabel: string;
  label: string;
  text: string;
  kind: FeedEvent["kind"];
}

/** Letters an agent id falls back to when no seat claims it. */
const UNKNOWN_ID_PREFIX = 8;

/** A seat that carries neither a role nor a legacy marker still needs a name. */
const UNNAMED_SEAT = "Agent";

/**
 * Feed labels are abbreviated: they sit in a narrow column. A role seat is
 * labelled by its role name, except the supervisor, which is always `Sup`
 * whatever its role is called; a seat recorded before roles keeps the marker
 * label it has always had.
 */
function feedLabel(seat: SeatRecord): string {
  const roleName = seat.roleName;
  if (roleName !== undefined) {
    return seat.roleKind === "supervisor" ? "Sup" : roleName;
  }

  const marker = seat.marker;
  if (marker === undefined) return UNNAMED_SEAT;
  switch (marker.seat) {
    case "supervisor":
      return "Sup";
    case "lead":
      return "Lead";
    case "peer":
      return `Peer:${marker.tier}`;
  }
}

/** The tree has room for the full seat name: the role name, or the marker. */
export function seatName(seat: SeatRecord): string {
  if (seat.roleName !== undefined) return seat.roleName;

  const marker = seat.marker;
  if (marker === undefined) return UNNAMED_SEAT;
  switch (marker.seat) {
    case "supervisor":
      return "Supervisor";
    case "lead":
      return "Lead";
    case "peer":
      return `Peer:${marker.tier}`;
  }
}

/** The member names a room is bound to, one slot per bindable role. */
export interface MemberChip {
  supervisor: string | null;
  lead: string | null;
}

/**
 * The names of the members a room was launched on.
 *
 * A room launched on the host seats carries no member ids, and a member the
 * store no longer has cannot be named: both read as `null`, so a caller can
 * tell "no member" from a member with an empty name (which the record schema
 * forbids anyway).
 */
export function memberChip(room: RoomRecord, members: readonly MemberRecord[]): MemberChip {
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (members.find((member) => member.id === id)?.name ?? null);
  return { supervisor: nameOf(room.supervisorMemberId), lead: nameOf(room.leadMemberId) };
}

/**
 * The member behind one seat of the tree.
 *
 * Only the two seats a room binds can have a member: a worker seat is launched
 * by a Lead and stands for no member of its own. A seat recorded before roles
 * existed has no `roleKind`, so it resolves to nothing rather than guessing.
 */
export function memberNameForSeat(
  seat: Pick<SeatRecord, "roleKind">,
  room: RoomRecord,
  members: readonly MemberRecord[],
): string | null {
  if (seat.roleKind === "supervisor") return memberChip(room, members).supervisor;
  if (seat.roleKind === "lead") return memberChip(room, members).lead;
  return null;
}

/**
 * The room as a depth-first tree, root first.
 *
 * The tree is the delegation graph, so a seat is drawn under the agent that
 * created it. A seat whose parent is not in the table — pruned, or created
 * before its parent was recorded — cannot be dropped: it is drawn as a second
 * root at depth 0, after the real root's subtree, and its own children follow
 * it. Anything still unreached (a parent cycle, or a room with no root at all)
 * gets the same treatment, so every seat on screen has exactly one row and
 * nothing is silently lost.
 */
export function buildTree(seats: SeatRecord[]): TreeNode[] {
  const known = new Set(seats.map((seat) => seat.agentId));
  const children = new Map<string, SeatRecord[]>();
  const rooted: SeatRecord[] = [];
  const parentless: SeatRecord[] = [];

  for (const seat of seats) {
    const parentId = seat.parentId;
    if (parentId === null) {
      rooted.push(seat);
      continue;
    }
    if (!known.has(parentId)) {
      parentless.push(seat);
      continue;
    }
    const siblings = children.get(parentId);
    if (siblings === undefined) {
      children.set(parentId, [seat]);
    } else {
      siblings.push(seat);
    }
  }

  const rows: TreeNode[] = [];
  // An array, not a Set: the audit that keeps this file React Native-only also
  // rejects generic type arguments, and a room is a handful of seats.
  const drawn: string[] = [];

  const draw = (seat: SeatRecord, depth: number): void => {
    // A duplicate id or a cycle would otherwise recurse forever.
    if (drawn.includes(seat.agentId)) return;
    drawn.push(seat.agentId);
    rows.push({ seat, depth });
    for (const child of children.get(seat.agentId) ?? []) {
      draw(child, depth + 1);
    }
  };

  for (const root of rooted) {
    draw(root, 0);
  }
  // A seat whose parent is missing cannot be hung under anything, so it becomes
  // its own root — after the real root's subtree, never before it.
  for (const seat of parentless) {
    draw(seat, 0);
  }
  // Depth-first from every root leaves a rootless cycle unreachable.
  for (const seat of seats) {
    if (!drawn.includes(seat.agentId)) draw(seat, 0);
  }

  return rows;
}

/**
 * Local 24-hour `HH:MM`, padded. A runtime without locale data is irrelevant.
 * Exported because the rooms popover stamps its rows with the same clock.
 */
export function timeOfDay(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * A message as the feed shows it. A room-state fence is a card in the agent
 * timeline and is rewritten here as one plain line per card, because the feed
 * renders text without markdown and the raw fence and `**` markers would be
 * noise.
 */
function feedText(text: string): string {
  const parsed = parseRoomStatusMessage(text);
  if (parsed === null) return text;
  const lines = parsed.cards.map(roomStatusLine);
  if (parsed.terminal !== null) {
    const label = parsed.terminal.kind === "done" ? "✅ Done" : "❓ Waiting on you";
    lines.push(`${label} — ${parsed.terminal.text}`);
  }
  return [parsed.before, lines.join("\n"), parsed.after]
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * The feed in the order the store keeps it (chronological), with each agent id
 * replaced by the label of the seat that owns it. `null` is the user, so a task
 * the user sent reads `You → Sup`; an id with no seat is shown by its prefix
 * rather than dropped, because a room should never hide traffic.
 */
export function feedRows(feed: FeedEvent[], seats: SeatRecord[]): FeedRow[] {
  const labels = new Map<string, string>();
  for (const seat of seats) {
    labels.set(seat.agentId, feedLabel(seat));
  }

  const labelOf = (agentId: string | null): string => {
    if (agentId === null) return "You";
    return labels.get(agentId) ?? agentId.slice(0, UNKNOWN_ID_PREFIX);
  };

  return feed.map((event) => ({
    id: event.id,
    time: timeOfDay(event.at),
    fromLabel: labelOf(event.from),
    toLabel: labelOf(event.to),
    label: event.label,
    text: feedText(event.text),
    kind: event.kind,
  }));
}

import type { FeedEvent, SeatMarkerRecord, SeatRecord } from "../shared/room";

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

/** Feed labels are abbreviated: they sit in a narrow column. */
function feedLabel(marker: SeatMarkerRecord): string {
  switch (marker.seat) {
    case "supervisor":
      return "Sup";
    case "lead":
      return "Lead";
    case "peer":
      return `Peer:${marker.tier}`;
  }
}

/** The tree has room for the full seat name. */
export function seatName(marker: SeatMarkerRecord): string {
  switch (marker.seat) {
    case "supervisor":
      return "Supervisor";
    case "lead":
      return "Lead";
    case "peer":
      return `Peer:${marker.tier}`;
  }
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

/** Local 24-hour `HH:MM`, padded. A runtime without locale data is irrelevant. */
function timeOfDay(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
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
    labels.set(seat.agentId, feedLabel(seat.marker));
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
    text: event.text,
    kind: event.kind,
  }));
}

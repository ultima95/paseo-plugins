import type { SeatMarker } from "../shared/seats";

/** What a parent seat may create. The guard is the enforcement half of the protocol. */
export type SpawnVerdict = { allowed: true } | { allowed: false; rule: string };

/** Told to the violator and written to the room feed, so it names the marker it wanted. */
const RULES = {
  supervisor: "a [room:supervisor] may only create [room:lead] agents",
  lead: "a [room:lead] may only create [room:peer:<tier>] agents",
  peer: "a [room:peer:<tier>] creates no agents",
} as const;

/**
 * Decide whether `parent` may spawn `child`. A `null` parent is not a room seat,
 * so the agent is unmanaged and every child it creates is allowed — the guard
 * only ever judges traffic inside a room. A `null` child under a seat carries no
 * role, so it is denied (the user's ruling: an unmarked child of a room seat is
 * archived).
 */
export function checkSpawn(parent: SeatMarker | null, child: SeatMarker | null): SpawnVerdict {
  if (parent === null) return { allowed: true };

  switch (parent.seat) {
    case "supervisor":
      return child?.seat === "lead" ? { allowed: true } : { allowed: false, rule: RULES.supervisor };
    case "lead":
      return child?.seat === "peer" ? { allowed: true } : { allowed: false, rule: RULES.lead };
    case "peer":
      return { allowed: false, rule: RULES.peer };
  }
}

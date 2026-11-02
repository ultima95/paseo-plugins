import { AGENT_TITLE_MAX_LENGTH } from "./roles";

/**
 * The legacy `[room:…]` marker. Room agents are titled with role names now
 * (`Lead: <text>`); this reader stays for one release so an in-flight room
 * created before the change keeps working.
 */
export type SeatMarker = { seat: "supervisor" } | { seat: "lead" } | { seat: "peer"; tier: string };

/**
 * The marker must be anchored at the start of the (trimmed) title, so a title
 * that merely mentions a marker mid-sentence is left alone.
 */
const MARKER_PATTERN = /^\[room:(supervisor|lead|peer(?::([a-z0-9-]+))?)\]\s*/i;
const DEFAULT_TIER_ID = "default";

/**
 * Read the seat marker off an agent title. Returns `null` when the title carries
 * no marker, or when the marker is malformed (unknown seat): such agents are
 * unmanaged and must never be touched.
 */
export function parseSeatMarker(
  title: string | null | undefined,
): { marker: SeatMarker; rest: string } | null {
  if (!title) return null;

  const trimmed = title.trim();
  const match = MARKER_PATTERN.exec(trimmed);
  if (!match) return null;

  const rest = trimmed.slice(match[0].length);
  const seat = match[1]!.toLowerCase();

  if (seat === "supervisor") return { marker: { seat: "supervisor" }, rest };
  if (seat === "lead") return { marker: { seat: "lead" }, rest };

  const tier = (match[2] ?? DEFAULT_TIER_ID).toLowerCase();
  return { marker: { seat: "peer", tier }, rest };
}

/** Render a marker back to the exact token legacy titles carry. */
export function formatMarker(marker: SeatMarker): string {
  switch (marker.seat) {
    case "supervisor":
      return "[room:supervisor]";
    case "lead":
      return "[room:lead]";
    case "peer":
      return `[room:peer:${marker.tier}]`;
  }
}

/** Build a titled agent name: marker first, then the trimmed text, capped at 60. */
export function seatTitle(marker: SeatMarker, text: string): string {
  return `${formatMarker(marker)} ${text.trim()}`.slice(0, AGENT_TITLE_MAX_LENGTH);
}

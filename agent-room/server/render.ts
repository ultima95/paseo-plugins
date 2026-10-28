import { formatMarker, seatConfigFor, type RoomSettings, type SeatMarker } from "../shared/seats";

import { PROMPTS } from "./prompts/generated";

/** The seat rules are the last thing a seat reads, so they stay in view. */
const SEAT_TABLE_HEADING = "## Room seats";

function code(value: string): string {
  return `\`${value}\``;
}

function providerModel(provider: string, model: string): string {
  return code(`${provider}/${model}`);
}

/** Keep a settings-supplied `useFor` inside its table cell. */
function tableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

const ROLE_PROMPTS = {
  supervisor: PROMPTS.supervisor,
  lead: PROMPTS.lead,
  peer: PROMPTS.peer,
} as const;

/**
 * What this seat may create, and on which seat. The plugin forces the seat's
 * provider, model, mode and thinking level from the title marker, so the table
 * is the whole routing rule a seat needs.
 */
export function renderSeatTable(marker: SeatMarker, settings: RoomSettings): string {
  switch (marker.seat) {
    case "supervisor": {
      const lead = settings.lead;
      return [
        SEAT_TABLE_HEADING,
        "",
        "You create Leads, and nothing else. Every Lead is titled `[room:lead] <workstream>`; the marker selects the Lead seat, so never title a Lead without it.",
        "",
        "| Seat you create | Title marker | Provider / model |",
        "|---|---|---|",
        `| Lead | ${code(formatMarker({ seat: "lead" }))} | ${providerModel(lead.provider, lead.model)} |`,
        "",
        "Never launch a Peer directly, and never launch an agent whose title carries no marker: an unmarked child of a room seat is archived by the room guard.",
      ].join("\n");
    }
    case "lead": {
      const rows = settings.peerTiers.map(
        (tier) =>
          `| ${tier.id} | ${code(formatMarker({ seat: "peer", tier: tier.id }))} | ${providerModel(tier.provider, tier.model)} | ${tableCell(tier.useFor)} |`,
      );
      return [
        SEAT_TABLE_HEADING,
        "",
        "You create Peers, and nothing else. Every Peer is titled `[room:peer:<tier>] <bounded outcome>` with a tier from this table; the marker selects the seat, so never title a Peer without it.",
        "",
        "| Tier | Title marker | Provider / model | Use for |",
        "|---|---|---|---|",
        ...rows,
        "",
        "A tier that is not in this table does not exist. Leave `settings` off the `create_agent` call: the seat sets mode and thinking level itself.",
      ].join("\n");
    }
    case "peer": {
      const { config, fallbackFrom } = seatConfigFor(marker, settings);
      const seat = providerModel(config.provider, config.model);
      const tierLine =
        fallbackFrom === undefined
          ? `- your tier: ${code(marker.tier)} (${seat})`
          : `- your tier: ${code(marker.tier)} — not a configured tier; the room runs this seat on the ${code("default")} tier (${seat})`;
      return [SEAT_TABLE_HEADING, "", tierLine, "- you create no agents"].join("\n");
    }
  }
}

/**
 * The seat's system prompt: the shared protocol, its own role, then the seat
 * table. An existing system prompt is kept in front of all of it rather than
 * replaced.
 */
export function renderSystemPrompt(
  marker: SeatMarker,
  settings: RoomSettings,
  existing?: string,
): string {
  const parts = [
    existing ?? "",
    PROMPTS.protocol,
    ROLE_PROMPTS[marker.seat],
    renderSeatTable(marker, settings),
  ];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

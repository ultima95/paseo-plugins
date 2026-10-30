import { z } from "zod";

/**
 * The fenced block the Supervisor writes its room-state block into, and the
 * kind/version of the timeline row the client renders for it. Both sides read
 * them from here: the prompt names the fence, the transformer parses it, and
 * the renderer is registered under the kind, so a rename on one side must not
 * leave the other silently rendering nothing.
 *
 * The fence is also the fallback: a host without the plugin shows the rows as
 * preformatted text, which is readable, instead of leaking a JSON payload.
 */
export const ROOM_STATUS_FENCE = "room-status";
export const ROOM_STATUS_KIND = "room-status";
export const ROOM_STATUS_VERSION = 1;

/** One `**<name>** — `<state>`` card and its optional detail line. */
export type RoomStatusCard = {
  name: string;
  state: string;
  detail?: string;
  peers: string[];
  waitingOn?: string;
  elapsed?: string;
};

/** The single row a finished or blocked turn ends on. */
export type RoomStatusTerminal = {
  kind: "done" | "waiting";
  text: string;
};

/**
 * One assistant message, split around its status fence. `before`/`after` keep
 * the rest of the reply so the renderer shows the prose as it was written, and
 * the cards/terminal are the part drawn natively.
 *
 * These are type aliases, not interfaces, on purpose: the transformer hands
 * this object to Paseo as a `JsonValue`, and only an object-literal type gets
 * the implicit index signature that assignment needs.
 */
export type RoomStatusData = {
  before: string;
  after: string;
  cards: RoomStatusCard[];
  terminal: RoomStatusTerminal | null;
};

/**
 * The data shape, stated once as a type and once as a schema so the renderer
 * cannot accept a row it could not draw. The annotation pins the two together:
 * a field added to one and not the other stops the typecheck.
 */
export const roomStatusSchema: z.ZodType<RoomStatusData> = z.object({
  before: z.string(),
  after: z.string(),
  cards: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      detail: z.string().optional(),
      peers: z.array(z.string()),
      waitingOn: z.string().optional(),
      elapsed: z.string().optional(),
    }),
  ),
  terminal: z
    .object({
      kind: z.enum(["done", "waiting"]),
      text: z.string(),
    })
    .nullable(),
});

const FENCED = /```room-status[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

/** An em dash, en dash or hyphen between the bold label and its text. */
const DASH = "[—–-]";

const TERMINAL = new RegExp(`^\\*\\*(✅|❓)\\s*([^*]+?)\\*\\*\\s*${DASH}\\s*(.+)$`);
const CARD = new RegExp(`^\\*\\*(.+?)\\*\\*\\s*${DASH}\\s*\`(.+?)\`\\s*$`);

/** `detail · peers: a, b · waiting on review · ~2m`, in any order. */
function applyDetail(card: RoomStatusCard, line: string): void {
  for (const part of line.split(/\s*·\s*/)) {
    const peers = /^peers:\s*(.*)$/i.exec(part);
    if (peers) {
      card.peers = peers[1]
        .split(/\s*,\s*/)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      continue;
    }
    const waiting = /^waiting on\s+(.+)$/i.exec(part);
    if (waiting) {
      card.waitingOn = waiting[1].trim();
      continue;
    }
    const elapsed = /^(~\s*\d+\s*m)$/i.exec(part);
    if (elapsed) {
      card.elapsed = elapsed[1].replace(/\s+/g, "");
      continue;
    }
    card.detail = card.detail === undefined ? part : `${card.detail} · ${part}`;
  }
}

function parseBody(body: string): Pick<RoomStatusData, "cards" | "terminal"> | null {
  const cards: RoomStatusCard[] = [];
  let terminal: RoomStatusTerminal | null = null;
  let current: RoomStatusCard | null = null;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      current = null;
      continue;
    }
    const done = TERMINAL.exec(line);
    if (done) {
      terminal = { kind: done[1] === "✅" ? "done" : "waiting", text: done[3].trim() };
      current = null;
      continue;
    }
    const card = CARD.exec(line);
    if (card) {
      current = { name: card[1].trim(), state: card[2].trim(), peers: [] };
      cards.push(current);
      continue;
    }
    if (current !== null) applyDetail(current, line);
  }

  // A terminal row is the whole block; a mixed block is a malformed one, and
  // the caller keeps the original text rather than drawing a guess.
  if (terminal !== null) return cards.length === 0 ? { cards: [], terminal } : null;
  if (cards.length === 0) return null;
  return { cards, terminal: null };
}

/**
 * Split one assistant message around its last `room-status` fence. Returns
 * `null` when there is no fence or the body does not parse, so the host keeps
 * the message exactly as written.
 */
export function parseRoomStatusMessage(text: string): RoomStatusData | null {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(FENCED)) last = match;
  if (last === null) return null;

  const body = last[1];
  const parsed = parseBody(body);
  if (parsed === null) return null;

  const start = last.index ?? 0;
  const end = start + last[0].length;
  return {
    before: text.slice(0, start).trimEnd(),
    after: text.slice(end).trim(),
    cards: parsed.cards,
    terminal: parsed.terminal,
  };
}

/**
 * An assistant message with each `room-status` fence replaced by its rows. The
 * room feed shows message text in a plain Text, so it gets the readable rows
 * without the fence markers.
 */
export function stripRoomStatusFence(text: string): string {
  return text.replace(FENCED, (_whole, body: string) => body);
}

/** The card in one plain line, for surfaces that cannot draw the component. */
export function roomStatusLine(card: RoomStatusCard): string {
  const parts = [`${card.name} · ${card.state}`];
  if (card.detail !== undefined) parts.push(card.detail);
  if (card.peers.length > 0) parts.push(`peers: ${card.peers.join(", ")}`);
  if (card.waitingOn !== undefined) parts.push(`waiting on ${card.waitingOn}`);
  if (card.elapsed !== undefined) parts.push(card.elapsed);
  return parts.join(" · ");
}

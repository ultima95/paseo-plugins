import { z } from "zod";

/** The plugin row kind the timeline renderer draws. */
export const MESSAGE_ROW_KIND = "reply-row";

/** The row schema version; bump only when the data shape changes incompatibly. */
export const MESSAGE_ROW_VERSION = 1;

export const messageRowSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export type MessageRowData = z.output<typeof messageRowSchema>;

/** The agent that wrote a reply, as much of it as the quote needs. */
export interface MessageOwner {
  provider: string;
  model: string | null;
}

/**
 * What names the agent behind a reply, for the quote's attribution line: its model, else
 * its provider.
 *
 * The agent's `title` is deliberately not used. Paseo fills it from the agent's first
 * prompt, so it is the task text ("could we create a new plugin...") rather than who is
 * speaking, and quoting it would attribute a reply to a question. Nothing on the snapshot
 * separates a role name from that task text, so the model is the honest answer: it is
 * what actually produced the message, and it is always set.
 */
export function ownerLabel(owner: MessageOwner | null): string | null {
  if (owner === null) return null;
  const model = owner.model?.trim();
  if (model) return model;
  const provider = owner.provider.trim();
  return provider.length > 0 ? provider : null;
}

/** Whole calendar days between two instants, in the device's local time. */
function localCalendarDaysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((end - start) / 86_400_000);
}

/**
 * A message timestamp for a row whose time only appears on hover: the clock time alone
 * for today, the weekday before it within the week, then the date. Paseo formats its own
 * message timestamps this way, and matching it keeps two rows in one conversation from
 * reading as two different surfaces.
 */
export function formatTimestamp(timestamp: Date, now: Date = new Date()): string {
  const time = timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const daysAgo = localCalendarDaysBetween(timestamp, now);
  if (daysAgo === 0) return time;
  if (daysAgo > 0 && daysAgo < 7) {
    return `${timestamp.toLocaleDateString([], { weekday: "long" })} ${time}`;
  }
  const date = timestamp.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${date}, ${time}`;
}

/** How many lines of the quoted message are kept. */
export const QUOTE_MAX_LINES = 8;

/** How many characters of the quoted message are kept, across all lines. */
export const QUOTE_MAX_CHARS = 600;

/**
 * The row data this plugin draws for a reply, or `null` to leave the reply to Paseo.
 *
 * Only an agent reply is replaced. A message the user sent is left to Paseo's own row
 * because a transformer receives only a message's text: the daemon drops image blocks
 * before the item reaches a plugin, so a plugin row could never draw an attachment. Paseo's
 * row draws the images, and keeps the rewind menu and its own Copy along with them.
 *
 * A reply with no text is left to Paseo too: this plugin would draw nothing for it while
 * still costing the completed-turn footer.
 */
export function rowForReply(text: string, phase: MessageRowData["phase"]): MessageRowData | null {
  if (text.trim().length === 0) return null;
  return { text, phase };
}

function clipLine(line: string): string {
  const trimmed = line.trimEnd();
  return trimmed.length === 0 ? ">" : `> ${trimmed}`;
}

/**
 * The composer text that replies to `text`: a Markdown blockquote of its first lines,
 * followed by a blank line for the answer. `owner`, when known, is the first quoted line,
 * so the agent reading the prompt knows which agent wrote what is being answered.
 * Returns `null` when the message has no quotable text, so a caller can leave the
 * composer alone instead of inserting "> ".
 */
export function buildQuote(text: string, owner: string | null = null): string | null {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return null;

  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trimEnd();
    if (kept.length >= QUOTE_MAX_LINES) {
      // A trailing run of blank lines is not worth an ellipsis.
      truncated = lines.slice(index).some((rest) => rest.trim().length > 0);
      break;
    }
    // A line longer than what is left is cut rather than dropped, so one long
    // paragraph or code line still quotes as much as fits.
    const room = QUOTE_MAX_CHARS - used;
    if (trimmed.length > room) {
      if (room > 0) kept.push(`> ${trimmed.slice(0, room)}`);
      truncated = true;
      break;
    }
    kept.push(clipLine(trimmed));
    used += trimmed.length;
  }

  if (kept.length === 0) return null;
  while (kept.length > 1 && kept[kept.length - 1] === ">") kept.pop();
  if (truncated) kept.push("> …");
  // The attribution goes inside the quote so it reads as part of what is being answered
  // rather than as text the user is about to send.
  if (owner) kept.unshift(`> **${owner}** wrote:`);
  return `${kept.join("\n")}\n\n`;
}

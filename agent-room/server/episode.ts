import { createHash } from "node:crypto";

import {
  LESSON_TEXT_CAP,
  type EpisodeFact,
  type EpisodeKind,
} from "../shared/member";
import type { RoleKind } from "../shared/roles";
import type { FeedEvent } from "../shared/room";

/** Only these five signals become episode facts. */
export const EPISODE_SIGNAL_KINDS: Readonly<Record<string, EpisodeKind>> = {
  DECISION_NEEDED: "decision",
  REJECT: "rejected",
  BLOCKED: "blocked",
  ACCEPT: "outcome",
  DONE: "outcome",
};

/**
 * Token shapes that are unambiguously credentials. Deliberately shallow: a fact
 * is written to disk and later read by the Lead, so an obvious key must not
 * survive, but guessing at prose is worse than leaving it intact.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z0-9 ]+-----/g,
];

/** Replace each obvious credential with `[redacted]` and report how many went. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let result = text;
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions += 1;
      return "[redacted]";
    });
  }
  return { text: result, redactions };
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The episode fact a feed event contributes, or `null` when it contributes none.
 * Pure: the caller decides whether the fact is worth persisting.
 */
export function episodeFactFor(
  event: Pick<FeedEvent, "at" | "label" | "text">,
  roleKind: RoleKind | undefined,
): { fact: EpisodeFact; redactions: number } | null {
  // A worker's signals reach the Lead; they contribute nothing directly.
  if (roleKind !== "supervisor" && roleKind !== "lead") return null;
  // `label` is an arbitrary string, so a plain lookup would also hit inherited
  // Object.prototype members (`constructor`, `toString`, ...) and emit a fact
  // whose `kind` is a function. Require an own property that maps to a string.
  if (!Object.hasOwn(EPISODE_SIGNAL_KINDS, event.label)) return null;
  const kind = EPISODE_SIGNAL_KINDS[event.label];
  if (typeof kind !== "string") return null;
  const redacted = redactSecrets(event.text);
  // `episodeFactSchema` requires non-empty text, so a blank signal carries no fact.
  if (redacted.text.trim().length === 0) return null;
  return {
    fact: {
      at: event.at,
      kind,
      signal: event.label,
      text: redacted.text,
    },
    redactions: redacted.redactions,
  };
}

export interface PromotionCandidate {
  id: string;
  at: string;
  scope: string;
  text: string;
  sourceRoomId: string;
}

/**
 * Turn episode facts into lesson candidates. Only what a Lead decided or had
 * rejected is worth remembering; the id is content-addressed, so the same
 * lesson in the same scope always proposes the same candidate.
 */
export function candidatesFromFacts(
  facts: readonly EpisodeFact[],
  input: { scope: string; sourceRoomId: string },
): PromotionCandidate[] {
  const seen = new Set<string>();
  const candidates: PromotionCandidate[] = [];

  for (const fact of facts) {
    if (fact.kind !== "decision" && fact.kind !== "rejected") continue;
    const text = fact.text.trim().slice(0, LESSON_TEXT_CAP);
    if (text.length === 0) continue;
    const key = normalize(text);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id: hash(`${input.scope}\n${key}`),
      at: fact.at,
      scope: input.scope,
      text,
      sourceRoomId: input.sourceRoomId,
    });
  }
  return candidates;
}

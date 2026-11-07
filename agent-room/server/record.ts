import type { RoleKind } from "../shared/roles";
import type { FeedEvent } from "../shared/room";

/**
 * The verification vocabulary, kept apart from the signal vocabulary on
 * purpose.
 *
 * A `verdict` is what verification found for a named work item. A
 * `disposition` is what the room decided about that verdict. Shipping a known
 * defect is a `FAIL` with an accepted disposition, or a `BLOCKED` with an
 * owner — it is never a silent `PASS`. `owner-accepted` is a claim about a Human
 * and is valid only when a recorded Human turn says so; otherwise the room
 * records the accepting role and flags the mismatch.
 */
export type Verdict = "FAIL" | "PASS" | "BLOCKED";

export interface VerdictRow {
  work: string;
  verdict: Verdict;
}

export interface AcceptanceClaim {
  /** The canonical disposition this line claims. */
  disposition: string;
  /** The work item the claim names, when the line names one. */
  work: string | null;
  /** The exact text that carried the claim. */
  raw: string;
}

export interface AcceptanceAudit {
  disposition: string;
  work: string | null;
  /** True only when a recorded Human turn supports an `owner-accepted`. */
  verified: boolean;
  /** What the room may record when the claim is not traceable. */
  recorded: string;
}

export interface VerdictChange {
  work: string;
  from: Verdict;
  to: "PASS";
}

/** Strip the markdown that wraps a work item in a table or bold line. */
function plain(line: string): string {
  return line.replace(/\*\*|__|`/g, "");
}

function cleanWork(text: string): string {
  return plain(text)
    .replace(/^[\s|*_`-]+/, "")
    .replace(/[\s|*_`]+$/, "")
    .trim();
}

/**
 * A row in the shapes a verification record actually takes:
 * `work: FAIL`, `| work | FAIL | evidence |`, `FAIL: work`, `FAIL work`.
 */
const WORK_FIRST = /^\s*(?:[-*]\s*)?\|?\s*([^|:—–]{1,80}?)\s*(?:\||:|—|–)\s*(FAIL|PASS|BLOCKED)\b/i;
const VERDICT_FIRST = /^\s*(?:[-*]\s*)?\|?\s*(FAIL|PASS|BLOCKED)\b\s*(?:\||:|—|–|-)\s*(.+?)\s*$/i;

function verdictFor(token: string): Verdict {
  const upper = token.toUpperCase();
  return upper === "FAIL" ? "FAIL" : upper === "BLOCKED" ? "BLOCKED" : "PASS";
}

/**
 * Every named verdict in one turn's text, last row per work item. Pure: the
 * caller decides what to do with a change.
 */
export function verdictsIn(text: string): VerdictRow[] {
  const byWork = new Map<string, VerdictRow>();

  for (const raw of text.split(/\r?\n/)) {
    const line = plain(raw).trim();
    if (line.length === 0) continue;

    const workFirst = WORK_FIRST.exec(line);
    if (workFirst) {
      const work = cleanWork(workFirst[1] ?? "");
      if (work.length === 0) continue;
      byWork.set(work.toLowerCase(), { work, verdict: verdictFor(workFirst[2] ?? "") });
      continue;
    }

    const verdictFirst = VERDICT_FIRST.exec(line);
    if (verdictFirst) {
      const work = cleanWork((verdictFirst[2] ?? "").replace(/^\|/, ""));
      if (work.length === 0) continue;
      byWork.set(work.toLowerCase(), { work, verdict: verdictFor(verdictFirst[1] ?? "") });
    }
  }

  return [...byWork.values()];
}

const OWNER_CLAIM = /\bowner[- ]accepted\b/gi;
const ROLE_CLAIM = /\baccepted[- ]by[- ](owner|human|supervisor|lead|worker|agent)\b/gi;

function workAround(line: string, index: number, length: number): string | null {
  const before = line.slice(0, index);
  const after = line.slice(index + length);

  const prefix = /^\s*(?:[-*]\s*)?\|?\s*(.+?)\s*(?:\||:|—|–)\s*$/.exec(before);
  if (prefix) {
    const work = cleanWork(prefix[1] ?? "");
    if (work.length > 0) return work;
  }

  const suffix = /^\s*(?:\||:|—|–|-)\s*(.+?)\s*$/.exec(after);
  if (suffix) {
    const work = cleanWork(suffix[1] ?? "");
    if (work.length > 0) return work;
  }

  return null;
}

/** Every acceptance attribution one turn's text claims. */
export function acceptanceClaims(text: string): AcceptanceClaim[] {
  const claims: AcceptanceClaim[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = plain(raw);

    for (const match of line.matchAll(OWNER_CLAIM)) {
      if (match.index === undefined) continue;
      claims.push({
        disposition: "owner-accepted",
        work: workAround(line, match.index, match[0].length),
        raw: raw.trim(),
      });
    }

    for (const match of line.matchAll(ROLE_CLAIM)) {
      if (match.index === undefined) continue;
      const role = (match[1] ?? "agent").toLowerCase();
      claims.push({
        disposition: role === "owner" || role === "human" ? "owner-accepted" : `accepted-by-${role}`,
        work: workAround(line, match.index, match[0].length),
        raw: raw.trim(),
      });
    }
  }

  return claims;
}

/** Words a Human turn uses to accept something. Deliberately narrow. */
const HUMAN_ACCEPT =
  /\b(accept|accepted|approve|approved|authori[sz]ed?|sign[- ]?off|ship it|go ahead|proceed)\b/i;

function namesWork(text: string, work: string): boolean {
  return text.toLowerCase().includes(work.toLowerCase());
}

/**
 * True when a recorded Human turn in this room supports the claim. A claim
 * that names a work item needs that item in the Human's text; a claim that
 * names none is supported by any Human acceptance in the room.
 */
export function humanAccepted(feed: readonly FeedEvent[], work: string | null): boolean {
  return feed.some(
    (event) =>
      event.from === null &&
      HUMAN_ACCEPT.test(event.text) &&
      (work === null || namesWork(event.text, work)),
  );
}

/**
 * Audit a turn's `owner-accepted` claims against the room feed. This turn's
 * incoming rows may be included, but the seat's own reply must not be: a claim
 * cannot vouch for itself.
 */
export function auditAcceptance(input: {
  text: string;
  feed: readonly FeedEvent[];
  role: RoleKind | undefined;
}): AcceptanceAudit[] {
  const recordedRole = input.role === undefined ? "agent" : input.role;
  return acceptanceClaims(input.text)
    .filter((claim) => claim.disposition === "owner-accepted")
    .map((claim) => {
      const verified = humanAccepted(input.feed, claim.work);
      return {
        disposition: claim.disposition,
        work: claim.work,
        verified,
        recorded: verified ? "owner-accepted" : `accepted-by-${recordedRole}`,
      };
    });
}

/**
 * Candidate and run identities a turn can cite. A commit sha, a PR/run number,
 * or an explicit `run <id>` is evidence that the tree was walked again.
 */
export function evidenceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) tokens.add(match[0].toLowerCase());
  for (const match of text.matchAll(/#(\d{1,6})\b/g)) tokens.add(`num-${match[1]}`);
  for (const match of text.matchAll(/\b(?:run|walk)\s+#?([A-Za-z0-9_-]{1,})\b/gi)) {
    tokens.add(`ref-${(match[1] ?? "").toLowerCase()}`);
  }
  return tokens;
}

/** True when this turn cites an identity the earlier turn did not. */
export function hasFreshEvidence(earlierText: string, laterText: string): boolean {
  const earlier = evidenceTokens(earlierText);
  return [...evidenceTokens(laterText)].some((token) => !earlier.has(token));
}

/**
 * Verdicts that moved from bad to `PASS` between two turns for the same work,
 * with no new candidate or walk to justify the move. Empty when the later turn
 * cites fresh evidence.
 */
export function verdictUpgrades(earlierText: string, laterText: string): VerdictChange[] {
  if (hasFreshEvidence(earlierText, laterText)) return [];

  const later = new Map(verdictsIn(laterText).map((row) => [row.work.toLowerCase(), row]));
  const changes: VerdictChange[] = [];

  for (const row of verdictsIn(earlierText)) {
    const current = later.get(row.work.toLowerCase());
    if (current === undefined || current.verdict !== "PASS") continue;
    if (row.verdict !== "FAIL" && row.verdict !== "BLOCKED") continue;
    changes.push({ work: current.work, from: row.verdict, to: "PASS" });
  }

  return changes;
}

/** True when an outcome signal still carries an unresolved verdict. */
export function hasUnresolvedVerdict(text: string): boolean {
  return verdictsIn(text).some((row) => row.verdict !== "PASS");
}

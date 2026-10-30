// Reclaim: the only place the GC port asks for a record to be deleted.
//
// Reference: `docs/gc-port/slp-gc.bash`, `do_apply`'s first loop (`:1046-1096`).
//
//   the two refuse-everything arms     :1050-1057  (`procs.ident.ok`, then `index.ok`)
//   the per-candidate loop             :1068-1096  (schedules first, then agents)
//   the tick budget, per candidate     :1072       (`budget_expired`, :1008)
//   `MAX_ACTIONS`, per attempt         :1073
//   the id/kind shapes                 :1074-1075
//   the record file is still a file    :1076       (gone, or a symlink)
//   a fresh full re-evaluation         :1077       (`recheck`, :1028)
//   the row must still be garbage      :1078-1079
//   the signature/timestamp re-check   :1080-1084  (file `sig` *and* the fresh row's)
//   the archived-proof arm             :1085-1091  (`prove_archived`, env-blind only)
//   the delete                         :1093-1094  (`paseo agent|schedule delete`)
//
// Six properties matter more than tidiness:
//
// 1. **A failed index refuses everything and nothing is attempted.** `do_apply`
//    returns before the loop when `.index.ok` is not true (`:1054`), which is the
//    reference's answer to an index with a record it could not reduce: an
//    incomplete index cannot tell "archived" from "unreadable", so a delete
//    authorised by it could hit a live agent. The gate here is a value
//    (`indexOk`), it defaults to *false*, and the refusal is per candidate so the
//    screen still shows every row it considered.
//
// 2. **Nothing is deleted on a stale decision.** Every candidate carries the
//    `sig` its decision was made on, and the caller's `verify` re-reads the record
//    immediately before the delete — the same signature *and* the same
//    `updatedAt`/`archivedAt`/`lastRunAt`/`archivedEpoch` it carries (`:1081-1082`).
//    An empty or absent `sig` is refused without calling anything: `""` is this
//    port's "unverified" (`evaluate.ts`, `ReportGarbageRow.sig`) and an unverified
//    row is not deletable. A candidate whose timestamps the re-read cannot confirm
//    is refused too, never defaulted — that is the `updatedAt // ""` / `arrivedAt
//    // ""` comparison the reference makes against the fresh row, with "absent"
//    treated as unprovable rather than as equal.
//
// 3. **The gates are ordered the way the reference orders them**, and each one is
//    a refusal that returns an `ActionResult` rather than an exception: the row's
//    own verdict, its rule's toggle, the budget, `MAX_ACTIONS`, the id/kind shapes,
//    the record file's own shape (`:1076`), the signature, the re-read. A failure of
//    the *delete* is also a result (`acted: false`), and the loop continues —
//    `fail=1` in the reference (`:1094`) does not stop the run. `MAX_ACTIONS` counts
//    *attempts*, not successes (`:1092` increments `n` before the CLI call at
//    `:1093`), so a delete that fails still consumes its slot.
//
// 4. **Nothing throws.** `deleteAgent`, `deleteSchedule`, `verify`, `lstat`, `now`
//    and the log are foreign code: a throw, a `null`, or a wrongly shaped answer is
//    a refusal. The one exception is deliberately *not* caught into a "verified"
//    answer — a `verify` that throws refuses the candidate.
//
// 5. **Pure of I/O.** No `paseo` client, no `fs`, no clock of its own: the
//    deletes, the re-read, the optional `lstat` and the clock arrive as `deps`. A
//    test never touches a record file, an agent or a schedule.
//
// 6. **The budget is the tick's.** `budgetS` is `SLP_GC_TICK_BUDGET_S`; when the
//    caller passes the tick's own `startedAt` the comparison is the reference's
//    (`now - TICK_START >= TICK_BUDGET_S`, `:1008`) and can refuse the *first*
//    candidate. Without `startedAt` the clock starts at the first action the phase
//    considers, so a tick that spent its time before the phase began still does
//    its first delete — the reference's own behaviour, since `TICK_BUDGET_S >= 1`
//    (`:88`) and a whole second has to elapse between two checks.

import type { GarbageRule } from "./evaluate";
import type { GcLog } from "./settings";

// ---------------------------------------------------------------------------
// The result row (the screen's `act` line, slp-gc.bash:1000-1006)
// ---------------------------------------------------------------------------

/**
 * The `act()` kinds this port emits. `agent`/`schedule` are the two delete
 * targets; `kill` is a signal (used by `kill.ts`, which shares this row shape
 * because the reference's `act` is one function for both loops, `:1000`);
 * `refuse` is the row-level refusal that has no candidate of its own.
 */
export type ActionResultKind = "agent" | "schedule" | "kill" | "refuse";

/**
 * One `act` row (`{ts, kind, target, result, detail}`, `:1002-1003`), in the
 * terms a screen needs: what was considered, whether anything happened, and why
 * not. `refusedBy` is the port's stable key — the same `<rule>: <text>` form
 * `GarbageCandidate.refusedBy` uses, so a screen can group refusals — and it is
 * `null` only when `acted` is `true`.
 */
export interface ActionResult {
  kind: ActionResultKind;
  /** The record's id (deletes) or the pid as a string (kills); `-` for a row-level refusal. */
  id: string;
  acted: boolean;
  /** The reference's `detail` text, verbatim where it has one. */
  reason: string;
  /** The stable refusal key, or `null` when the action was taken. */
  refusedBy: string | null;
  /** Set on a kill row: the pid that was signalled (the fresh one). */
  pid?: number;
  /** Set on a kill row: the class that was signalled. */
  pidClass?: string;
}

// ---------------------------------------------------------------------------
// The tick budget (slp-gc.bash:1008)
// ---------------------------------------------------------------------------

export interface BudgetOptions {
  /** `SLP_GC_TICK_BUDGET_S`; absent disables the gate (the caller has no tick clock). */
  budgetS?: number;
  /**
   * `TICK_START` in epoch seconds. Supplying the tick's own start makes the gate
   * the reference's exactly (`now - start >= budgetS`, so an already-spent tick
   * does nothing at all). Absent, the phase's own start is taken at the first
   * check, which never refuses the first candidate — see the file header, point 6.
   */
  startedAt?: number;
  /** The clock. Defaults to the wall clock in whole seconds. */
  now?: () => number;
}

/** The budget gate: `spent()` answers "no further action this phase". */
export interface Budget {
  spent(): boolean;
}

/**
 * Build the `budget_expired` gate (`:1008`).
 *
 * `spent()` is called once per candidate, *before* anything is acted on, so a
 * candidate can never be deleted or signalled on a tick whose budget is gone.
 * A clock that throws reads as spent: no action is the safe answer to "I cannot
 * tell what time it is".
 */
export function createBudget(options: BudgetOptions): Budget {
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const budgetS = options.budgetS;
  let start = options.startedAt;
  return {
    spent(): boolean {
      if (typeof budgetS !== "number" || !Number.isFinite(budgetS)) return false;
      let now: number;
      try {
        now = clock();
      } catch {
        return true;
      }
      if (typeof now !== "number" || !Number.isFinite(now)) return true;
      if (start === undefined) {
        start = now;
        return false;
      }
      return now - start >= budgetS;
    },
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * One garbage candidate as the reclaim step must see it: `evaluate.ts`'s
 * `GarbageCandidate` (which `report.ts` narrows into `ReportGarbageRow`) plus the
 * record facts the reference compares on the fresh re-read.
 *
 * The timestamp fields are **optional but not defaulted**: a candidate that
 * carries one has it compared against the fresh row and is refused when the
 * re-read cannot confirm it. A candidate that carries none is compared on its
 * signature alone — which is all the brief's own candidates have.
 */
export interface ReclaimCandidate {
  /** `category` in the reference's report (`:557`). */
  kind: "agent" | "schedule";
  /** The record's id — `paseo agent delete -- <uuid>` / `paseo schedule delete -- <hex8>`. */
  id: string;
  /**
   * The record file the decision was made on (`$path`, `:1076`). When supplied
   * *and* `deps.lstat` is supplied, the file must still be a regular file that is not
   * a symlink, or the candidate is refused (`file-gone`) before anything is re-read;
   * when absent — or when no `lstat` was injected — the file's existence is left to
   * `verify`, whose "no answer" refuses the candidate.
   */
  path?: string;
  /** `inode:size:mtime` of that file (`$sig`, `:1080`); `""`/absent = unverified, refused. */
  sig?: string;
  /** The rule that made the row garbage (`agent-archived` / `schedule-completed`). */
  rule?: GarbageRule;
  /**
   * `null` when the row's rule judged it garbage. Anything else — including
   * `undefined`, which a caller that forgot the field would supply — refuses the
   * candidate: the reference only ever acts on rows the fresh evaluation still
   * calls garbage (`:1078-1079`).
   */
  refusedBy: string | null;
  /** The reference's `reason` sentence, carried into the refusal result. */
  reason?: string;
  /** The reference's `action` sentence (`paseo agent delete …`); informational. */
  action?: string | null;
  /** `$upd` — the record's `updatedAt`, when the caller has it. */
  updatedAt?: string | null;
  /** `$arch` — the record's `archivedAt`, when the caller has it. */
  archivedAt?: string | null;
  /** The same instant as an epoch, when that is what the caller carries. */
  archivedEpoch?: number | null;
  /** `$lr` — the schedule's `lastRunAt`, when the caller has it. */
  lastRunAt?: string | null;
}

/**
 * A fresh record as `verify` may answer with: the fields the reference compares
 * (`:1081-1082`), plus the fresh rule verdict.
 */
export interface FreshRecord {
  /** `fsig "$path"` — the file's `inode:size:mtime` re-read now (`:1080`). */
  sig?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  archivedEpoch?: number | null;
  lastRunAt?: string | null;
  /** A fresh rule verdict: non-null means the row is not garbage any more (`:1079`). */
  refusedBy?: string | null;
  /** The fresh `reason` sentence, for the refusal. */
  reason?: string;
}

/**
 * What the caller's re-read may answer.
 *
 * - `true` — "the record is still the one you judged" (a re-read that only
 *   re-derives the verdict). Refused for a candidate that carries timestamps,
 *   because a boolean carries nothing to compare them against.
 * - a `string` — the freshly computed signature (`fsig`).
 * - a `FreshRecord` — the fresh signature and timestamps.
 * - `false`/`null`/`undefined` — the row is gone, or the re-read does not know.
 */
export type VerifyAnswer = boolean | string | FreshRecord | null | undefined;

export interface ReclaimInput {
  /** `$T/report.json`'s `.garbage[]`, in decision order (schedules first, `:557`). */
  candidates: readonly ReclaimCandidate[];
  /**
   * `$idx.ok` (`:1054`). **Defaults to false**: an index verdict the caller did
   * not supply is not a complete one, and the reference's answer to that is
   * "delete nothing".
   */
  indexOk?: boolean;
  /** `$idx.why` — joined with `"; "` into the refusal, as the reference does (`:1055`). */
  indexWhy?: readonly string[];
  /** `SLP_GC_MAX_ACTIONS`, 100 by default (`:31`, `:43`). */
  maxActions?: number;
  /** `SLP_GC_TICK_BUDGET_S`; absent disables the budget gate. */
  budgetS?: number;
  /** `TICK_START`; see `BudgetOptions`. */
  startedAt?: number;
  /**
   * The rule toggles, when the caller has them. Supplied, a candidate whose rule
   * is absent from the list is refused (`SLP_GC_APPLY` deciding *what* may be
   * reclaimed). Absent, the caller has already made that decision by choosing to
   * call this function — the reference's `do_apply` is reached only when the
   * apply flag is on (`:1061`).
   */
  enabledRules?: readonly GarbageRule[];
}

export interface ReclaimDeps {
  /** `paseo agent delete --home <home> -- <id>` (`:1093`). */
  deleteAgent: (id: string) => Promise<unknown>;
  /** `paseo schedule delete --home <home> -- <id>` (`:1093`). */
  deleteSchedule: (id: string) => Promise<unknown>;
  /**
   * The fresh full re-evaluation, called once per candidate *immediately* before
   * its delete (`recheck`, `:1077`, then `:1080-1084`). It must re-read the record
   * from disk and answer with what it now is.
   */
  verify: (candidate: ReclaimCandidate) => VerifyAnswer | Promise<VerifyAnswer>;
  /**
   * The record file's own shape, for `[ -L "$path" ] || [ ! -f "$path" ]` (`:1076`):
   * a production caller passes `fs.lstat`'s two answers. Optional — this module does
   * no I/O of its own, and the brief's candidates carry no `path` at all. When it is
   * absent and a candidate *does* carry a `path`, a `warn` says the arm was skipped
   * and `verify` owns the record's existence (a `verify` that answers nothing refuses
   * the candidate).
   */
  lstat?: (
    path: string,
  ) => { isFile?: boolean; isSymbolicLink?: boolean } | null | undefined;
  /** `date +%s`; defaults to the wall clock. */
  now?: () => number;
  log?: GcLog;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * A `warn` sink for the log the caller passed: a function, a logger shape or
 * nothing at all. Kept local, as `agents.ts` keeps its own, so this module cannot
 * widen `settings.ts`'s logging contract.
 *
 * A log sink that throws is swallowed: the whole point of this module is that a
 * dependency failure becomes an `ActionResult`, and a broken logger must not turn
 * a refusal into an exception on its way to the screen.
 */
function warnLog(log: GcLog | undefined): (message: string, fields?: Record<string, unknown>) => void {
  let sink: (message: string, fields?: Record<string, unknown>) => void;
  if (typeof log === "function") {
    sink = log as (message: string, fields?: Record<string, unknown>) => void;
  } else if (log !== null && typeof log === "object") {
    const candidate = (log as unknown as Record<string, unknown>).warn;
    sink =
      typeof candidate === "function"
        ? (candidate as (message: string, fields?: Record<string, unknown>) => void).bind(log)
        : () => {};
  } else {
    sink = () => {};
  }
  return (message, fields) => {
    try {
      sink(message, fields);
    } catch {
      // A log sink must never break a tick.
    }
  };
}

/** An error's message, for a refusal's `reason`. Never the stack. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/** `MAX_ACTIONS`'s default when the caller supplies none (`:31`, `:43`). */
export const DEFAULT_MAX_ACTIONS = 100;

/** The reference's signature-change sentence (`:1083`), used verbatim. */
const CHANGED = "file identity/mtime/size/content changed since evaluation";

/** A refusal's stable key and its text. */
interface Refusal {
  refusedBy: string;
  reason: string;
}

function refuseWith(refusedBy: string, reason: string): Refusal {
  return { refusedBy, reason };
}

/** `Object.hasOwn` plus "not undefined": a field the caller really supplied. */
function carries(record: object, field: string): boolean {
  const value = (record as Record<string, unknown>)[field];
  return Object.prototype.hasOwnProperty.call(record, field) && value !== undefined;
}

/** The timestamp fields the reference compares on the fresh re-read, in its order. */
const TIMESTAMP_FIELDS: readonly (keyof FreshRecord)[] = [
  "updatedAt",
  "archivedAt",
  "lastRunAt",
  "archivedEpoch",
];

/** Does the candidate carry any timestamp the re-read has to confirm? */
function carriesTimestamps(candidate: ReclaimCandidate): boolean {
  return TIMESTAMP_FIELDS.some((field) => carries(candidate, field as string));
}

/**
 * Judge one candidate's fresh re-read (`:1077-1084`).
 *
 * Every branch that is not an unambiguous "same record, still garbage" refuses:
 * a throw, a `null`, a `false`, a fresh verdict, an unreadable fresh signature, a
 * moved signature, a timestamp the fresh row cannot confirm. The `reason` texts
 * are the reference's own where it has one.
 *
 * `false` is the caller saying "the record I re-read is not the one you judged",
 * which is the reference's identity/mtime/size/content arm (`:1081-1083`) — so it
 * reads as a changed signature, not as an unknown answer. `null`/`undefined` is
 * "no answer at all", which is the failed-recheck arm.
 */
function judgeFresh(candidate: ReclaimCandidate, answer: VerifyAnswer): Refusal | null {
  if (answer === null || answer === undefined) {
    return refuseWith("fresh-evaluation", "fresh re-evaluation failed: no verdict");
  }
  if (answer === false) return refuseWith("sig-changed", CHANGED);
  if (answer === true) {
    // A boolean says "unchanged" without carrying anything to compare `sig` or the
    // timestamps against, so it can only authorise a candidate that has timestamps
    // to begin with.
    if (carriesTimestamps(candidate)) {
      return refuseWith(
        "timestamps-unverified",
        "the fresh re-evaluation answered without the timestamps to compare",
      );
    }
    return null;
  }
  if (typeof answer === "string") {
    if (answer === "") {
      return refuseWith("fresh-evaluation", "the fresh re-evaluation could not re-read the file's signature");
    }
    if (answer !== candidate.sig) return refuseWith("sig-changed", CHANGED);
    if (carriesTimestamps(candidate)) {
      return refuseWith(
        "timestamps-unverified",
        "the fresh re-evaluation answered without the timestamps to compare",
      );
    }
    return null;
  }
  if (typeof answer !== "object") {
    // A number, a symbol, an array: not an answer this module can act on.
    return refuseWith("fresh-evaluation", "fresh re-evaluation failed: unusable verdict");
  }

  const fresh = answer as FreshRecord;
  if (fresh.refusedBy !== undefined && fresh.refusedBy !== null) {
    return refuseWith(
      String(fresh.refusedBy),
      fresh.reason ?? "no longer garbage on the fresh full re-evaluation",
    );
  }
  if (typeof fresh.sig !== "string" || fresh.sig === "") {
    return refuseWith("sig-unverified", "the fresh re-evaluation could not re-read the file's signature");
  }
  if (fresh.sig !== candidate.sig) return refuseWith("sig-changed", CHANGED);

  for (const field of TIMESTAMP_FIELDS) {
    const key = field as string;
    if (!carries(candidate, key)) continue;
    if (!carries(fresh, key)) {
      return refuseWith(
        "timestamps-unverified",
        `the fresh re-evaluation could not re-read ${key}: refusing rather than assuming it unchanged`,
      );
    }
    if (
      (fresh as unknown as Record<string, unknown>)[key] !==
      (candidate as unknown as Record<string, unknown>)[key]
    ) {
      return refuseWith("sig-changed", CHANGED);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/** The result row for a candidate this step refuses. */
function refusal(
  candidate: ReclaimCandidate,
  kind: ActionResultKind,
  id: string,
  refusal: Refusal,
): ActionResult {
  return {
    kind,
    id,
    acted: false,
    reason: refusal.reason,
    refusedBy: refusal.refusedBy,
  };
}

/**
 * Delete every candidate the reference would delete, and return one
 * `ActionResult` per candidate considered (`act`, `:1000`).
 *
 * Refuses *everything* when the index is not proven complete, and refuses any
 * candidate whose verdict, rule, signature, timestamps or fresh re-read does not
 * hold. Never throws: every failure of a dependency is a refusal row.
 *
 * Order per candidate is the reference's: the row's own verdict, its rule's
 * toggle, the budget (`:1072`), `MAX_ACTIONS` (`:1073`, attempts), the id/kind
 * sanity the reference applies at `:1074-1075`, the record file's own shape
 * (`:1076`, through the optional `deps.lstat`), the signature (`:1080`), the fresh
 * re-read (`:1077-1084`), then the delete (`:1093`).
 */
export async function reclaim(input: ReclaimInput, deps: ReclaimDeps): Promise<ActionResult[]> {
  const warn = warnLog(deps?.log);
  const candidates: readonly ReclaimCandidate[] = Array.isArray(input?.candidates)
    ? input.candidates
    : [];
  const results: ActionResult[] = [];

  // --- .index.ok (:1054). Nothing below runs on an unproven index.
  if (input?.indexOk !== true) {
    const why = (input?.indexWhy ?? [])
      .map((text) => String(text))
      .filter((text) => text !== "")
      .join("; ");
    const reason = why === "" ? "index incomplete" : `index incomplete: ${why}`;
    const key = `index-incomplete: ${reason}`;
    if (candidates.length === 0) {
      results.push({ kind: "refuse", id: "-", acted: false, reason, refusedBy: key });
    }
    for (const candidate of candidates) {
      results.push(refusal(candidate, "refuse", String(candidate?.id ?? "-"), { refusedBy: key, reason }));
    }
    warn("gc apply refused: index incomplete", { why, candidates: candidates.length });
    return results;
  }

  const budget = createBudget({ budgetS: input.budgetS, startedAt: input.startedAt, now: deps.now });
  const maxActions =
    typeof input.maxActions === "number" && Number.isFinite(input.maxActions)
      ? input.maxActions
      : DEFAULT_MAX_ACTIONS;
  const enabledRules =
    input.enabledRules === undefined ? null : new Set<string>(input.enabledRules.map(String));

  /** Set once a phase-wide limit is hit: every remaining candidate is refused with it. */
  let stopped: Refusal | null = null;
  /** Deletes *attempted* this phase — the reference's `n`, incremented before the call. */
  let attempted = 0;
  /** Whether the "no lstat, so `verify` owns the file" warn was already emitted. */
  let warnedNoLstat = false;

  for (const candidate of candidates) {
    const kind: ActionResultKind =
      candidate?.kind === "schedule" ? "schedule" : candidate?.kind === "agent" ? "agent" : "refuse";
    const id = typeof candidate?.id === "string" ? candidate.id : "";
    const considered = (refusal: Refusal): void => {
      results.push({ kind, id: id === "" ? String(candidate?.id ?? "-") : id, acted: false, reason: refusal.reason, refusedBy: refusal.refusedBy });
    };

    if (stopped !== null) {
      considered(stopped);
      continue;
    }

    // --- the row's own verdict (:1078-1079)
    if (candidate?.refusedBy !== null) {
      considered(
        refuseWith(
          typeof candidate?.refusedBy === "string" ? candidate.refusedBy : "rule-refused",
          candidate?.reason ?? "not garbage",
        ),
      );
      continue;
    }

    // --- the rule's toggle (:1061, :1069)
    if (enabledRules !== null) {
      const rule = candidate.rule;
      if (typeof rule !== "string" || !enabledRules.has(rule)) {
        considered(
          refuseWith(
            "rule-off",
            `the rule's toggle is off: ${typeof rule === "string" ? rule : "(unknown rule)"} is not enabled`,
          ),
        );
        continue;
      }
    }

    // --- the budget (:1072)
    if (budget.spent()) {
      stopped = refuseWith(
        "budget",
        `tick budget (SLP_GC_TICK_BUDGET_S=${String(input.budgetS)}) expired: remaining apply work skipped`,
      );
      warn("gc apply stopped: tick budget expired", { budgetS: input.budgetS, attempted });
      considered(stopped);
      continue;
    }

    // --- MAX_ACTIONS (:1073), counted in *attempts*: `n` is incremented before the
    // CLI call (`:1092`), so a delete that fails still consumes its slot.
    if (attempted >= maxActions) {
      stopped = refuseWith("limit", `SLP_GC_MAX_ACTIONS=${maxActions} reached`);
      considered(stopped);
      continue;
    }

    // --- the id and kind the reference validates before acting (:1074-1075)
    if (kind === "refuse") {
      considered(refuseWith("bad-kind", `unknown candidate kind: ${String(candidate?.kind)}`));
      continue;
    }
    if (id === "") {
      considered(refuseWith("bad-id", "the candidate carries no id"));
      continue;
    }

    // --- the record file itself (:1076): `[ -L "$path" ] || [ ! -f "$path" ]` is
    // "file gone or symlink", refused *before* the re-read. Only when the caller
    // carries a `path` and injected `lstat`: this module does no I/O of its own, and
    // with no `path` — or no `lstat` to answer for it — the file's existence is
    // `verify`'s to answer one gate later (a `verify` that answers nothing refuses the
    // candidate). No `path`, nothing to check; no `lstat`, the caller is told so.
    if (typeof candidate.path === "string" && candidate.path !== "") {
      if (deps.lstat === undefined) {
        if (!warnedNoLstat) {
          warnedNoLstat = true;
          warn("gc apply: no lstat supplied, leaving each record file's existence to verify", {
            firstPath: candidate.path,
          });
        }
      } else {
        let shape: { isFile?: boolean; isSymbolicLink?: boolean } | null | undefined;
        try {
          shape = deps.lstat(candidate.path);
        } catch (error) {
          considered(refuseWith("file-gone", `file gone or symlink: lstat failed: ${reasonOf(error)}`));
          continue;
        }
        if (shape === null || shape === undefined) {
          considered(refuseWith("file-gone", "file gone or symlink: the record file no longer exists"));
          continue;
        }
        if (shape.isSymbolicLink === true) {
          considered(refuseWith("file-gone", "file gone or symlink: the record file is a symlink"));
          continue;
        }
        if (shape.isFile !== true) {
          considered(refuseWith("file-gone", "file gone or symlink: the record file is not a regular file"));
          continue;
        }
      }
    }

    // --- the signature the decision was made on (:1080). "" is "unverified".
    if (typeof candidate.sig !== "string" || candidate.sig === "") {
      considered(refuseWith("sig-unverified", "the candidate carries no signature to re-check"));
      continue;
    }

    // --- the fresh full re-evaluation, immediately before the delete (:1077-1084)
    let answer: VerifyAnswer;
    try {
      answer = await deps.verify(candidate);
    } catch (error) {
      considered(refuseWith("fresh-evaluation", `fresh re-evaluation failed: ${reasonOf(error)}`));
      continue;
    }
    const judged = judgeFresh(candidate, answer);
    if (judged !== null) {
      considered(judged);
      continue;
    }

    // --- the delete (:1093). The attempt is counted *before* the call, as the
    // reference does (`:1092` then `:1093`), so a failed delete still spends a slot.
    attempted += 1;
    try {
      if (kind === "schedule") await deps.deleteSchedule(id);
      else await deps.deleteAgent(id);
    } catch (error) {
      considered(refuseWith("delete-failed", `${kind} delete failed: ${reasonOf(error)}`));
      warn("gc apply delete failed", { kind, id, error: reasonOf(error) });
      continue;
    }
    results.push({
      kind,
      id,
      acted: true,
      reason: `${kind} delete ok: ${id}`,
      refusedBy: null,
    });
  }

  return results;
}

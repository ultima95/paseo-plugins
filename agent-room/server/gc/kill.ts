// Kills: the only place the GC port asks for a process to be signalled.
//
// Reference: `docs/gc-port/slp-gc.bash`, `do_apply`'s second loop (`:1104-1168`),
// plus the two helpers only it uses.
//
//   the two rule toggles               :1104-1105  (`$ks` = kill stale, `$km` = kill memory)
//   one consideration per pid          :1108-1109  (the `seen` list)
//   `MAX_KILLS`, per signal            :1110
//   the tick budget, per candidate     :1111       (`budget_expired`, :1008)
//   a signalable pid                   :1112       (`is_uint && > 1`)
//   a killable class                   :1113       (app main / Supervisor / daemon are never signalled)
//   the row is not protected           :1114
//   a fresh full re-evaluation         :1116       (`recheck`, :1028 — before *every* signal)
//   the fresh row is still eligible    :1117-1119
//   the fresh pid is considered once   :1108-1109  (the `seen` list, re-checked *after* the re-read,
//                                                   because the pid that gets signalled is the fresh one)
//   the fresh row's process identity   :1120-1128  (`lstart`: a reused pid is not the process judged)
//   the executable's own proof re-read :1148-1157  (`exe_of`, the `.app`/`/System`/`/Library`
//                                                   refusal, the `SLP_GC_KILL_COMMS` allowlist)
//   the footprint re-read              :1158-1163  (memory kills only)
//   one `SIGTERM`                      :1165       (`"$KILL" -TERM "$pid"`)
//
// Seven properties matter more than tidiness:
//
// 1. **Nothing is signalled without a fresh evaluation of that very candidate.**
//    `recheck` runs before *every* signal (`:1116`), and the reference then selects
//    the row again out of that fresh report and refuses when it cannot find it
//    (`:1117-1119`). Here `reevaluate` is the injected recheck: it is called once
//    per candidate, immediately before the signal, and the *fresh* row decides
//    everything downstream — its eligibility, its class, its protection, its
//    executable, its footprint, and the pid that is signalled. A pid from the
//    candidate is only ever a claim; a pid that came out of a stale report is
//    exactly what this module must not signal.
//
// 2. **A failed recheck stops the run.** The reference sets `stop=1` and breaks
//    when `recheck` fails (`:1116`), rather than retrying the next pid against a
//    re-evaluation it knows is broken. The remaining candidates are refused, not
//    silently dropped.
//
// 3. **The class gate is a whitelist.** Only a class a rule can actually make
//    eligible may be signalled: the agent family (`stale`, `:349`) and the four
//    memory classes (`:360`, `:365`). The app main, the Supervisor and the daemon
//    get the reference's own sentence (`:1113`); every other class — including a
//    class this port has never heard of — is refused, because an unclassified row
//    is not a row whose threat model anybody reasoned about.
//
// 4. **The budget and `maxKills` are per phase, not per candidate.** `maxKills`
//    counts signals across both kinds (`:1110`, `nk` is shared by the two loops),
//    and the budget check precedes every signal (`:1111`). Both are checked before
//    the signal, so a spent tick kills nothing.
//
// 5. **Nothing throws, and no signal is sent from here.** `signal`, `reevaluate`,
//    `now` and the log are injected: this module never touches `process.kill` or
//    the process table. A throw from any of them is a `ActionResult` with
//    `acted: false` — the only thing that leaves this module is a return value.
//
// 6. **`SIGTERM` and nothing else.** The signal name is passed to the injected
//    `signal` so the contract is visible at every call site and assertable in a
//    test; the reference sends `-TERM` once and never escalates (`:1165`).
//
// 7. **The three settings-shaped inputs fail open, out loud.** Absent `kinds`,
//    `killComms` and `memKillMb` mean *no restriction* — both rules on, no
//    executable allowlist, no footprint re-read — because the reference's own
//    parameters work that way (`do_apply 1 1`, `KILL_COMMS` and `KILL_MB` only
//    consulted when set) and because the brief's tests supply none of them. That
//    is permissive, so every absence is logged as a `warn` and each default is
//    pinned by its own test; the tick must always pass the settings it read.

import { type ActionResult, createBudget } from "./apply";
import type { Decision } from "./evaluate";
import type { GcLog } from "./settings";

// `ActionResult`, `createBudget` and the log helper live in `apply.ts` and are
// shared here for the same reason the reference keeps `act` and `budget_expired`
// in its apply section: one `act` row shape and one budget for both loops
// (`:1000-1008`).

/** The two kill rules (`$ks` / `$km`, `:1104-1105`). */
export type KillKind = "stale" | "mem";

/** Both kinds, in the reference's order (`:1104`). */
const BOTH_KINDS: readonly KillKind[] = ["stale", "mem"];

/**
 * The classes a rule can make eligible: the agent family (`agentfam`, `:349`) and
 * the four memory classes (`$memclass`, `:360`), plus `orphan` (a ppid-1 row with
 * agent provenance, `:427`). Anything else is refused by name.
 */
const KILLABLE_CLASSES: ReadonlySet<string> = new Set<string>([
  "claude-child",
  "codex-child",
  "slp-wait",
  "paseo-wait",
  "renderer",
  "gpu",
  "utility",
  "agent-descendant",
  "orphan",
]);

/** The three the reference names outright: never signalled, whatever the rule says (`:1113`). */
const NEVER_SIGNALLED: ReadonlySet<string> = new Set<string>(["app-main", "supervisor", "daemon"]);

/** The classes whose real executable the allowlist is re-read for (`:1150`). */
const EXE_GATED_CLASSES: ReadonlySet<string> = new Set<string>(["orphan", "agent-descendant"]);

/** `SLP_GC_MAX_KILLS` when the caller supplies none (`:87`). */
export const DEFAULT_MAX_KILLS = 10;

/** `is_uint` (`:40`): digits only, at most 12 of them. */
const UINT = /^[0-9]{1,12}$/;

/**
 * One kill candidate: a process row the report's rules judged, plus the fields the
 * re-read compares. `stale`/`overmem` are the two decisions (`evaluate.ts`'s
 * `Decision`); a row that arrives without them cannot be authorised.
 */
export interface KillCandidate {
  pid: number;
  /** `agent-descendant`, `orphan`, `claude-child`, `slp-wait`, … (`:333-380`). */
  class: string;
  /** `$stale`: the orphan rule's verdict for this row (`:345-359`). */
  stale?: Decision;
  /** `$overmem`: the memory rule's verdict for this row (`:360-374`). */
  overmem?: Decision;
  /** `footprint_mb` — re-read for a memory kill (`:1159-1163`). */
  footprint_mb?: number;
  /** Why this process must never be signalled, or null (`entry.protected`, `:350`, `:1114`). */
  protected?: string | null;
  /** The reference's `why` for the decision that made the row eligible (`:1167`). */
  why?: string;
  /**
   * `ps`'s `lstart` — the identity the reference re-reads before a signal
   * (`:1124-1127`). Optional: a candidate without one keeps the pre-fix behaviour
   * (no identity comparison), so nothing newly *requires* it. A candidate that
   * carries one is refused when the fresh row's `lstart` differs or cannot be
   * re-read — that is a reused pid, not the process the report judged.
   */
  lstart?: string;
  /**
   * The parent pid the reference re-checks (`:1123`). Informational here: `ppid`
   * and `comm` are carried for a refusal's text, and comparing them is
   * `reevaluate`'s job (`:1126` is one combined `lstart`/`ppid`/`command` arm).
   */
  ppid?: number;
  /** `comm` / argv basename, for a refusal's text. */
  comm?: string;
  /** The real executable path (`exe_of`, `:1151`), for the allowlist arm. */
  exePath?: string;
  /** The owning agent (`owner`), for a refusal's text. */
  owner?: string | null;
  /** Which proof the orphan rule used (`ledger` / `env`, `:1130-1143`). */
  proof?: "ledger" | "env";
}

export interface KillInput {
  /** The rows the report judged, in its order (`:1166`). */
  candidates: readonly KillCandidate[];
  /** `SLP_GC_MAX_KILLS`: signals per phase (`:87`, `:1110`). A non-finite value kills nothing. */
  maxKills: number;
  /** `SLP_GC_TICK_BUDGET_S`; absent disables the budget gate. */
  budgetS?: number;
  /** `TICK_START`; see `createBudget`. */
  startedAt?: number;
  /**
   * Which rules are enabled (`SLP_GC_KILL_STALE` / `SLP_GC_KILL_MEMORY`, `:1105`).
   *
   * **Absent is permissive**: both rules are treated as enabled — `do_apply 1 1`,
   * which is what the caller asks for by calling this function with no toggle
   * information — and a `warn` is logged to say so. An empty list means neither.
   * The tick must always pass the settings it read here, or a toggle the operator
   * turned off does nothing.
   */
  kinds?: readonly KillKind[];
  /**
   * `SLP_GC_MEM_KILL_MB`: when supplied, a memory kill re-checks the fresh footprint
   * (`:1159`).
   *
   * **Absent is permissive**: no footprint re-read at all, so a memory kill rests on
   * the report's own footprint; a `warn` is logged to say so. The tick must always
   * pass the setting.
   */
  memKillMb?: number;
  /**
   * `SLP_GC_KILL_COMMS`: when supplied, an `orphan`/`agent-descendant` signal also
   * requires the fresh row's real executable to be readable and in this allowlist
   * (`:1148-1157`).
   *
   * **Absent is permissive**: the executable arm is skipped entirely for every
   * class, so a signal rests on the class and the rule alone; a `warn` is logged to
   * say so. The tick must always pass the setting.
   */
  killComms?: readonly string[];
}

export interface KillDeps {
  /**
   * Send one signal. The implementation is `process.kill(pid, "SIGTERM")` in
   * production; a test passes a `vi.fn()`. `SIGTERM` is the only signal name this
   * module ever passes (`:1165`).
   */
  signal: (pid: number, signal: "SIGTERM") => unknown;
  /**
   * The fresh full re-evaluation of one candidate (`recheck`, `:1028`), called
   * immediately before its signal. It must re-read the process (`ps`, `top`, env,
   * the agent records) and answer with the row as it is now — or `null`/`undefined`
   * when the row is gone.
   */
  reevaluate: (candidate: KillCandidate) =>
    | KillCandidate
    | null
    | undefined
    | Promise<KillCandidate | null | undefined>;
  /** `date +%s`; defaults to the wall clock. */
  now?: () => number;
  log?: GcLog;
}

/**
 * A `warn` sink for the log the caller passed (a function, a logger shape, or
 * nothing). A sink that throws is swallowed: this module turns dependency
 * failures into `ActionResult`s, and a broken logger must not become the one
 * exception that escapes.
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

/** A refusal's stable key and its text. */
interface Refusal {
  refusedBy: string;
  reason: string;
}

function refuseWith(refusedBy: string, reason: string): Refusal {
  return { refusedBy, reason };
}

/** `is_uint "$pid" && [ "$pid" -gt 1 ]` (`:1112`): a pid worth signalling at all. */
function signalablePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && UINT.test(String(pid));
}

/** The decision the given kind reads out of a row (`:1118`). */
function decisionFor(row: KillCandidate, kind: KillKind): Decision | undefined {
  return kind === "stale" ? row.stale : row.overmem;
}

/**
 * The class gate (`:1113` and the rules' own class arms): the reference's
 * sentence for the three it names, and a refusal for every class no rule can make
 * eligible.
 */
function classRefusal(cls: unknown): Refusal | null {
  if (typeof cls !== "string" || cls === "") {
    return refuseWith("class", "the candidate carries no class: cannot establish that it is killable");
  }
  if (NEVER_SIGNALLED.has(cls)) return refuseWith("class", `${cls} is never signalled`);
  if (!KILLABLE_CLASSES.has(cls)) {
    return refuseWith(
      "class",
      `${cls} is not a class the kill rules can make eligible: refusing rather than guessing`,
    );
  }
  return null;
}

/** The basename of a path, for the `SLP_GC_KILL_COMMS` comparison (`ebase`, `:1154`). */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * The real-executable arm (`:1148-1157`): unreadable is a refusal, an `.app`
 * bundle or `/System`, `/Library` is a refusal, and the basename has to be in the
 * allowlist.
 */
function exeRefusal(row: KillCandidate, killComms: readonly string[]): Refusal | null {
  const exePath = row.exePath;
  if (typeof exePath !== "string" || exePath === "") {
    return refuseWith("exe", "real executable path unreadable: fail closed");
  }
  if (exePath.includes(".app/") || exePath.startsWith("/System/") || exePath.startsWith("/Library/")) {
    return refuseWith("exe", `executable path ${exePath} is inside an .app bundle or /System, /Library`);
  }
  if (!killComms.includes(baseName(exePath))) {
    return refuseWith("exe", `executable ${exePath} is not in SLP_GC_KILL_COMMS`);
  }
  return null;
}

/**
 * Signal every candidate the reference would signal, and return one
 * `ActionResult` per candidate considered (`act`, `:1000`).
 *
 * The order per candidate is the reference's: de-duplicate the pid (`:1108`),
 * `maxKills` (`:1110`), the budget (`:1111`), the pid (`:1112`), the class
 * (`:1113`), protection (`:1114`), the fresh re-evaluation (`:1116`), the fresh
 * row's own pid (`:1112` again, and de-duplicated again because *this* is the pid
 * that gets signalled, `:1108`), protection/class (`:1117`), eligibility
 * (`:1117-1119`), the process identity (`:1120-1128`), the executable
 * (`:1148-1157`), the memory footprint (`:1158-1163`), then exactly one
 * `SIGTERM` (`:1165`).
 *
 * Never throws: a dependency that throws is a `acted: false` row.
 */
export async function signalCandidates(
  input: KillInput,
  deps: KillDeps,
): Promise<ActionResult[]> {
  const warn = warnLog(deps?.log);
  const candidates: readonly KillCandidate[] = Array.isArray(input?.candidates)
    ? input.candidates
    : [];
  const results: ActionResult[] = [];
  if (candidates.length === 0) return results;

  const kinds: readonly KillKind[] = (input.kinds ?? BOTH_KINDS).filter(
    (kind): kind is KillKind => kind === "stale" || kind === "mem",
  );
  const disabled: readonly KillKind[] = BOTH_KINDS.filter((kind) => !kinds.includes(kind));
  const maxKills =
    typeof input.maxKills === "number" && Number.isFinite(input.maxKills)
      ? Math.max(0, Math.trunc(input.maxKills))
      : 0;
  const budget = createBudget({ budgetS: input.budgetS, startedAt: input.startedAt, now: deps.now });
  const killComms = input.killComms?.map(String);
  const memKillMb =
    typeof input.memKillMb === "number" && Number.isFinite(input.memKillMb)
      ? input.memKillMb
      : undefined;

  // The three settings-shaped inputs fail open when absent (file header, point 7).
  // Say so, every phase: a tick that forgot to pass settings must not be silent.
  if (input.kinds === undefined) {
    warn("gc kill: no rule toggles supplied (kinds absent): both the stale and the memory rule are treated as enabled", {
      default: "both",
    });
  }
  if (killComms === undefined) {
    warn("gc kill: no executable allowlist supplied (killComms absent): SLP_GC_KILL_COMMS is not enforced", {
      gatedClasses: [...EXE_GATED_CLASSES],
    });
  }
  if (memKillMb === undefined) {
    warn("gc kill: no memory threshold supplied (memKillMb absent): the footprint re-read is skipped", {
      default: "no footprint re-read",
    });
  }

  /** Pids already considered this phase (`seen`, `:1103`, `:1108-1109`). */
  const seen = new Set<number>();
  /** Set once a phase-wide limit fires: every remaining candidate is refused with it. */
  let stopped: Refusal | null = null;
  let signalled = 0;

  for (const candidate of candidates) {
    const candidatePid = candidate?.pid;
    const id = typeof candidatePid === "number" ? String(candidatePid) : String(candidatePid ?? "-");
    const considered = (refusal: Refusal): void => {
      results.push({ kind: "kill", id, acted: false, reason: refusal.reason, refusedBy: refusal.refusedBy });
    };

    // --- one consideration per pid (:1108-1109)
    if (typeof candidatePid === "number" && seen.has(candidatePid)) {
      considered(refuseWith("duplicate-pid", `pid ${candidatePid} was already considered this phase`));
      continue;
    }
    if (typeof candidatePid === "number") seen.add(candidatePid);

    if (stopped !== null) {
      considered(stopped);
      continue;
    }

    // --- SLP_GC_MAX_KILLS (:1110)
    if (signalled >= maxKills) {
      stopped = refuseWith(
        "limit",
        `SLP_GC_MAX_KILLS=${maxKills} reached: remaining kills deferred to the next tick`,
      );
      considered(stopped);
      continue;
    }

    // --- the tick budget (:1111)
    if (budget.spent()) {
      stopped = refuseWith(
        "budget",
        `tick budget (SLP_GC_TICK_BUDGET_S=${String(input.budgetS)}) expired: remaining kills skipped`,
      );
      warn("gc kills stopped: tick budget expired", { budgetS: input.budgetS, signalled });
      considered(stopped);
      continue;
    }

    // --- the pid (:1112)
    if (!signalablePid(candidatePid)) {
      considered(refuseWith("bad-pid", `bad pid: ${String(candidatePid)}`));
      continue;
    }

    // --- the class (:1113)
    const classRefused = classRefusal(candidate.class);
    if (classRefused !== null) {
      considered(classRefused);
      continue;
    }

    // --- protection (:1114): the row the report judged
    if (typeof candidate.protected === "string" && candidate.protected !== "") {
      considered(refuseWith("protected", `protected: ${candidate.protected}`));
      continue;
    }

    // --- a fresh full re-evaluation before *every* signal (:1116)
    let fresh: KillCandidate | null | undefined;
    try {
      fresh = await deps.reevaluate(candidate);
    } catch (error) {
      stopped = refuseWith("fresh-evaluation", `fresh re-evaluation failed: ${reasonOf(error)}`);
      warn("gc kills stopped: the fresh re-evaluation failed", { pid: candidatePid, error: reasonOf(error) });
      considered(stopped);
      continue;
    }
    if (fresh === null || fresh === undefined) {
      stopped = refuseWith("fresh-evaluation", "fresh re-evaluation failed: the row is gone");
      considered(stopped);
      continue;
    }
    const freshPid = fresh.pid;
    // `process.kill(0, …)` signals the caller's whole process group and
    // `process.kill(-1, …)` every process it may signal, so the non-positive pids the
    // candidate-level gate refuses have to be refused again here: the pid that gets
    // signalled is the *fresh* one, never the candidate's.
    if (!signalablePid(freshPid)) {
      considered(refuseWith("bad-pid", `bad pid on the fresh re-evaluation: ${String(freshPid)}`));
      continue;
    }
    // From here on the *fresh* row is the authority, pid included: a pid only ever
    // proves itself against the row that was just re-read (:1117-1119).
    if (freshPid !== candidatePid) {
      warn("gc kill: the fresh row carries a different pid", { candidate: candidatePid, fresh: freshPid });
    }
    // --- the fresh pid has to be one this phase has not already considered
    // (:1108-1109). `seen` is consulted for the candidate pid above, before the
    // re-read; two candidates can converge on one fresh pid, and signalling it twice
    // is one SIGTERM too many. A pid equal to the candidate's own was added above and
    // is not a second consideration.
    if (freshPid !== candidatePid && seen.has(freshPid)) {
      considered(
        refuseWith("duplicate-pid", `pid ${freshPid} was already considered this phase (fresh re-evaluation pid)`),
      );
      continue;
    }

    // --- its own proof on the fresh row (:1117): still protected, still killable
    if (typeof fresh.protected === "string" && fresh.protected !== "") {
      considered(refuseWith("protected", `protected: ${fresh.protected}`));
      continue;
    }
    const freshClassRefused = classRefusal(fresh.class);
    if (freshClassRefused !== null) {
      considered(freshClassRefused);
      continue;
    }

    // --- still eligible for an enabled rule (:1104-1105, :1117-1119)
    const authorising = kinds.find((kind) => decisionFor(fresh, kind)?.eligible === true);
    if (authorising === undefined) {
      const offRule = disabled.find((kind) => decisionFor(fresh, kind)?.eligible === true);
      if (offRule !== undefined) {
        considered(refuseWith("rule-off", `the ${offRule} rule's toggle is off: refusing to signal`));
        continue;
      }
      const why = kinds
        .map((kind) => decisionFor(fresh, kind)?.why ?? `${kind}: no decision`)
        .join("; ");
      considered(
        refuseWith(
          "fresh-evaluation",
          `no longer eligible on the fresh full re-evaluation (${why || "no decision for any enabled rule"})`,
        ),
      );
      continue;
    }
    const why = decisionFor(fresh, authorising)?.why ?? "";

    // --- the process identity (`:1120-1128`): a pid is reused, an `lstart` is not.
    // The reference re-reads `ps -p <pid>` and refuses when `lstart`, `ppid` or the
    // command moved between the evaluation and the signal. The one identity this port
    // can compare is the fresh row's `lstart` against the candidate's: a candidate
    // that carries none keeps the pre-fix behaviour (nothing is newly *required*), and
    // one that carries it is refused when the fresh row differs — or cannot answer,
    // because an unreadable identity proves nothing.
    if (typeof candidate.lstart === "string" && candidate.lstart !== "") {
      const freshLstart = fresh.lstart;
      if (typeof freshLstart !== "string" || freshLstart === "") {
        considered(
          refuseWith(
            "identity",
            "lstart/ppid/command changed since evaluation (pid reuse?): the fresh row carries no lstart to compare",
          ),
        );
        continue;
      }
      if (freshLstart !== candidate.lstart) {
        considered(
          refuseWith(
            "identity",
            `lstart/ppid/command changed since evaluation (pid reuse?): ${freshLstart} != ${candidate.lstart}`,
          ),
        );
        continue;
      }
    }

    // --- the executable's own proof (:1148-1157)
    if (killComms !== undefined && EXE_GATED_CLASSES.has(fresh.class)) {
      const exeRefused = exeRefusal(fresh, killComms);
      if (exeRefused !== null) {
        considered(exeRefused);
        continue;
      }
    }

    // --- the footprint re-read, memory kills only (:1158-1163)
    if (authorising === "mem" && memKillMb !== undefined) {
      const footprint = fresh.footprint_mb;
      if (typeof footprint !== "number" || !Number.isFinite(footprint)) {
        considered(refuseWith("footprint", "footprint unreadable on the last re-read: fail closed"));
        continue;
      }
      if (!(footprint > memKillMb)) {
        considered(refuseWith("footprint", `footprint now ${footprint} MB <= ${memKillMb} MB`));
        continue;
      }
    }

    // --- exactly one SIGTERM (:1165)
    signalled += 1;
    seen.add(freshPid);
    try {
      await deps.signal(freshPid, "SIGTERM");
    } catch (error) {
      results.push({
        kind: "kill",
        id: String(freshPid),
        acted: false,
        reason: `kill returned non-zero: ${reasonOf(error)}`,
        refusedBy: "signal-failed",
        pid: freshPid,
        pidClass: fresh.class,
      });
      warn("gc kill failed", { pid: freshPid, error: reasonOf(error) });
      continue;
    }
    results.push({
      kind: "kill",
      id: String(freshPid),
      acted: true,
      reason: `SIGTERM ${fresh.class} (${authorising}): ${why}`,
      refusedBy: null,
      pid: freshPid,
      pidClass: fresh.class,
    });
  }

  return results;
}

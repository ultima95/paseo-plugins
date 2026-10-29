import type { GcAction, GcStatus } from "../shared/gc";

/**
 * The GC screen's rows.
 *
 * Everything here is a pure mapping of one `gc.status` answer (and, for the run
 * log, one `gc.run` answer) into what the screen draws. Two rules shape it:
 *
 * 1. **Nothing is recomputed.** The tick already judged every process row and
 *    every record candidate; the screen reports those verdicts. It never
 *    re-derives `warn` from a threshold, because a second opinion on screen that
 *    disagrees with the tick would make the report and the UI contradict.
 * 2. **Nothing is invented.** `GcStatus` carries no daemon uptime, no ledger
 *    note and no report history, so those rows say so instead of showing a
 *    plausible-looking value from somewhere else (see `UNAVAILABLE`).
 */

/** The three rules the screen may switch, which are the three acting knobs. */
export type RuleKey = "apply" | "killStale" | "killMemory";

/** How a row reads: plain, de-emphasised, or one of the two alert weights. */
export type StatusTone = "normal" | "muted" | "warning" | "danger";

/** What a row says when the read model does not carry the fact. */
const UNAVAILABLE = "not published by gc.status";

export interface StatusRow {
  label: string;
  value: string;
  tone: StatusTone;
}

export interface ProcRowView {
  /** Unique on screen: a pid appears once per tick's table. */
  key: string;
  pid: number;
  /** The tick's class, or `(unclassified)` when it has none. */
  klass: string;
  owner: string;
  /** Formatted footprint, e.g. `1609.4 MB`. */
  footprint: string;
  /** The tick's own warn verdict for this row. */
  warn: boolean;
  /** Empty unless `warn`, so a row can be drawn without a second check. */
  warnText: string;
}

export interface CandidateRow {
  key: string;
  kind: GcAction["kind"] | "agent" | "schedule";
  id: string;
  /** `agent <id>` / `schedule <id>`. */
  label: string;
  /** The rule that matched, or `""` when the payload names none. */
  rule: string;
  /** The refusal text verbatim (it already starts with its rule key), or `""`. */
  refusal: string;
  /** True only for a candidate the tick judged garbage: nothing refused it. */
  actionable: boolean;
}

export interface GcRows {
  status: StatusRow[];
  procs: ProcRowView[];
  candidates: CandidateRow[];
}

/** One line of the screen's run log. */
export interface ActionRow {
  key: string;
  label: string;
  detail: string;
  tone: StatusTone;
}

/**
 * A megabyte figure. The reference prints footprints with one decimal
 * (`%.1f`), while every threshold is a whole number of MB, so a value that is
 * already integral stays short and a measured one keeps its decimal.
 */
export function mbText(value: number): string {
  if (!Number.isFinite(value)) return UNAVAILABLE;
  return Number.isInteger(value) ? `${value} MB` : `${value.toFixed(1)} MB`;
}

/** Local `HH:MM:SS`, or the raw text when the value is not a date. */
function clock(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  const seconds = String(parsed.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** A timestamp row's value: the clock, or the sentence that says there is none. */
function stamp(at: string | null, absent: string): string {
  return at === null || at.length === 0 ? absent : clock(at);
}

/** The daemon's own row in the tick's table, if the tick found it. */
function daemonRow(status: GcStatus): GcStatus["procs"][number] | undefined {
  return status.procs.find((proc) => proc.class === "daemon");
}

/**
 * The daemon's footprint against the two thresholds, in the daemon's own
 * terms: it is never memory-killed, so this is a reading and not a threat —
 * the reference prints the same comparison for the tree.
 */
function thresholdRow(status: GcStatus, daemon: GcStatus["procs"][number] | undefined): StatusRow {
  const warn = mbText(status.settings.memWarnMb);
  const kill = mbText(status.settings.memKillMb);
  if (daemon === undefined) {
    return { label: "footprint vs warn/kill", value: `warn ${warn} · kill ${kill}`, tone: "muted" };
  }
  const footprint = mbText(daemon.footprintMb);
  if (daemon.footprintMb >= status.settings.memKillMb) {
    return { label: "footprint vs warn/kill", value: `${footprint} · over kill ${kill}`, tone: "danger" };
  }
  if (daemon.footprintMb >= status.settings.memWarnMb) {
    return {
      label: "footprint vs warn/kill",
      value: `${footprint} · over warn ${warn} · kill ${kill}`,
      tone: "warning",
    };
  }
  return {
    label: "footprint vs warn/kill",
    value: `${footprint} · below warn ${warn} · kill ${kill}`,
    tone: "normal",
  };
}

/**
 * The index's state, read from the candidates themselves: when `snapshotAgents`
 * or `snapshotSchedules` failed, every candidate arrives refused by
 * `index-incomplete: <why>` (`server/gc/evaluate.ts`). With no candidates there
 * is nothing to conclude from, and the row says that rather than "ok" — an
 * empty list is exactly what a failed index also produces.
 */
function indexRow(status: GcStatus): StatusRow {
  const prefix = "index-incomplete:";
  const refusal = status.candidates.find(
    (candidate) => typeof candidate.refusedBy === "string" && candidate.refusedBy.startsWith(prefix),
  );
  if (refusal !== undefined && typeof refusal.refusedBy === "string") {
    return {
      label: "index",
      value: `refused: ${refusal.refusedBy.slice(prefix.length).trim()}`,
      tone: "danger",
    };
  }
  if (status.candidates.length === 0) {
    return { label: "index", value: "no candidates to judge in the last tick", tone: "muted" };
  }
  return {
    label: "index",
    value: `ok — ${status.candidates.length} record candidates judged`,
    tone: "normal",
  };
}

/** The candidate summary: how many were judged and how many a reclaim would take. */
function candidateSummary(status: GcStatus, actionable: number): StatusRow {
  const total = status.candidates.length;
  if (total === 0) return { label: "candidates", value: "none judged in the last tick", tone: "muted" };
  const applyNote = status.settings.apply ? "" : " · apply is off";
  return {
    label: "candidates",
    value: `${total} judged · ${actionable} reclaimable${applyNote}`,
    tone: actionable > 0 ? "warning" : "normal",
  };
}

/**
 * `gc.status` as the screen's three lists.
 *
 * The status block is ordered the way a person reads it: whether the tick could
 * see anything (identification), what the daemon is doing (pid, footprint vs
 * thresholds, processes over warn), when it ran and will report again, and what
 * it made of the index and the records. The two rows that would need a field the
 * contract does not have say so.
 */
export function toGcRows(status: GcStatus): GcRows {
  const daemon = daemonRow(status);
  const overWarn = status.procs.filter((proc) => proc.warn).length;

  const candidates: CandidateRow[] = status.candidates
    .map((candidate, index) => {
      const refused = typeof candidate.refusedBy === "string" && candidate.refusedBy.length > 0;
      return {
        key: `${String(index)}-${candidate.kind}-${candidate.id}`,
        kind: candidate.kind,
        id: candidate.id,
        label: `${String(candidate.kind)} ${candidate.id}`,
        rule: typeof candidate.rule === "string" ? candidate.rule : "",
        refusal: refused && typeof candidate.refusedBy === "string" ? candidate.refusedBy : "",
        // Fail-closed: only an explicit `null` refusal makes a candidate
        // reclaimable. A payload that omits the field is not a green light.
        actionable: candidate.refusedBy === null,
      };
    })
    // What a reclaim would actually take comes first; the refusals (usually the
    // overwhelming majority) keep their relative order below them.
    .sort((left, right) => Number(right.actionable) - Number(left.actionable));

  const actionable = candidates.filter((candidate) => candidate.actionable).length;

  const statusRows: StatusRow[] = [
    {
      label: "identification",
      value: status.ident.ok ? "ok" : `not identified: ${status.ident.why}`,
      tone: status.ident.ok ? "normal" : "danger",
    },
    {
      label: "daemon",
      value: daemon === undefined ? "no daemon row in the last tick" : `pid ${String(daemon.pid)} · ${mbText(daemon.footprintMb)}`,
      tone: daemon === undefined ? "muted" : "normal",
    },
    // Uptime is a `ps` etime the status contract does not carry.
    { label: "daemon uptime", value: UNAVAILABLE, tone: "muted" },
    thresholdRow(status, daemon),
    {
      label: "processes over warn",
      value:
        status.procs.length === 0
          ? "no process rows in the last tick"
          : `${String(overWarn)} of ${String(status.procs.length)} process rows at or above ${mbText(status.settings.memWarnMb)}`,
      tone: overWarn > 0 ? "warning" : status.procs.length === 0 ? "muted" : "normal",
    },
    {
      label: "last tick",
      value: stamp(status.lastTickAt, "no tick has run yet"),
      tone: status.lastTickAt === null ? "muted" : "normal",
    },
    {
      label: "next report",
      value: stamp(status.nextReportAt, "none scheduled in the last tick"),
      tone: status.nextReportAt === null ? "muted" : "normal",
    },
    indexRow(status),
    candidateSummary(status, actionable),
    // The ledger's own note ("lineage.tsv unreadable", N rows dropped) is in the
    // report text, not in `gc.status`.
    { label: "ledger", value: UNAVAILABLE, tone: "muted" },
  ];

  const procs: ProcRowView[] = status.procs.map((proc) => ({
    key: `pid-${String(proc.pid)}`,
    pid: proc.pid,
    klass: proc.class === null ? "(unclassified)" : proc.class,
    owner: proc.owner === null ? "—" : proc.owner,
    footprint: mbText(proc.footprintMb),
    warn: proc.warn,
    warnText: proc.warn ? `over warn (${mbText(status.settings.memWarnMb)})` : "",
  }));

  return { status: statusRows, procs, candidates };
}

/**
 * The value a rule toggle shows: the saved override when the document has one,
 * otherwise what the last tick actually acted on (the merged settings).
 *
 * The document is the user's layer over the imported `slp-gc.conf` baseline, so
 * an absent key means "whatever the conf says" — not "off".
 */
export function ruleValue(
  document: Partial<Record<RuleKey, boolean>> | null | undefined,
  status: GcStatus,
  key: RuleKey,
): boolean {
  const saved = document?.[key];
  if (typeof saved === "boolean") return saved;
  return status.settings[key] === true;
}

export interface RuleConfirm {
  title: string;
  /** Exactly what the next tick will do, in the rule's own terms. */
  body: string;
  confirm: string;
}

/**
 * The memory kill threshold a confirmation should quote, or `null` while no
 * status has answered yet — in which case the text names the settings key rather
 * than inventing the default.
 */
export type KillThreshold = number | null;

/**
 * The text of a rule toggle's confirmation.
 *
 * This is the guard, not a label: a toggle only moves when the panel is
 * confirmed, and the panel says what the next tick will delete or signal. The
 * sentences name the classes of target precisely — including what is *never*
 * touched — because the whole point of the screen is that a person can see the
 * consequence before it happens.
 *
 * `maxKills` is a settings key the status contract does not carry, so it is
 * named rather than given a number; the same goes for the memory kill threshold
 * until a status supplies it.
 */
export function ruleConfirm(rule: RuleKey, next: boolean, memKillMb: KillThreshold): RuleConfirm {
  if (rule === "apply") {
    return next
      ? {
          title: "Turn on record reclamation",
          body:
            "The next tick will delete records the garbage rules judged eligible: completed room schedules, and " +
            "agents archived for at least 14 days that no live process and no unarchived agent still references. " +
            "Deletion goes through `paseo schedule delete` / `paseo agent delete`; the record file is removed, not " +
            "moved. No process is signalled by this rule.",
          confirm: "Turn on and save",
        }
      : {
          title: "Turn off record reclamation",
          body:
            "No record will be deleted. Candidates are still judged and listed here, and the kill rules cannot act " +
            "while this is off — they need reclamation to be on.",
          confirm: "Turn off and save",
        };
  }

  if (rule === "killStale") {
    return next
      ? {
          title: "Turn on stale-orphan SIGTERM",
          body:
            "The next tick will send SIGTERM to orphan processes only: a process reparented to pid 1 whose ownership " +
            "the lineage ledger can prove and whose command name is on the kill list. One signal per process, at most " +
            "`maxKills` per tick. The daemon, the Supervisor, agent children and anything under the GC's own process " +
            "tree are never signalled. Reclamation must be on for this rule to act.",
          confirm: "Turn on and save",
        }
      : {
          title: "Turn off stale-orphan SIGTERM",
          body:
            "No process will be signalled for being a stale orphan. The memory rule, if it is on, can still signal " +
            "one process above its threshold.",
          confirm: "Turn off and save",
        };
  }

  const kill = memKillMb === null ? null : mbText(memKillMb);
  return next
    ? {
        title: "Turn on memory SIGTERM",
        body:
          `The next tick will send SIGTERM to the single largest process whose footprint is above ${
            kill ?? "the memory kill threshold (`memKillMb` in the gc settings)"
          }, and only ` +
          "if the lineage ledger proves it is an orphan. The daemon, the Supervisor, agent children and every process " +
          "under the GC's own tree are never signalled, whatever their footprint. One signal per tick at most. " +
          "Reclamation must be on for this rule to act.",
        confirm: "Turn on and save",
      }
    : {
        title: "Turn off memory SIGTERM",
        body:
          "No process will be signalled for memory, whatever its footprint. The stale-orphan rule, if it is on, can " +
          "still signal proven orphans.",
        confirm: "Turn off and save",
      };
}

/**
 * One `gc.run` answer as log lines.
 *
 * A refusal row is drawn as a refusal (`tone: "warning"`, the reason verbatim),
 * because a run that did nothing must not read like a run that did something.
 */
export function actionRows(actions: readonly GcAction[]): ActionRow[] {
  return actions.map((action, index) => ({
    key: `${String(index)}-${action.kind}-${action.id}`,
    label: `${action.kind} ${action.id}`,
    detail: action.acted ? action.reason : `no action — ${action.reason}`,
    tone: action.acted ? "normal" : "warning",
  }));
}

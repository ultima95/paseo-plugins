import type { GcAction, GcSettingsDocument, GcStatus } from "../shared/gc";

/**
 * The GC screen's rows.
 *
 * Everything here is a pure mapping of one `gc.status` answer (and, for the run
 * log, one `gc.run` answer) into what the screen draws. Two rules shape it:
 *
 * 1. **Nothing is recomputed.** The tick already judged every process row, every
 *    record candidate and the index; the screen reports those verdicts. It never
 *    re-derives `warn` from a threshold or an index verdict from a refusal string,
 *    because a second opinion on screen that disagrees with the tick would make the
 *    report and the UI contradict.
 * 2. **Nothing is invented.** Every field the status can leave unknown (`null`) is
 *    drawn as "no data yet" in the tick's own words, never as a zero or a guess.
 */

/** The three rules the screen may switch, which are the three acting knobs. */
export type RuleKey = "apply" | "killStale" | "killMemory";

/** How a row reads: plain, de-emphasised, or one of the two alert weights. */
export type StatusTone = "normal" | "muted" | "warning" | "danger";

/** What a numeric row says when the value it carries is not a number. */
const UNAVAILABLE = "not published by gc.status";

/** The status's own words for "no tick has finished yet". */
const NO_TICK = "no tick has run yet";

/** What an unknown fact reads as: a fresh install, not a zero. */
const NO_DATA = "no data yet";

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

/** One `alerts.log` line as the history list draws it, newest first. */
export interface AlertRow {
  key: string;
  /** The line's own stamp, formatted, or "no stamp" when it carries none. */
  at: string;
  text: string;
}

export interface GcRows {
  status: StatusRow[];
  procs: ProcRowView[];
  candidates: CandidateRow[];
  /** `gc.status.alerts`, newest first: the history the design asks for. */
  alerts: AlertRow[];
  /**
   * Whether `gc.status` could read `alerts.log`. `false` is "the history could not
   * be read", which the screen says in those words instead of "nothing recorded".
   */
  alertsReadable: boolean;
}

/** The settings store's state, as much of it as the disclosure depends on. */
export type SettingsStateForNotice =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "invalid"; error: string }
  | { status: "ready" };

/** The banner above the rules and thresholds: nothing to draw, or what to say. */
export interface SettingsNotice {
  tone: "warning" | "danger";
  text: string;
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

/** A date and time — history spans days, so an alert needs more than a clock. */
function dayStamp(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  const date = `${String(parsed.getFullYear())}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(
    parsed.getDate(),
  ).padStart(2, "0")}`;
  return `${date} ${clock(at)}`;
}

/**
 * A `ps` `etime` in seconds as a person reads it: `3 d 04:05:06`, `04:05:06`,
 * `04:05`. `null` is "no uptime has been read", never `0 s` — a zero uptime is a
 * real measurement of a process that just started.
 */
export function uptimeText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return NO_DATA;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(rest).padStart(2, "0");
  if (days > 0) return `${String(days)} d ${hh}:${mm}:${ss}`;
  if (hours > 0) return `${hh}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/**
 * The daemon's row: the process row identification named, else the one the tick
 * classified `daemon`. Two sources because they answer different questions — a
 * row can be classed `daemon` while identification refuses it — and the
 * identified pid is the one the uptime belongs to.
 */
function daemonRow(status: GcStatus): GcStatus["procs"][number] | undefined {
  const identified =
    status.daemonPid === null ? undefined : status.procs.find((proc) => proc.pid === status.daemonPid);
  return identified ?? status.procs.find((proc) => proc.class === "daemon");
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
 * The index's state, from the last tick's own verdict (`gc.status.index`: both
 * record scans complete, with the scans' reasons).
 *
 * Read, not derived: the candidates' refusal strings are the rules' answers and a
 * tick with no candidates at all says nothing about the index, so the screen used
 * to guess and could only ever say "not ok". A fresh install — no tick yet — is
 * its own row, in muted tones rather than an alarm.
 */
function indexRow(status: GcStatus): StatusRow {
  if (status.index.ok) return { label: "index", value: "ok — both record scans completed", tone: "normal" };
  const why = status.index.why.map((line) => line.trim()).filter((line) => line.length > 0);
  if (why.length === 1 && why[0] === NO_TICK) {
    return { label: "index", value: NO_TICK, tone: "muted" };
  }
  return {
    label: "index",
    value: why.length === 0 ? "not ok — the tick gave no reason" : `refused: ${why.join("; ")}`,
    tone: "danger",
  };
}

/**
 * The Paseo tree's footprint against the two thresholds the reference prints it
 * against: the resolved tree warn threshold and the memory kill threshold.
 *
 * Labelled "Paseo tree" on purpose — this is the app main plus its agents (and the
 * proven orphans), not the daemon, and the daemon has its own row. The footprint,
 * the resolved `warnMb` and the `over` verdict are the tick's; only the kill
 * comparison is drawn here, exactly as `thresholdRow` does for the daemon.
 *
 * `tree === null` is a fresh install: no tick has measured the tree, and that is
 * said in words rather than drawn as a zero-byte tree.
 */
function treeRow(status: GcStatus): StatusRow {
  const label = "Paseo tree";
  if (status.tree === null) {
    return { label, value: `${NO_DATA} — no tick has read the tree footprint`, tone: "muted" };
  }
  const tree = status.tree;
  const total = mbText(tree.totalMb);
  const split = `app ${mbText(tree.appMb)} · orphan ${mbText(tree.orphanMb)}`;
  const kill = mbText(status.settings.memKillMb);
  if (tree.totalMb >= status.settings.memKillMb) {
    return { label, value: `${total} · ${split} · over kill ${kill}`, tone: "danger" };
  }
  if (tree.over) {
    return {
      label,
      value: `${total} · ${split} · over warn ${mbText(tree.warnMb)} · kill ${kill}`,
      tone: "warning",
    };
  }
  return {
    label,
    value: `${total} · ${split} · below warn ${mbText(tree.warnMb)} · kill ${kill}`,
    tone: "normal",
  };
}

/** The lineage ledger the last tick read and wrote back. */
function ledgerRow(status: GcStatus): StatusRow {
  const { note, readable, rows } = status.ledger;
  const complaint = note === null || note.trim().length === 0 ? null : note;
  if (!readable) {
    // Not empty: the tick did not read a ledger at all (a failed process phase),
    // or the reader refused the file and said why.
    return {
      label: "ledger",
      value:
        complaint === null
          ? "could not be read — the last tick's process phase failed, so no ledger was read"
          : `could not be read · ${complaint}`,
      tone: complaint === null ? "danger" : "warning",
    };
  }
  if (rows === 0) {
    // No rows and a readable file: a fresh install, or a tick that recorded none.
    return { label: "ledger", value: "no ledger rows yet", tone: "muted" };
  }
  const count = `${String(rows)} row${rows === 1 ? "" : "s"}`;
  if (complaint === null) {
    return { label: "ledger", value: count, tone: "normal" };
  }
  // The reader's note is a warning about the file it read ("N rows dropped"), so
  // it outranks the count in the row's tone.
  return { label: "ledger", value: `${count} · ${complaint}`, tone: "warning" };
}

/** The alert tail, newest first: the design's history, from `alerts.log`. */
export function alertRows(alerts: GcStatus["alerts"]): AlertRow[] {
  return alerts.map((alert, index) => ({
    key: `${String(index)}-${alert.at}-${alert.text.slice(0, 24)}`,
    at: alert.at.length === 0 ? "no stamp" : dayStamp(alert.at),
    text: alert.text,
  }));
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
 * `gc.status` as the screen's lists.
 *
 * The status block is ordered the way a person reads it: whether the tick could
 * see anything (identification), what the daemon is doing (pid, uptime, footprint
 * vs thresholds, processes over warn), when it ran, when it last reported and will
 * report again, and what it made of the index and the records. Every value here is
 * a field the tick published; a `null` reads as "no data yet", never as a zero.
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
      value:
        daemon === undefined
          ? status.daemonPid === null
            ? "no daemon row in the last tick"
            : `identified pid ${String(status.daemonPid)} · no process row for it`
          : `pid ${String(daemon.pid)} · ${mbText(daemon.footprintMb)}`,
      tone: daemon === undefined ? "muted" : "normal",
    },
    // The identified daemon's `ps` etime, published as `uptimeS`. A fresh install
    // has none, and that is the row's own sentence rather than a `0 s`.
    {
      label: "daemon uptime",
      value:
        status.uptimeS === null
          ? `${NO_DATA} — no daemon uptime has been read`
          : uptimeText(status.uptimeS),
      tone: status.uptimeS === null ? "muted" : "normal",
    },
    thresholdRow(status, daemon),
    // The tree is its own row, right under the daemon's: the daemon's footprint is
    // one process inside the tree, and the two readings are not interchangeable.
    treeRow(status),
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
      label: "last report",
      value: stamp(status.lastReportAt, "no report has been written yet"),
      tone: status.lastReportAt === null ? "muted" : "normal",
    },
    {
      label: "next report",
      value: stamp(status.nextReportAt, "none scheduled in the last tick"),
      tone: status.nextReportAt === null ? "muted" : "normal",
    },
    indexRow(status),
    candidateSummary(status, actionable),
    ledgerRow(status),
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

  return {
    status: statusRows,
    procs,
    candidates,
    alerts: alertRows(status.alerts),
    alertsReadable: status.alertsReadable,
  };
}

/**
 * The banner above the rules and thresholds, mirroring the Room screen's settings
 * disclosure.
 *
 * Three of the store's four states are silent — `ready` is the normal case and
 * `loading` is momentary. The other two are the states a person must not have to
 * discover by pressing a toggle:
 *
 * - `error`: the store could not be read at all, so nothing here can be edited or
 *   saved until it loads; the store's own words are shown.
 * - `invalid`: the saved document does not match the schema. The values on screen
 *   therefore come from the last tick — the imported `slp-gc.conf` baseline
 *   layered under nothing — and saving writes a fresh document from those values,
 *   which replaces the broken one (an invalid document supplies a revision but no
 *   overrides, so any other override it carried is not preserved).
 */
export function settingsNotice(state: SettingsStateForNotice): SettingsNotice | null {
  if (state.status === "error") {
    return {
      tone: "danger",
      text: `${state.error} — the rules and thresholds cannot be edited until the settings load.`,
    };
  }
  if (state.status === "invalid") {
    return {
      tone: "warning",
      text:
        "The saved GC settings do not match the schema, so the values shown come from the last tick " +
        "(the imported slp-gc.conf baseline). Saving them replaces the saved document, and any other " +
        "override it carried is lost.",
    };
  }
  return null;
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

/* ------------------------------------------------------------------ *
 * The editable thresholds
 * ------------------------------------------------------------------ */

/** The three thresholds the design says are editable through settings. */
export type ThresholdKey = "memWarnMb" | "memKillMb" | "treeWarnMb";

/**
 * The fields as they are typed. Strings, because a field being edited is often
 * empty or half-typed and a number cannot hold that.
 */
export interface ThresholdDraft {
  memWarnMb: string;
  memKillMb: string;
  treeWarnMb: string;
}

/** The values a valid draft saves. */
export interface ThresholdValues {
  memWarnMb: number;
  memKillMb: number;
  treeWarnMb: number | null;
}

export type ThresholdCheck =
  | { ok: true; values: ThresholdValues }
  | { ok: false; values: null; error: string };

/** The reference's floors: `memKillMb` >= 1024, every threshold >= 1 (`norm_thresholds`). */
export const MEM_KILL_FLOOR_MB = 1024;

/** Whole megabytes, digits only — the same shape the settings schema accepts. */
const WHOLE_MB = /^[0-9]{1,9}$/;

/** One field's text for a saved/acted value; a blank field means "not known here". */
function fieldText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * What the three fields show when the screen opens.
 *
 * The saved `gc` document wins — those are the values the user put there — and the
 * last tick's acted settings supply the rest, because the document is a layer of
 * overrides over the imported `slp-gc.conf` baseline. A value neither source has
 * is left blank: an empty field is "unknown", and saving an empty warn threshold
 * is blocked by `validateThresholds` rather than filled with a guess.
 */
export function thresholdDraft(
  status: GcStatus | null,
  document: GcSettingsDocument | null | undefined,
): ThresholdDraft {
  const saved = (key: ThresholdKey): string => fieldText(document?.[key]);
  const acted = (key: ThresholdKey): string => fieldText(status === null ? null : statusValue(status, key));
  return {
    memWarnMb: saved("memWarnMb") || acted("memWarnMb"),
    memKillMb: saved("memKillMb") || acted("memKillMb"),
    treeWarnMb: saved("treeWarnMb") || acted("treeWarnMb"),
  };
}

/** The threshold a status publishes, wherever it lives in the payload. */
function statusValue(status: GcStatus, key: ThresholdKey): number | null {
  if (key === "treeWarnMb") return status.treeWarnMb;
  return status.settings[key];
}

/**
 * The single gate between the threshold fields and the settings store.
 *
 * The rules are the reference's and the schema's: a whole number of megabytes,
 * `memWarnMb` at least 1, `memKillMb` at least 1024 and never below `memWarnMb`,
 * and `treeWarnMb` either a whole number at least 1 or blank — blank is the
 * reference's `null`, "half of physical RAM". The first failure is returned as one
 * sentence naming the field, so the screen can show it inline instead of saving
 * something the daemon would clamp or reject.
 */
export function validateThresholds(draft: ThresholdDraft): ThresholdCheck {
  const fail = (error: string): ThresholdCheck => ({ ok: false, values: null, error });

  const warn = draft.memWarnMb.trim();
  const kill = draft.memKillMb.trim();
  const tree = draft.treeWarnMb.trim();

  if (!WHOLE_MB.test(warn)) {
    return fail("The warn threshold must be a whole number of megabytes (1 or more).");
  }
  const memWarnMb = Number(warn);
  if (memWarnMb < 1) {
    return fail("The warn threshold must be a whole number of megabytes (1 or more).");
  }

  if (!WHOLE_MB.test(kill)) {
    return fail(`The kill threshold must be a whole number of megabytes (${String(MEM_KILL_FLOOR_MB)} or more).`);
  }
  const memKillMb = Number(kill);
  if (memKillMb < MEM_KILL_FLOOR_MB) {
    return fail(
      `The kill threshold must be at least ${String(MEM_KILL_FLOOR_MB)} MB; ` +
        `the reference clamps anything lower, so it is refused here instead.`,
    );
  }
  if (memKillMb < memWarnMb) {
    return fail(
      `The kill threshold must be at least the warn threshold (${String(memWarnMb)} MB, got ${String(memKillMb)} MB).`,
    );
  }

  if (tree.length === 0) return { ok: true, values: { memWarnMb, memKillMb, treeWarnMb: null } };
  if (!WHOLE_MB.test(tree) || Number(tree) < 1) {
    return fail("The tree threshold must be a whole number of megabytes (1 or more), or blank for half of RAM.");
  }

  return { ok: true, values: { memWarnMb, memKillMb, treeWarnMb: Number(tree) } };
}


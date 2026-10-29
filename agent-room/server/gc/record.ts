// The memory record: one JSONL sample, its rotation, and the rate-limited alert.
//
// Reference (`agent-room/docs/gc-port/slp-gc.bash`, byte-identical to the deployed copy):
//
//   rotate                 :1181-1184  (`mv -f` the live file to `<file>.1` when it would overflow)
//   do_record              :1185-1235  (the sample, the append, the three alert reasons, the stamp)
//     the sample's shape   :1203-1211  (jq -nc: ts, epoch, procs[30], orphans, tree, totals,
//                                       overall, system)
//     the rotate + append  :1213-1214  (`rotate memory.jsonl 5242880 <bytes of line+newline>`, then
//                                       `printf '%s\n' >> memory.jsonl`)
//     the alert reasons    :1215-1219  (a process footprint >= warn, the Paseo tree >= tree-warn, a
//                                       proven orphan > 1024 MB)
//     the rate limit       :1220-1224  (`NOW - stamp >= 900`, then the stamp is overwritten)
//     alerts.log + notify  :1225-1232  (`rotate alerts.log 1048576 ${#msg}`, append, osascript)
//     the state dir's mode :1187       (`chmod 700` when it is not already ours:700)
//
// Four properties matter more than tidiness:
//
// 1. **One call appends exactly one line, in the reference's shape.** The object below has the
//    eight keys of :1206-1211 in that order, the `procs` rows are the reference's ten fields
//    sorted by descending footprint and capped at thirty, and the `orphans` rows its eight fields.
//    A consumer (a chart, an operator's jq one-liner) can therefore read a line by key without a
//    shape test, exactly as it can read `report --json`.
//
// 2. **Rotation never truncates and never loses the live file.** `rotate` is a rename — the one
//    filesystem operation here that cannot leave a half-written file — and it happens *before* the
//    append, so the new sample always lands in a fresh file. A rename that fails (a predecessor
//    that is a directory, a read-only parent) is swallowed: the live file keeps every byte it had
//    and the new line is appended to it, which costs an oversized file, never a sample. Nothing in
//    this module ever opens the live file for truncation.
//
// 3. **At most one alert per window, and the stamp is the only state.** A trip inside the window
//    is silent — no line in `alerts.log`, no notification, `null` returned — while a trip at or
//    after the boundary alerts again. An unreadable, non-numeric or absent stamp reads as `0`
//    (`is_uint "$last" || last=0`, :1222), so a corrupt stamp can only ever *cause* an alert, which
//    is the harmless direction. The stamp is written before the alert is recorded, as the
//    reference does (:1224 before :1230).
//
// 4. **Nothing here can fail the caller for a reason outside the sample itself.** `rotate` answers
//    a boolean and throws to nobody; `notify` is called inside a `try` that swallows everything
//    (the reference's `|| true`, :1232), and its failure cannot change the returned alert text. A
//    daemon-less machine, a missing `osascript`, a notification centre that is not running: each
//    costs a popup, never the alert line. The two writes that *are* the record — the state
//    directory and the append — do reject, because a tick that could not record must not believe
//    it did.
//
// The `system` block is the one input this module cannot derive: the reference reads `vm_stat`
// and `sysctl vm.swapusage` itself (:1194-1202), which the port does through its exec seam in the
// tick. Every field defaults to the reference's own fallback for a value it could not read
// (`null`, and `""` for the raw sysctl text), so a caller that supplies nothing gets the shape
// without inventing numbers.

import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_GC_SETTINGS } from "./settings";
import type { ClassTotal, GcReport, OverallTotal, ReportOrphanRow, ReportProcRow, ReportTree } from "./report";

// ---------------------------------------------------------------------------
// Constants (slp-gc.bash:1213, :1223, :1229, :1216-1218, :1207)
// ---------------------------------------------------------------------------

/** `rotate "$STATE/memory.jsonl" 5242880 …` (:1213) — 5 MB. */
export const MEMORY_MAX_BYTES = 5_242_880;
/** `rotate "$STATE/alerts.log" 1048576 …` (:1229) — 1 MB. */
export const ALERTS_MAX_BYTES = 1_048_576;
/** `[ $((NOW - last)) -ge 900 ]` (:1223), as the knob this port names in minutes. */
export const ALERT_WINDOW_MINUTES = 15;
/** `.[:30]` on the sample's process list (:1207). */
export const MEMORY_SAMPLE_PROCS = 30;
/** A proven orphan above this many MB always alerts (:1218, :1227). */
export const ORPHAN_ALERT_MB = 1024;
/** `display notification … with title "slp-gc"` (:1232). */
export const NOTIFY_TITLE = "slp-gc";
/** The reference's notification body (:1232): the alert itself is in `alerts.log`. */
export const NOTIFY_BODY = "Paseo memory alert (see alerts.log)";
/** `run_to 10 "$OSASCRIPT"` (:1232). */
export const OSASCRIPT_TIMEOUT_MS = 10_000;

/** `<state>/memory.jsonl` (:1213). */
export const MEMORY_FILE = "memory.jsonl";
/** `<state>/alerts.log` (:1229). */
export const ALERTS_FILE = "alerts.log";
/** `<state>/.alert-stamp` (:1221, :1224). */
export const ALERT_STAMP_FILE = ".alert-stamp";

/** `is_uint` (:40): digits only, at most twelve of them. */
const UINT = /^[0-9]{1,12}$/;

// ---------------------------------------------------------------------------
// Rotation (rotate, slp-gc.bash:1181-1184)
// ---------------------------------------------------------------------------

/**
 * `rotate <file> <max bytes> <bytes about to be added>`: keep the file and one predecessor
 * (:1181-1184).
 *
 * Two details are the reference's, and both are load-bearing:
 *
 * - the test is `s + incoming > max`, **strictly** — a file that lands exactly on the cap is not
 *   rotated, so the cap is the smallest maximum that holds the pair;
 * - the rotation is `mv -f "$1" "$1.1"`, i.e. one `rename` over whatever the predecessor was. The
 *   older predecessor is replaced, not accumulated, so the state dir holds exactly two files.
 *
 * A size that cannot be read (`fsize` empty, or a value that is not `is_uint`) means "do not
 * rotate", which is also what the reference's `is_uint "$s" && …` does. The rename is attempted
 * only after that check, and its failure — a predecessor that is a directory, a read-only parent,
 * a filesystem that refuses — is answered with `false` rather than an exception: the live file is
 * then untouched, and the caller's append still lands. `true` means the file is now `<file>.1`
 * and the live path is gone.
 */
export function rotate(file: string, maxBytes: number, incomingBytes: number): boolean {
  const size = fileSize(file);
  if (size === null) return false;
  // `is_uint "$s"` bounds the digits at twelve; a longer size is not a size the reference trusts.
  if (String(size).length > 12) return false;
  if (!(size + incomingBytes > maxBytes)) return false;
  try {
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/** `fsize` (:51-55) without following symlinks; `null` when it cannot be read. */
function fileSize(file: string): number | null {
  try {
    const info = statSync(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The sample's shape (slp-gc.bash:1203-1211)
// ---------------------------------------------------------------------------

/**
 * One process row of the sample (:1207): `{pid, ppid, class, owner, exe, etime_s, mem_mb,
 * cmprs_mb, rss_mb, footprint_mb}`, in that key order.
 *
 * `class` and `owner` are nullable in the reference's table, and every numeric field is widened to
 * `null` here for the same reason the report's rows are: a foreign or half-built report must cost
 * a field, never an exception on the way to the disk.
 */
export interface MemorySampleProc {
  pid: number | null;
  ppid: number | null;
  class: string | null;
  owner: string | null;
  exe: string | null;
  etime_s: number | null;
  mem_mb: number | null;
  cmprs_mb: number | null;
  rss_mb: number | null;
  footprint_mb: number | null;
}

/**
 * One orphan row of the sample (:1208): `{pid, comm, owner, proof, proven, protected, etime_s,
 * footprint_mb}` — note that the sample keeps `proven` and `protected` (the two facts an alert
 * and a future kill both read) and drops `cmd`, exactly as the report does.
 */
export interface MemorySampleOrphan {
  pid: number | null;
  comm: string | null;
  owner: string | null;
  proof: string | null;
  proven: boolean | null;
  protected: string | null;
  etime_s: number | null;
  footprint_mb: number | null;
}

/**
 * The `system` block (:1211): the machine-wide memory counters.
 *
 * Every value is `null` when it could not be read, and `swap_raw` keeps the sysctl text verbatim
 * (the empty string when `sysctl` printed nothing) — that is the reference's own fallback ladder
 * at :1201-1202. The port does not run `vm_stat`/`sysctl` here: the caller collects them through
 * the exec seam and hands them in, so this module stays a pure writer plus its two files.
 */
export interface MemorySampleSystem {
  vm_page_size: number | null;
  compressor_stored_pages: number | null;
  compressor_occupied_pages: number | null;
  swapouts: number | null;
  pageouts: number | null;
  swap_used_mb: number | null;
  swap_raw: string;
}

/** One line of `memory.jsonl` — the eight keys of :1206-1211, in the reference's order. */
export interface MemorySample {
  ts: string;
  epoch: number;
  procs: MemorySampleProc[];
  orphans: MemorySampleOrphan[];
  tree: ReportTree | null;
  totals: ClassTotal[];
  overall: OverallTotal | null;
  system: MemorySampleSystem;
}

/**
 * The part of a report the record reads.
 *
 * A `GcReport` satisfies it as it is; so does a hand-built report in a test. Everything is
 * optional because a record must still produce its line from a report whose process section was
 * degraded — a lost section costs fields, never the sample.
 */
export interface RecordReport {
  generated?: string;
  procs?: {
    procs?: readonly ReportProcRow[];
    orphans?: readonly ReportOrphanRow[];
    tree?: ReportTree;
    totals?: readonly ClassTotal[];
    overall?: OverallTotal;
    warnMb?: number;
  };
}

/** `display notification … with title …` (:1232). Failures are swallowed; see `alertNow`. */
export type Notify = (title: string, body: string) => void;

export interface RecordSampleInput {
  /** `<state>`: `~/Library/Logs/slp-gc` in production, a temp dir in a test. */
  stateDir: string;
  report: RecordReport | GcReport;
  /** `$NOW`, epoch seconds — the only clock this module reads. */
  now: number;
  /** The rate-limit window in minutes (:1223's 900 s); defaults to 15. */
  alertStampMinutes?: number;
  /** The machine counters (:1194-1211); omitted fields read as the reference's `null`s. */
  system?: Partial<MemorySampleSystem>;
  /** The notification seam. Defaults to `osascript`; a test injects a no-op. */
  notify?: Notify;
}

export interface RecordSampleResult {
  /** The object written to `memory.jsonl`, as it was written. */
  line: MemorySample;
  /** The `alerts.log` line, or `null` when no reason tripped or the window suppressed it. */
  alert: string | null;
}

/** `iso_now` (:48): `date -u +%Y-%m-%dT%H:%M:%SZ`. */
function isoNow(now: number): string {
  return new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A finite number, or `null` — the reference's `is_uint … || null` arm (:1201). */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** jq prints a number with no trailing `.0`; `String` agrees on every value the report carries. */
function jqNumber(value: number): string {
  return String(value);
}

/** `sort_by(-.footprint_mb) | .[:30]`, then the ten fields of :1207, in its order. */
function sampleProcs(rows: readonly ReportProcRow[]): MemorySampleProc[] {
  const ranked = [...rows].sort(
    (left, right) => (numOrNull(right?.footprint_mb) ?? 0) - (numOrNull(left?.footprint_mb) ?? 0),
  );
  return ranked.slice(0, MEMORY_SAMPLE_PROCS).map((row) => ({
    pid: numOrNull(row?.pid),
    ppid: numOrNull(row?.ppid),
    class: textOrNull(row?.class),
    owner: textOrNull(row?.owner),
    exe: textOrNull(row?.exe),
    etime_s: numOrNull(row?.etime_s),
    mem_mb: numOrNull(row?.mem_mb),
    cmprs_mb: numOrNull(row?.cmprs_mb),
    rss_mb: numOrNull(row?.rss_mb),
    footprint_mb: numOrNull(row?.footprint_mb),
  }));
}

/** The eight fields of :1208, in its order. */
function sampleOrphans(rows: readonly ReportOrphanRow[]): MemorySampleOrphan[] {
  return rows.map((row) => ({
    pid: numOrNull(row?.pid),
    comm: textOrNull(row?.comm),
    owner: textOrNull(row?.owner),
    proof: textOrNull(row?.proof),
    proven: typeof row?.proven === "boolean" ? row.proven : null,
    protected: textOrNull(row?.protected),
    etime_s: numOrNull(row?.etime_s),
    footprint_mb: numOrNull(row?.footprint_mb),
  }));
}

/** The `system` block with the reference's fallbacks (:1201-1202). */
function sampleSystem(input: Partial<MemorySampleSystem> | undefined): MemorySampleSystem {
  return {
    vm_page_size: numOrNull(input?.vm_page_size),
    compressor_stored_pages: numOrNull(input?.compressor_stored_pages),
    compressor_occupied_pages: numOrNull(input?.compressor_occupied_pages),
    swapouts: numOrNull(input?.swapouts),
    pageouts: numOrNull(input?.pageouts),
    swap_used_mb: numOrNull(input?.swap_used_mb),
    swap_raw: typeof input?.swap_raw === "string" ? input.swap_raw : "",
  };
}

/** The sample, assembled in the reference's key order (:1206-1211). */
export function buildSample(
  report: RecordReport | GcReport,
  now: number,
  system?: Partial<MemorySampleSystem>,
): MemorySample {
  const procs = (report as RecordReport)?.procs;
  return {
    ts: isoNow(now),
    epoch: now,
    procs: sampleProcs(procs?.procs ?? []),
    orphans: sampleOrphans(procs?.orphans ?? []),
    tree: procs?.tree ?? null,
    totals: [...(procs?.totals ?? [])],
    overall: procs?.overall ?? null,
    system: sampleSystem(system),
  };
}

// ---------------------------------------------------------------------------
// The alert reasons (slp-gc.bash:1215-1234)
// ---------------------------------------------------------------------------

/**
 * The alert's reasons, each a fragment of the reference's message. Every one is empty when its
 * arm did not trip, which is how :1219 decides whether there is an alert at all.
 */
export interface AlertReasons {
  /** `footprint >= $WARN_MB MB: …` — :1216, :1225. */
  over: string;
  /** `Paseo tree … MB >= … MB (…)` — :1217, :1226. */
  tover: string;
  /** `orphaned agent descendant(s) > 1024 MB: …` — :1218, :1227. */
  oover: string;
}

/**
 * The three reasons of :1216-1218, as text.
 *
 * Each is a verbatim port of one jq expression, including its quirks:
 *
 * - `over` reads the **whole** table (`(.procs + (.orphans | map(select(.proven))))`), not the
 *   sample's thirty rows, and it includes a *proven* orphan — an unproven orphan is a suspicion,
 *   and a suspicion is never announced. `>=` is inclusive.
 * - `tover` is the tree's own `over` flag, not a recomputation: `SLP_GC_TREE_WARN_MB` decides it.
 * - `oover` is `>` 1024 MB, strictly, and only for `proven` orphans: at exactly 1024 MB the first
 *   arm already covers it when the warn threshold is that low, and an unproven orphan never
 *   alerts here at all.
 *
 * A row whose footprint is not a finite number matches no arm (the reference's jq would abort the
 * whole run on such a value; matching nothing is the protective answer).
 */
export function alertReasons(
  report: RecordReport | GcReport,
  warnMb: number = DEFAULT_GC_SETTINGS.memWarnMb,
): AlertReasons {
  const procs = (report as RecordReport)?.procs;
  const rows = procs?.procs ?? [];
  const orphans = procs?.orphans ?? [];

  const over: string[] = [];
  const tripped = [
    ...rows,
    ...orphans.filter((row) => row?.proven === true),
  ];
  for (const row of tripped) {
    const footprint = numOrNull(row?.footprint_mb);
    if (footprint === null || !(footprint >= warnMb)) continue;
    const klass = typeof row?.class === "string" ? row.class : "null";
    over.push(`${klass} pid ${numOrNull(row?.pid) ?? "null"} ${jqNumber(footprint)} MB`);
  }

  const tree = procs?.tree;
  const tover =
    tree?.over === true
      ? `Paseo tree ${jqNumber(numOrNull(tree.totalMb) ?? 0)} MB >= ${jqNumber(
          numOrNull(tree.warnMb) ?? 0,
        )} MB (app subtree ${jqNumber(numOrNull(tree.appMb) ?? 0)}, proven orphans ${jqNumber(
          numOrNull(tree.orphanMb) ?? 0,
        )})`
      : "";

  const oover: string[] = [];
  for (const row of orphans) {
    if (row?.proven !== true) continue;
    const footprint = numOrNull(row?.footprint_mb);
    if (footprint === null || !(footprint > ORPHAN_ALERT_MB)) continue;
    const owner = typeof row?.owner === "string" ? row.owner : "?";
    oover.push(
      `${textOrNull(row?.comm) ?? "null"} pid ${numOrNull(row?.pid) ?? "null"} ${jqNumber(
        footprint,
      )} MB owner ${owner}`,
    );
  }

  return { over: over.join("; "), tover, oover: oover.join("; ") };
}

/** :1225-1227: the message's three arms, joined by ` | `, in the reference's order. */
function alertText(reasons: AlertReasons, warnMb: number): string {
  let msg = "";
  if (reasons.over !== "") msg = `footprint >= ${jqNumber(warnMb)} MB: ${reasons.over}`;
  if (reasons.tover !== "") msg = msg === "" ? reasons.tover : `${msg} | ${reasons.tover}`;
  if (reasons.oover !== "") {
    const arm = `orphaned agent descendant(s) > ${ORPHAN_ALERT_MB} MB: ${reasons.oover}`;
    msg = msg === "" ? arm : `${msg} | ${arm}`;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// The notification path (slp-gc.bash:1232)
// ---------------------------------------------------------------------------

/** Escape one AppleScript string literal: only `\` and `"` are special inside. */
function applescriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The default notification: `run_to 10 osascript -e 'display notification … with title …'`,
 * stderr and stdout dropped, any failure ignored (:1232).
 *
 * It is never allowed to matter: the spawn happens inside `try`, its non-zero exit is not read,
 * and it is given the reference's 10 s budget so a wedged notification centre cannot hold the
 * tick. A machine without `osascript` (Linux, a container) costs one ignored `ENOENT`.
 */
export const osascriptNotify: Notify = (title, body) => {
  try {
    spawnSync(
      "/usr/bin/osascript",
      ["-e", `display notification ${applescriptString(body)} with title ${applescriptString(title)}`],
      { timeout: OSASCRIPT_TIMEOUT_MS, stdio: "ignore" },
    );
  } catch {
    // `|| true`
  }
};

/** Call `notify`, swallowing everything it can do: throw, return garbage, not exist. */
function notifyQuietly(notify: Notify | undefined, title: string, body: string): void {
  const sink = notify ?? osascriptNotify;
  try {
    sink(title, body);
  } catch {
    // The reference's `|| true`: a failed notification is not a failed record.
  }
}

// ---------------------------------------------------------------------------
// State dir, stamp, and the record itself
// ---------------------------------------------------------------------------

/**
 * `mkdir -p "$STATE"` plus the `chmod 700` tightening of :1187.
 *
 * The state dir holds the memory history and the stamp, and the reference refuses to leave it
 * group- or world-readable. Creating it uses `0700`; an existing dir that is wider than that is
 * tightened, and a `chmod` the caller may not perform is ignored rather than fatal.
 */
async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    const info = await stat(stateDir);
    if ((info.mode & 0o077) !== 0) await chmod(stateDir, 0o700);
  } catch {
    // Not statable or not chmod-able: the append below is the real test of usability.
  }
}

/** `[ -f "$STATE/.alert-stamp" ] && cat …; is_uint "$last" || last=0` (:1221-1222). */
async function readStamp(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  const trimmed = text.trim();
  return UINT.test(trimmed) ? Number(trimmed) : 0;
}

/** `echo "$NOW" > "$STATE/.alert-stamp"` (:1224), mode `0600`: the stamp is this tool's alone. */
async function writeStamp(path: string, now: number): Promise<void> {
  await writeFile(path, `${now}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Record one memory sample: the line, the rotation, `alerts.log`, the stamp, the notification.
 *
 * The order is the reference's (:1213-1232) and each step matters:
 *
 * 1. the state dir is created (and tightened) first, because everything else writes into it;
 * 2. the line is built **before** anything is rotated, so a report that cannot be serialised
 *    costs nothing (`record: could not build the sample`, :1212);
 * 3. `memory.jsonl` is rotated against the size of the line about to be appended — the sample is
 *    what pushes the file over the cap, so the cap is never exceeded by a line that would have fit;
 * 4. exactly one newline-terminated line is appended;
 * 5. only then are the three reasons evaluated, the stamp consulted, and an alert (if any) written
 *    to `alerts.log` and handed to `notify`.
 *
 * `alert` is the `alerts.log` line — `"<iso> ALERT <arms>"` — which is also what the reference
 * prints on stdout (:1231), and `null` when no arm tripped *or* the window suppressed it. Those two
 * silences are deliberately indistinguishable to a caller: neither is an error, and the stamp says
 * which happened. A `notify` that throws changes neither the written line nor the return value.
 */
export async function recordSample(input: RecordSampleInput): Promise<RecordSampleResult> {
  const { stateDir, now } = input;
  await ensureStateDir(stateDir);

  const report = input.report;
  const warnMb = numOrNull((report as RecordReport)?.procs?.warnMb) ?? DEFAULT_GC_SETTINGS.memWarnMb;
  const line = buildSample(report, now, input.system);
  const text = `${JSON.stringify(line)}\n`;

  const memoryFile = join(stateDir, MEMORY_FILE);
  rotate(memoryFile, MEMORY_MAX_BYTES, Buffer.byteLength(text, "utf8"));
  // The append creates the file `0600`; an existing file keeps the mode it already has.
  await appendFile(memoryFile, text, { encoding: "utf8", mode: 0o600 });

  const reasons = alertReasons(report, warnMb);
  const message = alertText(reasons, warnMb);
  if (message === "") return { line, alert: null };

  const windowSeconds = alertWindowSeconds(input.alertStampMinutes);
  const stampPath = join(stateDir, ALERT_STAMP_FILE);
  const last = await readStamp(stampPath);
  // `[ $((NOW - last)) -ge 900 ]`: the boundary alerts, and a stamp in the future (a clock that
  // went backwards) suppresses — the reference's own arithmetic, sign included.
  if (now - last < windowSeconds) return { line, alert: null };

  await writeStamp(stampPath, now);

  const alert = `${isoNow(now)} ALERT ${message}`;
  const alertsFile = join(stateDir, ALERTS_FILE);
  // `${#msg}` (:1229) is the character count of the line, without its newline.
  rotate(alertsFile, ALERTS_MAX_BYTES, alert.length);
  await appendFile(alertsFile, `${alert}\n`, { encoding: "utf8", mode: 0o600 });

  notifyQuietly(input.notify, NOTIFY_TITLE, NOTIFY_BODY);
  return { line, alert };
}

/**
 * The window in seconds: `alertStampMinutes` minutes, defaulting to the reference's 900 s.
 *
 * Anything that is not a non-negative finite number falls back to the default, so a caller cannot
 * disable the rate limit by passing `NaN` (or make it negative and alert on every tick) by
 * accident: "no window" is not a state this module has.
 */
function alertWindowSeconds(minutes: number | undefined): number {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    return ALERT_WINDOW_MINUTES * 60;
  }
  return minutes * 60;
}

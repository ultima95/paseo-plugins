// Process collection and classification — the `ps`/`top` half of the GC port.
//
// Everything in this module is a transliteration of the reference tool
// (`agent-room/docs/gc-port/slp-gc.bash`, byte-identical to the deployed copy):
//
//   parse_etime          slp-gc.bash:256-260 (`def parse_etime`, inside PROCS_JQ),
//                        with the failure answer of the bash `etime_s` (:70-77)
//   classify             slp-gc.bash:262-276 (`def classify`, inside PROCS_JQ)
//   parsePs              slp-gc.bash:282-286 (the `capture(...)` + `$rows` block)
//   parseTop             slp-gc.bash:605-612 (`top_parse`)
//   collect_ps field list slp-gc.bash:563
//
// Two properties matter more than tidiness:
//
// 1. Nothing here throws. A `ps` row or a `top` row that cannot be read is
//    counted (`badRows`) or skipped, and the rest of the table survives — the
//    same fail-soft behaviour as the reference's `capture(...) // {bad: .}`.
// 2. The class order is load-bearing (slp-gc.bash:262-276): `app-main` before
//    the helpers, the terminal-worker / paseo-wait rows before the generic
//    helper rows, and `claude-child` only with all three of its flags. Reorder
//    the chain and rows silently change class, which changes kill eligibility.
//
// The reference's own raw fields (`etime` and `rss` as strings) are dropped on
// purpose: only `etime_s` and `rss_mb` are read downstream (slp-gc.bash:310,
// 358, 361), and `ProcRow` stays the shape the decision code already assumes.

/**
 * The classes the reference `classify` can return (slp-gc.bash:262-276).
 *
 * Two further class values exist downstream but are not products of
 * classification: `agent-descendant` (a row under an agent child) and `orphan`
 * (a ppid-1 row with agent provenance, slp-gc.bash:303, 427). They belong to
 * the process-table builder, not here.
 */
export type ProcClass =
  | "app-main"
  | "supervisor"
  | "daemon"
  | "terminal-worker"
  | "paseo-wait"
  | "renderer"
  | "gpu"
  | "utility"
  | "helper-other"
  | "slp-wait"
  | "claude-child"
  | "codex-child";

/** One parsed `ps` row (slp-gc.bash:284-285). */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** `etime` in seconds; `-1` when the field could not be read. */
  etime_s: number;
  /** `rss` converted from KB and rounded to one decimal (jq `mb1`). */
  rss_mb: number;
  /** `lstart`, whitespace-collapsed to `Mon Oct 27 10:00:00 2026`. */
  lstart: string;
  /** The command with its argv, verbatim. */
  cmd: string;
}

/** The `ps` table plus what could not be read (slp-gc.bash:283, 286). */
export interface ParsedPs {
  rows: ProcRow[];
  /** Rows the capture regex rejected; counted, never fatal. */
  badRows: number;
  /** Pids that appear more than once; identity refuses to act when it is non-zero. */
  dupes: number;
}

/** One `top` sample: physical footprint and its compressed part, in MB. */
export interface TopRow {
  mem: number;
  cmprs: number;
}

const UINT = /^[0-9]+$/;

/** `ps`'s `etime` field: `[[dd-]hh:]mm:ss` (the capture regex allows exactly this). */
const PS_ETIME = /^[0-9:-]+$/;

/**
 * The five `lstart` tokens, collapsed: `Thu Oct 29 11:43:21 2026`
 * (slp-gc.bash:282 captures them as one group; :285 collapses the whitespace).
 */
const PS_LSTART = /^[A-Za-z]{3} [A-Za-z]{3} [0-9]+ [0-9:]+ [0-9]{4}$/;

/** The number of `ps` fields that precede `command` (pid ppid pgid etime rss + lstart×5). */
const PS_FIELDS_BEFORE_CMD = 10;

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/**
 * `parse_etime` (slp-gc.bash:256-260): `[[dd-]hh:]mm:ss` -> seconds, base 10.
 *
 * The reference `def parse_etime` is total for anything the `ps` capture can
 * let through; the bash `etime_s` (:70-77) answers `-1` for a field it cannot
 * read, and so does this function. That is the fail-closed answer: an
 * unreadable age can never satisfy a minimum-age rule.
 */
export function parseEtime(input: string): number {
  const segments = input.split("-");
  const clock = (segments[segments.length - 1] ?? "").split(":");
  // `split("-")` of a value without a dash is one segment, so "no day part".
  const dayField = segments.length === 2 ? segments[0] : "0";
  if (clock.length > 3) return -1;
  if (!UINT.test(dayField)) return -1;
  const day = Number(dayField);

  const parts: number[] = [];
  for (const part of clock) {
    if (!UINT.test(part)) return -1;
    parts.push(Number(part));
  }

  if (parts.length === 3) return day * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return day * 86400 + parts[0] * 60 + parts[1];
  return day * 86400;
}

/**
 * `classify` (slp-gc.bash:262-276), in the reference's order.
 *
 * jq's `has(s)` is `contains(s)` (a substring test) and `test(re)` is an
 * unanchored Oniguruma match; `\z` is end-of-string, which is `$` here because
 * a command never contains a newline. The chain stops at the first match, which
 * is what makes the order load-bearing.
 */
export function classify(cmd: string): ProcClass | null {
  const has = (needle: string): boolean => cmd.includes(needle);

  if (/^(?:\/[^ ]*)?\/Paseo\.app\/Contents\/MacOS\/Paseo(?: |$)/.test(cmd)) return "app-main";
  if (/^Paseo Supervisor/.test(cmd)) return "supervisor";
  if (/^Paseo Daemon/.test(cmd)) return "daemon";
  if (has("Paseo Helper") && has("terminal/terminal-worker-process.js")) return "terminal-worker";
  if (has("node-entrypoint-runner.js") && /dist\/index\.js wait /.test(cmd)) return "paseo-wait";
  if (/^(?:\/[^ ]*\/)?paseo(?: [^ ]+)* wait [0-9a-f-]{36}/.test(cmd)) return "paseo-wait";
  // The parenthesised helper names come first: "Paseo Helper (Renderer)" alone
  // is enough, without any --type flag.
  if (has("Paseo Helper (Renderer)") || (has("Paseo Helper") && has("--type=renderer"))) {
    return "renderer";
  }
  if (has("Paseo Helper (GPU)") || (has("Paseo Helper") && has("--type=gpu-process"))) return "gpu";
  if (has("Paseo Helper") && has("--type=utility")) return "utility";
  if (has("Paseo Helper")) return "helper-other";
  if (/^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh (?:.*\/)?slp-wait [0-9a-f-]{36} [0-9]+$/.test(cmd)) {
    return "slp-wait";
  }
  // An agent child is only an agent child with all three stream-json flags
  // (slp-gc.bash:274); a bare `claude --print` is not one.
  if (
    /^(?:[^ ]*\/)?claude /.test(cmd) &&
    has("--output-format stream-json") &&
    has("--input-format stream-json") &&
    has("--permission-prompt-tool")
  ) {
    return "claude-child";
  }
  if (/^(?:[^ ]*\/)?codex /.test(cmd) && has("app-server")) return "codex-child";
  return null;
}

/**
 * `mb1` (slp-gc.bash:202): `(. * 10 | round) / 10`, and jq's `round` takes a
 * tie away from zero, which is what `Math.round` does for non-negative input.
 */
function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The `printf "%.1f"` rounding of `top_parse` (slp-gc.bash:610), which rounds
 * an exact tie to even: 8.25 MB stays 8.2, where `roundToTenth` would say 8.3.
 * The captured `top.txt` contains such ties (8448K), so this is not academic.
 */
function printfOneDecimal(value: number): number {
  const scaled = value * 10;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  if (fraction > 0.5) return (floor + 1) / 10;
  if (fraction < 0.5) return floor / 10;
  return (floor % 2 === 0 ? floor : floor + 1) / 10;
}

/**
 * One `ps` line -> a row, or `null` when the row cannot be read.
 *
 * The reference matches the whole line with one `capture(...)` regex
 * (slp-gc.bash:282). This walks the line positionally instead, which is the
 * same grammar with no way to backtrack: three numeric columns, `etime`, `rss`,
 * five `lstart` tokens, then the command as the untouched remainder of the
 * line. Field *count* is never used to find the command — `lstart` is five
 * tokens and the command has as many as it likes.
 */
function parsePsRow(line: string): ProcRow | null {
  const fields: string[] = [];
  let cursor = 0;
  while (fields.length < PS_FIELDS_BEFORE_CMD) {
    while (isSpace(line[cursor])) cursor++;
    if (cursor >= line.length) return null; // ran out of fields
    const start = cursor;
    while (cursor < line.length && !isSpace(line[cursor])) cursor++;
    fields.push(line.slice(start, cursor));
  }
  // A command requires the separating whitespace the reference regex demands.
  if (cursor >= line.length) return null;

  const [pidField, ppidField, pgidField, etime, rssField, ...lstartFields] = fields;
  if (!UINT.test(pidField) || !UINT.test(ppidField) || !UINT.test(pgidField)) return null;
  if (!UINT.test(rssField)) return null;
  if (!PS_ETIME.test(etime)) return null;
  const lstart = lstartFields.join(" ");
  if (!PS_LSTART.test(lstart)) return null;

  return {
    pid: Number(pidField),
    ppid: Number(ppidField),
    pgid: Number(pgidField),
    etime_s: parseEtime(etime),
    rss_mb: roundToTenth(Number(rssField) / 1024),
    lstart,
    cmd: line.slice(cursor).replace(/^\s+/, ""),
  };
}

/**
 * `ps -axww -o pid=,ppid=,pgid=,etime=,rss=,lstart=,command=` output -> rows
 * (slp-gc.bash:282-286).
 *
 * Blank lines are dropped (`select(length > 0)`); every other line that cannot
 * be read is counted in `badRows` and skipped.
 *
 * `dupes` is zero exactly when no pid appears twice, which is the only way
 * `$dupes` is consumed: identity refuses to act on any non-zero value
 * (slp-gc.bash:334-335). The reference counts *pid groups* with more than one
 * row; this counts the surplus rows instead, as the port's interface specifies.
 * The two agree on zero-ness, and the number itself is never reported.
 */
export function parsePs(text: string): ParsedPs {
  const rows: ProcRow[] = [];
  let badRows = 0;

  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const row = parsePsRow(line);
    if (row === null) {
      badRows += 1;
      continue;
    }
    rows.push(row);
  }

  const dupes = rows.length - new Set(rows.map((row) => row.pid)).size;
  return { rows, badRows, dupes };
}

/**
 * `top_parse`'s unit conversion (slp-gc.bash:607-609): strip one trailing `+`
 * or `-` state marker, then read the suffix as a unit, defaulting to bytes when
 * there is none (`0B`, or a bare number). Returns MB.
 */
function topMb(raw: string): number {
  const value = raw.replace(/[+-]$/, "");
  const suffix = value.slice(-1);
  const hasUnit = "KMGB".includes(suffix) && value.length > 0;
  const digits = hasUnit ? value.slice(0, -1) : value;
  const unit = hasUnit ? suffix : "B";
  // awk coerces a non-numeric offset to 0 rather than failing the row.
  const size = Number(digits);
  const amount = Number.isFinite(size) ? size : 0;

  if (unit === "K") return printfOneDecimal(amount / 1024);
  if (unit === "M") return printfOneDecimal(amount);
  if (unit === "G") return printfOneDecimal(amount * 1024);
  return printfOneDecimal(amount / 1048576);
}

/**
 * `top -l 1 -stats pid,mem,cmprs` output -> pid -> footprint (slp-gc.bash:605-612).
 *
 * A row is taken only when its first field is numeric and its second field is
 * `[0-9.]+` with an optional unit and marker — the reference's awk filter — so
 * header lines (a bare word, or a `#` comment) are skipped. To keep the port's
 * footprint byte-identical to the reference's, values are rounded the way
 * `printf "%.1f"` rounds them. A pid that appears twice keeps its last row,
 * as `from_entries` does (slp-gc.bash:289).
 */
export function parseTop(text: string): Map<number, TopRow> {
  const table = new Map<number, TopRow>();

  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [pidField, memField, cmprsField] = fields;
    if (!UINT.test(pidField)) continue;
    if (!/^[0-9.]+[KMGB]?[+-]?$/.test(memField)) continue;
    table.set(Number(pidField), { mem: topMb(memField), cmprs: topMb(cmprsField) });
  }

  return table;
}

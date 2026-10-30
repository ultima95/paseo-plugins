// The text report — a transliteration of `RENDER_JQ` (slp-gc.bash:912-994).
//
// Reference (`agent-room/docs/gc-port/slp-gc.bash`, byte-identical to the deployed copy):
//
//   pad / rpad      :913-914   (pad *truncates* at the width; rpad never does)
//   sh              :915       (an id shortened to 8 characters, or "-")
//   age             :916       (`6h44m`, `10m25s`)
//   kb              :917       (KB in, `MB`/`GB` out, one decimal)
//   bytes           :918       (bytes in; floored to KB and then formatted by `kb`)
//   cap             :919       (the first N lines plus `  ... X more (see --json)`)
//   the control-character wash :921 (`gsub("[\u0001-\u001f\u007f]"; "?")`)
//   the lines       :925-992, in order
//   render_text()   :994       (`jq -r "$RENDER_JQ"`, so every line ends with a newline)
//
// Two properties matter more than tidiness:
//
// 1. **The layout is the contract.** This text is what the operator reads, so it is reproduced
//    line for line: the header, the READ-ONLY sentence, the identification line (including the
//    `FAILED: … -> --apply would be refused` form), the failure text of an incomplete index, the
//    (a) process table with its per-class totals, the (a2) orphan section, (a3)/(a4) the memory
//    tree and the test-runner count, (b) the schedules, (c) the agents and transcripts, (d) the
//    garbage candidates with their groupings, (e) the retention data, and the closing summary.
//    `renderReport(JSON.parse(report-live.json))` reproduces the reference's own output for that
//    capture byte for byte — the digest in `render.test.ts` is the assertion.
//
// 2. **Rendering never throws.** The report is a JSON artifact that a human (or a bug) can hand
//    over half-filled, and a report that cannot be printed is a tick with no output at all. Every
//    section therefore reads defensively: an absent section renders as zeros or as `(none)`, and
//    a transcript whose agent the index does not name renders as `- unknown-agent` (the reference
//    would abort the whole render on `null.id`; the port does not, and this is its one intentional
//    divergence from the reference's behaviour on a malformed report).
//
// Pure: no I/O, no clock, no globals. The input is the report; the output is the string the
// reference's `render_text` would print.

import { isAgentFamily } from "./evaluate";
import type {
  ClassTotal,
  DaemonMetricRow,
  GcReport,
  OverallTotal,
  ReportAgentRow,
  ReportAgents,
  ReportGarbageRow,
  ReportOrphanRow,
  ReportProcRow,
  ReportScheduleRow,
  ReportTree,
  ReportTreeRow,
  RetentionRow,
  TranscriptRow,
} from "./report";

/** `walk(if type == "string" then gsub("[\u0001-\u001f\u007f]"; "?") else . end)` (:921). */
function sanitize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/[\u0001-\u001f\u007f]/g, "?");
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitize(item);
    }
    return out;
  }
  return value;
}

/**
 * jq's `tostring`: a string is itself, everything else is its JSON text (`null` for an absent
 * value).
 */
function tostr(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * One string as jq counts it: a sequence of code points.
 *
 * jq's `length` and `$s[:$n]` work in code points, not UTF-16 code units, so a name holding an
 * astral character (an emoji in an agent's label, a project directory) pads and truncates in jq
 * at half the width JavaScript's `String#length` sees. Every column below is measured this way so
 * the table stays aligned on the same text the reference aligned.
 */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/** `def pad($n)` (:913): right-pad to `n`, and **cut** anything longer than `n`. */
function pad(value: unknown, width: number): string {
  const chars = codePoints(tostr(value));
  const text = chars.join("");
  return chars.length >= width ? chars.slice(0, width).join("") : text + " ".repeat(width - chars.length);
}

/** `def rpad($n)` (:914): left-pad to `n`; a longer value is left whole. */
function rpad(value: unknown, width: number): string {
  const chars = codePoints(tostr(value));
  return chars.length >= width ? chars.join("") : " ".repeat(width - chars.length) + chars.join("");
}

/** `def sh` (:915): the first eight characters of an id, or `-` when there is none. */
function sh(value: unknown): string {
  if (value === null || value === undefined) return "-";
  return codePoints(tostr(value)).slice(0, 8).join("");
}

/**
 * jq's own order for the keys `sort_by` reads, which is what every ordering below reproduces:
 * `null` first, then numbers, then strings. (`sort_by(.id)` sorts an unreadable schedule's `null`
 * id *before* every real one; `sort_by(.class, …)` does the same for a row with no class.)
 */
function compareKeys(left: unknown, right: unknown): number {
  const nullish = (value: unknown): boolean => value === null || value === undefined;
  if (nullish(left) || nullish(right)) {
    return nullish(left) && nullish(right) ? 0 : nullish(left) ? -1 : 1;
  }
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  const a = tostr(left);
  const b = tostr(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `def age($s)` (:916), with jq's integer division (`floor`) and its `%` sign. */
function age(seconds: number): string {
  if (seconds >= 86400) {
    return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
  }
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** `(. * 10 | round) / 10` (:202), the one decimal every MB figure in the report carries. */
function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `def kb` (:917): a kilobyte count as `KB`/`MB`/`GB`, one decimal above 1 MB. */
function kb(value: number): string {
  if (value >= 1048576) return `${roundTenth(value / 1048576)} GB`;
  if (value >= 1024) return `${roundTenth(value / 1024)} MB`;
  return `${value} KB`;
}

/** `def bytes` (:918): a byte count, floored to KB and then formatted by `kb`. */
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return kb(Math.floor(value / 1024));
}

/** `def cap($n; f)` (:919): the first `n` rows, then the truncation message. */
function cap<T>(rows: readonly T[], limit: number, format: (row: T) => string): string[] {
  if (rows.length <= limit) return rows.map(format);
  return [...rows.slice(0, limit).map(format), `  ... ${rows.length - limit} more (see --json)`];
}

/**
 * `$P.tree.agents[].owner | if startswith("pid:") then split("@")[0] else .[:8] end` (:962, :966).
 */
function ownerLabel(owner: unknown): string {
  const text = tostr(owner);
  return text.startsWith("pid:") ? (text.split("@")[0] ?? "") : text.slice(0, 8);
}

/** jq's `sort_by` is stable, so a comparator that answers 0 keeps the input order. */
function stableSort<T>(rows: readonly T[], compare: (left: T, right: T) => number): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => compare(left.row, right.row) || left.index - right.index)
    .map((entry) => entry.row);
}

/** The `agents` section, tolerating a caller that handed in the rows alone. */
function agentsSection(report: GcReport): ReportAgents {
  const section = report.agents as ReportAgents | readonly ReportAgentRow[] | undefined;
  if (Array.isArray(section)) {
    const rows = section as readonly ReportAgentRow[];
    return {
      total: rows.length,
      live: rows.filter((row) => row.state === "live").length,
      archived: rows.filter((row) => row.state === "archived").length,
      closedUnarchived: rows.filter((row) => row.state === "closed-unarchived").length,
      unreadable: rows.filter((row) => row.state === "unreadable").length,
      trusted: rows.length > 0,
      rows: [...rows],
    };
  }
  const known = (section ?? {}) as Partial<ReportAgents>;
  const rows = known.rows ?? [];
  return {
    total: known.total ?? rows.length,
    live: known.live ?? 0,
    archived: known.archived ?? 0,
    closedUnarchived: known.closedUnarchived ?? 0,
    unreadable: known.unreadable ?? 0,
    trusted: known.trusted ?? false,
    rows: [...rows],
  };
}

/** The `tree` section, tolerating an absent one. */
function treeSection(report: GcReport): ReportTree {
  const tree = (report.procs?.tree ?? {}) as Partial<ReportTree>;
  const tests = (tree.tests ?? {}) as Partial<ReportTree["tests"]>;
  return {
    totalMb: tree.totalMb ?? 0,
    appMb: tree.appMb ?? 0,
    orphanMb: tree.orphanMb ?? 0,
    orphanN: tree.orphanN ?? 0,
    warnMb: tree.warnMb ?? 0,
    ramMb: tree.ramMb ?? 0,
    over: tree.over ?? false,
    daemon: tree.daemon ?? null,
    agents: [...(tree.agents ?? [])],
    tests: {
      agents: tests.agents ?? 0,
      warnAt: tests.warnAt ?? 0,
      over: tests.over ?? false,
      rows: [...(tests.rows ?? [])],
    },
  };
}

/** One row of the (a) table (:932-935), plus the three conditional follow-ups (:936-939). */
function procLines(row: ReportProcRow): string[] {
  const lines: string[] = [];
  const flags =
    (row.warn ? "!!WARN " : "") +
    (row.protected !== null && row.protected !== undefined ? "protected " : "") +
    (row.home === "other" ? "other-home " : "");
  lines.push(
    "  " +
      [
        rpad(row.pid, 7),
        rpad(row.ppid, 7),
        pad(row.class, 16),
        pad(sh(row.owner), 9),
        pad(age(row.etime_s), 8),
        rpad(tostr(row.footprint_mb) + (row.footprintSource === "rss" ? "*" : ""), 10),
        rpad(row.cmprs_mb ?? "-", 8),
        rpad(row.rss_mb, 8),
        flags,
      ].join(" "),
  );
  if (isAgentFamily(row.class)) {
    const stale = row.stale ?? { eligible: false, why: "" };
    lines.push(
      `      orphan rule: ${stale.why}` +
        (stale.eligible
          ? `  => WOULD SIGTERM pid ${row.pid} (with --apply --kill-stale-processes)`
          : ""),
    );
  }
  const overmem = row.overmem ?? { eligible: false, why: "" };
  if (overmem.eligible) {
    lines.push(
      `      memory rule: ${overmem.why}  => WOULD SIGTERM pid ${row.pid} (with --apply --kill-over-memory)`,
    );
  } else if (row.warn) {
    lines.push(`      memory: above warn; not killable: ${overmem.why}`);
  }
  return lines;
}

/** One row of the (a2) orphan table (:952-956). */
function orphanLines(row: ReportOrphanRow): string[] {
  const stale = row.stale ?? { eligible: false, why: "" };
  const lines = [
    "  " +
      [
        rpad(row.pid, 7),
        pad(row.comm, 10),
        `owner ${pad(sh(row.owner), 9)}`,
        pad(age(row.etime_s), 8),
        rpad(`${tostr(row.footprint_mb)} MB`, 10),
        `proof ${tostr(row.proof)}`,
        row.protected !== null && row.protected !== undefined ? "PROTECTED" : "",
        row.proven ? "ORPHAN" : "",
      ].join(" "),
    `      ${stale.why}` +
      (stale.eligible ? `  => WOULD SIGTERM pid ${row.pid} (with --apply --kill-stale-processes)` : ""),
  ];
  const overmem = row.overmem ?? { eligible: false, why: "" };
  if (overmem.eligible) {
    lines.push(
      `      memory rule: ${overmem.why}  => WOULD SIGTERM pid ${row.pid} (with --apply --kill-over-memory)`,
    );
  }
  if (row.hint !== null && row.hint !== undefined) {
    lines.push(`      hint (never proof): cwd ${tostr(row.hint)}`);
  }
  return lines;
}

/** One tree row (:962) or test-runner row (:966). */
function treeRowLine(row: ReportTreeRow, traffic: "agents" | "tests"): string {
  if (traffic === "agents") {
    return (
      "    " +
      pad(ownerLabel(row.owner), 12) +
      " " +
      pad(row.class, 13) +
      ` processes ${rpad(row.n, 4)}  ${rpad(row.footprint_mb, 9)} MB`
    );
  }
  return (
    "    " +
    pad(ownerLabel(row.owner), 12) +
    ` test-runner processes ${rpad(row.testWorkers, 4)}  ${rpad(row.testMb, 9)} MB`
  );
}

/** One schedule row (:970-971). */
function scheduleLines(row: ReportScheduleRow): string[] {
  if (row.id === null || row.id === undefined) {
    return [`  ${tostr(row.path)}  UNREADABLE: ${tostr(row.reason)}  size ${tostr(row.size)} B  -> skipped`];
  }
  const first =
    `  ${tostr(row.id)}  ${pad(row.status, 9)}  ` +
    `target ${tostr(row.targetType)}:${sh(row.targetAgent)} (${tostr(row.targetState ?? "n/a")})  ` +
    `cadence ${tostr(row.cadence ?? "-")}  runs ${tostr(row.runs)}  size ${bytes(row.size ?? 0)}  ` +
    `fires 1h/24h ${tostr(row.fires1h)}/${tostr(row.fires24h)}  name ${tostr(row.name ?? "-")}\n` +
    `      ${tostr(row.reason)}  | action: ${tostr(row.action)}`;
  if ((row.runs ?? 0) > 0) {
    const fail24h = row.fail24h ?? 0;
    const share =
      fail24h > 0 ? `${Math.round(((row.activeRunFail24h ?? 0) * 100) / fail24h)}%` : "n/a";
    return [
      `${first}\n      heartbeat health: runs[] ${tostr(row.runs)}, failures in the last 24 h ` +
        `${tostr(fail24h)}, "already has an active run" share ${share}`,
    ];
  }
  return [first];
}

/** One transcript row (:976). */
function transcriptLine(row: TranscriptRow): string {
  const agent = row.agent ?? null;
  return (
    `    ${rpad(row.bytes, 12)} B  ${sh(agent?.id)} ` +
    `${tostr(agent?.state ?? "unknown-agent")} ${tostr(agent?.provider ?? "")}  ${tostr(row.path)}`
  );
}

/** One garbage candidate (:980). */
function garbageLine(row: ReportGarbageRow): string {
  return `  [${tostr(row.category)}] ${tostr(row.id)}  ${tostr(row.path)}\n      ${tostr(row.reason)}\n      would: ${tostr(row.action)}`;
}

/** One anomaly / unreadable row (:985). */
function anomalyLine(row: ReportScheduleRow | ReportAgentRow): string {
  return `    [${tostr(row.category)}] ${tostr(row.id ?? "-")} ${tostr(row.path)}\n        ${tostr(row.reason)}`;
}

/** The `group_by(.reason | gsub("[0-9]+"; "N"))` block of (d) (:983). */
function failedRuleLines(rows: readonly ReportAgentRow[]): string[] {
  const notGarbage = rows.filter((row) => row.garbage !== true);
  const keyOf = (row: ReportAgentRow): string => (row.reason ?? "").replace(/[0-9]+/g, "N");
  // `group_by` sorts its input by key (stably), then groups equal keys together.
  const sorted = stableSort(notGarbage, (left, right) => {
    const a = keyOf(left);
    const b = keyOf(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const groups: ReportAgentRow[][] = [];
  let key: string | null = null;
  for (const row of sorted) {
    const rowKey = keyOf(row);
    if (key === null || rowKey !== key) {
      groups.push([row]);
      key = rowKey;
    } else {
      groups[groups.length - 1]?.push(row);
    }
  }
  const summaries = groups.map((group) => ({
    reason: group[0]?.reason ?? "",
    n: group.length,
    eg: group[0]?.id ?? null,
  }));
  return stableSort(summaries, (left, right) => right.n - left.n)
    .slice(0, 15)
    .map((summary) => `    ${rpad(summary.n, 5)}x  ${summary.reason}   (e.g. ${tostr(summary.eg ?? "-")})`);
}

/** The retention groups of (e) (:990): `group_by(.cat)`, cats in name order. */
function retentionGroups(rows: readonly RetentionRow[]): RetentionRow[][] {
  const sorted = stableSort(rows, (left, right) => {
    const a = left.cat;
    const b = right.cat;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const groups: RetentionRow[][] = [];
  let cat: string | null = null;
  for (const row of sorted) {
    if (cat === null || row.cat !== cat) {
      groups.push([row]);
      cat = row.cat;
    } else {
      groups[groups.length - 1]?.push(row);
    }
  }
  return groups;
}

/**
 * `render_text()` (:994): the report as the operator reads it.
 *
 * The lines are the reference's, in the reference's order; the one thing that is not a
 * transliteration is the tolerance described in the file header (a malformed section renders as
 * zeros/`(none)` instead of aborting the whole report).
 */
export function renderReport(report: GcReport): string {
  const r = sanitize(report) as GcReport;
  const procs = r.procs ?? ({} as GcReport["procs"]);
  const procRows = procs.procs ?? [];
  const orphans = procs.orphans ?? [];
  const totals: readonly ClassTotal[] = procs.totals ?? [];
  const overall: OverallTotal = procs.overall ?? { n: 0, footprint_mb: 0, rss_mb: 0 };
  const ident = procs.ident ?? ({} as GcReport["procs"]["ident"]);
  const tree = treeSection(r);
  const agents = agentsSection(r);
  const schedules = r.schedules ?? [];
  const transcripts = r.transcripts ?? [];
  const metrics = r.daemonMetrics ?? [];
  const retention = r.retention ?? [];
  const garbage = r.garbage ?? [];
  const ng = garbage.length;
  const index = r.index ?? { ok: true, why: [] };

  const out: string[] = [];

  // --- header (:925-929)
  out.push(`slp-gc report  ${tostr(r.generated)}  home ${tostr(r.home)}`);
  out.push("READ-ONLY: no paseo CLI call, nothing is changed. Use --apply to reclaim (see --help).");
  out.push(
    "identification: " +
      (ident.ok === true
        ? `ok (Supervisor ${tostr(ident.supervisorPid)}, daemon ${tostr(ident.daemonPid)}, listener ${tostr(ident.listen)})`
        : `FAILED: ${tostr(ident.why)} -> --apply would be refused`),
  );
  if (index.ok !== true) {
    out.push(
      `index: INCOMPLETE (${(index.why ?? []).map(tostr).join("; ")}) -> nothing is garbage, --apply is refused`,
    );
  }
  out.push("");

  // --- (a) Paseo processes (:930-946)
  out.push(
    `== (a) Paseo processes  (footprint = top MEM, fallback rss; MB; warn >= ${tostr(procs.warnMb ?? 0)} MB, memory-kill > ${tostr(procs.killMb ?? 0)} MB)`,
  );
  out.push(
    "  " +
      [
        rpad("PID", 7),
        rpad("PPID", 7),
        pad("CLASS", 16),
        pad("OWNER", 9),
        pad("AGE", 8),
        rpad("FOOTPRINT", 10),
        rpad("CMPRS", 8),
        rpad("RSS", 8),
        "FLAGS",
      ].join(" "),
  );
  const sortedProcs = stableSort(procRows, (left, right) => {
    const byClass = compareKeys(left.class, right.class);
    return byClass !== 0 ? byClass : right.footprint_mb - left.footprint_mb;
  });
  for (const row of sortedProcs) out.push(...procLines(row));
  if (procRows.length === 0) out.push("  (no Paseo process found)");
  if ((procs.unreadableRows ?? 0) > 0) {
    out.push(`  note: ${tostr(procs.unreadableRows)} ps row(s) could not be read and were skipped`);
  }
  out.push("  totals per class (n, footprint MB, rss MB):");
  for (const total of stableSort(totals, (left, right) => right.footprint_mb - left.footprint_mb)) {
    out.push(
      `    ${pad(total.class, 16)} ${rpad(total.n, 3)}  ${rpad(total.footprint_mb, 10)}  ${rpad(total.rss_mb, 10)}`,
    );
  }
  out.push(
    `    ${pad("ALL", 16)} ${rpad(overall.n, 3)}  ${rpad(overall.footprint_mb, 10)}  ${rpad(overall.rss_mb, 10)}`,
  );
  const family = procRows.filter((row) => isAgentFamily(row.class));
  out.push(
    `  env visibility: PASEO_HOME readable for ${family.filter((row) => row.envRead).length} of ${family.length} agent-family processes (unreadable => never signalled by --kill-stale-processes; ps eww may be restricted by SIP or a sandbox)`,
  );
  const lastMetric = metrics.length > 0 ? metrics[metrics.length - 1] : undefined;
  out.push(
    lastMetric === undefined
      ? "  daemon self-metrics: none found in daemon.log"
      : `  daemon self-metrics (last ws_runtime_metrics): ${tostr(lastMetric.time)} rss=${tostr(lastMetric.rss)} heapUsed=${tostr(lastMetric.heapUsed)} timelineStats=${JSON.stringify(lastMetric.timelineStats ?? null)}`,
  );
  out.push("");

  // --- (a2) orphaned agent descendants (:948-956)
  out.push(
    "== (a2) orphaned agent descendants (ppid 1 + agent provenance: lineage ledger pid+lstart, or env PASEO_HOME + PASEO_AGENT_ID; SIGTERM only with --apply --kill-stale-processes)",
  );
  if ((procs.ledgerNote ?? "") !== "") out.push(`  LEDGER: ${tostr(procs.ledgerNote)}`);
  if ((procs.ledgerDropped ?? 0) > 0) {
    out.push(
      `  LEDGER: ${tostr(procs.ledgerDropped)} row(s) failed validation (owner syntax, timestamps, comm, exe path) and were ignored`,
    );
  }
  if (orphans.length === 0) out.push("  (none with agent provenance)");
  for (const row of stableSort(orphans, (left, right) => right.footprint_mb - left.footprint_mb)) {
    out.push(...orphanLines(row));
  }
  out.push("");

  // --- (a3) Paseo tree memory (:958-963)
  out.push(
    "== (a3) Paseo tree memory (app main + everything under it + proven orphans; footprint MB)",
  );
  out.push(
    `  tree total ${tostr(tree.totalMb)} MB  = app subtree ${tostr(tree.appMb)} + proven orphans ${tostr(tree.orphanMb)} (${tostr(tree.orphanN)})   warn >= ${tostr(tree.warnMb)} MB (50% of ${tostr(tree.ramMb)} MB RAM)` +
      (tree.over ? "   !!TREE-WARN" : ""),
  );
  out.push(
    tree.daemon === null
      ? "  daemon: not found"
      : `  daemon: pid ${tostr(tree.daemon.pid)} footprint ${tostr(tree.daemon.footprint_mb)} MB (report-only: the daemon is never memory-killed)`,
  );
  out.push("  per-agent subtree totals (top 10; agent child + everything under it):");
  for (const row of tree.agents) out.push(treeRowLine(row, "agents"));
  if (tree.agents.length === 0) out.push("    (no agent child found)");
  out.push("");

  // --- (a4) test-runner concurrency (:965-966)
  out.push(
    `== (a4) test-runner concurrency (report-only): ${tostr(tree.tests.agents)} agent(s) with vitest/jest/pytest/mocha/playwright subtrees (warn when > ${tostr(tree.tests.warnAt)})` +
      (tree.tests.over ? "   !!CONCURRENCY-WARN" : ""),
  );
  for (const row of tree.tests.rows) out.push(treeRowLine(row, "tests"));
  out.push("");

  // --- (b) recurring machinery (:968-972)
  out.push(`== (b) recurring machinery: schedules / heartbeats on disk (${schedules.length})`);
  for (const row of stableSort(schedules, (left, right) => compareKeys(left.id, right.id))) {
    out.push(...scheduleLines(row));
  }
  if (schedules.length === 0) out.push("  (none)");
  out.push("");

  // --- (c) agents and transcripts (:974-977)
  out.push(
    `== (c) agents: ${tostr(agents.total)} records  live ${tostr(agents.live)}  archived ${tostr(agents.archived)}  closed-unarchived ${tostr(agents.closedUnarchived)}  unreadable ${tostr(agents.unreadable)}`,
  );
  out.push("  largest transcripts (CLAUDE_CONFIG_DIR/projects/*/<sessionId>.jsonl):");
  for (const row of transcripts.slice(0, 10)) out.push(transcriptLine(row));
  if (transcripts.length === 0) out.push("    (none above the size floor / not locatable)");
  out.push("");

  // --- (d) garbage candidates (:979-985)
  out.push(`== (d) garbage candidates: ${ng} (rules: memleak-live.md §6)`);
  for (const line of cap(garbage, 200, garbageLine)) out.push(line);
  if (ng === 0) out.push("  (none)");
  out.push("  not garbage, agents grouped by the rule that failed:");
  for (const line of failedRuleLines(agents.rows)) out.push(line);
  out.push("  anomalies / unreadable (skipped, never touched):");
  const anomalies = [...schedules, ...agents.rows].filter(
    (row) => (row as { anomaly?: boolean }).anomaly === true || (row.reason ?? "").startsWith("skipped"),
  );
  for (const line of cap(anomalies, 40, anomalyLine)) out.push(line);
  out.push("");

  // --- (e) retention data (:987-990)
  out.push("== (e) retention data (report only; nothing here has a Paseo CLI reclaim path)");
  out.push("  top-level entries of the home by size:");
  const entries = retention.filter((row) => row.cat === "home-entry");
  for (const row of stableSort(entries, (left, right) => right.kb - left.kb).slice(0, 15)) {
    out.push(`    ${rpad(kb(row.kb), 10)}  files ${rpad(row.count, 6)}  ${tostr(row.path)}`);
  }
  for (const group of retentionGroups(retention.filter((row) => row.cat !== "home-entry"))) {
    out.push(`  ${tostr(group[0]?.cat)} (${group.length}):`);
    for (const row of group.slice(0, 25)) {
      out.push(`    ${rpad(kb(row.kb), 10)}  ${tostr(row.path)}  -- ${tostr(row.note)}`);
    }
  }
  out.push("");

  // --- summary (:992)
  out.push(`summary: ${ng} garbage candidate(s); actions only with --apply. Exit 0.`);

  return `${out.join("\n")}\n`;
}

export type { DaemonMetricRow };

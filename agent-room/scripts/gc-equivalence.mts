// The equivalence harness: the reference tool's `report --json` against the port's
// own report, field by field.
//
// Reference: `agent-room/docs/gc-port/slp-gc.bash`, `report --json` (`:1351`). The
// port assembles the same object in `server/gc/report.ts` (`buildReport`) and, since
// this task, persists it beside the rendered text at
// `<state>/reports/<stamp>.json` (`writeReportFile`, `server/gc/tick.ts`).
//
// Usage:
//
//   node --experimental-strip-types scripts/gc-equivalence.mts [plugin-report.json]
//
// With no argument the newest `reports/*.json` under the plugin's GC state dir is
// read (`$AGENT_ROOM_GC_STATE`, default `~/.paseo/plugin-data/agent-room/gc`), so the
// check can be repeated against whatever the last scheduled tick wrote. The bash
// side runs with `SLP_GC_STATE_DIR` pointed at a fresh temporary directory: `report`
// is read-only by contract, but a state dir of its own makes "read-only" a property
// of the setup and not of the reference's promise, so a harness run can never touch
// the live GC state.
//
// What is compared, and what cannot be:
//
// The two reports are captured by different processes at different instants, so
// every field whose value is live — a pid, a sample of `top`, an age, a size, a
// timestamp — is dropped before the comparison (`IGNORE`), with the reason recorded
// in `docs/acceptance-phase3-2026-10-30.md`. Two whole-row *populations* are live for the
// same reason, and one list's *order* is not a decision. Nothing here is semantic: every
// refusal, class, owner, rule, reason, count, threshold and verdict is compared as it is.
//
// 1. **The process and orphan sections are compared as sets, keyed by `pid` +
//    `lstart`** (`ROW_SECTIONS`). A process that exits between the two captures is a
//    row on one side only; it is not a decision and is skipped, with the count logged
//    per section. The key is the pair, not the pid: a recycled pid is a different
//    process and stays a difference. A section with no row in common is *not* churn,
//    it is a different population, and it fails (`alignRowSections`).
// 2. **`why` sentences have their `top` sample collapsed** (`WHY_MB`): both sides
//    quote a measured footprint ("footprint 115.0 MB <= 4096 MB"), sampled seconds
//    apart. Only the numbers are replaced; the sentence, its comparison and its
//    verdict are compared as they are, and the thresholds remain compared as the
//    `warnMb`/`killMb` numbers the report carries separately.
// 3. **Sums and sizes of those samples are dropped too** (`IGNORE`'s second block):
//    `tree.totalMb`, `retention[].kb`, `daemonMetrics[].rss` and their like are the
//    same instant one level up. What they decide stays compared — `tree.over`,
//    `overall.n`, `totals[].n`, every threshold — and the sums' per-row inputs were
//    already dropped, so comparing a sum of dropped samples alone would only ever fail.
// 4. **`agents.rows` is compared sorted by `id`** (`ORDER_INSENSITIVE`): the reference
//    walks the record directory with `find` (`slp-gc.bash:628`, filesystem order) and the
//    port sorts each directory's filenames (`server/gc/agents.ts:255`), so the same 300
//    rows arrive in a different order. Sorting both sides keeps every row, every field
//    and the row count compared — the rows are identical by `id`, and the summary counts
//    are compared separately. No row is dropped.
// 5. **`procs.ledgerNext` is the one field the two artifacts do not share**
//    (`REPORT_MODE_ONLY`): the reference's `report` verb does not compute a ledger, and
//    the port's report is a *tick's* report, which does. The exemption is asserted, not
//    assumed, and covers no rule.
// 6. **`daemonMetrics[].timelineStats` is replaced on both sides, its entry shape asserted
//    first** (`normalizeDaemonCounters`): the section is the daemon's own last three
//    `ws_runtime_metrics` records, so its counters are live samples too — `totalItems` grows
//    with every agent turn (a re-run five minutes after the tick read `3748` against the
//    report's `3745`). `time`, `pid`, `rss` and `heapUsed` are dropped by name in `IGNORE`;
//    `timelineStats` is dropped as a *whole value* instead, because its own shape is what the
//    comparison must keep: the section is asserted to be an array of objects, each with a
//    `time` key and a `timelineStats` key, and a missing, non-array or restructured section
//    fails by path rather than passing quietly.
// 7. **The `dirty=<n>` and `unpushed=<n>` tokens inside `retention[*].note` are collapsed,
//    the entry shape asserted first** (`normalizeRetentionNotes`): that note is the reference's
//    `git_state` (`slp-gc.bash:829-833`) — `dirty=<n> unpushed=<n>` for a working tree it
//    samples — and the tree it samples is the repository this harness itself runs in, so a
//    live `git status` reading changes between captures (`dirty=1` against `dirty=0`). The
//    counts are a *live host reading*, used only for the report's `other-worktree` annotation
//    and read by no rule, gate or verdict. Only each numeric value becomes `<n>`; the rest of
//    the note — `live agent cwd:`, `never garbage`, and a non-numeric `unpushed=no-upstream`
//    — is still compared as text, the retention row's own fields are compared as they are,
//    and a missing, non-array or restructured `retention` entry fails by path.
//
// Nothing else about a row is normalised: an empty section on one side against a
// non-empty one on the other, a different class or owner, a different `why` sentence
// with the same numbers — all still fail. One value is not dropped but mapped to a
// sentinel (`EQUIVALENT`): `protected` reads `in slp-gc's own process tree` on the
// reference side and `null` on the port's, which is the documented deviation and not
// drift — see the `EQUIVALENT` comment for the reason and the ruling it implements.
// No other `protected` value is normalised. What remains is the report's structure
// and its decisions: sections, classes, owners, states, rules, reasons, actions,
// thresholds, counts and verdicts. A difference there is drift in the port, and the
// harness names the first one by path so the fix lands in the modules.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fields dropped before the comparison, with the reason each one is live rather
 * than drift. The first block is the brief's list; the rest is what the two capture
 * instants make unavoidably different (see the acceptance record's table).
 */
const IGNORE = new Set([
  // --- the brief's list
  "generated", // the capture instant
  "home", // the same path on both sides, but an absolute one: not a decision
  "etime_s", // process age, sampled seconds apart
  "pid", // a live pid; two captures see the same processes, not the same numbers
  "ppid",
  "pgid",
  "lstart", // process start time, as text
  "rss_mb", // a `ps`/`top` sample
  "mem_mb", // a `top` MEM sample
  "cmprs_mb", // a `top` CMPRS sample
  "footprint_mb", // a `top` MEM sample (the row's measured footprint)

  // --- sums and sizes *of* those samples: the same instant, one level up. Dropping the
  // per-row value while comparing the sum would fail on every live host and tell nobody
  // anything; what the sums decide stays compared — `tree.over` and `totals[].n` are still
  // compared as values, and the thresholds (`warnMb`, `killMb`, `treeWarnMb`) are still
  // compared as numbers.
  "totalMb", // the app subtree's footprint sum (registry: `tree`)
  "appMb",
  "orphanMb",
  "kb", // a `du -sk` reading (retention rows: report-only, no decision reads them)
  "count", // a `find | wc -l` reading
  "bytes", // a transcript file's size
  // --- the daemon's own samples: the report carries the last three `ws_runtime_metrics`
  // lines of `daemon.log`, and two captures read them seconds apart, so the three newest
  // lines are three *different* samples. The row shape and the pid are still compared. The
  // counters themselves — `agents.timelineStats`, which grows with every agent turn — are
  // not listed here: they are replaced as a whole object by `normalizeDaemonCounters`,
  // which asserts each entry's shape before doing it.
  "time",
  "rss",
  "heapUsed",
]);

/**
 * The `top` sample a `why` sentence quotes — `footprint 114 MB <= 4096 MB`, `footprint
 * 3892.7 MB` — collapsed to `<MB>` before the comparison.
 *
 * Both sides measure the same process's footprint at different instants, so the number
 * in the sentence is an instant and not a decision: the same row, sampled 2 s later,
 * reads `115.0 MB` on one side and `114.0 MB` on the other. The sentence around it, the
 * `<=`/`>` it asserts and the eligibility it states are untouched, and the two
 * thresholds are still compared as numbers (`procs.warnMb`, `procs.killMb`), so nothing
 * a rule decides is masked by this. Nothing but a `<number> MB` is replaced.
 */
const WHY_MB = /\d+(?:\.\d+)? MB/g;

/**
 * The reference's own-tree reason for a row, verbatim (`slp-gc.bash:317`, `:411`).
 * The port spells the same arm `in the GC's own process tree` (`server/gc/evaluate.ts:341`),
 * but never produces it in a tick: see `EQUIVALENT`.
 */
const REFERENCE_OWN_TREE = "in slp-gc's own process tree";

/** The one value both sides become: "inside a GC process tree, or the port has none". */
const NO_SELF_TREE = "<own process tree or none>";

/**
 * Keys whose *values* are equivalent while being unequal, mapped to a sentinel
 * before the comparison. The only entry is `protected`.
 *
 * ### `protected`: `in slp-gc's own process tree` ≡ `null`
 *
 * The reference protects its own process tree — its ancestry and every row
 * descending from it (`slp-gc.bash:295-298`, `$selfTree`), so under the bash tool
 * the app main, the Supervisor, the daemon and the tool's own shell all come out
 * `in slp-gc's own process tree`. The port runs *inside* the daemon and has no
 * process tree of its own, so its self-subtree arm is empty by ruling:
 * `NO_SELF_PID = 0` (`server/gc/tick.ts:193`). A tick therefore never claims a row
 * as its own, and those same rows carry `protected: null` — a null that means
 * "protected by nothing on this side", not "killable".
 *
 * This is a documented deviation, not drift, and it loses no decision. Every row
 * the reference covers with its own tree is still refused by class on both sides,
 * by the same arm in the same order: the app main and the Supervisor
 * (`slp-gc.bash:362`, `server/gc/evaluate.ts:595`), the daemon (`:363`, `:598`),
 * an agent child (`:364`, `:605`) — plus the invoking agent by `PASEO_AGENT_ID`
 * and `invOwnerPid`, which no class arm replaces. Since the two sides agree on the
 * class of every one of those rows, the same rows are ineligible for every rule,
 * action and verdict either way.
 *
 * Both values are mapped to `NO_SELF_TREE`, so `null` vs `null` still agrees (as
 * it did before) and a row the reference protects as its own now agrees with the
 * port's `null`. **No other `protected` value is normalised**: `belongs to the
 * invoking agent` and `in the invoking agent's process subtree` — and the port's
 * own `in the GC's own process tree`, should a caller ever pass a real
 * `deps.selfPid` — are compared as they are.
 */
const EQUIVALENT: Record<string, (value: unknown) => unknown> = {
  protected: (value) => (value === null || value === REFERENCE_OWN_TREE ? NO_SELF_TREE : value),
  // The `top` sample inside a `why` sentence: the number is an instant, the sentence is
  // the decision. See `WHY_MB` for what this does and does not hide.
  why: (value) => (typeof value === "string" ? value.replace(WHY_MB, "<MB>") : value),
};

/** A report section compared as a *set* of rows rather than a sequence, and its identity. */
interface RowSection {
  /** The section's name in the ignored-row log. */
  readonly name: string;
  /** The path to the array, from the report root. */
  readonly path: readonly string[];
  /**
   * The row's identity: what makes one capture's row "the same row" as another's.
   * `null` when the row carries no identity, and the whole row is then its own key.
   */
  readonly key: (row: Record<string, unknown>) => string | null;
}

/**
 * `pid@lstart`, the identity of a live process across two captures.
 *
 * Both halves are needed: a pid alone is recycled by the kernel, so two different
 * processes can share one, and `lstart` alone can repeat (a fork of a process describing
 * itself with the same second). Together they name one process for its whole life, which
 * is exactly the span a comparison of two captures may assume.
 */
function processKey(row: Record<string, unknown>): string | null {
  const { pid, lstart } = row;
  if (typeof pid !== "number" || typeof lstart !== "string") return null;
  return `${String(pid)}@${lstart}`;
}

/**
 * `category:id`, the identity of a garbage candidate: the record file's own name
 * (`ReportGarbageRow`, `server/gc/report.ts:880`) — a path is home-prefixed and would
 * make the key depend on an ignored field.
 */
function garbageKey(row: Record<string, unknown>): string | null {
  const { category, id } = row;
  if (typeof category !== "string" || typeof id !== "string") return null;
  return `${category}:${id}`;
}

/**
 * The sections compared as row sets. These are the populations a live machine changes
 * between two captures: a process exits, a record file is written or reclaimed. Every
 * other array in the report (an agent's `rows`, a schedule's, the retention walk) is
 * compared in order, as a sequence.
 */
const ROW_SECTIONS: readonly RowSection[] = [
  { name: "procs", path: ["procs", "procs"], key: processKey },
  { name: "orphans", path: ["procs", "orphans"], key: processKey },
  { name: "garbage", path: ["garbage"], key: garbageKey },
];

/** The value at `path` under `root`, or `undefined` when the path or root does not exist. */
function atPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const step of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[step];
  }
  return node;
}

/** Replace the value at `path` under `root`. `path` is never empty. */
function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const parents = path.slice(0, -1);
  const last = path[path.length - 1] as string;
  let node = root;
  for (const step of parents) {
    const next = node[step];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return;
    node = next as Record<string, unknown>;
  }
  node[last] = value;
}

/** One section's skipped rows, for the log: one-sided rows on each side, and the totals. */
interface RowCount {
  readonly name: string;
  readonly left: number;
  readonly right: number;
  readonly leftTotal: number;
  readonly rightTotal: number;
}

/**
 * Rows of `rows` keyed by identity, with the occurrence number appended so that two rows
 * with the same identity stay two rows instead of one overwriting the other. A row with
 * no identity is keyed by its own JSON, which can only ever match an identical row.
 */
function keyRows(
  rows: readonly Record<string, unknown>[],
  key: RowSection["key"],
): Map<string, Record<string, unknown>> {
  const seen = new Map<string, number>();
  const keyed = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const base = key(row) ?? JSON.stringify(row);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    keyed.set(`${base}#${String(occurrence)}`, row);
  }
  return keyed;
}

/**
 * Compare the row sections as sets: keep only the rows both captures saw, in key order,
 * and report what was skipped.
 *
 * The rule is deliberately asymmetric only in what it *drops*: a row on one side only is
 * live churn and is skipped, but a section whose two sides share *no* row is refused —
 * an empty section against a populated one is the case the brief names, and a pair of
 * disjoint non-empty ones (a completely different population, e.g. the pid-recycling bug
 * that once listed 418 system daemons as orphans) is not churn either. Both arrays are
 * replaced in place on the parsed reports; the caller owns them.
 */
function alignRowSections(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): { ignored: RowCount[]; refusal: string | null } {
  const ignored: RowCount[] = [];
  let refusal: string | null = null;
  for (const section of ROW_SECTIONS) {
    const leftSide = atPath(left, section.path);
    const rightSide = atPath(right, section.path);
    // Absent or not an array: no rows to align. `firstDifference` reports the shape
    // difference as the drift it is.
    if (!Array.isArray(leftSide) || !Array.isArray(rightSide)) continue;
    const leftRows = leftSide as readonly Record<string, unknown>[];
    const rightRows = rightSide as readonly Record<string, unknown>[];
    const leftKeyed = keyRows(leftRows, section.key);
    const rightKeyed = keyRows(rightRows, section.key);
    const shared = [...leftKeyed.keys()].filter((key) => rightKeyed.has(key)).sort();
    ignored.push({
      name: section.name,
      left: leftRows.length - shared.length,
      right: rightRows.length - shared.length,
      leftTotal: leftRows.length,
      rightTotal: rightRows.length,
    });
    if (shared.length === 0 && (leftRows.length > 0 || rightRows.length > 0)) {
      const path = section.path.join(".");
      refusal ??= `${path} (no row in common: ${String(leftRows.length)} rows vs ${String(rightRows.length)} rows)`;
      continue;
    }
    setPath(left, section.path, shared.map((key) => leftKeyed.get(key)));
    setPath(right, section.path, shared.map((key) => rightKeyed.get(key)));
  }
  return { ignored, refusal };
}

/**
 * Lists whose *order* is not a decision, compared sorted by the given field on both sides.
 *
 * `agents.rows` is the record index: the reference walks the directory with `find`
 * (`slp-gc.bash:628`) and takes the filesystem's order, while the port sorts each
 * directory's filenames (`server/gc/agents.ts:255`). The same rows therefore arrive in a
 * different order on a host with more than one workspace. Sorting both sides by `id`
 * compares every row, every field of it and the row count: nothing is dropped and no row
 * is matched against another. A row that exists on one side only still fails on length.
 */
const ORDER_INSENSITIVE: readonly { readonly path: readonly string[]; readonly by: string }[] = [
  { path: ["agents", "rows"], by: "id" },
];

/**
 * Sort the `ORDER_INSENSITIVE` lists on both sides by their key field. A side that is not
 * an array of objects with the key is left alone for `firstDifference` to report.
 */
function sortRowLists(left: Record<string, unknown>, right: Record<string, unknown>): void {
  for (const list of ORDER_INSENSITIVE) {
    const leftSide = atPath(left, list.path);
    const rightSide = atPath(right, list.path);
    if (!Array.isArray(leftSide) || !Array.isArray(rightSide)) continue;
    const sort = (rows: unknown): unknown =>
      (rows as readonly unknown[])
        .map((row) => row)
        .sort((one, other) => {
          const a = (one as Record<string, unknown>)[list.by];
          const b = (other as Record<string, unknown>)[list.by];
          return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
        });
    setPath(left, list.path, sort(leftSide));
    setPath(right, list.path, sort(rightSide));
  }
}

/**
 * Sections the reference's `report` verb leaves at its zero value for *every* host,
 * because it does not compute them at all.
 *
 * `procs.ledgerNext` is `null` unless `$wantLedger` (`slp-gc.bash:452`, `:467`), and
 * `WANT_LEDGER=1` is set in exactly one place — `do_record` (`:1188`) — which is reachable
 * only from `tick` (`:1344`). `report --json`, the verb this harness can print, therefore
 * answers `null` on every machine, while the port's report file is *a tick's* report and
 * carries the ledger that tick computed and wrote back (`server/gc/tick.ts:1752`). The two
 * values are not "no rows" against "rows": `null` here is the artifact's zero value.
 *
 * So the comparison drops the port's side **only when the reference side is exactly
 * `null`**, which is asserted on every run: a reference that ever produced rows keeps them
 * and is compared normally, so a rule that started computing the ledger in `report` would
 * surface here rather than be hidden. This is the one section where the two artifacts are
 * not the same artifact; every other section is compared as it is.
 *
 * What it does not do is check the port's ledger rows against the reference's. No
 * reference CLI emits a ledger (its `tick` writes rendered text only, and its JSON lives
 * in a temp dir it removes), so the ledger's rules are pinned by
 * `server/gc/ledger.test.ts` against the same jq instead.
 */
const REPORT_MODE_ONLY: readonly (readonly string[])[] = [["procs", "ledgerNext"]];

/**
 * Drop the port's side of a `REPORT_MODE_ONLY` section when — and only when — the
 * reference's side is `null`. Any other reference value is left alone to be compared.
 */
function reconcileReportMode(
  reference: Record<string, unknown>,
  plugin: Record<string, unknown>,
): void {
  for (const path of REPORT_MODE_ONLY) {
    if (atPath(reference, path) === null) setPath(plugin, path, null);
  }
}

/** The section of live daemon counters, and the one counter object inside each of its rows. */
const DAEMON_METRICS = "daemonMetrics";
const TIMELINE_STATS = "timelineStats";

/** The one value both sides become: "a live counter, whose value is an instant, not a ruling". */
const LIVE_COUNTER = "<live counter>";

/**
 * Replace `daemonMetrics[].timelineStats` on both sides — the daemon's live timeline counters
 * — after asserting every entry's shape.
 *
 * `daemonMetrics` is the last three `ws_runtime_metrics` records of `daemon.log`, collected by
 * both sides from the same log (`collect_metrics`, `slp-gc.bash:811-817`;
 * `collectDaemonMetrics`, `server/gc/report.ts:420`) at two instants, so each side reads three
 * *different* records. `time`, `pid`, `rss` and `heapUsed` are samples and are dropped by name
 * in `IGNORE`; `timelineStats` (`agents.timelineStats`) is an object of counters that grows
 * with every agent turn — a re-run five minutes after the tick that wrote the report read
 * `totalItems` 3748 against the report's 3745 — so its *values* cannot be compared either.
 * Dropping the key by name would also drop the section's shape, so the whole object is
 * replaced on both sides instead, and what is asserted first is what a restructure would
 * break:
 *
 *  - `daemonMetrics` exists on both sides and is an **array** (an absent section, or one that
 *    became a scalar or an object, is a refusal — not a silently equal pair);
 *  - every entry is a non-null **object** (not an array, not a scalar);
 *  - every entry carries a **`time`** key and a **`timelineStats`** key;
 *  - every `timelineStats` value is an **object or `null`** — the two shapes the daemon's own
 *    metrics record can have (`agents.timelineStats`, absent until an agent has a timeline).
 *
 * A failure in any of those is returned as the path it refused, so it prints as `DIFFERS at
 * daemonMetrics[1] (…)` and the run exits 1. Nothing else about the section is touched: the
 * row count is still compared (`firstDifference` fails on a length mismatch), and so is every
 * other field of every entry. `null` on one side against an object on the other is *not*
 * asserted away — that is a live difference in the sample window and stays a difference.
 */
function normalizeDaemonCounters(
  reference: Record<string, unknown>,
  plugin: Record<string, unknown>,
): string | null {
  const sides: readonly (readonly [string, Record<string, unknown>])[] = [
    ["reference", reference],
    ["plugin", plugin],
  ];
  for (const [label, side] of sides) {
    const metrics = side[DAEMON_METRICS];
    if (!Array.isArray(metrics)) {
      return `${DAEMON_METRICS} (${label} side is not an array: ${JSON.stringify(metrics) ?? "<absent>"})`;
    }
    for (let index = 0; index < metrics.length; index += 1) {
      const entry = metrics[index] as unknown;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return `${DAEMON_METRICS}[${String(index)}] (${label} side is not an object)`;
      }
      const row = entry as Record<string, unknown>;
      if (!Object.hasOwn(row, "time")) {
        return `${DAEMON_METRICS}[${String(index)}] (${label} side has no time key)`;
      }
      if (!Object.hasOwn(row, TIMELINE_STATS)) {
        return `${DAEMON_METRICS}[${String(index)}] (${label} side has no ${TIMELINE_STATS} key)`;
      }
      const stats = row[TIMELINE_STATS];
      if (stats !== null && (typeof stats !== "object" || Array.isArray(stats))) {
        return `${DAEMON_METRICS}[${String(index)}].${TIMELINE_STATS} (${label} side is neither an object nor null)`;
      }
    }
  }
  for (const [, side] of sides) {
    for (const entry of side[DAEMON_METRICS] as readonly Record<string, unknown>[]) {
      entry[TIMELINE_STATS] = LIVE_COUNTER;
    }
  }
  return null;
}

/** The section of report-only retention rows, and the annotation inside each row's note. */
const RETENTION = "retention";
const RETENTION_NOTE = "note";

/** The one value both sides become: "a live `git status` count, whose number is an instant". */
const GIT_STATE_COUNT = "<n>";

/**
 * The two counts `git_state` (`slp-gc.bash:829-833`) prints in a retention note —
 * `dirty=<n> unpushed=<n>` — with the value collapsed. Anchored to the token's own name so
 * nothing but that one number is replaced: `unpushed=no-upstream` is not a count and stays
 * as the text it is.
 */
const GIT_DIRTY = /\bdirty=\d+/g;
const GIT_UNPUSHED = /\bunpushed=\d+/g;

/**
 * Collapse the live `git status` counts inside `retention[*].note` on both sides, after
 * asserting every entry's shape.
 *
 * `retention` is the report-only scan of the home (`collect_retention`, `slp-gc.bash:835-872`;
 * `collectRetention`, `server/gc/report.ts:529`), and its `other-worktree` rows carry the
 * `git_state` of a live agent's cwd — one of which is the repository this harness itself runs
 * in. So the note quotes a reading of a tree that mutates between captures: the 17:49:31Z tick
 * recorded `dirty=0`, the 17:54:32Z tick `dirty=1`, and each captures a different instant.
 * The annotation decides nothing — no rule, gate, action or verdict reads `retention` — so the
 * counts are live host data, not port drift. What the comparison keeps is what a change could
 * mean:
 *
 *  - `retention` exists on both sides and is an **array** (an absent section, or one that
 *    became a scalar or an object, is a refusal, not a silently equal pair);
 *  - every entry is a non-null **object** (not an array, not a scalar);
 *  - every entry carries a **`note`** key and it is a **string** — a restructure that moves or
 *    drops the annotation fails by path instead of being normalised away;
 *  - only `dirty=<digits>` and `unpushed=<digits>` lose their number; the rest of the note
 *    (`live agent cwd:`, `never garbage`, `missing`, `unknown (git status failed)`,
 *    `unpushed=no-upstream`) is compared as it is.
 *
 * Every other field of every entry is untouched, and the row count is still compared by
 * `firstDifference` (a length mismatch fails). A failure in any assertion above is returned as
 * the path it refused, so it prints as `DIFFERS at retention[38] (…)` and the run exits 1.
 */
function normalizeRetentionNotes(
  reference: Record<string, unknown>,
  plugin: Record<string, unknown>,
): string | null {
  const sides: readonly (readonly [string, Record<string, unknown>])[] = [
    ["reference", reference],
    ["plugin", plugin],
  ];
  for (const [label, side] of sides) {
    const rows = side[RETENTION];
    if (!Array.isArray(rows)) {
      return `${RETENTION} (${label} side is not an array: ${JSON.stringify(rows) ?? "<absent>"})`;
    }
    for (let index = 0; index < rows.length; index += 1) {
      const entry = rows[index] as unknown;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return `${RETENTION}[${String(index)}] (${label} side is not an object)`;
      }
      const row = entry as Record<string, unknown>;
      if (!Object.hasOwn(row, RETENTION_NOTE)) {
        return `${RETENTION}[${String(index)}] (${label} side has no ${RETENTION_NOTE} key)`;
      }
      if (typeof row[RETENTION_NOTE] !== "string") {
        return `${RETENTION}[${String(index)}].${RETENTION_NOTE} (${label} side is not a string)`;
      }
    }
  }
  for (const [, side] of sides) {
    for (const entry of side[RETENTION] as readonly Record<string, unknown>[]) {
      const note = entry[RETENTION_NOTE] as string;
      entry[RETENTION_NOTE] = note
        .replace(GIT_DIRTY, `dirty=${GIT_STATE_COUNT}`)
        .replace(GIT_UNPUSHED, `unpushed=${GIT_STATE_COUNT}`);
    }
  }
  return null;
}

/** The one-line log of what the set comparison skipped, e.g. `procs 1/21 vs 2/21`. */
function ignoredLine(ignored: readonly RowCount[]): string {
  const parts = ignored.map(
    (count) =>
      `${count.name} ${String(count.left)}/${String(count.leftTotal)} vs ${String(count.right)}/${String(count.rightTotal)}`,
  );
  return `rows on one side only (skipped): ${parts.join("; ")}`;
}

/** The path of the first differing value, as `a.b[3].c`, or `null` when the two agree. */
function firstDifference(left: unknown, right: unknown, path = ""): string | null {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return `${path === "" ? "<root>" : path} (${String(left.length)} rows vs ${String(right.length)})`;
    }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${String(index)}]`);
      if (difference !== null) return difference;
    }
    return null;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const keys = new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ]);
    for (const key of keys) {
      const difference = firstDifference(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  if (left === right) return null;
  const show = (value: unknown): string => {
    const text = value === undefined ? "<absent>" : JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  };
  return `${path === "" ? "<root>" : path} (${show(left)} vs ${show(right)})`;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !IGNORE.has(key))
        .map(([key, entry]) => {
          // A keyed value mapping runs before the recursion, so a sentinel is
          // compared as a leaf and no other key of that object is touched.
          const mapValue = EQUIVALENT[key];
          return [key, normalize(mapValue === undefined ? entry : mapValue(entry))];
        }),
    );
  }
  return value;
}

/** The plugin's GC state dir: the daemon's own plugin-data directory in production. */
function pluginStateDir(): string {
  return (
    process.env.AGENT_ROOM_GC_STATE ?? join(homedir(), ".paseo", "plugin-data", "agent-room", "gc")
  );
}

/** The newest `reports/*.json` the plugin wrote, or a refusal that says why there is none. */
function newestPluginReport(stateDir: string): string {
  const reports = join(stateDir, "reports");
  let names: string[];
  try {
    names = readdirSync(reports).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new Error(`no plugin reports under ${reports}: a tick writes one when a report is due`);
  }
  const newest = names.at(-1);
  if (newest === undefined) {
    throw new Error(`no plugin report JSON under ${reports}: a tick writes one when a report is due`);
  }
  return join(reports, newest);
}

/** `report --json`, with a state dir of its own so the live GC state is never touched. */
function bashReport(): unknown {
  const stateDir = mkdtempSync(join(tmpdir(), "gc-equivalence-state-"));
  try {
    const stdout = execFileSync("bash", ["docs/gc-port/slp-gc.bash", "report", "--json"], {
      encoding: "utf8",
      env: { ...process.env, SLP_GC_STATE_DIR: stateDir },
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } finally {
    // `report` writes nothing, but the state dir exists and is this run's to remove.
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function main(): void {
  const explicit = process.argv[2];
  const pluginPath = explicit ?? newestPluginReport(pluginStateDir());
  let plugin: Record<string, unknown>;
  try {
    plugin = JSON.parse(readFileSync(pluginPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`cannot read the plugin report at ${pluginPath}: ${String(error)}`);
  }

  const reference = bashReport() as Record<string, unknown>;
  // The set comparison first: it decides which rows are comparable at all, and logs what
  // it skipped. Its refusal is a difference in its own right ("no row in common"), not a
  // value drift `firstDifference` could name.
  const aligned = alignRowSections(reference, plugin);
  console.log(ignoredLine(aligned.ignored));
  sortRowLists(reference, plugin);
  reconcileReportMode(reference, plugin);
  // The daemon's live counters, replaced only once both sides' shapes are asserted to hold.
  const counters = normalizeDaemonCounters(reference, plugin);
  // The retention note's live `git status` counts, collapsed only once the entry shape holds.
  const notes = normalizeRetentionNotes(reference, plugin);

  const difference =
    aligned.refusal ??
    counters ??
    notes ??
    firstDifference(normalize(reference), normalize(plugin));
  if (difference !== null) {
    console.log(`DIFFERS at ${difference}`);
    console.log(`  plugin report: ${pluginPath}`);
    process.exitCode = 1;
    return;
  }
  const written = statSync(pluginPath).mtime.toISOString();
  console.log(`EQUIVALENT (plugin report ${pluginPath}, written ${written})`);
}

main();

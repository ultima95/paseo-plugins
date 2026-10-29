// The text report — `renderReport` against `RENDER_JQ` (slp-gc.bash:912-994).
//
// The centrepiece is the parity test: the reference's own renderer was run over the captured
// report to produce 150 lines of text, and `renderReport` must produce them byte for byte for
// that same capture. It is asserted as a digest plus a handful of verbatim lines, because a
// digest alone does not say *what* drifted:
//
//   { sed -n '913,992p' docs/gc-port/slp-gc.bash; sed -n '993p' docs/gc-port/slp-gc.bash | sed "s/'$//"; } \
//     > /tmp/render.jq
//   jq -r -f /tmp/render.jq server/gc/__fixtures__/report-live.json | shasum -a 256
//   30bba84740c18f2b2de09cbd80980b7321a5dddcbbba55f845abb00c5d161c1d
//
// Everything else pins one line of the layout to one input, so a mutation in the renderer fails
// here with the sentence it broke rather than with "digest mismatch".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildReport } from "./report";
import type {
  BuildReportInput,
  GcReport,
  ReportOrphanInput,
  ReportProcInput,
  TranscriptRow,
} from "./report";
import { renderReport } from "./render";

const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__/report-live.json"), "utf8"));

const HOME = "/Users/x/.paseo";

/**
 * The reference text with its number *scale* squashed: `135.0` -> `135`.
 *
 * jq 1.7 prints a number with the precision it was parsed with, so the capture's
 * `"footprint_mb": 135.0` is printed `135.0`. JavaScript has one number type, so the port answers
 * `135` — and, as a consequence, pads that cell with one more space. The scale is not information
 * the port can carry (JSON has no int/float distinction), so it is normalised away on both sides;
 * everything else is compared byte for byte. 35 of the reference's 150 lines carry such a value,
 * and all 35 of the lines on which the two texts differ before this normalisation are among them.
 */
function parityNormalForm(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(\d)\.0(?!\d)/g, "$1").replace(/ {2,}/g, " "))
    .join("\n");
}

/** `sha256(parityNormalForm(reference text))`. */
const REFERENCE_NORMALISED_SHA256 =
  "754ea924dd0464717b63fb9bb37b0c9e5ccf9d15409e0f64d8d2093068406e3d";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function procRow(overrides: Partial<ReportProcInput> & { pid: number }): ReportProcInput {
  return {
    ppid: 1,
    pgid: overrides.pid,
    lstart: "Thu Oct 29 11:43:14 2026",
    etime_s: 10,
    rss_mb: 10,
    mem_mb: null,
    cmprs_mb: null,
    footprint_mb: 10,
    footprintSource: "rss",
    class: "agent-descendant",
    exe: "node",
    owner: null,
    ownerState: null,
    envRead: true,
    home: "match",
    protected: null,
    underDaemon: false,
    warn: false,
    stale: { eligible: false, why: "not an agent-child/wait class" },
    overmem: { eligible: false, why: "footprint 10 MB <= 4096 MB" },
    ...overrides,
  };
}

const NOTHING = { ident: { ok: true, why: "ok", supervisorPid: 1, daemonPid: 2, listen: "127.0.0.1:6767" } };

function reportOf(overrides: Partial<BuildReportInput> = {}): GcReport {
  return buildReport({
    now: 1_800_000_000,
    generated: "2027-01-15T08:00:00Z",
    home: HOME,
    procs: { ...NOTHING },
    agents: [],
    schedules: [],
    index: { ok: true, why: [] },
    garbage: [],
    warnMb: 3072,
    killMb: 4096,
    ...overrides,
  });
}

const lines = (text: string): string[] => text.split("\n");

/** The single line containing `needle`, with its trailing whitespace kept. */
function lineWith(text: string, needle: string): string {
  const found = lines(text).filter((line) => line.includes(needle));
  expect(found, `exactly one line containing ${JSON.stringify(needle)}`).toHaveLength(1);
  return found[0] ?? "";
}

/** The (a) table row for one pid (`  ` + `rpad(pid, 7)` + ` ` + `rpad(ppid, 7)`). */
function procLine(text: string, pid: number): string {
  const found = lines(text).filter((line) => new RegExp(`^ +${pid} +[0-9]+ +\\S`).test(line));
  expect(found, `exactly one process row for pid ${pid}`).toHaveLength(1);
  return found[0] ?? "";
}

function agentRow(state: string, id: string, reason: string, garbage = false) {
  return {
    path: `${HOME}/agents/ws/${id}.json`,
    id,
    state,
    garbage,
    reason,
    action: garbage ? `paseo agent delete ${id}` : null,
  };
}

function scheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    path: `${HOME}/schedules/b555dd4a.json`,
    size: 3356,
    ok: true,
    id: "b555dd4a",
    name: "supervisor: room",
    status: "active",
    strict: true,
    targetType: "agent",
    targetAgent: "2e3e406f-28c2-460b-bff2-da5c659260d5",
    cadence: "*/2 * * * *",
    createdAt: "2026-10-29T11:13:20.868Z",
    updatedAt: "2026-10-29T11:26:00.020Z",
    updatedEpoch: 1_793_273_160,
    lastRunAt: "2026-10-29T11:26:00.020Z",
    lastRunEpoch: 1_793_273_160,
    nextRunAt: "2026-10-29T11:28:00.000Z",
    room: true,
    runs: 7,
    runsRunning: 0,
    fires1h: 7,
    fires24h: 7,
    fail24h: 7,
    activeRunFail24h: 7,
    targetState: "live",
    garbage: false,
    reason: "protected: target agent is live/unarchived",
    action: null,
    ...overrides,
  } as unknown as GcReport["schedules"][number];
}

// ---------------------------------------------------------------------------
// Parity with the reference's own output
// ---------------------------------------------------------------------------

describe("renderReport — parity", () => {
  it("reproduces the reference's text for the captured report, byte for byte", () => {
    const text = renderReport(fixture as GcReport);
    expect(lines(text)).toHaveLength(151); // 150 lines plus the final newline's empty tail
    expect(text.endsWith("\n")).toBe(true);
    expect(sha256(parityNormalForm(text))).toBe(REFERENCE_NORMALISED_SHA256);
  });

  it("prints the header, the READ-ONLY sentence and the identification verdict verbatim", () => {
    const text = renderReport(fixture as GcReport);
    expect(lines(text)[0]).toBe("slp-gc report  2026-10-29T11:27:39Z  home /Users/<user>/.paseo");
    expect(lines(text)[1]).toBe(
      "READ-ONLY: no paseo CLI call, nothing is changed. Use --apply to reclaim (see --help).",
    );
    expect(lines(text)[2]).toBe(
      `identification: FAILED: ${fixture.procs.ident.why} -> --apply would be refused`,
    );
    expect(lines(text)[3]).toBe("");
    expect(lines(text)[4]).toBe(
      "== (a) Paseo processes  (footprint = top MEM, fallback rss; MB; warn >= 3072 MB, memory-kill > 4096 MB)",
    );
    expect(lines(text)[5]).toBe(
      "      PID    PPID CLASS            OWNER     AGE       FOOTPRINT    CMPRS      RSS FLAGS",
    );
    expect(lines(text)[text.split("\n").length - 2]).toBe(
      "summary: 0 garbage candidate(s); actions only with --apply. Exit 0.",
    );
  });

  it("starts with the reference header lines for a healthy identification", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ident: { ok: true, why: "ok", supervisorPid: 1, daemonPid: 2, listen: "127.0.0.1:6767" },
        },
      }),
    );
    expect(lines(text)[0]).toContain("slp-gc report  2027-01-15T08:00:00Z");
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("identification: ok");
    expect(lines(text)[2]).toBe("identification: ok (Supervisor 1, daemon 2, listener 127.0.0.1:6767)");
  });
});

// ---------------------------------------------------------------------------
// Header and index
// ---------------------------------------------------------------------------

describe("renderReport — index", () => {
  it("prints an incomplete index and refuses garbage in the same sentence", () => {
    const text = renderReport(
      reportOf({ index: { ok: false, why: ["agents: unreadable record", "schedules: missing"] } }),
    );
    expect(lines(text)[3]).toBe(
      "index: INCOMPLETE (agents: unreadable record; schedules: missing) -> nothing is garbage, --apply is refused",
    );
  });

  it("omits the line when the index is complete", () => {
    const text = renderReport(reportOf());
    expect(text).not.toContain("index: INCOMPLETE");
    expect(lines(text)[3]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// (a) the process table
// ---------------------------------------------------------------------------

describe("renderReport — process table", () => {
  it("sorts by class and then by footprint, and formats every column", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          procs: [
            procRow({ pid: 100, class: "agent-descendant", footprint_mb: 70, cmprs_mb: 4, rss_mb: 20 }),
            procRow({
              pid: 644,
              class: "app-main",
              ppid: 1,
              owner: "11111111-2222-3333-4444-555555555555",
              etime_s: 24265,
              footprint_mb: 112,
              footprintSource: "top",
              cmprs_mb: 60,
              rss_mb: 194.7,
              warn: true,
              protected: "in the GC's own process tree",
              home: "other",
            }),
            procRow({ pid: 101, class: "agent-descendant", footprint_mb: 135.5, cmprs_mb: null }),
          ],
        },
      }),
    );
    expect(lineWith(text, "     644")).toBe(
      "      644       1 app-main         11111111  6h44m           112       60    194.7 !!WARN protected other-home ",
    );
    // `rss`-sourced footprints carry the reference's `*`.
    expect(lineWith(text, "     101")).toBe(
      "      101       1 agent-descendant -         0m10s        135.5*        -       10 ",
    );
    // `sort_by(.class, -.footprint_mb)`: the same class, the bigger footprint first.
    const order = lines(text)
      .filter((line) => /^ {6}\d+ +1 agent-descendant /.test(line))
      .map((line) => line.trim().split(" ")[0]);
    expect(order).toEqual(["101", "100"]);
  });

  it("truncates a class at sixteen characters and pads an owner at nine", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          procs: [procRow({ pid: 5, class: "agent-descendant-long" as ReportProcInput["class"], owner: "abcdefghijklmnop" })],
        },
      }),
    );
    const row = procLine(text, 5);
    // `pad` cuts at the width where `rpad` does not.
    expect(row).toContain(" agent-descendant ");
    expect(row).not.toContain("agent-descendant-long");
    // The owner is padded to nine, and a longer one is left whole.
    expect(row).toContain(" abcdefgh ");
  });

  it("sorts a row with no class first, and measures a column in characters, not code units", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          procs: [
            procRow({ pid: 20, class: "app-main" }),
            // jq's `sort_by(.class, …)` puts the null class before every string.
            procRow({ pid: 21, class: null, footprint_mb: 999 }),
            // jq's `pad` cuts at 16 *code points*; a UTF-16 slice would cut at 8 of these.
            procRow({ pid: 22, class: ("\u{1f600}".repeat(20)) as ReportProcInput["class"] }),
          ],
        },
      }),
    );
    const order = lines(text)
      .filter((line) => /^ +(20|21) +\d+ +\S/.test(line))
      .map((line) => line.trim().split(" ")[0]);
    expect(order).toEqual(["21", "20"]);
    expect(procLine(text, 22)).toContain(` ${"\u{1f600}".repeat(16)} `);
  });

  it("formats ages in days, hours, minutes and seconds", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          procs: [
            procRow({ pid: 1, etime_s: 86400 }),
            procRow({ pid: 2, etime_s: 90061 }),
            procRow({ pid: 3, etime_s: 3599 }),
            procRow({ pid: 4, etime_s: 61 }),
            procRow({ pid: 5, etime_s: -1 }),
          ],
        },
      }),
    );
    expect(procLine(text, 1)).toContain(" 1d0h ");
    expect(procLine(text, 2)).toContain(" 1d1h ");
    expect(procLine(text, 3)).toContain(" 59m59s ");
    expect(procLine(text, 4)).toContain(" 1m1s ");
    // An unreadable age is `-1`, which jq's arithmetic prints as `-1m-1s`.
    expect(procLine(text, 5)).toContain(" -1m-1s ");
  });

  it("prints the per-class totals and the ALL line", () => {
    const text = renderReport(fixture as GcReport);
    expect(lineWith(text, "totals per class")).toBe(
      "  totals per class (n, footprint MB, rss MB):",
    );
    const totals = lines(text).filter((line) => /^ {4}\S+ +\d+ +\d/.test(line));
    expect(totals[0]).toBe("    daemon             1        1479       310.1");
    expect(totals[totals.length - 1]).toBe("    ALL               38      4557.1      3491.7");
  });

  it("says when there is no process, and notes unreadable ps rows", () => {
    const empty = renderReport(reportOf());
    expect(empty).toContain("  (no Paseo process found)");
    const unreadable = renderReport(reportOf({ procs: { ...NOTHING, unreadableRows: 3 } }));
    expect(unreadable).toContain(
      "  note: 3 ps row(s) could not be read and were skipped",
    );
  });

  it("counts the agent-family rows whose environment could not be read", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          procs: [
            procRow({ pid: 1, class: "claude-child", envRead: false }),
            procRow({ pid: 2, class: "paseo-wait", envRead: true }),
            procRow({ pid: 3, class: "helper-other", envRead: false }),
          ],
        },
      }),
    );
    expect(text).toContain(
      "  env visibility: PASEO_HOME readable for 1 of 2 agent-family processes",
    );
  });

  it("prints the last daemon self-metric, or says there is none", () => {
    const withMetrics = renderReport(
      reportOf({
        daemonMetrics: [
          { time: 1, pid: 2, rss: 3, heapUsed: 4, timelineStats: { a: 1 } },
          { time: 5, pid: 6, rss: 7, heapUsed: 8, timelineStats: { totalItems: 3572 } },
        ],
      }),
    );
    expect(lineWith(withMetrics, "daemon self-metrics")).toBe(
      '  daemon self-metrics (last ws_runtime_metrics): 5 rss=7 heapUsed=8 timelineStats={"totalItems":3572}',
    );
    expect(renderReport(reportOf())).toContain("  daemon self-metrics: none found in daemon.log");
  });

  it("adds the orphan rule, memory rule and memory-warn lines", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          procs: [
            procRow({
              pid: 10,
              class: "claude-child",
              stale: { eligible: true, why: "orphan: reparented to launchd (ppid==1)" },
              overmem: { eligible: false, why: "report only: an agent child itself is never memory-killed (use `paseo agent stop`)" },
            }),
            procRow({
              pid: 11,
              class: "agent-descendant",
              footprint_mb: 5000,
              warn: true,
              overmem: { eligible: true, why: "footprint 5000 MB > 4096 MB" },
            }),
            procRow({
              pid: 12,
              class: "renderer",
              footprint_mb: 4000,
              warn: true,
              overmem: { eligible: false, why: "footprint 4000 MB <= 4096 MB" },
            }),
          ],
        },
      }),
    );
    expect(text).toContain(
      "      orphan rule: orphan: reparented to launchd (ppid==1)  => WOULD SIGTERM pid 10 (with --apply --kill-stale-processes)",
    );
    expect(text).toContain(
      "      memory rule: footprint 5000 MB > 4096 MB  => WOULD SIGTERM pid 11 (with --apply --kill-over-memory)",
    );
    expect(text).toContain("      memory: above warn; not killable: footprint 4000 MB <= 4096 MB");
    // A non-agent-family row gets no orphan-rule line at all.
    expect(text).not.toContain("orphan rule: footprint");
  });
});

// ---------------------------------------------------------------------------
// (a2) orphans
// ---------------------------------------------------------------------------

describe("renderReport — orphan section", () => {
  function orphan(overrides: Partial<ReportOrphanInput> = {}): ReportOrphanInput {
    return {
      pid: 4444,
      ppid: 1,
      pgid: 4444,
      lstart: "Thu Oct 29 11:43:14 2026",
      etime_s: 600,
      class: "orphan",
      exe: "node",
      comm: "node",
      owner: "pid:31647@Thu Oct 29 18:17:13 2026",
      ownerState: null,
      proof: "ledger",
      orphanedAt: 1_790_000_000,
      exePath: "/opt/homebrew/bin/node",
      envRead: true,
      home: "match",
      rss_mb: 50,
      mem_mb: null,
      cmprs_mb: null,
      footprint_mb: 50,
      footprintSource: "rss",
      protected: null,
      proven: true,
      underDaemon: false,
      warn: false,
      hint: null,
      stale: { eligible: true, why: "orphaned agent descendant: ppid 1, proven by the lineage ledger" },
      overmem: { eligible: false, why: "footprint 50 MB <= 4096 MB" },
      ...overrides,
    };
  }

  it("says none when the ledger proved nothing, and prints the ledger crumbs", () => {
    expect(renderReport(reportOf())).toContain("  (none with agent provenance)");
    const text = renderReport(
      reportOf({
        procs: { ...NOTHING, ledgerNote: "lineage.tsv unreadable", ledgerDropped: 2 },
      }),
    );
    expect(text).toContain("  LEDGER: lineage.tsv unreadable");
    expect(text).toContain(
      "  LEDGER: 2 row(s) failed validation (owner syntax, timestamps, comm, exe path) and were ignored",
    );
  });

  it("prints an orphan row with its proof, flags and follow-up lines", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          orphans: [
            orphan(),
            orphan({ pid: 5000, footprint_mb: 60, protected: "in the GC's own process tree", proven: false, hint: "/w/room" }),
          ],
        },
      }),
    );
    expect(text).toContain(
      "     4444 node       owner pid:3164  10m0s         50 MB proof ledger  ORPHAN",
    );
    // `sort_by(-.footprint_mb)`: the heavier row first.
    const rows = lines(text).filter((line) => line.includes("proof ledger"));
    expect(rows[0]).toBe(
      "     5000 node       owner pid:3164  10m0s         60 MB proof ledger PROTECTED ",
    );
    expect(text).toContain("      hint (never proof): cwd /w/room");
  });

  it("prints the memory rule for an orphan that is over the kill threshold", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          orphans: [
            orphan({
              overmem: { eligible: true, why: "proven orphan, footprint 5000 MB > 4096 MB" },
              footprint_mb: 5000,
            }),
          ],
        },
      }),
    );
    expect(text).toContain(
      "      memory rule: proven orphan, footprint 5000 MB > 4096 MB  => WOULD SIGTERM pid 4444 (with --apply --kill-over-memory)",
    );
  });
});

// ---------------------------------------------------------------------------
// (a3) / (a4) the memory tree and the test-runner count
// ---------------------------------------------------------------------------

describe("renderReport — tree and test-runner sections", () => {
  const treeRow = (overrides: Record<string, unknown> = {}) => ({
    pid: 31647,
    class: "claude-child",
    owner: "pid:31647@Thu Oct 29 18:17:13 2026",
    n: 9,
    footprint_mb: 559.6,
    testWorkers: 1,
    testMb: 50,
    ...overrides,
  });

  it("prints the tree total, the daemon line and the per-agent rows", () => {
    const text = renderReport(fixture as GcReport);
    expect(text).toContain(
      "  tree total 7228.4 MB  = app subtree 7228.4 + proven orphans 0 (0)   warn >= 12288 MB (50% of 24576 MB RAM)",
    );
    expect(text).toContain(
      "  daemon: pid 1320 footprint 1479 MB (report-only: the daemon is never memory-killed)",
    );
    expect(text).toContain(
      "    pid:31647    claude-child  processes    9      559.6 MB",
    );
  });

  it("marks an over-budget tree, an absent daemon and an empty agent table", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          tree: { totalMb: 9000, appMb: 9000, warnMb: 8000, ramMb: 16000, over: true },
        },
      }),
    );
    expect(text).toContain(
      "  tree total 9000 MB  = app subtree 9000 + proven orphans 0 (0)   warn >= 8000 MB (50% of 16000 MB RAM)   !!TREE-WARN",
    );
    expect(text).toContain("  daemon: not found");
    expect(text).toContain("    (no agent child found)");
  });

  it("prints the test-runner count with its warn marker and rows", () => {
    const text = renderReport(
      reportOf({
        procs: {
          ...NOTHING,
          tree: {
            agents: [treeRow()],
            tests: { agents: 1, warnAt: 1, over: true, rows: [treeRow()] },
          },
        },
      }),
    );
    expect(text).toContain(
      "== (a4) test-runner concurrency (report-only): 1 agent(s) with vitest/jest/pytest/mocha/playwright subtrees (warn when > 1)   !!CONCURRENCY-WARN",
    );
    expect(text).toContain("    pid:31647    test-runner processes    1         50 MB");
  });
});

// ---------------------------------------------------------------------------
// (b) schedules
// ---------------------------------------------------------------------------

describe("renderReport — schedules", () => {
  it("prints a schedule row with its target, cadence, size and heartbeat health", () => {
    const text = renderReport(reportOf({ schedules: [scheduleRow()] }));
    expect(text).toContain("== (b) recurring machinery: schedules / heartbeats on disk (1)");
    expect(text).toContain(
      "  b555dd4a  active     target agent:2e3e406f (live)  cadence */2 * * * *  runs 7  size 3 KB  fires 1h/24h 7/7  name supervisor: room",
    );
    expect(text).toContain("      protected: target agent is live/unarchived  | action: null");
    expect(text).toContain(
      '      heartbeat health: runs[] 7, failures in the last 24 h 7, "already has an active run" share 100%',
    );
  });

  it("prints n/a for a share it cannot compute, and no health line without runs", () => {
    const text = renderReport(
      reportOf({ schedules: [scheduleRow({ fail24h: 0, activeRunFail24h: 0 }), scheduleRow({ id: "aaaa0000", runs: 0 })] }),
    );
    expect(text).toContain('"already has an active run" share n/a');
    expect(lines(text).filter((line) => line.includes("heartbeat health"))).toHaveLength(1);
  });

  it("formats a record's size through the reference's bytes() helper", () => {
    const text = renderReport(
      reportOf({
        schedules: [
          scheduleRow({ id: "aaaaaaaa", size: 1023 }),
          scheduleRow({ id: "bbbbbbbb", size: 1024 }),
          scheduleRow({ id: "cccccccc", size: 2_097_152 }),
        ],
      }),
    );
    // Below 1 KB the byte count itself; at and above it, floored to KB (1024 B is "1 KB").
    expect(lineWith(text, "aaaaaaaa")).toContain(" size 1023 B  ");
    expect(lineWith(text, "bbbbbbbb")).toContain(" size 1 KB  ");
    expect(lineWith(text, "cccccccc")).toContain(" size 2 MB  ");
  });

  it("sorts an unreadable record before every real id, as sort_by(.id) does with a null", () => {
    const text = renderReport(
      reportOf({
        schedules: [
          scheduleRow({ id: "b555dd4a" }),
          scheduleRow({ id: null, path: `${HOME}/schedules/aa.json`, reason: "skipped: unreadable record" }),
          scheduleRow({ id: "aaaa0000" }),
        ],
      }),
    );
    // jq's order is null < numbers < strings, so the unreadable row comes first — not last, which
    // is where a `String(null)` comparison would put it.
    const ids = lines(text).filter((line) => /^ {2}(b555dd4a|aaaa0000|\S*aa\.json) /.test(line));
    expect(ids[0]).toContain("/schedules/aa.json  UNREADABLE");
    expect(ids.slice(1).map((line) => line.trim().slice(0, 8))).toEqual(["aaaa0000", "b555dd4a"]);
  });

  it("prints an unreadable record as a skipped line and says none when empty", () => {
    const text = renderReport(
      reportOf({ schedules: [scheduleRow({ id: null, reason: "skipped: unreadable record (not a JSON object)" })] }),
    );
    expect(text).toContain(
      `  ${HOME}/schedules/b555dd4a.json  UNREADABLE: skipped: unreadable record (not a JSON object)  size 3356 B  -> skipped`,
    );
    expect(renderReport(reportOf())).toContain("  (none)");
  });
});

// ---------------------------------------------------------------------------
// (c) agents and transcripts
// ---------------------------------------------------------------------------

describe("renderReport — agents and transcripts", () => {
  it("prints the counts and the ten largest transcripts", () => {
    const transcripts: TranscriptRow[] = Array.from({ length: 12 }, (_unused, index) => ({
      bytes: 20_000_000 - index,
      path: `/c/projects/p/s${index}.jsonl`,
      sessionId: `s${index}`,
      agent: { id: `agent-${index}`, state: "archived", provider: "claude" },
    }));
    const text = renderReport(reportOf({ transcripts, agents: [agentRow("live", "a", "x")] }));
    expect(text).toContain(
      "== (c) agents: 1 records  live 1  archived 0  closed-unarchived 0  unreadable 0",
    );
    expect(text).toContain("  largest transcripts (CLAUDE_CONFIG_DIR/projects/*/<sessionId>.jsonl):");
    expect(text).toContain(
      "        20000000 B  agent-0 archived claude  /c/projects/p/s0.jsonl",
    );
    // `. [:10]`: eleven of the twelve are not printed.
    expect(lines(text).filter((line) => line.includes("/c/projects/p/s"))).toHaveLength(10);
    expect(text).not.toContain("/c/projects/p/s11.jsonl");
  });

  it("renders a transcript whose agent the index does not name", () => {
    const text = renderReport(
      reportOf({ transcripts: [{ bytes: 1, path: "/c/x.jsonl", sessionId: "x", agent: null }] }),
    );
    expect(text).toContain("            1 B  - unknown-agent   /c/x.jsonl");
  });

  it("says none when nothing cleared the size floor", () => {
    expect(renderReport(reportOf())).toContain("    (none above the size floor / not locatable)");
  });
});

// ---------------------------------------------------------------------------
// (d) garbage candidates
// ---------------------------------------------------------------------------

describe("renderReport — garbage candidates", () => {
  const garbageRow = (index: number) => ({
    kind: "agent" as const,
    id: `g-${index}`,
    path: `${HOME}/agents/ws/g-${index}.json`,
    sig: "1:2:3",
    rule: "agent-archived" as const,
    refusedBy: null,
    reason: "GARBAGE: archived 30 d ago",
    action: `paseo agent delete g-${index}`,
  });

  it("prints none when there is nothing to reclaim", () => {
    const text = renderReport(reportOf());
    expect(text).toContain("== (d) garbage candidates: 0 (rules: memleak-live.md §6)");
    expect(text).toContain("  (none)");
  });

  it("prints every candidate with its would-be action", () => {
    const text = renderReport(reportOf({ garbage: [garbageRow(1)] }));
    expect(text).toContain("== (d) garbage candidates: 1 (rules: memleak-live.md §6)");
    expect(text).toContain(
      `  [agent] g-1  ${HOME}/agents/ws/g-1.json\n      GARBAGE: archived 30 d ago\n      would: paseo agent delete g-1`,
    );
  });

  it("truncates the candidate list at 200 with the reference's message", () => {
    const many = Array.from({ length: 203 }, (_unused, index) => garbageRow(index));
    const text = renderReport(reportOf({ garbage: many }));
    expect(lines(text).filter((line) => line.includes("would: paseo agent delete"))).toHaveLength(200);
    expect(text).toContain("  ... 3 more (see --json)");
  });

  it("groups the refused agents by the rule that failed, normalising numbers", () => {
    const rows = [
      agentRow("archived", "a1", "not garbage: archived 30 d ago"),
      agentRow("archived", "a2", "not garbage: archived 3 d ago"),
      agentRow("live", "a3", "not garbage: unarchived agent (lastStatus idle)"),
      agentRow("live", "a4", "not garbage: unarchived agent (lastStatus idle)"),
      agentRow("live", "a5", "not garbage: unarchived agent (lastStatus idle)"),
    ];
    const text = renderReport(reportOf({ agents: rows }));
    expect(text).toContain("  not garbage, agents grouped by the rule that failed:");
    expect(text).toContain("      3x  not garbage: unarchived agent (lastStatus idle)   (e.g. a3)");
    // Two rows that differ only in a number are one group (`gsub("[0-9]+"; "N")`).
    expect(text).toContain("      2x  not garbage: archived 30 d ago   (e.g. a1)");
    // Sorted by size: the three-row group first.
    const grouped = lines(text).filter((line) => line.includes("   (e.g. "));
    expect(grouped[0]).toContain("      3x");
  });

  it("lists anomalies and skipped rows, truncating at forty", () => {
    const rows = Array.from({ length: 42 }, (_unused, index) =>
      agentRow("unreadable", `u${index}`, "skipped: unknown lastStatus null"),
    );
    const text = renderReport(reportOf({ agents: rows }));
    expect(text).toContain("  anomalies / unreadable (skipped, never touched):");
    expect(lines(text).filter((line) => line.startsWith("    [agent] u"))).toHaveLength(40);
    expect(text).toContain("  ... 2 more (see --json)");
  });
});

// ---------------------------------------------------------------------------
// (e) retention
// ---------------------------------------------------------------------------

describe("renderReport — retention", () => {
  const entry = (index: number, kb: number) => ({
    cat: "home-entry",
    path: `${HOME}/entry-${String(index).padStart(2, "0")}`,
    kb,
    count: index,
    note: "report-only: no Paseo CLI path",
  });

  it("prints the fifteen largest home entries and each group", () => {
    const text = renderReport(fixture as GcReport);
    expect(text).toContain(
      "== (e) retention data (report only; nothing here has a Paseo CLI reclaim path)",
    );
    expect(text).toContain("  top-level entries of the home by size:");
    expect(text).toContain("      984.1 MB  files    365  /Users/<user>/.paseo/models");
    expect(text).toContain("  agent-requests (1):");
    expect(text).toContain(
      "        5.4 MB  /Users/<user>/.paseo/agent-requests  -- daemon-owned; report-only (no CLI path)",
    );
  });

  it("keeps fifteen entries and marks the ones it dropped from view", () => {
    const many = Array.from({ length: 18 }, (_unused, index) => entry(index, 1000 + index));
    const text = renderReport(reportOf({ retention: many }));
    const shown = lines(text).filter((line) => line.includes("/entry-"));
    expect(shown).toHaveLength(15);
    // Largest first.
    expect(shown[0]).toContain("/entry-17");
  });

  it("groups by category in name order and caps a group at twenty-five rows", () => {
    const logs = Array.from({ length: 27 }, (_unused, index) => ({
      cat: "log",
      path: `${HOME}/daemon-${index}.log`,
      kb: 1024,
      count: 1,
      note: "age 0 d; report-only (daemon.log is held open by the Supervisor)",
    }));
    const text = renderReport(
      reportOf({
        retention: [entry(0, 8), ...logs, { cat: "config-backup", path: `${HOME}/b`, kb: 2, count: 1, note: "never read" }],
      }),
    );
    const headers = lines(text).filter((line) => /^ {2}\S+ \(\d+\):$/.test(line));
    expect(headers).toEqual(["  config-backup (1):", "  log (27):"]);
    expect(lines(text).filter((line) => line.includes("/daemon-"))).toHaveLength(25);
  });

  it("formats kilobytes through the reference's kb() helper", () => {
    const text = renderReport(
      reportOf({
        retention: [
          { cat: "home-entry", path: "/h/a", kb: 0, count: 0, note: "" },
          { cat: "home-entry", path: "/h/b", kb: 1023, count: 0, note: "" },
          { cat: "home-entry", path: "/h/c", kb: 1024, count: 0, note: "" },
          { cat: "home-entry", path: "/h/d", kb: 1_048_576, count: 0, note: "" },
        ],
      }),
    );
    expect(text).toContain("    0 KB  files      0  /h/a");
    expect(text).toContain("    1023 KB  files      0  /h/b");
    expect(text).toContain("    1 MB  files      0  /h/c");
    expect(text).toContain("    1 GB  files      0  /h/d");
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("renderReport — robustness", () => {
  it("washes the reference's control characters out of every string", () => {
    const text = renderReport(
      reportOf({ home: `/h\u0007ome\u001b`, agents: [agentRow("live", "a", "not garbage: bell\u0007")] }),
    );
    expect(text).toContain("home /h?ome?");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("not garbage: bell?");
    // A newline in a string is a control character too, so it cannot break the layout.
    const baseline = lines(renderReport(reportOf())).length;
    expect(lines(renderReport(reportOf({ home: "/h\nome" })))).toHaveLength(baseline);
  });

  it("renders a half-filled report instead of throwing", () => {
    const broken = {
      version: 1,
      generated: "x",
      home: "/h",
      procs: { ident: { ok: false, why: "nope" }, procs: [], orphans: [], warnMb: 1, killMb: 2 },
      agents: [],
      schedules: [],
      index: { ok: true, why: [] },
      garbage: [],
      transcripts: [],
      daemonMetrics: [],
      retention: [],
    } as unknown as GcReport;
    const text = renderReport(broken);
    expect(text).toContain("identification: FAILED: nope -> --apply would be refused");
    expect(text).toContain("summary: 0 garbage candidate(s); actions only with --apply. Exit 0.");
    expect(() => renderReport({} as GcReport)).not.toThrow();
  });
});

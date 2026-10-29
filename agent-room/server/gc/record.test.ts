// The memory record: one JSONL sample, rotation, alerts.
//
// Every test runs in its own `mkdtemp` directory and injects a no-op `notify`: nothing here reads
// or writes `~/Library/Logs/slp-gc`, and no test depends on a notification centre. The clock is an
// argument, so the 15-minute window is exercised without waiting.
//
// The three tests from the task brief come first, unmodified in substance; the rest pin the
// properties the brief's self-review asks about — the sample's shape, each alert reason, the
// window, rotation with a predecessor, and a rotation that fails.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ReportOrphanRow, ReportProcRow } from "./report";
import {
  ALERTS_FILE,
  ALERTS_MAX_BYTES,
  ALERT_STAMP_FILE,
  ALERT_WINDOW_MINUTES,
  MEMORY_FILE,
  MEMORY_MAX_BYTES,
  MEMORY_SAMPLE_PROCS,
  ORPHAN_ALERT_MB,
  rotate,
  recordSample,
} from "./record";
import type { MemorySample, RecordReport } from "./record";

const report = {
  generated: "2027-01-15T08:00:00Z",
  procs: { procs: [{ pid: 1, class: "daemon", footprint_mb: 500, rss_mb: 400 }], orphans: [],
    tree: { totalMb: 500, over: false, warnMb: 8192 }, totals: [], overall: { n: 1, footprint_mb: 500, rss_mb: 400 } },
} as never;

describe("recordSample", () => {
  it("appends one JSONL line and stays quiet under thresholds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-record-"));
    const result = await recordSample({ stateDir: dir, report, now: 1_800_000_000, alertStampMinutes: 60 });
    expect(result.alert).toBeNull();
    const lines = readFileSync(join(dir, "memory.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toHaveProperty("procs");
  });
});

describe("rotate", () => {
  it("keeps one predecessor when the file would exceed the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-rot-"));
    const file = join(dir, "memory.jsonl");
    writeFileSync(file, "x".repeat(100));
    rotate(file, 120, 30);
    expect(readFileSync(`${file}.1`, "utf8").length).toBe(100);
    expect(existsSync(file)).toBe(false);
  });
  it("leaves the file alone when it fits", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-rot-"));
    const file = join(dir, "memory.jsonl");
    writeFileSync(file, "x".repeat(10));
    rotate(file, 120, 30);
    expect(readFileSync(file, "utf8").length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `ReportProcRow` from the fields a case cares about; the rest is filler a record never reads. */
function proc(fields: Partial<ReportProcRow> & { pid: number; footprint_mb: number }): ReportProcRow {
  return {
    ppid: 1,
    pgid: fields.pid,
    lstart: "Thu Oct 29 11:43:14 2026",
    etime_s: 60,
    class: "daemon",
    exe: "Paseo",
    owner: null,
    ownerState: null,
    envRead: false,
    home: "unreadable",
    rss_mb: 1,
    mem_mb: 1,
    cmprs_mb: 1,
    footprintSource: "top",
    protected: null,
    underDaemon: false,
    warn: false,
    ...fields,
  } as unknown as ReportProcRow;
}

/** An `ReportOrphanRow` with the eight sample fields plus the identity the report needs. */
function orphan(fields: Partial<ReportOrphanRow> & { pid: number; footprint_mb: number }): ReportOrphanRow {
  return {
    ppid: 1,
    pgid: fields.pid,
    lstart: "Thu Oct 29 11:43:14 2026",
    etime_s: 60,
    class: "orphan",
    exe: "claude",
    comm: "claude",
    owner: null,
    ownerState: null,
    proof: "ledger",
    orphanedAt: 0,
    exePath: "",
    envRead: false,
    home: "unreadable",
    rss_mb: 1,
    mem_mb: 1,
    cmprs_mb: 1,
    footprintSource: "top",
    protected: null,
    proven: true,
    underDaemon: false,
    warn: false,
    hint: null,
    stale: { eligible: false, why: "" },
    overmem: { eligible: false, why: "" },
    ...fields,
  } as unknown as ReportOrphanRow;
}

/** A report whose process section is exactly what a case needs. */
function reportWith(
  procs: readonly ReportProcRow[],
  orphans: readonly ReportOrphanRow[] = [],
  tree = {},
  warnMb?: number,
): RecordReport {
  return {
    generated: "2027-01-15T08:00:00Z",
    procs: {
      procs: [...procs],
      orphans: [...orphans],
      tree: tree as never,
      ...(warnMb === undefined ? {} : { warnMb }),
    },
  };
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The single sample a quiet record wrote. */
function sampleAt(dir: string): MemorySample {
  const raw = readFileSync(join(dir, MEMORY_FILE), "utf8");
  return JSON.parse(raw) as MemorySample;
}

function alertLines(dir: string): string[] {
  const path = join(dir, ALERTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n");
}

/** The injected `notify`: a no-op that records its calls, so no test can pop a real banner. */
function recorder(): { notify: (title: string, body: string) => void; calls: [string, string][] } {
  const calls: [string, string][] = [];
  return { notify: (title, body) => calls.push([title, body]), calls };
}

const QUIET = { notify: (): void => {} };

// ---------------------------------------------------------------------------
// The sample's shape (slp-gc.bash:1203-1211)
// ---------------------------------------------------------------------------

describe("recordSample — the line", () => {
  it("writes the reference's eight keys, in its order, once per call", async () => {
    const dir = tmpDir("gc-shape-");
    const quiet = reportWith([proc({ pid: 7, footprint_mb: 100 })]);
    await recordSample({ stateDir: dir, report: quiet, now: 1_800_000_000, ...QUIET });
    await recordSample({ stateDir: dir, report: quiet, now: 1_800_000_060, ...QUIET });

    const lines = readFileSync(join(dir, MEMORY_FILE), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const sample = JSON.parse(lines[0]) as MemorySample;
    // :1206-1211 — the jq program's key order, which a consumer may rely on.
    expect(Object.keys(sample)).toEqual([
      "ts",
      "epoch",
      "procs",
      "orphans",
      "tree",
      "totals",
      "overall",
      "system",
    ]);
    // `--arg ts "$(iso_now)" --argjson epoch "$NOW"` (:1203).
    expect(sample.ts).toBe("2027-01-15T08:00:00Z");
    expect(sample.epoch).toBe(1_800_000_000);
    expect(JSON.parse(lines[1]).epoch).toBe(1_800_000_060);
    // The line ends with exactly one newline: an appended line, never a rewritten file.
    expect(lines[0].endsWith("}")).toBe(true);
    expect(readFileSync(join(dir, MEMORY_FILE), "utf8")).toMatch(/\}\n$/);
  });

  it("sorts the process rows by footprint, caps them at thirty, and keeps the ten fields", async () => {
    const dir = tmpDir("gc-procs-");
    // 31 rows, footprints 1..31: the cap drops exactly the smallest one, the sort reverses them.
    const procs = Array.from({ length: 31 }, (_, index) =>
      proc({ pid: index + 1, footprint_mb: index + 1 }),
    );
    await recordSample({ stateDir: dir, report: reportWith(procs), now: 1_800_000_000, ...QUIET });

    const sample = sampleAt(dir);
    expect(sample.procs).toHaveLength(MEMORY_SAMPLE_PROCS);
    expect(MEMORY_SAMPLE_PROCS).toBe(30);
    expect(sample.procs.map((row) => row.footprint_mb)).toEqual(
      Array.from({ length: 30 }, (_, index) => 31 - index),
    );
    expect(Object.keys(sample.procs[0])).toEqual([
      "pid",
      "ppid",
      "class",
      "owner",
      "exe",
      "etime_s",
      "mem_mb",
      "cmprs_mb",
      "rss_mb",
      "footprint_mb",
    ]);
  });

  it("keeps the orphan rows' proof facts and the system block's null fallbacks", async () => {
    const dir = tmpDir("gc-orph-");
    const orphanRows = [orphan({ pid: 42, footprint_mb: 300, owner: "agent-1" })];
    await recordSample({ stateDir: dir, report: reportWith([], orphanRows), now: 1_800_000_000, ...QUIET });

    const sample = sampleAt(dir);
    expect(Object.keys(sample.orphans[0])).toEqual([
      "pid",
      "comm",
      "owner",
      "proof",
      "proven",
      "protected",
      "etime_s",
      "footprint_mb",
    ]);
    expect(sample.orphans[0]).toMatchObject({ pid: 42, comm: "claude", proof: "ledger", proven: true });
    // :1201-1202 — every value that was not read is null, and the raw sysctl text is "".
    expect(sample.system).toEqual({
      vm_page_size: null,
      compressor_stored_pages: null,
      compressor_occupied_pages: null,
      swapouts: null,
      pageouts: null,
      swap_used_mb: null,
      swap_raw: "",
    });
  });
});

// ---------------------------------------------------------------------------
// The three alert reasons (slp-gc.bash:1215-1219)
// ---------------------------------------------------------------------------

describe("recordSample — alert reasons", () => {
  it("trips on a process at or above the warn threshold", async () => {
    const dir = tmpDir("gc-warn-");
    // The default SLP_GC_MEM_WARN_MB is 3072; 3072 is inclusive, so it trips.
    const trip = reportWith([proc({ pid: 9, class: "daemon", footprint_mb: 3072 })]);
    const result = await recordSample({ stateDir: dir, report: trip, now: 1_800_000_000, ...QUIET });

    expect(result.alert).toBe(
      "2027-01-15T08:00:00Z ALERT footprint >= 3072 MB: daemon pid 9 3072 MB",
    );
    // The same text is what alerts.log holds, and it is the one line the returned `line` describes.
    expect(alertLines(dir)).toEqual([result.alert as string]);
    expect(readFileSync(join(dir, MEMORY_FILE), "utf8").trim()).toBe(JSON.stringify(result.line));
    // The stamp is the window's start, in epoch seconds.
    expect(readFileSync(join(dir, ALERT_STAMP_FILE), "utf8").trim()).toBe("1800000000");

    const below = tmpDir("gc-warn-");
    const quiet = reportWith([proc({ pid: 9, footprint_mb: 3071 })]);
    expect((await recordSample({ stateDir: below, report: quiet, now: 1_800_000_000, ...QUIET })).alert).toBeNull();
    expect(alertLines(below)).toEqual([]);
  });

  it("joins two over-threshold processes with '; ' inside the warn arm", async () => {
    const dir = tmpDir("gc-warn2-");
    // Both rows clear 3072: one alert, one arm, the rows joined by `join("; ")` (:1216) — not by
    // the ` | ` that separates the arms (:1225-1227).
    const trip = reportWith([
      proc({ pid: 9, class: "daemon", footprint_mb: 4096 }),
      proc({ pid: 8, class: "claude-child", footprint_mb: 3072 }),
    ]);
    const result = await recordSample({ stateDir: dir, report: trip, now: 1_800_000_000, ...QUIET });

    expect(result.alert).toBe(
      "2027-01-15T08:00:00Z ALERT footprint >= 3072 MB: daemon pid 9 4096 MB; " +
        "claude-child pid 8 3072 MB",
    );
    // The separator itself, asserted on its own: a comma, a bare `;` or a second ` | ` fails here.
    expect(result.alert).toContain("; ");
    expect(result.alert?.split(" | ")).toHaveLength(1);
    expect(alertLines(dir)).toEqual([result.alert as string]);
  });

  it("reads a non-positive report threshold as absent", async () => {
    // `footprint >= 0` would match every process, so a report carrying `warnMb: 0` must not turn
    // each row into an alert: the value reads as absent and the default 3072 applies.
    const zero = tmpDir("gc-warn0-");
    const ordinary = reportWith([proc({ pid: 7, footprint_mb: 10 })], [], {}, 0);
    const quiet = await recordSample({ stateDir: zero, report: ordinary, now: 1_800_000_000, ...QUIET });
    expect(quiet.alert).toBeNull();
    expect(alertLines(zero)).toEqual([]);

    const negative = tmpDir("gc-warnneg-");
    const belowZero = reportWith([proc({ pid: 7, footprint_mb: 10 })], [], {}, -4096);
    const alsoQuiet = await recordSample({ stateDir: negative, report: belowZero, now: 1_800_000_000, ...QUIET });
    expect(alsoQuiet.alert).toBeNull();

    // The fallback is the default, and the arm names it: a genuinely large row still trips.
    const tripDir = tmpDir("gc-warn0-");
    const large = reportWith([proc({ pid: 9, footprint_mb: 4096 })], [], {}, 0);
    const tripped = await recordSample({ stateDir: tripDir, report: large, now: 1_800_000_000, ...QUIET });
    expect(tripped.alert).toBe("2027-01-15T08:00:00Z ALERT footprint >= 3072 MB: daemon pid 9 4096 MB");
  });

  it("trips on the Paseo tree once its own over flag is set", async () => {
    const dir = tmpDir("gc-tree-");
    const trip = reportWith([proc({ pid: 1, footprint_mb: 10 })], [], {
      totalMb: 9000,
      appMb: 8800,
      orphanMb: 200,
      over: true,
      warnMb: 8192,
    });
    const result = await recordSample({ stateDir: dir, report: trip, now: 1_800_000_000, ...QUIET });

    expect(result.alert).toBe(
      "2027-01-15T08:00:00Z ALERT Paseo tree 9000 MB >= 8192 MB (app subtree 8800, proven orphans 200)",
    );
    expect(alertLines(dir)).toHaveLength(1);
  });

  it("trips on a proven orphan above 1024 MB, and on no unproven one", async () => {
    const dir = tmpDir("gc-oover-");
    // 4096 MB clears both the warn arm (a proven orphan joins the process table, :1216) and the
    // orphan arm (:1218), which is why both fragments appear in one line.
    const trip = reportWith(
      [proc({ pid: 1, footprint_mb: 10 })],
      [orphan({ pid: 42, footprint_mb: 4096, owner: "agent-1" })],
    );
    const result = await recordSample({ stateDir: dir, report: trip, now: 1_800_000_000, ...QUIET });
    expect(result.alert).toBe(
      "2027-01-15T08:00:00Z ALERT footprint >= 3072 MB: orphan pid 42 4096 MB | " +
        "orphaned agent descendant(s) > 1024 MB: claude pid 42 4096 MB owner agent-1",
    );

    // A proven orphan at exactly 1024 MB clears neither arm, and an unproven 4096 MB orphan is a
    // suspicion: neither alerts.
    const quiet = tmpDir("gc-oover-");
    const edge = reportWith(
      [proc({ pid: 1, footprint_mb: 10 })],
      [
        orphan({ pid: 43, footprint_mb: 1024 }),
        orphan({ pid: 44, footprint_mb: 4096, proven: false }),
      ],
    );
    const quietResult = await recordSample({ stateDir: quiet, report: edge, now: 1_800_000_000, ...QUIET });
    expect(quietResult.alert).toBeNull();
    expect(alertLines(quiet)).toEqual([]);
    // The orphan is still recorded in the sample: the alert is a message, not a filter.
    expect(sampleAt(quiet).orphans.map((row) => row.pid)).toEqual([43, 44]);
  });

  it("joins two tripped reasons into one alert line, in the reference's order", async () => {
    const dir = tmpDir("gc-both-");
    const trip = reportWith(
      [proc({ pid: 5, class: "claude-child", footprint_mb: 5000 })],
      [],
      { totalMb: 20000, appMb: 20000, orphanMb: 0, over: true, warnMb: 12288 },
    );
    const result = await recordSample({ stateDir: dir, report: trip, now: 1_800_000_000, ...QUIET });
    expect(result.alert).toBe(
      "2027-01-15T08:00:00Z ALERT footprint >= 3072 MB: claude-child pid 5 5000 MB | " +
        "Paseo tree 20000 MB >= 12288 MB (app subtree 20000, proven orphans 0)",
    );
    expect(alertLines(dir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The rate limit (slp-gc.bash:1220-1234)
// ---------------------------------------------------------------------------

describe("recordSample — the alert window", () => {
  const NOW = 1_800_000_000;

  it("suppresses a second trip inside the window and alerts again at the boundary", async () => {
    const dir = tmpDir("gc-window-");
    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);

    const first = await recordSample({ stateDir: dir, report: trip, now: NOW, ...QUIET });
    expect(first.alert).not.toBeNull();

    // 899 s later (14m59s): still inside the 15-minute window, so silence ...
    const inside = await recordSample({ stateDir: dir, report: trip, now: NOW + 899, ...QUIET });
    expect(inside.alert).toBeNull();
    expect(alertLines(dir)).toHaveLength(1);
    // ... and the stamp is not refreshed, so the window still ends when the first alert said.
    expect(readFileSync(join(dir, ALERT_STAMP_FILE), "utf8").trim()).toBe(String(NOW));

    // 900 s after the first alert the comparison is `>=`: it alerts again.
    const boundary = await recordSample({ stateDir: dir, report: trip, now: NOW + 900, ...QUIET });
    expect(boundary.alert).toBe("2027-01-15T08:15:00Z ALERT footprint >= 3072 MB: daemon pid 9 4096 MB");
    expect(alertLines(dir)).toEqual([first.alert as string, boundary.alert as string]);
    expect(readFileSync(join(dir, ALERT_STAMP_FILE), "utf8").trim()).toBe(String(NOW + 900));

    // Every call recorded its sample, alerted or not: the window gates the message, never the line.
    expect(readFileSync(join(dir, MEMORY_FILE), "utf8").trimEnd().split("\n")).toHaveLength(3);
  });

  it("honours its own window and treats an unusable stamp as window-closed", async () => {
    const dir = tmpDir("gc-window2-");
    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);

    // A 1-minute window: 60 s after the first alert it trips again.
    expect((await recordSample({ stateDir: dir, report: trip, now: NOW, alertStampMinutes: 1, ...QUIET })).alert).not.toBeNull();
    expect((await recordSample({ stateDir: dir, report: trip, now: NOW + 59, alertStampMinutes: 1, ...QUIET })).alert).toBeNull();
    expect((await recordSample({ stateDir: dir, report: trip, now: NOW + 60, alertStampMinutes: 1, ...QUIET })).alert).not.toBeNull();

    // `is_uint "$last" || last=0` (:1222): a corrupt stamp reads as "never alerted".
    writeFileSync(join(dir, ALERT_STAMP_FILE), "not-a-number\n");
    expect((await recordSample({ stateDir: dir, report: trip, now: NOW + 120, ...QUIET })).alert).not.toBeNull();

    // A stamp in the future — a clock that went backwards — suppresses, as the reference's
    // subtraction does. It cannot cause a storm of alerts.
    writeFileSync(join(dir, ALERT_STAMP_FILE), `${NOW + 3600}\n`);
    expect((await recordSample({ stateDir: dir, report: trip, now: NOW + 180, ...QUIET })).alert).toBeNull();
  });

  it("defaults the window to the reference's fifteen minutes", () => {
    expect(ALERT_WINDOW_MINUTES).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Rotation (slp-gc.bash:1181-1184, :1213-1214)
// ---------------------------------------------------------------------------

describe("recordSample — rotation", () => {
  it("rotates at the reference's 5 MB cap, keeping exactly one predecessor", async () => {
    const dir = tmpDir("gc-cap-");
    expect(MEMORY_MAX_BYTES).toBe(5_242_880);
    const file = join(dir, MEMORY_FILE);

    // A live file one sample short of the cap: the next line overflows it, so it is rotated.
    const old = `${"x".repeat(MEMORY_MAX_BYTES - 2)}\n`;
    writeFileSync(file, old);
    // An older predecessor is replaced, never accumulated: still two files after the record.
    writeFileSync(`${file}.1`, "older\n");

    const quiet = reportWith([proc({ pid: 1, footprint_mb: 10 })]);
    await recordSample({ stateDir: dir, report: quiet, now: 1_800_000_000, ...QUIET });

    expect(readFileSync(`${file}.1`, "utf8")).toBe(old);
    const live = readFileSync(file, "utf8");
    expect(live.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(live) as MemorySample).toMatchObject({ epoch: 1_800_000_000 });
    expect(existsSync(`${file}.1.1`)).toBe(false);
  });

  it("leaves a live file that still fits, and stops rotating at exactly the cap", async () => {
    const dir = tmpDir("gc-cap2-");
    const file = join(dir, MEMORY_FILE);
    const quiet = reportWith([proc({ pid: 1, footprint_mb: 10 })]);

    // `s + incoming == max` is *not* over the cap: the reference's test is strictly greater, so
    // the line is appended to the existing file and no predecessor appears.
    const at = 1_800_000_001;
    const probe = tmpDir("gc-cap3-");
    await recordSample({ stateDir: probe, report: quiet, now: at, ...QUIET });
    const lineBytes = Buffer.byteLength(readFileSync(join(probe, MEMORY_FILE), "utf8"));
    writeFileSync(file, "x".repeat(MEMORY_MAX_BYTES - lineBytes));
    await recordSample({ stateDir: dir, report: quiet, now: at, ...QUIET });
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readFileSync(file, "utf8").length).toBe(MEMORY_MAX_BYTES);

    // One byte more and it rotates.
    await recordSample({ stateDir: dir, report: quiet, now: at + 1, ...QUIET });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")) as MemorySample).toMatchObject({ epoch: at + 1 });
  });

  it("keeps the sample when the rotation fails", async () => {
    const dir = tmpDir("gc-capfail-");
    const file = join(dir, MEMORY_FILE);
    // A directory where the predecessor goes makes `rename` fail: the live file must survive whole.
    mkdirSync(`${file}.1`, { recursive: true });
    const old = `${"x".repeat(MEMORY_MAX_BYTES - 2)}\n`;
    writeFileSync(file, old);

    const quiet = reportWith([proc({ pid: 1, footprint_mb: 10 })]);
    const result = await recordSample({ stateDir: dir, report: quiet, now: 1_800_000_000, ...QUIET });

    // The predecessor is untouched (it is still the directory that refused the rename) ...
    expect(statSync(`${file}.1`).isDirectory()).toBe(true);
    // ... the live file kept every byte it had and gained exactly one intact line ...
    const live = readFileSync(file, "utf8");
    expect(live.startsWith(old)).toBe(true);
    const appended = live.slice(old.length);
    expect(appended.endsWith("\n")).toBe(true);
    expect(JSON.parse(appended) as MemorySample).toEqual(result.line);
    // ... and the record itself is unaffected: the sample was built and returned.
    expect(result.alert).toBeNull();
    expect(result.line.epoch).toBe(1_800_000_000);
  });

  it("does not follow a symlink at the rotation path, as the reference's stat does not", async () => {
    const dir = tmpDir("gc-symlink-");
    const file = join(dir, MEMORY_FILE);
    // A file over the cap sitting behind a symlink: a size read that followed the link would see
    // the thickness and rotate the link away. The reference's `stat` is an `lstat`, so the path is
    // not a regular file, no rotation is attempted, and the append follows the link.
    const target = join(dir, "genuine.jsonl");
    const old = "x".repeat(MEMORY_MAX_BYTES - 1);
    writeFileSync(target, old);
    symlinkSync(target, file);

    const quiet = reportWith([proc({ pid: 1, footprint_mb: 10 })]);
    const result = await recordSample({ stateDir: dir, report: quiet, now: 1_800_000_000, ...QUIET });

    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(false);
    const grown = readFileSync(target, "utf8");
    expect(grown.startsWith(old)).toBe(true);
    expect(JSON.parse(grown.slice(old.length)) as MemorySample).toEqual(result.line);
  });

  it("writes the state files 0600", async () => {
    const dir = tmpDir("gc-mode-");
    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);
    await recordSample({ stateDir: dir, report: trip, now: 1_800_000_000, ...QUIET });
    for (const name of [MEMORY_FILE, ALERTS_FILE, ALERT_STAMP_FILE]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// alerts.log's own rotation (slp-gc.bash:1229)
// ---------------------------------------------------------------------------

describe("recordSample — alerts.log rotation", () => {
  const NOW = 1_800_000_000;
  /** The one arm this fixture trips: fixed text, so the file can be sized to the byte. */
  const TRIP_ALERT = "2027-01-15T08:00:00Z ALERT footprint >= 3072 MB: daemon pid 9 4096 MB";

  it("rotates alerts.log at its own 1 MB cap, within one line of it", async () => {
    const dir = tmpDir("gc-alertrot-");
    expect(ALERTS_MAX_BYTES).toBe(1_048_576);
    const alertsPath = join(dir, ALERTS_FILE);
    // A live file one byte short of the cap *once the alert line lands* (`size + incoming > max`):
    // as close to 1 MB as a file can be and still have to rotate.
    const old = `${"x".repeat(ALERTS_MAX_BYTES - TRIP_ALERT.length)}\n`;
    expect(Buffer.byteLength(old)).toBe(ALERTS_MAX_BYTES - TRIP_ALERT.length + 1);
    writeFileSync(alertsPath, old);

    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);
    const result = await recordSample({ stateDir: dir, report: trip, now: NOW, ...QUIET });

    expect(result.alert).toBe(TRIP_ALERT);
    // `rotate "$STATE/alerts.log" 1048576 ${#msg}` (:1229) is load-bearing: the old file is the
    // predecessor, and the live path holds only the new line.
    expect(readFileSync(`${alertsPath}.1`, "utf8")).toBe(old);
    expect(readFileSync(alertsPath, "utf8")).toBe(`${TRIP_ALERT}\n`);
    expect(existsSync(`${alertsPath}.1.1`)).toBe(false);
    // The rotation is what kept the file under its cap.
    expect(readFileSync(alertsPath, "utf8").length).toBeLessThan(ALERTS_MAX_BYTES);
  });

  it("leaves alerts.log alone while the line still fits", async () => {
    const dir = tmpDir("gc-alertrot2-");
    const alertsPath = join(dir, ALERTS_FILE);
    // `size + incoming === max` is not over the cap: appended in place, no predecessor.
    const old = `${"x".repeat(ALERTS_MAX_BYTES - TRIP_ALERT.length - 1)}\n`;
    expect(Buffer.byteLength(old)).toBe(ALERTS_MAX_BYTES - TRIP_ALERT.length);
    writeFileSync(alertsPath, old);

    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);
    await recordSample({ stateDir: dir, report: trip, now: NOW, ...QUIET });

    expect(existsSync(`${alertsPath}.1`)).toBe(false);
    expect(readFileSync(alertsPath, "utf8")).toBe(`${old}${TRIP_ALERT}\n`);
    // `${#msg}` is the line without its newline (:1229), so the appended file lands one byte over
    // the cap — the reference's own accounting, kept as it is.
    expect(readFileSync(alertsPath, "utf8").length).toBe(ALERTS_MAX_BYTES + 1);
  });
});

// ---------------------------------------------------------------------------
// The stamp before the alert line (slp-gc.bash:1224 before :1229-1230)
// ---------------------------------------------------------------------------

describe("recordSample — the stamp lands before the alert line", () => {
  const NOW = 1_800_000_000;

  it("leaves the stamp written when the alerts.log append fails", async () => {
    const dir = tmpDir("gc-stampfirst-");
    // A directory where alerts.log goes makes the append reject, so the alert line is lost ...
    mkdirSync(join(dir, ALERTS_FILE), { recursive: true });
    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);

    await expect(recordSample({ stateDir: dir, report: trip, now: NOW, ...QUIET })).rejects.toThrow();
    // ... but :1224 ran before :1230, so the stamp already holds the new window: one failed alert
    // file cannot turn the next tick inside the window into another alert ...
    expect(readFileSync(join(dir, ALERT_STAMP_FILE), "utf8").trim()).toBe(String(NOW));
    // ... and the sample itself is on disk — a failed alert never costs the history.
    expect(sampleAt(dir).epoch).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// The notification path (slp-gc.bash:1232)
// ---------------------------------------------------------------------------

describe("recordSample — notify", () => {
  const NOW = 1_800_000_000;

  it("notifies once per alert, with the reference's fixed text", async () => {
    const dir = tmpDir("gc-notify-");
    const { notify, calls } = recorder();
    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);

    await recordSample({ stateDir: dir, report: trip, now: NOW, notify });
    expect(calls).toEqual([["slp-gc", "Paseo memory alert (see alerts.log)"]]);

    // A suppressed trip notifies nothing.
    await recordSample({ stateDir: dir, report: trip, now: NOW + 60, notify });
    expect(calls).toHaveLength(1);
  });

  it("returns and records the same alert when notify throws", async () => {
    const dir = tmpDir("gc-notifyfail-");
    const trip = reportWith([proc({ pid: 9, footprint_mb: 4096 })]);
    const notify = vi.fn(() => {
      throw new Error("no notification centre");
    });

    const result = await recordSample({ stateDir: dir, report: trip, now: NOW, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result.alert).toBe("2027-01-15T08:00:00Z ALERT footprint >= 3072 MB: daemon pid 9 4096 MB");
    expect(alertLines(dir)).toEqual([result.alert as string]);
    // The stamp was written before the notification was attempted: one failure cannot re-alert.
    expect(readFileSync(join(dir, ALERT_STAMP_FILE), "utf8").trim()).toBe(String(NOW));
  });

  it("alerts on nothing, and notifies on nothing, when there is no reason", async () => {
    const dir = tmpDir("gc-none-");
    const { notify, calls } = recorder();
    const quiet = reportWith([proc({ pid: 1, footprint_mb: 10 })]);
    const result = await recordSample({ stateDir: dir, report: quiet, now: NOW, notify });
    expect(result.alert).toBeNull();
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, ALERTS_FILE))).toBe(false);
    expect(existsSync(join(dir, ALERT_STAMP_FILE))).toBe(false);
    expect(ORPHAN_ALERT_MB).toBe(1024);
  });
});

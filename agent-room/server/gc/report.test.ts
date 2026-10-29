// Report assembly and the three I/O collectors.
//
// Two kinds of assertion live here:
//
// 1. **Shape parity.** `__fixtures__/report-live.json` is the reference's own `report --json`
//    output for a captured home (see `__fixtures__/PROVENANCE.md`). The port's report must have
//    exactly its eleven top-level keys, `version: 1`, the same `procs` key set, and — fed its own
//    sections back — must reproduce the whole capture. That last test is what makes "the shape is
//    the contract" checkable rather than aspirational.
// 2. **Degradation.** Every collector is driven by a scripted `GcExec`; no test reads `~/.paseo`,
//    `~/Library/Logs/slp-gc`, `~/.claude` or runs a process. A broken, missing or throwing
//    command must cost rows, never an exception, and every command must be given the reference's
//    own `run_to` budget (60 s / 30 s / 15 s).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Decision, GarbageCandidate, ProcEntry } from "./evaluate";
import type { ProcClassValue } from "./identity";
import {
  buildReport,
  collectDaemonMetrics,
  collectRetention,
  collectTranscripts,
  gitState,
} from "./report";
import type {
  BuildReportInput,
  ExecOptions,
  ExecResult,
  GcExec,
  ReportProcInput,
  TranscriptRow,
} from "./report";

const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__/report-live.json"), "utf8"));

const HOME = "/Users/x/.paseo";
const INELIGIBLE: Decision = { eligible: false, why: "not an agent-child/wait class" };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function procEntry(
  overrides: Partial<ProcEntry> & { pid: number; class?: ProcClassValue | null },
): ProcEntry {
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
    cmd: "node /opt/room/server.js",
    ...overrides,
  };
}

function procRow(
  overrides: Partial<ReportProcInput> & { pid: number; class?: ProcClassValue | null },
): ReportProcInput {
  return { ...procEntry(overrides), stale: INELIGIBLE, overmem: INELIGIBLE, ...overrides };
}

function candidate(overrides: Partial<GarbageCandidate> = {}): GarbageCandidate {
  return {
    kind: "agent",
    id: "a-old",
    path: "/Users/x/.paseo/agents/ws/a-old.json",
    sig: "",
    rule: "agent-archived",
    refusedBy: null,
    reason: "GARBAGE: archived 30 d ago, lastStatus=closed, not internal, no live reference",
    action: "paseo agent delete a-old",
    ...overrides,
  };
}

/** The minimum input `buildReport` accepts; every test overrides what it is about. */
function input(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    now: 1_800_000_000,
    generated: "2027-01-15T08:00:00Z",
    home: HOME,
    procs: { ident: { ok: true, why: "ok" }, procs: [], orphans: [] },
    agents: [],
    schedules: [],
    index: { ok: true, why: [] },
    garbage: [],
    warnMb: 3072,
    killMb: 4096,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A scripted host: a tiny in-memory filesystem behind the `GcExec` port
// ---------------------------------------------------------------------------

interface ScriptedFile {
  size?: number;
  mtime?: number;
}

/**
 * Answers the collectors' argv from a fixed description of a machine. Nothing here touches the
 * real filesystem: a path is a "directory" because the test said so.
 */
class FakeHost {
  readonly calls: { argv: string[]; timeoutMs: number }[] = [];
  readonly dirs = new Set<string>();
  readonly symlinks = new Set<string>();
  readonly files = new Map<string, ScriptedFile>();
  /** `find <target> …` output: the entries, in this order (they get NUL-separated). */
  readonly listings = new Map<string, string[]>();
  /** `du -skP -- <path>` answers. */
  readonly blocks = new Map<string, number>();
  /** `git -C <dir> status --porcelain` answers; absent means exit 1. */
  readonly gitStatus = new Map<string, Partial<ExecResult>>();
  /** `git -C <dir> rev-list --count '@{u}..HEAD'` answers; absent means exit 1. */
  readonly gitUpstream = new Map<string, Partial<ExecResult>>();
  /** `tail -c … <path>` answers (the file's text). */
  readonly logs = new Map<string, string>();
  /** Commands that exit 1 instead of answering. */
  readonly broken = new Set<string>();
  /** `ls -A` that fails for one path (a permission error), while the walk still reaches it. */
  readonly lsFailure = new Set<string>();
  /** Commands that throw (a missing binary, a killed child). */
  readonly throwing = new Set<string>();

  readonly exec: GcExec = (argv: readonly string[], options: ExecOptions): ExecResult => {
    this.calls.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    const [command, ...args] = argv;
    if (command === undefined || this.throwing.has(command)) {
      throw new Error(`${String(command)} could not be started`);
    }
    if (this.broken.has(command)) return fail();
    switch (command) {
      case "test": {
        const [flag, path] = args;
        if (flag === "-d") return verdict(this.dirs.has(path ?? ""));
        if (flag === "-f") return verdict(this.files.has(path ?? ""));
        if (flag === "-L") return verdict(this.symlinks.has(path ?? ""));
        return fail();
      }
      case "stat": {
        const [format, path] = args.slice(1);
        const file = this.files.get(path ?? "");
        if (file === undefined) return fail();
        if (format === "%z") return good(String(file.size ?? 0));
        if (format === "%m") return good(String(file.mtime ?? 0));
        return fail();
      }
      case "du": {
        const path = args[args.length - 1] ?? "";
        const kb = this.blocks.get(path);
        return kb === undefined ? fail() : good(`${kb}\t${path}\n`);
      }
      case "find": {
        const target = args[0] ?? "";
        const entries = this.listings.get(target);
        if (entries === undefined) return fail();
        if (argv.includes("-print0")) return good(entries.map((e) => `${e}\u0000`).join(""));
        if (argv.includes("f")) return good(entries.map((e) => `${e}\n`).join(""));
        return good(entries.map((e) => `${e}\n`).join(""));
      }
      case "ls": {
        const path = args[args.length - 1] ?? "";
        if (this.lsFailure.has(path)) return fail();
        const entries = this.listings.get(path) ?? [];
        return good(entries.map((e) => `${e}\n`).join(""));
      }
      case "git": {
        const dir = args[1] ?? "";
        const upstream = argv.includes("rev-list");
        const answer = (upstream ? this.gitUpstream : this.gitStatus).get(dir);
        return answer === undefined ? fail() : { ...good(""), ...answer };
      }
      case "tail": {
        const path = args[args.length - 1] ?? "";
        const text = this.logs.get(path);
        return text === undefined ? fail() : good(text);
      }
      default:
        return fail();
    }
  };
}

function good(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

function fail(): ExecResult {
  return { code: 1, stdout: "", stderr: "", timedOut: false };
}

function verdict(passes: boolean): ExecResult {
  return passes ? good("") : fail();
}

/** The argv of every recorded call to one command. */
function callsTo(host: FakeHost, command: string): { argv: string[]; timeoutMs: number }[] {
  return host.calls.filter((call) => call.argv[0] === command);
}

// ---------------------------------------------------------------------------
// Shape: the fixture is the contract
// ---------------------------------------------------------------------------

describe("buildReport — shape", () => {
  it("emits exactly the reference top-level keys", () => {
    const report = buildReport(input());
    expect(Object.keys(report).sort()).toEqual(Object.keys(fixture).sort());
    expect(report.version).toBe(1);
    expect(report.generated).toBe("2027-01-15T08:00:00Z");
  });

  it("keeps every procs section key the fixture uses", () => {
    const report = buildReport(input());
    expect(Object.keys(report.procs).sort()).toEqual(Object.keys(fixture.procs).sort());
    for (const key of ["ident", "procs", "orphans", "tree", "totals", "overall", "warnMb", "killMb"]) {
      expect(report.procs).toHaveProperty(key);
    }
    expect(Object.keys(report.procs.tree).sort()).toEqual(Object.keys(fixture.procs.tree).sort());
    expect(Object.keys(report.procs.tree.tests).sort()).toEqual(
      Object.keys(fixture.procs.tree.tests).sort(),
    );
    expect(report.procs.warnMb).toBe(3072);
    expect(report.procs.killMb).toBe(4096);
  });

  it("reproduces the captured report from its own sections", () => {
    // The strongest shape assertion available: feed the capture's parts back in and require the
    // whole artifact, including the two derivations the caller did not supply (totals/overall and
    // `envBlind`), to come out identical.
    const report = buildReport({
      now: 1_791_000_000,
      generated: fixture.generated,
      home: fixture.home,
      procs: {
        ident: fixture.procs.ident,
        procs: fixture.procs.procs,
        orphans: fixture.procs.orphans,
        unreadableRows: fixture.procs.unreadableRows,
        ledgerNext: fixture.procs.ledgerNext,
        ledgerNote: fixture.procs.ledgerNote,
        ledgerDropped: fixture.procs.ledgerDropped,
        tree: fixture.procs.tree,
        warnMb: fixture.procs.warnMb,
        killMb: fixture.procs.killMb,
      },
      agents: fixture.agents,
      schedules: fixture.schedules,
      index: fixture.index,
      garbage: [],
      transcripts: fixture.transcripts,
      retention: fixture.retention,
      daemonMetrics: fixture.daemonMetrics,
    });
    expect(report).toEqual(fixture);
  });

  it("derives totals and overall from the rows, one decimal, classes in name order", () => {
    const report = buildReport(
      input({
        procs: {
          ident: { ok: true, why: "ok" },
          procs: [
            procRow({ pid: 10, class: "claude-child", footprint_mb: 100.04, rss_mb: 50.05, cmprs_mb: 1 }),
            procRow({ pid: 11, class: "claude-child", footprint_mb: 0.06, rss_mb: 0.05, cmprs_mb: null }),
            procRow({ pid: 12, class: "app-main", footprint_mb: 5, rss_mb: 5 }),
          ],
        },
      }),
    );
    expect(report.procs.totals).toEqual([
      { class: "app-main", n: 1, footprint_mb: 5, rss_mb: 5, cmprs_mb: 0 },
      { class: "claude-child", n: 2, footprint_mb: 100.1, rss_mb: 50.1, cmprs_mb: 1 },
    ]);
    expect(report.procs.overall).toEqual({ n: 3, footprint_mb: 105.1, rss_mb: 55.1 });
  });

  it("honours totals and overall when the caller already has them", () => {
    const report = buildReport(
      input({
        procs: {
          ident: { ok: true, why: "ok" },
          procs: [procRow({ pid: 10 })],
          totals: [{ class: "x", n: 9, footprint_mb: 1, rss_mb: 2, cmprs_mb: 3 }],
          overall: { n: 9, footprint_mb: 1, rss_mb: 2 },
        },
      }),
    );
    expect(report.procs.totals).toHaveLength(1);
    expect(report.procs.overall).toEqual({ n: 9, footprint_mb: 1, rss_mb: 2 });
  });

  it("never carries a process command line", () => {
    // `report --json` deletes them (`del(.procs.procs[].cmd, .procs.orphans[].cmd)`, :1351): a
    // command can hold an MCP bearer token, and the artifact is printed to a terminal.
    const report = buildReport(
      input({
        procs: {
          ident: { ok: true, why: "ok" },
          procs: [procRow({ pid: 10, cmd: "node --mcp-config {\"Authorization\":\"secret\"}" })],
        },
      }),
    );
    expect(report.procs.procs[0]).not.toHaveProperty("cmd");
    expect(JSON.stringify(report)).not.toContain("Authorization");
  });

  it("derives envBlind from the agent-family rows and keeps a supplied list", () => {
    const report = buildReport(
      input({
        procs: {
          ident: { ok: true, why: "ok" },
          procs: [
            procRow({ pid: 1, class: "claude-child", envRead: false }),
            procRow({ pid: 2, class: "paseo-wait", envRead: false, home: "unreadable" }),
            procRow({ pid: 3, class: "daemon", envRead: false }),
            procRow({ pid: 4, class: "utility", envRead: false }),
          ],
        },
      }),
    );
    expect(report.procs.envBlind).toEqual([1, 2]);
    const supplied = buildReport(
      input({
        procs: { ident: { ok: true, why: "ok" }, procs: [procRow({ pid: 1 })], envBlind: [7] },
      }),
    );
    expect(supplied.procs.envBlind).toEqual([7]);
  });

  it("fills the tree, the identity banners and the ledger crumbs fail-closed", () => {
    const report = buildReport(input({ procs: { ident: { ok: false, why: "no daemon" } } }));
    expect(report.procs.tree).toEqual({
      totalMb: 0,
      appMb: 0,
      orphanMb: 0,
      orphanN: 0,
      warnMb: 0,
      ramMb: 0,
      over: false,
      daemon: null,
      agents: [],
      tests: { agents: 0, warnAt: 0, over: false, rows: [] },
    });
    expect(report.procs.ident).toEqual({
      pidFile: false,
      supervisor: false,
      daemon: false,
      listener: false,
      supervisorPid: null,
      daemonPid: null,
      appPid: null,
      supHome: "unreadable",
      listen: null,
      homeBound: false,
      ok: false,
      why: "no daemon",
    });
    expect(report.procs.ledgerNext).toBeNull();
    expect(report.procs.ledgerNote).toBe("");
    expect(report.procs.ledgerDropped).toBe(0);
    expect(report.procs.unreadableRows).toBe(0);
  });

  it("keeps the tree it is handed, tests and all", () => {
    const tree = fixture.procs.tree;
    const report = buildReport(
      input({ procs: { ident: { ok: true, why: "ok" }, tree: { ...tree, over: true } } }),
    );
    expect(report.procs.tree).toEqual({ ...tree, over: true });
  });

  it("materialises every tree field a partial tree left out", () => {
    const report = buildReport(
      input({ procs: { ident: { ok: true, why: "ok" }, tree: { totalMb: 5 } } }),
    );
    expect(Object.keys(report.procs.tree).sort()).toEqual(Object.keys(fixture.procs.tree).sort());
    expect(report.procs.tree.daemon).toBeNull();
    expect(report.procs.tree.agents).toEqual([]);
    expect(report.procs.tree.tests).toEqual({ agents: 0, warnAt: 0, over: false, rows: [] });
    expect(report.procs.tree.totalMb).toBe(5);
  });

  it("derives the agent counts from the rows alone", () => {
    const row = (state: string, garbage = false) => ({
      path: `/h/agents/ws/${state}.json`,
      id: `${state}-id`,
      state,
      garbage,
      reason: `not garbage: ${state}`,
      action: null,
    });
    const report = buildReport(
      input({ agents: [row("live"), row("archived"), row("archived"), row("closed-unarchived"), row("unreadable")] }),
    );
    expect(report.agents).toEqual({
      total: 5,
      live: 1,
      archived: 2,
      closedUnarchived: 1,
      unreadable: 1,
      // `$trusted` (:484): at least one record parsed — an all-unreadable run is not trusted.
      trusted: true,
      rows: [
        expect.objectContaining({ category: "agent", state: "live" }),
        expect.objectContaining({ state: "archived" }),
        expect.objectContaining({ state: "archived" }),
        expect.objectContaining({ state: "closed-unarchived" }),
        expect.objectContaining({ state: "unreadable" }),
      ],
    });
    expect(buildReport(input({ agents: [row("unreadable")] })).agents.trusted).toBe(false);
    expect(buildReport(input({ agents: [] })).agents).toEqual({
      total: 0,
      live: 0,
      archived: 0,
      closedUnarchived: 0,
      unreadable: 0,
      trusted: false,
      rows: [],
    });
  });

  it("keeps supplied agent counts and rows", () => {
    const report = buildReport(input({ agents: fixture.agents }));
    expect(report.agents).toEqual(fixture.agents);
  });

  it("gives every schedule row its category and keeps its fields", () => {
    const report = buildReport(input({ schedules: [{ ...fixture.schedules[0], category: undefined }] }));
    expect(report.schedules[0].category).toBe("schedule");
    expect(report.schedules[0].id).toBe(fixture.schedules[0].id);
    expect(report.schedules[0]).toEqual({ ...fixture.schedules[0], category: "schedule" });
  });

  it("keeps only the eligible garbage candidates, with the fresh signature", () => {
    const report = buildReport(
      input({
        garbage: [
          candidate({ id: "eligible" }),
          candidate({ id: "refused", refusedBy: "identification: Paseo identification failed: x" }),
          candidate({ kind: "schedule", id: "sched", action: "paseo schedule delete sched" }),
        ],
        sigs: { "/Users/x/.paseo/agents/ws/a-old.json": "1:2:3" },
      }),
    );
    expect(report.garbage).toEqual([
      {
        category: "agent",
        id: "eligible",
        path: "/Users/x/.paseo/agents/ws/a-old.json",
        sig: "1:2:3",
        rule: "agent-archived",
        reason: candidate().reason,
        action: "paseo agent delete a-old",
      },
      {
        category: "schedule",
        id: "sched",
        path: "/Users/x/.paseo/agents/ws/a-old.json",
        sig: "1:2:3",
        rule: "agent-archived",
        reason: candidate().reason,
        action: "paseo schedule delete sched",
      },
    ]);
  });

  it("keeps the candidate's own signature when no fresh one was taken, and accepts a Map", () => {
    const rows = [
      candidate({ sig: "9:9:9" }),
      candidate({ id: "other", path: "/Users/x/.paseo/agents/ws/other.json", sig: "8:8:8" }),
    ];
    expect(buildReport(input({ garbage: rows })).garbage.map((row) => row.sig)).toEqual(["9:9:9", "8:8:8"]);
    const mapped = buildReport(
      input({
        garbage: rows,
        sigs: new Map([[rows[0]?.path ?? "", "1:1:1"]]),
      }),
    );
    expect(mapped.garbage.map((row) => row.sig)).toEqual(["1:1:1", "8:8:8"]);
  });

  it("joins transcripts to the agent index, last record winning", () => {
    const transcripts: TranscriptRow[] = [
      { bytes: 10, path: "/c/projects/p/one.jsonl", sessionId: "one" },
      { bytes: 20, path: "/c/projects/p/two.jsonl", sessionId: "two" },
      { bytes: 30, path: "/c/projects/p/three.jsonl", sessionId: "three" },
    ];
    const report = buildReport(
      input({
        transcripts,
        agentRecords: [
          agentRec({ id: "first", sessionId: "one", archivedAt: null }),
          agentRec({ id: "second", sessionId: "one", archivedAt: "2026-01-01T00:00:00Z" }),
          agentRec({ id: "two-agent", sessionId: "two", archivedAt: null }),
          agentRec({ id: "no-session", sessionId: null, archivedAt: null }),
        ],
      }),
    );
    expect(report.transcripts.map((row) => row.agent)).toEqual([
      { id: "second", state: "archived", provider: "claude" },
      { id: "two-agent", state: "live", provider: "claude" },
      null,
    ]);
  });

  it("keeps a transcript's own agent when no index is supplied", () => {
    const rows: TranscriptRow[] = [
      { bytes: 10, path: "/c/one.jsonl", sessionId: "one", agent: { id: "a", state: "live", provider: "claude" } },
    ];
    expect(buildReport(input({ transcripts: rows })).transcripts[0]?.agent?.id).toBe("a");
    expect(buildReport(input({ transcripts: [{ bytes: 1, path: "/c/x.jsonl", sessionId: "x" }] })).transcripts[0]?.agent).toBeNull();
  });

  it("defaults the clock-derived and empty sections", () => {
    const report = buildReport({
      now: 1_800_000_000,
      home: HOME,
      procs: { ident: { ok: true, why: "ok" } },
      agents: [],
      index: { ok: false },
    });
    expect(report.generated).toBe("2027-01-15T08:00:00Z");
    expect(report.index).toEqual({ ok: false, why: [] });
    expect(report.transcripts).toEqual([]);
    expect(report.daemonMetrics).toEqual([]);
    expect(report.retention).toEqual([]);
    expect(report.garbage).toEqual([]);
    expect(report.schedules).toEqual([]);
    expect(report.procs.totals).toEqual([]);
    expect(report.procs.overall).toEqual({ n: 0, footprint_mb: 0, rss_mb: 0 });
  });
});

function agentRec(overrides: {
  id: string;
  sessionId: string | null;
  archivedAt: string | null;
}) {
  return {
    id: overrides.id,
    provider: "claude",
    archivedAt: overrides.archivedAt,
    archivedEpoch: overrides.archivedAt === null ? null : 1,
    status: "closed",
    cwd: "/w",
    internal: false,
    labels: {},
    parent: null,
    sessionId: overrides.sessionId,
    strict: true,
  };
}

// ---------------------------------------------------------------------------
// collectTranscripts (slp-gc.bash:795-809)
// ---------------------------------------------------------------------------

describe("collectTranscripts", () => {
  const CLAUDE = "/Users/x/.claude";

  function host(): FakeHost {
    const machine = new FakeHost();
    machine.dirs.add(CLAUDE);
    machine.dirs.add(`${CLAUDE}/projects`);
    machine.listings.set(`${CLAUDE}/projects`, [
      `${CLAUDE}/projects/p-small/a.jsonl`,
      `${CLAUDE}/projects/p-big/b.jsonl`,
      `${CLAUDE}/projects/p-big/c.jsonl`,
    ]);
    machine.files.set(`${CLAUDE}/projects/p-small/a.jsonl`, { size: 600_000 });
    machine.files.set(`${CLAUDE}/projects/p-big/b.jsonl`, { size: 900_000 });
    machine.files.set(`${CLAUDE}/projects/p-big/c.jsonl`, { size: 900_000 });
    return machine;
  }

  it("lists the largest transcripts first, with the size floor of the reference", () => {
    const machine = host();
    const rows = collectTranscripts(machine.exec, { home: "/Users/x" });
    // `sort -rn`: equal sizes fall back to the whole line in reverse byte order, so "c" < "b".
    expect(rows).toEqual([
      { bytes: 900_000, path: `${CLAUDE}/projects/p-big/c.jsonl`, sessionId: "c" },
      { bytes: 900_000, path: `${CLAUDE}/projects/p-big/b.jsonl`, sessionId: "b" },
      { bytes: 600_000, path: `${CLAUDE}/projects/p-small/a.jsonl`, sessionId: "a" },
    ]);
    const find = callsTo(machine, "find")[0];
    expect(find?.argv).toEqual([
      "find",
      `${CLAUDE}/projects`,
      "-mindepth",
      "2",
      "-maxdepth",
      "2",
      "-type",
      "f",
      "-name",
      "*.jsonl",
      "-size",
      "+512k",
      "-print0",
    ]);
    expect(find?.timeoutMs).toBe(30_000);
    // Sizes come from `fsize` (`stat` without following symlinks), one call per candidate file.
    expect(callsTo(machine, "stat").map((call) => call.argv)).toEqual([
      ["stat", "-f", "%z", `${CLAUDE}/projects/p-small/a.jsonl`],
      ["stat", "-f", "%z", `${CLAUDE}/projects/p-big/b.jsonl`],
      ["stat", "-f", "%z", `${CLAUDE}/projects/p-big/c.jsonl`],
    ]);
    expect(callsTo(machine, "stat")[0]?.timeoutMs).toBe(5_000);
  });

  it("scans CLAUDE_CONFIG_DIR, the home and the slp-room variants, and de-duplicates", () => {
    const machine = host();
    machine.dirs.add("/cfg");
    machine.dirs.add("/cfg/projects");
    machine.listings.set("/cfg/projects", [`${CLAUDE}/projects/p-big/b.jsonl`]);
    machine.dirs.add("/Users/x/.config/slp-room");
    machine.listings.set("/Users/x/.config/slp-room", ["/Users/x/.config/slp-room/claude-a"]);
    machine.dirs.add("/Users/x/.config/slp-room/claude-a");
    machine.dirs.add("/Users/x/.config/slp-room/claude-a/projects");
    machine.listings.set("/Users/x/.config/slp-room/claude-a/projects", [
      "/Users/x/.config/slp-room/claude-a/projects/p/d.jsonl",
    ]);
    machine.files.set("/Users/x/.config/slp-room/claude-a/projects/p/d.jsonl", { size: 1_000_000 });

    const rows = collectTranscripts(machine.exec, {
      home: "/Users/x",
      claudeConfigDir: "/cfg",
    });
    expect(rows.filter((row) => row.sessionId === "c")).toHaveLength(1);
    expect(rows.map((row) => row.sessionId)).toEqual(["d", "c", "b", "a"]);
    // The same file seen through two directories is one row (`awk '!seen[$0]++'`).
    expect(rows.filter((row) => row.sessionId === "b")).toHaveLength(1);
  });

  it("honours the limit and the minimum size", () => {
    const machine = host();
    const rows = collectTranscripts(machine.exec, { home: "/Users/x", limit: 2, minKb: 128 });
    expect(rows).toHaveLength(2);
    expect(callsTo(machine, "find")[0]?.argv).toContain("+128k");
  });

  it("skips a direction that is not there, and a file whose size cannot be read", () => {
    const machine = new FakeHost();
    expect(collectTranscripts(machine.exec, { home: "/Users/x" })).toEqual([]);

    const missingSize = host();
    missingSize.files.delete(`${CLAUDE}/projects/p-big/b.jsonl`);
    expect(collectTranscripts(missingSize.exec, { home: "/Users/x" }).map((row) => row.sessionId)).toEqual([
      "c",
      "a",
    ]);
  });

  it("degrades to an empty list when the scan fails or the exec throws", () => {
    const broken = host();
    broken.broken.add("find");
    expect(collectTranscripts(broken.exec, { home: "/Users/x" })).toEqual([]);

    const throwing = host();
    throwing.throwing.add("find");
    expect(collectTranscripts(throwing.exec, { home: "/Users/x" })).toEqual([]);

    const timedOut = host();
    const exec: GcExec = (argv, options) =>
      argv[0] === "find"
        ? { code: null, stdout: "", stderr: "", timedOut: true }
        : timedOut.exec(argv, options);
    expect(collectTranscripts(exec, { home: "/Users/x" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectDaemonMetrics (slp-gc.bash:811-817)
// ---------------------------------------------------------------------------

describe("collectDaemonMetrics", () => {
  const LOG = `${HOME}/daemon.log`;

  function metricsLine(time: number, rss: number): string {
    return JSON.stringify({
      msg: "ws_runtime_metrics",
      time,
      pid: 42,
      memory: { rss, heapUsed: rss * 2 },
      agents: { timelineStats: { totalItems: 7 } },
    });
  }

  function host(lines: string[]): FakeHost {
    const machine = new FakeHost();
    machine.files.set(LOG, { size: 1000 });
    machine.logs.set(LOG, lines.join("\n"));
    return machine;
  }

  it("keeps the last three ws_runtime_metrics samples", () => {
    const machine = host([
      metricsLine(1, 100),
      '{"msg":"other","time":2}',
      "not json at all",
      metricsLine(3, 300),
      metricsLine(4, 400),
      metricsLine(5, 500),
    ]);
    const rows = collectDaemonMetrics(machine.exec, { home: HOME });
    expect(rows).toEqual([
      { time: 3, pid: 42, rss: 300, heapUsed: 600, timelineStats: { totalItems: 7 } },
      { time: 4, pid: 42, rss: 400, heapUsed: 800, timelineStats: { totalItems: 7 } },
      { time: 5, pid: 42, rss: 500, heapUsed: 1000, timelineStats: { totalItems: 7 } },
    ]);
    expect(callsTo(machine, "tail")[0]?.argv).toEqual([
      "tail",
      "-c",
      "3000000",
      LOG,
    ]);
    expect(callsTo(machine, "tail")[0]?.timeoutMs).toBe(15_000);
  });

  it("answers empty when the log is absent, a symlink, or unreadable", () => {
    const absent = new FakeHost();
    expect(collectDaemonMetrics(absent.exec, { home: HOME })).toEqual([]);

    const linked = host([metricsLine(1, 1)]);
    linked.symlinks.add(LOG);
    expect(collectDaemonMetrics(linked.exec, { home: HOME })).toEqual([]);

    const unreadable = host([metricsLine(1, 1)]);
    unreadable.broken.add("tail");
    expect(collectDaemonMetrics(unreadable.exec, { home: HOME })).toEqual([]);

    const throwing = host([metricsLine(1, 1)]);
    throwing.throwing.add("tail");
    expect(collectDaemonMetrics(throwing.exec, { home: HOME })).toEqual([]);
  });

  it("survives a record missing its memory and agents objects", () => {
    const machine = host(['{"msg":"ws_runtime_metrics","time":9,"pid":1}', '{"msg":"ws_runtime_metrics"}']);
    expect(collectDaemonMetrics(machine.exec, { home: HOME })).toEqual([
      { time: 9, pid: 1, rss: null, heapUsed: null, timelineStats: null },
      { time: null, pid: null, rss: null, heapUsed: null, timelineStats: null },
    ]);
  });

  it("drops a JSON line that is not a metrics record, even in the last three", () => {
    const machine = host([
      metricsLine(1, 100),
      metricsLine(2, 200),
      metricsLine(3, 300),
      '{"msg":"daemon_stopping","time":4,"pid":42}',
    ]);
    expect(collectDaemonMetrics(machine.exec, { home: HOME }).map((row) => row.time)).toEqual([
      1,
      2,
      3,
    ]);
  });
});

// ---------------------------------------------------------------------------
// gitState (slp-gc.bash:828-834)
// ---------------------------------------------------------------------------

describe("gitState", () => {
  function host(): FakeHost {
    const machine = new FakeHost();
    machine.dirs.add("/w/dirty");
    machine.gitStatus.set("/w/dirty", good(" M a.ts\n?? b.ts\n"));
    machine.gitUpstream.set("/w/dirty", good("2\n"));
    machine.dirs.add("/w/clean");
    machine.gitStatus.set("/w/clean", good(""));
    machine.gitUpstream.set("/w/clean", good("0"));
    machine.dirs.add("/w/no-upstream");
    machine.gitStatus.set("/w/no-upstream", good(" M a.ts\n"));
    machine.dirs.add("/w/unreadable");
    return machine;
  }

  it("counts dirty files and the unpushed commits", () => {
    const machine = host();
    expect(gitState(machine.exec, "/w/dirty")).toBe("dirty=2 unpushed=2");
    expect(gitState(machine.exec, "/w/clean")).toBe("dirty=0 unpushed=0");
  });

  it("reports an unknown state instead of a clean one", () => {
    const machine = host();
    expect(gitState(machine.exec, "/w/unreadable")).toBe("unknown (git status failed)");
    expect(gitState(machine.exec, "/w/no-upstream")).toBe("dirty=1 unpushed=no-upstream");
    expect(gitState(machine.exec, "/w/absent")).toBe("missing");
  });

  it("refuses a symlink and bounds both calls with the reference's timeout", () => {
    const machine = host();
    machine.symlinks.add("/w/clean");
    expect(gitState(machine.exec, "/w/clean")).toBe("missing");
    machine.symlinks.clear();
    gitState(machine.exec, "/w/dirty");
    const git = callsTo(machine, "git");
    expect(git.map((call) => call.timeoutMs)).toEqual([15_000, 15_000]);
    expect(git[1]?.argv).toEqual(["git", "-C", "/w/dirty", "rev-list", "--count", "@{u}..HEAD"]);
  });
});

// ---------------------------------------------------------------------------
// collectRetention (slp-gc.bash:835-872)
// ---------------------------------------------------------------------------

describe("collectRetention", () => {
  const NOW = 1_800_000_000;

  function host(): FakeHost {
    const machine = new FakeHost();
    const entries = [
      `${HOME}/agents`,
      `${HOME}/model-cache`,
      `${HOME}/link`,
      `${HOME}/daemon.log`,
      `${HOME}/daemon.log.1`,
      `${HOME}/20261027-0955-01-daemon.log`,
      `${HOME}/config.json.bak-20260101120000`,
      `${HOME}/agent-requests`,
      `${HOME}/uploads`,
      `${HOME}/worktrees`,
    ];
    machine.listings.set(HOME, entries);
    for (const entry of entries) machine.dirs.add(entry);
    machine.symlinks.add(`${HOME}/link`);
    machine.dirs.delete(`${HOME}/daemon.log`);
    machine.dirs.delete(`${HOME}/daemon.log.1`);
    machine.dirs.delete(`${HOME}/20261027-0955-01-daemon.log`);
    machine.dirs.delete(`${HOME}/config.json.bak-20260101120000`);
    machine.files.set(`${HOME}/daemon.log`, { size: 5_783_552, mtime: NOW - 100 });
    machine.files.set(`${HOME}/daemon.log.1`, { size: 10_240, mtime: NOW - 172_800 });
    machine.files.set(`${HOME}/20261027-0955-01-daemon.log`, { size: 10_486_784, mtime: NOW - 3 * 86_400 });
    machine.files.set(`${HOME}/config.json.bak-20260101120000`, { size: 2_048, mtime: NOW + 500 });
    machine.blocks.set(`${HOME}/agents`, 2_662);
    machine.blocks.set(`${HOME}/daemon.log`, 5_648);
    machine.blocks.set(`${HOME}/daemon.log.1`, 10);
    machine.blocks.set(`${HOME}/20261027-0955-01-daemon.log`, 10_241);
    machine.blocks.set(`${HOME}/model-cache`, 1_007_771);
    machine.blocks.set(`${HOME}/agent-requests`, 5_516);
    machine.blocks.set(`${HOME}/uploads`, 10);
    machine.listings.set(`${HOME}/agents`, [`${HOME}/agents/a.json`, `${HOME}/agents/b.json`]);
    machine.listings.set(`${HOME}/agent-requests`, [`${HOME}/agent-requests/r1`]);
    machine.listings.set(`${HOME}/uploads`, []);
    return machine;
  }

  it("reports every category the reference reports, with its notes", () => {
    const machine = host();
    const rows = collectRetention(machine.exec, { home: HOME, now: NOW });

    const homeEntries = rows.filter((row) => row.cat === "home-entry");
    expect(homeEntries.map((row) => row.path)).toEqual(machine.listings.get(HOME));
    expect(homeEntries.find((row) => row.path === `${HOME}/agents`), "du/find per directory").toEqual({
      cat: "home-entry",
      path: `${HOME}/agents`,
      kb: 2_662,
      count: 2,
      note: "report-only: no Paseo CLI path",
    });
    expect(homeEntries.find((row) => row.path === `${HOME}/link`), "a symlink is not followed")
      .toEqual({
        cat: "home-entry",
        path: `${HOME}/link`,
        kb: 0,
        count: 0,
        note: "symlink (not followed)",
      });
    expect(homeEntries.find((row) => row.path === `${HOME}/daemon.log`)?.kb).toBe(5_648);
    expect(homeEntries.find((row) => row.path === `${HOME}/daemon.log`)?.count).toBe(0);

    expect(rows.filter((row) => row.cat === "log")).toEqual([
      {
        cat: "log",
        path: `${HOME}/daemon.log`,
        kb: 5_648,
        count: 1,
        note: "age 0 d; report-only (daemon.log is held open by the Supervisor)",
      },
      {
        cat: "log",
        path: `${HOME}/daemon.log.1`,
        kb: 10,
        count: 1,
        note: "age 2 d; report-only (daemon.log is held open by the Supervisor)",
      },
      {
        cat: "log",
        path: `${HOME}/20261027-0955-01-daemon.log`,
        kb: 10_241,
        count: 1,
        note: "age 3 d; report-only (daemon.log is held open by the Supervisor)",
      },
    ]);
    // A future mtime reads as age 0, as `age_days` (:827) clamps it.
    expect(rows.find((row) => row.cat === "config-backup")).toEqual({
      cat: "config-backup",
      path: `${HOME}/config.json.bak-20260101120000`,
      kb: 2,
      count: 1,
      note: "age 0 d; may hold a token: never read; report-only",
    });
    expect(rows.filter((row) => row.cat === "agent-requests")).toEqual([
      {
        cat: "agent-requests",
        path: `${HOME}/agent-requests`,
        kb: 5_516,
        count: 1,
        note: "daemon-owned; report-only (no CLI path)",
      },
    ]);
    expect(rows.filter((row) => row.cat === "uploads")).toEqual([
      { cat: "uploads", path: `${HOME}/uploads`, kb: 10, count: 0, note: "daemon-owned; report-only (no CLI path)" },
    ]);
  });

  it("scans the worktree tree, naming the state of each worktree", () => {
    const machine = host();
    machine.listings.set(`${HOME}/worktrees`, [`${HOME}/worktrees/hash1`, `${HOME}/worktrees/hash2`]);
    machine.dirs.add(`${HOME}/worktrees/hash1`);
    machine.dirs.add(`${HOME}/worktrees/hash2`);
    machine.listings.set(`${HOME}/worktrees/hash1`, []); // empty project-hash dir
    machine.listings.set(`${HOME}/worktrees/hash2`, [`${HOME}/worktrees/hash2/room-a`]);
    machine.dirs.add(`${HOME}/worktrees/hash2/room-a`);
    machine.blocks.set(`${HOME}/worktrees/hash2/room-a`, 128);
    machine.gitStatus.set(`${HOME}/worktrees/hash2/room-a`, good(""));
    machine.gitUpstream.set(`${HOME}/worktrees/hash2/room-a`, good("0"));

    const rows = collectRetention(machine.exec, { home: HOME, now: NOW }).filter(
      (row) => row.cat === "paseo-worktree",
    );
    expect(rows).toEqual([
      {
        cat: "paseo-worktree",
        path: `${HOME}/worktrees/hash1`,
        kb: 0,
        count: 0,
        note: "empty project-hash dir; report-only",
      },
      {
        cat: "paseo-worktree",
        path: `${HOME}/worktrees/hash2/room-a`,
        kb: 128,
        count: 1,
        note: "dirty=0 unpushed=0; report-only (paseo worktree archive is a follow-up)",
      },
    ]);
  });

  it("treats an unreadable project dir as empty, as the reference does", () => {
    const machine = host();
    machine.listings.set(`${HOME}/worktrees`, [`${HOME}/worktrees/hash1`]);
    machine.dirs.add(`${HOME}/worktrees/hash1`);
    machine.listings.set(`${HOME}/worktrees/hash1`, [`${HOME}/worktrees/hash1/room-a`]);
    machine.lsFailure.add(`${HOME}/worktrees/hash1`);
    // `[ -z "$(ls -A …)" ]` is true when `ls` failed, so the dir reads as empty — never as a
    // worktree whose state was checked.
    expect(
      collectRetention(machine.exec, { home: HOME, now: NOW }).filter(
        (row) => row.cat === "paseo-worktree",
      ),
    ).toEqual([
      {
        cat: "paseo-worktree",
        path: `${HOME}/worktrees/hash1`,
        kb: 0,
        count: 0,
        note: "empty project-hash dir; report-only",
      },
    ]);
  });

  it("names the live agent cwds outside the Paseo tree, and only those", () => {
    const machine = host();
    machine.dirs.add("/w/room");
    machine.gitStatus.set("/w/room", good(" M x\n"));
    machine.gitUpstream.set("/w/room", good("1\n"));
    machine.dirs.add("/w/unreadable");
    // A live agent inside the Paseo worktree tree is not an `other-worktree`: the Paseo scan
    // already owns it (`case "$d" in "$PHOME"/worktrees/*) continue`).
    machine.dirs.add(`${HOME}/worktrees/hash2/room-a`);
    const rows = collectRetention(machine.exec, {
      home: HOME,
      now: NOW,
      liveAgentCwds: [
        "/w/room",
        `${HOME}/worktrees/hash2/room-a`,
        "/w/unreadable",
        "/w/absent",
        "/w/room",
      ],
    }).filter((row) => row.cat === "other-worktree");
    expect(rows.map((row) => row.path)).toEqual(["/w/room", "/w/unreadable"]);
    expect(rows[0]).toEqual({
      cat: "other-worktree",
      path: "/w/room",
      kb: 0,
      count: 1,
      note: "live agent cwd: dirty=1 unpushed=1; never garbage",
    });
    expect(rows[1]?.note).toBe("live agent cwd: unknown (git status failed); never garbage");
  });

  it("caps the live-agent cwds at thirty, as the reference does", () => {
    const machine = host();
    const cwds: string[] = [];
    for (let index = 0; index < 35; index++) {
      const path = `/w/agent-${String(index).padStart(2, "0")}`;
      cwds.push(path);
      machine.dirs.add(path);
      machine.gitStatus.set(path, good(""));
      machine.gitUpstream.set(path, good("0"));
    }
    const rows = collectRetention(machine.exec, { home: HOME, now: NOW, liveAgentCwds: cwds }).filter(
      (row) => row.cat === "other-worktree",
    );
    expect(rows).toHaveLength(30);
    expect(rows[0]?.path).toBe("/w/agent-00");
  });

  it("uses the reference's budgets: 60 s for the home scan and du, 30 s for find", () => {
    const machine = host();
    collectRetention(machine.exec, { home: HOME, now: NOW });
    const homeScan = callsTo(machine, "find").find((call) => call.argv[1] === HOME);
    // Literal milliseconds, not the module's constants: the reference's `run_to 60` / `run_to 30`
    // / `run_to 15` are the contract, so lowering a constant has to fail here.
    expect(homeScan?.timeoutMs).toBe(60_000);
    expect(callsTo(machine, "du").every((call) => call.timeoutMs === 60_000)).toBe(true);
    expect(
      callsTo(machine, "find")
        .filter((call) => call.argv[1] !== HOME)
        .every((call) => call.timeoutMs === 30_000),
    ).toBe(true);
    expect(callsTo(machine, "stat").every((call) => call.timeoutMs === 5_000)).toBe(true);
  });

  it("degrades a failed size to zero rather than dropping the row", () => {
    const machine = host();
    machine.broken.add("du");
    machine.broken.add("find");
    const rows = collectRetention(machine.exec, { home: HOME, now: NOW });
    // The home listing is gone (its `find` failed), so the log/backup rows are gone with it; the
    // directory probes still answer, with zeroed sizes.
    expect(rows.every((row) => row.cat !== "home-entry")).toBe(true);
    expect(rows.find((row) => row.cat === "agent-requests")).toEqual({
      cat: "agent-requests",
      path: `${HOME}/agent-requests`,
      kb: 0,
      count: 0,
      note: "daemon-owned; report-only (no CLI path)",
    });
    expect(rows.some((row) => row.cat === "log")).toBe(false);
  });

  it("never throws, whatever the exec does", () => {
    const throwing = new FakeHost();
    throwing.throwing.add("test");
    expect(() => collectRetention(throwing.exec, { home: HOME, now: NOW })).not.toThrow();
    expect(collectRetention(throwing.exec, { home: HOME, now: NOW })).toEqual([]);

    const everything = host();
    for (const command of ["test", "stat", "du", "find", "ls", "git", "tail"]) {
      everything.broken.add(command);
    }
    expect(() => collectRetention(everything.exec, { home: HOME, now: NOW })).not.toThrow();
    expect(collectRetention(everything.exec, { home: HOME, now: NOW })).toEqual([]);
  });

  it("accepts an exec that answers nothing at all", () => {
    const nothing: GcExec = () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    expect(collectRetention(nothing, { home: HOME, now: NOW })).toEqual([]);
    expect(collectTranscripts(nothing, { home: "/Users/x" })).toEqual([]);
    expect(collectDaemonMetrics(nothing, { home: HOME })).toEqual([]);
    expect(gitState(nothing, "/w")).toBe("missing");
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GcSettings } from "../../shared/gc";
import type { ExecResult, GcExec } from "./report";
import { DEFAULT_GC_SETTINGS } from "./settings";
import {
  AGENT_MIN_DAYS,
  buildStatus,
  collectProcsPhase,
  NO_SELF_PID,
  runTick,
  type TickDeps,
} from "./tick";

/**
 * A tick that runs against an empty machine: no `ps` rows, no `top` sample, no
 * pid file, no records. Every constraint the task names is honoured — no daemon,
 * no agent, no live process table, no reference run — and the whole composition
 * (index, process phase, record, report, gates) still executes.
 */
const emptyExec: GcExec = (): ExecResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
});

/** An exec that fails everywhere: a machine with no `ps`, no `top`, no `lsof`. */
const brokenExec: GcExec = (): ExecResult => {
  throw new Error("spawn ENOENT");
};

const NOW = 1_790_000_000; // 2026-09-21T…Z, a fixed clock so nothing depends on today

function settings(over: Partial<GcSettings> = {}): GcSettings {
  return { ...DEFAULT_GC_SETTINGS, killComms: [...DEFAULT_GC_SETTINGS.killComms], ...over };
}

let workspace: string;

interface Harness {
  deps: TickDeps;
  /** `<stateDir>/memory.jsonl`, parsed line by line. */
  samples: () => Promise<Array<Record<string, unknown>>>;
  deleteAgent: ReturnType<typeof vi.fn>;
  deleteSchedule: ReturnType<typeof vi.fn>;
  signal: ReturnType<typeof vi.fn>;
}

async function harness(
  over: Partial<TickDeps> = {},
  settingsOver: Partial<GcSettings> = {},
): Promise<Harness> {
  const deleteAgent = vi.fn(async () => undefined);
  const deleteSchedule = vi.fn(async () => undefined);
  const signal = vi.fn(() => true);
  const deps: TickDeps = {
    stateDir: join(workspace, "gc"),
    paseoHome: join(workspace, "paseo"),
    legacyStateDir: join(workspace, "legacy"),
    home: workspace,
    env: {},
    now: () => NOW,
    exec: emptyExec,
    notify: () => undefined,
    log: () => undefined,
    readSettings: async () => settings(settingsOver),
    deleteAgent,
    deleteSchedule,
    signal,
    ...over,
  };

  return {
    deps,
    deleteAgent,
    deleteSchedule,
    signal,
    samples: async () => {
      const text = await readFile(join(deps.stateDir, "memory.jsonl"), "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agent-room-gc-tick-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runTick", () => {
  it("always records a sample, in the reference's shape", async () => {
    const test = await harness();

    const result = await runTick(test.deps);

    expect(result.recorded).toBe(true);
    const samples = await test.samples();
    expect(samples).toHaveLength(1);
    // `do_record`'s eight keys, in the reference's order (`:1206-1211`).
    expect(Object.keys(samples[0] ?? {})).toEqual([
      "ts",
      "epoch",
      "procs",
      "orphans",
      "tree",
      "totals",
      "overall",
      "system",
    ]);
    expect(samples[0]?.epoch).toBe(NOW);
  });

  it("records on every tick, not only on the first", async () => {
    const test = await harness();

    await runTick(test.deps);
    await runTick({ ...test.deps, now: () => NOW + 60 });

    expect(await test.samples()).toHaveLength(2);
  });

  it("acts on nothing when every toggle is off, and calls no effect dependency", async () => {
    const test = await harness(
      {},
      { apply: false, killStale: false, killMemory: false },
    );

    const result = await runTick(test.deps);

    expect(result.acted).toEqual([]);
    expect(test.deleteAgent).not.toHaveBeenCalled();
    expect(test.deleteSchedule).not.toHaveBeenCalled();
    expect(test.signal).not.toHaveBeenCalled();
    // The tick still did its recording half.
    expect(result.recorded).toBe(true);
    expect(await test.samples()).toHaveLength(1);
  });

  it("carries the identification verdict into the record decisions", async () => {
    // A garbage-shaped agent record: archived 30 days ago, closed, not internal.
    const agentId = "11111111-2222-3333-4444-555555555555";
    const dir = join(workspace, "paseo", "agents", "workspace-a");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${agentId}.json`),
      JSON.stringify({
        id: agentId,
        provider: "claude",
        internal: false,
        archivedAt: new Date((NOW - 30 * 86400) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        lastStatus: "closed",
        updatedAt: "2026-08-01T00:00:00Z",
      }),
      "utf8",
    );

    const test = await harness({}, { apply: true });
    const result = await runTick(test.deps);

    // With no `ps` rows there is no identification, so the rule must refuse the
    // record by naming identification — the arm the tick is the only supplier of.
    const candidate = result.candidates.find((row) => row.id === agentId);
    expect(candidate).toBeDefined();
    expect(candidate?.refusedBy).toContain("identification");
    expect(AGENT_MIN_DAYS).toBe(14);

    // …and a refused candidate is never acted on, even with `apply` on.
    expect(test.deleteAgent).not.toHaveBeenCalled();
    expect(result.acted.some((row) => row.acted)).toBe(false);
    // The gate itself is reported, once, as a refusal row.
    expect(result.acted[0]).toMatchObject({ kind: "refuse", acted: false });
  });

  it("reportOnly turns every acting toggle off for that tick", async () => {
    const test = await harness({}, { apply: true, killStale: true, killMemory: true });

    const result = await runTick(test.deps, { reportOnly: true });

    expect(result.acted).toEqual([]);
    expect(result.settings).toMatchObject({ apply: false, killStale: false, killMemory: false });
    expect(test.deleteAgent).not.toHaveBeenCalled();
    expect(test.signal).not.toHaveBeenCalled();
  });

  it("survives a rejected recordSample: the sample is lost, the tick is not", async () => {
    const test = await harness({
      seams: {
        record: async () => {
          throw new Error("state dir is read-only");
        },
      },
    });

    const result = await runTick(test.deps);

    expect(result.recorded).toBe(false);
    expect(result.report.version).toBe(1);
    // The rest of the tick still happened: a report was rendered and stamped.
    const stamp = await readFile(join(test.deps.stateDir, ".last-report"), "utf8");
    expect(stamp.trim()).toBe(String(NOW));
  });

  it("survives an exec that throws everywhere", async () => {
    const test = await harness({ exec: brokenExec });

    const result = await runTick(test.deps);

    expect(result.recorded).toBe(true);
    expect(result.report.procs.ident.ok).toBe(false);
    expect(result.report.procs.procs).toEqual([]);
    expect(result.acted).toEqual([]);
  });

  it("survives a settings reader that throws, using the reference defaults", async () => {
    const test = await harness({
      readSettings: async () => {
        throw new Error("the daemon's settings read blew up");
      },
    });

    const result = await runTick(test.deps);

    expect(result.settings).toMatchObject({ apply: false, killStale: false, killMemory: false });
    expect(result.recorded).toBe(true);
  });

  it("migrates once per process, before the first record", async () => {
    const legacy = join(workspace, "legacy");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "memory.jsonl"), "the reference's line\n", "utf8");

    const deps = { ...(await harness()).deps };
    expect(deps.migrated).toBeUndefined();

    const first = await runTick(deps);
    expect(first.migrated?.copied).toContain("memory.jsonl");
    expect(deps.migrated).toBe(true);
    // The copied history is now the live file, and the tick appended to it.
    expect(await readFile(join(deps.stateDir, "memory.jsonl"), "utf8")).toContain(
      "the reference's line",
    );

    const second = await runTick(deps);
    expect(second.migrated).toBeNull();
  });

  it("reports the settings it acted on and when the next report is due", async () => {
    const test = await harness({}, { reportIntervalMin: 60 });

    const result = await runTick(test.deps);

    expect(result.settings.reportIntervalMin).toBe(60);
    expect(result.nextReportAt).toBe(
      new Date((NOW + 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    );
  });

  it("retries a migration that failed, because it never claims to have run", async () => {
    // M-1: the flag means "the copy succeeded". A migration that rejects leaves it
    // unset, so the next tick reaches the copy again; setting it on failure would
    // silently drop the reference's history forever.
    const migrate = vi.fn(async () => {
      throw new Error("the state dir is read-only");
    });
    const test = await harness({ seams: { migrate } });

    const first = await runTick(test.deps);
    expect(first.migrated).toBeNull();
    expect(test.deps.migrated).not.toBe(true);

    const second = await runTick(test.deps);
    expect(second.migrated).toBeNull();
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(test.deps.migrated).not.toBe(true);
    // …and the rest of the tick is unaffected.
    expect(second.recorded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The acting path, against a non-empty world
// ---------------------------------------------------------------------------
//
// Every "toggles off" test above runs against an empty machine, so deleting the
// `if (settings.apply)` guard would keep them green: with nothing eligible there
// is nothing to delete either way. These tests build a world where a rule really
// does produce an eligible, signed candidate, so the guard, the gate, `reclaim`
// and the delete are all observable.
//
// The machine is the reference's own shape: app main 100, Supervisor 150 (the
// pid `paseo.pid` names), daemon 200, one live agent child 400, and 500 — a
// classless `node`, i.e. an `agent-descendant` — whose pid **is this test
// process's**, so a self-tree rooted at `process.pid` would claim it. Every row's
// footprint is above `memKillMb`, so each rule gets to speak.

/** The clock the acting tests use: the real one, because `reclaim`'s recheck is. */
function actingNow(): number {
  return Math.floor(Date.now() / 1000);
}

const GARBAGE_ID = "11111111-2222-3333-4444-555555555555";
const LIVE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const APP_CMD = "/Applications/Paseo.app/Contents/MacOS/Paseo";
const SUP_CMD = "Paseo Supervisor";
const DAEMON_CMD = "Paseo Daemon";
const CLAUDE_CMD =
  'claude --output-format stream-json --input-format stream-json --permission-prompt-tool ""';
const DESCENDANT_CMD = "node /repo/build.mjs";
const LSTART = "Thu Oct 29 11:43:21 2026";

/** One `ps -axww -o pid=,ppid=,pgid=,etime=,rss=,lstart=,command=` line. */
function psLine(input: { pid: number; ppid: number; rssKb: number; cmd: string }): string {
  return `${input.pid} ${input.ppid} ${input.pid} 600 ${input.rssKb} ${LSTART} ${input.cmd}`;
}

/**
 * The `exec` seam answering that machine: the `ps` table, the two env reads
 * identification needs, and the `lsof` listener. Every other command answers an
 * empty success, so `top`/`vm_stat`/`sysctl` contribute nothing.
 */
function machineExec(paseoHome: string): GcExec {
  const table = [
    psLine({ pid: 100, ppid: 1, rssKb: 2_097_152, cmd: APP_CMD }),
    psLine({ pid: 150, ppid: 100, rssKb: 2_097_152, cmd: SUP_CMD }),
    psLine({ pid: 200, ppid: 150, rssKb: 3_145_728, cmd: DAEMON_CMD }),
    psLine({ pid: 400, ppid: 200, rssKb: 2_097_152, cmd: CLAUDE_CMD }),
    psLine({ pid: process.pid, ppid: 400, rssKb: 4_194_304, cmd: DESCENDANT_CMD }),
  ].join("\n");

  const env = new Map<number, string>([
    [150, `${SUP_CMD} PATH=/usr/bin HOME=/h PASEO_HOME=${paseoHome}`],
    [400, `${CLAUDE_CMD} PATH=/usr/bin HOME=/h PASEO_AGENT_ID=${LIVE_ID} PASEO_HOME=${paseoHome}`],
  ]);

  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

  return (argv) => {
    const [command, ...args] = argv;
    if (command === "ps") {
      if (args.includes("-axww")) return ok(table);
      const at = args.indexOf("-p");
      const pid = at < 0 ? Number.NaN : Number(args[at + 1]);
      if (args.includes("-eww")) return ok(env.get(pid) ?? "");
      return ok("");
    }
    if (command === "lsof") {
      // `collect_listen` asks for the pid file's port; `exe_of` asks for `-d txt`.
      if (args.some((arg) => arg.startsWith("-iTCP:"))) return ok("p200\n");
      return ok("n/repo/node\n");
    }
    return ok("");
  };
}

interface World extends Harness {
  /** `<paseoHome>/agents/workspace-a/<id>.json`, the record the rule judges. */
  recordPath: string;
}

/**
 * The non-empty world. The record is archived 15 days ago and carries every key
 * the rule's `strict` gate needs; the pid file names the Supervisor and the
 * listener; the two env reads prove the home binding.
 */
async function world(
  settingsOver: Partial<GcSettings> = {},
  over: Partial<TickDeps> = {},
): Promise<World> {
  const paseoHome = join(workspace, "paseo");
  const agentDir = join(paseoHome, "agents", "workspace-a");
  await mkdir(agentDir, { recursive: true });
  const recordPath = join(agentDir, `${GARBAGE_ID}.json`);
  await writeFile(
    recordPath,
    JSON.stringify({
      id: GARBAGE_ID,
      provider: "claude",
      internal: false,
      archivedAt: new Date((actingNow() - 15 * 86400) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      lastStatus: "closed",
      updatedAt: "2026-10-01T00:00:00Z",
    }),
    "utf8",
  );
  await writeFile(
    join(paseoHome, "paseo.pid"),
    JSON.stringify({ pid: 150, listen: "127.0.0.1:6767" }),
    "utf8",
  );

  const test = await harness(
    { paseoHome, exec: machineExec(paseoHome), now: actingNow, ...over },
    settingsOver,
  );
  return { ...test, recordPath };
}

describe("runTick — the GC's own pid (selfPid)", () => {
  it("passes a sentinel that matches no row, so the daemon's tree is not the GC's tree", async () => {
    const test = await world({ apply: false, memWarnMb: 512, memKillMb: 1024 });

    const result = await runTick(test.deps);

    expect(NO_SELF_PID).toBe(0);
    expect(result.report.procs.ident.ok).toBe(true);

    const rows = new Map(result.report.procs.procs.map((row) => [row.pid, row]));
    const descendant = rows.get(process.pid);

    // The class the memory rule exists for, under the daemon, above the threshold.
    expect(descendant?.class).toBe("agent-descendant");
    expect(descendant?.footprint_mb).toBe(4096);
    // The finding: NOT "in the GC's own process tree".
    expect(descendant?.protected).toBeNull();
    expect(descendant?.overmem).toEqual({ eligible: true, why: "footprint 4096 MB > 1024 MB" });

    // …and every class-based refusal is still in force.
    expect(rows.get(100)?.overmem).toEqual({ eligible: false, why: "never killed: report only" });
    expect(rows.get(150)?.overmem).toEqual({ eligible: false, why: "never killed: report only" });
    expect(rows.get(200)?.overmem?.why).toContain("the daemon is never memory-killed");
    expect(rows.get(400)?.overmem?.why).toContain(
      "an agent child itself is never memory-killed",
    );
    for (const pid of [100, 150, 200, 400]) {
      expect(rows.get(pid)?.overmem?.eligible).toBe(false);
    }
  });

  it("would have protected the whole agent tree if selfPid were the daemon (the ruled-out reading)", async () => {
    // The same world, with the old default: the daemon's pid. This is what the
    // fix removes, and it is why the sentinel is not merely cosmetic.
    const test = await world(
      { apply: false, memWarnMb: 512, memKillMb: 1024 },
      { selfPid: 200 },
    );

    const result = await runTick(test.deps);
    const rows = new Map(result.report.procs.procs.map((row) => [row.pid, row]));

    for (const pid of [100, 150, 200, 400, process.pid]) {
      expect(rows.get(pid)?.protected).toBe("in the GC's own process tree");
    }
    expect(rows.get(process.pid)?.overmem?.eligible).toBe(false);
  });
});

describe("runTick — the acting phases, with something to act on", () => {
  it("deletes an eligible, signed agent record exactly once when apply is on", async () => {
    const test = await world({ apply: true, killStale: false, killMemory: false });

    const result = await runTick(test.deps);

    const candidate = result.candidates.find((row) => row.id === GARBAGE_ID);
    expect(candidate).toMatchObject({
      kind: "agent",
      id: GARBAGE_ID,
      rule: "agent-archived",
      refusedBy: null,
      path: test.recordPath,
    });
    expect(candidate?.sig).not.toBe("");

    expect(test.deleteAgent).toHaveBeenCalledTimes(1);
    expect(test.deleteAgent).toHaveBeenCalledWith(GARBAGE_ID);
    expect(test.deleteSchedule).not.toHaveBeenCalled();
    // The row the screen shows records the action, not just the attempt.
    expect(result.acted).toEqual([
      {
        kind: "agent",
        id: GARBAGE_ID,
        acted: true,
        reason: `agent delete ok: ${GARBAGE_ID}`,
        refusedBy: null,
      },
    ]);
  });

  it("deletes nothing with the same eligible candidate when apply is off", async () => {
    const test = await world({ apply: false, killStale: false, killMemory: false });

    const result = await runTick(test.deps);

    // The candidate is garbage on the same evidence as above — only the guard differs.
    expect(result.candidates.find((row) => row.id === GARBAGE_ID)?.refusedBy).toBeNull();
    expect(test.deleteAgent).not.toHaveBeenCalled();
    expect(result.acted).toEqual([]);
  });

  it("refuses a candidate whose signature cannot be re-read, and deletes nothing", async () => {
    const test = await world({ apply: true, killStale: false, killMemory: false });
    const recordPath = test.recordPath;
    // The record file vanishes between the index scan and the record scan: the
    // candidate is still eligible, but there is no `inode:size:mtime` to re-check.
    test.deps.seams = {
      procs: async (input) => {
        const phase = await collectProcsPhase(input);
        await rm(recordPath, { force: true });
        return phase;
      },
    };

    const result = await runTick(test.deps);

    const candidate = result.candidates.find((row) => row.id === GARBAGE_ID);
    expect(candidate?.refusedBy).toBeNull();
    expect(candidate?.sig).toBe("");

    const row = result.acted.find((entry) => entry.id === GARBAGE_ID);
    expect(row).toMatchObject({ kind: "agent", acted: false });
    expect(String(row?.refusedBy)).toContain("sig-unverified");
    expect(test.deleteAgent).not.toHaveBeenCalled();
  });

  it("builds the screen's status from a non-empty tick", async () => {
    const test = await world({ apply: false, memWarnMb: 512, memKillMb: 1024 });

    const result = await runTick(test.deps);
    const status = buildStatus(result);

    expect(status.ident).toEqual({ ok: true, why: "ok" });
    expect(status.lastTickAt).toBe(result.at);
    expect(status.nextReportAt).toBe(result.nextReportAt);
    expect(status.procs.map((row) => row.pid)).toEqual([100, 150, 200, 400, process.pid]);
    expect(status.procs.find((row) => row.pid === 200)).toEqual({
      pid: 200,
      class: "daemon",
      owner: null,
      footprintMb: 3072,
      warn: true,
    });
    expect(status.procs.find((row) => row.pid === 400)?.owner).toBe(LIVE_ID);
    expect(status.procs.find((row) => row.pid === process.pid)).toEqual({
      pid: process.pid,
      class: "agent-descendant",
      owner: LIVE_ID,
      footprintMb: 4096,
      warn: true,
    });
    // Every record candidate, refused ones included: this one is eligible.
    expect(status.candidates).toEqual([
      { kind: "agent", id: GARBAGE_ID, rule: "agent-archived", refusedBy: null },
    ]);
  });
});

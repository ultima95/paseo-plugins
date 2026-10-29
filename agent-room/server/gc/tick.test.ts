import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GcSettings } from "../../shared/gc";
import type { ExecResult, GcExec } from "./report";
import { DEFAULT_GC_SETTINGS } from "./settings";
import { AGENT_MIN_DAYS, runTick, type TickDeps } from "./tick";

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
});

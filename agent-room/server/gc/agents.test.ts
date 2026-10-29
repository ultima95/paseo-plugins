// The agent and schedule index: the two reads whose completeness every deletion
// depends on.
//
// Every case here is a mock of the SDK's own shapes (`@getpaseo/client`): the
// agent list returns `{ entries: [{ agent }], pageInfo }` and the schedule list
// returns `{ schedules, error }`. No live daemon, agent or schedule is touched
// and the reference tool is never run. The derivations under test are the
// reference's `AGENT_JQ` (slp-gc.bash:212-225) and `SCHED_JQ` (slp-gc.bash:228-252).
import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";

import {
  isoEpoch,
  snapshotAgents,
  snapshotSchedules,
  type AgentsApi,
  type SchedulesApi,
} from "./agents";

/** A fixed clock: the reference's epoch-second comparisons are all `NOW`-relative. */
const NOW = 1_800_000_000;

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** A fake `paseo` carrying only the agent list, cast like the SDK's own surface. */
function agentsPaseo(list: (options?: unknown) => Promise<unknown>): AgentsApi {
  return { agents: { list: vi.fn(list) } } as unknown as AgentsApi;
}

/** A fake `paseo` for the schedule surface (or for one that is missing). */
function schedulesPaseo(api: Record<string, unknown>): SchedulesApi {
  return api as unknown as SchedulesApi;
}

/** One agent snapshot with every key the deletion rule reads (AGENT_JQ:217-225). */
function agent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    provider: "claude",
    cwd: "/tmp",
    status: "idle",
    updatedAt: iso(NOW - 60),
    archivedAt: null,
    internal: false,
    labels: {},
    ...over,
  };
}

/** One `FetchAgentsEntry`: the snapshot plus the project it sits in. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent: agent(over), project: null };
}

function page(entries: unknown[], hasMore = false, nextCursor: string | null = null) {
  return { entries, pageInfo: { hasMore, nextCursor, prevCursor: null } };
}

/** One schedule summary (protocol `ScheduleSummary`) with its runs for the test. */
function schedule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    name: null,
    prompt: "sweep the room",
    status: "active",
    target: { type: "agent", agentId: "a1" },
    updatedAt: iso(NOW - 7200),
    lastRunAt: null,
    nextRunAt: null,
    runs: [],
    ...over,
  };
}

describe("isoEpoch", () => {
  // `iso_epoch` (slp-gc.bash:199-200) accepts exactly the UTC form the daemon
  // writes, strips a fractional part, and answers null for anything else.
  const cases: Array<[unknown, number | null]> = [
    ["2026-10-01T00:00:00Z", Date.parse("2026-10-01T00:00:00Z") / 1000],
    ["2026-10-01T00:00:00.123Z", Date.parse("2026-10-01T00:00:00Z") / 1000],
    ["2026-10-01T00:00:00+02:00", null],
    ["2026-10-01", null],
    ["not-a-date", null],
    ["2026-13-01T00:00:00Z", null],
    [null, null],
    [1790000000, null],
  ];
  it.each(cases)("%s", (value, expected) => {
    expect(isoEpoch(value)).toBe(expected);
  });

  it("never answers NaN", () => {
    for (const [, expected] of cases) {
      expect(Number.isNaN(expected as number)).toBe(false);
    }
    expect(isoEpoch("2026-13-01T00:00:00Z")).toBeNull();
  });
});

describe("snapshotAgents", () => {
  it("maps API records and marks index ok", async () => {
    const paseo = agentsPaseo(async () =>
      page([
        entry({ id: "a1", archivedAt: null }),
        entry({
          id: "a2",
          provider: "command-code",
          cwd: null,
          archivedAt: "2026-10-01T00:00:00Z",
        }),
      ]),
    );

    const { agents, index } = await snapshotAgents(paseo);

    expect(index.ok).toBe(true);
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(agents[1].archivedEpoch).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
    expect(agents[0].archivedEpoch).toBeNull();
  });

  it("a failed read yields an incomplete index and no agents", async () => {
    const log = { warn: vi.fn() };
    const paseo = agentsPaseo(async () => {
      throw new Error("boom");
    });

    const { agents, index } = await snapshotAgents(paseo, { log });

    expect(agents).toEqual([]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("boom");
    // The failure is logged as well as reported: a silent refusal would look
    // like a healthy empty home.
    expect(log.warn).toHaveBeenCalled();
  });

  it("asks for archived and internal records, as the reference's file scan does", async () => {
    const list = vi.fn(async (_request?: unknown) => page([entry()]));
    const paseo = { agents: { list } } as unknown as AgentsApi;

    await snapshotAgents(paseo);

    expect(list.mock.calls[0][0]).toMatchObject({
      filter: { includeArchived: true, includeInternal: true },
    });
  });

  it("follows pageInfo until the daemon has no more agents", async () => {
    // A partial index is the one thing reclamation cannot tolerate: a missing
    // record hides a live parent or a targeting schedule.
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([entry({ id: "a1" })], true, "cursor-2"))
      .mockResolvedValueOnce(page([entry({ id: "a2" })], false));
    const paseo = { agents: { list } } as unknown as AgentsApi;

    const { agents, index } = await snapshotAgents(paseo);

    expect(index.ok).toBe(true);
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(list.mock.calls[1][0]).toMatchObject({ page: { cursor: "cursor-2" } });
  });

  it("an unreachable next page fails the index instead of truncating it", async () => {
    const list = vi.fn(async () => page([entry({ id: "a1" })], true, null));
    const paseo = { agents: { list } } as unknown as AgentsApi;

    const { index } = await snapshotAgents(paseo);

    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("cursor");
  });

  it("reads the decision fields of one snapshot", async () => {
    const paseo = agentsPaseo(async () =>
      page([
        entry({
          id: "child",
          status: "closed",
          archivedAt: iso(NOW - 20 * 86400),
          internal: false,
          labels: { "paseo.parent-agent-id": "parent", other: "value" },
          runtimeInfo: { provider: "claude", sessionId: "sess-1" },
        }),
      ]),
    );

    const { agents } = await snapshotAgents(paseo);

    expect(agents[0]).toMatchObject({
      id: "child",
      provider: "claude",
      status: "closed",
      cwd: "/tmp",
      internal: false,
      parent: "parent",
      sessionId: "sess-1",
      labels: { "paseo.parent-agent-id": "parent", other: "value" },
    });
    expect(agents[0].archivedEpoch).toBe(NOW - 20 * 86400);
  });

  it("defaults a missing label map and a missing runtime info", async () => {
    const paseo = agentsPaseo(async () => page([entry({ labels: "nope" })]));

    const { agents } = await snapshotAgents(paseo);

    expect(agents[0].labels).toEqual({});
    expect(agents[0].parent).toBeNull();
    expect(agents[0].sessionId).toBeNull();
  });

  // `strict` (AGENT_JQ:220-222): every key the deletion rule depends on is
  // present with the right type. Each row below removes or retypes exactly one
  // of them, so a dropped clause in the implementation turns one green.
  const strictCases: Array<[string, Record<string, unknown>, boolean]> = [
    ["a full record", {}, true],
    ["no internal key", { internal: undefined }, false],
    ["a non-boolean internal", { internal: "true" }, false],
    ["no archivedAt key", { archivedAt: undefined }, false],
    ["a numeric archivedAt", { archivedAt: 1790000000 }, false],
    ["a null archivedAt", { archivedAt: null }, true],
    ["no status", { status: undefined }, false],
    ["no updatedAt", { updatedAt: undefined }, false],
  ];
  it.each(strictCases)("strict is %s -> %s", async (_label, over, expected) => {
    const record = agent(over);
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete record[key];
    }
    const paseo = agentsPaseo(async () => page([{ agent: record }]));

    const { agents } = await snapshotAgents(paseo);

    expect(agents[0].strict).toBe(expected);
  });

  it("flags an internal record without making it strict", async () => {
    const paseo = agentsPaseo(async () => page([entry({ internal: true })]));

    const { agents } = await snapshotAgents(paseo);

    expect(agents[0].internal).toBe(true);
    expect(agents[0].strict).toBe(true);
  });

  it("an invalid archivedAt yields a null epoch, never NaN", async () => {
    const paseo = agentsPaseo(async () =>
      page([entry({ archivedAt: "2026-10-01T00:00:00+02:00" })]),
    );

    const { agents } = await snapshotAgents(paseo);

    expect(agents[0].archivedAt).toBe("2026-10-01T00:00:00+02:00");
    expect(agents[0].archivedEpoch).toBeNull();
  });

  it("drops a record it cannot identify and fails the index", async () => {
    // The reference keeps such a record as `unreadable` and lets its id block
    // deletions; here the whole index refuses instead, which is the same
    // fail-closed answer for a caller that has no path to file contents.
    const paseo = agentsPaseo(async () =>
      page([entry({ id: "a1" }), { agent: { provider: "claude" } }, { agent: { id: "" } }]),
    );

    const { agents, index } = await snapshotAgents(paseo);

    expect(agents.map((a) => a.id)).toEqual(["a1"]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("id");
  });

  it("fails the index when a record has no provider", async () => {
    const paseo = agentsPaseo(async () =>
      page([{ agent: { id: "a1", status: "idle", updatedAt: iso(NOW) } }]),
    );

    const { agents, index } = await snapshotAgents(paseo);

    expect(agents).toEqual([]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("provider");
  });
});

describe("snapshotSchedules", () => {
  const listOnly = (schedules: unknown[]) =>
    schedulesPaseo({ scheduleList: vi.fn(async () => ({ schedules, error: null })) });

  it("counts failures in the last 24h", async () => {
    const paseo = listOnly([
      schedule({
        runs: [
          { startedAt: iso(NOW - 60), status: "failed", error: "boom" },
          { startedAt: iso(NOW - 7200), status: "succeeded", error: null },
        ],
      }),
    ]);

    const { schedules, index } = await snapshotSchedules(paseo, { now: NOW });

    expect(index.ok).toBe(true);
    expect(schedules[0]).toMatchObject({ id: "s1", runs: 2, fail24h: 1, targetAgent: "a1" });
  });

  it("counts fires from run timestamps and ignores unusable ones", async () => {
    const paseo = listOnly([
      schedule({
        runs: [
          { startedAt: iso(NOW - 60), status: "succeeded" },
          { startedAt: iso(NOW - 7200), status: "succeeded" },
          { scheduledFor: iso(NOW - 3600), status: "succeeded" },
          { startedAt: iso(NOW - 90000), status: "succeeded" },
          { startedAt: "2026-10-01T00:00:00+02:00", status: "succeeded" },
          { startedAt: null, scheduledFor: null, status: "succeeded" },
        ],
      }),
    ]);

    const { schedules } = await snapshotSchedules(paseo, { now: NOW });

    // fires24h: -60, -7200 and -3600 are inside 24 h; -90000 and the two
    // unreadable timestamps are not.
    expect(schedules[0]).toMatchObject({ runs: 6, fires1h: 2, fires24h: 3 });
  });

  it("counts an active-run failure separately from plain failures", async () => {
    const paseo = listOnly([
      schedule({
        runs: [
          { startedAt: iso(NOW - 60), status: "failed", error: "boom" },
          {
            startedAt: iso(NOW - 120),
            status: "failed",
            error: "Agent already has an active run",
          },
          { startedAt: iso(NOW - 180), status: "failed", error: "Already Has An Active Run!" },
          { startedAt: iso(NOW - 240), status: "running", error: null },
          // Inside the day but outside the hour: only the 24 h window counts it.
          { startedAt: iso(NOW - 7200), status: "failed", error: "" },
          // Outside the day: not a 24 h failure at all.
          { startedAt: iso(NOW - 90000), status: "failed", error: "long gone" },
        ],
      }),
    ]);

    const { schedules } = await snapshotSchedules(paseo, { now: NOW });

    expect(schedules[0]).toMatchObject({
      runs: 6,
      runsRunning: 1,
      fail24h: 4,
      activeRunFail24h: 2,
    });
  });

  it("treats an error the runs do not carry as a failure", async () => {
    const paseo = listOnly([
      schedule({
        runs: [{ startedAt: iso(NOW - 60), status: "succeeded", error: "provider died" }],
      }),
    ]);

    const { schedules } = await snapshotSchedules(paseo, { now: NOW });

    expect(schedules[0].fail24h).toBe(1);
  });

  it("detects room machinery by name and by heartbeat prompt", async () => {
    const paseo = listOnly([
      schedule({ id: "s1", name: "supervisor: nightly" }),
      schedule({
        id: "s2",
        name: null,
        prompt: "[supervisor-heartbeat] tick",
        target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
      }),
      schedule({ id: "s3", name: "user job", prompt: "do work" }),
    ]);

    const { schedules } = await snapshotSchedules(paseo, { now: NOW });

    expect(schedules.map((s) => s.room)).toEqual([true, true, false]);
    expect(schedules[1].targetType).toBe("new-agent");
    expect(schedules[1].targetAgent).toBeNull();
  });

  it("reads runs from the schedule logs when the list summary has none", async () => {
    // The daemon's list payload is a `ScheduleSummary`, which has no `runs`.
    const withoutRuns = schedule();
    delete withoutRuns.runs;
    const logs = vi.fn(async () => ({
      runs: [{ startedAt: iso(NOW - 30), status: "running" }],
      error: null,
    }));
    const paseo = schedulesPaseo({
      scheduleList: vi.fn(async () => ({ schedules: [withoutRuns], error: null })),
      scheduleLogs: logs,
    });

    const { schedules, index } = await snapshotSchedules(paseo, { now: NOW });

    expect(logs).toHaveBeenCalledWith({ id: "s1" });
    expect(schedules[0]).toMatchObject({ runs: 1, runsRunning: 1, strict: true });
    expect(index.ok).toBe(true);
  });

  it("fails the index when the runs of a schedule cannot be read", async () => {
    const withoutRuns = schedule();
    delete withoutRuns.runs;
    const paseo = schedulesPaseo({
      scheduleList: vi.fn(async () => ({ schedules: [withoutRuns], error: null })),
      scheduleLogs: vi.fn(async () => {
        throw new Error("logs unavailable");
      }),
    });

    const { index } = await snapshotSchedules(paseo, { now: NOW });

    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("logs unavailable");
  });

  // `strict` (SCHED_JQ:241-242): the runs array plus the two run stamps the
  // reclamation recheck reads, and an updatedAt of the right type.
  const strictCases: Array<[string, Record<string, unknown>, boolean]> = [
    ["a full record", {}, true],
    ["no runs", { runs: undefined }, false],
    ["a non-array runs", { runs: "nope" }, false],
    ["no lastRunAt key", { lastRunAt: undefined }, false],
    ["a lastRunAt of the wrong type", { lastRunAt: 12345 }, false],
    ["no nextRunAt key", { nextRunAt: undefined }, false],
    ["no updatedAt", { updatedAt: undefined }, false],
  ];
  it.each(strictCases)("strict is %s -> %s", async (_label, over, expected) => {
    const record = schedule(over);
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete record[key];
    }
    const paseo = listOnly([record]);

    const { schedules } = await snapshotSchedules(paseo, { now: NOW });

    expect(schedules[0].strict).toBe(expected);
  });

  it("carries the run stamps the reclamation rule compares", async () => {
    const paseo = listOnly([
      schedule({
        status: "completed",
        updatedAt: iso(NOW - 7200),
        lastRunAt: iso(NOW - 600),
        nextRunAt: null,
      }),
    ]);

    const { schedules } = await snapshotSchedules(paseo, { now: NOW });

    expect(schedules[0]).toMatchObject({
      name: null,
      status: "completed",
      targetType: "agent",
      nextRunAt: null,
      updatedAt: iso(NOW - 7200),
      updatedEpoch: NOW - 7200,
      lastRunEpoch: NOW - 600,
    });
  });

  it("drops a schedule it cannot identify and fails the index", async () => {
    const paseo = listOnly([
      schedule({ id: "s1" }),
      { status: "active", target: { type: "agent", agentId: "a1" } },
      { id: "s3", target: { type: "agent", agentId: "a1" } },
      { id: "s4", status: "active" },
    ]);

    const { schedules, index } = await snapshotSchedules(paseo, { now: NOW });

    expect(schedules.map((s) => s.id)).toEqual(["s1"]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("s3");
  });

  it("a listed error fails the index and yields no schedules", async () => {
    const paseo = schedulesPaseo({
      scheduleList: vi.fn(async () => ({ schedules: [schedule()], error: "daemon busy" })),
    });

    const { schedules, index } = await snapshotSchedules(paseo, { now: NOW });

    expect(schedules).toEqual([]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("daemon busy");
  });

  it("a thrown read yields an incomplete index and no schedules", async () => {
    const log = { warn: vi.fn() };
    const paseo = schedulesPaseo({
      scheduleList: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const { schedules, index } = await snapshotSchedules(paseo, { now: NOW, log });

    expect(schedules).toEqual([]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("boom");
    expect(log.warn).toHaveBeenCalled();
  });

  it("says why when the api exposes no schedule surface", async () => {
    // Today's `PaseoApi` has no schedules at all, so the honest answer is an
    // incomplete index — never an empty one that looks like "nothing to do".
    const { schedules, index } = await snapshotSchedules(schedulesPaseo({}), { now: NOW });

    expect(schedules).toEqual([]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("scheduleList");
  });
});

describe("the shapes the plugin context hands in", () => {
  it("accepts PaseoApi for the agent read", () => {
    // Compile-time assertion: if the SDK's agent surface moves, this file stops
    // compiling rather than the snapshot discovering it at runtime.
    const fitsAgents: PaseoApi extends AgentsApi ? true : false = true;
    expect(fitsAgents).toBe(true);
  });

  it("cannot be handed to the schedule read, because it has no schedules", () => {
    // `PaseoApi` (index.d.ts:398-408) has hosts, terminals, workspaces,
    // projects, agents, providers and config — no schedule member at all, so
    // this assignment is a type error today. Annotating it keeps the gap
    // honest: a future SDK that grows a schedule surface makes the annotation
    // unused and this file stops compiling, which is the moment to wire it up.
    // @ts-expect-error PaseoApi exposes no schedules; only DaemonClient does.
    const notSchedules: SchedulesApi = {} as PaseoApi;
    expect(notSchedules).toBeDefined();
  });
});

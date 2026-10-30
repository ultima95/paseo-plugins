// The agent and schedule index: the two reads whose completeness every deletion
// depends on, built from on-disk records exactly as the reference builds them.
//
// Every case writes synthetic records into a fresh temp directory shaped like
// the daemon's home (`agents/<workspace>/<id>.json`, `schedules/<id>.json`). No
// live `~/.paseo` directory is read, no daemon, agent or schedule is touched, and
// the reference tool is never run. The derivations under test are the
// reference's `AGENT_JQ` (slp-gc.bash:212-225), `SCHED_JQ` (slp-gc.bash:228-252)
// and the two scans `extract_agents` / `extract_schedules` (slp-gc.bash:623-661).
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { isoEpoch, snapshotAgents, snapshotSchedules } from "./agents";

/** A fixed clock: the reference's epoch-second comparisons are all `NOW`-relative. */
const NOW = 1_800_000_000;

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// ---------------------------------------------------------------------------
// temp homes
// ---------------------------------------------------------------------------

const homes: string[] = [];

/** A fresh `$PASEO_HOME` stand-in; removed after the file finishes. */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "gc-agents-"));
  homes.push(home);
  return home;
}

afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

/** Write one file, creating its parents; a string is written verbatim (for corrupt records). */
async function put(home: string, relative: string, value: unknown): Promise<string> {
  const path = join(home, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

/** `agents/<workspace>/<name>` — the depth `extract_agents` scans (slp-gc.bash:628). */
function putAgent(home: string, workspace: string, name: string, value: unknown): Promise<string> {
  return put(home, join("agents", workspace, name), value);
}

/** `schedules/<name>` — flat, `mindepth 1 -maxdepth 1` (slp-gc.bash:650). */
function putSchedule(home: string, name: string, value: unknown): Promise<string> {
  return put(home, join("schedules", name), value);
}

// ---------------------------------------------------------------------------
// record factories, shaped like the daemon's own files
// ---------------------------------------------------------------------------

/**
 * One agent record with every key the deletion rule reads. `id`, `provider`,
 * `lastStatus`, `archivedAt` (null), `internal`, `updatedAt`, `cwd`, `labels`
 * and `runtimeInfo.sessionId` are the keys observed in a real record.
 */
function agent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    provider: "claude",
    cwd: "/tmp",
    lastStatus: "idle",
    updatedAt: iso(NOW - 60),
    archivedAt: null,
    internal: false,
    labels: {},
    ...over,
  };
}

/** One schedule record with every key SCHED_JQ reads. */
function schedule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cff78540",
    name: null,
    prompt: "sweep the room",
    status: "active",
    target: { type: "agent", agentId: "a1" },
    cadence: { type: "cron", expression: "*/2 * * * *" },
    createdAt: iso(NOW - 7200),
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
  it("maps the records on disk and marks the index ok", async () => {
    const home = await makeHome();
    await putAgent(home, "workspace-one", "a1.json", agent({ id: "a1", archivedAt: null }));
    await putAgent(
      home,
      "workspace-two",
      "a2.json",
      agent({
        id: "a2",
        provider: "command-code",
        cwd: null,
        archivedAt: "2026-10-01T00:00:00Z",
      }),
    );

    const { agents, index } = await snapshotAgents(home);

    expect(index).toEqual({ ok: true, why: [] });
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(agents[1].archivedEpoch).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
    expect(agents[0].archivedEpoch).toBeNull();
    expect(agents[0]).toMatchObject({ provider: "claude", cwd: "/tmp", status: "idle" });
  });

  it("reads `status` out of the record's `lastStatus`, as AGENT_JQ does", async () => {
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent({ lastStatus: "closed" }));
    // A record that carries `status` but no `lastStatus` gets a null status and
    // fails strict: the reference reads `.lastStatus` only.
    await putAgent(home, "w", "a2.json", agent({ id: "a2", lastStatus: undefined, status: "closed" }));

    const { agents } = await snapshotAgents(home);

    expect(agents[0].status).toBe("closed");
    expect(agents[1].status).toBeNull();
    expect(agents[1].strict).toBe(false);
  });

  it("reads the decision fields of one record", async () => {
    const home = await makeHome();
    await putAgent(
      home,
      "w",
      "child.json",
      agent({
        id: "child",
        lastStatus: "closed",
        archivedAt: iso(NOW - 20 * 86400),
        internal: false,
        labels: { "paseo.parent-agent-id": "parent", other: "value" },
        runtimeInfo: { provider: "claude", sessionId: "sess-1" },
      }),
    );

    const { agents } = await snapshotAgents(home);

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
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent({ labels: "nope", runtimeInfo: undefined }));

    const { agents } = await snapshotAgents(home);

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
    ["no lastStatus", { lastStatus: undefined }, false],
    ["no updatedAt", { updatedAt: undefined }, false],
  ];
  it.each(strictCases)("strict is %s -> %s", async (_label, over, expected) => {
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent(over));

    const { agents } = await snapshotAgents(home);

    expect(agents).toHaveLength(1);
    expect(agents[0].strict).toBe(expected);
  });

  it("flags an internal record without making it non-strict", async () => {
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent({ internal: true }));

    const { agents } = await snapshotAgents(home);

    expect(agents[0].internal).toBe(true);
    expect(agents[0].strict).toBe(true);
  });

  it("an invalid archivedAt yields a null epoch, never NaN", async () => {
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent({ archivedAt: "2026-10-01T00:00:00+02:00" }));

    const { agents } = await snapshotAgents(home);

    expect(agents[0].archivedAt).toBe("2026-10-01T00:00:00+02:00");
    expect(agents[0].archivedEpoch).toBeNull();
  });

  it("a corrupt record fails the index but still returns the good ones", async () => {
    // The ruling: a record that fails to parse sets `index.ok: false` with the
    // reason, and the records that did parse still come back. The failed index
    // is what refuses reclamation downstream.
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent({ id: "a1" }));
    const bad = await putAgent(home, "w", "a2.json", '{"id": "a2", ');

    const log = { warn: vi.fn() };
    const { agents, index } = await snapshotAgents(home, { log });

    expect(agents.map((a) => a.id)).toEqual(["a1"]);
    expect(index.ok).toBe(false);
    expect(index.why.join("\n")).toContain(bad);
    expect(index.why.join("\n")).toContain("invalid JSON");
    // A silent `ok:false` would look like a healthy, empty home.
    expect(log.warn).toHaveBeenCalled();
  });

  it("drops a record it cannot identify, fails the index, and keeps the rest", async () => {
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent({ id: "a1" }));
    await putAgent(home, "w", "no-id.json", agent({ id: undefined }));
    await putAgent(home, "w", "empty-id.json", agent({ id: "" }));
    await putAgent(home, "w", "no-provider.json", agent({ id: "a3", provider: undefined }));
    await putAgent(home, "w", "not-an-object.json", "[]");

    const { agents, index } = await snapshotAgents(home);

    expect(agents.map((a) => a.id)).toEqual(["a1"]);
    expect(index.ok).toBe(false);
    const why = index.why.join("\n");
    expect(why).toContain("missing id");
    expect(why).toContain("missing provider");
    expect(why).toContain("not a JSON object");
  });

  it("an absent agents directory is a healthy, empty index", async () => {
    // slp-gc.bash:627 — `[ ! -d "$PHOME/agents" ]` answers `[]` and no error.
    const home = await makeHome();

    const { agents, index } = await snapshotAgents(home);

    expect(agents).toEqual([]);
    expect(index).toEqual({ ok: true, why: [] });
  });

  it("treats a non-directory at the agents path as absent, like `[ ! -d ]`", async () => {
    const home = await makeHome();
    await put(home, "agents", "not a directory");

    const { agents, index } = await snapshotAgents(home);

    expect(agents).toEqual([]);
    expect(index.ok).toBe(true);
  });

  it("scans only `<workspace>/<name>.json` at the reference's depth and suffix", async () => {
    const home = await makeHome();
    await putAgent(home, "w", "kept.json", agent({ id: "kept" }));
    // `-mindepth 2`: a record sitting directly in agents/ is not scanned.
    await put(home, "agents/top-level.json", agent({ id: "top" }));
    // `-name '*.json'`: anything else is not a record.
    await putAgent(home, "w", "notes.txt", "not a record");
    // `-maxdepth 2`: a record nested one level deeper is not scanned.
    await put(home, "agents/w/deeper/nested.json", agent({ id: "nested" }));

    const { agents, index } = await snapshotAgents(home);

    expect(agents.map((a) => a.id)).toEqual(["kept"]);
    expect(index.ok).toBe(true);
  });

  it("flags a symlinked record and never follows it", async () => {
    // slp-gc.bash:641-643 — `find … -type l` reports the link itself.
    const home = await makeHome();
    await putAgent(home, "w", "a1.json", agent({ id: "a1" }));
    const target = join(home, "elsewhere.json");
    await writeFile(target, JSON.stringify(agent({ id: "linked" })));
    await symlink(target, join(home, "agents/w/linked.json"));

    const { agents, index } = await snapshotAgents(home);

    expect(agents.map((a) => a.id)).toEqual(["a1"]);
    expect(index.ok).toBe(false);
    expect(index.why.join("\n")).toContain("symlink (never followed)");
  });

  it("keeps one record per id when two files disagree", async () => {
    const home = await makeHome();
    await putAgent(home, "w", "a1-first.json", agent({ id: "a1", provider: "claude" }));
    await putAgent(home, "w", "a1-second.json", agent({ id: "a1", provider: "codex" }));

    const { agents, index } = await snapshotAgents(home);

    expect(agents).toHaveLength(1);
    expect(agents[0].provider).toBe("claude"); // sorted by file name, first wins
    expect(index.ok).toBe(true);
  });

  it("fails the index when a workspace directory cannot be read", async () => {
    // A directory read failure is the reference's `idx_err` (:628): the index is
    // incomplete and apply is disabled. A root test runner ignores mode bits, so
    // the case is skipped there.
    if (process.getuid?.() === 0) return;
    const home = await makeHome();
    await putAgent(home, "readable", "a1.json", agent({ id: "a1" }));
    await putAgent(home, "closed", "a2.json", agent({ id: "a2" }));
    const closed = join(home, "agents/closed");
    await chmod(closed, 0o000);

    try {
      const { agents, index } = await snapshotAgents(home);

      expect(agents.map((a) => a.id)).toEqual(["a1"]);
      expect(index.ok).toBe(false);
      expect(index.why.join("\n")).toContain(closed);
    } finally {
      await chmod(closed, 0o755); // so the temp home can be removed
    }
  });

  it("honours an explicit directory override", async () => {
    const home = await makeHome();
    const elsewhere = join(home, "somewhere-else");
    await mkdir(join(elsewhere, "w"), { recursive: true });
    await writeFile(join(elsewhere, "w", "a9.json"), JSON.stringify(agent({ id: "a9" })));

    const { agents } = await snapshotAgents(home, { dir: elsewhere });

    expect(agents.map((a) => a.id)).toEqual(["a9"]);
  });
});

describe("snapshotSchedules", () => {
  it("counts failures in the last 24h from the record's runs", async () => {
    const home = await makeHome();
    await putSchedule(
      home,
      "cff78540.json",
      schedule({
        runs: [
          { startedAt: iso(NOW - 60), status: "failed", error: "boom" },
          { startedAt: iso(NOW - 7200), status: "succeeded", error: null },
        ],
      }),
    );

    const { schedules, index } = await snapshotSchedules(home, { now: NOW });

    expect(index).toEqual({ ok: true, why: [] });
    expect(schedules[0]).toMatchObject({ id: "cff78540", runs: 2, fail24h: 1, targetAgent: "a1" });
  });

  it("counts fires from run timestamps and ignores unusable ones", async () => {
    const home = await makeHome();
    await putSchedule(
      home,
      "cff78540.json",
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
    );

    const { schedules } = await snapshotSchedules(home, { now: NOW });

    // fires24h: -60, -7200 and -3600 are inside 24 h; -90000 and the two
    // unusable stamps are not.
    expect(schedules[0]).toMatchObject({ runs: 6, fires1h: 2, fires24h: 3 });
  });

  it("counts an active-run failure separately from plain failures", async () => {
    const home = await makeHome();
    await putSchedule(
      home,
      "cff78540.json",
      schedule({
        runs: [
          { startedAt: iso(NOW - 60), status: "failed", error: "boom" },
          {
            startedAt: iso(NOW - 120),
            status: "failed",
            error: "Agent a1 already has an active run",
          },
          { startedAt: iso(NOW - 180), status: "failed", error: "Already Has An Active Run!" },
          { startedAt: iso(NOW - 240), status: "running", error: null },
          // Inside the day but outside the hour: only the 24 h window counts it.
          { startedAt: iso(NOW - 7200), status: "failed", error: "" },
          // Outside the day: not a 24 h failure at all.
          { startedAt: iso(NOW - 90000), status: "failed", error: "long gone" },
        ],
      }),
    );

    const { schedules } = await snapshotSchedules(home, { now: NOW });

    expect(schedules[0]).toMatchObject({
      runs: 6,
      runsRunning: 1,
      fail24h: 4,
      activeRunFail24h: 2,
    });
  });

  it("treats an error without a failed status as a failure (isfail, :230)", async () => {
    const home = await makeHome();
    await putSchedule(
      home,
      "cff78540.json",
      schedule({
        runs: [{ startedAt: iso(NOW - 60), status: "succeeded", error: "provider died" }],
      }),
    );

    const { schedules } = await snapshotSchedules(home, { now: NOW });

    expect(schedules[0].fail24h).toBe(1);
  });

  it("flattens the cadence object and keeps createdAt (SCHED_JQ:244-245)", async () => {
    // The report's `cadence` is one token, not the record's object: the reference
    // reads `.cadence.expression`, else `type:` + the interval, and `null` for
    // anything that is not an object. The port shipped `cadence: null` on every
    // row until the equivalence harness compared the two reports.
    const home = await makeHome();
    await putSchedule(home, "aaaaaaaa.json", schedule({ id: "aaaaaaaa" }));
    await putSchedule(
      home,
      "bbbbbbbb.json",
      schedule({ id: "bbbbbbbb", cadence: { type: "interval", everyMs: 5000 } }),
    );
    await putSchedule(home, "cccccccc.json", schedule({ id: "cccccccc", cadence: "*/5 * * * *" }));
    await putSchedule(home, "dddddddd.json", schedule({ id: "dddddddd", createdAt: null }));

    const { schedules } = await snapshotSchedules(home, { now: NOW });
    const byId = new Map(schedules.map((entry) => [entry.id, entry]));

    expect(byId.get("aaaaaaaa")?.cadence).toBe("*/2 * * * *");
    expect(byId.get("bbbbbbbb")?.cadence).toBe("interval:5000");
    expect(byId.get("cccccccc")?.cadence).toBeNull();
    expect(byId.get("aaaaaaaa")?.createdAt).toBe(iso(NOW - 7200));
    expect(byId.get("dddddddd")?.createdAt).toBeNull();
  });

  it("detects room machinery by name and by heartbeat prompt", async () => {
    const home = await makeHome();
    await putSchedule(home, "11111111.json", schedule({ id: "11111111", name: "supervisor: nightly" }));
    await putSchedule(
      home,
      "22222222.json",
      schedule({
        id: "22222222",
        name: null,
        prompt: "[supervisor-heartbeat] tick",
        target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
      }),
    );
    await putSchedule(
      home,
      "33333333.json",
      schedule({ id: "33333333", name: "user job", prompt: "do work" }),
    );

    const { schedules } = await snapshotSchedules(home, { now: NOW });

    expect(schedules.map((s) => s.room)).toEqual([true, true, false]);
    expect(schedules[1].targetType).toBe("new-agent");
    expect(schedules[1].targetAgent).toBeNull();
  });

  // `strict` (SCHED_JQ:241-242): the runs array plus the two run stamps the
  // reclamation recheck reads, and an updatedAt of the right type. Note that a
  // missing `runs` is *not* a parse failure — the reference reads it as `[]`
  // (:237) — it is only a `strict: false` record.
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
    const home = await makeHome();
    await putSchedule(home, "cff78540.json", schedule(over));

    const { schedules } = await snapshotSchedules(home, { now: NOW });

    expect(schedules).toHaveLength(1);
    expect(schedules[0].strict).toBe(expected);
  });

  it("reads a record with no runs array as zero runs, not as a failure", async () => {
    const home = await makeHome();
    await putSchedule(home, "cff78540.json", schedule({ runs: undefined }));

    const { schedules, index } = await snapshotSchedules(home, { now: NOW });

    expect(index.ok).toBe(true);
    expect(schedules[0]).toMatchObject({ runs: 0, runsRunning: 0, fires1h: 0, fires24h: 0 });
  });

  it("carries the run stamps the reclamation rule compares", async () => {
    const home = await makeHome();
    await putSchedule(
      home,
      "cff78540.json",
      schedule({
        status: "completed",
        updatedAt: iso(NOW - 7200),
        lastRunAt: iso(NOW - 600),
        nextRunAt: null,
      }),
    );

    const { schedules } = await snapshotSchedules(home, { now: NOW });

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

  it("a corrupt schedule fails the index but still returns the good ones", async () => {
    const home = await makeHome();
    await putSchedule(home, "cff78540.json", schedule({ id: "cff78540" }));
    const bad = await putSchedule(home, "deadbeef.json", "{oops");

    const log = { warn: vi.fn() };
    const { schedules, index } = await snapshotSchedules(home, { now: NOW, log });

    expect(schedules.map((s) => s.id)).toEqual(["cff78540"]);
    expect(index.ok).toBe(false);
    expect(index.why.join("\n")).toContain(bad);
    expect(index.why.join("\n")).toContain("invalid JSON");
    expect(log.warn).toHaveBeenCalled();
  });

  it("drops a schedule it cannot identify, fails the index, and keeps the rest", async () => {
    const home = await makeHome();
    await putSchedule(home, "cff78540.json", schedule({ id: "cff78540" }));
    await putSchedule(home, "no-id.json", schedule({ id: undefined }));
    await putSchedule(home, "no-status.json", schedule({ id: "aaaa0001", status: undefined }));
    await putSchedule(home, "no-target.json", schedule({ id: "aaaa0002", target: undefined }));
    await putSchedule(
      home,
      "bad-target.json",
      schedule({ id: "aaaa0003", target: { agentId: "a1" } }),
    );
    await putSchedule(home, "not-an-object.json", "null");

    const { schedules, index } = await snapshotSchedules(home, { now: NOW });

    expect(schedules.map((s) => s.id)).toEqual(["cff78540"]);
    expect(index.ok).toBe(false);
    const why = index.why.join("\n");
    expect(why).toContain("missing id");
    expect(why).toContain("missing status");
    expect(why).toContain("missing target");
    expect(why).toContain("not a JSON object");
  });

  it("an absent schedules directory is a healthy, empty index", async () => {
    // slp-gc.bash:648 — `[ ! -d "$PHOME/schedules" ]` answers `[]` and no error.
    const home = await makeHome();

    const { schedules, index } = await snapshotSchedules(home, { now: NOW });

    expect(schedules).toEqual([]);
    expect(index).toEqual({ ok: true, why: [] });
  });

  it("scans only `*.json` files directly in the schedules directory", async () => {
    const home = await makeHome();
    await putSchedule(home, "cff78540.json", schedule({ id: "cff78540" }));
    await putSchedule(home, "cff78540.tmp", "{oops");
    await putSchedule(home, "notes.txt", "not a record");
    // `-mindepth 1 -maxdepth 1`: a subdirectory's records are not scanned.
    await putSchedule(home, join("nested", "aaaa0001.json"), schedule({ id: "aaaa0001" }));

    const { schedules, index } = await snapshotSchedules(home, { now: NOW });

    expect(schedules.map((s) => s.id)).toEqual(["cff78540"]);
    expect(index.ok).toBe(true);
  });

  it("flags a symlinked schedule record and never follows it", async () => {
    const home = await makeHome();
    await putSchedule(home, "cff78540.json", schedule({ id: "cff78540" }));
    const target = join(home, "elsewhere.json");
    await writeFile(target, JSON.stringify(schedule({ id: "aaaa0002" })));
    await symlink(target, join(home, "schedules", "aaaa0002.json"));

    const { schedules, index } = await snapshotSchedules(home, { now: NOW });

    expect(schedules.map((s) => s.id)).toEqual(["cff78540"]);
    expect(index.ok).toBe(false);
    expect(index.why.join("\n")).toContain("symlink (never followed)");
  });

  it("uses the wall clock by default and its own window arithmetic", async () => {
    // No `now` seam: a record updated/run a minute ago must land inside both
    // 1 h and 24 h windows of the real clock.
    const home = await makeHome();
    const wall = Math.floor(Date.now() / 1000);
    await putSchedule(
      home,
      "cff78540.json",
      schedule({
        updatedAt: iso(wall - 30),
        lastRunAt: iso(wall - 30),
        nextRunAt: iso(wall + 600),
        runs: [{ startedAt: iso(wall - 30), status: "succeeded" }],
      }),
    );

    const { schedules } = await snapshotSchedules(home);

    expect(schedules[0]).toMatchObject({ fires1h: 1, fires24h: 1, fail24h: 0 });
    expect(schedules[0].lastRunEpoch).toBeCloseTo(wall - 30, 0);
  });

  it("honours an explicit directory override", async () => {
    const home = await makeHome();
    const elsewhere = join(home, "somewhere-else");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(
      join(elsewhere, "aaaa0003.json"),
      JSON.stringify(schedule({ id: "aaaa0003" })),
    );

    const { schedules } = await snapshotSchedules(home, { now: NOW, dir: elsewhere });

    expect(schedules.map((s) => s.id)).toEqual(["aaaa0003"]);
  });
});

describe("the index never consults the daemon", () => {
  it("takes a home directory on both reads", () => {
    // Compile-time assertion: both reads take a home directory, so an edit that
    // reintroduces `PaseoApi` here stops compiling rather than silently reading
    // the wrong source of truth.
    const agentsRead: (home: string) => Promise<unknown> = (home) => snapshotAgents(home);
    const schedulesRead: (home: string) => Promise<unknown> = (home) => snapshotSchedules(home);
    expect(typeof agentsRead).toBe("function");
    expect(typeof schedulesRead).toBe("function");
  });
});

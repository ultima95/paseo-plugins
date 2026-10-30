// The garbage rules of the GC port: which archived agent records and which
// completed schedule records may be deleted at all.
//
// Every case is inline data — a hand-built record, a hand-built ref set and a
// stated index verdict. Nothing here reads the live `$PASEO_HOME`, stats a file,
// shells out to `ps`/`jq`, runs a reference subcommand, or talks to the daemon or
// an agent. The semantics authority is `docs/gc-port/slp-gc.bash` (EVAL_JQ,
// :480-557); the line numbers in each comment are its.
//
// Four brief cases needed an adjustment to be judged by the reference at all.
// Each is marked where it appears, and each adjustment is the reference's own
// requirement, not a relaxation:
//
//   1. The brief's `archivedAgent` has `status: "idle"`. The reference's agent
//      rule needs `lastStatus == "closed"` (:506), so that record is refused by
//      the status arm before any age is measured — `baseAgent` says `"closed"`.
//   2. The brief's `fresh` case expects the *age* to be the reason (":35"), which
//      again needs `"closed"` first.
//   3. The brief's schedule id is `"s1"`. The reference refuses a schedule whose
//      id is not 8 hex digits (:525), so `baseSchedule` uses `"abcd1234"`;
//      `"s1"` has its own case below.
//   4. The brief's schedule case passes `agents: []`. With no parsed agent record
//      the target's state is `unknown` (:494), which the reference refuses
//      (`:534`), so the schedule cases hand in the target agent's record.
import { describe, expect, it } from "vitest";

import type { AgentRecord, ScheduleRecord } from "./evaluate";
import { garbageDecisions } from "./evaluate";

const NOW = 1_800_000_000;
const DAY = 86400;
const iso = (s: number) => new Date(s * 1000).toISOString();

/** The brief's `ctx`, verbatim. */
const ctx = {
  now: NOW,
  minDays: 14,
  invoker: null,
  busyRefs: new Set<string>(),
  rawRefs: new Set<string>(),
  indexOk: true,
};

/**
 * An archived agent record that the reference calls garbage as it stands:
 * archived 20 days ago, `closed`, not internal, strict, referenced by nothing.
 */
function baseAgent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a-old",
    provider: "claude",
    archivedAt: iso(NOW - 20 * DAY),
    archivedEpoch: NOW - 20 * DAY,
    status: "closed",
    cwd: "/tmp/x",
    internal: false,
    labels: {},
    parent: null,
    sessionId: null,
    strict: true,
    ...over,
  };
}

/**
 * A completed room schedule aimed at `a-old`, updated two hours ago with its last
 * run ten-plus minutes back: garbage as it stands, once `baseAgent()` is in the
 * index too.
 */
function baseSchedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "abcd1234",
    name: "supervisor:cleanup",
    status: "completed",
    targetType: "agent",
    targetAgent: "a-old",
    lastRunAt: iso(NOW - 7200),
    nextRunAt: null,
    runs: 2,
    runsRunning: 0,
    fail24h: 0,
    room: true,
    strict: true,
    updatedAt: iso(NOW - 7200),
    updatedEpoch: NOW - 7200,
    lastRunEpoch: NOW - 7200,
    cadence: "*/2 * * * *",
    createdAt: iso(NOW - 3 * 86400),
    fires1h: 0,
    fires24h: 2,
    activeRunFail24h: 0,
    ...over,
  };
}

/** One agent row, judged on its own. */
const oneAgent = (rec: AgentRecord, over: Record<string, unknown> = {}) =>
  garbageDecisions({ ...ctx, agents: [rec], schedules: [], ...over })[0]!;

/** One schedule row, judged against the `a-old` record it targets. */
const oneSchedule = (rec: ScheduleRecord, over: Record<string, unknown> = {}) =>
  garbageDecisions({ ...ctx, agents: [baseAgent()], schedules: [rec], ...over })[0]!;

// ---------------------------------------------------------------------------
// The brief's six cases
// ---------------------------------------------------------------------------

describe("garbageDecisions", () => {
  it("candidates an agent archived beyond the minimum, with the rule named", () => {
    const [c] = garbageDecisions({ ...ctx, agents: [baseAgent()], schedules: [] });
    expect(c).toMatchObject({ kind: "agent", id: "a-old", rule: "agent-archived" });
    expect(c.refusedBy).toBeNull();
    expect(c.reason).toContain("GARBAGE: archived 20 d ago");
    expect(c.action).toBe("paseo agent delete a-old");
  });

  it("refuses an agent archived inside the window", () => {
    const fresh = baseAgent({ archivedAt: iso(NOW - DAY), archivedEpoch: NOW - DAY });
    const row = oneAgent(fresh);
    expect(row.refusedBy).toContain("14");
    // The rule is named, not just the number: the screen groups by the prefix.
    expect(row.refusedBy).toContain("agent-archived-age");
    expect(row.reason).toBe("not garbage: archived 1 d ago (< 14 d)");
  });

  it("refuses every candidate when the index is incomplete", () => {
    const result = garbageDecisions({
      ...ctx,
      indexOk: false,
      indexWhy: ["cannot read the record /h/agents/ws/a-old.json: EACCES"],
      agents: [baseAgent()],
      schedules: [baseSchedule()],
    });
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.refusedBy !== null)).toBe(true);
    // …and the refusal names the rule and carries the scan's own text.
    for (const c of result) {
      expect(c.refusedBy).toContain("index-incomplete");
      expect(c.refusedBy).toContain("cannot read the record");
      expect(c.action).toBeNull();
    }
  });

  it("refuses a live agent", () => {
    const live = baseAgent({ archivedAt: null, archivedEpoch: null });
    const row = oneAgent(live);
    expect(row.refusedBy).not.toBeNull();
    expect(row.refusedBy).toContain("agent-not-archived");
    // `closed`-but-unarchived has its own sentence: the user may still see it.
    expect(row.reason).toBe(
      "not garbage: closed but not archived (report-only; the user may still see it)",
    );
    expect(oneAgent(baseAgent({ archivedAt: null, archivedEpoch: null, status: "idle" })).reason).toBe(
      "not garbage: unarchived agent (lastStatus idle)",
    );
  });

  it("candidates a completed schedule", () => {
    const [c] = garbageDecisions({
      ...ctx,
      agents: [baseAgent()],
      schedules: [baseSchedule()],
    });
    expect(c).toMatchObject({ kind: "schedule", id: "abcd1234", rule: "schedule-completed" });
    expect(c.refusedBy).toBeNull();
    expect(c.reason).toBe(
      "GARBAGE: completed room schedule, target agent archived, updated > 1 h ago, no run in 10 min",
    );
    expect(c.action).toBe("paseo schedule delete abcd1234");
  });

  it("refuses a schedule another agent holds busy", () => {
    const busy = { ...ctx, busyRefs: new Set(["abcd1234"]) };
    const row = oneSchedule(baseSchedule(), busy);
    expect(row.refusedBy).not.toBeNull();
    expect(row.refusedBy).toContain("schedule-busy-ref");
  });
});

// ---------------------------------------------------------------------------
// The agent rule's refusals, one arm at a time
// ---------------------------------------------------------------------------

describe("garbageDecisions — agent refusals", () => {
  it("refuses an internal record even when everything else is clear", () => {
    const row = oneAgent(baseAgent({ internal: true }));
    expect(row.refusedBy).toBe("agent-internal: internal record");
  });

  it("refuses a record whose keys are not all of the right type", () => {
    const row = oneAgent(baseAgent({ strict: false }));
    expect(row.refusedBy).toContain("agent-strict");
    expect(row.reason).toContain("required keys missing or of the wrong type");
  });

  it("refuses an archived record whose lastStatus is not closed", () => {
    const row = oneAgent(baseAgent({ status: "idle" }));
    expect(row.refusedBy).toBe("agent-status: lastStatus is idle (rule needs closed)");
  });

  it("refuses an archived record whose archivedAt does not parse", () => {
    const row = oneAgent(
      baseAgent({ archivedAt: "2026-01-01 00:00:00", archivedEpoch: null }),
    );
    expect(row.refusedBy).toBe(
      "agent-archived-at-invalid: skipped: archivedAt is not a valid ISO timestamp",
    );
  });

  it("refuses a record with an unknown lastStatus", () => {
    const row = oneAgent(baseAgent({ status: "hibernating" }));
    expect(row.refusedBy).toBe(
      'agent-status-unknown: skipped: unknown lastStatus "hibernating"',
    );
    // jq's `tojson` of a missing status is the bare literal.
    expect(oneAgent(baseAgent({ status: null })).refusedBy).toBe(
      "agent-status-unknown: skipped: unknown lastStatus null",
    );
  });

  it("refuses the agent an unarchived record names as its parent", () => {
    const child = baseAgent({
      id: "a-child",
      archivedAt: null,
      archivedEpoch: null,
      status: "running",
      parent: "a-old",
    });
    const row = garbageDecisions({ ...ctx, agents: [baseAgent(), child], schedules: [] }).find(
      (c) => c.id === "a-old",
    )!;
    expect(row.refusedBy).toBe(
      "agent-live-parent: an unarchived agent references it via paseo.parent-agent-id",
    );
  });

  it("refuses the agent an active or paused schedule still targets", () => {
    const active = baseSchedule({ status: "active" });
    const row = garbageDecisions({ ...ctx, agents: [baseAgent()], schedules: [active] })[1]!;
    expect(row.id).toBe("a-old");
    expect(row.refusedBy).toBe("agent-schedule-target: an active/paused schedule targets it");
    // `paused` is a target claim too: the schedule can be resumed (:490).
    const paused = baseSchedule({ id: "ffffffff", status: "paused", targetAgent: "a-old" });
    expect(
      garbageDecisions({ ...ctx, agents: [baseAgent()], schedules: [paused] })[1]!.refusedBy,
    ).toBe("agent-schedule-target: an active/paused schedule targets it");
    // A paused schedule aimed elsewhere is not a claim about this agent.
    const pausedForOther = baseSchedule({ id: "ffffffff", status: "paused", targetAgent: "a-other" });
    expect(
      garbageDecisions({ ...ctx, agents: [baseAgent()], schedules: [pausedForOther] })[1]!.refusedBy,
    ).toBeNull();
    // Nor is a completed one: its target is gone by definition, which is what
    // makes the schedule garbage in the first place.
    expect(
      garbageDecisions({ ...ctx, agents: [baseAgent()], schedules: [baseSchedule()] })[1]!.refusedBy,
    ).toBeNull();
  });

  it("refuses an agent a live process still carries", () => {
    const row = oneAgent(baseAgent(), { procOwners: ["a-old"] });
    expect(row.refusedBy).toBe("agent-process: a process with PASEO_AGENT_ID=a-old is running");
  });

  it("refuses the invoking agent", () => {
    const row = oneAgent(baseAgent(), { invoker: "a-old" });
    expect(row.refusedBy).toBe("agent-invoker: it is the invoking agent");
    // An empty invoker is "run by hand" (:509), not a match.
    expect(oneAgent(baseAgent(), { invoker: "" }).refusedBy).toBeNull();
  });

  it("refuses an agent an in-flight creation or an unreadable record mentions", () => {
    expect(oneAgent(baseAgent(), { busyRefs: new Set(["a-old"]) }).refusedBy).toBe(
      "agent-busy-ref: an in-flight creation references it",
    );
    expect(oneAgent(baseAgent(), { rawRefs: new Set(["a-old"]) }).refusedBy).toBe(
      "agent-raw-ref: an unreadable record/schedule mentions it",
    );
    // The listed form is accepted for every ref input, not just a Set.
    expect(oneAgent(baseAgent(), { busyRefs: ["a-old"] }).refusedBy).toContain("agent-busy-ref");
  });

  it("refuses every agent and schedule when identification failed", () => {
    const identification = { ok: false, why: "no single daemon found" };
    const rows = garbageDecisions({
      ...ctx,
      identification,
      agents: [baseAgent()],
      schedules: [baseSchedule()],
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.refusedBy).toBe(
        "identification: Paseo identification failed: no single daemon found",
      );
    }
  });

  it("names the first failing rule but reports the whole fail list", () => {
    const row = oneAgent(
      baseAgent({ internal: true, archivedAt: iso(NOW - DAY), archivedEpoch: NOW - DAY }),
    );
    // Order is the contract: `internal` (:505) is examined before the age (:507).
    expect(row.refusedBy).toBe("agent-internal: internal record");
    expect(row.reason).toBe("not garbage: internal record; archived 1 d ago (< 14 d)");
  });

  it("measures the archive age in floored days, at the boundary", () => {
    const at = NOW - ctx.minDays * DAY;
    expect(oneAgent(baseAgent({ archivedAt: iso(at), archivedEpoch: at })).refusedBy).toBeNull();
    const justUnder = at + 1;
    expect(
      oneAgent(baseAgent({ archivedAt: iso(justUnder), archivedEpoch: justUnder })).refusedBy,
    ).toContain("archived 13 d ago (< 14 d)");
    // A future timestamp reads as a negative age and refuses, like the reference.
    expect(
      oneAgent(baseAgent({ archivedAt: iso(NOW + DAY), archivedEpoch: NOW + DAY })).refusedBy,
    ).toContain("archived -1 d ago");
  });

  it("notes unreadable agent environments on an otherwise eligible record", () => {
    const row = oneAgent(baseAgent(), { envBlind: 2 });
    expect(row.refusedBy).toBeNull();
    expect(row.reason).toContain("NOTE: the env of 2 agent-class process(es) is unreadable");
    // …and says nothing when every environment was readable.
    expect(oneAgent(baseAgent()).reason).not.toContain("NOTE:");
  });
});

// ---------------------------------------------------------------------------
// The schedule rule's refusals, one arm at a time
// ---------------------------------------------------------------------------

describe("garbageDecisions — schedule refusals", () => {
  it("refuses an id that is not 8 hex digits", () => {
    // The brief's own literal `s1` is refused here, before any other rule (:525).
    const row = oneSchedule(baseSchedule({ id: "s1" }));
    expect(row.refusedBy).toBe(
      "schedule-file-name: skipped: file name is not <id>.json with an 8-hex id",
    );
    // Uppercase hex and a 9-character id are both outside the reference's regex.
    expect(oneSchedule(baseSchedule({ id: "ABCD1234" })).refusedBy).toContain(
      "schedule-file-name",
    );
    expect(oneSchedule(baseSchedule({ id: "abcd12345" })).refusedBy).toContain(
      "schedule-file-name",
    );
  });

  it("refuses a record file whose name disagrees with the schedule id", () => {
    const row = oneSchedule(baseSchedule({ path: "/h/.paseo/schedules/ffffffff.json" }));
    expect(row.refusedBy).toContain("schedule-file-name");
    // A name that agrees is used verbatim and changes nothing.
    const ok = oneSchedule(baseSchedule({ path: "/h/.paseo/schedules/abcd1234.json" }));
    expect(ok.refusedBy).toBeNull();
    expect(ok.path).toBe("/h/.paseo/schedules/abcd1234.json");
  });

  it("refuses a schedule whose status is not one of the three", () => {
    const row = oneSchedule(baseSchedule({ status: "archived" }));
    expect(row.refusedBy).toBe('schedule-status-unknown: skipped: unknown status "archived"');
  });

  it("refuses a completed schedule that is not strict", () => {
    const row = oneSchedule(baseSchedule({ strict: false }));
    expect(row.refusedBy).toContain("schedule-strict");
    expect(row.reason).toContain("required keys missing or of the wrong type");
  });

  it("refuses a completed schedule that still has a next run", () => {
    const row = oneSchedule(baseSchedule({ nextRunAt: iso(NOW + 60) }));
    expect(row.refusedBy).toBe("schedule-next-run: nextRunAt is set");
  });

  it("refuses a completed schedule that targets a new agent", () => {
    const row = oneSchedule(baseSchedule({ targetType: "new-agent", targetAgent: null }));
    expect(row.refusedBy).toBe(
      "schedule-target-type: target is a new-agent schedule (not room machinery)",
    );
  });

  it("refuses a completed schedule whose target agent is still live or unknown", () => {
    const live = baseAgent({ archivedAt: null, archivedEpoch: null, status: "running" });
    const liveRow = garbageDecisions({
      ...ctx,
      agents: [live],
      schedules: [baseSchedule()],
    })[0]!;
    expect(liveRow.refusedBy).toBe("schedule-target-state: target agent is live");

    // No parsed record at all: the index is not trusted, so the target is
    // `unknown`, never `missing` (:494).
    const unknown = garbageDecisions({ ...ctx, agents: [], schedules: [baseSchedule()] })[0]!;
    expect(unknown.refusedBy).toBe("schedule-target-state: target agent is unknown");

    // A record the scan could not parse mentions the id: `unreadable` is not a
    // proof either, even with a trusted index (:491-494).
    const unreadable = oneSchedule(baseSchedule({ targetAgent: "a-raw" }), {
      rawRefs: new Set(["a-raw"]),
    });
    expect(unreadable.refusedBy).toBe("schedule-target-state: target agent is unreadable");

    // A trusted index with no record for the target: `missing`, which is garbage.
    const missing = oneSchedule(baseSchedule({ targetAgent: "a-gone" }));
    expect(missing.refusedBy).toBeNull();
    expect(missing.reason).toContain("target agent missing");
  });

  it("refuses a completed schedule without the room marker", () => {
    const row = oneSchedule(baseSchedule({ room: false }));
    expect(row.refusedBy).toBe(
      "schedule-room: no room marker (name supervisor: / heartbeat prompt)",
    );
    // The heartbeat half of the marker is the same flag: `agents.ts` derives it.
    const heartbeat = oneSchedule(baseSchedule({ name: null, room: true }));
    expect(heartbeat.refusedBy).toBeNull();
  });

  it("refuses a completed schedule updated less than an hour ago", () => {
    expect(oneSchedule(baseSchedule({ updatedEpoch: NOW - 100 })).refusedBy).toBe(
      "schedule-updated: updated < 1 h ago",
    );
    expect(
      oneSchedule(baseSchedule({ updatedAt: "not a time", updatedEpoch: null })).refusedBy,
    ).toBe("schedule-updated: updatedAt invalid");
    // One hour exactly is "not < 1 h ago": the reference's comparison is strict.
    expect(oneSchedule(baseSchedule({ updatedEpoch: NOW - 3600 })).refusedBy).toBeNull();
  });

  it("refuses a completed schedule whose last run was under ten minutes ago", () => {
    expect(oneSchedule(baseSchedule({ lastRunEpoch: NOW - 100 })).refusedBy).toBe(
      "schedule-last-run-recent: last run < 10 min ago",
    );
    expect(
      oneSchedule(baseSchedule({ lastRunAt: "nope", lastRunEpoch: null })).refusedBy,
    ).toBe("schedule-last-run-invalid: lastRunAt invalid");
    // Exactly ten minutes is quiet enough, and a never-run schedule has no arm.
    expect(oneSchedule(baseSchedule({ lastRunEpoch: NOW - 600 })).refusedBy).toBeNull();
    expect(
      oneSchedule(baseSchedule({ lastRunAt: null, lastRunEpoch: null })).refusedBy,
    ).toBeNull();
  });

  it("refuses a completed schedule with a run still marked running", () => {
    const row = oneSchedule(baseSchedule({ runsRunning: 1 }));
    expect(row.refusedBy).toBe("schedule-running: a run is still marked running");
  });

  it("refuses a non-completed schedule and reports the anomaly", () => {
    // A live target protects its schedule whatever its status (:544).
    const live = baseAgent({ archivedAt: null, archivedEpoch: null, status: "idle" });
    const rows = garbageDecisions({
      ...ctx,
      agents: [live],
      schedules: [baseSchedule({ status: "active" }), baseSchedule({ id: "ffffffff", status: "paused" })],
    });
    expect(rows[0]!.refusedBy).toBe("schedule-target-live: protected: target agent is live/unarchived");
    expect(rows[1]!.refusedBy).toBe("schedule-target-live: protected: target agent is live/unarchived");

    // Anything else falls through to the status/target sentence (:547).
    const paused = oneSchedule(baseSchedule({ status: "paused", targetAgent: "a-gone" }));
    expect(paused.refusedBy).toBe("schedule-status: not garbage: status paused, target missing");

    // An active schedule whose target is gone is the reference's report-only
    // anomaly: the daemon is the one that completes it (:545-546).
    const anomaly = oneSchedule(baseSchedule({ status: "active" }));
    expect(anomaly.refusedBy).toBe(
      "schedule-anomaly: anomaly (report-only): active schedule with archived target; the daemon normally completes it",
    );
    expect(anomaly.action).toBeNull();
  });

  it("refuses every schedule when the index is incomplete, naming the rule", () => {
    const row = oneSchedule(baseSchedule(), { indexOk: false, indexWhy: ["symlink: /h/x.json"] });
    expect(row.refusedBy).toBe("index-incomplete: index incomplete: symlink: /h/x.json");
  });

  it("refuses everything when the index verdict is not stated at all", () => {
    // Fail closed: an unstated index is an unproven index, and the reason
    // sentence has to stay readable when a caller recorded none.
    const rows = garbageDecisions({ now: NOW, minDays: 14, agents: [baseAgent()], schedules: [baseSchedule()] });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.refusedBy).toBe("index-incomplete: index incomplete: (no reason recorded)");
    }
  });
});

// ---------------------------------------------------------------------------
// The `path` / `sig` crumbs (the carried-forward T4 gap)
// ---------------------------------------------------------------------------

describe("garbageDecisions — path and sig", () => {
  it("re-derives the path from the id and leaves the workspace segment unknown", () => {
    const agent = oneAgent(baseAgent());
    // The agent scan keeps one workspace directory, which the record snapshot
    // does not keep: the locator says so with a literal `*` rather than guess.
    expect(agent.path).toBe("agents/*/a-old.json");
    expect(oneAgent(baseAgent(), { paseoHome: "/h/.paseo" }).path).toBe(
      "/h/.paseo/agents/*/a-old.json",
    );
    // The schedule scan is flat, so the id *is* the path.
    expect(oneSchedule(baseSchedule()).path).toBe("schedules/abcd1234.json");
    expect(oneSchedule(baseSchedule(), { paseoHome: "/h/.paseo/" }).path).toBe(
      "/h/.paseo/schedules/abcd1234.json",
    );
    // No stat has happened, and the port does not invent one.
    expect(agent.sig).toBe("");
  });

  it("keeps a supplied path and sig verbatim", () => {
    const rec = baseAgent({ path: "/h/.paseo/agents/ws-1/a-old.json", sig: "1:2:3" });
    const row = oneAgent(rec);
    expect(row.path).toBe("/h/.paseo/agents/ws-1/a-old.json");
    expect(row.sig).toBe("1:2:3");
    expect(row.refusedBy).toBeNull();
  });

  it("refuses a record file whose basename is not the agent id", () => {
    // The only half of the reference's basename gate this module can evaluate,
    // and it does evaluate it whenever the caller still has the name.
    const row = oneAgent(baseAgent({ path: "/h/.paseo/agents/ws/not-a-old.json" }));
    expect(row.refusedBy).toBe("agent-file-name: skipped: file name uuid != record id");
    expect(oneAgent(baseAgent({ path: "/h/.paseo/agents/ws/a-old.JSON" })).refusedBy).toContain(
      "agent-file-name",
    );
  });
});

// ---------------------------------------------------------------------------
// Shape of the whole answer
// ---------------------------------------------------------------------------

describe("garbageDecisions — the result set", () => {
  it("returns one candidate per record, schedules first, in index order", () => {
    const rows = garbageDecisions({
      ...ctx,
      agents: [baseAgent(), baseAgent({ id: "a-two" })],
      // Neither schedule targets an agent in the index, so no agent is held by a
      // target claim and both agents stay eligible; the paused schedule refuses
      // itself (status/target sentence), the completed one is garbage.
      schedules: [
        baseSchedule(),
        baseSchedule({ id: "ffffffff", status: "paused", targetAgent: "a-gone" }),
      ],
    });
    expect(rows.map((row) => `${row.kind}:${row.id}`)).toEqual([
      "schedule:abcd1234",
      "schedule:ffffffff",
      "agent:a-old",
      "agent:a-two",
    ]);
    // Every row is judged, none dropped: a dropped row would be indistinguishable
    // from an eligible one to a caller that filters on `refusedBy`.
    expect(rows.filter((row) => row.refusedBy === null).map((row) => row.id)).toEqual([
      "abcd1234",
      "a-old",
      "a-two",
    ]);
  });

  it("never returns an eligible row for a record the rules refuse", () => {
    // The cross product the safety property reduces to: an archived, closed,
    // strict, non-internal record is the only shape that can be an agent
    // candidate, and a completed, strict, room-marked, quiet, completed-target
    // schedule the only shape that can be a schedule candidate.
    const agents = [
      baseAgent(),
      baseAgent({ id: "a-live", archivedAt: null, archivedEpoch: null }),
      baseAgent({ id: "a-internal", internal: true }),
      baseAgent({ id: "a-open", status: "running" }),
      baseAgent({ id: "a-fresh", archivedAt: iso(NOW - 60), archivedEpoch: NOW - 60 }),
    ];
    for (const blind of [false, true]) {
      for (const indexOk of [true, false]) {
        for (const identification of [null, { ok: true, why: "ok" }, { ok: false, why: "no" }]) {
          const rows = garbageDecisions({
            ...ctx,
            indexOk,
            identification,
            envBlind: blind ? 1 : 0,
            agents,
            schedules: [],
          });
          for (const row of rows) {
            const eligible = indexOk && identification?.ok !== false && row.id === "a-old";
            expect(row.refusedBy === null).toBe(eligible);
          }
        }
      }
    }
  });
});

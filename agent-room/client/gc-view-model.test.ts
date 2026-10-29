import { describe, expect, it } from "vitest";

import type { GcStatus } from "../shared/gc";
import { actionRows, mbText, ruleConfirm, ruleValue, toGcRows } from "./gc-view-model";

const SETTINGS: GcStatus["settings"] = {
  apply: false,
  killStale: false,
  killMemory: false,
  memWarnMb: 3072,
  memKillMb: 4096,
};

/** A status the shape `gc.status` answers, with only the interesting parts varied. */
function status(over: Partial<GcStatus> = {}): GcStatus {
  return {
    ident: { ok: true, why: "ok" },
    lastTickAt: "2027-01-15T08:00:00Z",
    nextReportAt: null,
    settings: { ...SETTINGS },
    procs: [],
    candidates: [],
    ...over,
  };
}

function row(rows: ReturnType<typeof toGcRows>, label: string) {
  return rows.status.find((candidate) => candidate.label === label);
}

describe("toGcRows", () => {
  it("marks a non-eligible candidate with its refusal", () => {
    const rows = toGcRows({
      ident: { ok: true, why: "ok" },
      lastTickAt: "2027-01-15T08:00:00Z",
      nextReportAt: null,
      settings: { apply: false, killStale: false, killMemory: false, memWarnMb: 3072, memKillMb: 4096 },
      procs: [],
      candidates: [{ kind: "agent", id: "a1", refusedBy: "archived 3d < 14d" }],
    } as never);
    expect(rows.candidates[0]).toMatchObject({
      label: "agent a1",
      refusal: "archived 3d < 14d",
      actionable: false,
    });
  });

  it("reports identification failure in the status rows", () => {
    const rows = toGcRows({
      ident: { ok: false, why: "paseo.pid missing" },
      lastTickAt: null,
      nextReportAt: null,
      settings: { apply: false, killStale: false, killMemory: false, memWarnMb: 3072, memKillMb: 4096 },
      procs: [],
      candidates: [],
    } as never);
    expect(rows.status.find((candidate) => candidate.label === "identification")?.value).toContain(
      "paseo.pid missing",
    );
  });

  it("treats an eligible candidate as actionable, with no refusal text", () => {
    const rows = toGcRows(
      status({ candidates: [{ kind: "schedule", id: "deadbeef", rule: "schedule-completed", refusedBy: null }] }),
    );
    expect(rows.candidates[0]).toMatchObject({
      label: "schedule deadbeef",
      rule: "schedule-completed",
      refusal: "",
      actionable: true,
    });
  });

  it("keeps a refused candidate non-actionable even when a rule names it", () => {
    const rows = toGcRows(
      status({
        candidates: [{ kind: "agent", id: "b2", rule: "agent-archived", refusedBy: "agent-archived: archived 3 d ago (< 14 d)" }],
        settings: { ...SETTINGS, apply: true },
      }),
    );
    expect(rows.candidates[0].actionable).toBe(false);
    expect(rows.candidates[0].refusal).toContain("< 14 d");
    // Nothing reclaimable, so the summary cannot promise a deletion.
    expect(row(rows, "candidates")?.value).toContain("0 reclaimable");
  });

  it("orders actionable candidates before refused ones, keeping the payload order inside each group", () => {
    const rows = toGcRows(
      status({
        candidates: [
          { kind: "agent", id: "refused-1", rule: "agent-not-archived", refusedBy: "agent-not-archived: unarchived" },
          { kind: "agent", id: "live-1", rule: "agent-archived", refusedBy: null },
          { kind: "agent", id: "refused-2", rule: "agent-internal", refusedBy: "agent-internal: internal record" },
          { kind: "schedule", id: "live-2", rule: "schedule-completed", refusedBy: null },
        ],
      }),
    );
    expect(rows.candidates.map((candidate) => candidate.id)).toEqual([
      "live-1",
      "live-2",
      "refused-1",
      "refused-2",
    ]);
  });

  it("survives an empty status and says no tick has run instead of inventing one", () => {
    const rows = toGcRows(
      status({ ident: { ok: false, why: "no tick has run yet" }, lastTickAt: null, nextReportAt: null }),
    );
    expect(rows.procs).toEqual([]);
    expect(rows.candidates).toEqual([]);
    expect(row(rows, "identification")?.value).toContain("no tick has run yet");
    expect(row(rows, "last tick")?.value).toBe("no tick has run yet");
    expect(row(rows, "daemon")?.value).toContain("no daemon row");
    // An unread index is not reported as ok.
    expect(row(rows, "index")?.value).not.toContain("ok");
  });

  it("formats MB values and the footprint against both thresholds", () => {
    expect(mbText(3072)).toBe("3072 MB");
    expect(mbText(1609.44)).toBe("1609.4 MB");

    const underThreshold = toGcRows(
      status({ procs: [{ pid: 1320, class: "daemon", owner: null, footprintMb: 1609.44, warn: false }] }),
    );
    expect(row(underThreshold, "daemon")?.value).toBe("pid 1320 · 1609.4 MB");
    expect(row(underThreshold, "footprint vs warn/kill")).toMatchObject({
      value: "1609.4 MB · below warn 3072 MB · kill 4096 MB",
      tone: "normal",
    });

    const overWarn = toGcRows(
      status({ procs: [{ pid: 1320, class: "daemon", owner: null, footprintMb: 3200, warn: true }] }),
    );
    expect(row(overWarn, "footprint vs warn/kill")).toMatchObject({
      value: "3200 MB · over warn 3072 MB · kill 4096 MB",
      tone: "warning",
    });

    const overKill = toGcRows(
      status({ procs: [{ pid: 1320, class: "daemon", owner: null, footprintMb: 5000, warn: true }] }),
    );
    expect(row(overKill, "footprint vs warn/kill")).toMatchObject({
      value: "5000 MB · over kill 4096 MB",
      tone: "danger",
    });
  });

  it("takes each process row's warn flag from the tick, never from a threshold it computes itself", () => {
    const rows = toGcRows(
      status({
        procs: [
          { pid: 11, class: "agent-descendant", owner: "pid:3164", footprintMb: 5000, warn: false },
          { pid: 12, class: "supervisor", owner: null, footprintMb: 100, warn: true },
        ],
      }),
    );
    // The tick judged 5000 MB not worth warning about; the screen must not overrule it.
    expect(rows.procs[0]).toMatchObject({
      pid: 11,
      klass: "agent-descendant",
      owner: "pid:3164",
      footprint: "5000 MB",
      warn: false,
      warnText: "",
    });
    expect(rows.procs[1]).toMatchObject({ warn: true, warnText: "over warn (3072 MB)" });
    expect(row(rows, "processes over warn")?.value).toBe("1 of 2 process rows at or above 3072 MB");
  });

  it("shows an index refusal from the candidates that carry it", () => {
    const rows = toGcRows(
      status({
        candidates: [
          { kind: "agent", id: "a1", rule: "agent-archived", refusedBy: "index-incomplete: agents/ unreadable" },
        ],
      }),
    );
    expect(row(rows, "index")).toMatchObject({ value: "refused: agents/ unreadable", tone: "danger" });
  });

  it("does not publish what gc.status does not carry", () => {
    const rows = toGcRows(status());
    expect(row(rows, "daemon uptime")?.value).toBe("not published by gc.status");
    expect(row(rows, "ledger")?.value).toBe("not published by gc.status");
  });
});

describe("ruleValue", () => {
  it("prefers a saved override over what the last tick acted on", () => {
    expect(ruleValue({ killStale: false }, status({ settings: { ...SETTINGS, killStale: true } }), "killStale")).toBe(
      false,
    );
    expect(ruleValue({ killMemory: true }, status(), "killMemory")).toBe(true);
  });

  it("falls back to the tick's own setting when the document says nothing", () => {
    expect(ruleValue({}, status({ settings: { ...SETTINGS, apply: true } }), "apply")).toBe(true);
    expect(ruleValue(null, status(), "killStale")).toBe(false);
  });
});

describe("ruleConfirm", () => {
  it("names exactly what will be signalled when a rule is turned on", () => {
    const stale = ruleConfirm("killStale", true, 4096);
    expect(stale.body).toContain("SIGTERM");
    expect(stale.body).toContain("orphan");
    expect(stale.body).toContain("never signalled");
    expect(stale.title.toLowerCase()).toContain("on");

    // The memory rule quotes the threshold it will actually compare against.
    const memory = ruleConfirm("killMemory", true, 2048);
    expect(memory.body).toContain("SIGTERM");
    expect(memory.body).toContain("2048 MB");

    // Record reclamation deletes; it does not signal, and the text says so.
    const apply = ruleConfirm("apply", true, 4096);
    expect(apply.body).toContain("delete");
    expect(apply.body).not.toContain("SIGTERM");
  });

  it("names the settings key instead of inventing a threshold when no status has answered", () => {
    const memory = ruleConfirm("killMemory", true, null);
    expect(memory.body).toContain("memKillMb");
    expect(memory.body).not.toContain("4096");
  });

  it("names the consequence of turning a rule off, so cancelling is a real choice", () => {
    for (const key of ["apply", "killStale", "killMemory"] as const) {
      const confirm = ruleConfirm(key, false, 4096);
      expect(confirm.body.length).toBeGreaterThan(20);
      expect(confirm.confirm.toLowerCase()).toContain("off");
      expect(confirm.title.toLowerCase()).toContain("off");
    }
    expect(ruleConfirm("apply", false, 4096).body.toLowerCase()).toContain("no record");
  });
});

describe("actionRows", () => {
  it("shows a refusal as a refusal rather than as an action", () => {
    const rows = actionRows([
      { kind: "refuse", id: "-", acted: false, reason: "another tick is running", refusedBy: "tick-in-progress: running" },
      { kind: "agent", id: "a1", acted: true, reason: "agent delete ok: a1", refusedBy: null },
    ]);
    expect(rows[0].detail).toContain("another tick is running");
    expect(rows[0].tone).toBe("warning");
    expect(rows[1].detail).toContain("agent delete ok");
    expect(rows[1].tone).toBe("normal");
  });

  it("returns no rows for an empty run", () => {
    expect(actionRows([])).toEqual([]);
  });
});

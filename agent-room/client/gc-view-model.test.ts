import { describe, expect, it } from "vitest";

import type { GcSettingsDocument, GcStatus } from "../shared/gc";
import {
  actionRows,
  mbText,
  ruleConfirm,
  ruleValue,
  settingsNotice,
  thresholdDraft,
  toGcRows,
  uptimeText,
  validateThresholds,
} from "./gc-view-model";

const SETTINGS: GcStatus["settings"] = {
  apply: false,
  killStale: false,
  killMemory: false,
  memWarnMb: 3072,
  memKillMb: 4096,
};

/** A tree footprint, as the tick published it. */
const TREE: NonNullable<GcStatus["tree"]> = {
  totalMb: 2814.2,
  appMb: 2600,
  orphanMb: 214.2,
  warnMb: 6144,
  over: false,
};

/** A status the shape `gc.status` answers, with only the interesting parts varied. */
function status(over: Partial<GcStatus> = {}): GcStatus {
  return {
    ident: { ok: true, why: "ok" },
    lastTickAt: "2027-01-15T08:00:00Z",
    nextReportAt: null,
    daemonPid: null,
    uptimeS: null,
    treeWarnMb: 6144,
    tree: { ...TREE },
    ledger: { note: null, rows: 0, readable: true },
    index: { ok: true, why: [] },
    lastReportAt: null,
    alerts: [],
    alertsReadable: true,
    settings: { ...SETTINGS },
    procs: [],
    candidates: [],
    ...over,
  };
}

/** A fresh install: `emptyStatus()`, field for field. */
function freshStatus(over: Partial<GcStatus> = {}): GcStatus {
  return status({
    ident: { ok: false, why: "no tick has run yet" },
    lastTickAt: null,
    nextReportAt: null,
    daemonPid: null,
    uptimeS: null,
    treeWarnMb: null,
    tree: null,
    ledger: { note: null, rows: 0, readable: true },
    index: { ok: false, why: ["no tick has run yet"] },
    lastReportAt: null,
    alerts: [],
    alertsReadable: true,
    ...over,
  });
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
      daemonPid: null,
      uptimeS: null,
      treeWarnMb: null,
      tree: null,
      ledger: { note: null, rows: 0, readable: true },
      index: { ok: true, why: [] },
      lastReportAt: null,
      alerts: [],
      alertsReadable: true,
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
      daemonPid: null,
      uptimeS: null,
      treeWarnMb: null,
      tree: null,
      ledger: { note: null, rows: 0, readable: true },
      index: { ok: false, why: ["no tick has run yet"] },
      lastReportAt: null,
      alerts: [],
      alertsReadable: true,
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
    const rows = toGcRows(freshStatus());
    expect(rows.procs).toEqual([]);
    expect(rows.candidates).toEqual([]);
    expect(rows.alerts).toEqual([]);
    expect(row(rows, "identification")?.value).toContain("no tick has run yet");
    expect(row(rows, "last tick")?.value).toBe("no tick has run yet");
    expect(row(rows, "daemon")?.value).toContain("no daemon row");
    // The index is the tick's verdict, and "no tick has run" is not "ok".
    expect(row(rows, "index")?.value).toBe("no tick has run yet");
    expect(row(rows, "index")?.value).not.toContain("ok");
    expect(row(rows, "index")?.tone).toBe("muted");
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

  it("shows the daemon pid identification named and the uptime the tick read for it", () => {
    const rows = toGcRows(
      status({
        daemonPid: 1320,
        uptimeS: 3 * 86400 + 4 * 3600 + 5 * 60 + 6,
        procs: [{ pid: 1320, class: "daemon", owner: null, footprintMb: 1609.44, warn: false }],
      }),
    );
    expect(row(rows, "daemon")?.value).toBe("pid 1320 · 1609.4 MB");
    expect(row(rows, "daemon uptime")).toMatchObject({ value: "3 d 04:05:06", tone: "normal" });
  });

  it("prefers the identified pid over a row that merely classified as daemon", () => {
    const rows = toGcRows(
      status({
        daemonPid: 200,
        procs: [
          { pid: 190, class: "daemon", owner: null, footprintMb: 10, warn: false },
          { pid: 200, class: "daemon", owner: null, footprintMb: 900, warn: false },
        ],
      }),
    );
    expect(row(rows, "daemon")?.value).toBe("pid 200 · 900 MB");
  });

  it("says no data yet for the uptime, the report and the history of a fresh install", () => {
    const rows = toGcRows(freshStatus());
    expect(row(rows, "daemon uptime")?.value).toContain("no data yet");
    expect(row(rows, "daemon uptime")?.tone).toBe("muted");
    expect(row(rows, "last report")?.value).toBe("no report has been written yet");
    expect(row(rows, "ledger")).toMatchObject({ value: "no ledger rows yet", tone: "muted" });
  });

  it("formats the uptime and refuses to invent one from a negative etime", () => {
    expect(uptimeText(null)).toBe("no data yet");
    expect(uptimeText(-1)).toBe("no data yet");
    expect(uptimeText(0)).toBe("00:00");
    expect(uptimeText(65)).toBe("01:05");
    expect(uptimeText(3725)).toBe("01:02:05");
    expect(uptimeText(90061)).toBe("1 d 01:01:01");
  });

  it("shows the ledger's row count and the reader's own note", () => {
    const rows = toGcRows(status({ ledger: { note: null, rows: 12, readable: true } }));
    expect(row(rows, "ledger")).toMatchObject({ value: "12 rows", tone: "normal" });

    const complained = toGcRows(
      status({ ledger: { note: "lineage.tsv unreadable (mode 0644)", rows: 4, readable: true } }),
    );
    expect(row(complained, "ledger")).toMatchObject({
      value: "4 rows · lineage.tsv unreadable (mode 0644)",
      tone: "warning",
    });
  });

  it("says an unreadable ledger could not be read instead of calling it empty", () => {
    // The reader refused the file and said why.
    const refused = toGcRows(
      status({ ledger: { note: "lineage.tsv is not a regular file (symlink or directory): ignored", rows: 0, readable: false } }),
    );
    expect(row(refused, "ledger")?.value).toContain("could not be read");
    expect(row(refused, "ledger")?.value).not.toContain("no ledger rows yet");
    expect(row(refused, "ledger")?.value).toContain("not a regular file");
    expect(row(refused, "ledger")?.tone).toBe("warning");

    // Nothing was read at all (a failed process phase) and nothing explains it.
    const failed = toGcRows(status({ ledger: { note: null, rows: 0, readable: false } }));
    expect(row(failed, "ledger")?.value).toContain("could not be read");
    expect(row(failed, "ledger")?.value).toContain("process phase failed");
    expect(row(failed, "ledger")?.tone).toBe("danger");

    // Only a readable ledger with no rows is allowed to read as empty.
    const empty = toGcRows(status({ ledger: { note: null, rows: 0, readable: true } }));
    expect(row(empty, "ledger")).toMatchObject({ value: "no ledger rows yet", tone: "muted" });
  });

  it("draws the Paseo tree as its own row, against the resolved warn threshold and the kill threshold", () => {
    const below = toGcRows(status());
    expect(row(below, "Paseo tree")).toMatchObject({
      value: "2814.2 MB · app 2600 MB · orphan 214.2 MB · below warn 6144 MB · kill 4096 MB",
      tone: "normal",
    });
    // The label, not the value, is what keeps this apart from the daemon's row.
    expect(row(below, "Paseo tree")?.label).toBe("Paseo tree");
    expect(row(below, "footprint vs warn/kill")?.label).not.toContain("tree");

    // `over` is the tick's verdict, at the resolved warn value it published. The
    // kill threshold is above the tree warn here, which is the state where "over
    // warn, below kill" can exist at all.
    const over = toGcRows(
      status({
        tree: { ...TREE, totalMb: 7000, over: true },
        settings: { ...SETTINGS, memKillMb: 8192 },
      }),
    );
    expect(row(over, "Paseo tree")).toMatchObject({
      value: "7000 MB · app 2600 MB · orphan 214.2 MB · over warn 6144 MB · kill 8192 MB",
      tone: "warning",
    });

    // Above the memory kill threshold the row is a danger, not a warning.
    const kill = toGcRows(status({ tree: { ...TREE, totalMb: 5000, over: true }, settings: { ...SETTINGS, memKillMb: 4096 } }));
    expect(row(kill, "Paseo tree")).toMatchObject({
      value: "5000 MB · app 2600 MB · orphan 214.2 MB · over kill 4096 MB",
      tone: "danger",
    });
  });

  it("says no data yet for the tree before any tick has measured it", () => {
    const rows = toGcRows(freshStatus());
    expect(row(rows, "Paseo tree")).toMatchObject({
      value: "no data yet — no tick has read the tree footprint",
      tone: "muted",
    });
  });

  it("carries whether the alert tail could be read, so empty and unreadable are not the same answer", () => {
    expect(toGcRows(status()).alertsReadable).toBe(true);
    expect(toGcRows(status({ alertsReadable: false })).alertsReadable).toBe(false);
    expect(toGcRows(freshStatus()).alertsReadable).toBe(true);
  });

  it("reads the index verdict from the tick, not from the candidates' refusal strings", () => {
    const refused = toGcRows(
      status({ index: { ok: false, why: ["agents/ unreadable", "schedules/ unreadable"] } }),
    );
    expect(row(refused, "index")).toMatchObject({
      value: "refused: agents/ unreadable; schedules/ unreadable",
      tone: "danger",
    });

    // A candidate refused by an index-incomplete rule does not decide the
    // verdict: the tick's own index answer does.
    const ticked = toGcRows(
      status({
        index: { ok: true, why: [] },
        candidates: [
          { kind: "agent", id: "a1", rule: "agent-archived", refusedBy: "index-incomplete: agents/ unreadable" },
        ],
      }),
    );
    expect(row(ticked, "index")).toMatchObject({ value: "ok — both record scans completed", tone: "normal" });
    expect(row(ticked, "index")?.tone).not.toBe("danger");
  });

  it("shows the last report's clock when the tick published one", () => {
    const rows = toGcRows(status({ lastReportAt: "2027-01-15T08:05:00Z" }));
    expect(row(rows, "last report")?.value).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(row(rows, "last report")?.tone).toBe("normal");
  });

  it("draws the alert tail as history, newest first, with a date and a stamp per line", () => {
    const rows = toGcRows(
      status({
        alerts: [
          { at: "2027-01-15T09:00:00Z", text: "ALERT 1 agent descendant(s) > 1024 MB: pid 500 node" },
          { at: "", text: "a line this port could not stamp" },
        ],
      }),
    );
    expect(rows.alerts).toHaveLength(2);
    expect(rows.alerts[0]?.text).toContain("ALERT");
    expect(rows.alerts[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(rows.alerts[1]).toMatchObject({ at: "no stamp", text: "a line this port could not stamp" });
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

describe("thresholdDraft", () => {
  it("lets the saved document win and the last tick supply the rest", () => {
    const document: GcSettingsDocument = { memKillMb: 6144, treeWarnMb: 8192 };
    expect(thresholdDraft(status(), document)).toEqual({
      memWarnMb: "3072",
      memKillMb: "6144",
      treeWarnMb: "8192",
    });
  });

  it("follows the acted settings before any document override exists", () => {
    expect(thresholdDraft(status({ treeWarnMb: null }), {})).toEqual({
      memWarnMb: "3072",
      memKillMb: "4096",
      treeWarnMb: "",
    });
  });

  it("leaves the fields blank before a status has answered, rather than inventing defaults", () => {
    expect(thresholdDraft(null, null)).toEqual({ memWarnMb: "", memKillMb: "", treeWarnMb: "" });
  });
});

describe("settingsNotice", () => {
  it("shows the store's own error and says nothing can be edited until it loads", () => {
    const notice = settingsNotice({ status: "error", error: "settings store unreachable" });
    expect(notice?.tone).toBe("danger");
    expect(notice?.text).toContain("settings store unreachable");
    expect(notice?.text).toContain("cannot be edited");
    expect(notice?.text).toContain("until the settings load");
  });

  it("says an invalid document is not what is shown, and that saving replaces it", () => {
    const notice = settingsNotice({ status: "invalid", error: "memWarnMb: expected number" });
    expect(notice?.tone).toBe("warning");
    expect(notice?.text).toContain("do not match the schema");
    // Where the shown values come from, and what a save does to the broken document.
    expect(notice?.text).toContain("slp-gc.conf baseline");
    expect(notice?.text).toContain("replaces the saved document");
    expect(notice?.text).toContain("is lost");
  });

  it("says nothing while the document is ready or still loading", () => {
    expect(settingsNotice({ status: "ready" })).toBeNull();
    expect(settingsNotice({ status: "loading" })).toBeNull();
  });
});

describe("validateThresholds", () => {
  it("accepts the reference's own shape and returns numbers", () => {
    expect(validateThresholds({ memWarnMb: "3072", memKillMb: "4096", treeWarnMb: "6144" })).toEqual({
      ok: true,
      values: { memWarnMb: 3072, memKillMb: 4096, treeWarnMb: 6144 },
    });
  });

  it("reads a blank tree threshold as the reference's null (half of RAM)", () => {
    expect(validateThresholds({ memWarnMb: "3072", memKillMb: "4096", treeWarnMb: "" })).toEqual({
      ok: true,
      values: { memWarnMb: 3072, memKillMb: 4096, treeWarnMb: null },
    });
  });

  it("refuses a kill threshold below 1024 MB and nothing is saved", () => {
    const checked = validateThresholds({ memWarnMb: "512", memKillMb: "900", treeWarnMb: "" });
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.error).toContain("1024 MB");
  });

  it("refuses a kill threshold below the warn threshold", () => {
    const checked = validateThresholds({ memWarnMb: "3072", memKillMb: "2048", treeWarnMb: "" });
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.error).toContain("at least the warn threshold (3072 MB, got 2048 MB)");
  });

  it("refuses anything that is not a whole number of megabytes", () => {
    expect(validateThresholds({ memWarnMb: "", memKillMb: "4096", treeWarnMb: "" }).ok).toBe(false);
    expect(validateThresholds({ memWarnMb: "3.5", memKillMb: "4096", treeWarnMb: "" }).ok).toBe(false);
    expect(validateThresholds({ memWarnMb: "0", memKillMb: "4096", treeWarnMb: "" }).ok).toBe(false);
    expect(validateThresholds({ memWarnMb: "3072", memKillMb: "4096", treeWarnMb: "0" }).ok).toBe(false);
    expect(validateThresholds({ memWarnMb: "3072", memKillMb: "4096", treeWarnMb: "lots" }).ok).toBe(false);
  });
});

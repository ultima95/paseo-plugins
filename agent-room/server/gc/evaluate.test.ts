// The per-process rules of the GC port: protection/ownership/footprint in the
// table builder, then the staleness and over-memory decisions that read it.
//
// Every case is inline data — a hand-built process table, environment map and
// agent index. Nothing here reads the live process table, shells out to `ps`,
// `top` or `lsof`, runs a reference subcommand, or talks to the daemon or an
// agent. The semantics authority is `docs/gc-port/slp-gc.bash`; the line numbers
// in each comment are its.
import { describe, expect, it } from "vitest";

import type { AgentRec } from "./agents";
import type { DecisionEntry, DecisionContext, ProcTableInput } from "./evaluate";
import { buildProcTable, overmemDecision, staleDecision } from "./evaluate";
import type { ProcRow } from "./procs";

// ---------------------------------------------------------------------------
// The brief's cases. `baseEntry` and `ctx` are the brief's, verbatim; the two
// adjustments are marked and explained where they appear.
// ---------------------------------------------------------------------------

const idOk = { ok: true, why: "ok", daemonPid: 200, appPid: 100, supervisorPid: 150 };
const baseEntry = {
  pid: 300, ppid: 1, class: "claude-child" as const, owner: "owner-1", ownerState: "archived" as const,
  envRead: true, home: "match" as const, etime_s: 3600, footprint_mb: 100, exe: "node",
  protected: null, underDaemon: false, cmd: "claude --output-format stream-json",
};
const ctx = { identity: idOk, killMb: 4096, killComms: ["node"], warnMb: 3072, famPids: [300], invoker: null, invTree: [] };

describe("staleDecision", () => {
  it("signals an aged ppid-1 agent child whose owner is archived", () => {
    expect(staleDecision(baseEntry, ctx).eligible).toBe(true);
  });
  it("refuses when the env is unreadable", () => {
    expect(staleDecision({ ...baseEntry, home: "unreadable" }, ctx)).toMatchObject({ eligible: false });
  });
  it("refuses when identification failed", () => {
    expect(staleDecision(baseEntry, { ...ctx, identity: { ...idOk, ok: false, why: "x" } }).eligible).toBe(false);
  });
  it("refuses daemon-owned processes", () => {
    expect(staleDecision({ ...baseEntry, underDaemon: true }, ctx).why).toContain("daemon-owned");
  });
  it("refuses a live parent in the Paseo family", () => {
    expect(staleDecision({ ...baseEntry, ppid: 250 }, { ...ctx, famPids: [250] }).eligible).toBe(false);
  });
  it("refuses an owner that is neither archived nor missing", () => {
    // Adjusted from the brief: the reference's owner arm is guarded by
    // `$p.ppid != 1` (slp-gc.bash:356), so a ppid-1 row never reaches it. The
    // parent is an ordinary process here (and is not in the family), which is
    // the only shape in which "the owner is live" is a refusal at all.
    expect(staleDecision({ ...baseEntry, ppid: 250, ownerState: "live" }, ctx).eligible).toBe(false);
  });
  it("refuses below the minimum age", () => {
    expect(staleDecision({ ...baseEntry, etime_s: 60 }, ctx).why).toContain("< 600s");
  });
});

describe("overmemDecision", () => {
  const big = { ...baseEntry, class: "agent-descendant" as const, ppid: 200, footprint_mb: 9000, exe: "node", underDaemon: true };
  it("refuses the daemon, supervisor and app main", () => {
    for (const cls of ["daemon", "supervisor", "app-main"] as const) {
      expect(overmemDecision({ ...big, class: cls }, ctx).eligible).toBe(false);
    }
  });
  it("refuses an agent child even at 9 GB", () => {
    expect(overmemDecision({ ...big, class: "claude-child" }, ctx).why).toContain("never memory-killed");
  });
  it("refuses a comm outside the allowlist", () => {
    expect(overmemDecision({ ...big, exe: "somebinary" }, ctx).eligible).toBe(false);
  });
  it("refuses an executable inside an .app or /System", () => {
    expect(overmemDecision({ ...big, cmd: "/Applications/X.app/Contents/MacOS/X" }, ctx).eligible).toBe(false);
    expect(overmemDecision({ ...big, cmd: "/System/Library/x" }, ctx).eligible).toBe(false);
  });
  it("allows an allowlisted descendant of the daemon above the threshold", () => {
    expect(overmemDecision(big, ctx).eligible).toBe(true);
  });
  it("refuses at or below the threshold", () => {
    expect(overmemDecision({ ...big, footprint_mb: 4096 }, ctx).eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refusal order. Each case makes two or more arms true at once and asserts
// which one answered, so a reordered chain is a red test even though the
// verdict (`eligible: false`) would be unchanged.
// ---------------------------------------------------------------------------

describe("staleDecision — the reference's refusal order (slp-gc.bash:349-358)", () => {
  const cases: Array<[string, Partial<DecisionEntry>, DecisionContext, string]> = [
    // :349 before :350 — a class the rule never touches wins over protection.
    ["class before protection", { class: "renderer", protected: "in the GC's own process tree" }, ctx, "not an agent-child/wait class"],
    // :350 before :351 — protection outranks a failed identification.
    ["protection before identification", { protected: "belongs to the invoking agent" }, { ...ctx, identity: { ...idOk, ok: false, why: "x" } }, "protected: belongs to the invoking agent"],
    // :351 before :352 — a failed identification outranks an unproven home.
    ["identification before home", { home: "other" }, { ...ctx, identity: { ...idOk, ok: false, why: "no single daemon" } }, "identification failed: no single daemon"],
    // :352 before :353.
    ["home before daemon-owned", { home: "other", underDaemon: true }, ctx, 'PASEO_HOME in the process env is "other"'],
    // :353 before :354.
    ["daemon-owned before a live parent", { underDaemon: true, ppid: 250 }, { ...ctx, famPids: [250] }, "daemon-owned"],
    // :354 before :355.
    ["live parent before a missing owner", { ppid: 250, owner: null }, { ...ctx, famPids: [250] }, "parent pid 250 is a live Paseo process"],
    // :355 before :356.
    ["missing owner before a live owner state", { ppid: 250, owner: null, ownerState: "live" }, ctx, "no PASEO_AGENT_ID owner and ppid != 1"],
    // :356-357 before :358.
    ["owner state before the age", { ppid: 250, ownerState: "live", etime_s: 1 }, ctx, "not orphaned: ppid 250 and owner owner-1 is live"],
    // :358 last.
    ["the age is the last refusal", { etime_s: 1 }, ctx, "orphan signature but age 1s < 600s"],
  ];

  it.each(cases)("%s", (_name, over, context, why) => {
    const decision = staleDecision({ ...baseEntry, ...over }, context);
    expect(decision.eligible).toBe(false);
    expect(decision.why).toContain(why);
  });
});

describe("overmemDecision — the reference's refusal order (slp-gc.bash:361-373)", () => {
  const big = { ...baseEntry, class: "agent-descendant" as const, ppid: 200, footprint_mb: 9000, exe: "node", underDaemon: true };
  const cases: Array<[string, Partial<DecisionEntry>, DecisionContext, string]> = [
    // :361 before everything.
    ["the threshold before the class", { class: "daemon", footprint_mb: 4096 }, ctx, "MB <= 4096 MB"],
    // :362 before :363.
    ["app main/supervisor before daemon", { class: "supervisor" }, ctx, "never killed: report only"],
    // :363 before :364.
    ["daemon before agent child", { class: "daemon" }, ctx, "the daemon is never memory-killed"],
    // :364 before :365.
    ["agent child before the allowlist", { class: "codex-child", exe: "not-allowlisted" }, ctx, "an agent child itself is never memory-killed"],
    // :365 before :366.
    ["class before protection", { class: "slp-wait", protected: "in the GC's own process tree" }, ctx, "class not allowed for a memory kill"],
    ["a null class is not allowed", { class: null }, ctx, "class not allowed for a memory kill"],
    // :366 before :367.
    ["protection before identification", { protected: "in the invoking agent's process subtree" }, { ...ctx, identity: { ...idOk, ok: false, why: "x" } }, "protected: in the invoking agent's process subtree"],
    // :367 before :370 — identification failure outranks the daemon-descent arm.
    ["identification before daemon descent", { underDaemon: false }, { ...ctx, identity: { ...idOk, ok: false, why: "no daemon" } }, "identification failed: no daemon"],
    // :368-369 before :370.
    ["helper parent before daemon descent", { class: "renderer", ppid: 7 }, ctx, "helper is not a direct child of the app main (pid 100)"],
    // :370 before :371.
    ["daemon descent before the .app path", { underDaemon: false, cmd: "/Applications/X.app/Contents/MacOS/X" }, ctx, "not a descendant of the identified daemon (pid 200)"],
    // :371 before :372 — a path that is both.
    [".app before /System", { cmd: "/System/Applications/Foo.app/Contents/MacOS/Foo" }, ctx, "inside an .app bundle"],
    // :372 before :373.
    ["/System before the comm allowlist", { exe: "somebinary", cmd: "/Library/Daemons/x --flag" }, ctx, "under /System or /Library"],
    // :373 last.
    ["the comm allowlist before eligibility", { exe: "somebinary" }, ctx, 'comm "somebinary" is not in SLP_GC_KILL_COMMS'],
  ];

  it.each(cases)("%s", (_name, over, context, why) => {
    const decision = overmemDecision({ ...big, ...over }, context);
    expect(decision.eligible).toBe(false);
    expect(decision.why).toContain(why);
  });

  it("never reports a refusal that names a rule it did not run", () => {
    // The counterpart of the order above: every refusal must name its own rule,
    // so the operator can tell an unsafe process from a merely protected one.
    const why = overmemDecision({ ...big, exe: "somebinary" }, ctx).why;
    expect(why).not.toContain("protected");
    expect(why).not.toContain("identification");
  });
});

describe("staleDecision — minimum ages and the ppid-1 exception", () => {
  it("uses the reference's 130 s bar for the wait helpers and 600 s otherwise (slp-gc.bash:348)", () => {
    const wait = { ...baseEntry, class: "slp-wait" as const, owner: null, ownerState: null };
    expect(staleDecision({ ...wait, etime_s: 129 }, ctx).why).toContain("< 130s");
    expect(staleDecision({ ...wait, etime_s: 130 }, ctx).eligible).toBe(true);
    expect(staleDecision({ ...wait, class: "paseo-wait", etime_s: 130 }, ctx).eligible).toBe(true);
    expect(staleDecision({ ...wait, class: "codex-child", etime_s: 599 }, ctx).why).toContain("< 600s");
    expect(staleDecision({ ...wait, class: "codex-child", etime_s: 600 }, ctx).eligible).toBe(true);
  });

  it("takes the thresholds from the caller when they are supplied", () => {
    expect(staleDecision({ ...baseEntry, etime_s: 60 }, { ...ctx, minAgeAgentS: 30 }).eligible).toBe(true);
    expect(staleDecision({ ...baseEntry, class: "slp-wait", etime_s: 60 }, { ...ctx, minAgeWaitS: 90 }).why).toContain("< 90s");
  });

  it("signals a ppid-1 orphan even when its owner is still live", () => {
    // slp-gc.bash:354-357: all three owner arms are guarded by `ppid != 1`. The
    // brief's "owner is live" case therefore has to carry a real parent; this
    // test pins the reference's actual answer for the reparented shape so the
    // guard cannot be quietly dropped in either direction.
    const decision = staleDecision({ ...baseEntry, ownerState: "live" }, ctx);
    expect(decision.eligible).toBe(true);
    expect(decision.why).toBe(
      "orphan: reparented to launchd (ppid==1), PASEO_HOME matches, age 3600s >= 600s",
    );
  });

  it("names the non-launchd shape when the parent is an unrelated process", () => {
    const decision = staleDecision({ ...baseEntry, ppid: 250 }, ctx);
    expect(decision.eligible).toBe(true);
    expect(decision.why).toContain("parent is not a Paseo process and owner owner-1 is archived");
  });

  it("refuses an owner state it cannot classify", () => {
    expect(staleDecision({ ...baseEntry, ppid: 250, ownerState: "unknown" }, ctx).why).toContain(
      "owner owner-1 is unknown",
    );
    expect(staleDecision({ ...baseEntry, ppid: 250, ownerState: null }, ctx).why).toContain(
      "owner owner-1 is ?",
    );
  });

  it("refuses an unreadable age", () => {
    expect(staleDecision({ ...baseEntry, etime_s: -1 }, ctx).why).toContain("age -1s < 600s");
  });
});

describe("overmemDecision — the remaining arms", () => {
  const big = { ...baseEntry, class: "agent-descendant" as const, ppid: 200, footprint_mb: 9000, exe: "node", underDaemon: true };

  it("accepts a helper that is a direct child of the identified app main", () => {
    expect(overmemDecision({ ...big, class: "renderer", ppid: 100 }, ctx).eligible).toBe(true);
    expect(overmemDecision({ ...big, class: "gpu", ppid: 100 }, ctx).eligible).toBe(true);
    expect(overmemDecision({ ...big, class: "utility", ppid: 100 }, ctx).eligible).toBe(true);
  });

  it("does not apply the comm allowlist to the helper classes", () => {
    // slp-gc.bash:373 is guarded by `$p.class == "agent-descendant"`; a helper's
    // comm is `Paseo Helper`, which is never in the configurable list.
    expect(overmemDecision({ ...big, class: "renderer", ppid: 100, exe: "Paseo Helper" }, ctx).eligible).toBe(true);
  });

  it("does not apply the path guards to the helper classes either", () => {
    // :371-372 carry the same guard as :373. A helper the app main started is
    // part of Paseo, whatever its own bundle path says.
    expect(
      overmemDecision({ ...big, class: "renderer", ppid: 100, cmd: "/Applications/X.app/Contents/MacOS/X helper" }, ctx)
        .eligible,
    ).toBe(true);
    expect(
      overmemDecision({ ...big, class: "utility", ppid: 100, cmd: "/Library/Helpers/x --type=utility" }, ctx).eligible,
    ).toBe(true);
  });

  it("compares the allowlist verbatim, case included", () => {
    expect(overmemDecision({ ...big, exe: "Node" }, ctx).eligible).toBe(false);
    expect(overmemDecision({ ...big, exe: "node" }, { ...ctx, killComms: ["bun", "node"] }).eligible).toBe(true);
  });

  it("cuts the executable at the first ` -` before testing the path (slp-gc.bash:371)", () => {
    // `cmd.split(" -")[0]` — a flag carrying `.app/` later on the line does not
    // make the executable a bundle.
    expect(overmemDecision({ ...big, cmd: "/usr/local/bin/node build.js --out /tmp/X.app/y" }, ctx).eligible).toBe(true);
    expect(overmemDecision({ ...big, cmd: "/Library/x -a b" }, ctx).why).toContain("/System or /Library");
  });

  it("refuses just above the threshold only", () => {
    expect(overmemDecision({ ...big, footprint_mb: 4096.1 }, ctx).eligible).toBe(true);
    expect(overmemDecision({ ...big, footprint_mb: 4095.9 }, ctx).why).toContain("<= 4096 MB");
  });

  it("names the missing daemon pid in the descent refusal", () => {
    const unknown = { ...ctx, identity: { ...idOk, daemonPid: null } };
    expect(overmemDecision({ ...big, underDaemon: false }, unknown).why).toContain(
      "not a descendant of the identified daemon (pid null)",
    );
  });
});

// ---------------------------------------------------------------------------
// The table builder.
// ---------------------------------------------------------------------------

const LSTART = "Thu Oct 29 11:43:21 2026";

const APP = "/Applications/Paseo.app/Contents/MacOS/Paseo";
const SUP = "Paseo Supervisor";
const DAEMON = "Paseo Daemon";
const CLAUDE = "claude --output-format stream-json --input-format stream-json --permission-prompt-tool x";

/** One `ps` row with the reference's defaults. */
function psRow(over: Partial<ProcRow> & { pid: number }): ProcRow {
  return {
    ppid: 1,
    pgid: over.pid,
    etime_s: 600,
    rss_mb: 10,
    lstart: LSTART,
    cmd: "node /repo/build.mjs",
    ...over,
  };
}

/** One agent record, as `snapshotAgents` returns it (only the read fields matter here). */
function agent(id: string, archivedAt: string | null): AgentRec {
  return {
    id,
    provider: "claude",
    archivedAt,
    archivedEpoch: archivedAt === null ? null : 1_800_000_000,
    status: archivedAt === null ? "running" : "archived",
    cwd: null,
    internal: false,
    labels: {},
    parent: null,
    sessionId: null,
    strict: true,
  };
}

/** The fixed machine: app main 100, supervisor 150, daemon 200, agent child 400, its child 500. */
const MACHINE: ProcRow[] = [
  psRow({ pid: 100, ppid: 1, cmd: APP }),
  psRow({ pid: 150, ppid: 100, cmd: SUP }),
  psRow({ pid: 200, ppid: 150, cmd: DAEMON }),
  psRow({ pid: 400, ppid: 200, cmd: CLAUDE }),
  psRow({ pid: 500, ppid: 400, cmd: "node /repo/build.mjs" }),
];

/** The GC's own fact map, keyed by pid. */
function envOf(entries: Record<number, { agent?: string | null; home?: "match" | "other" | "none"; read?: boolean }>) {
  const map = new Map<number, { agent: string | null; home: "match" | "other" | "none"; read: boolean }>();
  for (const [pid, entry] of Object.entries(entries)) {
    map.set(Number(pid), {
      agent: entry.agent ?? null,
      home: entry.home ?? "match",
      read: entry.read ?? true,
    });
  }
  return map;
}

/** Sane defaults for everything a case does not care about. */
function tableInput(over: Partial<ProcTableInput> = {}): ProcTableInput {
  return {
    rows: MACHINE,
    top: new Map(),
    env: envOf({
      150: { home: "match" },
      400: { agent: "agent-1", home: "match" },
      500: { agent: "agent-1", home: "match" },
    }),
    agents: [agent("agent-1", "2026-10-01T00:00:00Z")],
    selfPid: 2000,
    invoker: null,
    warnMb: 3072,
    daemonPid: 200,
    ...over,
  };
}

describe("buildProcTable — what is in the table (slp-gc.bash:303)", () => {
  it("keeps Paseo classes and agent descendants, and drops unrelated rows", () => {
    const table = buildProcTable(
      tableInput({
        rows: [...MACHINE, psRow({ pid: 700, ppid: 200, cmd: "node /somewhere/else.js" })],
      }),
    );
    expect(table.famPids).toEqual([100, 150, 200, 400, 500]);
    expect(table.famPids).not.toContain(700);
  });

  it("classes a classless row under an agent as agent-descendant, and a classed one as itself", () => {
    const table = buildProcTable(tableInput());
    const byPid = new Map(table.procs.map((entry) => [entry.pid, entry]));
    expect(byPid.get(100)?.class).toBe("app-main");
    expect(byPid.get(400)?.class).toBe("claude-child");
    expect(byPid.get(500)?.class).toBe("agent-descendant");
  });

  it("walks ancestry through rows that are not in the table", () => {
    // 500 -> 400 (agent) -> 600 (plain node, classless and unrelated) -> daemon 200.
    const rows = [
      psRow({ pid: 100, ppid: 1, cmd: APP }),
      psRow({ pid: 150, ppid: 100, cmd: SUP }),
      psRow({ pid: 200, ppid: 150, cmd: DAEMON }),
      psRow({ pid: 600, ppid: 200, cmd: "node /x.js" }),
      psRow({ pid: 400, ppid: 600, cmd: CLAUDE }),
      psRow({ pid: 500, ppid: 400, cmd: "node /repo/build.mjs" }),
    ];
    const table = buildProcTable(tableInput({ rows }));
    expect(table.famPids).toEqual([100, 150, 200, 400, 500]);
    expect(table.procs.find((entry) => entry.pid === 500)?.underDaemon).toBe(true);
  });

  it("stops the ancestor walk at ppid 1, a missing parent and a cycle", () => {
    const rows = [
      psRow({ pid: 400, ppid: 1, cmd: CLAUDE }),
      psRow({ pid: 500, ppid: 400, cmd: "node /repo/build.mjs" }),
      psRow({ pid: 600, ppid: 601, cmd: CLAUDE }),
      psRow({ pid: 601, ppid: 600, cmd: "node /loop.js" }),
      psRow({ pid: 700, ppid: 9999, cmd: CLAUDE }),
    ];
    const table = buildProcTable(tableInput({ rows }));
    expect(table.procs.find((entry) => entry.pid === 500)?.underDaemon).toBe(false);
    // A cycle is walked until the repeated pid, not for ever.
    const loop = table.procs.find((entry) => entry.pid === 601);
    expect(loop?.class).toBe("agent-descendant");
    expect(table.procs.find((entry) => entry.pid === 700)?.ppid).toBe(9999);
  });

  it("never walks into pid 1 (slp-gc.bash:294)", () => {
    // Synthetic on purpose: a real sample has launchd at pid 1 and no Paseo
    // class on it, so `$l.ppid > 1` and "the parent is missing" would be
    // indistinguishable. Giving pid 1 a class makes the guard observable: an
    // orphan at ppid 1 must not inherit an agent ancestor from it.
    const rows = [psRow({ pid: 1, ppid: 0, cmd: CLAUDE }), psRow({ pid: 400, ppid: 1, cmd: "node /repo/build.mjs" })];
    const table = buildProcTable(tableInput({ rows, env: envOf({ 1: { agent: "ghost" } }) }));
    expect(table.famPids).toEqual([1]);
    expect(table.procs.find((entry) => entry.pid === 400)).toBeUndefined();
  });
});

describe("buildProcTable — ownership (slp-gc.bash:304-312)", () => {
  it("takes the owner from the row's own environment first", () => {
    const table = buildProcTable(
      tableInput({ env: envOf({ 400: { agent: "agent-1" }, 500: { agent: "agent-2" } }) }),
    );
    expect(table.procs.find((entry) => entry.pid === 500)?.owner).toBe("agent-2");
  });

  it("falls back to the nearest agent-class ancestor's environment", () => {
    const table = buildProcTable(tableInput({ env: envOf({ 400: { agent: "agent-1" } }) }));
    expect(table.procs.find((entry) => entry.pid === 500)?.owner).toBe("agent-1");
  });

  it("has no owner when neither the row nor an ancestor names one", () => {
    const table = buildProcTable(tableInput({ env: envOf({}) }));
    const entry = table.procs.find((e) => e.pid === 500);
    expect(entry?.owner).toBeNull();
    expect(entry?.ownerState).toBeNull();
  });

  it("resolves an owner state from the agent index", () => {
    const states = [
      [agent("agent-1", "2026-10-01T00:00:00Z"), "archived"],
      [agent("agent-1", null), "live"],
    ] as const;
    for (const [record, expected] of states) {
      const table = buildProcTable(tableInput({ agents: [record] }));
      expect(table.procs.find((entry) => entry.pid === 500)?.ownerState).toBe(expected);
    }
  });

  it("answers missing, unknown and unknown-on-a-broken-index (slp-gc.bash:312)", () => {
    // `missing` is the one state that needs the caller to vouch for the index:
    // it proves the agent is gone, so it is opt-in (`agentIndexOk: true`).
    const missing = buildProcTable(
      tableInput({ agents: [agent("other", null)], agentIndexOk: true }),
    );
    expect(missing.procs.find((entry) => entry.pid === 500)?.ownerState).toBe("missing");

    const noIndex = buildProcTable(tableInput({ agents: [] }));
    expect(noIndex.procs.find((entry) => entry.pid === 500)?.ownerState).toBe("unknown");

    const broken = buildProcTable(
      tableInput({ agents: [agent("other", null)], agentIndexOk: false }),
    );
    expect(broken.procs.find((entry) => entry.pid === 500)?.ownerState).toBe("unknown");
  });
});

describe("buildProcTable — the index completeness must be opted into (slp-gc.bash:312)", () => {
  // `agentIndexOk` defaults to false. An index nobody vouched for must not turn
  // a missing record into `missing`, because `missing` is the only owner state
  // that proves the agent is gone and the stale rule signals on it (arm 8).
  it("reads an owner with no record as unknown when the flag is absent", () => {
    const table = buildProcTable(tableInput({ agents: [agent("other", null)] }));
    expect(table.procs.find((entry) => entry.pid === 500)?.ownerState).toBe("unknown");
    expect(table.procs.find((entry) => entry.pid === 400)?.ownerState).toBe("unknown");
    // Even an explicit `undefined` is an unstated index, not a complete one.
    const explicit = buildProcTable(
      tableInput({ agents: [agent("other", null)], agentIndexOk: undefined }),
    );
    expect(explicit.procs.find((entry) => entry.pid === 500)?.ownerState).toBe("unknown");
  });

  it("leaves a record-backed owner state alone, whatever the flag says", () => {
    for (const agentIndexOk of [undefined, true, false]) {
      for (const [record, expected] of [
        [agent("agent-1", "2026-10-01T00:00:00Z"), "archived"],
        [agent("agent-1", null), "live"],
      ] as const) {
        const table = buildProcTable(tableInput({ agents: [record], agentIndexOk }));
        expect(table.procs.find((entry) => entry.pid === 500)?.ownerState).toBe(expected);
      }
    }
  });

  it("refuses the stale rule for the owner a defaulted index could not resolve", () => {
    // The fail-closed consequence: an aged agent child whose parent is gone from
    // the table and whose owner has no record is refused until the caller proves
    // the index was complete. (ppid must not be 1: all three owner arms of
    // slp-gc.bash:354-357 are guarded by `ppid != 1`.)
    const rows = [...MACHINE, psRow({ pid: 800, ppid: 900, cmd: CLAUDE, etime_s: 3600 })];
    const env = envOf({ 400: { agent: "agent-1" }, 800: { agent: "agent-gone", home: "match" } });
    const agents = [agent("agent-1", "2026-10-01T00:00:00Z")];

    const defaulted = buildProcTable(tableInput({ rows, env, agents }));
    const orphan = defaulted.procs.find((entry) => entry.pid === 800)!;
    expect(orphan.ownerState).toBe("unknown");
    const refused = staleDecision(orphan, { ...ctx, famPids: defaulted.famPids });
    expect(refused.eligible).toBe(false);
    expect(refused.why).toContain("owner agent-gone is unknown");

    // The same machine with the index vouched for: the owner really is gone.
    const complete = buildProcTable(tableInput({ rows, env, agents, agentIndexOk: true }));
    const proven = complete.procs.find((entry) => entry.pid === 800)!;
    expect(proven.ownerState).toBe("missing");
  });
});

describe("buildProcTable — home and footprint (slp-gc.bash:313-315, 375)", () => {
  it("overlays an unreadable environment onto the home verdict", () => {
    const table = buildProcTable(
      tableInput({ env: envOf({ 500: { agent: "agent-1", home: "other", read: false } }) }),
    );
    const entry = table.procs.find((e) => e.pid === 500);
    expect(entry?.envRead).toBe(false);
    expect(entry?.home).toBe("unreadable");
  });

  it("reports a readable home verbatim", () => {
    const table = buildProcTable(tableInput({ env: envOf({ 500: { home: "none" } }) }));
    expect(table.procs.find((entry) => entry.pid === 500)?.home).toBe("none");
  });

  it("prefers top's footprint and falls back to rss, naming the source", () => {
    const top = new Map([
      [500, { mem: 999.5, cmprs: 12 }],
    ]);
    const table = buildProcTable(tableInput({ top }));
    const withTop = table.procs.find((entry) => entry.pid === 500);
    expect(withTop?.footprint_mb).toBe(999.5);
    expect(withTop?.footprintSource).toBe("top");
    expect(withTop?.mem_mb).toBe(999.5);
    expect(withTop?.cmprs_mb).toBe(12);

    const withoutTop = table.procs.find((entry) => entry.pid === 400);
    expect(withoutTop?.footprint_mb).toBe(10);
    expect(withoutTop?.footprintSource).toBe("rss");
    expect(withoutTop?.mem_mb).toBeNull();
    expect(withoutTop?.cmprs_mb).toBeNull();
  });

  it("warns at the threshold, not above it", () => {
    const top = new Map([
      [400, { mem: 3072, cmprs: 0 }],
      [500, { mem: 3071.9, cmprs: 0 }],
    ]);
    const table = buildProcTable(tableInput({ top }));
    expect(table.procs.find((entry) => entry.pid === 400)?.warn).toBe(true);
    expect(table.procs.find((entry) => entry.pid === 500)?.warn).toBe(false);
  });

  it("takes the comm from the basename of argv[0]", () => {
    const table = buildProcTable(
      tableInput({ rows: [psRow({ pid: 400, ppid: 1, cmd: `/usr/local/bin/${CLAUDE}` })] }),
    );
    expect(table.procs[0]?.exe).toBe("claude");
  });
});

describe("buildProcTable — protection (slp-gc.bash:295-302, 317-319)", () => {
  it("protects the GC's own process and its whole subtree", () => {
    // The GC runs under an agent (as it does when a supervisor heartbeat runs
    // it), so its row is in `$ours` and its protection is visible at all: a row
    // with no class and no agent-class ancestor never enters the table.
    const table = buildProcTable(
      tableInput({
        selfPid: 2000,
        rows: [
          ...MACHINE,
          psRow({ pid: 2000, ppid: 400, cmd: "node /gc.js" }),
          psRow({ pid: 2001, ppid: 2000, cmd: "node /gc-child.js" }),
          psRow({ pid: 800, ppid: 200, cmd: CLAUDE }),
        ],
        invoker: null,
      }),
    );
    const byPid = new Map(table.procs.map((entry) => [entry.pid, entry]));
    expect(byPid.get(2000)?.protected).toBe("in the GC's own process tree");
    expect(byPid.get(2001)?.protected).toBe("in the GC's own process tree");
    // The reference protects its own ancestry too: those are the processes the
    // tick is running under.
    expect(byPid.get(400)?.protected).toBe("in the GC's own process tree");
    expect(byPid.get(150)?.protected).toBe("in the GC's own process tree");
    // Everything else under that agent is protected by the subtree arm,
    // `$invSub` (slp-gc.bash:301), which is independent of `$invoker`.
    expect(byPid.get(500)?.protected).toBe("in the invoking agent's process subtree");
    // A sibling branch under the daemon is in neither tree.
    expect(byPid.get(800)?.protected).toBeNull();
  });

  it("protects an agent the GC itself cannot see, by its own pid alone", () => {
    const table = buildProcTable(tableInput({ selfPid: 4321 }));
    // No row for 4321, and nothing descends from it.
    expect(table.procs.every((entry) => entry.protected === null)).toBe(true);
  });

  it("protects the invoking agent's processes and prefers the owner arm", () => {
    const table = buildProcTable(
      tableInput({
        selfPid: 2000,
        invoker: "agent-1",
        rows: [...MACHINE, psRow({ pid: 2000, ppid: 400, cmd: "node /gc.js" })],
        env: envOf({ 400: { agent: "agent-1" }, 500: { agent: null } }),
      }),
    );
    const byPid = new Map(table.procs.map((entry) => [entry.pid, entry]));
    expect(byPid.get(500)?.owner).toBe("agent-1");
    expect(byPid.get(500)?.protected).toBe("belongs to the invoking agent");

    // With no owner on the row, the subtree arm answers instead.
    const subtree = buildProcTable(
      tableInput({
        selfPid: 2000,
        invoker: "someone-else",
        rows: [...MACHINE, psRow({ pid: 2000, ppid: 400, cmd: "node /gc.js" })],
        env: envOf({ 400: { agent: null } }),
      }),
    );
    const sub = new Map(subtree.procs.map((entry) => [entry.pid, entry]));
    expect(sub.get(500)?.owner).toBeNull();
    expect(sub.get(500)?.protected).toBe("in the invoking agent's process subtree");
  });

  it("leaves the invoking-agent arms alone when the GC was run by hand", () => {
    const table = buildProcTable(tableInput({ invoker: null }));
    expect(table.procs.every((entry) => entry.protected === null)).toBe(true);
  });
});

describe("buildProcTable — underDaemon (slp-gc.bash:346)", () => {
  it("requires a descent from the identified daemon pid", () => {
    const table = buildProcTable(tableInput());
    const byPid = new Map(table.procs.map((entry) => [entry.pid, entry]));
    expect(byPid.get(400)?.underDaemon).toBe(true);
    expect(byPid.get(500)?.underDaemon).toBe(true);
    // `chainc` includes the row itself, so the daemon is "under" itself, while
    // the Supervisor and the app main — its ancestors — are not.
    expect(byPid.get(200)?.underDaemon).toBe(true);
    expect(byPid.get(150)?.underDaemon).toBe(false);
    expect(byPid.get(100)?.underDaemon).toBe(false);
  });

  it("is false for a row parented elsewhere", () => {
    const rows = [...MACHINE, psRow({ pid: 800, ppid: 1, cmd: CLAUDE })];
    const table = buildProcTable(tableInput({ rows }));
    expect(table.procs.find((entry) => entry.pid === 800)?.underDaemon).toBe(false);
  });

  it("is false for every row when identification found no daemon (explicit null)", () => {
    // `daemonPid: null` is a *finding* — identification ran and there is no single
    // daemon — not the absent state below. It is safe because identity is not
    // `ok` in that case, so the stale rule refuses at its identification arm.
    const table = buildProcTable(tableInput({ daemonPid: null }));
    expect(table.procs.every((entry) => entry.underDaemon === false)).toBe(true);
  });

  it("does not treat a descendant of a lookalike process as daemon-owned", () => {
    // Same shape, different pids: only the identified daemon counts.
    const rows = [
      psRow({ pid: 700, ppid: 1, cmd: "Paseo Daemon" }),
      psRow({ pid: 400, ppid: 700, cmd: CLAUDE }),
    ];
    const table = buildProcTable(tableInput({ rows, daemonPid: 200 }));
    expect(table.procs.find((entry) => entry.pid === 400)?.underDaemon).toBe(false);
  });
});

describe("buildProcTable — the three daemonPid states (slp-gc.bash:346, 353)", () => {
  /** The single-pass build: no `daemonPid` key at all, as a caller that has not identified the daemon yet. */
  function singlePass(over: Partial<ProcTableInput> = {}) {
    const { daemonPid: _omitted, ...rest } = tableInput(over);
    return buildProcTable(rest);
  }

  it("treats an absent daemonPid as unknown ownership: every row is daemon-owned", () => {
    const absent = singlePass();
    expect(absent.procs.map((entry) => entry.pid)).toEqual([100, 150, 200, 400, 500]);
    expect(absent.procs.every((entry) => entry.underDaemon === true)).toBe(true);
    // Deliberately not a claim about a real daemon: even a row that cannot descend
    // from one — the app main, whose own parent is launchd — is marked.
    expect(absent.procs.find((entry) => entry.pid === 100)?.underDaemon).toBe(true);
  });

  it("refuses a single-pass table's stale-eligible row at the daemon-owned arm", () => {
    // The fail-closed consequence: a reparented, aged agent child with an archived
    // owner would be stale-eligible — but a table built before the daemon is known
    // cannot prove it is not daemon-owned, so it is refused.
    const rows = [...MACHINE, psRow({ pid: 800, ppid: 1, cmd: CLAUDE, etime_s: 3600 })];
    const env = envOf({ 400: { agent: "agent-1" }, 800: { agent: "agent-1", home: "match" } });
    const agents = [agent("agent-1", "2026-10-01T00:00:00Z")];

    const absent = singlePass({ rows, env, agents });
    const orphan = absent.procs.find((entry) => entry.pid === 800)!;
    expect(orphan.class).toBe("claude-child");
    expect(orphan.protected).toBeNull();
    expect(orphan.home).toBe("match");
    expect(orphan.ownerState).toBe("archived");
    const refused = staleDecision(orphan, { ...ctx, famPids: absent.famPids });
    expect(refused.eligible).toBe(false);
    expect(refused.why).toContain("daemon-owned (runs under the daemon)");

    // The second build, handed the identified daemon pid, judges the same row on
    // its own merits — which is what makes the refusal above meaningful.
    const identified = buildProcTable(tableInput({ rows, env, agents }));
    const sameRow = identified.procs.find((entry) => entry.pid === 800)!;
    expect(sameRow.underDaemon).toBe(false);
    expect(staleDecision(sameRow, { ...ctx, famPids: identified.famPids }).eligible).toBe(true);
  });

  it("keeps absent and explicit-null distinct, and differs only in underDaemon", () => {
    const absent = singlePass();
    const none = buildProcTable(tableInput({ daemonPid: null }));
    expect(absent.procs.every((entry) => entry.underDaemon)).toBe(true);
    expect(none.procs.every((entry) => !entry.underDaemon)).toBe(true);
    expect(none.famPids).toEqual(absent.famPids);
    expect(none.procs.map((entry) => entry.pid)).toEqual(absent.procs.map((entry) => entry.pid));
  });

  it("refuses explicit-null rows at the identification arm, never at daemon-owned", () => {
    const none = buildProcTable(tableInput({ daemonPid: null }));
    const row = none.procs.find((entry) => entry.pid === 400)!;
    expect(row.underDaemon).toBe(false);
    const decision = staleDecision(row, {
      ...ctx,
      identity: {
        ok: false,
        why: 'no single "Paseo Daemon" child of the Supervisor',
        supervisorPid: 150,
        daemonPid: null,
        appPid: 100,
      },
      famPids: none.famPids,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.why).toContain("identification failed");
    expect(decision.why).not.toContain("daemon-owned");
  });

  it("keeps a real pid precise: the daemon itself and its descendants only", () => {
    const table = buildProcTable(tableInput({ daemonPid: 200 }));
    const under = table.procs.filter((entry) => entry.underDaemon).map((entry) => entry.pid);
    expect(under).toEqual([200, 400, 500]);
  });
});

describe("the table and the decisions agree", () => {
  it("lets a built orphan row through the stale rule", () => {
    const table = buildProcTable(
      tableInput({
        rows: [
          psRow({ pid: 400, ppid: 1, cmd: CLAUDE, etime_s: 3600 }),
        ],
        env: envOf({ 400: { agent: "agent-1", home: "match" } }),
        agents: [agent("agent-1", "2026-10-01T00:00:00Z")],
        selfPid: 2000,
        daemonPid: 200,
      }),
    );
    const entry = table.procs[0]!;
    expect(entry.owner).toBe("agent-1");
    expect(entry.ownerState).toBe("archived");
    expect(staleDecision(entry, { ...ctx, famPids: table.famPids })).toMatchObject({ eligible: true });
  });

  it("cannot reach eligible through a built entry for any protected shape", () => {
    // Every protection the builder can produce must refuse both rules.
    const table = buildProcTable(
      tableInput({
        selfPid: 400,
        invoker: "agent-1",
        env: envOf({ 400: { agent: "agent-1" }, 500: { agent: "agent-1" } }),
      }),
    );
    for (const entry of table.procs) {
      const decisionContext = { ...ctx, famPids: table.famPids };
      if (entry.protected === null) continue;
      expect(staleDecision(entry, decisionContext).eligible).toBe(false);
      expect(overmemDecision({ ...entry, footprint_mb: 99999 }, decisionContext).eligible).toBe(false);
    }
  });
});

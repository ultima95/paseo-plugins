// The kill path of the GC port: which process the port is allowed to signal.
//
// Every case is inline data and an injected dependency — no `process.kill`, no
// `ps`, no live process, no reference run. The semantics authority is
// `docs/gc-port/slp-gc.bash`, `do_apply`'s second loop (:1104-1168); the line
// numbers in each comment are its.
//
// The gates, in the reference's order, and what pins each one here:
//
//   the same pid is considered once        :1108  "does not signal the same pid twice",
//                                                  "refuses two candidates that resolve to one
//                                                  fresh pid" (the pid signalled is the fresh one)
//   `maxKills`                             :1110  "stops at maxKills", "counts across kinds"
//   the tick budget                        :1111  "stops when the budget is spent",
//                                                  "refuses everything when the budget was
//                                                  already spent at entry"
//   the pid is a signalable process        :1112  "refuses a pid that is not signalable", and
//                                                  "refuses a fresh pid that is not signalable"
//                                                  (0 and -900: `kill(0)`/`kill(-1)` are groups)
//   the class is killable                  :1113  "refuses a class the rules can never make
//                                                  eligible", the three never-signalled classes
//   the row is not protected               :1114  "never signals a protected candidate"
//   a fresh full re-evaluation             :1116  "stops after a fresh re-evaluation fails …"
//   the fresh row is still eligible        :1117  "unless the rule's toggle is off",
//                                                  "skips one that no longer qualifies"
//   the fresh row's pid is what is signalled :1112 "signals the pid the fresh re-evaluation
//                                                  carries"
//   the fresh row's process identity       :1126  "refuses a fresh row whose lstart differs
//                                                  (pid reuse)"
//   its own proof re-read (exe allowlist)  :1148  "refuses an executable outside the allowlist"
//   the footprint re-read before a mem kill :1159 "re-reads the footprint before a memory kill"
//   one `SIGTERM`                          :1165  every acted case asserts the second argument
//
// The three settings-shaped inputs are permissive when absent (file header, point 7 of
// `kill.ts`), so each absence has its own test pinning that default *and* the `warn` that
// announces it: "treats absent kinds as both rules on", "…an absent killComms as no
// executable allowlist", "…an absent memKillMb as no footprint re-read".
import { describe, expect, it, vi } from "vitest";

import type { KillCandidate, KillDeps } from "./kill";
import { signalCandidates } from "./kill";

const candidate: KillCandidate = {
  pid: 900,
  class: "agent-descendant",
  footprint_mb: 9000,
  protected: null,
  overmem: { eligible: true, why: "ok" },
  stale: { eligible: false, why: "no" },
};

/** The deps of the brief's tests: a fresh row that still says what the candidate said. */
function makeDeps(over: Partial<KillDeps> = {}): KillDeps {
  return {
    signal: vi.fn(),
    reevaluate: (row) => row,
    now: () => 0,
    log: vi.fn(),
    ...over,
  };
}

describe("signalCandidates", () => {
  it("never signals a protected candidate", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      {
        candidates: [{ ...candidate, protected: "in the GC's own process tree" }],
        maxKills: 10,
        budgetS: 45,
      },
      { signal, reevaluate: () => candidate, now: () => 0, log: vi.fn() },
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ acted: false });
  });

  it("stops at maxKills", async () => {
    const signal = vi.fn();
    await signalCandidates(
      {
        candidates: Array.from({ length: 5 }, (_, i) => ({ ...candidate, pid: 900 + i })),
        maxKills: 2,
        budgetS: 45,
      },
      { signal, reevaluate: (c) => c, now: () => 0, log: vi.fn() },
    );
    expect(signal).toHaveBeenCalledTimes(2);
  });

  it("re-evaluates each candidate and skips one that no longer qualifies", async () => {
    const signal = vi.fn();
    await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      {
        signal,
        reevaluate: () => ({ ...candidate, overmem: { eligible: false, why: "gone" } }),
        now: () => 0,
        log: vi.fn(),
      },
    );
    expect(signal).not.toHaveBeenCalled();
  });

  it("stops when the budget is spent", async () => {
    const signal = vi.fn();
    let clock = 0;
    await signalCandidates(
      { candidates: [candidate, { ...candidate, pid: 901 }], maxKills: 10, budgetS: 1 },
      { signal, reevaluate: (c) => c, now: () => (clock += 2), log: vi.fn() },
    );
    expect(signal).toHaveBeenCalledTimes(1);
  });

  // --- the reference's class arm (:1113)
  it.each(["app-main", "supervisor", "daemon"])(
    "never signals a %s, whatever its decision says",
    async (cls) => {
      const signal = vi.fn();
      const result = await signalCandidates(
        {
          candidates: [{ ...candidate, class: cls }],
          maxKills: 10,
          budgetS: 45,
          // even when the caller asks for both kinds: the class wins.
        },
        makeDeps({ signal }),
      );
      expect(signal).not.toHaveBeenCalled();
      expect(result[0]).toMatchObject({ acted: false, kind: "kill", id: "900" });
      expect(result[0].reason).toContain(cls);
      expect(result[0].reason).toContain("never signalled");
    },
  );

  it("refuses a class the rules can never make eligible", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [{ ...candidate, class: "terminal-worker" }], maxKills: 10, budgetS: 45 },
      makeDeps({ signal }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toContain("class");
    expect(result[0].reason).toContain("terminal-worker");
  });

  it("treats a missing class as unkillable rather than defaulting one", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      {
        candidates: [{ ...candidate, class: undefined as unknown as string }],
        maxKills: 10,
        budgetS: 45,
      },
      makeDeps({ signal }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toContain("class");
  });

  // --- the pid arm (:1112)
  it.each([
    ["0", 0],
    ["1", 1],
    ["-7", -7],
    ["a fraction", 12.5],
    ["NaN", Number.NaN],
  ])("refuses a pid that is not signalable: %s", async (_label, pid) => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [{ ...candidate, pid }], maxKills: 10, budgetS: 45 },
      makeDeps({ signal }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ acted: false });
    expect(result[0].refusedBy).toBe("bad-pid");
  });

  it("refuses a bad pid without spending a fresh re-evaluation", async () => {
    const reevaluate = vi.fn((row: KillCandidate) => row);
    const result = await signalCandidates(
      { candidates: [{ ...candidate, pid: 1 }], maxKills: 10, budgetS: 45 },
      makeDeps({ reevaluate }),
    );
    expect(reevaluate).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("bad-pid");
  });

  it("refuses a class the rules can never make eligible without spending a fresh re-evaluation", async () => {
    const reevaluate = vi.fn((row: KillCandidate) => row);
    const result = await signalCandidates(
      { candidates: [{ ...candidate, class: "daemon" }], maxKills: 10, budgetS: 45 },
      makeDeps({ reevaluate }),
    );
    expect(reevaluate).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("class");
  });

  it("refuses a protected candidate without spending a fresh re-evaluation", async () => {
    const reevaluate = vi.fn((row: KillCandidate) => row);
    const result = await signalCandidates(
      { candidates: [{ ...candidate, protected: "in the GC's own process tree" }], maxKills: 10, budgetS: 45 },
      makeDeps({ reevaluate }),
    );
    expect(reevaluate).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("protected");
  });

  // --- the fresh re-evaluation (:1116-1119)
  it("signals the pid the fresh re-evaluation carries, not the candidate's", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, reevaluate: () => ({ ...candidate, pid: 901 }) }),
    );
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(901, "SIGTERM");
    expect(result[0]).toMatchObject({ kind: "kill", id: "901", acted: true });
  });

  // --- the fresh pid is gated again (:1112), because *it* is the one signalled
  it.each([
    ["0", 0],
    ["-900", -900],
  ])("refuses a fresh pid that is not signalable: %s", async (_label, freshPid) => {
    // `process.kill(0, "SIGTERM")` signals the caller's own process group and a negative
    // pid signals a group too: the candidate's pid being signalable is not enough.
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [{ ...candidate, pid: 900 }], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, reevaluate: () => ({ ...candidate, pid: freshPid }) }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ acted: false });
    expect(result[0].refusedBy).toBe("bad-pid");
    expect(result[0].reason).toContain(String(freshPid));
  });

  // --- the fresh row's process identity (:1120-1128)
  it("refuses a fresh row whose lstart differs, or cannot be re-read (pid reuse)", async () => {
    const judged = { ...candidate, lstart: "Mon Oct  1 10:00:00 2026" };
    for (const freshLstart of ["Tue Oct  2 10:00:00 2026", undefined]) {
      const signal = vi.fn();
      const result = await signalCandidates(
        { candidates: [judged], maxKills: 10, budgetS: 45 },
        makeDeps({ signal, reevaluate: () => ({ ...judged, lstart: freshLstart }) }),
      );
      expect(signal).not.toHaveBeenCalled();
      expect(result[0]).toMatchObject({ acted: false, refusedBy: "identity" });
      expect(result[0].reason).toContain("pid reuse");
    }
  });

  it("signals a candidate whose lstart the fresh row confirms, and one that carries none", async () => {
    const withLstart = { ...candidate, pid: 900, lstart: "Mon Oct  1 10:00:00 2026" };
    const withoutLstart = { ...candidate, pid: 901, lstart: undefined };
    const signal = vi.fn();
    await signalCandidates(
      { candidates: [withLstart, withoutLstart], maxKills: 10, budgetS: 45 },
      makeDeps({ signal }),
    );
    // `lstart` is not newly required: only a candidate that carries one is compared.
    expect(signal).toHaveBeenCalledTimes(2);
    expect(signal).toHaveBeenNthCalledWith(1, 900, "SIGTERM");
    expect(signal).toHaveBeenNthCalledWith(2, 901, "SIGTERM");
  });

  it("stops after a fresh re-evaluation fails and refuses the rest", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate, { ...candidate, pid: 901 }], maxKills: 10, budgetS: 45 },
      makeDeps({
        signal,
        reevaluate: () => {
          throw new Error("ps exploded");
        },
      }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0].refusedBy).toBe("fresh-evaluation");
    expect(result[0].reason).toContain("ps exploded");
    expect(result[1].acted).toBe(false);
    expect(result[1].reason).toContain("fresh re-evaluation");
  });

  it("refuses a fresh row that carries no decision for the enabled kind", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, reevaluate: () => ({ pid: 900, class: "agent-descendant" }) }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].reason).toContain("no longer eligible");
  });

  it("refuses a candidate the fresh re-evaluation says is gone", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, reevaluate: () => null }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("fresh-evaluation");
    expect(result[0].reason).toContain("gone");
  });

  it("uses the fresh row's class, not the candidate's, to decide killability", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, reevaluate: () => ({ ...candidate, class: "daemon" }) }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("class");
    expect(result[0].reason).toContain("daemon");
  });

  it("never signals a candidate whose fresh row is protected", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      makeDeps({
        signal,
        reevaluate: () => ({ ...candidate, protected: "in the GC's own process tree" }),
      }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].reason).toContain("protected");
  });

  it("does not signal the same pid twice", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate, { ...candidate }], maxKills: 10, budgetS: 45 },
      makeDeps({ signal }),
    );
    expect(signal).toHaveBeenCalledTimes(1);
    expect(result[0].acted).toBe(true);
    expect(result[1]).toMatchObject({ acted: false });
    expect(result[1].refusedBy).toBe("duplicate-pid");
  });

  it("refuses two candidates that resolve to one fresh pid, after signalling it once", async () => {
    // Two *different* candidate pids that the re-read says are the same process. The pid
    // that gets signalled is the fresh one, so `seen` has to be consulted for it again
    // once it is known — otherwise both candidates signal 950.
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [{ ...candidate, pid: 900 }, { ...candidate, pid: 901 }], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, reevaluate: (row) => ({ ...row, pid: 950 }) }),
    );
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(950, "SIGTERM");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "kill", id: "950", acted: true });
    expect(result[1]).toMatchObject({ kind: "kill", id: "901", acted: false, refusedBy: "duplicate-pid" });
    expect(result[1].reason).toContain("950");
  });

  // --- the three fail-open defaults (kill.ts, file header point 7)
  it("treats absent kinds as both rules on, and warns", async () => {
    const signal = vi.fn();
    const log = vi.fn();
    const memOnly = { ...candidate, pid: 700, stale: { eligible: false, why: "no" } };
    const result = await signalCandidates(
      { candidates: [memOnly], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, log }),
    );
    expect(signal).toHaveBeenCalledWith(700, "SIGTERM");
    expect(result[0].acted).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("kinds"), expect.anything());
  });

  it("treats an absent killComms as no executable allowlist, and warns", async () => {
    const signal = vi.fn();
    const log = vi.fn();
    // `/bin/bash` is refused by name when a `killComms` allowlist is supplied; with none,
    // the executable arm does not run at all.
    const orphan = { ...candidate, pid: 820, class: "orphan", exePath: "/bin/bash" };
    const result = await signalCandidates(
      { candidates: [orphan], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, log }),
    );
    expect(signal).toHaveBeenCalledWith(820, "SIGTERM");
    expect(result[0].acted).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("killComms"), expect.anything());
  });

  it("treats an absent memKillMb as no footprint re-read, and warns", async () => {
    const signal = vi.fn();
    const log = vi.fn();
    // A memory kill whose footprint cannot be read is refused when a threshold is
    // supplied; with none, nothing re-reads it.
    const memOnly = { ...candidate, pid: 830, footprint_mb: undefined };
    const result = await signalCandidates(
      { candidates: [memOnly], maxKills: 10, budgetS: 45, kinds: ["mem"] },
      makeDeps({ signal, log }),
    );
    expect(signal).toHaveBeenCalledWith(830, "SIGTERM");
    expect(result[0].acted).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("memKillMb"), expect.anything());
  });

  it("warns nothing about settings it was given", async () => {
    const log = vi.fn();
    await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45, kinds: ["mem"], killComms: ["node"], memKillMb: 4096 },
      makeDeps({ signal: vi.fn(), log }),
    );
    expect(log).not.toHaveBeenCalled();
  });

  // --- the rule toggles (:1105)
  it("signals nothing when both rule toggles are off", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45, kinds: [] },
      makeDeps({ signal }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("rule-off");
  });

  it("signals a stale candidate but not an over-memory one on a stale-only tick", async () => {
    const signal = vi.fn();
    const stale = {
      ...candidate,
      pid: 700,
      class: "claude-child",
      footprint_mb: 100,
      stale: { eligible: true, why: "orphan: reparented to launchd (ppid==1)" },
      overmem: { eligible: false, why: "footprint 100 MB <= 4096 MB" },
    };
    const mem = { ...candidate, pid: 701 };
    const result = await signalCandidates(
      { candidates: [stale, mem], maxKills: 10, budgetS: 45, kinds: ["stale"] },
      makeDeps({ signal }),
    );
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(700, "SIGTERM");
    expect(result[1].acted).toBe(false);
    expect(result[1].refusedBy).toBe("rule-off");
  });

  it("counts maxKills across both kinds", async () => {
    const signal = vi.fn();
    const stale = {
      ...candidate,
      pid: 700,
      class: "slp-wait",
      stale: { eligible: true, why: "orphan: reparented to launchd (ppid==1)" },
      overmem: { eligible: false, why: "footprint 9000 MB <= 0 MB" },
    };
    const result = await signalCandidates(
      { candidates: [stale, candidate], maxKills: 1, budgetS: 45 },
      makeDeps({ signal }),
    );
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(700, "SIGTERM");
    expect(result[1].refusedBy).toBe("limit");
  });

  // --- the tick budget (:1111)
  it("refuses everything when the budget was already spent at entry", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 1, startedAt: 0 },
      makeDeps({ signal, now: () => 2 }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("budget");
    expect(result[0].reason).toContain("SLP_GC_TICK_BUDGET_S=1");
  });

  it("does not read the clock when no budget was given", async () => {
    const now = vi.fn(() => 0);
    const signal = vi.fn();
    await signalCandidates({ candidates: [candidate], maxKills: 10 }, makeDeps({ signal, now }));
    expect(now).not.toHaveBeenCalled();
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it("signals nothing at maxKills 0", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 0, budgetS: 45 },
      makeDeps({ signal }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("limit");
  });

  // --- the footprint re-read (:1159-1163)
  it("re-reads the footprint before a memory kill when a threshold is supplied", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      {
        candidates: [{ ...candidate, pid: 800 }, { ...candidate, pid: 801, footprint_mb: 4096 }],
        maxKills: 10,
        budgetS: 45,
        kinds: ["mem"],
        memKillMb: 4096,
      },
      makeDeps({ signal }),
    );
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(800, "SIGTERM");
    expect(result[1].refusedBy).toBe("footprint");
    expect(result[1].reason).toContain("<= 4096 MB");
  });

  it("refuses a memory kill whose fresh footprint cannot be read", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      {
        candidates: [{ ...candidate, footprint_mb: undefined }],
        maxKills: 10,
        budgetS: 45,
        kinds: ["mem"],
        memKillMb: 4096,
      },
      makeDeps({ signal }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("footprint");
    expect(result[0].reason).toContain("fail closed");
  });

  // --- the executable's own proof (:1148-1157)
  it("refuses an executable outside the allowlist when one is supplied", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      {
        candidates: [
          { ...candidate, pid: 810, class: "orphan", exePath: "/bin/bash" },
          { ...candidate, pid: 811, class: "orphan", exePath: "/usr/local/bin/node" },
          { ...candidate, pid: 812, class: "orphan" },
        ],
        maxKills: 10,
        budgetS: 45,
        killComms: ["node"],
      },
      makeDeps({ signal }),
    );
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(811, "SIGTERM");
    expect(result[0].refusedBy).toBe("exe");
    expect(result[0].reason).toContain("not in SLP_GC_KILL_COMMS");
    expect(result[2].refusedBy).toBe("exe");
    expect(result[2].reason).toContain("unreadable");
  });

  it("refuses an executable inside an .app bundle or /System, /Library", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      {
        candidates: [
          { ...candidate, pid: 820, class: "orphan", exePath: "/Applications/X.app/Contents/node" },
          { ...candidate, pid: 821, class: "orphan", exePath: "/System/bin/node" },
        ],
        maxKills: 10,
        budgetS: 45,
        killComms: ["node"],
      },
      makeDeps({ signal }),
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0].reason).toContain(".app bundle");
    expect(result[1].reason).toContain("/System");
  });

  // --- the ledger's failure arm (:1165)
  it("reports a signal that failed and keeps going", async () => {
    const signal = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("ESRCH");
      })
      .mockImplementation(() => undefined);
    const result = await signalCandidates(
      { candidates: [candidate, { ...candidate, pid: 901 }], maxKills: 10, budgetS: 45 },
      makeDeps({ signal }),
    );
    expect(signal).toHaveBeenCalledTimes(2);
    expect(result[0]).toMatchObject({ acted: false, refusedBy: "signal-failed" });
    expect(result[0].reason).toContain("ESRCH");
    expect(result[1].acted).toBe(true);
  });

  it("returns one result per candidate, refusals included", async () => {
    const result = await signalCandidates(
      {
        candidates: [
          candidate,
          { ...candidate, pid: 901, protected: "in the GC's own process tree" },
          { ...candidate, pid: 902, class: "daemon" },
        ],
        maxKills: 10,
        budgetS: 45,
      },
      makeDeps(),
    );
    expect(result.map((row) => row.acted)).toEqual([true, false, false]);
    expect(result.map((row) => row.id)).toEqual(["900", "901", "902"]);
    expect(result.every((row) => row.kind === "kill")).toBe(true);
  });

  it("signals nothing for an empty candidate list", async () => {
    const signal = vi.fn();
    const result = await signalCandidates({ candidates: [], maxKills: 10, budgetS: 45 }, makeDeps({ signal }));
    expect(result).toEqual([]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("never throws when the log sink itself throws", async () => {
    const signal = vi.fn(() => {
      throw new Error("EPERM");
    });
    const log = () => {
      throw new Error("sink exploded");
    };
    const result = await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      makeDeps({ signal, log }),
    );
    expect(result[0].refusedBy).toBe("signal-failed");
  });
});

// The reclaim path of the GC port: which record the port is allowed to delete.
//
// Every case is inline data and an injected dependency — no `paseo` CLI, no API
// client, no file is statted or unlinked, no live agent or schedule exists. The
// semantics authority is `docs/gc-port/slp-gc.bash`, `do_apply`'s first loop
// (:1046-1096); the line numbers in each comment are its.
//
// The gates, in the reference's order, and what pins each one here:
//
//   the index is complete               :1054  "refuses everything when the index failed"
//   the candidate is garbage            :1079  "refuses a candidate its own rule refused"
//   the rule's toggle                   :1061  "refuses a candidate whose rule is off"
//   the tick budget                     :1072  "stops when the budget is spent"
//   `maxActions`                        :1073  "stops at maxActions", "counts a failed delete"
//   the record file is still a file     :1076  "refuses a record file that is gone or a symlink"
//   a signature to compare against      :1080  "refuses a candidate with no signature"
//   a fresh full re-evaluation          :1077  "refuses when the fresh re-evaluation fails"
//   the signature/timestamps still match :1081 "skips a candidate whose signature changed"
//   the delete itself                   :1093  "deletes …", "reports a failed delete"
import { describe, expect, it, vi } from "vitest";

import type { ReclaimCandidate, ReclaimDeps } from "./apply";
import { reclaim } from "./apply";

const agentCandidate: ReclaimCandidate = {
  kind: "agent",
  id: "a1",
  path: "/h/agents/w/a1.json",
  sig: "1:2:3",
  rule: "agent-archived",
  refusedBy: null,
  updatedAt: "2026-10-01T10:00:00Z",
  archivedAt: "2026-10-01T10:00:00Z",
};

/**
 * Deps whose fresh re-read answers with the record the candidate was judged on
 * — the same signature and both timestamps — so a case that is about a *later*
 * gate is not refused by the re-read.
 */
function makeDeps(over: Partial<ReclaimDeps> = {}): ReclaimDeps {
  return {
    deleteAgent: vi.fn(async () => undefined),
    deleteSchedule: vi.fn(async () => undefined),
    verify: () => ({
      sig: agentCandidate.sig,
      updatedAt: agentCandidate.updatedAt,
      archivedAt: agentCandidate.archivedAt,
    }),
    log: vi.fn(),
    ...over,
  };
}

describe("reclaim", () => {
  it("refuses everything when the index failed", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [{ kind: "agent", id: "a1", refusedBy: null }], indexOk: false },
      { deleteAgent, deleteSchedule: vi.fn(), verify: () => true, log: vi.fn() },
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toContain("index");
  });

  it("deletes a candidate whose signature still matches", async () => {
    const deleteAgent = vi.fn(async () => {});
    const result = await reclaim(
      { candidates: [{ kind: "agent", id: "a1", refusedBy: null, sig: "1:2:3" }], indexOk: true },
      { deleteAgent, deleteSchedule: vi.fn(), verify: () => true, log: vi.fn() },
    );
    expect(deleteAgent).toHaveBeenCalledWith("a1");
    expect(result[0].acted).toBe(true);
  });

  it("skips a candidate whose signature changed", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [{ kind: "agent", id: "a1", refusedBy: null, sig: "1:2:3" }], indexOk: true },
      { deleteAgent, deleteSchedule: vi.fn(), verify: () => false, log: vi.fn() },
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].reason).toContain("changed");
  });

  // --- the index arm (:1054)
  it("refuses every candidate, with one result each, when the index failed", async () => {
    const deleteAgent = vi.fn();
    const deleteSchedule = vi.fn();
    const result = await reclaim(
      {
        candidates: [
          agentCandidate,
          { ...agentCandidate, id: "a2" },
          { ...agentCandidate, kind: "schedule", id: "abcd1234", rule: "schedule-completed" },
        ],
        indexOk: false,
        indexWhy: ["agents: EACCES", "schedules: unreadable"],
      },
      makeDeps({ deleteAgent, deleteSchedule }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(result).toHaveLength(3);
    expect(result.every((row) => row.acted === false)).toBe(true);
    expect(result[0].refusedBy).toContain("index");
    expect(result[0].reason).toContain("agents: EACCES; schedules: unreadable");
  });

  it("refuses everything when the index verdict is absent", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim({ candidates: [agentCandidate] }, makeDeps({ deleteAgent }));
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toContain("index");
  });

  it("says so when there was nothing to refuse and the index failed", async () => {
    const result = await reclaim({ candidates: [], indexOk: false }, makeDeps());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "refuse", id: "-", acted: false });
  });

  // --- the rule / candidate verdict (:1079)
  it("refuses a candidate its own rule refused", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      {
        candidates: [
          {
            ...agentCandidate,
            refusedBy: "agent-schedule-target: an active/paused schedule targets it",
            reason: "not garbage: an active/paused schedule targets it",
          },
        ],
        indexOk: true,
      },
      makeDeps({ deleteAgent }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toContain("agent-schedule-target");
    expect(result[0].reason).toBe("not garbage: an active/paused schedule targets it");
  });

  it("refuses a candidate whose verdict is missing rather than defaulting it", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [{ ...agentCandidate, refusedBy: undefined as unknown as null }], indexOk: true },
      makeDeps({ deleteAgent }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].acted).toBe(false);
  });

  // --- the rule's toggle (:1061)
  it("refuses a candidate whose rule is off", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true, enabledRules: ["schedule-completed"] },
      makeDeps({ deleteAgent }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("rule-off");
    expect(result[0].reason).toContain("agent-archived");
  });

  it("deletes a candidate whose rule is on", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true, enabledRules: ["agent-archived"] },
      makeDeps({ deleteAgent }),
    );
    expect(deleteAgent).toHaveBeenCalledWith("a1");
    expect(result[0].acted).toBe(true);
  });

  // --- the signature (:1080-1084)
  it("refuses a candidate with an empty signature", async () => {
    const deleteAgent = vi.fn();
    const verify = vi.fn(() => true);
    const result = await reclaim(
      { candidates: [{ ...agentCandidate, sig: "" }], indexOk: true },
      makeDeps({ deleteAgent, verify }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("sig-unverified");
  });

  it("refuses a candidate whose signature is missing", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [{ ...agentCandidate, sig: undefined }], indexOk: true },
      makeDeps({ deleteAgent }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("sig-unverified");
  });

  it("skips a candidate whose fresh signature differs", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({ deleteAgent, verify: () => ({ sig: "1:2:9" }) }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("sig-changed");
    expect(result[0].reason).toContain("changed");
  });

  it("skips a candidate a bare fresh signature marks as changed", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({ deleteAgent, verify: () => "1:2:9" }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("sig-changed");
  });

  // --- the fresh re-evaluation (:1077)
  it("refuses when the fresh re-evaluation fails", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({
        deleteAgent,
        verify: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("fresh-evaluation");
    expect(result[0].reason).toContain("EACCES");
  });

  it("refuses when the fresh re-evaluation answers nothing at all", async () => {
    const deleteAgent = vi.fn();
    for (const answer of [null, undefined]) {
      const result = await reclaim(
        { candidates: [agentCandidate], indexOk: true },
        makeDeps({ deleteAgent, verify: () => answer }),
      );
      expect(deleteAgent).not.toHaveBeenCalled();
      expect(result[0].refusedBy).toBe("fresh-evaluation");
    }
  });

  it("refuses when the fresh row is no longer garbage", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({
        deleteAgent,
        verify: () => ({ sig: "1:2:3", refusedBy: "agent-strict: not strict" }),
      }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toContain("agent-strict");
  });

  it("refuses when the fresh re-evaluation answers with no signature", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({ deleteAgent, verify: () => ({ sig: "" }) }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("sig-unverified");
  });

  // --- the timestamps (:1081-1082)
  it("deletes when the fresh row matches the signature and both timestamps", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({
        deleteAgent,
        verify: () => ({
          sig: "1:2:3",
          updatedAt: "2026-10-01T10:00:00Z",
          archivedAt: "2026-10-01T10:00:00Z",
        }),
      }),
    );
    expect(deleteAgent).toHaveBeenCalledWith("a1");
    expect(result[0].acted).toBe(true);
  });

  it("skips when the fresh row's timestamp moved", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({
        deleteAgent,
        verify: () => ({
          sig: "1:2:3",
          updatedAt: "2026-10-02T10:00:00Z",
          archivedAt: "2026-10-01T10:00:00Z",
        }),
      }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("sig-changed");
  });

  it("refuses when the fresh row cannot verify a timestamp it needs", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({ deleteAgent, verify: () => ({ sig: "1:2:3", archivedAt: "2026-10-01T10:00:00Z" }) }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("timestamps-unverified");
  });

  it("refuses a bare boolean re-check for a candidate that carries timestamps", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({ deleteAgent, verify: () => true }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("timestamps-unverified");
  });

  it("compares archivedEpoch when that is what the candidate carries", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const candidate = {
      ...agentCandidate,
      updatedAt: undefined,
      archivedAt: undefined,
      archivedEpoch: 1_790_000_000,
    };
    const ok = await reclaim(
      { candidates: [candidate], indexOk: true },
      makeDeps({
        deleteAgent,
        verify: () => ({ sig: "1:2:3", archivedEpoch: 1_790_000_000 }),
      }),
    );
    expect(ok[0].acted).toBe(true);
    const moved = await reclaim(
      { candidates: [candidate], indexOk: true },
      makeDeps({ deleteAgent: vi.fn(), verify: () => ({ sig: "1:2:3", archivedEpoch: 1_790_000_001 }) }),
    );
    expect(moved[0].refusedBy).toBe("sig-changed");
  });

  // --- what it calls, and in which order
  it("verifies immediately before each delete", async () => {
    const order: string[] = [];
    const deleteAgent = vi.fn(async () => {
      order.push("delete");
    });
    const verify = vi.fn((_candidate: ReclaimCandidate) => {
      order.push("verify");
      return { sig: "1:2:3", updatedAt: agentCandidate.updatedAt, archivedAt: agentCandidate.archivedAt };
    });
    await reclaim(
      { candidates: [agentCandidate, { ...agentCandidate, id: "a2" }], indexOk: true },
      makeDeps({ deleteAgent, verify }),
    );
    expect(order).toEqual(["verify", "delete", "verify", "delete"]);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[1][0]).toMatchObject({ id: "a2" });
  });

  it("deletes a schedule through deleteSchedule and never through deleteAgent", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const deleteSchedule = vi.fn(async () => undefined);
    const result = await reclaim(
      {
        candidates: [
          { ...agentCandidate, kind: "schedule", id: "abcd1234", rule: "schedule-completed" },
        ],
        indexOk: true,
      },
      makeDeps({ deleteAgent, deleteSchedule }),
    );
    expect(deleteSchedule).toHaveBeenCalledWith("abcd1234");
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ kind: "schedule", id: "abcd1234", acted: true });
  });

  it("reports a failed delete and keeps going", async () => {
    const deleteAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon closed the socket"))
      .mockResolvedValue(undefined);
    const result = await reclaim(
      { candidates: [agentCandidate, { ...agentCandidate, id: "a2" }], indexOk: true },
      makeDeps({
        deleteAgent,
        verify: () => ({
          sig: "1:2:3",
          updatedAt: agentCandidate.updatedAt,
          archivedAt: agentCandidate.archivedAt,
        }),
      }),
    );
    expect(deleteAgent).toHaveBeenCalledTimes(2);
    expect(result[0]).toMatchObject({ acted: false, refusedBy: "delete-failed" });
    expect(result[0].reason).toContain("daemon closed the socket");
    expect(result[1].acted).toBe(true);
  });

  it("refuses a candidate with no id, or an unknown kind", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      {
        candidates: [
          { ...agentCandidate, id: "" },
          { ...agentCandidate, kind: "agent" as const, id: "a3" },
          { ...agentCandidate, kind: "workspace" as unknown as "agent", id: "a4" },
        ],
        indexOk: true,
      },
      makeDeps({ deleteAgent }),
    );
    expect(deleteAgent).toHaveBeenCalledTimes(1);
    expect(deleteAgent).toHaveBeenCalledWith("a3");
    expect(result[0].refusedBy).toBe("bad-id");
    expect(result[2].refusedBy).toBe("bad-kind");
  });

  // --- the record file's own shape (:1076): `[ -L "$path" ] || [ ! -f "$path" ]`
  it("refuses a record file that is gone or a symlink, before re-reading it", async () => {
    const shapes = [
      ["gone", null],
      ["a symlink", { isSymbolicLink: true, isFile: true }],
      ["a directory", { isSymbolicLink: false, isFile: false }],
    ] as const;
    for (const [label, shape] of shapes) {
      const deleteAgent = vi.fn();
      const verify = vi.fn(() => true);
      const result = await reclaim(
        { candidates: [agentCandidate], indexOk: true },
        makeDeps({ deleteAgent, verify, lstat: () => shape }),
      );
      expect(deleteAgent, label).not.toHaveBeenCalled();
      expect(verify, label).not.toHaveBeenCalled();
      expect(result[0].refusedBy).toBe("file-gone");
      expect(result[0].reason).toContain("file gone or symlink");
    }
  });

  it("refuses when the record file itself cannot be statted", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({
        deleteAgent,
        lstat: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("file-gone");
    expect(result[0].reason).toContain("EACCES");
  });

  it("deletes when the record file is still a regular file", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const lstat = vi.fn(() => ({ isFile: true, isSymbolicLink: false }));
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({ deleteAgent, lstat }),
    );
    expect(lstat).toHaveBeenCalledWith(agentCandidate.path);
    expect(deleteAgent).toHaveBeenCalledWith("a1");
    expect(result[0].acted).toBe(true);
  });

  it("leaves the record file's existence to verify when no path is supplied", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const lstat = vi.fn(() => null);
    const verify = vi.fn(() => ({
      sig: "1:2:3",
      updatedAt: agentCandidate.updatedAt,
      archivedAt: agentCandidate.archivedAt,
    }));
    const result = await reclaim(
      { candidates: [{ ...agentCandidate, path: undefined }], indexOk: true },
      makeDeps({ deleteAgent, lstat, verify }),
    );
    expect(lstat).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result[0].acted).toBe(true);
  });

  it("says so when the record file cannot be checked and leans on verify instead", async () => {
    // No `lstat` injected: the arm is skipped (this module does no I/O of its own), so
    // the file's existence is `verify`'s to answer — and a `verify` that answers nothing
    // refuses the row.
    const deleteAgent = vi.fn();
    const log = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true },
      makeDeps({ deleteAgent, log, verify: () => null }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("fresh-evaluation");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("lstat"), expect.anything());
  });

  // --- the limits (:1072-1073)
  it("stops at maxActions", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const result = await reclaim(
      {
        candidates: [0, 1, 2].map((i) => ({ ...agentCandidate, id: `a${i}` })),
        indexOk: true,
        maxActions: 2,
      },
      makeDeps({
        deleteAgent,
        verify: () => ({
          sig: "1:2:3",
          updatedAt: agentCandidate.updatedAt,
          archivedAt: agentCandidate.archivedAt,
        }),
      }),
    );
    expect(deleteAgent).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({ acted: false, refusedBy: "limit" });
    expect(result[2].reason).toContain("SLP_GC_MAX_ACTIONS=2");
  });

  it("counts a failed delete against maxActions", async () => {
    // `MAX_ACTIONS` counts attempts, as the reference does: `n=$((n + 1))` is at :1092,
    // before the CLI call at :1093. A delete that fails still spends its slot.
    const deleteAgent = vi.fn(async () => {
      throw new Error("daemon hung");
    });
    const result = await reclaim(
      { candidates: [agentCandidate, { ...agentCandidate, id: "a2" }], indexOk: true, maxActions: 1 },
      makeDeps({ deleteAgent }),
    );
    expect(deleteAgent).toHaveBeenCalledTimes(1);
    expect(deleteAgent).toHaveBeenCalledWith("a1");
    expect(result[0]).toMatchObject({ acted: false, refusedBy: "delete-failed" });
    expect(result[1]).toMatchObject({ acted: false, refusedBy: "limit" });
    expect(result[1].reason).toContain("SLP_GC_MAX_ACTIONS=1");
  });

  it("stops when the budget is spent", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    let clock = 0;
    const result = await reclaim(
      { candidates: [agentCandidate, { ...agentCandidate, id: "a2" }], indexOk: true, budgetS: 1 },
      makeDeps({
        deleteAgent,
        now: () => (clock += 2),
        verify: () => ({
          sig: "1:2:3",
          updatedAt: agentCandidate.updatedAt,
          archivedAt: agentCandidate.archivedAt,
        }),
      }),
    );
    expect(deleteAgent).toHaveBeenCalledTimes(1);
    expect(result[1].refusedBy).toBe("budget");
    expect(result[1].reason).toContain("SLP_GC_TICK_BUDGET_S=1");
  });

  it("refuses everything when the budget was already spent at entry", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true, budgetS: 1, startedAt: 0 },
      makeDeps({ deleteAgent, now: () => 2 }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("budget");
  });

  it("refuses everything when the clock itself fails", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: true, budgetS: 45 },
      makeDeps({
        deleteAgent,
        now: () => {
          throw new Error("no clock");
        },
      }),
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toBe("budget");
  });

  it("returns nothing for an empty candidate list", async () => {
    const result = await reclaim({ candidates: [], indexOk: true }, makeDeps());
    expect(result).toEqual([]);
  });

  it("never throws when the log sink itself throws", async () => {
    const log = () => {
      throw new Error("sink exploded");
    };
    const result = await reclaim(
      { candidates: [agentCandidate], indexOk: false },
      makeDeps({ log }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].acted).toBe(false);
  });
});

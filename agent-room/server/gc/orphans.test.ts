// The orphan proof: the one rule that decides whether a ppid-1 process with
// agent provenance may be signalled at all.
//
// Every case is inline data — a hand-built `ps` row, one environment verdict, one
// ledger row, one agent index and one process table. Nothing here reads the live
// process table, shells out to `ps`/`top`/`lsof`, runs a reference subcommand, or
// talks to the daemon or an agent. The semantics authority is
// `docs/gc-port/slp-gc.bash`; the line numbers in the comments are its.
import { describe, expect, it } from "vitest";

import type { EnvFacts, OrphanContext } from "./evaluate";
import { orphanDecision } from "./evaluate";
import type { LedgerRow } from "./ledger";
import type { ProcRow } from "./procs";

const LSTART = "Mon Oct 27 10:00:00 2026";
const NOW = 1_800_000_000;
const OWNER = "9f1c2f0a-1111-4bbb-8ccc-1234567890ab";

// The brief's fixtures, verbatim.
const row: ProcRow = {
  pid: 500, ppid: 1, pgid: 500, etime_s: 7200, rss_mb: 40, lstart: LSTART, cmd: "node /repo/build.mjs",
};
const ledger: LedgerRow = {
  pid: 500, lstart: LSTART, comm: "node", owner: OWNER,
  first: NOW - 9000, orphaned: NOW - 8000, exe: "/usr/local/bin/node",
};
const noEnv: EnvFacts = { agent: null, home: "none", read: false };

/**
 * The brief's `ctx`, minus one correction (slp-gc.bash:390): the reference reads
 * an **empty** agent index as `unknown`, never as `missing`, so with `agents: []`
 * no owned orphan can be proven dead. The brief's first case expected a proof
 * from exactly that shape; `ctx` below therefore carries the owner's archived
 * record, and `briefCtx` is kept to pin the empty-index refusal (see
 * "treats an empty agent index as unknown"). Same class of adjustment as the
 * Task 6 report's concern 1 — the reference wins, the brief's intent is kept.
 */
const briefCtx: OrphanContext = {
  now: NOW,
  identity: { ok: true, why: "ok", daemonPid: 200, appPid: 100, supervisorPid: 150 },
  killMb: 4096, killComms: ["node"], warnMb: 3072, orphanMinAgeMin: 10,
  agents: [], top: new Map(), invoker: null, invTree: [], selfTree: [],
};
const archivedOwner = [{ id: OWNER, archivedAt: "2026-10-01T00:00:00.000Z" }];
const ctx: OrphanContext = { ...briefCtx, agents: archivedOwner };

describe("orphanDecision — the brief's cases", () => {
  it("proves an orphan from a ledger row and eligible age", () => {
    const d = orphanDecision({ row, env: noEnv, ledger, ctx });
    expect(d.proof).toBe("ledger");
    expect(d.stale.eligible).toBe(true);
    expect(d.entry.proven).toBe(true);
  });

  it("refuses when the ledger has no real executable path", () => {
    const d = orphanDecision({ row, env: noEnv, ledger: { ...ledger, exe: "" }, ctx });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toContain("real executable path not recorded in the ledger");
  });

  it("refuses when the current env contradicts the ledger owner", () => {
    const env: EnvFacts = { agent: "other-owner", home: "match", read: true };
    expect(orphanDecision({ row, env, ledger, ctx }).stale.eligible).toBe(false);
  });

  it("refuses a live owner", () => {
    const agents = [{ id: OWNER, archivedAt: null }];
    expect(orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, agents } }).stale.eligible).toBe(false);
  });

  it("refuses when orphaned-at is not recorded yet", () => {
    const d = orphanDecision({ row, env: noEnv, ledger: { ...ledger, orphaned: 0 }, ctx });
    expect(d.stale.why).toContain("not recorded yet");
  });

  it("refuses when an agent-class process has an unreadable env (fail closed)", () => {
    // The brief builds the blind row and passes the flag the caller derived from
    // its own table; both spellings of `$blindAgents` are exercised here.
    const blind = [{
      pid: 501, lstart: LSTART, class: "claude-child" as const, owner: OWNER, envRead: false,
    }];
    const flagged = orphanDecision({
      row, env: noEnv, ledger, ctx: { ...ctx, blindAgentPresent: true },
    });
    const derived = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, procs: blind } });
    for (const d of [flagged, derived]) {
      expect(d.stale.eligible).toBe(false);
      expect(d.stale.why).toContain("treated as LIVE (fail closed)");
    }
  });

  it("refuses an executable inside an .app bundle", () => {
    const d = orphanDecision({
      row, env: noEnv,
      ledger: { ...ledger, comm: "X", exe: "/Applications/X.app/Contents/MacOS/X" }, ctx,
    });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toContain(".app bundle");
  });
});

describe("orphanDecision — the proof chain", () => {
  it("labels an env-only proof and still refuses it: the exe lives in the ledger", () => {
    // slp-gc.bash:404-409, :421: without a ledger row `$rexe` is "" and the
    // missing-executable arm fires before the age arms, so an env-proof row is
    // provenance for the report/ledger and never kill eligibility in that tick.
    const env: EnvFacts = { agent: OWNER, home: "match", read: true };
    const d = orphanDecision({ row, env, ledger: null, ctx });
    expect(d.proof).toBe("env");
    expect(d.entry.proven).toBe(false);
    expect(d.entry.owner).toBe(OWNER);
    expect(d.entry.orphanedAt).toBe(0);
    expect(d.stale.why).toContain("real executable path not recorded in the ledger");
  });

  it("names the ledger proof in the eligible sentence", () => {
    const d = orphanDecision({ row, env: noEnv, ledger, ctx });
    expect(d.stale.why).toBe(
      "orphaned agent descendant: ppid 1, proven by the lineage ledger (pid+lstart), " +
        "owner not live, comm node, orphaned 8000s >= 600s",
    );
  });

  it("refuses a comm outside the allowlist, naming the recorded executable", () => {
    const d = orphanDecision({
      row, env: noEnv, ledger: { ...ledger, exe: "/usr/local/bin/rg", comm: "rg" }, ctx,
    });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toBe('report only: executable "/usr/local/bin/rg" (comm "rg") is not in SLP_GC_KILL_COMMS');
  });

  it("compares the allowlist case-sensitively", () => {
    // `($oc | index($p.exe))` (`:373`, `:422`): jq's `index` is exact.
    const d = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, killComms: ["NODE"] } });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toContain("not in SLP_GC_KILL_COMMS");
  });

  it("accepts an env that agrees with the ledger owner", () => {
    // slp-gc.bash:420 refuses a *contradiction*; agreement is not one.
    const env: EnvFacts = { agent: OWNER, home: "match", read: true };
    const d = orphanDecision({ row, env, ledger, ctx });
    expect(d.stale.eligible).toBe(true);
    expect(d.entry.owner).toBe(OWNER);
  });

  it("treats an empty agent index as unknown", () => {
    const d = orphanDecision({ row, env: noEnv, ledger, ctx: briefCtx });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toContain("treated as LIVE (fail closed)");
  });

  it("reads a missing record as dead only on a complete index", () => {
    // slp-gc.bash:390-391: no record plus `$nbad == 0` is `missing`; an index the
    // caller did not vouch for leaves `unknown`, which is not a proof.
    const other = [{ id: "some-other-agent", archivedAt: "2026-10-01T00:00:00.000Z" }];
    const withoutFlag = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, agents: other } });
    const complete = orphanDecision({
      row, env: noEnv, ledger, ctx: { ...ctx, agents: other, agentIndexOk: true },
    });
    expect(withoutFlag.stale.eligible).toBe(false);
    expect(complete.stale.eligible).toBe(true);
  });

  it("proves a pid:<n>@<lstart> owner dead only when no live row matches it", () => {
    const pidOwner = `pid:700@${LSTART}`;
    const pidLedger = { ...ledger, owner: pidOwner };
    const liveRow = { pid: 700, lstart: LSTART, class: "claude-child" as const, owner: null, envRead: true };
    const dead = orphanDecision({ row, env: noEnv, ledger: pidLedger, ctx });
    const live = orphanDecision({ row, env: noEnv, ledger: pidLedger, ctx: { ...ctx, procs: [liveRow] } });
    expect(dead.stale.eligible).toBe(true);
    expect(dead.entry.owner).toBe(pidOwner);
    expect(live.stale.eligible).toBe(false);
  });

  it("treats a recycled pid as gone: the lstart must match, not just the pid", () => {
    const pidOwner = `pid:700@Tue Oct 28 09:00:00 2026`;
    const recycled = { pid: 700, lstart: LSTART, class: "claude-child" as const, owner: null, envRead: true };
    const d = orphanDecision({
      row, env: noEnv, ledger: { ...ledger, owner: pidOwner }, ctx: { ...ctx, procs: [recycled] },
    });
    expect(d.stale.eligible).toBe(true);
  });

  it("refuses an agent-id owner that a live agent-class process still carries", () => {
    // slp-gc.bash:395: archived/missing is not enough — no agent-class process may
    // carry the owner either.
    const carrying = { pid: 800, lstart: LSTART, class: "claude-child" as const, owner: OWNER, envRead: true };
    const d = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, procs: [carrying] } });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toContain("treated as LIVE (fail closed)");
  });

  it("counts only agent-class processes as evidence of a live owner", () => {
    // The scan is `select((.class | agentish) and .owner == $o)` (`:395`): a
    // helper that merely inherits the id is not the agent.
    const descendant = { pid: 810, lstart: LSTART, class: "agent-descendant" as const, owner: OWNER, envRead: true };
    const d = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, procs: [descendant] } });
    expect(d.stale.eligible).toBe(true);
  });

  it("refuses a ledger row with no owner at all", () => {
    // Defensive: `validateLedger` never lets such a row through, so this pins the
    // fail-closed answer for a caller that skipped it. `ldead(null)` is false.
    const ownerless = { ...ledger, owner: null as unknown as string };
    const d = orphanDecision({ row, env: noEnv, ledger: ownerless, ctx });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toContain("treated as LIVE (fail closed)");
  });

  it("reads an absent table as an empty one", () => {
    // The documented default of `OrphanContext.procs`: a tick that hands in no
    // table saw no agent-class process. Task 12 must pass `buildProcTable().procs`
    // (see the context's doc); this pin keeps the default from being a surprise.
    expect(orphanDecision({ row, env: noEnv, ledger, ctx }).entry.proven).toBe(true);
    const carrying = { pid: 800, lstart: LSTART, class: "claude-child" as const, owner: OWNER, envRead: true };
    expect(orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, procs: [carrying] } }).entry.proven).toBe(false);
  });

  it("refuses a wait helper with an unreadable env in the table", () => {
    // `agentfam` (:278, :392), not just `agentish`: a blind slp-wait/paseo-wait
    // row blinds the whole tick too.
    const blindWait = { pid: 900, lstart: LSTART, class: "slp-wait" as const, owner: null, envRead: false };
    expect(orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, procs: [blindWait] } }).stale.eligible).toBe(false);
  });

  it("accepts a readable agent-class table that carries no owner", () => {
    const sighted = { pid: 901, lstart: LSTART, class: "codex-child" as const, owner: "other", envRead: true };
    expect(orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, procs: [sighted] } }).stale.eligible).toBe(true);
  });

  it("refuses a row that no ledger row and no env prove", () => {
    const d = orphanDecision({ row, env: noEnv, ledger: null, ctx });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toContain("real executable path not recorded in the ledger");
  });
});

describe("orphanDecision — protection", () => {
  const protectedCase = (patch: Partial<OrphanContext>, patchLedger: Partial<LedgerRow> = {}, why: string) => {
    const d = orphanDecision({ row, env: noEnv, ledger: { ...ledger, ...patchLedger }, ctx: { ...ctx, ...patch } });
    expect(d.stale.eligible).toBe(false);
    expect(d.stale.why).toBe(`protected: ${why}`);
    expect(d.entry.protected).toBe(why);
  };

  it("refuses the GC's own process tree", () => {
    protectedCase({ selfTree: [500] }, {}, "in the GC's own process tree");
  });

  it("refuses the invoking agent", () => {
    protectedCase({ invoker: OWNER }, {}, "belongs to the invoking agent");
  });

  it("refuses the invoking agent's own pid owner", () => {
    const pidOwner = `pid:700@${LSTART}`;
    protectedCase(
      { invOwnerPid: pidOwner },
      { owner: pidOwner },
      "belongs to the invoking agent (from slp-gc's own ancestry)",
    );
  });

  it("refuses the invoking agent's process subtree", () => {
    protectedCase({ invTree: [500] }, {}, "in the invoking agent's process subtree");
  });

  it("refuses an executable under /System or /Library, from either side", () => {
    protectedCase({}, { exe: "/System/Library/CoreServices/x" }, "executable under /System or /Library (system service): never garbage");
    protectedCase({}, { exe: "/Library/LaunchDaemons/x" }, "executable under /System or /Library (system service): never garbage");
    const d = orphanDecision({
      row: { ...row, cmd: "/Library/Application Support/x --serve" }, env: noEnv, ledger, ctx,
    });
    expect(d.stale.why).toContain("executable under /System or /Library");
  });

  it("refuses an .app bundle found through the command line", () => {
    const d = orphanDecision({ row: { ...row, cmd: "/Applications/X.app/Contents/MacOS/X" }, env: noEnv, ledger, ctx });
    expect(d.stale.why).toBe("protected: executable inside an .app bundle (GUI app / service): never garbage");
  });

  it("puts protection before every other arm", () => {
    // Protected *and* env-contradicting, exe-less, owner-less and unaged at once.
    const d = orphanDecision({
      row, env: { agent: "other-owner", home: "match", read: true },
      ledger: { ...ledger, exe: "", orphaned: 0 },
      ctx: { ...ctx, selfTree: [500], invoker: OWNER },
    });
    expect(d.stale.why).toBe("protected: in the GC's own process tree");
  });

  it("keeps an empty invoker and an empty tree from protecting anything", () => {
    const d = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, invoker: "", selfTree: [], invTree: [] } });
    expect(d.stale.eligible).toBe(true);
  });
});

describe("orphanDecision — age, threshold and identification", () => {
  it("refuses an orphan younger than the minimum age", () => {
    const d = orphanDecision({ row, env: noEnv, ledger: { ...ledger, orphaned: NOW - 300 }, ctx });
    expect(d.stale.why).toBe("orphaned 300s ago < 600s");
  });

  it("scales the minimum age from the configured minutes", () => {
    const young = { ...ledger, orphaned: NOW - 300 };
    expect(orphanDecision({ row, env: noEnv, ledger: young, ctx }).stale.eligible).toBe(false);
    expect(
      orphanDecision({ row, env: noEnv, ledger: young, ctx: { ...ctx, orphanMinAgeMin: 1 } }).stale.eligible,
    ).toBe(true);
  });

  it("refuses at exactly the minimum age minus one second", () => {
    const at = { ...ledger, orphaned: NOW - 600 };
    const under = { ...ledger, orphaned: NOW - 599 };
    expect(orphanDecision({ row, env: noEnv, ledger: at, ctx }).stale.eligible).toBe(true);
    expect(orphanDecision({ row, env: noEnv, ledger: under, ctx }).stale.eligible).toBe(false);
  });

  it("requires a proven orphan and the threshold for over-memory", () => {
    const big = new Map([[500, { mem: 9000, cmprs: 10 }]]);
    const proven = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, top: big } });
    expect(proven.overmem.eligible).toBe(true);
    expect(proven.overmem.why).toBe("proven orphan, footprint 9000 MB > 4096 MB");
    const unproven = orphanDecision({ row, env: noEnv, ledger: { ...ledger, exe: "" }, ctx: { ...ctx, top: big } });
    expect(unproven.overmem.eligible).toBe(false);
    expect(unproven.overmem.why).toContain("real executable path not recorded");
    // `$fpm <= $killMb` refuses (`:434`): exactly at the threshold is not over it.
    const exact = new Map([[500, { mem: 4096, cmprs: 10 }]]);
    const at = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, top: exact } });
    expect(at.overmem.eligible).toBe(false);
    expect(at.overmem.why).toBe("footprint 4096 MB <= 4096 MB");
    expect(at.stale.eligible).toBe(true);
  });

  it("keeps the threshold arm first in over-memory", () => {
    const d = orphanDecision({ row, env: noEnv, ledger: { ...ledger, exe: "" }, ctx });
    expect(d.overmem.why).toBe("footprint 40 MB <= 4096 MB");
    expect(d.stale.why).toContain("real executable path not recorded");
  });

  it("refuses both decisions when identification failed", () => {
    const identity = { ok: false, why: "no single \"Paseo Daemon\" child of the Supervisor", daemonPid: null, appPid: 100, supervisorPid: 150 };
    const big = new Map([[500, { mem: 9000, cmprs: 10 }]]);
    const d = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, identity, top: big } });
    expect(d.entry.proven).toBe(true);
    expect(d.stale.why).toBe('identification failed: no single "Paseo Daemon" child of the Supervisor');
    expect(d.overmem.why).toBe('identification failed: no single "Paseo Daemon" child of the Supervisor');
  });
});

describe("orphanDecision — entry shape and candidate selection", () => {
  it("emits the reference's orphan fields", () => {
    const d = orphanDecision({ row, env: noEnv, ledger, ctx });
    expect(d.entry).toEqual({
      pid: 500, ppid: 1, pgid: 500, lstart: LSTART, etime_s: 7200, class: "orphan",
      exe: "node", comm: "node", owner: OWNER, ownerState: null, proof: "ledger",
      orphanedAt: NOW - 8000, exePath: "/usr/local/bin/node",
      // `$e.read` is false in `noEnv`, and an unreadable env always reads as an
      // unreadable home (slp-gc.bash:429).
      envRead: false, home: "unreadable",
      rss_mb: 40, mem_mb: null, cmprs_mb: null, footprint_mb: 40, footprintSource: "rss",
      cmd: row.cmd, protected: null, proven: true, underDaemon: false, warn: false,
      hint: null, stale: d.stale, overmem: d.overmem,
    });
    expect(d.proof).toBe(d.entry.proof);
  });

  it("takes the footprint from top when it sampled the pid", () => {
    const d = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, top: new Map([[500, { mem: 3072.5, cmprs: 12 }]]) } });
    expect(d.entry).toMatchObject({ footprint_mb: 3072.5, footprintSource: "top", mem_mb: 3072.5, cmprs_mb: 12, warn: true });
    // `warn` is `footprint_mb >= $warnMb` (`:432`): at the threshold is a warn.
    const at = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, top: new Map([[500, { mem: 3072, cmprs: 0 }]]) } });
    expect(at.entry.warn).toBe(true);
    const under = orphanDecision({ row, env: noEnv, ledger, ctx: { ...ctx, top: new Map([[500, { mem: 3071.9, cmprs: 0 }]]) } });
    expect(under.entry.warn).toBe(false);
  });

  it("reads an unreadable env as an unreadable home", () => {
    const d = orphanDecision({ row, env: { agent: null, home: "match", read: false }, ledger, ctx });
    expect(d.entry.home).toBe("unreadable");
  });

  it("falls back to the command's executable when the ledger records none", () => {
    const d = orphanDecision({ row: { ...row, cmd: "/opt/bin/node x" }, env: noEnv, ledger: { ...ledger, exe: "" }, ctx });
    expect(d.entry.comm).toBe("node");
  });

  it("refuses a row that carries a class of its own", () => {
    // slp-gc.bash:399 selects `.class == null`: a classified row is never an
    // orphan descendant, and this function must not be talkable into one.
    const agentRow = { ...row, cmd: "claude --output-format stream-json --input-format stream-json --permission-prompt-tool x" };
    const d = orphanDecision({ row: agentRow, env: noEnv, ledger, ctx });
    expect(d.stale.eligible).toBe(false);
    expect(d.entry.proven).toBe(false);
  });

  it("refuses a row that is not reparented", () => {
    const d = orphanDecision({ row: { ...row, ppid: 400 }, env: noEnv, ledger, ctx });
    expect(d.stale.eligible).toBe(false);
    expect(d.entry.proven).toBe(false);
  });

  it("never proves a row that breaks any arm (cross-product sweep)", () => {
    // The whole proof surface at once: every owner record shape, three env
    // owners, blindness on and off, three orphan ages and five recorded
    // executables. Only `archived` + (no env owner, or the same owner) + sighted
    // + a recorded orphan age + an allowlisted exe may ever reach `proven`, and
    // the count pins that the sweep's positive arm really fires.
    const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
    const records: Record<string, { id: string; archivedAt: string | null }[]> = {
      none: [],
      archived: [{ id: OWNER, archivedAt: "2026-10-01T00:00:00.000Z" }],
      live: [{ id: OWNER, archivedAt: null }],
    };
    let proven = 0;
    let swept = 0;
    for (const [record, agents] of Object.entries(records)) {
      for (const envAgent of [null, "other", OWNER]) {
        for (const blindAgentPresent of [false, true]) {
          for (const orphaned of [0, NOW - 60, NOW - 8000]) {
            for (const exe of [
              "", "/usr/local/bin/node", "/usr/local/bin/rg",
              "/Applications/X.app/Contents/MacOS/X", "/System/Library/CoreServices/x",
            ]) {
              swept += 1;
              const d = orphanDecision({
                row, env: { agent: envAgent, home: "match", read: true },
                ledger: { ...ledger, exe, comm: base(exe), orphaned },
                ctx: { ...ctx, agents, blindAgentPresent },
              });
              if (!d.entry.proven) continue;
              proven += 1;
              expect({ record, envAgent, blindAgentPresent, orphaned, exe }).toEqual({
                record: "archived", envAgent,
                blindAgentPresent: false, orphaned: NOW - 8000, exe: "/usr/local/bin/node",
              });
              expect(d.stale.eligible).toBe(true);
              expect(d.overmem.eligible).toBe(false); // 40 MB, under the 4096 MB threshold
            }
          }
        }
      }
    }
    expect(swept).toBe(3 * 3 * 2 * 3 * 5);
    expect(proven).toBe(2);
  });
});

// The per-process half of the GC port: the process table the reference builds
// after classification (protection, ownership, footprint) and the three decision
// rules that read it — staleness, over-memory and the orphan proof.
//
// Reference (`agent-room/docs/gc-port/slp-gc.bash`, byte-identical to the
// deployed copy):
//
//   chainc                  slp-gc.bash:294   (the 40-step ppid walk)
//   the GC's own tree       slp-gc.bash:295-298
//   the invoking agent      slp-gc.bash:299-302
//   `$ours`                 slp-gc.bash:303   (rows worth reporting)
//   `$procs`                slp-gc.bash:304-320 (class, owner, ownerState, env/home, footprint, protected)
//   stale rule              slp-gc.bash:345-359
//   over-memory rule        slp-gc.bash:360-374
//   `underDaemon` / `warn`  slp-gc.bash:346, 375
//   `ost` (owner state)     slp-gc.bash:390-391
//   `$blindAgents`          slp-gc.bash:392, 474
//   `ldead` / `olive`       slp-gc.bash:393-398
//   `$orph` (orphan proof)  slp-gc.bash:399-437
//
// Two properties matter more than tidiness:
//
// 1. **Refusal order is the contract.** The `why` strings reach the user's
//    report and fail-closed behaviour depends on which check fires first, so the
//    order below is the reference's, branch for branch. Reordering the chain
//    changes what the operator is told and, for the fail-closed arms, which
//    check gets to answer at all.
// 2. **Nothing here throws and nothing here shells out.** `rows`, `top`, `env`
//    and the agent records arrive as values, and every one of them may be empty
//    — an empty table, no `top` sample, no env row and no agent record are all
//    ordinary, and each degrades to the fail-closed answer rather than an
//    exception. The only external behaviour is `classify()` from `procs.ts`.
//    Task 12 owns `ps`, `top`, `lsof` and the environment reads.
//
// `buildProcTable` is called twice in a tick, by construction: `underDaemon`
// needs the identified daemon pid, and identification needs the table's classes
// and homes. The pipeline is
//
//   const table = buildProcTable({ rows, top, env, agents, selfPid, warnMb });
//   const identity = resolveIdentity({ procs: table.procs, pidFile, listen, dupes, homeDefault });
//   const final = buildProcTable({ …input, daemonPid: identity.daemonPid });
//
// The second call is the same pure function over the same inputs, so the two
// tables cannot disagree about anything except `underDaemon`. Both builds are
// O(rows) and the table is a few hundred rows.
//
// **The first table is for identification only.** Without a `daemonPid` the
// builder cannot say which rows the daemon owns, so it marks every one of them
// daemon-owned (fail closed) rather than clearing them: the stale rule refuses
// on that flag, and a single-pass caller must never get a stale-eligible row for
// a process the daemon may own. Only the second build — the one handed the
// identified pid, or an explicit `null` after identification failed — may be
// judged by the two rules.
//
// The file also carries the record-level half of the port — the garbage
// decisions for agent and schedule records — which has its own header at the end
// of the file (slp-gc.bash:480-557). It shares nothing with the table above but
// the reference and the `Decision`-style vocabulary: it reads records, not
// processes.

import { classify, type ProcClass, type ProcRow, type TopRow } from "./procs";
import type {
  HomeState,
  IdentityFacts,
  ProcClassValue,
} from "./identity";
import { ledgerKey, type LedgerRow } from "./ledger";
import type { AgentRec, ScheduleRec } from "./agents";

/**
 * Agent classes whose process *is* an agent (`agentish`, slp-gc.bash:277): the
 * reference's own protection and ownership rules key on exactly these.
 */
export function isAgentChild(cls: ProcClassValue | null): boolean {
  return cls === "claude-child" || cls === "codex-child";
}

/** Agent classes plus the two wait helpers (`agentfam`, slp-gc.bash:278). */
export function isAgentFamily(cls: ProcClassValue | null): boolean {
  return isAgentChild(cls) || cls === "slp-wait" || cls === "paseo-wait";
}

/**
 * What the per-process rules are allowed to conclude about an owner agent
 * (slp-gc.bash:312, `$p.ownerState`):
 *
 * - `archived` / `live` — the record is in the index.
 * - `missing` — no record, and the index is complete, so the agent is gone.
 * - `unknown` — the index could not be trusted (empty, or a record failed to
 *   parse), so neither of the two above may be claimed.
 *
 * `null` (no owner at all) is a separate value; the stale rule refuses it
 * through its own arm (:355).
 */
export type OwnerState = "archived" | "live" | "missing" | "unknown";

/** One process's environment facts (slp-gc.bash:288, `$envBy`'s values). */
export interface EnvFacts {
  /** `PASEO_AGENT_ID` when it is a 36-character uuid-shaped token, else null. */
  agent: string | null;
  /** The `PASEO_HOME` verdict before the env-unreadable overlay. */
  home: Exclude<HomeState, "unreadable">;
  /** Whether the environment could be read at all. */
  read: boolean;
}

/** The two agent-record fields the table reads (AGENT_JQ's `{ok, id, archivedAt}`). */
export interface AgentOwner {
  id: string;
  /** `archivedAt` verbatim; non-null means archived (slp-gc.bash:290). */
  archivedAt: string | null;
}

/**
 * One row of the built table (`$procs`, slp-gc.bash:310-320).
 *
 * `DecisionEntry` is this without the diagnostics, so the two decision rules
 * accept a table row *and* a hand-built case in a test.
 */
export interface ProcEntry extends DecisionEntry {
  pgid: number;
  /** `ps`'s `lstart`, whitespace-collapsed. */
  lstart: string;
  /** `rss` in MB — the fallback footprint when `top` did not sample the pid. */
  rss_mb: number;
  /** `top`'s physical footprint, or null when `top` had no row for the pid. */
  mem_mb: number | null;
  /** `top`'s compressed segment, or null. */
  cmprs_mb: number | null;
  /** `footprint_mb`, and which of the two sources produced it. */
  footprintSource: "top" | "rss";
  /** `footprint_mb >= warnMb` (slp-gc.bash:375). */
  warn: boolean;
}

/** The table plus every pid in it (`$famPids`, slp-gc.bash:321). */
export interface ProcTable {
  procs: ProcEntry[];
  famPids: number[];
}

export interface ProcTableInput {
  /** The parsed `ps` table (`parsePs().rows`). */
  rows: readonly ProcRow[];
  /** `top -l 1 -stats pid,mem,cmprs`, parsed (`parseTop`). */
  top: ReadonlyMap<number, TopRow>;
  /** Per-pid environment facts (`collect_env`'s output). */
  env: ReadonlyMap<number, EnvFacts>;
  /** The agent index (`snapshotAgents().agents`). */
  agents: readonly AgentOwner[];
  /**
   * Whether the agent index is complete (`snapshotAgents().index.ok`) — the
   * reference's `$nbad > 0` arm (slp-gc.bash:312).
   *
   * **Defaults to `false`.** An owner with no record then reads `unknown` rather
   * than `missing`, and `missing` is the *only* owner state that proves an agent
   * is gone: it is what the stale rule signals on (arm 8). So it has to be opted
   * into, by a caller that has established the index was complete. A caller that
   * simply forgot the flag, or whose index lost a record, can therefore never
   * turn an unreadable index into kill eligibility.
   */
  agentIndexOk?: boolean;
  /** The GC's own pid (`$$`, the reference's `$selfPid`): its tree is protected. */
  selfPid: number;
  /** `PASEO_AGENT_ID` of the GC's own environment (`$invoker`), or null. */
  invoker?: string | null;
  /** `SLP_GC_MEM_WARN_MB` (`$warnMb`). */
  warnMb: number;
  /**
   * The identified daemon pid (`identity.daemonPid`). **Omit it on the first
   * build**; the three states are deliberately distinct, and only one of them is
   * "nothing is daemon-owned":
   *
   * - **absent** (`undefined`, the key not supplied) — identification has not run
   *   yet. Every row's `underDaemon` is `true`, so the stale rule refuses each
   *   one at its `daemon-owned` arm (:353). Fail closed: a table built before the
   *   daemon is known cannot prove that a row is *not* under it, and a
   *   single-pass caller must never get a stale-eligible daemon-owned process.
   * - **explicit `null`** — identification ran and found no single daemon, so no
   *   row is daemon-owned (`$idt.daemonPid != null and …`, :346) and
   *   `underDaemon` is `false` for every row. That is safe without the first
   *   rule's help: identification is not `ok`, so the stale rule's
   *   identification arm (:351) refuses first, before the daemon-owned arm could
   *   have said anything.
   * - **a pid** — `underDaemon` is true for that pid and its descendants, exactly
   *   as `chainc(.) | map(.pid) | index($idt.daemonPid)` (:346).
   */
  daemonPid?: number | null;
}

/**
 * One row, plus the class `classify` gave it. The reference keeps the classified
 * rows (`$cl`, slp-gc.bash:292) and resolves every pid through them (`$clBy`,
 * :293), so the ancestor walk must see *every* row — including the ones the
 * report later drops.
 */
interface ClassifiedRow extends ProcRow {
  class: ProcClass | null;
}

/** `def base: split("/") | last` (slp-gc.bash:201), for a token with no slash. */
function baseName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/** The table every `classify`, `chain` and `underDaemon` call is keyed on. */
interface Walk {
  byPid: Map<number, ClassifiedRow>;
  chain(row: ClassifiedRow | undefined): ClassifiedRow[];
}

/**
 * The reference's `chainc` (slp-gc.bash:294): a row, then its ancestors, walking
 * `ppid` up to 40 steps through *all* classified rows.
 *
 * It stops at ppid 1 (`$l.ppid > 1`), at a parent that is not in the table, and
 * on a cycle (the `index($par.pid) == null` guard), which is why a `ps` sample
 * taken mid-fork cannot loop. The row itself is element 0 — the reference's
 * `agentish` ancestor scan therefore sees a row that *is* an agent, and
 * `chainc(.) | map(.pid) | index($x)` includes the row's own pid.
 */
function buildWalk(rows: readonly ClassifiedRow[]): Walk {
  const byPid = new Map<number, ClassifiedRow>();
  for (const row of rows) byPid.set(row.pid, row);

  const chain = (row: ClassifiedRow | undefined): ClassifiedRow[] => {
    if (row === undefined) return [];
    const out: ClassifiedRow[] = [row];
    const seen = new Set<number>([row.pid]);
    for (let step = 0; step < 40; step++) {
      const last = out[out.length - 1]!;
      if (last.ppid <= 1) break;
      const parent = byPid.get(last.ppid);
      if (parent === undefined || seen.has(parent.pid)) break;
      out.push(parent);
      seen.add(parent.pid);
    }
    return out;
  };

  return { byPid, chain };
}

/**
 * Build the process table (slp-gc.bash:294-320, 346, 375).
 *
 * Order of operations, and why:
 *
 * 1. **Classify every row** (`$cl`, :292). The ancestor walk needs the classes
 *    of rows that never enter the report.
 * 2. **The GC's own tree** (:295-298): its ancestry, plus every row that
 *    descends from it. Both are protected — a GC that kills in its own subtree
 *    kills the tick that is doing the killing.
 * 3. **The invoking agent** (:299-302): the first agent-class process in the
 *    GC's own ancestry, and its whole subtree. Independent of any environment,
 *    because the env of the GC itself is not evidence about the agent that is
 *    watching.
 * 4. **`$ours`** (:303): rows with a class of their own, plus rows that descend
 *    from an agent-class process. A plain `node` under the daemon that no agent
 *    ever spawned is not part of the Paseo tree and is never reported or
 *    killed; the same `node` under a `claude-child` is an `agent-descendant`.
 * 5. **The per-row facts** (:304-320): env, owner, owner state, home, footprint,
 *    protection. `owner` comes from the row's own `PASEO_AGENT_ID`, falling back
 *    to the nearest agent-class ancestor's (`:306-308`) — a helper process
 *    inherits the agent that started it.
 * 6. **`underDaemon`** (:346, `$ud`) and **`warn`** (:375), the two facts that
 *    need an input the table itself does not carry (the identified daemon) or a
 *    configured threshold.
 */
export function buildProcTable(input: ProcTableInput): ProcTable {
  // Both defaults are fail-closed. An unstated index is an unproven index
  // (`unknown`, never `missing`), and an unstated daemon is an *unknown* daemon
  // owner (`underDaemon: true`, never `false`) — see the two options' docs.
  const agentIndexOk = input.agentIndexOk ?? false;
  const invoker = input.invoker === null || input.invoker === undefined || input.invoker === ""
    ? null
    : input.invoker;
  // Three states, not two: "identification has not run" is not "no daemon was
  // found". An absent key means the former and has to fail closed.
  const daemonPidSupplied = input.daemonPid !== undefined;
  const daemonPid = input.daemonPid ?? null;

  const classed: ClassifiedRow[] = input.rows.map((row) => ({
    ...row,
    class: classify(row.cmd),
  }));
  const walk = buildWalk(classed);

  // The GC's own tree: its ancestry (or just itself when the ps sample lost it).
  const selfRow = walk.byPid.get(input.selfPid);
  const selfAnc = selfRow !== undefined ? walk.chain(selfRow) : [];
  const selfTree = new Set<number>(
    selfRow !== undefined ? selfAnc.map((row) => row.pid) : [input.selfPid],
  );
  for (const row of classed) {
    if (walk.chain(row).some((anc) => anc.pid === input.selfPid)) selfTree.add(row.pid);
  }

  // The invoking agent, taken from the GC's own ancestry rather than from any env.
  const selfAgent = selfAnc.find((row) => isAgentChild(row.class));
  const invokerTree = new Set<number>(
    selfAgent === undefined
      ? []
      : classed
          .filter((row) => walk.chain(row).some((anc) => anc.pid === selfAgent.pid))
          .map((row) => row.pid),
  );

  // `$ownerBy`: id -> archived|live, from the records that are in the index.
  const ownerBy = new Map<string, "archived" | "live">();
  for (const rec of input.agents) {
    if (ownerBy.has(rec.id)) continue;
    ownerBy.set(rec.id, rec.archivedAt !== null ? "archived" : "live");
  }

  const procs: ProcEntry[] = [];
  for (const row of classed) {
    const ancestors = walk.chain(row);
    const agentAncestor = ancestors.find((anc) => isAgentChild(anc.class));
    // `$ours`: a class of its own, or an agent-class ancestor.
    if (row.class === null && agentAncestor === undefined) continue;

    const env = input.env.get(row.pid) ?? { agent: null, home: "none", read: false };
    const owner =
      env.agent ??
      (agentAncestor === undefined ? null : (input.env.get(agentAncestor.pid)?.agent ?? null));
    const ownerState: OwnerState | null =
      owner === null
        ? null
        : input.agents.length === 0
          ? "unknown"
          : // `missing` proves the agent is gone, so it needs a complete index
            // the caller vouched for; an unstated index leaves `unknown` (:312).
            (ownerBy.get(owner) ?? (agentIndexOk ? "missing" : "unknown"));
    const top = input.top.get(row.pid);
    const footprint = top === undefined ? row.rss_mb : top.mem;

    const protectedBy =
      selfTree.has(row.pid)
        ? "in the GC's own process tree"
        : owner !== null && invoker !== null && owner === invoker
          ? "belongs to the invoking agent"
          : invokerTree.has(row.pid)
            ? "in the invoking agent's process subtree"
            : null;

    procs.push({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      lstart: row.lstart,
      etime_s: row.etime_s,
      class: row.class ?? "agent-descendant",
      exe: baseName(row.cmd.split(" ")[0] ?? ""),
      owner,
      ownerState,
      envRead: env.read,
      home: env.read ? env.home : "unreadable",
      rss_mb: row.rss_mb,
      mem_mb: top === undefined ? null : top.mem,
      cmprs_mb: top === undefined ? null : top.cmprs,
      footprint_mb: footprint,
      footprintSource: top === undefined ? "rss" : "top",
      cmd: row.cmd,
      protected: protectedBy,
      // Absent daemon pid ⇒ ownership unknown ⇒ `true` (fail closed); explicit
      // `null` ⇒ identification found no daemon ⇒ `false` (:346).
      underDaemon: daemonPidSupplied
        ? daemonPid !== null && ancestors.some((anc) => anc.pid === daemonPid)
        : true,
      warn: footprint >= input.warnMb,
    });
  }

  return { procs, famPids: procs.map((entry) => entry.pid) };
}

/** `{ eligible: true }` or a refusal naming the rule that fired. */
export interface Decision {
  eligible: boolean;
  /** The reference's text, verbatim: this string is surfaced to the operator. */
  why: string;
}

/**
 * Everything the two rules read beyond the row itself. Named after the
 * reference's jq arguments so the mapping stays obvious:
 * `$idt`, `$killMb`, `$oc` (`killComms`), `$warnMb`, `$famPids`, and the
 * invoking agent's identity (`$invoker`, `$invSub`).
 */
export interface DecisionContext {
  /** `$idt` — the five fields a rule branches on. */
  identity: IdentityFacts;
  /** `$killMb`: `SLP_GC_MEM_KILL_MB`. */
  killMb: number;
  /** `$oc`: `SLP_GC_KILL_COMMS`. */
  killComms: readonly string[];
  /** `$warnMb`: `SLP_GC_MEM_WARN_MB`. Carried for the report; no rule here reads it. */
  warnMb: number;
  /** `$famPids`: every pid in the table — a live parent in it means "not orphaned". */
  famPids: readonly number[];
  /** `$invoker`: the invoking agent's id, or null when the GC was run by hand. */
  invoker?: string | null;
  /**
   * `$invSub`: the invoking agent's process subtree. Protection is already
   * encoded in `entry.protected`; this is carried for the tasks that report and
   * record it (7-11) rather than re-derived per call.
   */
  invTree?: readonly number[];
  /** Overrides the reference's 130 s minimum age for `slp-wait`/`paseo-wait` (`:348`). */
  minAgeWaitS?: number;
  /** Overrides the reference's 600 s minimum age for an agent child (`:348`). */
  minAgeAgentS?: number;
}

/**
 * The minimum orphan age the reference applies (slp-gc.bash:348): a wait helper
 * is cheap to mis-identify and exits on its own, an agent child is not, so the
 * bar is 130 s versus 600 s. Kept as two named constants so the rule and its
 * report text can never disagree.
 */
export const MIN_AGE_WAIT_S = 130;
export const MIN_AGE_AGENT_S = 600;

/**
 * The row facts the rules read — `ProcEntry` minus the diagnostics, so a test can
 * build a case out of exactly the fields a rule consults.
 */
export interface DecisionEntry {
  pid: number;
  ppid: number;
  class: ProcClassValue | null;
  /** `PASEO_AGENT_ID` of the row or of its nearest agent-class ancestor. */
  owner: string | null;
  ownerState: OwnerState | null;
  /** Whether the row's environment could be read at all. */
  envRead: boolean;
  home: HomeState;
  /** Age in seconds; `-1` when unreadable, which fails every minimum. */
  etime_s: number;
  footprint_mb: number;
  /**
   * Where `footprint_mb` came from (`:315`, `:431`): a `top` sample or the `rss`
   * fallback. The rule text prints the number the way jq renders *that* provenance
   * (see `footprintText`), so a row judged from `rss` says `115 MB` and a row
   * judged from `top` says `115.0 MB` — the reference's own difference.
   */
  footprintSource?: "top" | "rss";
  /** The basename of `argv[0]` — the comm the allowlist compares (slp-gc.bash:311, 373). */
  exe: string;
  /** Why this process must never be signalled, or null. */
  protected: string | null;
  /**
   * `$ud`: descends from the identified daemon (slp-gc.bash:346).
   *
   * `true` also covers "daemon ownership has not been established":
   * `buildProcTable` sets it on every row when it was not told which daemon to
   * trust, so this flag is a *refusal* signal as well as a fact. `false` is only
   * ever claimed by a caller that identified the absence of a daemon.
   */
  underDaemon: boolean;
  /** The command line with its argv, verbatim. */
  cmd: string;
}

/**
 * The stale rule (slp-gc.bash:345-359).
 *
 * An orphaned agent child or wait helper may be signalled only when *all* of the
 * following hold. The reference's order is preserved exactly, because each arm's
 * `why` is shown to the operator and because the fail-closed arms must be
 * reachable before anything weaker:
 *
 * 1. `agentfam` class — nothing else is ever stale-killed (`:349`).
 * 2. not protected (`:350`).
 * 3. identification succeeded (`:351`): with no proven Supervisor/daemon, no
 *    claim about what is "Paseo's" is trustworthy.
 * 4. `PASEO_HOME` is `match` (`:352`) — an `unreadable` env refuses here.
 * 5. not daemon-owned (`:353`): a process under the daemon is stopped through the
 *    daemon, never signalled. This arm is also the fail-closed answer for
 *    *unknown* ownership: a table built before the identified daemon pid was
 *    known carries `underDaemon: true` on every row (see `ProcTableInput`'s
 *    `daemonPid`), so a single-pass caller's rows are refused here rather than
 *    slipping through to eligibility. An explicit `daemonPid: null` means the
 *    opposite — identification found no daemon, so no row is owned, and the
 *    `identification failed` arm above has already refused every row.
 * 6. `ppid == 1`, or the parent is not a live Paseo process (`:354`).
 * 7. `ppid == 1`, or there is an owner (`:355`) — an orphan with no provenance
 *    cannot be traced back to an agent.
 * 8. `ppid == 1`, or the owner is `archived`/`missing` (`:356-357`).
 * 9. age at or above the class's minimum (`:358`).
 */
export function staleDecision(entry: DecisionEntry, ctx: DecisionContext): Decision {
  const minAge =
    entry.class === "slp-wait" || entry.class === "paseo-wait"
      ? (ctx.minAgeWaitS ?? MIN_AGE_WAIT_S)
      : (ctx.minAgeAgentS ?? MIN_AGE_AGENT_S);

  if (!isAgentFamily(entry.class)) {
    return { eligible: false, why: "not an agent-child/wait class" };
  }
  if (entry.protected !== null) {
    return { eligible: false, why: `protected: ${entry.protected}` };
  }
  if (!ctx.identity.ok) {
    return { eligible: false, why: `identification failed: ${ctx.identity.why}` };
  }
  if (entry.home !== "match") {
    return {
      eligible: false,
      why: `PASEO_HOME in the process env is "${entry.home}" (need match): cannot prove it belongs to this home`,
    };
  }
  if (entry.underDaemon) {
    return {
      eligible: false,
      why: "daemon-owned (runs under the daemon): use `paseo agent stop`; never signalled by the stale rule",
    };
  }
  if (entry.ppid !== 1 && ctx.famPids.includes(entry.ppid)) {
    return {
      eligible: false,
      why: `parent pid ${entry.ppid} is a live Paseo process: not orphaned`,
    };
  }
  if (entry.ppid !== 1 && entry.owner === null) {
    return { eligible: false, why: "no PASEO_AGENT_ID owner and ppid != 1" };
  }
  if (entry.ppid !== 1 && entry.ownerState !== "archived" && entry.ownerState !== "missing") {
    return {
      eligible: false,
      why: `not orphaned: ppid ${entry.ppid} and owner ${entry.owner ?? "?"} is ${entry.ownerState ?? "?"}`,
    };
  }
  if (entry.etime_s < minAge) {
    return {
      eligible: false,
      why: `orphan signature but age ${entry.etime_s}s < ${minAge}s`,
    };
  }
  return {
    eligible: true,
    why: `orphan: ${
      entry.ppid === 1
        ? "reparented to launchd (ppid==1)"
        : `parent is not a Paseo process and owner ${entry.owner} is ${entry.ownerState}`
    }, PASEO_HOME matches, age ${entry.etime_s}s >= ${minAge}s`,
  };
}

/**
 * The classes the memory rule may ever consider (`$memclass`, slp-gc.bash:360):
 * the app main's helper processes and agent descendants. Everything else — the
 * app main, the Supervisor, the daemon, the agent children themselves and the
 * wait helpers — is refused by its own arm above.
 */
const MEMORY_CLASSES: ReadonlySet<ProcClassValue> = new Set<ProcClassValue>([
  "renderer",
  "gpu",
  "utility",
  "agent-descendant",
]);

/**
 * The over-memory rule (slp-gc.bash:360-374).
 *
 * The reference's order again, exactly:
 *
 * 1. below or at the threshold — nothing to do (`:361`).
 * 2. app main or Supervisor — report only (`:362`).
 * 3. daemon — report only (`:363`).
 * 4. an agent child itself — report only, use `paseo agent stop` (`:364`).
 * 5. a class outside `$memclass` — refused (`:365`).
 * 6. not protected (`:366`).
 * 7. identification succeeded (`:367`).
 * 8. a renderer/gpu/utility must be a direct child of the identified app main
 *    (`:368-369`) — otherwise it is some other Chrome helper on the machine.
 * 9. an `agent-descendant` must descend from the identified daemon (`:370`).
 * 10. not an `.app` bundle's executable (`:371`).
 * 11. not under `/System` or `/Library` (`:372`).
 * 12. its comm is in the allowlist (`:373`).
 *
 * Rules 10-12 are only applied to `agent-descendant` rows, as in the reference:
 * the helper classes' threat model is different and their comms are not the
 * configurable allowlist.
 */
export function overmemDecision(entry: DecisionEntry, ctx: DecisionContext): Decision {
  if (entry.footprint_mb <= ctx.killMb) {
    return {
      eligible: false,
      why: `footprint ${footprintText(entry)} MB <= ${ctx.killMb} MB`,
    };
  }
  if (entry.class === "app-main" || entry.class === "supervisor") {
    return { eligible: false, why: "never killed: report only" };
  }
  if (entry.class === "daemon") {
    return {
      eligible: false,
      why: "report only: the daemon is never memory-killed (it is touched only through an explicit path)",
    };
  }
  if (isAgentChild(entry.class)) {
    return {
      eligible: false,
      why: "report only: an agent child itself is never memory-killed (use `paseo agent stop`)",
    };
  }
  if (entry.class === null || !MEMORY_CLASSES.has(entry.class)) {
    return { eligible: false, why: "class not allowed for a memory kill" };
  }
  if (entry.protected !== null) {
    return { eligible: false, why: `protected: ${entry.protected}` };
  }
  if (!ctx.identity.ok) {
    return { eligible: false, why: `identification failed: ${ctx.identity.why}` };
  }

  const helper =
    entry.class === "renderer" || entry.class === "gpu" || entry.class === "utility";
  if (helper && entry.ppid !== ctx.identity.appPid) {
    return {
      eligible: false,
      why: `report only: helper is not a direct child of the app main (pid ${ctx.identity.appPid}) that is the Supervisor's parent`,
    };
  }

  const descendant = entry.class === "agent-descendant";
  if (descendant && !entry.underDaemon) {
    return {
      eligible: false,
      why: `report only: not a descendant of the identified daemon (pid ${ctx.identity.daemonPid})`,
    };
  }

  // `$p.cmd | split(" -") | .[0]`: the executable part of the command line, cut
  // at the first argument-looking ` -` (slp-gc.bash:371-372).
  const executable = entry.cmd.split(" -")[0] ?? "";
  if (descendant && executable.includes(".app/")) {
    return {
      eligible: false,
      why: "report only: executable inside an .app bundle (GUI app / service): never killed",
    };
  }
  if (descendant && /^\/(?:System|Library)\//.test(executable)) {
    return {
      eligible: false,
      why: "report only: executable under /System or /Library (system service): never killed",
    };
  }
  if (descendant && !ctx.killComms.includes(entry.exe)) {
    return {
      eligible: false,
      why: `report only: comm "${entry.exe}" is not in SLP_GC_KILL_COMMS`,
    };
  }

  return {
    eligible: true,
    why: `footprint ${footprintText(entry)} MB > ${ctx.killMb} MB`,
  };
}

/**
 * `footprint_mb | tostring` in the reference's rule text (`:361`, `:374`, `:434`,
 * `:437`), reproduced with jq 1.7's number rendering.
 *
 * jq 1.7 keeps a number's **original literal**, so a footprint that arrived as
 * `top`'s `%.1f` text (`115.0`) prints as `115.0`; the `rss` fallback is *computed*
 * (`(.rss | tonumber) / 1024 | mb1`, `:285`) and prints as a plain number (`115`).
 * The two sources are therefore rendered differently on purpose, and the port's
 * report said `115 MB` for both until the equivalence harness compared the text.
 */
function footprintText(entry: { footprint_mb: number; footprintSource?: "top" | "rss" }): string {
  return entry.footprintSource === "top"
    ? entry.footprint_mb.toFixed(1)
    : String(entry.footprint_mb);
}

// ---------------------------------------------------------------------------
// The orphan proof (slp-gc.bash:390-437)
// ---------------------------------------------------------------------------
//
// Everything above judges a row that classification gave a class to. The orphan
// block judges the one kind of row that has **none**: a `ppid == 1` process that
// no longer has an agent ancestor to explain it. It is the rule that must never
// signal a live process, so it proves its subject dead from three independent
// sources — the lineage ledger (`pid+lstart`), the agent index, and the process
// table — and refuses on the first one that cannot answer.
//
// The two decision rules above are *not* reused for it, and the reference does
// not reuse them either (`:433-437`): an orphan entry's class is the literal
// `"orphan"`, which both of those rules refuse at their class arm, and their
// remaining arms (PASEO_HOME, daemon descent, the `.app`/comm arms) are already
// folded into the proof. What *is* shared is the vocabulary: `Decision`, the
// `identification failed: …` sentence, the threshold sentence and `baseName`.
//
// Two properties matter more than tidiness:
//
// 1. **The order is the proof** (`:419-426`): protection, an env/ledger owner
//    contradiction, a missing recorded executable, the comm allowlist, a missing
//    process table, the dead-owner proof, `orphanedAt == 0`, the minimum age, then
//    proven. Every arm before the last one is a refusal, and the dead-owner arm is
//    the only place the agent index and the process table have to agree.
// 2. **`ldead` fails closed at every unknown** (`:393-395`): no owner, an
//    unreadable environment anywhere in the agent family, an index that is empty
//    or incomplete, a record that says `live` — each one means "treat the owner
//    as live", and a live owner is never an orphan.
//
// Nothing here reads a clock or a process table: `now`, the ledger row, the env
// verdict, the agent index and the built table all arrive as values. Task 12 owns
// `ps`, `lsof`, the environment reads and the tick's own timing.

/**
 * One row of the built table, as the orphan proof reads it — the reference's
 * `$procs` (`:304-320`) narrowed to the five fields `ost`, `$blindAgents`,
 * `ldead` and the `pid:` live check consult. A `ProcEntry` satisfies it as is.
 */
export interface OrphanTableRow {
  pid: number;
  /** `ps`'s `lstart`, whitespace-collapsed. Part of the ledger's identity. */
  lstart: string;
  class: ProcClassValue | null;
  /** `PASEO_AGENT_ID` of the row or of its nearest agent-class ancestor. */
  owner: string | null;
  /** Whether the row's environment could be read at all. */
  envRead: boolean;
}

/**
 * Everything the orphan proof reads beyond the row, its env verdict and its
 * ledger row. Named after the reference's jq arguments, like `DecisionContext`.
 *
 * The optional fields are the ones the reference computes from inputs a single
 * row cannot carry. Each defaults to the reading its own doc states: the two that
 * can only *withhold* a proof (`agents`, `agentIndexOk`) default to the closed
 * answer, and `procs` — the one input whose absence could *widen* a proof — is
 * required rather than defaulted, so it can never be forgotten.
 */
export interface OrphanContext {
  /** `$now`: epoch seconds, read once by the caller. */
  now: number;
  /** `$idt` — the identification the orphan's own stale/over-memory answers carry. */
  identity: IdentityFacts;
  /** `$killMb`: `SLP_GC_MEM_KILL_MB`. */
  killMb: number;
  /** `$oc` (`$orphanComms`): the comms an orphan descendant may be signalled by. */
  killComms: readonly string[];
  /** `$warnMb`: `SLP_GC_MEM_WARN_MB`, reported as `warn` and read by no arm. */
  warnMb: number;
  /** `SLP_GC_ORPHAN_MIN_AGE_MIN`; the reference multiplies it by 60 (`:785`). */
  orphanMinAgeMin: number;
  /**
   * `$agentIdx`, reduced to the records that parsed (`map(select(.ok))`, `:290`).
   * An **empty** index is `unknown`, never `missing` (`:390`) — a GC that could
   * not read the index learns nothing about its agents.
   */
  agents: readonly AgentOwner[];
  /**
   * Whether the index was complete (`$nbad == 0`, `:291`). **Defaults to
   * `false`**, so a `missing` record — the only owner state that helps prove an
   * agent is gone — has to be opted into by a caller that checked the index.
   */
  agentIndexOk?: boolean;
  /** `$topBy`: the `top` sample, when it had a row for the pid. */
  top?: ReadonlyMap<number, TopRow>;
  /**
   * `$procs`: the built table (`buildProcTable().procs`). Three answers depend on
   * it — the agent-class owner scan in `ldead` (`:395`), `$blindAgents` (`:392`)
   * and the live half of a `pid:<n>@<lstart>` owner (`:394`).
   *
   * **Required**, because those three answers are the whole of the fail-closed
   * arm: absent, the table would clear all three at once (nothing is blind, no
   * `pid:` owner is live, no agent-class process carries any id), which is the
   * one direction a proof must never move. A required field can still arrive as
   * `undefined` from a JavaScript caller, so `orphanDecision` refuses on that
   * explicitly (`proven: false`, a "missing process table" reason) instead of
   * reading it as an empty table; pass `[]` for a tick that genuinely saw no
   * agent-class process. Task 12 must pass `buildProcTable().procs`.
   */
  procs: readonly OrphanTableRow[];
  /** `$invoker`: the invoking agent's id, or null/"" when the GC was run by hand. */
  invoker?: string | null;
  /** `$invOwnerPid`: `pid:<n>@<lstart>` of the invoking agent, or null. */
  invOwnerPid?: string | null;
  /** `$invSub`: the invoking agent's process subtree. */
  invTree?: readonly number[];
  /** `$selfTree`: the GC's own process tree, ancestry plus descendants. */
  selfTree?: readonly number[];
  /**
   * `$blindAgents`: some `agentfam` row's environment could not be read (`:392`).
   *
   * Passed **in addition to** `procs`, never instead of it: blindness is the or
   * of both, so a caller can only ever add a refusal here. Task 12 computes it as
   * `procs.some(p => isAgentFamily(p.class) && !p.envRead)` (the reference's own
   * expression) or hands in the table and lets this function derive it.
   */
  blindAgentPresent?: boolean;
}

/**
 * One orphan entry — the reference's `$orph` object (`:427-437`), field for field.
 *
 * `class` is the literal `"orphan"` (it is not a product of `classify`),
 * `ownerState` is always null (an orphan's owner state is answered by the proof,
 * not by the record alone) and `underDaemon` is always false: a row under the
 * daemon would have a `Paseo` ancestor and therefore a class.
 */
export interface OrphanEntry {
  pid: number;
  ppid: number;
  pgid: number;
  lstart: string;
  etime_s: number;
  class: "orphan";
  /** The basename of the real executable — `comm` (`:405`, `:427`). */
  exe: string;
  comm: string;
  owner: string | null;
  ownerState: null;
  proof: "ledger" | "env";
  /** `$oat`: the ledger's ppid-1 first-seen, or 0 while it is not recorded. */
  orphanedAt: number;
  /** `$rexe`: the real executable path from the ledger, or "" when unrecorded. */
  exePath: string;
  envRead: boolean;
  home: HomeState;
  rss_mb: number;
  mem_mb: number | null;
  cmprs_mb: number | null;
  footprint_mb: number;
  footprintSource: "top" | "rss";
  cmd: string;
  protected: string | null;
  proven: boolean;
  underDaemon: false;
  warn: boolean;
  /** `hint` is the reference's placeholder for a future remediation (`:432`). */
  hint: null;
  stale: Decision;
  overmem: Decision;
}

/** The three values `orphanDecision` answers with, plus the entry they describe. */
export interface OrphanDecision {
  entry: OrphanEntry;
  /** `$led != null ? "ledger" : "env"` (`:428`) — the *source*, not a proof. */
  proof: "ledger" | "env";
  /** `$orph[].stale` (`:433`). */
  stale: Decision;
  /** `$orph[].overmem` (`:434-437`). */
  overmem: Decision;
}

export interface OrphanInput {
  /** An unclassified `ps` row the caller saw at `ppid == 1` (`:399`). */
  row: ProcRow;
  /** `$envBy[pid]`, or the reference's default `{agent: null, home: "none", read: false}`. */
  env: EnvFacts;
  /** `$ledBy[pid|lstart]` — the proof row, when the ledger has one (`:401`). */
  ledger?: LedgerRow | null;
  ctx: OrphanContext;
}

/**
 * The orphan proof (slp-gc.bash:399-437).
 *
 * The reference's per-row block, in its own order:
 *
 * | # | Arm | Reference |
 * |---|---|---|
 * | — | candidate: no class of its own, `ppid == 1` | `:399` (the `select`) |
 * | 1 | protection: own tree, invoking agent, invoking agent's pid owner, invoking agent's subtree, `.app` bundle, `/System`/`/Library` | `:411-417`, `:419` |
 * | 2 | the current env contradicts the ledger owner | `:420` |
 * | 3 | no real executable path recorded in the ledger | `:421` |
 * | 4 | the recorded comm is not in `SLP_GC_KILL_COMMS` | `:422` |
 * | 4a | the process table is absent (`ctx.procs === undefined`) | — (the port's own guard; see `OrphanContext.procs`) |
 * | 5 | `ldead($owner)` — the owner is treated as live (fail closed) | `:423` |
 * | 6 | `orphanedAt == 0`: no ledger ppid-1 first-seen yet | `:424` |
 * | 7 | `now - orphanedAt < SLP_GC_ORPHAN_MIN_AGE_MIN * 60` | `:425` |
 * | 8 | proven | `:426` |
 *
 * Arms 1-7 are refusals. Protection comes first because it is the only arm that
 * needs nothing but the row; the owner contradiction comes next because a ledger
 * row and an env that name two different agents prove nothing about either; the
 * dead-owner arm comes after the cheap syntactic arms so that a process we
 * would never signal costs no owner lookup.
 *
 * Arm 4a sits immediately before the arm it protects because arms 1-4 answer
 * from the row, the env and the ledger alone: a caller that never supplied the
 * table still gets each of those arms' own sentence, and only the answers that
 * *need* the table refuse on its absence.
 *
 * The candidate check is the reference's `select` (`:399`, `:403`), which drops
 * a row rather than judging it. Here it refuses instead, so a caller that hands
 * in every `ppid == 1` row it saw gets an answer for each one and can never
 * mistake a dropped row for a proven one. Its two sentences are the only strings
 * in this function the reference does not itself emit, and no input the reference
 * would have judged can reach them.
 */
export function orphanDecision(input: OrphanInput): OrphanDecision {
  const { row, env, ctx } = input;
  const ledger = input.ledger ?? null;
  // `procs` is required in the type, but a required field is still `undefined` at
  // runtime when a JavaScript caller forwards an optional value (`procs: tbl`).
  // An absent table must never be read as an empty one: it would clear three
  // owner guards at once (blindness, a live `pid:` owner, an agent-class
  // carrier), so the verdict refuses on it below. The `?? []` only keeps the two
  // derived sets total for the arms that never consult them.
  const table = ctx.procs as readonly OrphanTableRow[] | undefined;
  const procs = table ?? [];
  const top = ctx.top ?? new Map<number, TopRow>();
  const invoker = ctx.invoker === null || ctx.invoker === undefined || ctx.invoker === ""
    ? null
    : ctx.invoker;
  const invOwnerPid = ctx.invOwnerPid ?? null;
  const selfTree = ctx.selfTree ?? [];
  const invTree = ctx.invTree ?? [];
  const agentIndexOk = ctx.agentIndexOk ?? false;
  // `--argjson orphanMinAge $((ORPHAN_MIN_AGE_MIN * 60))` (slp-gc.bash:785).
  const orphanMinAge = ctx.orphanMinAgeMin * 60;

  const proof: "ledger" | "env" = ledger !== null ? "ledger" : "env";
  // `$led.exe // ""` (`:404`). Without a ledger row there is no recorded
  // executable, and the arm below refuses on exactly that — an env proof seeds
  // the ledger (`:464-465`) and never kills on its own.
  const exePath = ledger?.exe ?? "";
  // `if $rexe != "" then base($rexe) else ($r.cmd | split(" ") | .[0] | base)` (`:405`).
  const comm = exePath !== "" ? baseName(exePath) : baseName(row.cmd.split(" ")[0] ?? "");
  // `($r.cmd | split(" -") | .[0])` (`:406`): the executable part of the command.
  const exe = row.cmd.split(" -")[0] ?? "";
  // `def fp` (`:377`): `top`'s footprint when it sampled the pid, else `rss`.
  const sample = top.get(row.pid);
  const footprint = sample === undefined ? row.rss_mb : sample.mem;
  // `($led.owner // $e.agent)` (`:408`): the ledger's owner wins when it has one.
  const owner = ledger?.owner ?? env.agent;
  // `if $led != null then ($led.orphaned // 0) else 0 end` (`:409`).
  const orphanedAt = ledger === null ? 0 : (ledger.orphaned ?? 0);

  // `$ownerBy` (`:290`), first record wins, exactly as `buildProcTable` builds it.
  const ownerBy = new Map<string, "archived" | "live">();
  for (const rec of ctx.agents) {
    if (ownerBy.has(rec.id)) continue;
    ownerBy.set(rec.id, rec.archivedAt !== null ? "archived" : "live");
  }

  /** `def ost($o)` (slp-gc.bash:390-391). */
  const ownerState = (id: string | null): OwnerState | null => {
    if (id === null) return null;
    // An empty index (or one whose every record failed to parse) is `unknown`:
    // a GC that could not read the index has learned nothing about its agents.
    if (ctx.agents.length === 0) return "unknown";
    // `missing` proves the agent is gone, so it needs a complete index.
    return ownerBy.get(id) ?? (agentIndexOk ? "missing" : "unknown");
  };

  // `$blindAgents` (`:392`): any `agentfam` row whose environment could not be
  // read. Both sources can only add blindness, never clear it.
  const blind =
    ctx.blindAgentPresent === true ||
    procs.some((proc) => isAgentFamily(proc.class) && !proc.envRead);

  // `$liveSet`'s keys, as the built table can answer them (see `OrphanContext.procs`).
  //
  // The equivalence holds only for the `pid:` tokens the record tick itself
  // writes: `$liveSet` in the reference is built from **every** `ps` row (`:343`),
  // while this set is built from the filtered table (`$ours`, `:303`), which
  // holds only rows with a class or an agent-class ancestor. For a token naming a
  // row outside that filter the two would read differently — the reference would
  // find the row live and this set would not — so a foreign `pid:` token (one
  // written by something other than the record tick) is a known divergence, in
  // the "calls it dead" direction. The record tick writes the token from the
  // agent process it just observed, which always has a class of its own, so the
  // token the port actually produces is always in the table.
  const liveKeys = new Set(procs.map((proc) => ledgerKey(proc.pid, proc.lstart)));

  /**
   * `def ldead($o)` (slp-gc.bash:393-395): can this owner be proven gone?
   *
   * Every unknown answers `false`, which the decision reads as "live":
   *
   * - a blind agent family (`:393`) — any agent-class process with an unreadable
   *   env might be the owner we are asking about, so no owner is dead;
   * - no owner at all;
   * - a `pid:<n>@<lstart>` owner, unless no live row carries that pid *and* start
   *   time (`:394`) — the start time is what makes a recycled pid dead;
   * - an agent id, unless the record says `archived`/`missing` **and** no
   *   agent-class process still carries that id (`:395`). `live` and `unknown`
   *   both refuse: a record is the only thing that can prove an agent gone.
   */
  const deadOwner = (id: string | null): boolean => {
    if (blind) return false;
    if (id === null) return false;
    if (id.startsWith("pid:")) {
      // `$o | ltrimstr("pid:") | split("@") | (.[0] + "|" + (.[1:] | join("@")))`.
      // A non-canonical token (`pid:07@…`) can only make the answer more
      // conservative: the ledger validates the token as digits, so the number is
      // exact for every row the reference would have kept.
      const [pidPart, ...rest] = id.slice("pid:".length).split("@");
      return !liveKeys.has(ledgerKey(Number(pidPart), rest.join("@")));
    }
    const state = ownerState(id);
    return (
      (state === "archived" || state === "missing") &&
      !procs.some((proc) => isAgentChild(proc.class) && proc.owner === id)
    );
  };

  /** `$prot` (slp-gc.bash:411-417), in the reference's order. */
  const protectedBy = ((): string | null => {
    if (selfTree.includes(row.pid)) return "in the GC's own process tree";
    if (invoker !== null && owner === invoker) return "belongs to the invoking agent";
    if (invOwnerPid !== null && owner === invOwnerPid) {
      return "belongs to the invoking agent (from slp-gc's own ancestry)";
    }
    if (invTree.includes(row.pid)) return "in the invoking agent's process subtree";
    if (/\.app\//.test(exe) || /\.app\//.test(exePath)) {
      return "executable inside an .app bundle (GUI app / service): never garbage";
    }
    if (/^\/(?:System|Library)\//.test(exe) || /^\/(?:System|Library)\//.test(exePath)) {
      return "executable under /System or /Library (system service): never garbage";
    }
    return null;
  })();

  /** `$ov` (slp-gc.bash:418-426): the proof, or the first arm that refused it. */
  const verdict = ((): { proven: boolean; why: string } => {
    // The reference's `select` (`:399`): neither a class of its own nor `ppid 1`
    // is an orphan descendant. Refused rather than dropped — see the doc above.
    const own = classify(row.cmd);
    if (own !== null) {
      return {
        proven: false,
        why: `not an orphan: the row is classified "${own}" (an orphan has no class of its own)`,
      };
    }
    if (row.ppid !== 1) {
      return {
        proven: false,
        why: `not an orphan: ppid ${row.ppid} (an orphan is reparented to launchd, ppid 1)`,
      };
    }
    if (protectedBy !== null) return { proven: false, why: `protected: ${protectedBy}` };
    if (ledger !== null && env.agent !== null && env.agent !== ledger.owner) {
      return {
        proven: false,
        why: `the current env PASEO_AGENT_ID ${env.agent} contradicts the ledger owner ${ledger.owner}: no proof`,
      };
    }
    if (exePath === "") {
      return {
        proven: false,
        why: "real executable path not recorded in the ledger (needs the ledger row from a record tick): no proof",
      };
    }
    if (!ctx.killComms.includes(comm)) {
      return {
        proven: false,
        why: `report only: executable "${exePath}" (comm "${comm}") is not in SLP_GC_KILL_COMMS`,
      };
    }
    // The table is what arms 5's three answers are made of, so its absence is
    // refused immediately before them — every arm above answers from the row, the
    // env and the ledger alone and keeps its own sentence.
    if (table === undefined) {
      return {
        proven: false,
        why: "missing process table (ctx.procs is undefined): the owner-liveness checks (blind agent family, pid:N@lstart, agent-class carrier) cannot run without it: no proof",
      };
    }
    if (!deadOwner(owner)) {
      return {
        proven: false,
        why: `owner ${owner ?? "?"} is treated as LIVE (fail closed): it is dead only if its record is archived or missing (a valid record, not unknown) or its pid:N@lstart child is gone, and no agent-class process may have an unreadable env: not an orphan`,
      };
    }
    if (orphanedAt === 0) {
      return {
        proven: false,
        why: "orphaned-at not recorded yet (no ledger ppid-1 first-seen): waits for the next record tick",
      };
    }
    if (ctx.now - orphanedAt < orphanMinAge) {
      return { proven: false, why: `orphaned ${ctx.now - orphanedAt}s ago < ${orphanMinAge}s` };
    }
    return {
      proven: true,
      why: `orphaned agent descendant: ppid 1, proven by ${
        ledger !== null ? "the lineage ledger (pid+lstart)" : "env PASEO_HOME + PASEO_AGENT_ID"
      }, owner not live, comm ${comm}, orphaned ${ctx.now - orphanedAt}s >= ${orphanMinAge}s`,
    };
  })();

  const proven = verdict.proven;
  const why = verdict.why;

  // `stale` (`:433`): the proof, refused outright when identification failed.
  const stale: Decision =
    proven && !ctx.identity.ok
      ? { eligible: false, why: `identification failed: ${ctx.identity.why}` }
      : { eligible: proven, why };

  // `overmem` (`:434-437`), in the reference's own order: the threshold is
  // checked before the proof, so a small unproven row reports its footprint.
  // The text renders the footprint from the same source the row's decision used
  // (`:434-437` again; see `footprintText`).
  const footprintEntry = {
    footprint_mb: footprint,
    footprintSource: sample === undefined ? ("rss" as const) : ("top" as const),
  };
  const overmem: Decision =
    footprint <= ctx.killMb
      ? { eligible: false, why: `footprint ${footprintText(footprintEntry)} MB <= ${ctx.killMb} MB` }
      : !proven
        ? { eligible: false, why }
        : !ctx.identity.ok
          ? { eligible: false, why: `identification failed: ${ctx.identity.why}` }
          : {
              eligible: true,
              why: `proven orphan, footprint ${footprintText(footprintEntry)} MB > ${ctx.killMb} MB`,
            };

  const entry: OrphanEntry = {
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    lstart: row.lstart,
    etime_s: row.etime_s,
    class: "orphan",
    exe: comm,
    comm,
    owner,
    ownerState: null,
    proof,
    orphanedAt,
    exePath,
    envRead: env.read,
    home: env.read ? env.home : "unreadable",
    rss_mb: row.rss_mb,
    mem_mb: sample === undefined ? null : sample.mem,
    cmprs_mb: sample === undefined ? null : sample.cmprs,
    footprint_mb: footprint,
    footprintSource: sample === undefined ? "rss" : "top",
    cmd: row.cmd,
    protected: protectedBy,
    proven,
    underDaemon: false,
    warn: footprint >= ctx.warnMb,
    hint: null,
    stale,
    overmem,
  };

  return { entry, proof, stale, overmem };
}

// ---------------------------------------------------------------------------
// Garbage decisions for agents and schedules (slp-gc.bash:480-557)
// ---------------------------------------------------------------------------
//
// The third rule family: which *records* may be deleted at all. Everything
// above judges a process; this judges an archived agent record and a completed
// schedule record, and it is the only place the port answers "garbage".
//
//   EVAL_JQ                      slp-gc.bash:480
//   `$agents` / `$sch`           :482     (both record scans, already parsed)
//   `$trusted`                   :484     (at least one record parsed)
//   `$A`                         :485     (id -> record)
//   `$procOwners`                :486     (agents a live process still carries)
//   `$liveParents`               :487     (agents an unarchived record claims as parent)
//   `$schedTargets`              :488     (agents an active/paused schedule targets)
//   `$blind` / `$procs.envBlind` :489     (the `needsProof` NOTE)
//   `$idxwhy`                    :490
//   `astate`                     :491-494 (archived|live|unreadable|missing|unknown)
//   agent rows                   :495-522
//   schedule rows                :523-548
//   `$garbage`                   :557     (schedule rows first, then agent rows)
//   `sig`                        :883, 893-897 (inode:size:mtime of each candidate)
//
// Four properties matter more than tidiness:
//
// 1. **The reference's order is the contract, again.** Every row is refused by
//    the *first* arm that fails, and the arms are ordered exactly as the
//    reference ordered them: the syntactic `skipped:` gates (`:497-499`,
//    `:525-526`) before any judgement, then `archivedAt == null` (`:500-502`),
//    then the fail list (`:504-515`, `:531-541`). An operator reads the first
//    failing rule, and the fail-closed arms must answer before anything weaker.
//
// 2. **The index refuses everything.** `$idx.ok` is the second-to-last fail
//    (`:514`, `:540`), but because *any* fail makes a row non-garbage, an
//    incomplete index makes every row non-garbage — the reference's report says
//    so in as many words (`:928`). The arm is kept inside the fail list rather
//    than lifted to a pre-check so that the row still carries the more specific
//    reason when one fired first.
//
// 3. **`path` and `sig` are re-derived, not dropped.** `AgentRec` / `ScheduleRec`
//    are the record snapshots of `agents.ts`, which reduces a record to the keys
//    the deletion rule reads and keeps neither the file path nor its stat. The
//    reference's basename gate (`:497`, `:525`) and its `sig` (`:883`) are
//    therefore *not* evaluable from a bare record. This module re-derives what
//    the id determines and refuses nothing it can decide:
//    - `schedules/<id>.json` is exact — the schedule scan is flat (`:650`), so
//      the path is the id.
//    - `agents/*/<id>.json` is the agent path with the workspace directory left
//      as `*`: the scan keeps one level of directory (`:628-629`) and the
//      snapshot does not retain its name. The `*` is deliberate — it cannot be
//      mistaken for a path to stat or delete.
//    - the 8-hex id gate (`:525`) is **id-only** in the reference and is applied
//      here unconditionally.
//    - the basename-equals-id half of both gates needs the real file name, so it
//      is applied when the caller supplies `path` (the record tick can, it just
//      scanned the file) and is unverifiable when it does not. Nothing is
//      silently dropped: `agents.ts` fails the whole index on a record it could
//      not reduce, and the *apply* step re-stats the file it is about to unlink
//      (`:1054-1057`, `:1080-1083`), which is where the gate is load-bearing. Callers that can
//      supply `path`/`sig` should; `sig: ""` means "unverified" and must be
//      refused by whoever acts on it.
//
// 4. **Pure.** `now`, `minDays`, both record arrays, the two ref sets, the live
//    owners and the index state all arrive as values. Nothing here reads a
//    clock, a file or the process table, and nothing throws.
//
// `refusedBy` names the rule that failed, in the machine-readable form
// `<rule>: <reference text>`: the key is stable (the screen can group by it) and
// the text is the reference's, verbatim. `reason` carries the reference's whole
// `reason` sentence — the joined fail list for a refused row, the `GARBAGE:`
// sentence for an eligible one — so the operator sees everything the reference
// would have printed even though `refusedBy` names only the first failure.

/**
 * A set of ids, or the list a caller collected them into. `$busyRefs`,
 * `$rawRefs` and `$procOwners` are all jq arrays in the reference; a `Set` is
 * the useful shape here, so both are accepted.
 */
type RefIds = readonly string[] | ReadonlySet<string>;

/** The empty set, shared so a caller that supplies nothing allocates nothing. */
const NO_REFS: ReadonlySet<string> = new Set<string>();

/** Normalise a ref collection to a set, once per call. */
function refIds(refs: RefIds | null | undefined): ReadonlySet<string> {
  if (refs === null || refs === undefined) return NO_REFS;
  if (Array.isArray(refs)) return new Set<string>(refs as readonly string[]);
  return refs as ReadonlySet<string>;
}

/**
 * One agent record, plus the two crumbs `agents.ts` does not keep — see
 * property 3 above. Both are optional, and a bare `AgentRec` is assignable to
 * this type, so a caller that never statted a file is not forced to invent one.
 */
export interface AgentRecord extends AgentRec {
  /** The record file's path, when the caller still has it (`$r.path`). */
  path?: string;
  /** `inode:size:mtime` of that file (`$sigBy[.path]`, `:893-897`), else "". */
  sig?: string;
}

/** One schedule record, plus the same two crumbs. */
export interface ScheduleRecord extends ScheduleRec {
  path?: string;
  sig?: string;
}

/** The two rules that can make a candidate eligible, named for the screen. */
export type GarbageRule = "agent-archived" | "schedule-completed";

/**
 * One row of the decision — the reference's `$agentRows` / `$schedRows` row
 * (`:495-548`), reduced to what a screen needs. Every record handed in produces
 * exactly one candidate, eligible or not, so a row can never be dropped and
 * mistaken for a decision.
 */
export interface GarbageCandidate {
  kind: "agent" | "schedule";
  id: string;
  /** The record's path when the caller supplied it, else the derived locator. */
  path: string;
  /** The file's `inode:size:mtime` when the caller supplied it, else `""`. */
  sig: string;
  /** The rule that *would* make this row garbage, eligible or not. */
  rule: GarbageRule;
  /**
   * `null` when the row is garbage. Otherwise `<rule>: <reference text>` — the
   * first arm that failed, named, so the screen can show and group it.
   */
  refusedBy: string | null;
  /** The reference's `reason` sentence, verbatim (the joined fail list when refused). */
  reason: string;
  /** The reference's `action` for an eligible row, else `null` (`action: "none"`). */
  action: string | null;
}

/**
 * Everything the garbage rules read. Named after the reference's jq arguments,
 * like `DecisionContext` and `OrphanContext`, so the mapping stays obvious.
 */
export interface GarbageInput {
  /** `$now`: epoch seconds, read once by the caller. */
  now: number;
  /** `$minDays`: `SLP_GC_AGENT_MIN_DAYS`, 14 by default (slp-gc.bash:32). */
  minDays: number;
  /** `$agents`: the agent index (`snapshotAgents().agents`). */
  agents?: readonly AgentRecord[];
  /** `$sch`: the schedule index (`snapshotSchedules().schedules`). */
  schedules?: readonly ScheduleRecord[];
  /**
   * `$idx.ok`: both scans complete (`snapshotAgents().index.ok &&
   * snapshotSchedules().index.ok`; the reference has one index for both).
   *
   * **Defaults to `false`** — an unstated index is an unproven one, and the
   * reference's answer to an unproven index is "nothing is garbage" (:928).
   */
  indexOk?: boolean;
  /** `$idx.why`: every reason a scan recorded, joined verbatim into `$idxwhy`. */
  indexWhy?: readonly string[];
  /** `$busyRefs`: ids an in-flight creation references. */
  busyRefs?: RefIds | null;
  /** `$rawRefs`: ids mentioned by a record that could not be parsed. */
  rawRefs?: RefIds | null;
  /** `$procOwners`: owners of the processes in the table (procs plus orphans). */
  procOwners?: RefIds | null;
  /** `$invoker`: the invoking agent's id, or null/"" when run by hand. */
  invoker?: string | null;
  /**
   * `$procs.ident.ok` / `.why`: whether Supervisor/daemon identification
   * succeeded (`:515`, `:541`).
   *
   * Absent or `null` means "no identification result to report", which skips the
   * arm — the one default in this module that is *not* fail-closed, and
   * deliberately so: identification is a fact about the host, not about the
   * records, and `garbageDecisions` is called by the report path too, where no
   * process table has been built. **Task 12 must pass the real verdict**, since
   * the reference refuses every candidate when it failed.
   */
  identification?: { ok: boolean; why: string } | null;
  /** `$procs.envBlind | length`: how many agent-class rows had an unreadable env. */
  envBlind?: number;
  /** Prefixes the derived `path` (`$PASEO_HOME`); omitted, the path is relative. */
  paseoHome?: string | null;
}

/** The record directories the reference scans (`extract_agents` / `extract_schedules`). */
const AGENT_RECORD_DIR = "agents";
const SCHEDULE_RECORD_DIR = "schedules";

/** The workspace directory segment `agents.ts` does not retain. */
const UNKNOWN_WORKSPACE_DIR = "*";

const SECONDS_PER_DAY = 86400;
const UPDATED_QUIET_S = 3600;
const LAST_RUN_QUIET_S = 600;

/** `["idle","running","closed","error","initializing"]` (slp-gc.bash:498). */
const AGENT_STATUSES: ReadonlySet<string> = new Set<string>([
  "idle",
  "running",
  "closed",
  "error",
  "initializing",
]);

/** `["active","paused","completed"]` (slp-gc.bash:526). */
const SCHEDULE_STATUSES: ReadonlySet<string> = new Set<string>(["active", "paused", "completed"]);

/** The schedule id the reference requires: `\A[0-9a-f]{8}\z` (slp-gc.bash:525). */
const SCHEDULE_ID = /^[0-9a-f]{8}$/;

/** `sub("\\.json\\z"; "")` — the file stem both basename gates compare. */
function stripJsonSuffix(name: string): string {
  return name.endsWith(".json") ? name.slice(0, -".json".length) : name;
}

/** jq's `tojson` for the two "unknown …" arms; `undefined` reads as `null`. */
function jsonText(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
}

/**
 * The record's path as far as this module can know it (property 3 above): the
 * caller's when it has one, else the id-derived locator. The agent locator keeps
 * the workspace segment as a literal `*` rather than guessing it.
 */
function recordPath(
  kind: "agent" | "schedule",
  id: string,
  paseoHome: string | null,
): string {
  const home = paseoHome === null ? "" : `${paseoHome.replace(/\/+$/, "")}/`;
  if (kind === "schedule") return `${home}${SCHEDULE_RECORD_DIR}/${id}.json`;
  return `${home}${AGENT_RECORD_DIR}/${UNKNOWN_WORKSPACE_DIR}/${id}.json`;
}

/** One refusal: the rule that failed, and the reference's text for it. */
interface Refusal {
  /** Stable rule key, for grouping and for `refusedBy`'s prefix. */
  rule: string;
  /** The reference's text, verbatim. */
  text: string;
}

/**
 * `days($e)` (slp-gc.bash:481): whole days between `now` and an epoch, floored —
 * the reference's own arithmetic, including its reading of a future timestamp as
 * a negative age.
 */
function daysAgo(now: number, epoch: number): number {
  return Math.floor((now - epoch) / SECONDS_PER_DAY);
}

/** `"not garbage: " + ($fails | join("; "))` (`:521`, `:543`) plus the named first failure. */
function refused(
  base: Omit<GarbageCandidate, "refusedBy" | "reason" | "action">,
  fails: readonly Refusal[],
): GarbageCandidate {
  const first = fails[0] ?? { rule: "unknown", text: "not garbage" };
  return {
    ...base,
    refusedBy: `${first.rule}: ${first.text}`,
    reason: `not garbage: ${fails.map((fail) => fail.text).join("; ")}`,
    action: null,
  };
}

/**
 * Garbage decisions for agents and schedules (slp-gc.bash:480-557).
 *
 * Every agent record and every schedule record produces one candidate, in the
 * reference's `$garbage` order: all schedule rows first, then all agent rows
 * (`:557`), each kind in index order. `refusedBy === null` means garbage; every
 * other row names the rule that refused it.
 *
 * The rules, in the reference's order:
 *
 * | Kind | Arm | Reference |
 * |---|---|---|
 * | agent | archived (not live, not `closed`-unarchived) | `:500-502` |
 * | agent | `strict` — the record carries every key the rule reads | `:504` |
 * | agent | not `internal` | `:505` |
 * | agent | `lastStatus == "closed"` | `:506` |
 * | agent | archived ≥ `minDays` days (floored days) | `:507` |
 * | agent | no live process carries `PASEO_AGENT_ID=<id>` | `:508` |
 * | agent | not the invoking agent | `:509` |
 * | agent | no unarchived agent names it as `paseo.parent-agent-id` | `:510` |
 * | agent | no active/paused schedule targets it | `:511` |
 * | agent | no in-flight creation references it | `:512` |
 * | agent | no unreadable record mentions it | `:513` |
 * | agent | the index is complete | `:514` |
 * | agent | identification succeeded | `:515` |
 * | agent | the file name is the record's id (needs the caller's `path`) | `:497` |
 * | agent | `lastStatus` is one of the five known values | `:498` |
 * | agent | an archived record's `archivedAt` parses | `:499` |
 * | schedule | `completed` only | `:530` |
 * | schedule | `strict`, `nextRunAt` null, an agent target | `:531-533` |
 * | schedule | the target agent is `missing`/`archived` | `:534` |
 * | schedule | the room marker is present | `:535` |
 * | schedule | updated ≥ 1 h ago, no run in 10 min | `:536-538` |
 * | schedule | no run is still marked running | `:539` |
 * | schedule | the index is complete, identification succeeded | `:540-541` |
 * | schedule | the id is 8 hex digits (always), the file name matches (with `path`) | `:525` |
 * | schedule | `status` is one of the three known values | `:526` |
 *
 * The three report-only arms (`:544-547`) are refusals here too, with the
 * reference's text: a live target ("protected: …"), the active-with-dead-target
 * anomaly, and any other status/target pair.
 */
export function garbageDecisions(input: GarbageInput): GarbageCandidate[] {
  const now = input.now;
  const minDays = input.minDays;
  const agents = input.agents ?? [];
  const schedules = input.schedules ?? [];
  // Fail closed: an unstated index is an unproven one, and the reference treats
  // an unproven index as "nothing is garbage" (:514, :928).
  const indexOk = input.indexOk ?? false;
  const indexWhy = input.indexWhy ?? [];
  const busyRefs = refIds(input.busyRefs);
  const rawRefs = refIds(input.rawRefs);
  const procOwners = refIds(input.procOwners);
  const identification = input.identification ?? null;
  const envBlind = input.envBlind ?? 0;
  const blind = envBlind > 0;
  const paseoHome = input.paseoHome ?? null;
  const invoker =
    input.invoker === null || input.invoker === undefined || input.invoker === ""
      ? null
      : input.invoker;

  // `("index incomplete: " + ($idx.why | join("; ")))` (:490). The reference
  // cannot reach an `ok:false` index with no reason; the fallback only keeps the
  // sentence readable if a caller hands one in.
  const idxWhy = `index incomplete: ${
    indexWhy.length > 0 ? indexWhy.join("; ") : "(no reason recorded)"
  }`;

  // `$A` (:485) and `$trusted` (:484): first record wins, as in `buildProcTable`.
  const byId = new Map<string, AgentRecord>();
  for (const rec of agents) if (!byId.has(rec.id)) byId.set(rec.id, rec);
  const trusted = agents.length > 0;

  /** `astate($id)` (:491-494): what the index can say about an agent. */
  const agentState = (id: string | null): string => {
    if (id === null) return "n/a";
    const rec = byId.get(id);
    if (rec !== undefined) return rec.archivedAt !== null ? "archived" : "live";
    // A record that mentions the id but could not be parsed: the port fails the
    // whole index instead (`agents.ts`), so `rawRefs` is expected to be empty.
    if (rawRefs.has(id)) return "unreadable";
    // `missing` proves the agent is gone, so it needs at least one parsed record
    // to have been a trustworthy scan; an empty index answers `unknown` (:494).
    return trusted ? "missing" : "unknown";
  };

  // `$liveParents` (:487): agents that an unarchived record still names as parent.
  const liveParents = new Set<string>();
  for (const rec of agents) {
    if (rec.archivedAt === null && rec.parent !== null) liveParents.add(rec.parent);
  }

  // `$schedTargets` (:488): agents an active/paused schedule still targets.
  const schedTargets = new Set<string>();
  for (const rec of schedules) {
    if ((rec.status === "active" || rec.status === "paused") && rec.targetAgent !== null) {
      schedTargets.add(rec.targetAgent);
    }
  }

  /** The two crumbs every row carries; `path`/`sig` per property 3. */
  const crumbs = (kind: "agent" | "schedule", rec: AgentRecord | ScheduleRecord) => {
    const supplied = typeof rec.path === "string" && rec.path !== "" ? rec.path : null;
    return {
      // Kept so the basename gate below can tell "no file name" from "a name
      // that disagrees with the id".
      supplied,
      path: supplied ?? recordPath(kind, rec.id, paseoHome),
      sig: typeof rec.sig === "string" ? rec.sig : "",
    };
  };

  // `(:495-522)` — one agent row.
  const agentRow = (rec: AgentRecord): GarbageCandidate => {
    const { supplied, path, sig } = crumbs("agent", rec);
    const base = { kind: "agent" as const, id: rec.id, path, sig, rule: "agent-archived" as const };

    /** The reference's `skipped:` arms (`:497-499`): the row is never judged. */
    const skip = (rule: string, text: string): GarbageCandidate => ({
      ...base,
      refusedBy: `${rule}: ${text}`,
      reason: text,
      action: null,
    });

    // `:497` — the file name carries the record's own id. A record file whose
    // name disagrees with its content is not evidence about either.
    if (supplied !== null && stripJsonSuffix(baseName(supplied)) !== rec.id) {
      return skip("agent-file-name", "skipped: file name uuid != record id");
    }
    // `:498` — an unknown `lastStatus` means the record is not of a shape this
    // rule was written for.
    if (rec.status === null || !AGENT_STATUSES.has(rec.status)) {
      return skip("agent-status-unknown", `skipped: unknown lastStatus ${jsonText(rec.status)}`);
    }
    // `:500-502` — a record that is not archived is never garbage, whatever its
    // status. `closed`-but-unarchived gets its own sentence: the user may still
    // see it, so the reference reports it rather than hiding it.
    if (rec.archivedAt === null) {
      const text =
        rec.status === "closed"
          ? "not garbage: closed but not archived (report-only; the user may still see it)"
          : `not garbage: unarchived agent (lastStatus ${rec.status})`;
      return { ...base, refusedBy: `agent-not-archived: ${text}`, reason: text, action: null };
    }
    const archivedEpoch = rec.archivedEpoch;
    // `:499` — archived, but not with a timestamp the reference can measure.
    if (archivedEpoch === null) {
      return skip("agent-archived-at-invalid", "skipped: archivedAt is not a valid ISO timestamp");
    }

    const days = daysAgo(now, archivedEpoch);
    const fails: Refusal[] = [];
    // `:504`
    if (!rec.strict) {
      fails.push({
        rule: "agent-strict",
        text: "required keys missing or of the wrong type (internal/archivedAt/lastStatus/updatedAt): skipped, defaults are for reporting only",
      });
    }
    // `:505`
    if (rec.internal !== false) fails.push({ rule: "agent-internal", text: "internal record" });
    // `:506`
    if (rec.status !== "closed") {
      fails.push({ rule: "agent-status", text: `lastStatus is ${rec.status} (rule needs closed)` });
    }
    // `:507`
    if (days < minDays) {
      fails.push({ rule: "agent-archived-age", text: `archived ${days} d ago (< ${minDays} d)` });
    }
    // `:508`
    if (procOwners.has(rec.id)) {
      fails.push({
        rule: "agent-process",
        text: `a process with PASEO_AGENT_ID=${rec.id} is running`,
      });
    }
    // `:509`
    if (invoker !== null && invoker === rec.id) {
      fails.push({ rule: "agent-invoker", text: "it is the invoking agent" });
    }
    // `:510`
    if (liveParents.has(rec.id)) {
      fails.push({
        rule: "agent-live-parent",
        text: "an unarchived agent references it via paseo.parent-agent-id",
      });
    }
    // `:511`
    if (schedTargets.has(rec.id)) {
      fails.push({ rule: "agent-schedule-target", text: "an active/paused schedule targets it" });
    }
    // `:512`
    if (busyRefs.has(rec.id)) {
      fails.push({ rule: "agent-busy-ref", text: "an in-flight creation references it" });
    }
    // `:513`
    if (rawRefs.has(rec.id)) {
      fails.push({
        rule: "agent-raw-ref",
        text: "an unreadable record/schedule mentions it",
      });
    }
    // `:514`
    if (!indexOk) fails.push({ rule: "index-incomplete", text: idxWhy });
    // `:515`
    if (identification !== null && !identification.ok) {
      fails.push({
        rule: "identification",
        text: `Paseo identification failed: ${identification.why}`,
      });
    }

    if (fails.length > 0) return refused(base, fails);

    // `:517-519`
    return {
      ...base,
      refusedBy: null,
      reason:
        `GARBAGE: archived ${days} d ago, lastStatus=closed, not internal, ` +
        "no live process/child/schedule/creation reference" +
        (blind
          ? `; NOTE: the env of ${envBlind} agent-class process(es) is unreadable, so --apply must first prove it archived and not running with \`paseo agent inspect\``
          : ""),
      action: `paseo agent delete ${rec.id}`,
    };
  };

  // `(:523-548)` — one schedule row.
  const scheduleRow = (rec: ScheduleRecord): GarbageCandidate => {
    const { supplied, path, sig } = crumbs("schedule", rec);
    const base = {
      kind: "schedule" as const,
      id: rec.id,
      path,
      sig,
      rule: "schedule-completed" as const,
    };

    /** A refusal whose whole reason is the one sentence (the `skipped:` gates and
     * the three report-only arms: `:525-526`, `:544-547`). */
    const refuse = (rule: string, text: string): GarbageCandidate => ({
      ...base,
      refusedBy: `${rule}: ${text}`,
      reason: text,
      action: null,
    });

    // `:525` — the schedule scan is flat and id-keyed, so the id *is* the file
    // stem: the 8-hex gate is decided from the id alone, and the file-name half
    // is decided when the caller still has the path.
    if (
      !SCHEDULE_ID.test(rec.id) ||
      (supplied !== null && baseName(supplied) !== `${rec.id}.json`)
    ) {
      return refuse("schedule-file-name", "skipped: file name is not <id>.json with an 8-hex id");
    }
    // `:526`
    if (!SCHEDULE_STATUSES.has(rec.status)) {
      return refuse("schedule-status-unknown", `skipped: unknown status ${jsonText(rec.status)}`);
    }

    // `$ts` (:528-529): what the index can say about the target, or `n/a`.
    const targetState =
      rec.targetType === "agent" && rec.targetAgent !== null
        ? agentState(rec.targetAgent)
        : "n/a";

    if (rec.status === "completed") {
      const fails: Refusal[] = [];
      // `:531`
      if (!rec.strict) {
        fails.push({
          rule: "schedule-strict",
          text: "required keys missing or of the wrong type (runs/lastRunAt/nextRunAt/updatedAt): skipped",
        });
      }
      // `:532` — a completed schedule with a next fire is not finished.
      if (rec.nextRunAt !== null) {
        fails.push({ rule: "schedule-next-run", text: "nextRunAt is set" });
      }
      // `:533` — only room machinery is ever reclaimed.
      if (rec.targetType !== "agent") {
        fails.push({
          rule: "schedule-target-type",
          text: "target is a new-agent schedule (not room machinery)",
        });
      }
      // `:534` — the target must be gone; `unreadable`/`unknown` refuse.
      if (rec.targetType === "agent" && targetState !== "missing" && targetState !== "archived") {
        fails.push({ rule: "schedule-target-state", text: `target agent is ${targetState}` });
      }
      // `:535` — the room marker. The reference reclaims *room* schedules and
      // refuses every other one, so a user's own schedule is never a candidate.
      if (!rec.room) {
        fails.push({
          rule: "schedule-room",
          text: "no room marker (name supervisor: / heartbeat prompt)",
        });
      }
      // `:536`
      if (rec.updatedEpoch === null) {
        fails.push({ rule: "schedule-updated", text: "updatedAt invalid" });
      } else if (now - rec.updatedEpoch < UPDATED_QUIET_S) {
        fails.push({ rule: "schedule-updated", text: "updated < 1 h ago" });
      }
      // `:537`
      if (rec.lastRunEpoch !== null && now - rec.lastRunEpoch < LAST_RUN_QUIET_S) {
        fails.push({ rule: "schedule-last-run-recent", text: "last run < 10 min ago" });
      }
      // `:538`
      if (rec.lastRunAt !== null && rec.lastRunEpoch === null) {
        fails.push({ rule: "schedule-last-run-invalid", text: "lastRunAt invalid" });
      }
      // `:539`
      if (rec.runsRunning > 0) {
        fails.push({ rule: "schedule-running", text: "a run is still marked running" });
      }
      // The reference gates *agents* on `$busyRefs` (`:512`) and not schedules;
      // it is ported for schedules too, because a schedule an in-flight creation
      // references is the one thing a deletion must not race. The arm can only
      // ever refuse (the reference's `$busyRefs` holds agent ids), so it is a
      // fail-closed addition, not a widening: the cost is one report line, the
      // cost of the missing arm is deleting a schedule something is creating.
      if (busyRefs.has(rec.id)) {
        fails.push({ rule: "schedule-busy-ref", text: "an in-flight creation references it" });
      }
      // `:540`
      if (!indexOk) fails.push({ rule: "index-incomplete", text: idxWhy });
      // `:541`
      if (identification !== null && !identification.ok) {
        fails.push({
          rule: "identification",
          text: `Paseo identification failed: ${identification.why}`,
        });
      }

      if (fails.length > 0) return refused(base, fails);

      // `:542`
      return {
        ...base,
        refusedBy: null,
        reason: `GARBAGE: completed room schedule, target agent ${targetState}, updated > 1 h ago, no run in 10 min`,
        action: `paseo schedule delete ${rec.id}`,
      };
    }

    // `:544` — a live target protects its schedules, whatever their status.
    if (targetState === "live") {
      return refuse("schedule-target-live", "protected: target agent is live/unarchived");
    }
    // `:545-546` — the daemon completes an active schedule whose target is gone;
    // the reference reports the anomaly and acts on nothing.
    if ((targetState === "missing" || targetState === "archived") && rec.status === "active") {
      return refuse(
        "schedule-anomaly",
        `anomaly (report-only): active schedule with ${targetState} target; the daemon normally completes it`,
      );
    }
    // `:547`
    return refuse("schedule-status", `not garbage: status ${rec.status}, target ${targetState}`);
  };

  // `$garbage` (:557): `($schedRows + $agentRows) | map(select(.garbage))` — but
  // every row is kept here, refused rather than dropped, so a caller can never
  // mistake a dropped row for an eligible one.
  return [...schedules.map(scheduleRow), ...agents.map(agentRow)];
}

// The tick: the one function that composes every other module of the GC port in
// the reference's order, plus the I/O it alone owns.
//
// Reference: `agent-room/docs/gc-port/slp-gc.bash`, `do_tick` (`:1300-1338`) over
// `do_record` (`:1185-1235`), `evaluate` (`:885-908`) and `do_apply`
// (`:1046-1168`). The order is the reference's and it is load-bearing:
//
//   read_config                                   :1302   (settings, once a tick)
//   migrate (once per process, before any tick)   —       (the port's addition: :169's state dir)
//   the agent + schedule index                    :888   (extract_agents / extract_schedules)
//   the process collection                        :765-793 (collect_procs)
//   do_record                                     :1308   → :1185-1235
//   the report, when due                          :1309-1328
//   do_apply                                      :1329-1332 → :1046-1168
//
// Six properties matter more than tidiness:
//
// 1. **A tick never throws.** `do_tick` is `set -e`-free by construction: every
//    phase prints its own failure and the tick still returns 0 (§1308, :1317,
//    :1334). Each `deps.*` call here is wrapped the same way — a failing
//    retention scan, a hung `top`, a rejected `recordSample` or an unwritable
//    report costs that phase and nothing else.
// 2. **Every decision gets its inputs.** This is the module that has them, so it
//    passes them: the resolved `daemonPid` (`null` when identification found no
//    daemon, never omitted) and the *second* table into the decision rules, the
//    built `procs` table into the orphan proof, the real `index.ok` and the
//    identification verdict into `garbageDecisions`, and `path` plus a real
//    `inode:size:mtime` `sig` out of the record scan so `reclaim` can re-check
//    them. A field that is missing here is a wiring bug, not a default.
// 3. **The acting settings are passed, not re-derived.** `kinds`, `killComms`,
//    `memKillMb`, `enabledRules`, the `lstat` dep and the tick's `startedAt` all
//    reach the acting modules, so a rule that is off in the settings cannot act
//    even if its call site were reached by mistake.
// 4. **Identification failure refuses everything.** `do_apply` returns before
//    its loops when `.procs.ident.ok` is not true (`:1050-1053`) and before that
//    when the index is incomplete (`:1054-1057`); both gates are reproduced here,
//    the identification one in the tick because the acting modules only know
//    about the index. The refusal covers the kills as well as the deletes: the
//    reference's two loops are both behind these returns, so a refused tick emits
//    one refusal row and sends no signal.
// 5. **The I/O lives here and nowhere else.** `ps`, `top`, `lsof`, `vm_stat`,
//    `sysctl`, the `paseo` CLI and the state-dir files are this module's; the
//    decision modules stay pure. Every call takes the reference's `run_to` budget
//    and degrades to an empty answer instead of an exception.
// 6. **Nothing is read from the process table that the port did not sample.**
//    The tests run the whole composition against an empty `ps`/`top` and an
//    in-memory settings reader; no daemon, no live process table, no reference
//    run.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { gcSettingsDocumentSchema, type GcSettings, type GcStatus } from "../../shared/gc";
import { type ActionResult, reclaim, type ReclaimCandidate, type VerifyAnswer } from "./apply";
import {
  snapshotAgents,
  snapshotSchedules,
  type AgentRec,
  type AgentSnapshot,
  type ScheduleRec,
  type ScheduleSnapshot,
} from "./agents";
import {
  buildProcTable,
  garbageDecisions,
  isAgentChild,
  isAgentFamily,
  overmemDecision,
  orphanDecision,
  staleDecision,
  type AgentOwner,
  type DecisionContext,
  type EnvFacts,
  type GarbageCandidate,
  type OrphanContext,
  type OrphanDecision,
  type ProcEntry,
  type ProcTable,
} from "./evaluate";
import { resolveIdentity, type Identity } from "./identity";
import { signalCandidates, type KillCandidate, type KillKind } from "./kill";
import {
  ledgerKey,
  nextLedger,
  readLedger,
  validateLedger,
  writeLedger,
  type LedgerRow,
} from "./ledger";
import type { Decision } from "./evaluate";
import {
  buildReport,
  collectDaemonMetrics,
  collectRetention,
  collectTranscripts,
  type ExecResult,
  type GcExec,
  type GcReport,
  type ReportAgentRow,
  type ReportScheduleRow,
  type ReportTree,
  type ReportTreeRow,
} from "./report";
import { ALERTS_FILE, recordSample, type MemorySampleSystem, type Notify } from "./record";
import { renderReport } from "./render";
import { migrateState, type MigrateResult } from "./migrate";
import { DEFAULT_GC_SETTINGS, type GcLog } from "./settings";
import { classify, parsePs, parseTop, type ProcRow, type ParsedPs, type TopRow } from "./procs";

// ---------------------------------------------------------------------------
// Constants: the reference's own numbers
// ---------------------------------------------------------------------------

/**
 * `AGENT_MIN_DAYS` (slp-gc.bash:32): how long an archived agent must have been
 * archived before its record is garbage. The reference fixes it at 14 days; it is
 * a constant and not a settings knob, because a user who could lower it could
 * delete live history.
 */
export const AGENT_MIN_DAYS = 14;

/** `run_to 20 "$PS" -axww …` (slp-gc.bash:563). */
export const PS_TIMEOUT_MS = 20_000;
/** `run_to 30 "$TOP" -l 1 …` (slp-gc.bash:612). */
export const TOP_TIMEOUT_MS = 30_000;
/** `run_to 3 "$PSENV" -eww …` per pid (slp-gc.bash:574). */
export const ENV_TIMEOUT_MS = 3_000;
/** `run_to 15 "$LSOF" …` for the listener (slp-gc.bash:618) and the exe (slp-gc.bash:718). */
export const LSOF_TIMEOUT_MS = 15_000;
/** `exe_of`'s `run_to 3 "$PS" -o comm=` fallback (slp-gc.bash:719). */
export const EXE_PS_TIMEOUT_MS = 3_000;
/** `run_to 10 "$VMSTAT"` / `"$SYSCTL" -n vm.swapusage` (slp-gc.bash:1194, 1199). */
export const SYSTEM_TIMEOUT_MS = 10_000;
/** The port's budget for `sysctl -n hw.memsize`, which the reference caches at startup. */
export const RAM_TIMEOUT_MS = 5_000;

/**
 * The port's bound on per-tick environment reads. The reference reads the env of
 * every agent-family pid with four readers at a time (slp-gc.bash:571-604) and
 * has no cap; a daemon with hundreds of agent children would spend minutes inside
 * one tick, so the port samples the first 64 (in pid order) and reports the rest
 * as env-unreadable, which is the fail-closed direction for every rule that reads
 * the env.
 */
export const ENV_PID_CAP = 64;

/** `fill_exe`'s `head -n 40` (slp-gc.bash:727): `lsof` lookups per tick. */
export const EXE_LOOKUP_CAP = 40;

/**
 * `ls -1 "$STATE/reports" | sort -r | tail -n +49` (slp-gc.bash:1327): 48 reports kept.
 * A report is one stamp and two files (`.txt` + `.json`), so this is the number of
 * stamps: see `writeReportFile`.
 */
export const REPORTS_KEPT = 48;

/**
 * How many `alerts.log` lines `gc.status` publishes: the newest 20, newest first.
 *
 * The file is the reference's history surface (`:1229`) and rotates at 1 MB, so it
 * can hold thousands of lines; the screen shows a tail, and a tail of a fixed size
 * is the whole point of it. This is a status limit only — nothing in the GC's
 * rules reads it, and the file itself is untouched.
 */
export const ALERTS_STATUS_LIMIT = 20;

/**
 * The `selfPid` the tick passes when the caller supplies none: a sentinel that
 * matches no `ps` row, **not** `process.pid`.
 *
 * The reference runs as a shell script, so `$$` is a real, short-lived pid whose
 * ancestry is the invoking shell's and whose subtree is nothing but itself: the
 * `$selfTree` protection (slp-gc.bash:295-298) protects "the GC's own process
 * tree" and there is one. Inside the plugin there is no such tree — the tick runs
 * *in* the daemon's process, so `process.pid` is the daemon's pid and
 * `buildProcTable`'s self-tree would be the daemon plus **every descendant**,
 * i.e. every agent, every agent child and every agent descendant. That would make
 * the memory rule unable to fire on `agent-descendant` rows at all (the one class
 * it targets, `:365-370`) and would mislabel every agent process in the report and
 * in `gc.status` as "in the GC's own process tree".
 *
 * `0` is safe as a sentinel because `ps` never reports pid 0 (the kernel's
 * scheduler is not a user process) and `parsePs` refuses a non-positive pid
 * through `UINT`; so `selfRow` is `undefined`, the self subtree is empty and no
 * row is ever claimed by that arm. Nothing else weakens: the daemon is refused by
 * class (`:363`), the app main and the Supervisor by class (`:362`), an agent
 * child by class (`:364`), and the invoking agent by its `PASEO_AGENT_ID`
 * (`invoker`) and by `invOwnerPid` in the orphan proof (`:411-417`). A caller that
 * really does have a process tree of its own — a test, or a future out-of-process
 * runner — passes `deps.selfPid`.
 */
export const NO_SELF_PID = 0;

/** `-size +512k` and `head -n 15` are `report.ts`'s defaults; the tick passes the settings it has. */

/** `is_uint` (slp-gc.bash:40): digits only, at most twelve of them. */
const UINT = /^[0-9]{1,12}$/;

/** The reference's `date -u +%Y-%m-%dT%H:%M:%SZ` (slp-gc.bash:48). */
export function isoUtc(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The reference's `date -u +%Y%m%dT%H%M%SZ` (slp-gc.bash:47), for a report's name. */
export function reportStamp(epoch: number): string {
  return isoUtc(epoch).replace(/[-:]/g, "");
}

// ---------------------------------------------------------------------------
// The exec boundary
// ---------------------------------------------------------------------------

function emptyResult(): ExecResult {
  return { code: null, stdout: "", stderr: "", timedOut: false };
}

/**
 * The production `GcExec`: one `spawnSync` with the reference's `run_to` budget.
 *
 * `run_to` (slp-gc.bash:57-61) wraps every external call in a perl `alarm` and
 * treats the alarm as a failure (exit 142); `spawnSync`'s `timeout` is the same
 * gate, and a timed-out child is reported as `timedOut` so no caller can mistake
 * a partial read for a complete one. stdout is capped at 32 MB — a `ps -axww` on
 * a busy machine is well under it, and the cap is what keeps a pathological
 * `command` column from exhausting the heap.
 */
export const defaultExec: GcExec = (argv, options) => {
  const [command, ...args] = argv;
  if (command === undefined) return emptyResult();
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    return {
      code: typeof result.status === "number" ? result.status : null,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      timedOut: code === "ETIMEDOUT",
    };
  } catch {
    return emptyResult();
  }
};

/**
 * Run one command through the injected exec and never throw.
 *
 * The exec is foreign code: it can throw (a missing binary), answer `undefined`
 * (a stub) or answer with the wrong field types. Each of those is "nothing came
 * back", which every caller here already treats as a degradation.
 */
function runExec(exec: GcExec, argv: readonly string[], timeoutMs: number): ExecResult {
  let result: ExecResult;
  try {
    result = exec(argv, { timeoutMs });
  } catch {
    return emptyResult();
  }
  if (result === null || typeof result !== "object") return emptyResult();
  return {
    code: typeof result.code === "number" ? result.code : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut: result.timedOut === true,
  };
}

/** `cmd` exited 0 and `run_to` did not alarm — the reference's success test everywhere. */
function succeeded(result: ExecResult): boolean {
  return result.timedOut !== true && result.code === 0;
}

/** A command's stdout when it succeeded, else `""` (`2>/dev/null || true`). */
function stdoutOrEmpty(exec: GcExec, argv: readonly string[], timeoutMs: number): string {
  const result = runExec(exec, argv, timeoutMs);
  return succeeded(result) ? result.stdout : "";
}

// ---------------------------------------------------------------------------
// The runtime the tick hands to every phase
// ---------------------------------------------------------------------------

/** Everything the I/O half reads that is not a setting. Read once per phase. */
export interface GcRuntime {
  /** `$HOME`. */
  home: string;
  /** `$PHOME`: the resolved Paseo home (`$PASEO_HOME` or `<home>/.paseo`). */
  paseoHome: string;
  /** `$PASEO_HOME` verbatim (may be `""`), for the second `bound()` arm (slp-gc.bash:575). */
  paseoHomeRaw: string;
  /** The plugin's GC state dir: `$PASEO_HOME/plugin-data/agent-room/gc`. */
  stateDir: string;
  /** `$NOW`, epoch seconds — one clock read per phase. */
  now: number;
  /**
   * `$$` in the reference, `NO_SELF_PID` (a sentinel matching no row) here: the
   * plugin runs *inside* the daemon, so it has no process tree of its own. See
   * `NO_SELF_PID` for the ruling and for the protections that stay in force.
   */
  selfPid: number;
  /** `$PASEO_AGENT_ID` of the process running the tick, or null. */
  invoker: string | null;
  /** The exec seam (`ps`, `top`, `lsof`, `vm_stat`, `sysctl`, the `paseo` CLI). */
  exec: GcExec;
  /** `$HOME_IS_DEFAULT` (slp-gc.bash:784): the GC's own home is the default one. */
  homeDefault: boolean;
  log?: GcLog;
}

/** A `warn` sink for whatever log the caller passed; a broken sink must not break a tick. */
function warnLog(log: GcLog | undefined): (message: string, fields?: Record<string, unknown>) => void {
  let sink: (message: string, fields?: Record<string, unknown>) => void;
  if (typeof log === "function") {
    sink = log as (message: string, fields?: Record<string, unknown>) => void;
  } else if (log !== null && typeof log === "object") {
    const candidate = (log as unknown as Record<string, unknown>).warn;
    sink =
      typeof candidate === "function"
        ? (candidate as (message: string, fields?: Record<string, unknown>) => void).bind(log)
        : () => {};
  } else {
    sink = () => {};
  }
  return (message, fields) => {
    try {
      sink(message, fields);
    } catch {
      // A log sink must never break a tick.
    }
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// collect_env (slp-gc.bash:573-604)
// ---------------------------------------------------------------------------

/** `bound()` (slp-gc.bash:589): `v` is `home`, or `home` followed by a space. */
function bound(value: string, home: string): boolean {
  if (home === "") return false;
  return value.startsWith(home) && (value.length === home.length || value[home.length] === " ");
}

/**
 * `env_one` (slp-gc.bash:573-590): one pid's environment facts, from the `ps eww`
 * text of that pid.
 *
 * The two scans are the reference's awk, including its quirks:
 *
 * - `PASEO_AGENT_ID=` is taken from the **last** occurrence whose next 36
 *   characters are `[0-9a-f-]+` — a variable echoed inside a command line cannot
 *   win over the real one that follows it;
 * - `PASEO_HOME=` matches when its value is the GC's home *or* the raw
 *   `$PASEO_HOME` (`bound(v, home) || bound(v, home2)`), and the first `other`
 *   does not override a later `match`;
 * - "readable" is `PATH=`, `HOME=` or `USER=` anywhere in the text — a pid whose
 *   environment macOS would not hand over shows none of them, and an unreadable
 *   env must never look like an absent `PASEO_HOME`.
 */
export function parseEnvText(text: string, home: string, homeRaw: string): EnvFacts {
  const flat = text.replace(/\n/g, " ");
  let agent: string | null = null;
  let rest = flat;
  for (;;) {
    const at = rest.indexOf(" PASEO_AGENT_ID=");
    if (at < 0) break;
    const candidate = rest.slice(at + 16, at + 16 + 36);
    if (/^[0-9a-f-]+$/.test(candidate) && candidate.length === 36) agent = candidate;
    rest = rest.slice(at + 16);
  }

  let state: "match" | "other" | "none" = "none";
  rest = flat;
  for (;;) {
    const at = rest.indexOf(" PASEO_HOME=");
    if (at < 0) break;
    const value = rest.slice(at + 12);
    if (bound(value, home) || bound(value, homeRaw)) state = "match";
    else if (state === "none") state = "other";
    rest = value;
  }

  const readable =
    flat.includes(" PATH=") || flat.includes(" HOME=") || flat.includes(" USER=");
  return { agent, home: state, read: readable };
}

/** The `{agent: null, home: "none", read: false}` default (slp-gc.bash:324). */
const NO_ENV: EnvFacts = { agent: null, home: "none", read: false };

/**
 * Which pids `collect_env` reads: the reference's `PSPAT` (slp-gc.bash:565-567)
 * keeps the Supervisor, the agent children (claude with the stream-json flags,
 * codex with `app-server`), the `slp-wait` helpers and anything with a
 * `wait <uuid>` tail — i.e. the agent family plus the Supervisor, which is what
 * classification already answers. A row the classifier does not name is never
 * env-read, exactly as in the reference.
 */
export function envPids(rows: readonly ProcRow[]): number[] {
  const pids: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const cls = classify(row.cmd);
    const wanted =
      cls === "supervisor" ||
      cls === "claude-child" ||
      cls === "codex-child" ||
      cls === "slp-wait" ||
      cls === "paseo-wait";
    if (!wanted || seen.has(row.pid)) continue;
    seen.add(row.pid);
    pids.push(row.pid);
    if (pids.length >= ENV_PID_CAP) break;
  }
  return pids;
}

/**
 * `collect_env` (slp-gc.bash:591-604): the environment facts of the given pids.
 *
 * The reference reads up to four pids concurrently with `ps -eww -p <pid>` each;
 * the port runs them one at a time through the exec seam — the seam is synchronous
 * by design (one `spawnSync` per call) and the cap in `envPids` bounds the work.
 * A failed read is `NO_ENV`, which every rule reads as fail-closed.
 */
export function collectEnv(
  exec: GcExec,
  pids: readonly number[],
  home: string,
  homeRaw: string,
): Map<number, EnvFacts> {
  const env = new Map<number, EnvFacts>();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const text = stdoutOrEmpty(exec, ["ps", "-eww", "-o", "command=", "-p", String(pid)], ENV_TIMEOUT_MS);
    env.set(pid, text === "" ? NO_ENV : parseEnvText(text, home, homeRaw));
  }
  return env;
}

// ---------------------------------------------------------------------------
// The other collectors (slp-gc.bash:563, 605-619, 1194-1202)
// ---------------------------------------------------------------------------

const PS_ARGV: readonly string[] = [
  "ps",
  "-axww",
  "-o",
  "pid=,ppid=,pgid=,etime=,rss=,lstart=,command=",
];
const TOP_ARGV: readonly string[] = ["top", "-l", "1", "-stats", "pid,mem,cmprs"];

/** `collect_ps` (slp-gc.bash:563), parsed. An unreadable `ps` is an empty table. */
export function collectPs(exec: GcExec): ParsedPs {
  return parsePs(stdoutOrEmpty(exec, PS_ARGV, PS_TIMEOUT_MS));
}

/** `collect_top` (slp-gc.bash:612), parsed. An unreadable `top` is an empty sample. */
export function collectTop(exec: GcExec): Map<number, TopRow> {
  return parseTop(stdoutOrEmpty(exec, TOP_ARGV, TOP_TIMEOUT_MS));
}

/**
 * `collect_listen` (slp-gc.bash:615-619): the pids listening on the pid file's
 * port, from `lsof -Fp`. A pid file without a usable port, or a failed `lsof`,
 * answers an empty list — which identification reads as "the daemon does not own
 * the listener", the fail-closed answer.
 */
export function collectListen(exec: GcExec, listen: string | null): number[] {
  if (listen === null) return [];
  const colon = listen.lastIndexOf(":");
  const port = colon < 0 ? listen : listen.slice(colon + 1);
  if (!UINT.test(port)) return [];
  const text = stdoutOrEmpty(
    exec,
    ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
    LSOF_TIMEOUT_MS,
  );
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const match = /^p([0-9]+)$/.exec(line.trim());
    if (match === null) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** `exe_of` (slp-gc.bash:717-721): the real executable, or `""` when it cannot be read. */
export function exeOf(exec: GcExec, pid: number): string {
  const lsof = stdoutOrEmpty(
    exec,
    ["lsof", "-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"],
    LSOF_TIMEOUT_MS,
  );
  const first = lsof
    .split("\n")
    .map((line) => (line.startsWith("n") ? line.slice(1) : ""))
    .find((path) => path !== "");
  if (first !== undefined && first.startsWith("/")) return first.replace(/\n/g, " ");
  const comm = stdoutOrEmpty(exec, ["ps", "-o", "comm=", "-p", String(pid)], EXE_PS_TIMEOUT_MS)
    .split("\n")[0];
  if (comm !== undefined && comm.startsWith("/")) return comm.replace(/\n/g, " ");
  return "";
}

/**
 * `$PHOME/paseo.pid`, parsed — `null` for an absent file, an unreadable one or a
 * symlink (`[ -f ] && [ ! -L ]`, slp-gc.bash:776). The *type* test stays in
 * `resolveIdentity`, so a JSON file that is not a pid file is `null` there too.
 */
export async function readPidFile(paseoHome: string): Promise<unknown> {
  const path = join(paseoHome, "paseo.pid");
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** `vmval`'s `[0-9]`-only arm (slp-gc.bash:1196): a number, or `null`. */
function vmValue(text: string, key: string): number | null {
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (!line.slice(0, colon).trim().startsWith(key)) continue;
    const digits = (line.slice(colon + 1).replace(/[ .]/g, "").match(/^[0-9]+/) ?? [])[0];
    return digits === undefined ? null : Number(digits);
  }
  return null;
}

/**
 * The `system` block of the memory sample (`vm_stat` + `sysctl vm.swapusage`,
 * slp-gc.bash:1193-1202). Every failure is the reference's own `null`, and
 * `swap_raw` keeps the sysctl text verbatim.
 */
export function collectSystem(exec: GcExec): Partial<MemorySampleSystem> {
  const vm = stdoutOrEmpty(exec, ["vm_stat"], SYSTEM_TIMEOUT_MS);
  const pageSize = /page size of ([0-9]*) bytes/.exec(vm);
  const swap = stdoutOrEmpty(exec, ["sysctl", "-n", "vm.swapusage"], SYSTEM_TIMEOUT_MS);
  const used = /used = ([0-9]*)(\.[0-9]*)?M/.exec(swap);
  return {
    vm_page_size: pageSize === null ? null : Number(pageSize[1] ?? "") || null,
    compressor_stored_pages: vmValue(vm, "Pages stored in compressor"),
    compressor_occupied_pages: vmValue(vm, "Pages occupied by compressor"),
    swapouts: vmValue(vm, "Swapouts"),
    pageouts: vmValue(vm, "Pageouts"),
    swap_used_mb: used === null ? null : Number(`${used[1] ?? ""}${used[2] ?? ""}`),
    swap_raw: swap,
  };
}

/** Physical RAM in MB (`hw.memsize`), for `SLP_GC_TREE_WARN_MB`'s `null` arm. */
export function collectRamMb(exec: GcExec): number | null {
  const text = stdoutOrEmpty(exec, ["sysctl", "-n", "hw.memsize"], RAM_TIMEOUT_MS).trim();
  if (!UINT.test(text)) return null;
  return Math.floor(Number(text) / (1024 * 1024));
}

// ---------------------------------------------------------------------------
// The process phase: the two-pass table, identification, orphans, the ledger
// ---------------------------------------------------------------------------

/** `$procs.json` as the tick needs it: everything the report and the rules read. */
export interface ProcsPhase {
  ident: Identity;
  /** The **second** table — the one built with the identified `daemonPid`. */
  table: ProcTable;
  orphans: OrphanDecision[];
  ps: ParsedPs;
  top: Map<number, TopRow>;
  env: Map<number, EnvFacts>;
  ledgerNext: LedgerRow[] | null;
  ledgerNote: string;
  ledgerDropped: number;
}

/** The `pid|lstart` -> row map the orphan proof reads (`$ledBy`, slp-gc.bash:401). */
function ledgerByKey(rows: readonly LedgerRow[]): Map<string, LedgerRow> {
  const byKey = new Map<string, LedgerRow>();
  for (const row of rows) byKey.set(ledgerKey(row.pid, row.lstart), row);
  return byKey;
}

/** `$anc`: each pid's ancestry (the row first), 40 steps, stopping at ppid 1 / a cycle. */
function ancestry(rows: readonly ProcRow[]): (row: ProcRow) => ProcRow[] {
  const byPid = new Map<number, ProcRow>();
  for (const row of rows) byPid.set(row.pid, row);
  return (row: ProcRow): ProcRow[] => {
    const out: ProcRow[] = [row];
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
}

/**
 * `$curr` (slp-gc.bash:452-460): the ledger rows this tick records for live,
 * unclassified descendants of an agent under the identified daemon.
 *
 * The row's `exe` is the *previous* ledger's (`$ledBy[...].exe // ""`): the record
 * tick fills a missing one from `lsof` afterwards (`fill_exe`, :724-737), so a row
 * earns its executable over two ticks and an unreadable one stays unkillable.
 */
function currentLedgerRows(
  phase: { rows: readonly ProcRow[]; ident: Identity; env: Map<number, EnvFacts>; previous: Map<string, LedgerRow> },
  now: number,
): LedgerRow[] {
  const chain = ancestry(phase.rows);
  const byPid = new Map<number, ProcRow>();
  for (const row of phase.rows) byPid.set(row.pid, row);

  const rows: LedgerRow[] = [];
  for (const row of phase.rows) {
    if (classify(row.cmd) !== null) continue;
    const up = chain(row).slice(1);
    const agentish = up
      .map((ancestor) => byPid.get(ancestor.pid))
      .find((ancestor) => ancestor !== undefined && isAgentChild(classify(ancestor.cmd)));
    if (agentish === undefined) continue;
    if (phase.ident.daemonPid === null) continue;
    if (!up.some((ancestor) => ancestor.pid === phase.ident.daemonPid)) continue;

    const key = ledgerKey(row.pid, row.lstart);
    const previous = phase.previous.get(key);
    const owner =
      phase.env.get(agentish.pid)?.agent ?? `pid:${agentish.pid}@${agentish.lstart}`;
    rows.push({
      pid: row.pid,
      lstart: row.lstart,
      comm: baseName(row.cmd.split(" ")[0] ?? ""),
      owner,
      first: previous?.first ?? now,
      orphaned: 0,
      exe: previous?.exe ?? "",
    });
  }
  return rows;
}

/** `base` (slp-gc.bash:201). */
function baseName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

export interface ProcsPhaseInput {
  runtime: GcRuntime;
  settings: GcSettings;
  /** The agent index (`snapshotAgents()`), for the owner states. */
  agents: AgentSnapshot;
  /** `slp-gc record`'s `WANT_LEDGER=1` (:1188): compute and write the next ledger. */
  wantLedger: boolean;
}

/**
 * `collect_procs` (slp-gc.bash:765-793), the port's composition of it.
 *
 * The two-pass table is `evaluate.ts`'s contract, reproduced exactly:
 *
 *   const first  = buildProcTable({ …no daemonPid… });          // identification only
 *   const ident  = resolveIdentity({ procs: first.procs, … });
 *   const table  = buildProcTable({ …, daemonPid: ident.daemonPid });  // the decisions read this
 *
 * The first build deliberately *omits* `daemonPid` (that is `evaluate.ts`'s
 * fail-closed state: every row reads `underDaemon: true`), and the second always
 * supplies it — a pid, or the explicit `null` that means "identification found no
 * daemon". The orphan proof then gets the second table's rows, and the ledger is
 * assembled from the rows, the env and the previous ledger.
 */
export async function collectProcsPhase(input: ProcsPhaseInput): Promise<ProcsPhase> {
  const { runtime, settings } = input;
  const warn = warnLog(runtime.log);

  const ps = collectPs(runtime.exec);
  const pids = envPids(ps.rows);
  const env = collectEnv(runtime.exec, pids, runtime.paseoHome, runtime.paseoHomeRaw);
  const top = collectTop(runtime.exec);

  const ledgerPath = join(runtime.stateDir, "lineage.tsv");
  const loaded = await readLedger(ledgerPath);
  const validated = validateLedger(loaded.rows, runtime.now);
  const previous = ledgerByKey(validated.rows);

  const pidFile = await readPidFile(runtime.paseoHome);
  const listen = collectListen(
    runtime.exec,
    typeof (pidFile as { listen?: unknown } | null)?.listen === "string"
      ? ((pidFile as { listen: string }).listen)
      : null,
  );

  const agents: readonly AgentOwner[] = input.agents.agents;
  const common = {
    rows: ps.rows,
    top,
    env,
    agents,
    agentIndexOk: input.agents.index.ok,
    selfPid: runtime.selfPid,
    invoker: runtime.invoker,
    warnMb: settings.memWarnMb,
  };

  // The first build deliberately omits `daemonPid`: that is `evaluate.ts`'s
  // fail-closed "identification has not run" state, under which every row reads
  // `underDaemon: true`. Only the second build — below, with the resolved pid or
  // the explicit `null` — may be judged by the two rules.
  const first = buildProcTable(common);
  const ident = resolveIdentity({
    procs: first.procs,
    pidFile,
    listen,
    dupes: ps.dupes,
    homeDefault: runtime.homeDefault,
  });
  const table = buildProcTable({ ...common, daemonPid: ident.daemonPid });

  // `$orph` (:399): an unclassified row reparented to launchd, **and** named by the
  // ledger or proven by its env — the reference's `select($led != null or $envProof)`,
  // applied below before the proof runs. The proof itself refuses anything else, so
  // the selection is what decides which rows are candidates at all.
  //
  // The three tree inputs are passed **explicitly empty**, not omitted: the
  // reference protects the GC's own tree (`$selfTree`), the invoking agent's
  // subtree (`$invSub`) and the invoking agent's `pid:<n>@<lstart>` owner
  // (`$invOwnerPid`) because it runs as a shell script *inside* an agent's
  // ancestry. The plugin has no process tree of its own (see `NO_SELF_PID`) and
  // is not itself an agent, so `selfTree`/`invTree` are `[]` and `invOwnerPid` is
  // `null`. That is also the only possible answer for this module's subject: a
  // `ppid == 1` orphan has no ancestors left, so it can be in neither the GC's
  // tree nor any agent's subtree — reparenting to launchd is exactly what removes
  // it from both. Everything else in `$prot` stays in force and is passed below:
  // `invoker` (`belongs to the invoking agent`), and the `exe`/`exePath` arms
  // (`.app`, `/System`, `/Library`) are computed from the row and the ledger.
  const orphanCtx: OrphanContext = {
    now: runtime.now,
    identity: ident,
    killMb: settings.memKillMb,
    killComms: settings.killComms,
    warnMb: settings.memWarnMb,
    orphanMinAgeMin: settings.orphanMinAgeMin,
    agents,
    agentIndexOk: input.agents.index.ok,
    top,
    procs: table.procs,
    invoker: runtime.invoker,
    invOwnerPid: null,
    invTree: [],
    selfTree: [],
  };
  const orphans: OrphanDecision[] = [];
  for (const row of ps.rows) {
    if (row.ppid !== 1) continue;
    if (classify(row.cmd) !== null) continue;
    const envFacts = env.get(row.pid) ?? NO_ENV;
    const ledgerRow = previous.get(ledgerKey(row.pid, row.lstart)) ?? null;
    // `select($led != null or $envProof)` (:399-402). The reference lists an
    // unclassified launchd child as an orphan *candidate* only when the lineage
    // ledger names it or its env proves it belongs to this home
    // (`$e.home == "match" and $e.agent != null`). Without this gate every system
    // daemon on the box (ppid 1, no ledger row, an unreadable env) would appear as
    // an "orphan" — 364 rows on this host against the reference's 0, which is what
    // the equivalence harness found. Such a row is not a candidate at all: the
    // proof would refuse it anyway (no ledger executable path), and the report is
    // the reference's list.
    if (
      ledgerRow === null &&
      !(envFacts.read && envFacts.home === "match" && envFacts.agent !== null)
    ) {
      continue;
    }
    orphans.push(
      orphanDecision({
        row,
        env: envFacts,
        ledger: ledgerRow,
        ctx: orphanCtx,
      }),
    );
  }

  let ledgerNext: LedgerRow[] | null = null;
  if (input.wantLedger) {
    const current = currentLedgerRows({ rows: ps.rows, ident, env, previous }, runtime.now);
    // `$envrows` (:464-465): an orphan proven by its env alone, unprotected, with
    // an allowlisted comm, seeds the ledger at `now` so the next tick has a row.
    const envRows: LedgerRow[] = orphans
      .filter(
        (orphan) =>
          orphan.entry.proof === "env" &&
          orphan.entry.protected === null &&
          settings.killComms.includes(orphan.entry.comm) &&
          ident.ok,
      )
      .map((orphan) => ({
        pid: orphan.entry.pid,
        lstart: orphan.entry.lstart,
        comm: orphan.entry.comm,
        owner: orphan.entry.owner ?? `pid:${orphan.entry.pid}@${orphan.entry.lstart}`,
        first: runtime.now,
        orphaned: runtime.now,
        exe: "",
      }));

    const next = nextLedger({
      ledger: validated.rows,
      current,
      envRows,
      procs: ps.rows,
      now: runtime.now,
    }).rows;

    // `fill_exe` (:724-737): at most 40 `lsof` lookups, allowlisted comms only,
    // and only for rows that do not have an executable yet.
    let lookups = 0;
    const filled: LedgerRow[] = [];
    for (const row of next) {
      if (row.exe !== "" || !settings.killComms.includes(row.comm) || lookups >= EXE_LOOKUP_CAP) {
        filled.push(row);
        continue;
      }
      lookups += 1;
      const exe = exeOf(runtime.exec, row.pid);
      filled.push(exe === "" ? row : { ...row, exe });
    }
    ledgerNext = filled;

    // `write_lineage` (:739-745): an atomic replace; a failure is a note, never a
    // failed tick.
    const written = await writeLedger(ledgerPath, filled);
    if (!written.ok && written.note !== null) warn("gc ledger not written", { note: written.note });
  }

  if (loaded.note !== null) warn("gc ledger ignored", { note: loaded.note });

  return {
    ident,
    table,
    orphans,
    ps,
    top,
    env,
    ledgerNext,
    ledgerNote: loaded.note ?? "",
    ledgerDropped: validated.dropped,
  };
}

// ---------------------------------------------------------------------------
// The tree (slp-gc.bash:440-473) — report-only, but the memory sample carries it
// ---------------------------------------------------------------------------

/** `mb1` (slp-gc.bash:202): one decimal, jq's `round` on the scaled value. */
function mb1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The reference's test-runner comm test (`:447`). */
const TEST_RUNNER = /(^|[^A-Za-z0-9_.-])(vitest|jest|pytest|mocha|playwright)([^A-Za-z0-9_-]|$)/;

/**
 * `$P.tree` (slp-gc.bash:440-473): the app subtree's footprint, the proven
 * orphans', the daemon's own row, and the per-agent / per-test-runner tables.
 * Report-only — no rule reads it — so every value is a best effort and an empty
 * table answers a zero tree.
 */
export function buildTree(input: {
  rows: readonly ProcRow[];
  table: ProcTable;
  orphans: readonly OrphanDecision[];
  ident: Identity;
  ramMb: number | null;
  settings: GcSettings;
}): ReportTree {
  const { rows, table, orphans, ident } = input;
  const chain = ancestry(rows);
  const byPid = new Map<number, ProcRow>();
  for (const row of rows) byPid.set(row.pid, row);

  const roots =
    ident.appPid !== null
      ? [ident.appPid]
      : table.procs.filter((row) => row.class === "app-main").map((row) => row.pid);

  /** `fp` (:377) for a raw row: the built row's footprint, else its rss. */
  const footprint = new Map<number, number>();
  for (const row of table.procs) footprint.set(row.pid, row.footprint_mb);
  const fp = (row: ProcRow): number => footprint.get(row.pid) ?? row.rss_mb;

  let appMb = 0;
  for (const row of rows) {
    if (!chain(row).some((ancestor) => roots.includes(ancestor.pid))) continue;
    appMb += fp(row);
  }
  const proven = orphans.filter((orphan) => orphan.entry.proven);
  const orphanMb = proven.reduce((sum, orphan) => sum + orphan.entry.footprint_mb, 0);

  const ramMb = input.ramMb ?? 0;
  const treeWarn = input.settings.treeWarnMb ?? Math.floor(ramMb / 2);
  const totalMb = mb1(appMb + orphanMb);

  const agentTot: ReportTreeRow[] = [];
  for (const agent of table.procs.filter((row) => isAgentChild(row.class))) {
    const descendants = rows.filter((row) =>
      chain(row).some((ancestor) => ancestor.pid === agent.pid),
    );
    const tests = descendants.filter(
      (row) => !isAgentFamily(classify(row.cmd)) && TEST_RUNNER.test(row.cmd),
    );
    agentTot.push({
      pid: agent.pid,
      class: String(agent.class),
      owner: agent.owner ?? `pid:${agent.pid}@${agent.lstart}`,
      n: descendants.length,
      footprint_mb: mb1(descendants.reduce((sum, row) => sum + fp(row), 0)),
      testWorkers: tests.length,
      testMb: mb1(tests.reduce((sum, row) => sum + fp(row), 0)),
    });
  }
  const testRows = agentTot
    .filter((row) => row.testWorkers > 0)
    .sort((left, right) => right.testMb - left.testMb);

  const daemon = table.procs.find((row) => row.class === "daemon");

  return {
    totalMb,
    appMb: mb1(appMb),
    orphanMb: mb1(orphanMb),
    orphanN: proven.length,
    warnMb: treeWarn,
    ramMb,
    over: totalMb >= treeWarn,
    daemon:
      daemon === undefined
        ? null
        : {
            pid: daemon.pid,
            footprint_mb: daemon.footprint_mb,
            identified: daemon.pid === ident.daemonPid,
          },
    agents: [...agentTot].sort((left, right) => right.footprint_mb - left.footprint_mb).slice(0, 10),
    tests: {
      agents: testRows.length,
      warnAt: input.settings.testConcurrencyWarn,
      over: testRows.length > input.settings.testConcurrencyWarn,
      rows: testRows,
    },
  };
}

// ---------------------------------------------------------------------------
// The record scan's crumbs: `path`, `inode:size:mtime` and the file's size
// ---------------------------------------------------------------------------

/** The three facts about a record file that the decision and action steps re-check. */
export interface RecordCrumb {
  path: string;
  /** `fsig` (slp-gc.bash:52): `inode:size:mtime`, `""` when it cannot be read. */
  sig: string;
  /** `fsize`: bytes, `0` when it cannot be read. */
  size: number;
}

/** `fsig "$path"` (slp-gc.bash:52, 55), without following a symlink. */
export async function sigOf(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return "";
    return `${info.ino}:${info.size}:${Math.floor(info.mtimeMs / 1000)}`;
  } catch {
    return "";
  }
}

async function crumbOf(path: string): Promise<RecordCrumb> {
  try {
    const info = await lstat(path);
    return {
      path,
      sig: info.isFile() ? `${info.ino}:${info.size}:${Math.floor(info.mtimeMs / 1000)}` : "",
      size: info.size,
    };
  } catch {
    return { path, sig: "", size: 0 };
  }
}

/**
 * The record files the two scans walked: `<paseoHome>/agents/<workspace>/<id>.json`
 * (one level, no symlinks) and `<paseoHome>/schedules/<id>.json` (flat).
 *
 * `agents.ts` reduces a record to the keys its rule reads and keeps neither the
 * path nor its stat, so this is how the tick carries them: the same directories,
 * the same one-level shape, the id as the stem. A directory that cannot be read
 * contributes no crumbs, and a record without a crumb is passed on without
 * `path`/`sig` — which `garbageDecisions` reports as unverified and `reclaim`
 * refuses, rather than silently acting.
 */
export async function scanRecordFiles(paseoHome: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  const agentRoot = join(paseoHome, "agents");
  try {
    for (const workspace of await readdir(agentRoot, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const dir = join(agentRoot, workspace.name);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -".json".length);
        if (!files.has(id)) files.set(id, join(dir, entry.name));
      }
    }
  } catch {
    // An absent `agents/` is a healthy, empty index (`agents.ts` says so too).
  }

  const scheduleRoot = join(paseoHome, "schedules");
  try {
    for (const entry of await readdir(scheduleRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!files.has(`schedule:${id}`)) files.set(`schedule:${id}`, join(scheduleRoot, entry.name));
    }
  } catch {
    // As above.
  }

  return files;
}

/** A record plus the crumbs, or the bare record when its file could not be found. */
export type WithCrumbs<T> = T & Partial<RecordCrumb>;

async function attachCrumbs<T extends { id: string }>(
  records: readonly T[],
  files: Map<string, string>,
  key: (id: string) => string,
): Promise<WithCrumbs<T>[]> {
  const out: WithCrumbs<T>[] = [];
  for (const record of records) {
    const path = files.get(key(record.id));
    if (path === undefined) {
      out.push({ ...record });
      continue;
    }
    out.push({ ...record, ...(await crumbOf(path)) });
  }
  return out;
}

/** The agent record's key in the crumb map. */
const agentKey = (id: string): string => id;
/** The schedule record's key: the same id space, disambiguated. */
const scheduleKey = (id: string): string => `schedule:${id}`;

// ---------------------------------------------------------------------------
// The report's display sections (slp-gc.bash:495-557)
// ---------------------------------------------------------------------------

/** `astate($id)` (slp-gc.bash:491-494), for a schedule row's `targetState`. */
function agentState(
  id: string | null,
  byId: Map<string, AgentRec>,
  trusted: boolean,
): string {
  if (id === null) return "n/a";
  const record = byId.get(id);
  if (record !== undefined) return record.archivedAt !== null ? "archived" : "live";
  return trusted ? "missing" : "unknown";
}

/**
 * `$agentRows` (slp-gc.bash:495-522): one row per agent record, with the rule's
 * own verdict carried through. The state is the record's alone (`archived`,
 * `live`, `closed-unarchived`); a record that could not be parsed fails the whole
 * index in `agents.ts`, so there is no `unreadable` row to build here.
 */
function agentReportRows(
  records: readonly WithCrumbs<AgentRec>[],
  candidates: readonly GarbageCandidate[],
): ReportAgentRow[] {
  const byId = new Map<string, GarbageCandidate>();
  for (const candidate of candidates) {
    if (candidate.kind === "agent") byId.set(candidate.id, candidate);
  }
  return records.map((record) => {
    const candidate = byId.get(record.id);
    const state =
      record.archivedAt !== null
        ? "archived"
        : record.status === "closed"
          ? "closed-unarchived"
          : "live";
    return {
      category: "agent" as const,
      path: record.path ?? `agents/*/${record.id}.json`,
      id: record.id,
      state,
      garbage: candidate?.refusedBy === null,
      reason: candidate?.reason ?? "not garbage: no decision",
      // `$agentRows`' `action` (:503-519): the delete command on a garbage row, `"none"`
      // on every other one. Never `null` — the reference's report says `"none"` on all
      // 298 rows here, which is one of the differences the equivalence harness found.
      action: candidate?.refusedBy === null ? (candidate.action ?? "none") : "none",
    };
  });
}

/**
 * `$schedRows` (slp-gc.bash:523-548): one row per schedule record. The counts and
 * epochs are `agents.ts`'s; the target's state is `astate`; the rule's verdict is
 * the candidate's.
 */
function scheduleReportRows(
  records: readonly WithCrumbs<ScheduleRec>[],
  candidates: readonly GarbageCandidate[],
  agentRecords: readonly AgentRec[],
): ReportScheduleRow[] {
  const byId = new Map<string, GarbageCandidate>();
  for (const candidate of candidates) {
    if (candidate.kind === "schedule") byId.set(candidate.id, candidate);
  }
  const agentById = new Map<string, AgentRec>();
  for (const record of agentRecords) if (!agentById.has(record.id)) agentById.set(record.id, record);
  const trusted = agentRecords.length > 0;

  return records.map((record) => {
    const candidate = byId.get(record.id);
    const targetState =
      record.targetType === "agent" ? agentState(record.targetAgent, agentById, trusted) : "n/a";
    // `$schedRows`' three report-only arms (:544-547): the anomaly row carries
    // `anomaly: true` and its own action sentence, and every other refused row says
    // `"none"`; only a garbage row carries the delete command.
    const anomaly = candidate?.refusedBy?.startsWith("schedule-anomaly:") === true;
    return {
      category: "schedule" as const,
      path: record.path ?? `schedules/${record.id}.json`,
      size: record.size ?? 0,
      ok: true,
      id: record.id,
      name: record.name,
      status: record.status,
      strict: record.strict,
      targetType: record.targetType,
      targetAgent: record.targetAgent,
      cadence: record.cadence,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      updatedEpoch: record.updatedEpoch,
      lastRunAt: record.lastRunAt,
      lastRunEpoch: record.lastRunEpoch,
      nextRunAt: record.nextRunAt,
      room: record.room,
      runs: record.runs,
      runsRunning: record.runsRunning,
      fires1h: record.fires1h,
      fires24h: record.fires24h,
      fail24h: record.fail24h,
      activeRunFail24h: record.activeRunFail24h,
      targetState,
      garbage: candidate?.refusedBy === null,
      ...(anomaly ? { anomaly: true } : {}),
      reason: candidate?.reason ?? "not garbage: no decision",
      action:
        candidate?.refusedBy === null
          ? (candidate.action ?? "none")
          : anomaly
            ? "none (report-only in this version)"
            : "none",
    };
  });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** Everything one tick reads, plus the seams a test drives it through. */
export interface TickDeps {
  /** The plugin's GC state dir (`$PASEO_HOME/plugin-data/agent-room/gc`). */
  stateDir: string;
  /** The merged settings reader (plugin document over the imported conf baseline). */
  readSettings: () => Promise<GcSettings>;
  /** `$HOME`; defaults to `os.homedir()`. */
  home?: string;
  /** `$PHOME`; defaults to `$PASEO_HOME` or `<home>/.paseo`. */
  paseoHome?: string;
  /** `$PASEO_HOME` verbatim, for the env `bound()` arm; defaults from the environment. */
  paseoHomeRaw?: string;
  /** The reference's state dir, migrated from once per process. */
  legacyStateDir?: string;
  /** Set once `migrateState` has **succeeded**; the tick flips it, never clears it. */
  migrated?: boolean;
  now?: () => number;
  /**
   * Override the GC's own pid. Production omits it and gets `NO_SELF_PID`, which
   * matches no `ps` row (the plugin has no process tree of its own); a test that
   * wants to prove the self-tree arm still protects a real tree passes one.
   */
  selfPid?: number;
  env?: Record<string, string | undefined>;
  log?: GcLog;
  /** The exec seam; defaults to `defaultExec`. */
  exec?: GcExec;
  /** `paseo agent delete --home <home> -- <id>`. Defaults to the CLI through the exec seam. */
  deleteAgent?: (id: string) => Promise<unknown>;
  /** `paseo schedule delete --home <home> -- <id>`. Defaults to the CLI through the exec seam. */
  deleteSchedule?: (id: string) => Promise<unknown>;
  /** `process.kill(pid, "SIGTERM")`; defaults to the real one. */
  signal?: (pid: number, signal: "SIGTERM") => unknown;
  /** The alert notification seam (`osascript` by default); a test passes a no-op. */
  notify?: Notify;
  /** Test seams: replace one phase (each still runs inside the tick's error guard). */
  seams?: TickSeams;
}

export interface TickSeams {
  /** Replace the process phase (`collectProcsPhase`). */
  procs?: (input: ProcsPhaseInput) => Promise<ProcsPhase>;
  /**
   * Replace the one-time state copy (`migrateState`). A seam, because that call
   * owns the `deps.migrated` flag and a test has to be able to make it fail.
   */
  migrate?: (input: { from: string; to: string }) => Promise<MigrateResult>;
  /** Replace the memory-sample writer (`recordSample`). */
  record?: (input: {
    stateDir: string;
    report: GcReport;
    now: number;
    system: Partial<MemorySampleSystem>;
  }) => Promise<{ line: unknown; alert: string | null }>;
}

export interface TickResult {
  /** `at: deps.now()` — the tick's own finish, as the reference's `$NOW`-derived ISO text. */
  at: string;
  /** The same instant in epoch seconds. */
  epoch: number;
  /** Whether the memory sample landed (`recorded.line !== null`). */
  recorded: boolean;
  report: GcReport;
  /** Every record candidate the rules considered, refused ones included. */
  candidates: GarbageCandidate[];
  acted: ActionResult[];
  /** The settings this tick acted on. */
  settings: GcSettings;
  /** When the next report is due, ISO, or `null` when the interval is unreadable. */
  nextReportAt: string | null;
  /**
   * When a report text was last written, ISO: this tick's own `startedAt` when it
   * wrote one (`.last-report` accepted it), else the `.last-report` stamp it read,
   * else `null`. Read-only status: nothing in the tick's decisions reads it.
   */
  lastReportAt: string | null;
  /** The newest `alerts.log` lines, newest first (`ALERTS_STATUS_LIMIT`), for the status. */
  alerts: GcStatus["alerts"];
  /** Whether `alerts.log` could be read; `false` is "unknown", not "empty". */
  alertsReadable: boolean;
  /** The migration's answer on the tick that ran it, else `null`. */
  migrated: MigrateResult | null;
}

/**
 * The newest `alerts.log` lines as `gc.status` publishes them, newest first.
 *
 * The file is append-only (`:1229`, after `recordSample`'s rotation), so the tail
 * is the history: the last `limit` non-blank lines, reversed. A line reads
 * `<iso> ALERT <arms>` — the reference's own shape — and is split at its first
 * space: the stamp becomes `at`, the rest stays verbatim as `text`. A line whose
 * first token is not an ISO stamp is kept whole with `at: ""`, because a line this
 * port cannot parse is still an alert a person should see.
 *
 * An absent or unreadable file is no alerts: a fresh install has none, and a
 * status read must never fail over one. The two cases are not the same answer to
 * the screen, though, so `readable` says which one it was — an absent file is a
 * history that has not started (`readable: true`), a failed read is a history that
 * could not be read (`readable: false`).
 */
export async function readAlertTail(
  stateDir: string,
  limit: number = ALERTS_STATUS_LIMIT,
): Promise<{ alerts: GcStatus["alerts"]; readable: boolean }> {
  if (limit <= 0) return { alerts: [], readable: true };
  let text: string;
  try {
    text = await readFile(join(stateDir, ALERTS_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // No file yet is a fresh install, not a read failure.
    return { alerts: [], readable: code === "ENOENT" || code === "ENOTDIR" };
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const tail = lines.slice(Math.max(0, lines.length - limit)).reverse();
  return {
    alerts: tail.map((line) => {
      const space = line.indexOf(" ");
      const head = space < 0 ? line : line.slice(0, space);
      const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(head.trim());
      return stamp
        ? { at: head.trim(), text: line.slice(space + 1).trim() }
        : { at: "", text: line.trim() };
    }),
    readable: true,
  };
}

/** Run one phase, logging and falling back instead of throwing (property 1). */
async function phase<T>(
  log: GcLog | undefined,
  name: string,
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    warnLog(log)(`gc tick: ${name} failed`, { error: reasonOf(error) });
    return fallback;
  }
}

/** `date +%s`: the wall clock in whole seconds, for the acting modules' rechecks. */
function wallClockSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The empty agent snapshot a failed scan degrades to. */
function emptyAgents(): AgentSnapshot {
  return { agents: [], index: { ok: false, why: ["the agent scan failed"] } };
}

/** The empty schedule snapshot a failed scan degrades to. */
function emptySchedules(): ScheduleSnapshot {
  return { schedules: [], index: { ok: false, why: ["the schedule scan failed"] } };
}

/** The reference's `-1`-style empty process phase: identification failed outright. */
function emptyProcsPhase(why: string): ProcsPhase {
  const ident: Identity = {
    ok: false,
    why,
    pidFile: false,
    supervisor: false,
    daemon: false,
    listener: false,
    homeBound: false,
    supHome: "unreadable",
    listen: null,
    supervisorPid: null,
    daemonPid: null,
    appPid: null,
  };
  return {
    ident,
    table: { procs: [], famPids: [] },
    orphans: [],
    ps: { rows: [], badRows: 0, dupes: 0 },
    top: new Map(),
    env: new Map(),
    ledgerNext: null,
    ledgerNote: "",
    ledgerDropped: 0,
  };
}

/** The `MEMORY.jsonl` line counter's clock: `date +%s` over the tick's own now. */
function epochOf(clock: () => number): number {
  const value = clock();
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Math.floor(Date.now() / 1000);
}

/**
 * Read `$STATE/.last-report` (slp-gc.bash:1309-1310): epoch seconds, or `0` for
 * an absent or unreadable file (`is_uint "$last" || last=0`).
 */
async function readLastReport(stateDir: string): Promise<number> {
  try {
    const text = (await readFile(join(stateDir, ".last-report"), "utf8")).trim();
    return UINT.test(text) ? Number(text) : 0;
  } catch {
    return 0;
  }
}

/**
 * `ts_now` in the state dir, then the prune to 48 (slp-gc.bash:1325-1327).
 *
 * One report stamp owns **two** artifacts: the rendered text the reference writes
 * (`reports/<stamp>.txt`, `renderReport`) and the JSON the reference prints with
 * `report --json` (`reports/<stamp>.json`, the assembled `GcReport` at jq's
 * two-space indent). The port assembles one report object per tick and renders the
 * text from it; persisting that object is what lets a later reader — the
 * equivalence harness, or anyone comparing the port with the reference — diff a
 * tick's report without re-running it. `REPORTS_KEPT` counts *stamps*, so 48
 * reports are up to 96 files, and the prune removes both artifacts of an expired
 * stamp together (a JSON left behind would otherwise accumulate one file a tick).
 */
async function writeReportFile(stateDir: string, now: number, report: GcReport): Promise<void> {
  const reports = join(stateDir, "reports");
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const stamp = reportStamp(now);
  await writeFile(join(reports, `${stamp}.txt`), renderReport(report), {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(reports, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  let names: string[];
  try {
    names = await readdir(reports);
  } catch {
    return;
  }
  const REPORT_NAME = /^(\d{8}T\d{6}Z)\.(txt|json)$/;
  const stamps = [
    ...new Set(
      names
        .map((name) => REPORT_NAME.exec(name)?.[1])
        .filter((value): value is string => value !== undefined),
    ),
  ].sort();
  // Newest 48 stamps survive (the reference's `sort -r | tail -n +49`).
  const keep = new Set(stamps.reverse().slice(0, REPORTS_KEPT));
  for (const name of names) {
    const stampOfName = REPORT_NAME.exec(name)?.[1];
    // Anything that is not one of this directory's two report artifacts is left alone.
    if (stampOfName === undefined || keep.has(stampOfName)) continue;
    try {
      await rm(join(reports, name), { force: true });
    } catch {
      // A report that will not go away is not worth a failed tick.
    }
  }
}

/**
 * The decision half of `do_apply`'s two gates (`:1050-1057`), answered as the
 * rows the screen shows: identification first, then the index. `null` means both
 * hold and the caller may act.
 */
function applyGateRefusal(
  ident: Identity,
  index: { ok: boolean; why: readonly string[] },
): ActionResult | null {
  if (ident.ok !== true) {
    return {
      kind: "refuse",
      id: "-",
      acted: false,
      reason: `refused: identification failed: ${ident.why}`,
      refusedBy: `identification: ${ident.why}`,
    };
  }
  if (index.ok !== true) {
    const why = index.why.join("; ");
    return {
      kind: "refuse",
      id: "-",
      acted: false,
      reason: `refused: index incomplete: ${why}`,
      refusedBy: `index-incomplete: ${why}`,
    };
  }
  return null;
}

/**
 * `paseo <kind> delete --home <home> -- <id>` (:1093), through the exec seam.
 *
 * The plugin's `PaseoApi` surface has no delete call and no schedules at all, so
 * the reference's own CLI is the only route — and it is the route the reference
 * takes, with the same `--home` argument and the `SLP_GC_CLI_TIMEOUT` budget. A
 * non-zero exit rejects, which `reclaim` records as a `delete-failed` row and the
 * loop continues (`fail=1` in the reference does not stop the run).
 */
function cliDelete(
  runtime: GcRuntime,
  settings: GcSettings,
  kind: "agent" | "schedule",
): (id: string) => Promise<unknown> {
  const cli = "paseo";
  return async (id: string): Promise<void> => {
    const result = runExec(
      runtime.exec,
      [cli, kind, "delete", "--home", runtime.paseoHome, "--", id],
      settings.cliTimeoutS * 1000,
    );
    if (result.timedOut) throw new Error(`paseo ${kind} delete timed out after ${settings.cliTimeoutS}s`);
    if (result.code !== 0) {
      throw new Error(`paseo ${kind} delete exited ${String(result.code)}: ${result.stderr.trim()}`.trim());
    }
  };
}

/**
 * One tick (`do_tick`, slp-gc.bash:1300-1338).
 *
 * Phases, in the reference's order: settings, migration (once), the two record
 * scans, the process phase, `do_record`, the report when due, then the acting
 * phases behind their gates. Nothing here throws: every phase is wrapped by
 * `phase()`, and the acting modules turn their own dependency failures into rows.
 *
 * `reportOnly` is the RPC's `mode: "report"` and the port's only override: it
 * turns the three acting toggles **off** for this tick, so it can only ever do
 * less than a scheduled tick. It cannot turn a rule on.
 */
export async function runTick(
  deps: TickDeps,
  options: { reportOnly?: boolean } = {},
): Promise<TickResult> {
  const clock = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const env = deps.env ?? process.env;
  const log = deps.log;
  const home = deps.home ?? os.homedir();
  const paseoHomeRaw = deps.paseoHomeRaw ?? (env.PASEO_HOME?.trim() ?? "");
  const paseoHome =
    deps.paseoHome ??
    (paseoHomeRaw !== "" ? paseoHomeRaw : join(home, ".paseo"));
  const startedAt = epochOf(clock);

  const runtime: GcRuntime = {
    home,
    paseoHome,
    paseoHomeRaw,
    stateDir: deps.stateDir,
    now: startedAt,
    // **Not** `process.pid`: inside the plugin that is the daemon, and a self-tree
    // rooted at the daemon would protect every agent process (see `NO_SELF_PID`).
    // The reference's `$$` has a real, tiny tree; this process has none.
    selfPid: deps.selfPid ?? NO_SELF_PID,
    invoker: env.PASEO_AGENT_ID !== undefined && env.PASEO_AGENT_ID !== "" ? env.PASEO_AGENT_ID : null,
    exec: deps.exec ?? defaultExec,
    homeDefault: paseoHomeRaw === "" || paseoHomeRaw === join(home, ".paseo"),
    log,
  };

  // --- settings (:1302). A reader that throws is the baseline, out loud.
  const readSettings = await phase(
    log,
    "settings",
    async () => deps.readSettings(),
    { ...DEFAULT_GC_SETTINGS },
  );
  const settings: GcSettings = options.reportOnly === true
    ? { ...readSettings, apply: false, killStale: false, killMemory: false }
    : readSettings;

  // --- migration, once per process, before the first record (:169's state dir).
  let migrated: MigrateResult | null = null;
  if (deps.migrated !== true) {
    const legacy = deps.legacyStateDir ?? join(home, "Library/Logs/slp-gc");
    const runMigrate: NonNullable<TickSeams["migrate"]> =
      deps.seams?.migrate ?? ((input) => migrateState(input));
    try {
      migrated = await runMigrate({ from: legacy, to: deps.stateDir });
      // Only *this* tick, which actually ran the copy, may claim it is done. Set
      // it here and not before the call: a migration that rejects has not run,
      // and a later tick has to retry it — the flag is what makes the retry
      // reachable, so setting it on failure would silently skip the copy forever.
      deps.migrated = true;
    } catch (error) {
      warnLog(log)("gc tick: migrate failed", { error: reasonOf(error) });
      // `migrated: null` (nothing was copied) and `deps.migrated` still unset, so
      // the next tick tries again.
      migrated = null;
    }
  }

  // `mkdir -p "$STATE"` (:1301): everything below writes into it, and the ledger
  // reader refuses a state dir that is not this uid at `0700` (:708), so the
  // directory is created (and its mode set) before the process phase reads it.
  await phase(
    log,
    "state dir",
    async () => {
      await mkdir(deps.stateDir, { recursive: true, mode: 0o700 });
    },
    undefined,
  );

  // --- the two record scans (:888).
  const agentsSnapshot = await phase(
    log,
    "agent index",
    () => snapshotAgents(paseoHome, { log }),
    emptyAgents(),
  );
  const schedulesSnapshot = await phase(
    log,
    "schedule index",
    () => snapshotSchedules(paseoHome, { log, now: startedAt }),
    emptySchedules(),
  );

  // --- the process phase (:765-793). It carries the identification verdict the
  // record rules refuse on, so a failed phase refuses everything downstream.
  const procsPhase = await phase(
    log,
    "process table",
    () =>
      (deps.seams?.procs ?? collectProcsPhase)({
        runtime,
        settings,
        agents: agentsSnapshot,
        wantLedger: true,
      }),
    emptyProcsPhase("the process phase failed"),
  );
  const ident = procsPhase.ident;

  // --- the report's inputs. The index is the reference's single `$idx.ok`: both
  // scans complete (`snapshotAgents().index.ok && snapshotSchedules().index.ok`).
  const index = {
    ok: agentsSnapshot.index.ok && schedulesSnapshot.index.ok,
    why: [...agentsSnapshot.index.why, ...schedulesSnapshot.index.why],
  };

  const files = await phase(log, "record scan", () => scanRecordFiles(paseoHome), new Map<string, string>());
  const agentRecords = await attachCrumbs(agentsSnapshot.agents, files, agentKey);
  const scheduleRecords = await attachCrumbs(schedulesSnapshot.schedules, files, scheduleKey);

  // `$procOwners` (:486): every owner the process table and the orphan table
  // still carry — the "a process with PASEO_AGENT_ID=<id> is running" arm.
  const procOwners = [
    ...new Set(
      [
        ...procsPhase.table.procs.map((row) => row.owner),
        ...procsPhase.orphans.map((orphan) => orphan.entry.owner),
      ].filter((owner): owner is string => typeof owner === "string" && owner !== ""),
    ),
  ];

  const candidates = garbageDecisions({
    now: startedAt,
    minDays: AGENT_MIN_DAYS,
    agents: agentRecords,
    schedules: scheduleRecords,
    indexOk: index.ok,
    indexWhy: index.why,
    // `$busyRefs` / `$rawRefs` (:488, :513): in-flight creations are not scanned
    // by this port, and `agents.ts` fails the whole index on a record it cannot
    // reduce instead of collecting raw refs — so both are empty by construction.
    busyRefs: [],
    rawRefs: [],
    procOwners,
    invoker: runtime.invoker,
    identification: { ok: ident.ok, why: ident.why },
    envBlind: procsPhase.table.procs.filter((row) => isAgentFamily(row.class) && !row.envRead).length,
    paseoHome,
  });

  const sigs = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.sig !== "") sigs.set(candidate.path, candidate.sig);
  }

  // --- the decisions the two process rules reached, attached to the rows the
  // report and the kill phase read (`$P.procs[].stale/.overmem`, :375).
  const decisionCtx: DecisionContext = {
    identity: ident,
    killMb: settings.memKillMb,
    killComms: settings.killComms,
    warnMb: settings.memWarnMb,
    famPids: procsPhase.table.famPids,
    invoker: runtime.invoker,
  };
  const decided: DecidedProc[] = procsPhase.table.procs.map((row) => ({
    ...row,
    stale: staleDecision(row, decisionCtx),
    overmem: overmemDecision(row, decisionCtx),
  }));

  const lastReport = await readLastReport(deps.stateDir);
  const reportDue = startedAt - lastReport >= settings.reportIntervalMin * 60;
  // The `.last-report` stamp as this tick leaves it. Status only: it is what the
  // screen's "last report" row shows, and it moves only when the file really
  // landed (see the report phase below).
  let reportedAt = lastReport;

  const tree = buildTree({
    rows: procsPhase.ps.rows,
    table: procsPhase.table,
    orphans: procsPhase.orphans,
    ident,
    ramMb: collectRamMb(runtime.exec),
    settings,
  });

  // --- `evaluate full`'s report-only collectors (:900-903): only when a report is
  // due, exactly as the reference's `mode=full` (:1322).
  const transcripts = reportDue
    ? await phase(
        log,
        "transcripts",
        async () =>
          collectTranscripts(runtime.exec, {
            home,
            claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null,
          }),
        [],
      )
    : [];
  const daemonMetrics = reportDue
    ? await phase(log, "daemon metrics", async () => collectDaemonMetrics(runtime.exec, { home: paseoHome }), [])
    : [];
  const retention = reportDue
    ? await phase(
        log,
        "retention",
        async () =>
          collectRetention(runtime.exec, {
            home: paseoHome,
            now: startedAt,
            liveAgentCwds: agentsSnapshot.agents
              .filter((record) => record.archivedAt === null && record.cwd !== null)
              .map((record) => record.cwd as string),
          }),
        [],
      )
    : [];

  const report: GcReport = buildReport({
    now: startedAt,
    home: paseoHome,
    procs: {
      ident,
      procs: decided,
      orphans: procsPhase.orphans.map((orphan) => orphan.entry),
      unreadableRows: procsPhase.ps.badRows,
      ledgerNext: procsPhase.ledgerNext,
      ledgerNote: procsPhase.ledgerNote,
      ledgerDropped: procsPhase.ledgerDropped,
      tree,
      envBlind: decided
        .filter((row) => isAgentFamily(row.class) && !row.envRead)
        .map((row) => row.pid),
      warnMb: settings.memWarnMb,
      killMb: settings.memKillMb,
    },
    agents: agentReportRows(agentRecords, candidates),
    schedules: scheduleReportRows(scheduleRecords, candidates, agentsSnapshot.agents),
    index,
    garbage: candidates,
    sigs,
    transcripts,
    daemonMetrics,
    retention,
    agentRecords: agentsSnapshot.agents,
  });

  // --- do_record (:1308). A rejected sample is the one write a tick must survive
  // (record.ts's own contract): it costs the sample, never the tick.
  const system = await phase(log, "system counters", async () => collectSystem(runtime.exec), {});
  const writeSample: NonNullable<TickSeams["record"]> =
    deps.seams?.record ?? ((input) => recordSample({ ...input, notify: deps.notify }));
  const recorded = await phase(
    log,
    "record",
    async () => writeSample({ stateDir: deps.stateDir, report, now: startedAt, system }),
    { line: null, alert: null as string | null },
  );

  // --- the report, when due (:1324-1328). The `.last-report` stamp is written
  // only after the file landed, so a failed write retries next tick.
  if (reportDue) {
    await phase(log, "report", async () => {
      await writeReportFile(deps.stateDir, startedAt, report);
      await writeFile(join(deps.stateDir, ".last-report"), `${startedAt}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      // Only a report that landed moves the stamp: a failed write leaves the
      // previous one, exactly as the file on disk does.
      reportedAt = startedAt;
    }, undefined);
  }

  // --- do_apply (:1329-1332): both gates, then the deletes and the kills behind
  // the settings' toggles.
  const acted: ActionResult[] = [];
  const gate = applyGateRefusal(ident, index);
  const eligible = candidates.filter((candidate) => candidate.refusedBy === null);
  // `sig: ""` never reaches an action: `fsig` could not be read for this record
  // file, and an unverified row is not deletable (`apply.ts`'s rule). The refusal
  // is reported as its own row so the screen can say why it stayed.
  const unsigned = eligible.filter((candidate) => candidate.sig === "");

  if (settings.apply) {
    if (gate !== null) {
      // One row, not one per candidate: `do_apply` refuses the whole run on either
      // gate and returns before *both* of its loops (`:1050-1057`), so the kills
      // below are refused by this same row and nothing is even considered. The row
      // names the gate that refused (`identification: …` / `index-incomplete: …`).
      acted.push(gate);
    } else {
      for (const candidate of unsigned) {
        acted.push({
          kind: candidate.kind,
          id: candidate.id,
          acted: false,
          reason:
            "the record scan could not read the record file's signature: refusing rather than acting on an unverified row",
          refusedBy:
            "sig-unverified: the candidate carries no signature to re-check",
        });
      }
      const deletes = await phase(
        log,
        "reclaim",
        () =>
          reclaim(
            {
              candidates: eligible
                .filter((candidate) => candidate.sig !== "")
                .map((candidate) => toReclaimCandidate(candidate, agentRecords, scheduleRecords)),
              indexOk: index.ok,
              indexWhy: index.why,
              maxActions: undefined,
              budgetS: settings.tickBudgetS,
              startedAt,
              // `SLP_GC_APPLY` decides *what* may be reclaimed; both rules are
              // named explicitly so a row of any other rule is refused.
              enabledRules: ["agent-archived", "schedule-completed"],
            },
            {
              deleteAgent:
                deps.deleteAgent ?? cliDelete(runtime, settings, "agent"),
              deleteSchedule:
                deps.deleteSchedule ?? cliDelete(runtime, settings, "schedule"),
              verify: async (candidate) => verifyRecord(candidate, {
                runtime,
                settings,
                agents: agentsSnapshot,
                paseoHome,
                log,
              }),
              lstat: (path: string) => {
                const info = lstatSyncOrNull(path);
                if (info === null) return null;
                return { isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() };
              },
              now: () => epochOf(clock),
              log,
            },
          ),
        [],
      );
      acted.push(...deletes);
    }
  }

  // The kills sit behind the *same* two gates as the deletes: `do_apply` answers
  // both refusals before either loop runs (`:1050-1057`), so a refused run signals
  // nothing — and `gate`, already reported once above, is the whole of the refusal.
  if (settings.apply && gate === null && (settings.killStale || settings.killMemory)) {
    const kinds: KillKind[] = [];
    if (settings.killStale) kinds.push("stale");
    if (settings.killMemory) kinds.push("mem");
    const killList = killCandidates(decided, procsPhase.orphans, runtime, settings.killComms);

    // The reference's `recheck` (`:1116`) re-reads the agent records before *every*
    // signal, so the owner state a stale-eligibility decision reads is never older
    // than the signal it authorises; the tick's own snapshot can be a whole tick
    // stale. One re-read per kill phase, not one per candidate: the same freshness
    // for a bounded cost. A phase with no candidate reads nothing, because the
    // reference's recheck lives inside its per-pid loop.
    let killAgents: AgentSnapshot | null = null;
    if (killList.length > 0) {
      try {
        const reread = await snapshotAgents(paseoHome, { log });
        // An incomplete re-read is a failed re-read: the reference's `recheck` fails
        // outright when its own record scan fails (`:1028`), and a stale-eligibility
        // decision must not be taken on half the records.
        if (reread.index.ok === true) {
          killAgents = reread;
        } else {
          warnLog(log)("gc kills refused: the agent index is incomplete", {
            problems: reread.index.why.length,
          });
        }
      } catch (error) {
        warnLog(log)("gc kills refused: the agent records could not be re-read", {
          error: reasonOf(error),
        });
      }
    }

    if (killList.length > 0) {
      if (killAgents === null) {
        // A re-read that failed refuses the phase the way an incomplete index refuses
        // the deletes (`:1054-1057`): one row for the phase, and no signal from a
        // decision whose inputs could not be read.
        acted.push({
          kind: "refuse",
          id: "-",
          acted: false,
          reason:
            "refused: the agent records could not be re-read before the kill phase (the re-read threw, or its own index is incomplete), so no signal was sent",
          refusedBy: "index-incomplete: the kill phase's agent re-read failed",
        });
      } else {
        const freshAgents: AgentSnapshot = killAgents;
        const kills = await phase(
          log,
          "kills",
          () =>
            signalCandidates(
              {
                candidates: killList,
                maxKills: settings.maxKills,
                budgetS: settings.tickBudgetS,
                startedAt,
                // The toggles, explicitly: a rule that is off in the settings cannot
                // signal, whatever the caller's candidate list contains.
                kinds,
                memKillMb: settings.memKillMb,
                killComms: settings.killComms,
              },
              {
                signal:
                  deps.signal ??
                  ((pid: number, signal: "SIGTERM") => process.kill(pid, signal)),
                reevaluate: (candidate) =>
                  reevaluateProc(candidate, { runtime, settings, agents: freshAgents, log }),
                now: () => epochOf(clock),
                log,
              },
            ),
          [],
        );
        acted.push(...kills);
      }
    }
  }

  const epoch = epochOf(clock);
  const nextReportAt =
    settings.reportIntervalMin > 0
      ? isoUtc((reportDue ? startedAt : lastReport) + settings.reportIntervalMin * 60)
      : null;

  // --- the status tail (`alerts.log`, :1229). Read last, so an alert this tick
  // just wrote is in it. Status only: no rule reads the file, and an unreadable
  // one is an empty tail rather than a failed tick.
  const alertTail = await phase(
    log,
    "alerts tail",
    () => readAlertTail(deps.stateDir),
    // A failed read is not an empty history: the screen has to be able to say so.
    { alerts: [] as GcStatus["alerts"], readable: false },
  );

  return {
    at: isoUtc(epoch),
    epoch,
    recorded: recorded.line !== null,
    report,
    candidates,
    acted,
    settings,
    nextReportAt,
    lastReportAt: reportedAt > 0 ? isoUtc(reportedAt) : null,
    alerts: alertTail.alerts,
    alertsReadable: alertTail.readable,
    migrated,
  };
}

// ---------------------------------------------------------------------------
// The acting phases' inputs
// ---------------------------------------------------------------------------

/** `lstat` for `reclaim`'s file gate: a synchronous answer, `null` when absent. */
function lstatSyncOrNull(path: string): { isFile(): boolean; isSymbolicLink(): boolean } | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** A report garbage row as the acting step re-checks it (`$garbage[]`, :1070). */
function toReclaimCandidate(
  candidate: GarbageCandidate,
  agentRecords: readonly WithCrumbs<AgentRec>[],
  scheduleRecords: readonly WithCrumbs<ScheduleRec>[],
): ReclaimCandidate {
  const base: ReclaimCandidate = {
    kind: candidate.kind,
    id: candidate.id,
    path: candidate.path,
    sig: candidate.sig,
    rule: candidate.rule,
    refusedBy: candidate.refusedBy,
    reason: candidate.reason,
    action: candidate.action,
  };
  if (candidate.kind === "agent") {
    const record = agentRecords.find((entry) => entry.id === candidate.id);
    if (record === undefined) return base;
    return { ...base, archivedAt: record.archivedAt, archivedEpoch: record.archivedEpoch };
  }
  const record = scheduleRecords.find((entry) => entry.id === candidate.id);
  if (record === undefined) return base;
  return {
    ...base,
    updatedAt: record.updatedAt,
    lastRunAt: record.lastRunAt,
    archivedAt: null,
  };
}

/**
 * The recheck behind a delete (`recheck`, :1028 → `evaluate light`): a full fresh
 * record scan and the rule's verdict on it, plus the file's fresh signature.
 *
 * The process half is re-read too: the agent rule's "no live process carries this
 * id" arm is only as fresh as the sample it read. A fresh pass that fails answers
 * `null`, which `reclaim` turns into a refusal.
 */
async function verifyRecord(
  candidate: ReclaimCandidate,
  input: {
    runtime: GcRuntime;
    settings: GcSettings;
    agents: AgentSnapshot;
    paseoHome: string;
    log?: GcLog;
  },
): Promise<VerifyAnswer> {
  const now = wallClockSeconds();
  const fresh = await collectProcsPhase({
    runtime: { ...input.runtime, now },
    settings: input.settings,
    agents: input.agents,
    wantLedger: false,
  });

  const agents = await snapshotAgents(input.paseoHome, { log: input.log });
  const schedules = await snapshotSchedules(input.paseoHome, { log: input.log, now });
  const files = await scanRecordFiles(input.paseoHome);
  const agentRecords = await attachCrumbs(agents.agents, files, agentKey);
  const scheduleRecords = await attachCrumbs(schedules.schedules, files, scheduleKey);
  const index = {
    ok: agents.index.ok && schedules.index.ok,
    why: [...agents.index.why, ...schedules.index.why],
  };

  const procOwners = [
    ...new Set(
      [
        ...fresh.table.procs.map((row) => row.owner),
        ...fresh.orphans.map((orphan) => orphan.entry.owner),
      ].filter((owner): owner is string => typeof owner === "string" && owner !== ""),
    ),
  ];

  const rows = garbageDecisions({
    now,
    minDays: AGENT_MIN_DAYS,
    agents: agentRecords,
    schedules: scheduleRecords,
    indexOk: index.ok,
    indexWhy: index.why,
    busyRefs: [],
    rawRefs: [],
    procOwners,
    invoker: input.runtime.invoker,
    identification: { ok: fresh.ident.ok, why: fresh.ident.why },
    envBlind: fresh.table.procs.filter((row) => isAgentFamily(row.class) && !row.envRead).length,
    paseoHome: input.paseoHome,
  });
  const row = rows.find((entry) => entry.kind === candidate.kind && entry.id === candidate.id);
  if (row === undefined) return null;

  const path = candidate.path ?? "";
  const sig = path === "" ? "" : await sigOf(path);
  const record =
    candidate.kind === "agent"
      ? agentRecords.find((entry) => entry.id === candidate.id)
      : scheduleRecords.find((entry) => entry.id === candidate.id);

  return {
    sig,
    refusedBy: row.refusedBy,
    reason: row.reason,
    updatedAt: candidate.kind === "schedule" ? ((record as WithCrumbs<ScheduleRec>)?.updatedAt ?? null) : null,
    archivedAt: candidate.kind === "agent" ? ((record as WithCrumbs<AgentRec>)?.archivedAt ?? null) : null,
    archivedEpoch:
      candidate.kind === "agent" ? ((record as WithCrumbs<AgentRec>)?.archivedEpoch ?? null) : null,
    lastRunAt: candidate.kind === "schedule" ? ((record as WithCrumbs<ScheduleRec>)?.lastRunAt ?? null) : null,
  };
}

/**
 * A table row with the two decisions the reference attaches after classification
 * (`$P.procs[].stale/.overmem`, :375). The report reads them as `ReportProcInput`
 * and the kill phase reads them as its candidates, so the tick builds them once.
 */
export type DecidedProc = ProcEntry & { stale: Decision; overmem: Decision };

/** The rows the kill phase considers (`$final` + `$orph`, :1166). */
function killCandidates(
  procs: readonly DecidedProc[],
  orphans: readonly OrphanDecision[],
  runtime: GcRuntime,
  killComms: readonly string[],
): KillCandidate[] {
  const rows: KillCandidate[] = [];
  for (const row of procs) {
    rows.push({
      pid: row.pid,
      class: String(row.class),
      stale: row.stale,
      overmem: row.overmem,
      footprint_mb: row.footprint_mb,
      protected: row.protected,
      why: row.stale.eligible ? row.stale.why : row.overmem.why,
      lstart: row.lstart,
      ppid: row.ppid,
      comm: row.exe,
      exePath: row.protected === null && (row.stale.eligible || row.overmem.eligible)
        ? exeOf(runtime.exec, row.pid)
        : undefined,
      owner: row.owner,
    });
  }
  for (const orphan of orphans) {
    if (!killComms.includes(orphan.entry.comm)) {
      // The reference only ever lists an allowlisted orphan's kill decision; every
      // other row is refused by the proof already, so it is not a candidate.
      continue;
    }
    rows.push({
      pid: orphan.entry.pid,
      class: "orphan",
      stale: orphan.stale,
      overmem: orphan.overmem,
      footprint_mb: orphan.entry.footprint_mb,
      protected: orphan.entry.protected,
      why: orphan.stale.eligible ? orphan.stale.why : orphan.overmem.why,
      lstart: orphan.entry.lstart,
      ppid: orphan.entry.ppid,
      comm: orphan.entry.comm,
      exePath: orphan.entry.exePath,
      owner: orphan.entry.owner,
      proof: orphan.entry.proof,
    });
  }
  return rows;
}

/**
 * The recheck behind a signal (`recheck`, :1116): a full fresh process phase, the
 * row found by pid, and both rules re-run on it. `null` means the row is gone.
 */
async function reevaluateProc(
  candidate: KillCandidate,
  input: { runtime: GcRuntime; settings: GcSettings; agents: AgentSnapshot; log?: GcLog },
): Promise<KillCandidate | null> {
  const now = wallClockSeconds();
  const fresh = await collectProcsPhase({
    runtime: { ...input.runtime, now },
    settings: input.settings,
    agents: input.agents,
    wantLedger: false,
  });
  const ctx: DecisionContext = {
    identity: fresh.ident,
    killMb: input.settings.memKillMb,
    killComms: input.settings.killComms,
    warnMb: input.settings.memWarnMb,
    famPids: fresh.table.famPids,
    invoker: input.runtime.invoker,
  };
  const row = fresh.table.procs.find((entry) => entry.pid === candidate.pid);
  if (row !== undefined) {
    return {
      pid: row.pid,
      class: String(row.class),
      stale: staleDecision(row, ctx),
      overmem: overmemDecision(row, ctx),
      footprint_mb: row.footprint_mb,
      protected: row.protected,
      lstart: row.lstart,
      ppid: row.ppid,
      comm: row.exe,
      exePath: exeOf(input.runtime.exec, row.pid),
      owner: row.owner,
    };
  }
  const orphan = fresh.orphans.find((entry) => entry.entry.pid === candidate.pid);
  if (orphan === undefined) return null;
  return {
    pid: orphan.entry.pid,
    class: "orphan",
    stale: orphan.stale,
    overmem: orphan.overmem,
    footprint_mb: orphan.entry.footprint_mb,
    protected: orphan.entry.protected,
    lstart: orphan.entry.lstart,
    ppid: orphan.entry.ppid,
    comm: orphan.entry.comm,
    exePath: orphan.entry.exePath,
    owner: orphan.entry.owner,
    proof: orphan.entry.proof,
  };
}

// ---------------------------------------------------------------------------
// Settings: the document over the imported baseline
// ---------------------------------------------------------------------------

/**
 * The reference's conf path (`read_config`, slp-gc.bash:1243):
 * `$SLP_GC_CONFIG` or `~/.config/slp-room/slp-gc.conf`.
 */
export function resolveGcConfPath(env: Record<string, string | undefined>, home: string): string {
  const configured = env.SLP_GC_CONFIG?.trim();
  return configured !== undefined && configured !== ""
    ? configured
    : join(home, ".config/slp-room/slp-gc.conf");
}

/**
 * Merge the plugin's settings document over the conf-imported baseline.
 *
 * Only the keys the document *carries* override the baseline — a key it does not
 * carry keeps the imported value, which is what makes the document a set of
 * overrides rather than a second set of defaults. Two clamps are applied here
 * because they are cross-field and a schema cannot express them without turning
 * one bad pair into a rejected document:
 *
 * - `memKillMb` is never below `memWarnMb` (shared/gc.ts's own note: "applied by
 *   whoever merges plugin settings over this baseline");
 * - the kill-comm list is copied, so the caller cannot mutate a shared default.
 */
export function mergeGcSettings(
  baseline: GcSettings,
  document: unknown,
): GcSettings {
  const parsed = gcSettingsDocumentSchema.safeParse(document);
  if (!parsed.success) return { ...baseline, killComms: [...baseline.killComms] };

  const merged: GcSettings = { ...baseline, killComms: [...baseline.killComms] };
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] =
      key === "killComms" ? [...(value as string[])] : value;
  }
  merged.memKillMb = Math.max(merged.memKillMb, merged.memWarnMb);
  return merged;
}

// ---------------------------------------------------------------------------
// The screen's read model
// ---------------------------------------------------------------------------

/**
 * The status a screen sees before the first tick has finished.
 *
 * Every field the tick would fill is the honest empty value: no pid, no uptime, no
 * ledger rows, an index that is *not* ok (with the reason being that nothing has
 * run), no report and no alerts. The design's screen has to distinguish "a fresh
 * install" from "a tick that saw nothing", and "not ok because no tick has run" is
 * that distinction — a zero or an `ok: true` here would be a fabricated reading.
 */
export function emptyStatus(settings: GcSettings): GcStatus {
  return {
    ident: { ok: false, why: "no tick has run yet" },
    lastTickAt: null,
    nextReportAt: null,
    daemonPid: null,
    uptimeS: null,
    treeWarnMb: settings.treeWarnMb,
    // No footprint has been measured, and no tree threshold resolved against RAM:
    // `null` is "no tick has read the tree", never a zero-byte tree.
    tree: null,
    // Nothing has been written yet, which is a readable, empty ledger — not an
    // unreadable one.
    ledger: { note: null, rows: 0, readable: true },
    index: { ok: false, why: ["no tick has run yet"] },
    lastReportAt: null,
    alerts: [],
    alertsReadable: true,
    settings: {
      apply: settings.apply,
      killStale: settings.killStale,
      killMemory: settings.killMemory,
      memWarnMb: settings.memWarnMb,
      memKillMb: settings.memKillMb,
    },
    procs: [],
    candidates: [],
  };
}

/**
 * The last tick's result as the screen's one read model.
 *
 * The process rows are the report's own (already decisions-attached, `cmd`
 * stripped); the candidates are the *unfiltered* list, so a refused row arrives
 * with its rule key and the screen can say why nothing happened to it.
 *
 * The daemon identity, the tree, the ledger and the index are read off that same
 * captured result — `ident.daemonPid`, the `daemon` row's `etime_s`, the report's
 * `tree` (its resolved `warnMb` and its own `over` verdict), `ledgerNext` /
 * `ledgerNote`, and the tick's one `index` verdict. Nothing here re-judges: the
 * ledger row count is the ledger the tick wrote back, `ledger.readable` /
 * `alertsReadable` distinguish "unreadable" from "empty", and `index` is the
 * scans' own answer, not a conclusion drawn from refusal strings.
 */
export function buildStatus(result: TickResult): GcStatus {
  const ident = result.report.procs.ident;
  const daemonRow =
    ident.daemonPid === null
      ? undefined
      : result.report.procs.procs.find((row) => row.pid === ident.daemonPid);
  const ledgerNext: unknown = result.report.procs.ledgerNext;
  const ledgerNote = result.report.procs.ledgerNote;
  const tree = result.report.procs.tree;

  return {
    ident: { ok: result.report.procs.ident.ok, why: result.report.procs.ident.why },
    lastTickAt: result.at,
    nextReportAt: result.nextReportAt,
    daemonPid: ident.daemonPid,
    // `etime_s` is `-1` for a field `ps` did not give: unknown, not zero.
    uptimeS: daemonRow === undefined || daemonRow.etime_s < 0 ? null : daemonRow.etime_s,
    treeWarnMb: result.settings.treeWarnMb,
    // The report's own tree: `warnMb` is already resolved against RAM there
    // (`buildTree`), and `over` is the tick's verdict — neither is recomputed.
    tree: {
      totalMb: tree.totalMb,
      appMb: tree.appMb,
      orphanMb: tree.orphanMb,
      warnMb: tree.warnMb,
      over: tree.over,
    },
    ledger: {
      note: ledgerNote === "" ? null : ledgerNote,
      // The tick always asks for the next ledger (`wantLedger: true`); `null` here
      // means the process phase failed, and a failed phase recorded no rows.
      rows: Array.isArray(ledgerNext) ? ledgerNext.length : 0,
      // A ledger that was never read (failed process phase) or that the reader
      // refused (a note) is not an empty ledger, and must not read as one.
      readable: Array.isArray(ledgerNext) && ledgerNote === "",
    },
    index: { ok: result.report.index.ok, why: [...result.report.index.why] },
    lastReportAt: result.lastReportAt,
    alerts: result.alerts.map((alert) => ({ at: alert.at, text: alert.text })),
    alertsReadable: result.alertsReadable,
    settings: {
      apply: result.settings.apply,
      killStale: result.settings.killStale,
      killMemory: result.settings.killMemory,
      memWarnMb: result.settings.memWarnMb,
      memKillMb: result.settings.memKillMb,
    },
    procs: result.report.procs.procs.map((row) => ({
      pid: row.pid,
      class: typeof row.class === "string" ? row.class : null,
      owner: row.owner ?? null,
      footprintMb: row.footprint_mb,
      warn: row.warn,
    })),
    candidates: result.candidates.map((candidate) => ({
      kind: candidate.kind,
      id: candidate.id,
      rule: candidate.rule ?? null,
      refusedBy: candidate.refusedBy,
    })),
  };
}

// Identification: which Supervisor, daemon and app main this tick is allowed to
// believe in — the `$idt` block of the reference tool
// (`agent-room/docs/gc-port/slp-gc.bash`):
//
//   pid file type test        slp-gc.bash:323  (`$pidfile | if type == "object" and (.pid | type) == "number"`)
//   supervisor                slp-gc.bash:324  (`class == "supervisor"` and its pid is the pid file's)
//   app mains                 slp-gc.bash:325  (`$apps`, the pids the supervisor must be a child of)
//   daemon                    slp-gc.bash:326  (a `class == "daemon"` child of that supervisor)
//   flags                     slp-gc.bash:327-332 (`pidFile`/`supervisor`/`daemon`/`listener`/pids/supHome/listen)
//   home binding              slp-gc.bash:333  (`match`, or `none` for the default home)
//   ok + why                  slp-gc.bash:334-341 (dupes first, then each flag in order)
//
// Every decision in this module is a pure function of the classified process
// table plus the facts the caller read once: this module never shells out, never
// reads `/proc`, never calls `ps`/`top` and never consults the daemon. Task 12
// owns the invocation and hands the results in.
//
// Two properties matter more than tidiness:
//
// 1. **Refusal order is the contract.** The `why` strings below reach the user's
//    report, and fail-closed behaviour depends on which check fires first: an
//    unreadable home must be reported as an unproven home, not as a missing
//    supervisor. The order is the reference's, exactly.
// 2. **Nothing here throws.** A caller hands in whatever it read (a pid file it
//    could not parse, an empty table, a listener list from a failed `lsof`) and
//    gets `ok: false` with a reason. A tick that cannot identify itself must
//    signal nothing, and it never gets an exception instead of an answer.
//
// The listener is an input rather than a lookup: the reference collects it from
// `lsof` on the pid file's port (`collect_listen`, slp-gc.bash:615-619) and this
// port takes the pids (`listen`) so the answer stays pure. `homeDefault` is the
// reference's `$HOME_IS_DEFAULT` (slp-gc.bash:784) — whether the GC's own home is
// the default one, which is the only case where an empty `PASEO_HOME` proves the
// binding.

import type { ProcClass } from "./procs";

/** One process's view of the `PASEO_HOME` in its environment (`env_one`, slp-gc.bash:573-590). */
export type HomeState =
  /** `PASEO_HOME` equals this GC's home (`bound()`), slp-gc.bash:585. */
  | "match"
  /** Readable, but every `PASEO_HOME` it carries names another home. */
  | "other"
  /** Readable, and no `PASEO_HOME` at all — only the default home is proven by that. */
  | "none"
  /** The environment could not be read at all (slp-gc.bash:313: `if $e.read then $e.home else "unreadable"`). */
  | "unreadable";

/**
 * The class vocabulary the table uses: the reference's `classify` answers
 * (slp-gc.bash:262-276) plus `agent-descendant`, which classification never
 * produces — the table builder assigns it to a row with no class of its own but
 * an agent-class ancestor (slp-gc.bash:303-307).
 */
export type ProcClassValue = ProcClass | "agent-descendant";

/** One classified process, as much as identification reads (the reference's `$procs` rows). */
export interface IdentityProc {
  pid: number;
  ppid: number;
  class: ProcClassValue | null;
  /** The `PASEO_HOME` verdict for this pid, from its own environment. */
  home: HomeState;
}

/**
 * What the rest of the GC actually branches on.
 *
 * Deliberately narrower than `Identity`: the decision rules only ever read these
 * five fields (`slp-gc.bash:334`, `:367-370`), so a caller or a test can supply
 * exactly them and nothing else.
 */
export interface IdentityFacts {
  /** `$idt.ok` — every flag below held and the pid rows were unique. */
  ok: boolean;
  /** `$idt.why` — `"ok"`, or the first refusal in the reference's order. */
  why: string;
  /** `$sup.pid` when the pid file named a live Supervisor, else null. */
  supervisorPid: number | null;
  /** The single `Paseo Daemon` child of that Supervisor, else null. */
  daemonPid: number | null;
  /** The Supervisor's parent (the app main), else null. */
  appPid: number | null;
}

/** Everything `$idt` carries into the report (slp-gc.bash:327-333). */
export interface Identity extends IdentityFacts {
  /** `$pf != null`: the pid file parsed as an object with a numeric pid. */
  pidFile: boolean;
  /** `$sup != null and $apps | index($sup.ppid)`: the pid is a Supervisor under an app main. */
  supervisor: boolean;
  /** Exactly one daemon child of the Supervisor (more than one is refused, not resolved). */
  daemon: boolean;
  /** That single daemon is the pid the listener belongs to. */
  listener: boolean;
  /** The Supervisor's home is this home (`match`), or unset while this is the default home (`none`). */
  homeBound: boolean;
  /** `$sup.home // "unreadable"` — reported verbatim in the refusal, as the reference does. */
  supHome: HomeState;
  /** `$pf.listen` verbatim: the `host:port` the pid file advertises, when it carries one. */
  listen: string | null;
}

export interface IdentityInput {
  /** The classified table (`buildProcTable().procs`). */
  procs: readonly IdentityProc[];
  /**
   * `<paseoHome>/paseo.pid`, parsed. Typed `unknown` on purpose: the type test
   * (an object with a numeric `pid`) is part of identification, so an
   * unparseable file is an input, not a caller error.
   */
  pidFile: unknown;
  /** Pids listening on the pid file's port — the reference's `listen.json` (slp-gc.bash:615-619). */
  listen: readonly number[];
  /** Pid rows that appeared more than once in the `ps` output (`ParsedPs.dupes`, slp-gc.bash:286). */
  dupes: number;
  /** `$HOME_IS_DEFAULT`: the GC's own `PASEO_HOME` is the default one (slp-gc.bash:784). */
  homeDefault: boolean;
}

/** The pid file, reduced the way the reference reduces it (`$pf`, slp-gc.bash:323). */
interface PidFile {
  pid: number;
  /** `$pf.listen? // null` (slp-gc.bash:332). */
  listen: string | null;
}

/**
 * `($pidfile | if type == "object" and (.pid | type) == "number" then . else null end)`
 * (slp-gc.bash:323). jq's `type == "object"` is false for an array and for
 * null, and `(.pid | type) == "number"` is false for a numeric string — the
 * pid file the daemon writes carries a JSON number, so a string there means the
 * file is not the file this GC was told to trust.
 */
function readPidFile(raw: unknown): PidFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const pid = (raw as Record<string, unknown>).pid;
  if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
  const listen = (raw as Record<string, unknown>).listen;
  return { pid, listen: typeof listen === "string" ? listen : null };
}

/**
 * Resolve the identity (slp-gc.bash:323-341).
 *
 * The reference's order, and the reason each check is where it is:
 *
 * 1. **duplicates** — two rows for one pid mean the `ps` sample is not a
 *    process table, so every pid-keyed lookup below is unreliable; nothing else
 *    can be trusted first (`:334-335`).
 * 2. **pid file** — without it there is no claim to check (`:336`).
 * 3. **supervisor** — the pid the file names must be a live Supervisor *and* a
 *    child of an app main, which is what makes it the GUI's Supervisor rather
 *    than any other `Paseo Supervisor` (`:337`).
 * 4. **daemon** — exactly one `Paseo Daemon` child of that supervisor; zero or
 *    two is refused rather than guessed (`:338`).
 * 5. **listener** — the daemon must own the advertised listener, or the pid
 *    file describes a different daemon than the one running (`:339`).
 * 6. **home binding** — the Supervisor's `PASEO_HOME` must be this home, or
 *    absent while this is the default home; an unreadable env always refuses
 *    (`:333`, `:340`).
 */
export function resolveIdentity(input: IdentityInput): Identity {
  const pf = readPidFile(input.pidFile);
  // A caller that could not collect a table hands in nothing; an absent table is
  // an empty one, so every flag below is false and the refusal is total.
  const procs = Array.isArray(input.procs) ? input.procs : [];
  const listeners = Array.isArray(input.listen) ? input.listen : [];

  const sup = procs.find((proc) => proc.class === "supervisor" && pf !== null && proc.pid === pf.pid);
  const apps = procs.filter((proc) => proc.class === "app-main").map((proc) => proc.pid);
  const daemons =
    sup === undefined
      ? []
      : procs.filter((proc) => proc.class === "daemon" && proc.ppid === sup.pid);

  const pidFile = pf !== null;
  const supervisor = sup !== undefined && apps.includes(sup.ppid);
  const daemon = daemons.length === 1;
  const single = daemons.length === 1 ? daemons[0] : undefined;
  const listener = single !== undefined && listeners.includes(single.pid);
  const supHome: HomeState = sup === undefined ? "unreadable" : (sup.home ?? "unreadable");
  const homeBound = supHome === "match" || (supHome === "none" && input.homeDefault);

  const ok =
    input.dupes === 0 && pidFile && supervisor && daemon && listener && homeBound;

  const why = ((): string => {
    if (input.dupes > 0) return "duplicate pid rows in the ps output";
    if (!pidFile) return "paseo.pid missing/unparseable";
    if (!supervisor) return 'pid in paseo.pid is not a live "Paseo Supervisor" child of an app main';
    if (!daemon) return 'no single "Paseo Daemon" child of the Supervisor';
    if (!listener) return "the daemon does not own the listener from paseo.pid";
    if (!homeBound) {
      return `the Supervisor's PASEO_HOME is "${supHome}": not proven to serve this home (an unreadable env always refuses; a readable env without PASEO_HOME is accepted only for the default home)`;
    }
    return "ok";
  })();

  return {
    ok,
    why,
    pidFile,
    supervisor,
    daemon,
    listener,
    homeBound,
    supHome,
    listen: pf?.listen ?? null,
    supervisorPid: sup?.pid ?? null,
    daemonPid: single?.pid ?? null,
    appPid: sup?.ppid ?? null,
  };
}

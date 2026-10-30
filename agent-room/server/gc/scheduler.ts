// The in-process ticker: one interval, a mutex, and a cleanup that leaves no
// timer behind.
//
// Reference: `slp-gc.bash`'s launchd plist runs `slp-gc tick` every 60 s and the
// script serialises itself with `take_lock` (slp-gc.bash:1283-1303): a second
// tick that finds the lock held prints "another tick is running; skipped" and
// returns 0. A long-lived plugin needs the same two properties without a lock
// directory: an interval (the plist's `StartInterval`) and a conservative
// "already running" answer (the mkdir lock's), because two concurrent ticks would
// double-signal and double-delete.
//
// Four properties matter more than tidiness:
//
// 1. **A tick never throws into the interval.** `setInterval` has nowhere to put
//    a rejection, and an unhandled one would reach the daemon's process. The
//    runner's promise is caught and dropped; whatever the tick wants to report it
//    reports through its own log.
// 2. **Overlapping ticks are dropped, not queued.** The reference's lock answer is
//    "skip this one", not "run it later": a tick that started while another was
//    still sampling would judge a stale process table. Dropping is the safe
//    direction and it is what the brief's test pins.
// 3. **Cleanup is total.** The returned function clears the interval, marks the
//    scheduler stopped (so a tick that was already in flight cannot re-arm
//    anything) and is idempotent: a plugin reload that calls it twice leaves one
//    timer less than it found, never a second live interval.
// 4. **One exclusion primitive, two callers.** The reference has a single tick
//    path (`slp-gc tick`), so its `take_lock` covers everything. The port has
//    two — the interval below and the `gc.run` RPC — and a mutex captured inside
//    the interval's closure would leave the RPC free to overlap a scheduled tick
//    (double samples, double ledger writes, and with `apply` on two concurrent
//    acting phases on the same records). So the mutex is its own object
//    (`createTickGate`) that the scheduler takes as an input and the RPC calls
//    through; a second caller is answered "not now", never queued.

/** The reference's `StartInterval` in the launchd plist: one tick a minute. */
export const GC_INTERVAL_MS = 60_000;

/** The answer to `runExclusive`: whether this caller got to run, and what it returned. */
export type ExclusiveRun<T> = { ran: true; value: T } | { ran: false };

/**
 * The one mutual exclusion between ticks, whoever starts them.
 *
 * `runExclusive` sets its flag **before its first await**, so two callers in the
 * same task queue cannot both enter: JavaScript cannot interleave the synchronous
 * prefix of an `async` function. A caller that arrives while another is running
 * is answered `{ ran: false }` — refused, not queued, because a tick that waited
 * for the previous one would sample a process table it already judged stale (the
 * reference's `take_lock` says "another tick is running; skipped" for the same
 * reason).
 *
 * The flag is cleared in `finally`, so a task that rejects still releases the
 * gate: a failed tick may not block every later one.
 */
export interface TickGate {
  /** Whether a tick is running right now (a diagnostic; not a lock test). */
  readonly running: boolean;
  /** Run `task` if no tick is running; otherwise answer `{ ran: false }`. */
  runExclusive<T>(task: () => Promise<T>): Promise<ExclusiveRun<T>>;
}

/** The shared gate's constructor. One per plugin load, handed to every tick path. */
export function createTickGate(): TickGate {
  let running = false;
  return {
    get running(): boolean {
      return running;
    },
    async runExclusive<T>(task: () => Promise<T>): Promise<ExclusiveRun<T>> {
      if (running) return { ran: false };
      // Set before any await: the synchronous prefix of this function is the
      // whole critical section's entry, and nothing can interleave with it.
      running = true;
      try {
        return { ran: true, value: await task() };
      } finally {
        running = false;
      }
    },
  };
}

export interface SchedulerInput {
  /** How often a tick is attempted, in milliseconds. `GC_INTERVAL_MS` in production. */
  intervalMs: number;
  /** One tick. Its answer is ignored; a rejection is swallowed (property 1). */
  runTick: () => Promise<unknown>;
  /** Optional sink for a dropped overlap, so an operator can see the tick was skipped. */
  onSkip?: () => void;
  /**
   * The gate this scheduler shares with every other tick path (property 4). The
   * plugin passes the same object to the `gc.run` RPC. Omitted, the scheduler
   * creates a private one — a scheduler with no other caller needs no more.
   */
  gate?: TickGate;
}

/**
 * Start the ticker and answer a cleanup. The first tick fires one interval after
 * `start`, exactly like the plist (the plugin's own load is not a tick).
 *
 * The mutex is `input.gate` (property 4): the same object the RPC runs through,
 * so a scheduled tick and an RPC run can never overlap.
 */
export function startScheduler(input: SchedulerInput): () => void {
  const gate = input.gate ?? createTickGate();
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    void (async () => {
      try {
        const outcome = await gate.runExclusive(input.runTick);
        if (outcome.ran) return;
        // Another tick is still sampling: the reference's "another tick is
        // running; skipped". This one is dropped rather than queued.
        try {
          input.onSkip?.();
        } catch {
          // A skip reporter must never break the interval.
        }
      } catch {
        // A tick never throws into the interval (property 1). The tick itself logs.
      }
    })();
  };

  const timer = setInterval(tick, input.intervalMs);
  // A plugin's timer must not be the reason the host process stays alive.
  try {
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    // A non-Node timer (a test double) has no `unref`; the cleanup still clears it.
  }

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

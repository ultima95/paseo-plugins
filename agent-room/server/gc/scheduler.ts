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
// Three properties matter more than tidiness:
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

/** The reference's `StartInterval` in the launchd plist: one tick a minute. */
export const GC_INTERVAL_MS = 60_000;

export interface SchedulerInput {
  /** How often a tick is attempted, in milliseconds. `GC_INTERVAL_MS` in production. */
  intervalMs: number;
  /** One tick. Its answer is ignored; a rejection is swallowed (property 1). */
  runTick: () => Promise<unknown>;
  /** Optional sink for a dropped overlap, so an operator can see the tick was skipped. */
  onSkip?: () => void;
}

/**
 * Start the ticker and answer a cleanup. The first tick fires one interval after
 * `start`, exactly like the plist (the plugin's own load is not a tick).
 *
 * The mutex is a plain boolean: JavaScript cannot interleave two runs of the
 * callback, so "set before the first await, cleared in `finally`" is all the
 * exclusion there is to build.
 */
export function startScheduler(input: SchedulerInput): () => void {
  let running = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    if (running) {
      // Another tick is still sampling: the reference's "another tick is running;
      // skipped". This one is dropped rather than queued.
      try {
        input.onSkip?.();
      } catch {
        // A skip reporter must never break the interval.
      }
      return;
    }
    running = true;
    void (async () => {
      try {
        await input.runTick();
      } catch {
        // A tick never throws into the interval (property 1). The tick itself logs.
      } finally {
        running = false;
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

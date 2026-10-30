import { randomUUID } from "node:crypto";
import os from "node:os";
import { join } from "node:path";

import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";

import { gcSettingsDefinition, type GcSettings } from "./shared/gc";
import { adoptRoomRpc, gcRunRpc, gcStatusRpc, getRoomRpc, launchRoomRpc, listRoomsRpc } from "./shared/rpc";
import { parseSeatMarker, roomSettings } from "./shared/seats";
import { createRoomEvents, lookupTitle } from "./server/events";
import type { ActionResult } from "./server/gc/apply";
import { createGcSettingsReader } from "./server/gc/settings";
import { createTickGate, startScheduler, GC_INTERVAL_MS } from "./server/gc/scheduler";
import {
  buildStatus,
  emptyStatus,
  mergeGcSettings,
  resolveGcConfPath,
  runTick,
  type TickDeps,
  type TickResult,
} from "./server/gc/tick";
import { createHandlers } from "./server/handlers";
import { applySeat } from "./server/inject";
import { consoleLogger } from "./server/logger";
import { createSettingsReader } from "./server/settings";
import { createRoomStore, resolveDataDir } from "./server/store";

/** The plugin's single store file, inside `resolveDataDir(...)`. */
const ROOMS_FILE = "rooms.json";

/** The GC's own state dir, a sibling of `rooms.json` inside the plugin's data dir. */
const GC_DIR = "gc";

/**
 * How long one GC settings read may take before the tick uses the imported
 * baseline. A stalled settings read must not hold the scheduler's mutex — the
 * next tick would be dropped while this one waits forever.
 */
const GC_SETTINGS_TIMEOUT_MS = 2_000;

const log = consoleLogger;

/**
 * Whether the one-time state migration has run in this process. Module-level on
 * purpose: the plugin loads once per daemon, and a reload creates a new module
 * instance, which is exactly when the copy should be re-attempted (it is
 * idempotent — an existing destination is skipped).
 */
let gcMigrated = false;

/** Exposed for tests: the migrated flag is process state, and a test must reset it. */
export function __resetGcMigrated(): void {
  gcMigrated = false;
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Resolve with `promise`, or with `fallback` after `timeoutMs`. Never rejects. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * The GC seams a test may replace: everything a tick would otherwise read from
 * the machine. Production passes nothing and gets the real `spawnSync` exec, the
 * real clock and `process.kill`.
 */
export interface GcOverrides {
  exec?: TickDeps["exec"];
  legacyStateDir?: TickDeps["legacyStateDir"];
  now?: TickDeps["now"];
  signal?: TickDeps["signal"];
  deleteAgent?: TickDeps["deleteAgent"];
  deleteSchedule?: TickDeps["deleteSchedule"];
  notify?: TickDeps["notify"];
  log?: TickDeps["log"];
  /** Replace one tick phase (`TickDeps["seams"]`); a test holds a tick open with it. */
  seams?: TickDeps["seams"];
  /** The scheduler's interval. `GC_INTERVAL_MS` in production; short in a test. */
  intervalMs?: number;
}

/**
 * The answer `gc.run` gives when the scheduler's tick is still running: a
 * refusal row, not an error and not a queue.
 *
 * The RPC's output is `ActionResult[]`, so a refusal fits the contract and the
 * screen shows it the way it shows any other refusal. Queuing was the
 * alternative and it is worse: the caller would wait for a tick it cannot see,
 * and a second acting phase would start on records the running tick is already
 * judging (the reference's `take_lock` answers "another tick is running;
 * skipped" for the same reason).
 */
function tickBusyRefusal(): ActionResult[] {
  return [
    {
      kind: "refuse",
      id: "-",
      acted: false,
      reason: "refused: another gc tick is still running (this run was not queued)",
      refusedBy: "tick-in-progress: the scheduled tick is still sampling",
    },
  ];
}

/**
 * Seat injection and room lifecycle, plus the GC.
 *
 * Every agent creation passes through `applySeat`, which only touches agents
 * whose title carries a `[room:…]` marker; everything else is returned unchanged
 * by returning `undefined`. The lifecycle hooks record room membership, enforce
 * the guard and keep the feed, and every one of them swallows its own errors:
 * a broken room must never break an agent.
 *
 * The GC is a second, independent contribution to the same plugin: a 60 s
 * scheduler, two RPCs and its own settings document. Nothing about it may block
 * the room: its first tick is an interval away, its settings read is lazy and
 * time-boxed, and an unreadable conf or an invalid settings document falls back
 * to the reference's defaults instead of failing the load.
 */
export default function contribute(
  server: PluginServerContext,
  gcOverrides: GcOverrides = {},
): () => Promise<void> {
  const settings = server.registerSettings(roomSettings);
  const readSettings = createSettingsReader(settings, log);

  const dataDir = resolveDataDir(process.env, os.homedir());
  const store = createRoomStore({
    file: join(dataDir, ROOMS_FILE),
    now: () => Date.now(),
    newId: () => randomUUID(),
    log,
  });

  // ── GC wiring ───────────────────────────────────────────────────────────────
  //
  // Settings precedence, in this direction and no other: the reference's
  // `slp-gc.conf` is imported **once** per process (a memoised read that never
  // rejects, `server/gc/settings.ts`) and is the baseline; the plugin's `gc`
  // settings document is layered *over* it. Registration is synchronous and the
  // read is lazy, so neither can delay a room hook.
  const gcDoc = server.registerSettings(gcSettingsDefinition);
  const confPath = resolveGcConfPath(process.env, os.homedir());
  const gcBaseline = createGcSettingsReader({ confPath, log });
  let gcFallbackLogged = false;

  /**
   * The settings a tick acts on: the imported baseline with the plugin document
   * merged over it. A document that will not parse, or a read that stalls or
   * throws, yields the baseline — logged once per plugin load, never thrown.
   */
  const readGcSettings = async (): Promise<GcSettings> => {
    const baseline = await gcBaseline;
    let document: unknown;
    try {
      const state = await withTimeout(
        gcDoc.read(),
        GC_SETTINGS_TIMEOUT_MS,
        { status: "invalid" as const, revision: "0", error: "settings read timed out" },
      );
      if (state.status !== "ready") {
        if (!gcFallbackLogged) {
          gcFallbackLogged = true;
          log.warn("gc settings invalid; using the imported baseline", { error: state.error });
        }
        return { ...baseline, killComms: [...baseline.killComms] };
      }
      document = state.values;
    } catch (error) {
      if (!gcFallbackLogged) {
        gcFallbackLogged = true;
        log.warn("gc settings unreadable; using the imported baseline", { error: reason(error) });
      }
      return { ...baseline, killComms: [...baseline.killComms] };
    }
    return mergeGcSettings(baseline, document);
  };

  /** One tick, with the last result kept for `gc.status`. Never throws. */
  let lastTick: TickResult | null = null;
  const runGc = async (options: { reportOnly?: boolean } = {}): Promise<TickResult> => {
    try {
      const result = await runTick(
        {
          stateDir: join(dataDir, GC_DIR),
          readSettings: readGcSettings,
          home: os.homedir(),
          env: process.env,
          log,
          // `migrated` flips inside `runTick`, so the copy happens once per
          // process: the first tick, whatever started it.
          migrated: gcMigrated,
          ...gcOverrides,
        },
        options,
      );
      gcMigrated = true;
      lastTick = result;
      return result;
    } catch (error) {
      // `runTick` is written not to throw; this is the belt for a bug in it.
      log.error("gc tick failed", { error: reason(error) });
      throw error;
    }
  };

  // ── room wiring ─────────────────────────────────────────────────────────────

  // Lifecycle hooks fire as soon as the plugin loads, so no handler may touch the
  // store before the file is in memory. A failed load is logged and still lets
  // hooks run against an empty store.
  const loaded = store.load().catch((error: unknown) => {
    log.error("room store load failed", { error: reason(error) });
  });

  const events = createRoomEvents({ store, readSettings, lookupTitle, log });

  // Two readers over the same settings, deliberately: `agent.create` must never
  // break, so it keeps the lenient one (a stalled read becomes default seats),
  // while `room.launch` has a waiting user and must say so instead of launching
  // a default `bypassPermissions` Supervisor. A settings state that is `invalid`
  // still seeds `DEFAULT_SETTINGS` for both — that is the designed fallback.
  const launchSettings = createSettingsReader(settings, log, { strict: true });

  // The screen's RPCs read the same store the hooks write, so each one waits for
  // the load first.
  const handlers = createHandlers({ store, readSettings: launchSettings });

  /** Wait for the load, then run the handler; a handler failure is logged, not thrown. */
  const afterLoad = <Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (event: PluginLifecycleEvents[Name], ctx: PluginHookContext) => Promise<void>,
  ) => {
    return async (event: PluginLifecycleEvents[Name], context: PluginHookContext): Promise<void> => {
      try {
        await loaded;
        await handler(event, context);
      } catch (error) {
        log.error(`${name} hook failed`, { error: reason(error) });
      }
    };
  };

  server.on("agent.created", afterLoad("agent.created", events.onCreated));
  server.on("agent.turn_ended", afterLoad("agent.turn_ended", events.onTurnEnded));
  server.on("agent.archived", afterLoad("agent.archived", events.onArchived));

  server.before("agent.create", async ({ request }) => {
    // Parse the seat off the title before anything awaits: an unmarked agent —
    // which is most agents on the daemon — must not pay a settings round-trip
    // that can stall for up to 2 s.
    if (!parseSeatMarker(request.config.title)) return;
    try {
      const applied = applySeat(request, await readSettings());
      if (!applied) return;
      if (applied.fallbackFrom !== undefined) {
        log.warn("unknown peer tier", { tier: applied.fallbackFrom });
      }
      return applied.request;
    } catch (error) {
      // Never fail or hang agent creation: an unreadable request passes through.
      log.error("agent.create hook failed; request passed through", { error });
      return;
    }
  });

  // RPC failures are the caller's to see (the launch form shows them), so these
  // propagate instead of being swallowed the way the lifecycle hooks are.
  server.handle(launchRoomRpc, async (input, { paseo }) => {
    await loaded;
    return handlers.launch(input, paseo);
  });

  server.handle(adoptRoomRpc, async (input, { paseo }) => {
    await loaded;
    return handlers.adopt(input, paseo);
  });

  server.handle(listRoomsRpc, async () => {
    await loaded;
    return handlers.list();
  });

  server.handle(getRoomRpc, async (input) => {
    await loaded;
    return handlers.get(input);
  });

  // The GC screen's two contracts. `gc.status` answers the last tick's captured
  // result (or an empty status carrying the settings the next tick would use), and
  // `gc.run` runs exactly one tick: `report` with the acting toggles forced off,
  // `act` with whatever the settings enable.
  server.handle(gcStatusRpc, async () => {
    if (lastTick !== null) return buildStatus(lastTick);
    const settingsNow = await readGcSettings();
    return emptyStatus(settingsNow);
  });

  // The one exclusion every tick path shares. The interval and `gc.run` both go
  // through this object, so an RPC run can never overlap a scheduled tick —
  // two overlapping ticks would record two samples, write the ledger twice and,
  // with `apply` on, run two acting phases over the same records.
  const tickGate = createTickGate();

  server.handle(gcRunRpc, async (input) => {
    const outcome = await tickGate.runExclusive(() =>
      runGc({ reportOnly: input.mode === "report" }),
    );
    // Refused, not queued: the caller asked for a tick *now*, and the answer is
    // that one is already running. `lastTick` is untouched, so `gc.status` keeps
    // describing the tick that actually ran.
    if (!outcome.ran) {
      log.warn("gc run refused: a tick is still running");
      return tickBusyRefusal();
    }
    return outcome.value.acted;
  });

  // The scheduler is started last, after every handler is registered, and its
  // first tick is one interval away — a room hook that fires during the load
  // never races it.
  const stopGc = startScheduler({
    intervalMs: gcOverrides.intervalMs ?? GC_INTERVAL_MS,
    runTick: () => runGc(),
    onSkip: () => log.warn("gc tick skipped: the previous tick is still running"),
    gate: tickGate,
  });

  return async () => {
    // The scheduler goes first: a tick that fired during the cleanup would write
    // into a state dir we are about to flush past, and the room store's flush must
    // not wait on a `ps` sample.
    stopGc();
    await loaded;
    await store.flush();
  };
}


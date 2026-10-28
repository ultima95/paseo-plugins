import { randomUUID } from "node:crypto";
import os from "node:os";
import { join } from "node:path";

import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";

import { getRoomRpc, launchRoomRpc, listRoomsRpc } from "./shared/rpc";
import { DEFAULT_SETTINGS, roomSettings, type RoomSettings } from "./shared/seats";
import { createRoomEvents, lookupTitle } from "./server/events";
import { createHandlers } from "./server/handlers";
import { applySeat } from "./server/inject";
import { consoleLogger } from "./server/logger";
import { createSettingsReader, type SettingsReader } from "./server/settings";
import { createRoomStore, resolveDataDir } from "./server/store";

/** Seat settings live in the daemon, so a stuck read must not stall creation. */
const SETTINGS_TIMEOUT_MS = 2_000;

/** The plugin's single store file, inside `resolveDataDir(...)`. */
const ROOMS_FILE = "rooms.json";

const log = consoleLogger;

async function readSeats(read: SettingsReader): Promise<RoomSettings> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<RoomSettings>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(DEFAULT_SETTINGS);
    }, SETTINGS_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    const settings = await Promise.race([read(), timeout]);
    if (timedOut) {
      log.warn("seat settings read timed out; using default seats", {
        timeoutMs: SETTINGS_TIMEOUT_MS,
      });
    }
    return settings;
  } catch (error) {
    // `createSettingsReader` never rejects; this is the belt to its braces so a
    // future reader cannot fail agent creation.
    log.error("seat settings read failed; using default seats", { error });
    return DEFAULT_SETTINGS;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Seat injection and room lifecycle.
 *
 * Every agent creation passes through `applySeat`, which only touches agents
 * whose title carries a `[room:…]` marker; everything else is returned unchanged
 * by returning `undefined`. The lifecycle hooks record room membership, enforce
 * the guard and keep the feed, and every one of them swallows its own errors:
 * a broken room must never break an agent.
 */
export default function contribute(server: PluginServerContext): () => Promise<void> {
  const settings = server.registerSettings(roomSettings);
  const readSettings = createSettingsReader(settings, log);

  const store = createRoomStore({
    file: join(resolveDataDir(process.env, os.homedir()), ROOMS_FILE),
    now: () => Date.now(),
    newId: () => randomUUID(),
    log,
  });

  // Lifecycle hooks fire as soon as the plugin loads, so no handler may touch the
  // store before the file is in memory. A failed load is logged and still lets
  // hooks run against an empty store.
  const loaded = store.load().catch((error: unknown) => {
    log.error("room store load failed", { error: reason(error) });
  });

  const events = createRoomEvents({ store, readSettings, lookupTitle, log });

  // The screen's RPCs read the same store the hooks write, so each one waits for
  // the load first. `readSeats` keeps a stuck settings read from stalling launch.
  const handlers = createHandlers({ store, readSettings: () => readSeats(readSettings) });

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
    try {
      const applied = applySeat(request, await readSeats(readSettings));
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

  server.handle(listRoomsRpc, async () => {
    await loaded;
    return handlers.list();
  });

  server.handle(getRoomRpc, async (input) => {
    await loaded;
    return handlers.get(input);
  });

  return async () => {
    await loaded;
    await store.flush();
  };
}

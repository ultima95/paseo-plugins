import type { PluginServerContext } from "@getpaseo/plugin/server";

import { DEFAULT_SETTINGS, roomSettings, type RoomSettings } from "./shared/seats";
import { applySeat } from "./server/inject";
import { consoleLogger } from "./server/logger";
import { createSettingsReader, type SettingsReader } from "./server/settings";

/** Seat settings live in the daemon, so a stuck read must not stall creation. */
const SETTINGS_TIMEOUT_MS = 2_000;

const log = consoleLogger;

async function readSeats(read: SettingsReader): Promise<RoomSettings> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RoomSettings>((resolve) => {
    timer = setTimeout(() => resolve(DEFAULT_SETTINGS), SETTINGS_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    return await Promise.race([read(), timeout]);
  } catch (error) {
    // `createSettingsReader` never rejects; this is the belt to its braces so a
    // future reader cannot fail agent creation.
    log.error("seat settings read failed; using default seats", { error });
    return DEFAULT_SETTINGS;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Seat injection. Every agent creation passes through `applySeat`, which only
 * touches agents whose title carries a `[room:…]` marker; everything else is
 * returned unchanged by returning `undefined`.
 */
export default function contribute(server: PluginServerContext): () => void {
  const settings = server.registerSettings(roomSettings);
  const readSettings = createSettingsReader(settings, log);

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

  return () => undefined;
}

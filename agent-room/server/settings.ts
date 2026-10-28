import type { PluginSettings } from "@getpaseo/plugin/server";

import { DEFAULT_SETTINGS, roomSettingsSchema, type RoomSettings } from "../shared/seats";
import type { Logger } from "./logger";

/** Resolves the seat table for one `agent.create`; never throws. */
export type SettingsReader = () => Promise<RoomSettings>;

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Wrap the registered settings in a reader the create hook can call on every
 * agent creation. A missing, invalid or unreadable settings state is expected on
 * a fresh install, so it falls back to `DEFAULT_SETTINGS` and says so once per
 * distinct reason instead of failing the hook.
 */
export function createSettingsReader(
  settings: PluginSettings<typeof roomSettingsSchema>,
  log: Logger,
): SettingsReader {
  let lastLoggedReason: string | null = null;

  const warnOnce = (message: string, error: unknown): void => {
    const text = reason(error);
    if (text === lastLoggedReason) return;
    lastLoggedReason = text;
    log.warn(message, { error: text });
  };

  return async () => {
    let state;
    try {
      state = await settings.read();
    } catch (error) {
      warnOnce("settings unreadable; using default seats", error);
      return DEFAULT_SETTINGS;
    }

    if (state.status === "ready") {
      lastLoggedReason = null;
      return state.values;
    }

    warnOnce("room settings invalid; using default seats", state.error);
    return DEFAULT_SETTINGS;
  };
}

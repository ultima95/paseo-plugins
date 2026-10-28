import type { PluginSettings } from "@getpaseo/plugin/server";

import { DEFAULT_SETTINGS, roomSettingsSchema, type RoomSettings } from "../shared/seats";
import type { Logger } from "./logger";

/**
 * Resolves the seat table for one RPC or one `agent.create`. The lenient reader
 * never throws; a strict one rejects with `SEAT_SETTINGS_UNLOADED` when the
 * seats did not arrive.
 */
export type SettingsReader = () => Promise<RoomSettings>;

/** A stuck daemon settings read must not stall an agent creation. */
export const SETTINGS_TIMEOUT_MS = 2_000;

/**
 * What a strict reader rejects with when the seats never arrived. It reaches the
 * launch form, so it says what the user can do about it.
 */
export const SEAT_SETTINGS_UNLOADED = "room seat settings did not load; try again";

export interface SettingsReaderOptions {
  /** How long `settings.read()` may take; defaults to `SETTINGS_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Reject with `SEAT_SETTINGS_UNLOADED` when the settings did not arrive,
   * instead of substituting `DEFAULT_SETTINGS`. A state that is `invalid` still
   * yields `DEFAULT_SETTINGS` either way: that is the seeded-defaults design.
   *
   * Strict readers are for `room.launch`, which has a waiting user; the
   * `agent.create` hook keeps the lenient reader because agent creation must
   * never break.
   */
  strict?: boolean;
}

/** The race's timeout arm; distinct from any error the reader itself can throw. */
const STALLED = Symbol("settings-read-timed-out");

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Resolve with `promise`, or reject with `STALLED` after `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(STALLED), timeoutMs);
    timer.unref?.();
  });

  return Promise.race([promise, stalled]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Wrap the registered settings in a reader the hooks and handlers can call. A
 * missing, invalid or unreadable settings state is expected on a fresh install,
 * so the lenient reader falls back to `DEFAULT_SETTINGS` and says so once per
 * distinct reason instead of failing. The strict reader (see
 * `SettingsReaderOptions.strict`) still falls back for `invalid`, but makes a
 * read that never arrives a visible failure rather than a silent default.
 */
export function createSettingsReader(
  settings: PluginSettings<typeof roomSettingsSchema>,
  log: Logger,
  options: SettingsReaderOptions = {},
): SettingsReader {
  const timeoutMs = options.timeoutMs ?? SETTINGS_TIMEOUT_MS;
  const strict = options.strict === true;
  let lastLoggedReason: string | null = null;

  const warnOnce = (message: string, error: unknown): void => {
    const text = reason(error);
    if (text === lastLoggedReason) return;
    lastLoggedReason = text;
    log.warn(message, { error: text });
  };

  /** Only reachable from a strict reader: the seats did not load. */
  const unloaded = (): never => {
    throw new Error(SEAT_SETTINGS_UNLOADED);
  };

  return async () => {
    let state;
    try {
      state = await withTimeout(settings.read(), timeoutMs);
    } catch (error) {
      if (error === STALLED) {
        warnOnce("seat settings read timed out", `timed out after ${timeoutMs}ms`);
        if (strict) unloaded();
        return DEFAULT_SETTINGS;
      }
      warnOnce("settings unreadable; using default seats", error);
      if (strict) unloaded();
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

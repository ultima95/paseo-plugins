import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, roomSettingsSchema, type RoomSettings } from "../shared/seats";
import type { Logger } from "./logger";
import { SEAT_SETTINGS_UNLOADED, SETTINGS_TIMEOUT_MS, createSettingsReader } from "./settings";

type SeatsSettings = PluginSettings<typeof roomSettingsSchema>;
type SeatsState = PluginSettingsState<typeof roomSettingsSchema>;

function fakeSettings(...states: Array<SeatsState | Error>): SeatsSettings {
  let call = 0;
  return {
    read: () => {
      const state = states[Math.min(call, states.length - 1)];
      call += 1;
      return state instanceof Error ? Promise.reject(state) : Promise.resolve(state);
    },
    subscribe: () => () => undefined,
  };
}

/** A daemon that never answers, the way a stuck settings read looks. */
function stallingSettings(): SeatsSettings {
  return {
    read: () => new Promise<SeatsState>(() => undefined),
    subscribe: () => () => undefined,
  };
}

function fakeLogger() {
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return log;
}

const custom: RoomSettings = {
  ...DEFAULT_SETTINGS,
  lead: { provider: "codex", model: "gpt-5.6-sol" },
};

describe("createSettingsReader", () => {
  it("returns the stored values when the settings are ready", async () => {
    const log = fakeLogger();
    const read = createSettingsReader(
      fakeSettings({ status: "ready", revision: "1", values: custom }),
      log,
    );
    await expect(read()).resolves.toEqual(custom);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to DEFAULT_SETTINGS and logs once when the settings are invalid", async () => {
    const log = fakeLogger();
    const read = createSettingsReader(
      fakeSettings({ status: "invalid", revision: "2", error: "bad seats" }),
      log,
    );
    await expect(read()).resolves.toBe(DEFAULT_SETTINGS);
    await expect(read()).resolves.toBe(DEFAULT_SETTINGS);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to DEFAULT_SETTINGS without throwing when read() rejects", async () => {
    const log = fakeLogger();
    const read = createSettingsReader(fakeSettings(new Error("daemon gone")), log);
    await expect(read()).resolves.toBe(DEFAULT_SETTINGS);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("reads again once the settings become ready", async () => {
    const log = fakeLogger();
    const read = createSettingsReader(
      fakeSettings({ status: "invalid", revision: "1", error: "bad" }, { status: "ready", revision: "2", values: custom }),
      log,
    );
    await expect(read()).resolves.toBe(DEFAULT_SETTINGS);
    await expect(read()).resolves.toEqual(custom);
  });

  it("falls back to DEFAULT_SETTINGS once when the read stalls", async () => {
    vi.useFakeTimers();
    try {
      const log = fakeLogger();
      const read = createSettingsReader(stallingSettings(), log);

      const first = read();
      const second = read();
      await vi.advanceTimersByTimeAsync(SETTINGS_TIMEOUT_MS);

      await expect(first).resolves.toBe(DEFAULT_SETTINGS);
      await expect(second).resolves.toBe(DEFAULT_SETTINGS);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith("seat settings read timed out", {
        error: `timed out after ${SETTINGS_TIMEOUT_MS}ms`,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createSettingsReader with { strict: true }", () => {
  it("still returns the stored values when the settings are ready", async () => {
    const log = fakeLogger();
    const read = createSettingsReader(
      fakeSettings({ status: "ready", revision: "1", values: custom }),
      log,
      { strict: true },
    );
    await expect(read()).resolves.toEqual(custom);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("still seeds DEFAULT_SETTINGS from an invalid state: that is the seeded-defaults design", async () => {
    const log = fakeLogger();
    const read = createSettingsReader(
      fakeSettings({ status: "invalid", revision: "2", error: "bad seats" }),
      log,
      { strict: true },
    );
    await expect(read()).resolves.toBe(DEFAULT_SETTINGS);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of substituting defaults when the read stalls", async () => {
    vi.useFakeTimers();
    try {
      const log = fakeLogger();
      const read = createSettingsReader(stallingSettings(), log, { strict: true });

      const pending = read();
      const rejected = expect(pending).rejects.toThrow(SEAT_SETTINGS_UNLOADED);
      await vi.advanceTimersByTimeAsync(SETTINGS_TIMEOUT_MS);
      await rejected;

      // The stall is still reported to the log once, exactly as the lenient reader does.
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith("seat settings read timed out", {
        error: `timed out after ${SETTINGS_TIMEOUT_MS}ms`,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects instead of substituting defaults when the settings are unreadable", async () => {
    const log = fakeLogger();
    const read = createSettingsReader(fakeSettings(new Error("daemon gone")), log, { strict: true });
    await expect(read()).rejects.toThrow(SEAT_SETTINGS_UNLOADED);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

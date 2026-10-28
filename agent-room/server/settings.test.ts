import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, roomSettingsSchema, type RoomSettings } from "../shared/seats";
import type { Logger } from "./logger";
import { createSettingsReader } from "./settings";

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
});

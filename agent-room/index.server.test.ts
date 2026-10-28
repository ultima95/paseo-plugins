import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, roomSettingsSchema } from "./shared/seats";
import contribute from "./index.server";
import type { AgentCreateRequest } from "./server/inject";

type SeatsSettings = PluginSettings<typeof roomSettingsSchema>;
type CreateHook = (input: { request: AgentCreateRequest }) => Promise<AgentCreateRequest | void>;

function readState(state: Awaited<ReturnType<SeatsSettings["read"]>>) {
  return vi.fn(async () => state);
}

function contributeWith(read: ReturnType<typeof readState>) {
  let hook: CreateHook | undefined;
  const server = {
    registerSettings: () => ({ read, subscribe: () => () => undefined }) as unknown as SeatsSettings,
    before: (name: string, handler: CreateHook) => {
      if (name === "agent.create") hook = handler;
      return () => undefined;
    },
    on: () => () => undefined,
    handle: () => undefined,
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
  } as unknown as PluginServerContext;

  const cleanup = contribute(server);
  return { cleanup, create: (request: AgentCreateRequest) => hook!({ request }) };
}

const request = (title: string | null): AgentCreateRequest => ({
  config: { provider: "opencode", cwd: "/repo", title, model: "x" },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent-room server contribution", () => {
  it("registers the seats settings and an agent.create hook", () => {
    const { cleanup } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    expect(typeof cleanup).toBe("function");
  });

  it("passes an unmarked agent through untouched (returns undefined)", async () => {
    const { create } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    await expect(create(request("Fix it"))).resolves.toBeUndefined();
    await expect(create(request("[Lead] old room"))).resolves.toBeUndefined();
    await expect(create(request(null))).resolves.toBeUndefined();
  });

  it("returns the seat's request for a marked agent", async () => {
    const { create } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    const out = await create(request("[room:peer:default] probe"));
    expect(out?.config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
      cwd: "/repo",
      title: "[room:peer:default] probe",
    });
    expect(out?.config.systemPrompt).toContain("## Room seats");
  });

  it("still injects with DEFAULT_SETTINGS when the stored state is invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { create } = contributeWith(readState({ status: "invalid", revision: "1", error: "bad seats" }));
    const out = await create(request("[room:peer:cheap] fmt"));
    expect(out?.config.model).toBe("claude-haiku-4-5");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never rejects when settings.read() throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = vi.fn(async () => {
      throw new Error("daemon gone");
    });
    const { create } = contributeWith(read as unknown as ReturnType<typeof readState>);
    await expect(create(request("[room:lead] x"))).resolves.toMatchObject({
      config: { provider: "claude", model: "claude-opus-5-5" },
    });
  });

  it("warns about an unknown peer tier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { create } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    const out = await create(request("[room:peer:zzz] x"));
    expect(out?.config.model).toBe("claude-sonnet-5-5");
    expect(warn).toHaveBeenCalledWith("[agent-room]", "unknown peer tier", { tier: "zzz" });
  });
});

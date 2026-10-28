import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginServerContext,
  PluginSettings,
} from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, roomSettingsSchema } from "./shared/seats";
import contribute from "./index.server";
import type { AgentCreateRequest } from "./server/inject";

type SeatsSettings = PluginSettings<typeof roomSettingsSchema>;
type CreateHook = (input: { request: AgentCreateRequest }) => Promise<AgentCreateRequest | void>;
type LifecycleHook = (event: unknown, context: PluginHookContext) => Promise<void>;

function readState(state: Awaited<ReturnType<SeatsSettings["read"]>>) {
  return vi.fn(async () => state);
}

function contributeWith(read: ReturnType<typeof readState>) {
  let hook: CreateHook | undefined;
  const hooks: Record<string, LifecycleHook> = {};
  const handled: string[] = [];
  const server = {
    registerSettings: () => ({ read, subscribe: () => () => undefined }) as unknown as SeatsSettings,
    before: (name: string, handler: CreateHook) => {
      if (name === "agent.create") hook = handler;
      return () => undefined;
    },
    on: (name: string, handler: LifecycleHook) => {
      hooks[name] = handler;
      return () => undefined;
    },
    handle: (contract: { name: string }) => {
      handled.push(contract.name);
    },
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
  } as unknown as PluginServerContext;

  const cleanup = contribute(server);
  return { cleanup, handled, hooks, create: (request: AgentCreateRequest) => hook!({ request }) };
}

const request = (title: string | null): AgentCreateRequest => ({
  config: { provider: "opencode", cwd: "/repo", title, model: "x" },
});

const hookAgent = (over: Partial<PluginHookAgent> & { id: string }): PluginHookAgent => ({
  id: over.id,
  workspaceId: over.workspaceId ?? "W1",
  parentAgentId: over.parentAgentId ?? null,
  provider: over.provider ?? "claude",
  cwd: over.cwd ?? "/repo",
  title: over.title ?? null,
});

/** The store path resolves at contribute time, so the data dir must be sandboxed. */
let home: string;
let previousPaseoHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-room-home-"));
  previousPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  if (previousPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousPaseoHome;
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("agent-room server contribution", () => {
  it("registers the seats settings and an agent.create hook", () => {
    const { cleanup } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    expect(typeof cleanup).toBe("function");
  });

  it("registers the room lifecycle hooks and flushes the store on cleanup", async () => {
    const { cleanup, hooks } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    expect(Object.keys(hooks).sort()).toEqual(["agent.archived", "agent.created", "agent.turn_ended"]);
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("registers the launch, list and get RPCs in contract order", () => {
    const { handled } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    expect(handled).toEqual(["room.launch", "room.list", "room.get"]);
  });

  it("swallows lifecycle failures instead of throwing at the daemon", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hooks } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    const context = { paseo: {} as PaseoApi, signal: new AbortController().signal };

    // A parent id with no room and an unreadable daemon: the handler logs, never throws.
    await expect(
      hooks["agent.created"]({ agent: hookAgent({ id: "X1", parentAgentId: "U1", title: "plain" }) }, context),
    ).resolves.toBeUndefined();
    await expect(
      hooks["agent.archived"](
        { agent: hookAgent({ id: "Y1" }), archivedAt: "2026-10-28T10:00:00.000Z" },
        context,
      ),
    ).resolves.toBeUndefined();
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

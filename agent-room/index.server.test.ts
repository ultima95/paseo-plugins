import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaseoAgentCreateOptions, PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginServerContext,
  PluginSettings,
} from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, roomSettingsSchema } from "./shared/seats";
import contribute, { __resetGcMigrated, type GcOverrides } from "./index.server";
import type { AgentCreateRequest } from "./server/inject";
import { SEAT_SETTINGS_UNLOADED, SETTINGS_TIMEOUT_MS } from "./server/settings";

type SeatsSettings = PluginSettings<typeof roomSettingsSchema>;
type SeatsState = Awaited<ReturnType<SeatsSettings["read"]>>;
type SeatsRead = () => Promise<SeatsState>;
type CreateHook = (input: { request: AgentCreateRequest }) => Promise<AgentCreateRequest | void>;
type LifecycleHook = (event: unknown, context: PluginHookContext) => Promise<void>;

/** A registered RPC handler, callable with whatever the test passes. */
type RpcCall = (input: unknown, context: unknown) => Promise<unknown>;
type RegisteredHandler = (input: never, context: never) => Promise<unknown>;

function readState(state: SeatsState) {
  return vi.fn(async () => state);
}

/** A daemon whose settings read never answers: the stall the rulings care about. */
function stallingState(): SeatsRead {
  return () => new Promise<SeatsState>(() => undefined);
}

/**
 * The store load is the only wait between a plugin load and an RPC serving, and
 * it is real file I/O, so the tests need a way to hold it open.
 */
const loadGate = vi.hoisted(() => {
  let hold = false;
  let release: (() => void) | undefined;
  let waiting = Promise.resolve();

  return {
    close(): void {
      hold = true;
      waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open(): void {
      hold = false;
      release?.();
      release = undefined;
      waiting = Promise.resolve();
    },
    wait(): Promise<void> {
      return waiting;
    },
    get held(): boolean {
      return hold;
    },
  };
});

vi.mock("./server/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server/store")>();
  return {
    ...actual,
    createRoomStore: (deps: Parameters<typeof actual.createRoomStore>[0]) => {
      const store = actual.createRoomStore(deps);
      const load = store.load.bind(store);
      store.load = () => (loadGate.held ? loadGate.wait() : load());
      return store;
    },
  };
});

/** A daemon stub that records every `agents.create` and hands back sequential ids. */
function fakePaseo() {
  const created: PaseoAgentCreateOptions[] = [];
  const paseo = {
    agents: {
      create: vi.fn(async (options: PaseoAgentCreateOptions) => {
        created.push(options);
        return { id: `A${created.length}` };
      }),
    },
    workspaces: {
      list: vi.fn(async () => ({ entries: [] })),
      ref: vi.fn((workspaceId: string) => ({
        id: workspaceId,
        agents: {
          create: vi.fn(async (options: PaseoAgentCreateOptions) => {
            created.push(options);
            return { id: `W${created.length}` };
          }),
        },
      })),
    },
  } as unknown as PaseoApi;

  return { paseo, created };
}

/** The `gc` settings document a test wants the plugin to see. */
type GcRead = () => Promise<unknown>;

const readyGc = (values: unknown = {}): GcRead => {
  return async () => ({ status: "ready", revision: "1", values });
};

function contributeWith(read: SeatsRead, gc: GcRead = readyGc(), overrides: GcOverrides = {}) {
  let hook: CreateHook | undefined;
  const hooks: Record<string, LifecycleHook> = {};
  const handled: Array<{ name: string; handler: RegisteredHandler }> = [];
  const server = {
    registerSettings: (definition: { id: string }) =>
      (definition.id === "gc" ? { read: gc, subscribe: () => () => undefined } : { read, subscribe: () => () => undefined }) as unknown as SeatsSettings,
    before: (name: string, handler: CreateHook) => {
      if (name === "agent.create") hook = handler;
      return () => undefined;
    },
    on: (name: string, handler: LifecycleHook) => {
      hooks[name] = handler;
      return () => undefined;
    },
    handle: (contract: { name: string }, handler: RegisteredHandler) => {
      handled.push({ name: contract.name, handler });
    },
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
  } as unknown as PluginServerContext;

  const cleanup = contribute(server, overrides);

  /** The handler the daemon would run for `name`, with its narrow types erased. */
  const invoke = (name: string): RpcCall => {
    const entry = handled.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no handler registered for ${name}`);
    return (input, context) => entry.handler(input as never, context as never);
  };

  return { cleanup, handled, hooks, invoke, create: (request: AgentCreateRequest) => hook!({ request }) };
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
let previousGcConfig: string | undefined;

beforeEach(async () => {
  loadGate.open();
  __resetGcMigrated();
  home = await mkdtemp(join(tmpdir(), "agent-room-home-"));
  previousPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  // Every test gets its own (absent unless it writes one) `slp-gc.conf`, so the
  // GC never reads the machine's real one and its memoised import is per-test.
  previousGcConfig = process.env.SLP_GC_CONFIG;
  process.env.SLP_GC_CONFIG = join(home, "slp-gc.conf");
});

afterEach(async () => {
  loadGate.open();
  if (previousPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousPaseoHome;
  if (previousGcConfig === undefined) delete process.env.SLP_GC_CONFIG;
  else process.env.SLP_GC_CONFIG = previousGcConfig;
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

  it("registers the room and GC RPCs in contract order", () => {
    const { handled } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    expect(handled.map((entry) => entry.name)).toEqual([
      "room.launch",
      "room.adopt",
      "room.list",
      "room.get",
      "gc.status",
      "gc.run",
    ]);
    // Six contracts, six distinct handlers: none registered twice by mistake.
    expect(new Set(handled.map((entry) => entry.handler)).size).toBe(6);
  });

  it("binds each contract to its matching handler, not merely to some handler", async () => {
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );
    const { paseo, created } = fakePaseo();
    const context = { paseo };

    // `room.launch` reaches the create path: a `room.list` binding would answer
    // with rooms and create nothing.
    await expect(
      invoke("room.launch")({ task: "Fix the room", cwd: "/repo" }, context),
    ).resolves.toEqual({ roomId: "A1" });
    expect(created).toHaveLength(1);
    expect(created[0]?.prompt).toBe("Fix the room");

    // …and the reads stay reads: neither creates an agent.
    await expect(invoke("room.list")({}, context)).resolves.toEqual({ rooms: [] });
    await expect(invoke("room.get")({ roomId: "no-such-room" }, context)).resolves.toEqual({
      missing: true,
    });
    expect(created).toHaveLength(1);
  });

  it("holds a launch until the room store has loaded", async () => {
    loadGate.close();
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );
    const { paseo, created } = fakePaseo();

    const pending = invoke("room.launch")({ task: "Fix the room", cwd: "/repo" }, { paseo });

    // A real macrotask drains the handler's microtasks: with the load still
    // unresolved it must be parked on `await loaded`, not creating an agent
    // against a store that is not in memory yet.
    await new Promise((resolve) => setImmediate(resolve));
    expect(loadGate.held).toBe(true);
    expect(created).toHaveLength(0);

    loadGate.open();
    await expect(pending).resolves.toEqual({ roomId: "A1" });
    expect(created).toHaveLength(1);
  });

  it("fails the launch, and creates nothing, when the seat settings stall", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { invoke } = contributeWith(stallingState());
      // Drain the store load first, so the only pending wait is the settings read.
      await invoke("room.list")({}, {});

      const { paseo, created } = fakePaseo();
      const pending = invoke("room.launch")({ task: "Fix the room", cwd: "/repo" }, { paseo });
      const rejected = expect(pending).rejects.toThrow(SEAT_SETTINGS_UNLOADED);

      // Let the handler reach the settings read, then run its 2 s timer out.
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(SETTINGS_TIMEOUT_MS);
      await rejected;

      expect(created).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith("[agent-room]", "seat settings read timed out", {
        error: `timed out after ${SETTINGS_TIMEOUT_MS}ms`,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still seeds DEFAULT_SETTINGS for a launch when the saved settings are invalid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { invoke } = contributeWith(readState({ status: "invalid", revision: "1", error: "bad seats" }));
    const { paseo, created } = fakePaseo();

    await invoke("room.launch")({ task: "Fix the room", cwd: "/repo" }, { paseo });

    expect(created).toHaveLength(1);
    expect(created[0]?.config).toMatchObject({
      provider: "claude/claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "xhigh",
    });
    // The launch carries the Supervisor's prompt itself (I4), not only the hook.
    expect(created[0]?.config.systemPrompt).toContain("## Room seats");
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

  it("does not read the seat settings for an agent with no marker", async () => {
    const read = readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS });
    const { create } = contributeWith(read);

    await create(request("Fix it"));
    await create(request("[Lead] old room"));
    await create(request(null));

    // An unmarked create is the daemon's common case; a settings round-trip
    // there can stall for 2 s and must never happen.
    expect(read).not.toHaveBeenCalled();
  });

  it("does not wait on a stalled settings read for an unmarked agent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { create } = contributeWith(stallingState());

      // The read never answers: this only settles because it is never awaited.
      await expect(create(request("Fix it"))).resolves.toBeUndefined();
      await expect(create(request(null))).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reads the settings for a marked agent", async () => {
    const read = readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS });
    const { create } = contributeWith(read);

    await create(request("[room:lead] x"));

    expect(read).toHaveBeenCalledTimes(1);
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
    const { create } = contributeWith(read);
    await expect(create(request("[room:lead] x"))).resolves.toMatchObject({
      config: { provider: "claude", model: "claude-opus-5-5" },
    });
  });

  it("serves gc.status before any tick has run, with the defaults in force", async () => {
    const { invoke } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));

    const status = (await invoke("gc.status")({}, {})) as Record<string, unknown>;

    // No tick yet: nothing identified, nothing sampled, and the reference's
    // report-only defaults — which is exactly what the next tick would act on.
    expect(status.ident).toEqual({ ok: false, why: "no tick has run yet" });
    expect(status.lastTickAt).toBeNull();
    expect(status.procs).toEqual([]);
    expect(status.candidates).toEqual([]);
    expect(status.settings).toEqual({
      apply: false,
      killStale: false,
      killMemory: false,
      memWarnMb: 3072,
      memKillMb: 4096,
    });
  });

  it("lets the plugin's gc document override the imported conf baseline", async () => {
    await writeFile(
      process.env.SLP_GC_CONFIG as string,
      ["# the reference's own conf", "SLP_GC_MEM_WARN_MB=2048", "SLP_GC_KILL_STALE=0"].join("\n"),
      "utf8",
    );
    const gcRead = readyGc({ killStale: true, memWarnMb: 1500 });
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
      gcRead,
    );

    const status = (await invoke("gc.status")({}, {})) as { settings: Record<string, unknown> };

    // The document wins on the two keys it carries; the conf's baseline supplies
    // everything else (apply stays off, because neither source turned it on).
    expect(status.settings).toMatchObject({
      apply: false,
      killStale: true,
      killMemory: false,
      memWarnMb: 1500,
      memKillMb: 4096,
    });
  });

  it("falls back to the imported baseline when the gc settings document is invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(process.env.SLP_GC_CONFIG as string, "SLP_GC_MEM_WARN_MB=2048\n", "utf8");
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
      // What `registerSettings` answers for a document that does not parse.
      async () => ({ status: "invalid", revision: "1", error: "memWarnMb: expected number" }),
    );

    const status = (await invoke("gc.status")({}, {})) as { settings: Record<string, number> };

    expect(status.settings.memWarnMb).toBe(2048);
    expect(warn).toHaveBeenCalledWith(
      "[agent-room]",
      "gc settings invalid; using the imported baseline",
      { error: "memWarnMb: expected number" },
    );
  });

  it("still loads and serves the GC when the conf is malformed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(
      process.env.SLP_GC_CONFIG as string,
      ["not a conf line at all", "SLP_GC_MAX_KILLS=banana", "SLP_GC_MEM_WARN_MB=2048"].join("\n"),
      "utf8",
    );
    const { invoke } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));

    const status = (await invoke("gc.status")({}, {})) as { settings: Record<string, number> };

    // The keys that parsed apply, the malformed ones fall back to the defaults,
    // and the plugin still answers with an empty room and a served status.
    expect(status.settings.memWarnMb).toBe(2048);
    await expect(invoke("room.list")({}, {})).resolves.toEqual({ rooms: [] });
  });

  it("runs one tick for gc.run and keeps its result for gc.status", async () => {
    const emptyExec = () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
      readyGc(),
      {
        exec: emptyExec,
        now: () => 1_790_000_000,
        legacyStateDir: join(home, "no-legacy-state"),
        notify: () => undefined,
      },
    );

    await expect(invoke("gc.run")({ mode: "report" }, {})).resolves.toEqual([]);

    const status = (await invoke("gc.status")({}, {})) as Record<string, unknown>;
    expect(status.lastTickAt).toBe("2026-09-21T14:13:20Z");
    expect(status.settings).toMatchObject({ apply: false });
  });

  it("acts on nothing through gc.run while the toggles are off", async () => {
    const emptyExec = () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
    const deleteAgent = vi.fn(async () => undefined);
    const signal = vi.fn(() => true);
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
      readyGc(),
      {
        exec: emptyExec,
        now: () => 1_790_000_000,
        legacyStateDir: join(home, "no-legacy-state"),
        notify: () => undefined,
        deleteAgent,
        signal,
      },
    );

    await expect(invoke("gc.run")({ mode: "act" }, {})).resolves.toEqual([]);
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("warns about an unknown peer tier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { create } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    const out = await create(request("[room:peer:zzz] x"));
    expect(out?.config.model).toBe("claude-sonnet-5-5");
    expect(warn).toHaveBeenCalledWith("[agent-room]", "unknown peer tier", { tier: "zzz" });
  });
});

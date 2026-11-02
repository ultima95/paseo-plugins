import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

import { CHARTER_PROMPT_CAP } from "./shared/member";
import { DEFAULT_SETTINGS, roomSettingsSchema } from "./shared/roles";
import contribute, { __resetGcMigrated, type GcOverrides } from "./index.server";
import type { AgentCreateRequest } from "./server/inject";
import { PROMPTS } from "./server/prompts/generated";
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

/** A member record on disk; its seat matches what a launch would request. */
const MEMBER = {
  id: "mem-1",
  name: "Ada",
  role: "supervisor",
  provider: "opencode",
  model: "m1",
  memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
};

/** Write `members.json` (and `mem-1`'s charter) into the sandboxed data dir. */
async function seedMember(charter = "Ship it."): Promise<string> {
  const dataDir = join(home, "plugin-data", "agent-room");
  await mkdir(join(dataDir, "members", "mem-1"), { recursive: true });
  await writeFile(
    join(dataDir, "members.json"),
    JSON.stringify({ version: 1, members: [MEMBER] }),
    "utf8",
  );
  await writeFile(join(dataDir, "members", "mem-1", "charter.md"), charter, "utf8");
  return dataDir;
}

/** The request a Supervisor launch makes for the seeded member's seat. */
const memberRequest = (): AgentCreateRequest => ({
  config: { provider: "opencode", cwd: "/repo", title: "Supervisor: fix auth", model: "m1" },
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

  it("registers the room, member and GC RPCs in contract order", () => {
    const { handled } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    expect(handled.map((entry) => entry.name)).toEqual([
      "room.launch",
      "room.adopt",
      "room.list",
      "room.get",
      "member.list",
      "member.get",
      "member.save",
      "member.charter",
      "member.pending",
      "gc.status",
      "gc.run",
    ]);
    // Eleven contracts, eleven distinct handlers: none registered twice by mistake.
    expect(new Set(handled.map((entry) => entry.handler)).size).toBe(11);
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

  it("binds each member contract to the member store, not to a room handler", async () => {
    await seedMember();
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    // `member.list` answers members while `room.list` answers rooms: a swap
    // between the two stores would fail both shapes.
    await expect(invoke("member.list")({}, {})).resolves.toEqual({ members: [MEMBER] });
    await expect(invoke("room.list")({}, {})).resolves.toEqual({ rooms: [] });

    // The whole-member read carries what the seed wrote, and the missing arm is
    // the `room.get` shape's sibling.
    await expect(invoke("member.get")({ memberId: "mem-1" }, {})).resolves.toMatchObject({
      member: MEMBER,
      charter: "Ship it.",
      lessons: [],
      pending: [],
      episodes: [],
    });
    await expect(invoke("member.get")({ memberId: "mem-2" }, {})).resolves.toEqual({
      missing: true,
    });
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

  it("seeds members when a v1 rooms file is migrated on load", async () => {
    const dataDir = join(home, "plugin-data", "agent-room");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "rooms.json"),
      JSON.stringify({ version: 1, rooms: [], seats: [], feed: [] }),
      "utf8",
    );

    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );
    // The RPC waits for the load, and the load includes the member migration.
    await invoke("room.list")({}, {});

    const written = JSON.parse(await readFile(join(dataDir, "members.json"), "utf8")) as {
      version: number;
      members: Array<{ id: string }>;
    };
    expect(written.version).toBe(1);
    expect(written.members.map((record) => record.id).sort()).toEqual([
      "default-lead",
      "default-supervisor",
    ]);
  });

  it("loads without seeding members for a room store that is already v2", async () => {
    const dataDir = join(home, "plugin-data", "agent-room");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "rooms.json"),
      JSON.stringify({ version: 2, rooms: [], seats: [], feed: [] }),
      "utf8",
    );

    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );
    await invoke("room.list")({}, {});

    // No migration, so no member file: a fresh install starts with no members
    // rather than with seats the user never chose.
    await expect(readFile(join(dataDir, "members.json"), "utf8")).rejects.toThrow(/ENOENT/);
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
    expect(created[0]?.config.systemPrompt).toContain("## Room roles");
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

  it("does not read the role settings for an agent whose title names no role", async () => {
    const read = readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS });
    const { create } = contributeWith(read);

    // The hook's cheap pre-check rejects a title with no colon and no leading
    // bracket before anything awaits. An agent that names no role is the
    // daemon's common case, and a settings round-trip there can stall for 2 s
    // and must never happen. `Implementer audit the diff` is the grammar's own
    // near-miss: a role word without the separator names no role.
    await create(request("Fix it"));
    await create(request("Implementer audit the diff"));
    await create(request(null));

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

  it("returns the role's request for a role title, and for a legacy marker", async () => {
    const { create } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));

    // The grammar: the role name before the colon decides the seat.
    const titled = await create(request("Implementer: probe"));
    expect(titled?.config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
      cwd: "/repo",
      title: "Implementer: probe",
    });
    expect(titled?.config.systemPrompt).toContain("## Room roles");

    // Read old, write new: an in-flight room's `[room:peer:default]` title still
    // resolves, onto the same role, and is left as it is.
    const legacy = await create(request("[room:peer:default] probe"));
    expect(legacy?.config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
      cwd: "/repo",
      title: "[room:peer:default] probe",
    });
    expect(legacy?.config.systemPrompt).toContain("## Room roles");
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

  it("serves gc.status after a tick whose process phase failed outright", async () => {
    const brokenExec = () => {
      throw new Error("spawn ENOENT");
    };
    const { invoke } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
      readyGc(),
      {
        exec: brokenExec,
        now: () => 1_790_000_000,
        legacyStateDir: join(home, "no-legacy-state"),
        notify: () => undefined,
      },
    );

    // The tick still answers — a failed sample is a report, not an exception.
    await expect(invoke("gc.run")({ mode: "report" }, {})).resolves.toEqual([]);

    const status = (await invoke("gc.status")({}, {})) as {
      ident: { ok: boolean; why: string };
      lastTickAt: string | null;
      settings: Record<string, unknown>;
      procs: unknown[];
      candidates: unknown[];
    };

    // A failed tick is still the last tick: the screen must say why nothing is
    // known, not fall back to "no tick has run yet".
    expect(status.ident.ok).toBe(false);
    expect(status.ident.why).not.toBe("");
    expect(status.ident.why).not.toBe("no tick has run yet");
    expect(status.procs).toEqual([]);
    expect(status.candidates).toEqual([]);
    expect(status.lastTickAt).toBe("2026-09-21T14:13:20Z");
    expect(status.settings).toMatchObject({ apply: false, memWarnMb: 3072, memKillMb: 4096 });
  });

  it("refuses a gc.run that arrives while a scheduled tick is still running", async () => {
    // I-2: an RPC run must not overlap a scheduled tick. Both paths go through
    // the one `createTickGate`, so the RPC is *refused* (not queued) and starts
    // no tick of its own.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let tickStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      tickStarted = resolve;
    });
    let releaseTick!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const record = vi.fn(async () => {
      tickStarted();
      await released;
      return { line: null, alert: null };
    });
    const deleteAgent = vi.fn(async () => undefined);
    const emptyExec = () => ({ code: 0, stdout: "", stderr: "", timedOut: false });

    const { invoke, cleanup } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
      readyGc({ apply: true }),
      {
        exec: emptyExec,
        now: () => 1_790_000_000,
        legacyStateDir: join(home, "no-legacy-state"),
        notify: () => undefined,
        deleteAgent,
        // Short interval: the first scheduled tick fires while the test waits.
        intervalMs: 25,
        seams: { record },
      },
    );

    // The scheduled tick is now mid-tick, holding the gate inside the record phase.
    await started;
    expect(record).toHaveBeenCalledTimes(1);

    const rows = (await invoke("gc.run")({ mode: "act" }, {})) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "refuse", id: "-", acted: false });
    expect(String(rows[0]?.refusedBy)).toContain("tick-in-progress");
    // The strongest evidence: the RPC started no tick at all, so there is no
    // second acting phase — the seam still has exactly the scheduled tick's call.
    expect(record).toHaveBeenCalledTimes(1);
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(
        (call) => call[0] === "[agent-room]" && call[1] === "gc run refused: a tick is still running",
      ),
    ).toBe(true);

    // Teardown order, not an assertion: the scheduled tick this test held open is
    // still mid-tick below `record`, and it goes on to write the tick's report into
    // `stateDir` (one `.txt` and, since Task 14, its `.json`). `cleanup()` first, so
    // the interval stops and no *second* tick can start; then release the tick and
    // wait for it through the public status, which carries a tick only once
    // `runTick` has resolved. Without this the `afterEach` that removes the tmp home
    // races those writes (`ENOTEMPTY`), which says nothing about the mutex above.
    releaseTick();
    await cleanup();
    await vi.waitFor(async () => {
      const status = (await invoke("gc.status")({}, {})) as { lastTickAt: string | null };
      expect(status.lastTickAt).not.toBeNull();
    });
  });

  it("renders the matching member's section on a create that names its seat", async () => {
    await seedMember();
    const { create } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    const out = await create(memberRequest());

    // The member, not the catalog supervisor, supplies the seat and the section.
    expect(out?.config).toMatchObject({ provider: "opencode", model: "m1" });
    expect(out?.config.systemPrompt).toContain("## Member");
    expect(out?.config.systemPrompt).toContain("Name: Ada.");
    expect(out?.config.systemPrompt).toContain("Ship it.");
  });

  it("warns when the member section had to truncate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await seedMember("x".repeat(CHARTER_PROMPT_CAP + 1));
    const { create } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    const out = await create(memberRequest());

    expect(out?.config.systemPrompt).toContain("[charter truncated]");
    expect(warn).toHaveBeenCalledWith("[agent-room]", "member section truncated", {
      memberId: "mem-1",
      role: "supervisor",
    });
  });

  it("holds a marked create until the member store has loaded", async () => {
    await seedMember();
    loadGate.close();
    const { create } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    let settled = false;
    const pending = create(memberRequest()).then((out) => {
      settled = true;
      return out;
    });

    // The member index the hook builds is worthless before the load lands: the
    // create waits rather than passing the seat through unmembered.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    loadGate.open();
    await expect(pending).resolves.toMatchObject({ config: { model: "m1" } });
  });

  it("leaves a request that already carries the room prompt untouched", async () => {
    // This is `room.launch`'s own Supervisor: its seat and member section are
    // already built, and the hook re-applying the catalog role would undo them.
    const { create } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );
    const launched: AgentCreateRequest = {
      config: {
        provider: "opencode",
        cwd: "/repo",
        title: "Supervisor: fix auth",
        model: "m1",
        systemPrompt: PROMPTS.protocol,
      },
    };

    await expect(create(launched)).resolves.toBeUndefined();
  });

  it("keeps a member-seated Supervisor's seat truthful when agent.created lands first", async () => {
    await seedMember();
    const { invoke, hooks, cleanup } = contributeWith(
      readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
    );

    // No repository here: only the launch's member section asks for one.
    const dir = home;
    const context = { paseo: {} as PaseoApi, signal: new AbortController().signal };
    const created: PaseoAgentCreateOptions[] = [];
    const paseo = {
      agents: {
        // The daemon fires `agent.created` before `create` resolves, so the seat
        // is written before `room.launch` gets the id it can bind the member to.
        create: vi.fn(async (options: PaseoAgentCreateOptions) => {
          created.push(options);
          await hooks["agent.created"](
            {
              agent: hookAgent({
                id: "A1",
                // The member's own provider: the launch created the agent on it.
                provider: "opencode",
                cwd: dir,
                title: "Supervisor: fix auth",
              }),
            },
            context,
          );
          return { id: "A1" };
        }),
      },
      workspaces: { list: vi.fn(async () => ({ entries: [] })) },
    } as unknown as PaseoApi;

    await invoke("room.launch")(
      { task: "Fix the room", cwd: dir, supervisorMemberId: "mem-1" },
      { paseo },
    );

    const detail = (await invoke("room.get")({ roomId: "A1" }, {})) as {
      room: { supervisorMemberId: string | null };
      seats: Array<{ agentId: string; provider: string; model: string }>;
    };

    expect(created).toHaveLength(1);
    expect(detail.room.supervisorMemberId).toBe("mem-1");
    // The catalog supervisor runs `claude-opus-5-5`; the seat must name the
    // member's model and provider, whichever of the hook and the bind ran first.
    expect(detail.seats).toHaveLength(1);
    expect(detail.seats[0]).toMatchObject({ agentId: "A1", provider: "opencode", model: "m1" });

    // Flush the store before the `afterEach` removes the data dir: a write still
    // in flight would race the teardown instead of the assertion above.
    await cleanup();
  });

  it("warns about an unknown legacy peer tier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { create } = contributeWith(readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }));
    const out = await create(request("[room:peer:zzz] x"));
    // A tier the catalog no longer configures falls back to the first worker
    // role, and the warning names both the tier it came from and the role it got.
    expect(out?.config.model).toBe("claude-sonnet-5-5");
    expect(warn).toHaveBeenCalledWith("[agent-room]", "unknown legacy peer tier", {
      tier: "zzz",
      role: "implementer",
    });
  });
});

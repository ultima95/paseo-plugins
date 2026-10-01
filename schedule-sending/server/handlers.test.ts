import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_HORIZON_MS, MAX_TEXT_LENGTH, PAST_GRACE_MS, type ScheduledMessage } from "../shared/model";
import type { PaseoLike } from "./gateway";
import { createHandlers } from "./handlers";
import type { Logger } from "./logger";
import type { AgentGateway, AgentState } from "./scheduler";
import { createFileStore, type QueueStore } from "./store";

const silent: Logger = { info() {}, error() {} };
const paseo: PaseoLike = {
  agents: {
    ref: () => {
      throw new Error("handlers must use the gateway");
    },
  },
};

let dir: string;
let clock: number;
let store: QueueStore;
let agentState: AgentState;
let attached: PaseoLike[];
let nextId: number;

function setup() {
  const gateway: AgentGateway = {
    inspect: async () => agentState,
    send: async () => undefined,
  };
  return createHandlers({
    store,
    now: () => clock,
    newId: () => `id-${(nextId += 1)}`,
    ready: Promise.resolve(),
    attach: (p) => {
      attached.push(p);
    },
    gatewayFor: () => gateway,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "schedule-handlers-"));
  clock = 1_800_000_000_000;
  agentState = "idle";
  attached = [];
  nextId = 0;
  store = createFileStore({ dir, now: () => clock, log: silent });
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("add", () => {
  it("stores a pending item and remembers the paseo handle", async () => {
    const { add } = setup();
    const { item } = await add({ agentId: "agent-1", text: "hello", fireAt: clock + 120_000 }, paseo);

    expect(item).toEqual({
      id: "id-1",
      agentId: "agent-1",
      text: "hello",
      fireAt: clock + 120_000,
      createdAt: clock,
      status: "pending",
      attempts: 0,
    });
    expect(store.list()).toEqual([item]);
    expect(attached).toEqual([paseo]);
  });

  it("trims the message text", async () => {
    const { add } = setup();
    const { item } = await add({ agentId: "a", text: "  hi there \n", fireAt: clock + 120_000 }, paseo);
    expect(item.text).toBe("hi there");
  });

  it("rejects whitespace-only text and stores nothing", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "  \n\t ", fireAt: clock + 120_000 }, paseo)).rejects.toThrow("Message is empty");
    expect(store.list()).toEqual([]);
  });

  it("rejects text over the limit but accepts text exactly at it", async () => {
    const { add } = setup();
    await expect(
      add({ agentId: "a", text: "x".repeat(MAX_TEXT_LENGTH + 1), fireAt: clock + 120_000 }, paseo),
    ).rejects.toThrow(`Message is too long (max ${MAX_TEXT_LENGTH} characters)`);
    await expect(
      add({ agentId: "a", text: "x".repeat(MAX_TEXT_LENGTH), fireAt: clock + 120_000 }, paseo),
    ).resolves.toBeDefined();
  });

  it("rejects a time more than 30 days ahead", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "x", fireAt: clock + MAX_HORIZON_MS + 1 }, paseo)).rejects.toThrow(
      "Time is more than 30 days ahead",
    );
  });

  it("rejects a time further in the past than the clock-skew grace, accepts one inside it", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "x", fireAt: clock - PAST_GRACE_MS - 1 }, paseo)).rejects.toThrow(
      "Time is in the past",
    );
    await expect(add({ agentId: "a", text: "x", fireAt: clock - 4 * 60_000 }, paseo)).resolves.toBeDefined();
  });

  it("rejects a non-integer time", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 0.5 }, paseo)).rejects.toThrow("Invalid time");
    await expect(add({ agentId: "a", text: "x", fireAt: Number.NaN }, paseo)).rejects.toThrow("Invalid time");
  });

  it("rejects a missing or archived agent", async () => {
    const { add } = setup();
    agentState = "missing";
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 120_000 }, paseo)).rejects.toThrow("Agent not found");
    agentState = "archived";
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 120_000 }, paseo)).rejects.toThrow("Agent is archived");
    expect(store.list()).toEqual([]);
  });

  it("accepts a busy agent (the message will wait for it)", async () => {
    const { add } = setup();
    agentState = "busy";
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 120_000 }, paseo)).resolves.toBeDefined();
  });
});

describe("list", () => {
  it("returns only that agent's items: pending by fireAt, then finished newest first", async () => {
    const { list } = setup();
    const base = { agentId: "agent-1", attempts: 0, createdAt: clock - 1_000 };
    const items: ScheduledMessage[] = [
      { ...base, id: "later", text: "later", fireAt: clock + 9_000, status: "pending" },
      { ...base, id: "sooner", text: "sooner", fireAt: clock + 1_000, status: "pending" },
      { ...base, id: "sent-old", text: "s1", fireAt: clock - 500, status: "sent", finishedAt: clock - 400 },
      { ...base, id: "failed-new", text: "s2", fireAt: clock - 300, status: "failed", finishedAt: clock - 100 },
      { ...base, agentId: "agent-2", id: "other", text: "other", fireAt: clock + 1, status: "pending" },
    ];
    for (const item of items) await store.add(item);

    const { items: result } = await list({ agentId: "agent-1" }, paseo);
    expect(result.map((i) => i.id)).toEqual(["sooner", "later", "failed-new", "sent-old"]);
    expect(attached).toEqual([paseo]);
  });
});

describe("cancel", () => {
  const seed = (over: Partial<ScheduledMessage>): ScheduledMessage => ({
    id: "m1",
    agentId: "a",
    text: "x",
    fireAt: clock + 1_000,
    createdAt: clock,
    status: "pending",
    attempts: 0,
    ...over,
  });

  it("cancels a pending item", async () => {
    const { cancel } = setup();
    await store.add(seed({}));
    const { item } = await cancel({ id: "m1" }, paseo);
    expect(item).toMatchObject({ id: "m1", status: "canceled", finishedAt: clock });
    expect(store.get("m1")!.status).toBe("canceled");
  });

  it.each(["sent", "failed", "canceled"] as const)("leaves a %s item unchanged", async (status) => {
    const { cancel } = setup();
    await store.add(seed({ status, finishedAt: clock - 5 }));
    const { item } = await cancel({ id: "m1" }, paseo);
    expect(item).toMatchObject({ status, finishedAt: clock - 5 });
  });

  it("returns null for an unknown id", async () => {
    const { cancel } = setup();
    expect(await cancel({ id: "nope" }, paseo)).toEqual({ item: null });
  });
});

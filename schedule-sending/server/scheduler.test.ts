import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_MS,
  HISTORY_RETENTION_MS,
  INFRA_RETRY_WINDOW_MS,
  MAX_ATTEMPTS,
  type ScheduledMessage,
} from "../shared/model";
import type { Logger } from "./logger";
import { createScheduler, type AgentGateway, type AgentState } from "./scheduler";
import { createFileStore, type QueueStore } from "./store";

const SECRET = "the-secret-message-body";
const logged: string[] = [];
const recording: Logger = {
  info: (message, fields) => {
    logged.push(JSON.stringify([message, fields]));
  },
  error: (message, fields) => {
    logged.push(JSON.stringify([message, fields]));
  },
};

class FakeGateway implements AgentGateway {
  states = new Map<string, AgentState>();
  sent: Array<{ agentId: string; text: string }> = [];
  sendError: Error | null = null;
  inspectError: Error | null = null;
  beforeInspect: (() => Promise<void>) | null = null;

  async inspect(agentId: string): Promise<AgentState> {
    if (this.beforeInspect) await this.beforeInspect();
    if (this.inspectError) throw this.inspectError;
    return this.states.get(agentId) ?? "idle";
  }

  async send(agentId: string, text: string): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push({ agentId, text });
  }
}

let dir: string;
let clock: number;
let store: QueueStore;

const pending = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: "m1",
  agentId: "agent-1",
  text: SECRET,
  fireAt: clock - 1,
  createdAt: clock - 10_000,
  status: "pending",
  attempts: 0,
  ...over,
});

const makeScheduler = (gateway: AgentGateway | null) =>
  createScheduler({ store, now: () => clock, log: recording, getGateway: () => gateway });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "schedule-scheduler-"));
  clock = 1_800_000_000_000;
  logged.length = 0;
  store = createFileStore({ dir, now: () => clock, log: recording });
  await store.load();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("delivery", () => {
  it("sends a due item when the agent is idle and records it as sent", async () => {
    const gateway = new FakeGateway();
    await store.add(pending());
    await makeScheduler(gateway).tick();

    expect(gateway.sent).toEqual([{ agentId: "agent-1", text: SECRET }]);
    expect(store.get("m1")).toMatchObject({ status: "sent", sentAt: clock, finishedAt: clock });
  });

  it("does not send before fireAt", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ fireAt: clock + 60_000 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")!.status).toBe("pending");
  });

  it("does nothing while no gateway is available", async () => {
    await store.add(pending());
    await makeScheduler(null).tick();
    expect(store.get("m1")!.status).toBe("pending");
  });

  it("delivers an item that became overdue long ago instead of dropping it", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ fireAt: clock - 3 * 24 * 60 * 60 * 1000 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toHaveLength(1);
  });

  it("never logs the message text", async () => {
    const gateway = new FakeGateway();
    await store.add(pending());
    await makeScheduler(gateway).tick();
    gateway.sendError = new Error("boom");
    await store.add(pending({ id: "m2", agentId: "agent-2" }));
    await makeScheduler(gateway).tick();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});

describe("busy agents", () => {
  it("waits while the agent is busy, then sends once it is idle", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "busy");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    await scheduler.tick();
    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")).toMatchObject({ status: "pending", attempts: 0 });

    gateway.states.set("agent-1", "idle");
    await scheduler.tick();
    expect(gateway.sent).toHaveLength(1);
    expect(store.get("m1")!.status).toBe("sent");
  });
});

describe("failures and retries", () => {
  it("records a failed attempt with backoff and does not retry early", async () => {
    const gateway = new FakeGateway();
    gateway.sendError = new Error("socket closed");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    await scheduler.tick();
    expect(store.get("m1")).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "socket closed",
      nextAttemptAt: clock + BACKOFF_MS[0],
    });

    gateway.sendError = null;
    await scheduler.tick();
    expect(gateway.sent).toEqual([]);

    clock = store.get("m1")!.nextAttemptAt!;
    await scheduler.tick();
    expect(gateway.sent).toHaveLength(1);
    expect(store.get("m1")!.status).toBe("sent");
  });

  it("retries with growing backoff and fails after MAX_ATTEMPTS", async () => {
    const gateway = new FakeGateway();
    gateway.sendError = new Error("socket closed");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await scheduler.tick();
      const current = store.get("m1")!;
      expect(current.status).toBe("pending");
      expect(current.attempts).toBe(attempt);
      expect(current.nextAttemptAt).toBe(clock + BACKOFF_MS[attempt - 1]!);
      clock = current.nextAttemptAt!;
    }

    await scheduler.tick();
    expect(store.get("m1")).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      lastError: "socket closed",
      finishedAt: clock,
    });
  });

  it("keeps an item pending through an outage of the agent lookup without using up attempts", async () => {
    const gateway = new FakeGateway();
    gateway.inspectError = new Error("daemon unreachable");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    for (let tickNumber = 0; tickNumber < 8 * 60; tickNumber += 1) {
      await scheduler.tick();
      clock += 10_000;
    }
    expect(store.get("m1")).toMatchObject({ status: "pending", attempts: 0, lastError: "daemon unreachable" });
    expect(store.get("m1")!.nextAttemptAt).toBeUndefined();

    gateway.inspectError = null;
    await scheduler.tick();
    expect(gateway.sent).toHaveLength(1);
    expect(store.get("m1")!.status).toBe("sent");
  });

  it("does not rewrite the store when the same lookup error repeats", async () => {
    const gateway = new FakeGateway();
    gateway.inspectError = new Error("daemon unreachable");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());
    const update = vi.spyOn(store, "update");

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("clears the lookup error once the agent can be inspected again", async () => {
    const gateway = new FakeGateway();
    gateway.inspectError = new Error("daemon unreachable");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());
    await scheduler.tick();
    expect(store.get("m1")!.lastError).toBe("daemon unreachable");

    gateway.inspectError = null;
    gateway.states.set("agent-1", "busy");
    await scheduler.tick();
    expect(store.get("m1")!.status).toBe("pending");
    expect(store.get("m1")!.lastError).toBeUndefined();
  });

  it("fails an item only after the lookup has been failing past the retry window", async () => {
    const gateway = new FakeGateway();
    gateway.inspectError = new Error("daemon unreachable");
    const scheduler = makeScheduler(gateway);
    const item = pending();
    await store.add(item);

    clock = item.fireAt + INFRA_RETRY_WINDOW_MS;
    await scheduler.tick();
    expect(store.get("m1")!.status).toBe("pending");

    clock = item.fireAt + INFRA_RETRY_WINDOW_MS + 1;
    await scheduler.tick();
    expect(store.get("m1")).toMatchObject({
      status: "failed",
      lastError: "daemon unreachable",
      finishedAt: clock,
    });
    expect(gateway.sent).toEqual([]);
  });

  it("fails immediately, without sending, when the agent is archived", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "archived");
    await store.add(pending());
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")).toMatchObject({ status: "failed", lastError: "Agent archived" });
  });

  it("fails immediately, without sending, when the agent no longer exists", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "missing");
    await store.add(pending());
    await makeScheduler(gateway).tick();
    expect(store.get("m1")).toMatchObject({ status: "failed", lastError: "Agent not found" });
  });
});

describe("ordering", () => {
  it("sends only the earliest item for an agent per tick", async () => {
    const gateway = new FakeGateway();
    const scheduler = makeScheduler(gateway);
    await store.add(pending({ id: "late", text: "second", fireAt: clock - 10 }));
    await store.add(pending({ id: "early", text: "first", fireAt: clock - 500 }));

    await scheduler.tick();
    expect(gateway.sent.map((s) => s.text)).toEqual(["first"]);

    await scheduler.tick();
    expect(gateway.sent.map((s) => s.text)).toEqual(["first", "second"]);
  });

  it("breaks fireAt ties by createdAt", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "b", text: "created-later", fireAt: clock - 5, createdAt: clock - 100 }));
    await store.add(pending({ id: "a", text: "created-first", fireAt: clock - 5, createdAt: clock - 200 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent.map((s) => s.text)).toEqual(["created-first"]);
  });

  it("does not let a later item overtake an earlier one waiting out a backoff", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "head", text: "head", fireAt: clock - 500, attempts: 1, nextAttemptAt: clock + 60_000 }));
    await store.add(pending({ id: "next", text: "next", fireAt: clock - 10 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toEqual([]);
  });

  it("sends to different agents in the same tick", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "a", agentId: "agent-1", text: "one" }));
    await store.add(pending({ id: "b", agentId: "agent-2", text: "two" }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent.map((s) => s.text).sort()).toEqual(["one", "two"]);
  });
});

describe("races", () => {
  it("does not send when the item is canceled while the agent is being inspected", async () => {
    const gateway = new FakeGateway();
    gateway.beforeInspect = async () => {
      await store.update("m1", (item) => ({ ...item, status: "canceled", finishedAt: clock }));
    };
    await store.add(pending());
    await makeScheduler(gateway).tick();

    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")!.status).toBe("canceled");
  });

  it("keeps a canceled item canceled when the agent turns out to be archived", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "archived");
    gateway.beforeInspect = async () => {
      await store.update("m1", (item) => ({ ...item, status: "canceled", finishedAt: clock }));
    };
    await store.add(pending());
    await makeScheduler(gateway).tick();
    expect(store.get("m1")!.status).toBe("canceled");
  });

  it("sends once when two ticks overlap", async () => {
    const gateway = new FakeGateway();
    const scheduler = makeScheduler(gateway);
    await store.add(pending());
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(gateway.sent).toHaveLength(1);
  });
});

describe("housekeeping", () => {
  it("prunes finished items past the retention window on each tick", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "old", status: "sent", finishedAt: clock - HISTORY_RETENTION_MS - 1 }));
    await makeScheduler(gateway).tick();
    expect(store.get("old")).toBeUndefined();
  });
});

describe("timer", () => {
  it("ticks on an interval after start() and stops after stop()", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const gateway = new FakeGateway();
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    scheduler.start(10_000);
    vi.advanceTimersByTime(10_000);
    await vi.waitFor(() => expect(gateway.sent).toHaveLength(1));

    scheduler.stop();
    await store.add(pending({ id: "m2", agentId: "agent-2", text: "after stop" }));
    vi.advanceTimersByTime(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.sent).toHaveLength(1);
  });
});

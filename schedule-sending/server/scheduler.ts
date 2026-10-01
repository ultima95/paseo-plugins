import { BACKOFF_MS, INFRA_RETRY_WINDOW_MS, MAX_ATTEMPTS, type ScheduledMessage } from "../shared/model";
import type { Logger } from "./logger";
import type { QueueStore } from "./store";

export const TICK_MS = 10_000;

export type AgentState = "idle" | "busy" | "missing" | "archived";

export interface AgentGateway {
  inspect(agentId: string): Promise<AgentState>;
  send(agentId: string, text: string): Promise<void>;
}

export interface SchedulerDeps {
  store: QueueStore;
  now: () => number;
  log: Logger;
  getGateway: () => AgentGateway | null;
}

export interface Scheduler {
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

const MAX_ERROR_LENGTH = 300;
const LAST_BACKOFF_MS = 1_800_000;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, now, log, getGateway } = deps;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // A cancel that lands mid-flight must win over a failure verdict, so failures only touch pending items.
  async function closeIfPending(id: string, patch: Partial<ScheduledMessage>): Promise<void> {
    await store.update(id, (item) =>
      item.status === "pending" ? { ...item, ...patch, finishedAt: now() } : item,
    );
  }

  async function recordFailure(item: ScheduledMessage, error: unknown): Promise<void> {
    const attempts = item.attempts + 1;
    const lastError = describeError(error);
    if (attempts >= MAX_ATTEMPTS) {
      log.error("giving up", { id: item.id, agentId: item.agentId, attempts });
      await closeIfPending(item.id, { status: "failed", attempts, lastError });
      return;
    }
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? LAST_BACKOFF_MS;
    log.error("attempt failed, will retry", { id: item.id, agentId: item.agentId, attempts });
    await store.update(item.id, (current) =>
      current.status === "pending" ? { ...current, attempts, lastError, nextAttemptAt: now() + delay } : current,
    );
  }

  // A failing agent lookup means the daemon connection is down, not that this message is bad. It must
  // not use up the send budget (an overnight blip would turn every item into Failed): keep the item
  // pending, retry each tick, and only give up once it has been failing past the retry window.
  async function recordLookupFailure(item: ScheduledMessage, error: unknown): Promise<void> {
    const lastError = describeError(error);
    if (now() - item.fireAt > INFRA_RETRY_WINDOW_MS) {
      log.error("giving up after retry window", { id: item.id, agentId: item.agentId });
      await closeIfPending(item.id, { status: "failed", lastError });
      return;
    }
    if (item.lastError === lastError) return;
    log.error("agent lookup failed, will keep retrying", { id: item.id, agentId: item.agentId });
    await store.update(item.id, (current) =>
      current.status === "pending" ? { ...current, lastError } : current,
    );
  }

  async function clearLookupError(item: ScheduledMessage): Promise<void> {
    if (item.attempts !== 0 || item.lastError === undefined) return;
    await store.update(item.id, (current) => {
      if (current.status !== "pending") return current;
      const { lastError: _cleared, ...rest } = current;
      return rest;
    });
  }

  async function deliver(item: ScheduledMessage, gateway: AgentGateway): Promise<void> {
    let state: AgentState;
    try {
      state = await gateway.inspect(item.agentId);
    } catch (error) {
      await recordLookupFailure(item, error);
      return;
    }
    if (state === "missing") {
      await closeIfPending(item.id, { status: "failed", lastError: "Agent not found" });
      return;
    }
    if (state === "archived") {
      await closeIfPending(item.id, { status: "failed", lastError: "Agent archived" });
      return;
    }
    await clearLookupError(item);
    if (state === "busy") return;

    const current = store.get(item.id);
    if (current === undefined || current.status !== "pending") return;

    try {
      await gateway.send(item.agentId, item.text);
    } catch (error) {
      await recordFailure(item, error);
      return;
    }
    log.info("sent", { id: item.id, agentId: item.agentId });
    // The message is out; record the truth even if a cancel slipped in after the check above.
    await store.update(item.id, (latest) => ({ ...latest, status: "sent", sentAt: now(), finishedAt: now() }));
  }

  // Only the head item of each agent is eligible, so nothing overtakes an earlier waiting item
  // and at most one message per agent is sent per tick.
  function dueHeads(nowMs: number): ScheduledMessage[] {
    const heads = new Map<string, ScheduledMessage>();
    for (const item of store.list()) {
      if (item.status !== "pending") continue;
      const head = heads.get(item.agentId);
      const earlier =
        head === undefined ||
        item.fireAt < head.fireAt ||
        (item.fireAt === head.fireAt && item.createdAt < head.createdAt);
      if (earlier) heads.set(item.agentId, item);
    }
    return [...heads.values()].filter(
      (item) => item.fireAt <= nowMs && (item.nextAttemptAt === undefined || item.nextAttemptAt <= nowMs),
    );
  }

  async function runTick(): Promise<void> {
    const gateway = getGateway();
    if (gateway === null) return;
    const nowMs = now();
    try {
      await store.prune(nowMs);
    } catch (error) {
      log.error("prune failed", { error: describeError(error) });
    }
    for (const item of dueHeads(nowMs)) {
      try {
        await deliver(item, gateway);
      } catch (error) {
        log.error("delivery crashed", { id: item.id, agentId: item.agentId, error: describeError(error) });
      }
    }
  }

  function tick(): Promise<void> {
    if (inFlight === null) {
      inFlight = runTick().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    tick,
    start(intervalMs = TICK_MS) {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

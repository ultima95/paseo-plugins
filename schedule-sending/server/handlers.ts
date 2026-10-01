import { MAX_HORIZON_MS, MAX_TEXT_LENGTH, PAST_GRACE_MS, type ScheduledMessage } from "../shared/model";
import type { PaseoLike } from "./gateway";
import type { AgentGateway } from "./scheduler";
import type { QueueStore } from "./store";

export interface HandlerDeps {
  store: QueueStore;
  now: () => number;
  newId: () => string;
  ready: Promise<void>;
  attach(paseo: PaseoLike): void;
  gatewayFor(paseo: PaseoLike): AgentGateway;
}

export interface AddInput {
  agentId: string;
  text: string;
  fireAt: number;
}

export function createHandlers(deps: HandlerDeps) {
  const { store, now, newId, ready, attach, gatewayFor } = deps;

  return {
    async add(input: AddInput, paseo: PaseoLike): Promise<{ item: ScheduledMessage }> {
      await ready;
      attach(paseo);

      const text = input.text.trim();
      if (text.length === 0) throw new Error("Message is empty");
      if (text.length > MAX_TEXT_LENGTH) throw new Error(`Message is too long (max ${MAX_TEXT_LENGTH} characters)`);

      const nowMs = now();
      if (!Number.isInteger(input.fireAt)) throw new Error("Invalid time");
      if (input.fireAt < nowMs - PAST_GRACE_MS) throw new Error("Time is in the past");
      if (input.fireAt > nowMs + MAX_HORIZON_MS) throw new Error("Time is more than 30 days ahead");

      const state = await gatewayFor(paseo).inspect(input.agentId);
      if (state === "missing") throw new Error("Agent not found");
      if (state === "archived") throw new Error("Agent is archived");

      const item: ScheduledMessage = {
        id: newId(),
        agentId: input.agentId,
        text,
        fireAt: input.fireAt,
        createdAt: nowMs,
        status: "pending",
        attempts: 0,
      };
      await store.add(item);
      return { item };
    },

    async list(input: { agentId: string }, paseo: PaseoLike): Promise<{ items: ScheduledMessage[] }> {
      await ready;
      attach(paseo);
      const mine = store.list().filter((item) => item.agentId === input.agentId);
      const pending = mine
        .filter((item) => item.status === "pending")
        .sort((a, b) => a.fireAt - b.fireAt || a.createdAt - b.createdAt);
      const finished = mine
        .filter((item) => item.status !== "pending")
        .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
      return { items: [...pending, ...finished] };
    },

    async cancel(input: { id: string }, paseo: PaseoLike): Promise<{ item: ScheduledMessage | null }> {
      await ready;
      attach(paseo);
      const updated = await store.update(input.id, (item) =>
        item.status === "pending" ? { ...item, status: "canceled", finishedAt: now() } : item,
      );
      return { item: updated ?? null };
    },
  };
}

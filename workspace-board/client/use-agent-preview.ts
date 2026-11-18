import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
} from "@getpaseo/protocol/agent-types";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { appendLiveItem, rowsFromEntries, type TimelineRow } from "./timeline-model";

type AgentEntry = PaseoAgent;

/** The agent a preview is talking to, as its host reports it right now. */
export interface PreviewAgent {
  readonly agentId: string;
  readonly title: string | null;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly pending: readonly AgentPermissionRequest[];
}

export type AgentLookup =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly agents: readonly PreviewAgent[] };

export type TimelineState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly rows: readonly TimelineRow[] };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host's API when the card lives elsewhere; the surface's own connection otherwise. */
export function previewApi(serverId: string | undefined, fallback: PaseoApi): PaseoApi {
  if (serverId === undefined || typeof getPaseoClient !== "function") return fallback;
  try {
    return getPaseoClient(serverId);
  } catch {
    return fallback;
  }
}

/** Busier agents first: the one that is asking something is the one to preview. */
function rank(status: PreviewAgent["status"], pending: number): number {
  if (pending > 0) return 0;
  if (status === "running") return 1;
  if (status === "idle") return 2;
  if (status === "error") return 3;
  if (status === "initializing") return 4;
  return 5;
}

function toPreview(entry: AgentEntry): PreviewAgent {
  return {
    agentId: entry.id,
    title: entry.title ?? null,
    status: entry.status,
    pending: entry.pendingPermissions ?? [],
  };
}

/**
 * The agents a workspace holds, live, newest attention first. The board reads the workspace
 * list rather than the entity store, so it finds each card's agents by workspace id.
 */
export function useWorkspaceAgents(
  serverId: string | undefined,
  workspaceId: string | null,
  fallback: PaseoApi,
): AgentLookup {
  const [state, setState] = useState<AgentLookup>({ status: "loading" });

  useEffect(() => {
    if (workspaceId === null) {
      setState({ status: "empty" });
      return;
    }
    let disposed = false;
    let stop: (() => void) | undefined;
    let release: (() => Promise<void>) | undefined;
    let lastSignature: string | null = null;
    setState({ status: "loading" });

    const publish = (agents: Iterable<AgentEntry>) => {
      const mine: PreviewAgent[] = [];
      for (const agent of agents) {
        if (agent.workspaceId !== workspaceId) continue;
        if (agent.background === true) continue;
        mine.push(toPreview(agent));
      }
      mine.sort((a, b) => rank(a.status, a.pending.length) - rank(b.status, b.pending.length));

      // Every agent on the host sends updates; re-render only when one this preview shows changed.
      // A pending request's id is in the signature, so a new question with the same count still lands.
      const signature = mine
        .map(
          (agent) =>
            `${agent.agentId}\u0000${agent.title ?? ""}\u0000${agent.status}\u0000${agent.pending
              .map((request) => request.id)
              .join(",")}`,
        )
        .join("\u0001");
      if (signature === lastSignature) return;
      lastSignature = signature;
      setState(mine.length === 0 ? { status: "empty" } : { status: "ready", agents: mine });
    };

    previewApi(serverId, fallback)
      .agents.list({ subscribe: {}, page: { limit: 100 } })
      .then(({ entries, subscription }) => {
        if (disposed) {
          void subscription.release().catch(() => undefined);
          return;
        }
        release = () => subscription.release();
        const byId = new Map<string, AgentEntry>();
        for (const entry of entries) byId.set(entry.agent.id, entry.agent);
        publish(byId.values());
        stop = subscription.subscribe({
          snapshot: ({ entries: next }) => {
            byId.clear();
            for (const entry of next) byId.set(entry.agent.id, entry.agent);
            publish(byId.values());
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") byId.set(update.agent.id, update.agent);
            else byId.delete(update.agentId);
            publish(byId.values());
          },
        });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!disposed) setState({ status: "error", message: describe(error) });
      });

    return () => {
      disposed = true;
      stop?.();
      void release?.().catch(() => undefined);
    };
  }, [serverId, workspaceId, fallback]);

  return state;
}

/**
 * One agent's chat, live: its recent history once, then every stream event. A reconnect or a
 * replacement epoch refetches, because live delivery alone may have missed rows.
 */
export function useAgentTimeline(
  serverId: string | undefined,
  agentId: string | null,
  fallback: PaseoApi,
): TimelineState {
  const [state, setState] = useState<TimelineState>({ status: "loading" });

  useEffect(() => {
    if (agentId === null) {
      setState({ status: "ready", rows: [] });
      return;
    }
    let disposed = false;
    let subscription: { release(): Promise<void> } | undefined;
    let live = 0;
    setState({ status: "loading" });

    const handle = previewApi(serverId, fallback).agents.ref(agentId);
    const timeline = handle.timeline;
    // A host older than the agent timeline API has nothing to show; say so instead of throwing.
    if (typeof timeline?.subscribe !== "function") {
      setState({ status: "error", message: "This host cannot show agent chat." });
      return;
    }

    const load = () => {
      timeline
        .refetch({ direction: "tail", limit: 60 })
        .then((page) => {
          if (disposed) return;
          setState({ status: "ready", rows: rowsFromEntries(page.entries) });
          return undefined;
        })
        .catch((error: unknown) => {
          if (!disposed) setState({ status: "error", message: describe(error) });
        });
    };

    subscription = timeline.subscribe((event) => {
      if (disposed) return;
      if (event.event.type === "replacement" || event.event.type === "subscription_restored") {
        load();
        return;
      }
      if (event.event.type === "error") {
        setState({ status: "error", message: event.event.error });
        return;
      }
      const stream = event.event;
      if (stream.type !== "timeline") return;
      const item: AgentTimelineItem = stream.item;
      live += 1;
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", rows: appendLiveItem(current.rows, item, `live:${live}`) }
          : current,
      );
    });
    load();

    return () => {
      disposed = true;
      void subscription?.release().catch(() => undefined);
    };
  }, [serverId, agentId, fallback]);

  return state;
}

/** Sends a prompt into the agent the preview shows. */
export async function sendPrompt(api: PaseoApi, agentId: string, text: string): Promise<void> {
  await api.agents.ref(agentId).send(text);
}

/** Closes a pending permission or question request on the agent. */
export async function respond(
  api: PaseoApi,
  agentId: string,
  requestId: string,
  response: AgentPermissionResponse,
): Promise<void> {
  await api.agents.ref(agentId).respondToPermission({ requestId, response });
}

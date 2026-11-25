import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
} from "@getpaseo/protocol/agent-types";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import {
  appendLiveItem,
  rowsFromEntries,
  subagentFromItem,
  type SubagentRow,
  type TimelineRow,
} from "./timeline-model";

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
  | {
      readonly status: "ready";
      readonly rows: readonly TimelineRow[];
      readonly subagents: readonly SubagentRow[];
    };

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
 * replacement epoch refetches, because live delivery alone may have missed rows. Subagents the
 * agent delegates to come from both the timeline's Task calls and the host's subagent session
 * events, because a host may report one and not the other.
 */
export function useAgentTimeline(
  serverId: string | undefined,
  agentId: string | null,
  fallback: PaseoApi,
): TimelineState {
  const [state, setState] = useState<TimelineState>({ status: "loading" });

  useEffect(() => {
    if (agentId === null) {
      setState({ status: "ready", rows: [], subagents: [] });
      return;
    }
    let disposed = false;
    let subscription: { release(): Promise<void> } | undefined;
    let observation: ReturnType<PaseoApi["observeEvents"]> | undefined;
    let live = 0;
    let loaded = false;
    let rows: readonly TimelineRow[] = [];
    const subagents = new Map<string, SubagentRow>();
    // A host may key a session by its own id while the timeline names the tool call.
    const providerKeys = new Map<string, string>();
    // A Task call reports completed as soon as an async subagent launches; the host's state wins.
    const providerManaged = new Set<string>();
    setState({ status: "loading" });

    const api = previewApi(serverId, fallback);
    const handle = api.agents.ref(agentId);
    const timeline = handle.timeline;
    // A host older than the agent timeline API has nothing to show; say so instead of throwing.
    if (typeof timeline?.subscribe !== "function") {
      setState({ status: "error", message: "This host cannot show agent chat." });
      return;
    }

    const publish = () => {
      if (disposed) return;
      // Running subagents first: the ones doing work now are the ones to watch.
      const ordered = [...subagents.values()].sort(
        (a, b) => Number(b.state === "running") - Number(a.state === "running"),
      );
      setState({ status: "ready", rows, subagents: ordered });
    };

    const rememberFromTimeline = (subagent: SubagentRow) => {
      if (!providerManaged.has(subagent.id)) subagents.set(subagent.id, subagent);
    };

    const load = () => {
      timeline
        .refetch({ direction: "tail", limit: 60 })
        .then((page) => {
          if (disposed) return;
          rows = rowsFromEntries(page.entries);
          for (const entry of page.entries) {
            const subagent = subagentFromItem(entry.item);
            if (subagent !== null) rememberFromTimeline(subagent);
          }
          loaded = true;
          publish();
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
      // Without a provider message id, its turn keeps the chunk from merging into an older reply.
      const item: AgentTimelineItem =
        stream.item.type === "assistant_message" &&
        stream.item.messageId === undefined &&
        stream.turnId !== undefined
          ? { ...stream.item, messageId: `turn:${stream.turnId}` }
          : stream.item;
      live += 1;
      rows = appendLiveItem(rows, item, `live:${live}`);
      const subagent = subagentFromItem(item);
      if (subagent !== null) rememberFromTimeline(subagent);
      if (loaded) publish();
    });

    // Session events carry status the timeline only shows while the Task call is running.
    try {
      observation = api.observeEvents(["agent.provider_subagents.update"], {});
      observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (disposed || message.type !== "agent.provider_subagents.update") return;
          const payload = message.payload;
          if (payload.kind === "upsert") {
            const subagent = payload.subagent;
            if (subagent.parentAgentId !== agentId) return;
            const key =
              providerKeys.get(subagent.id) ?? subagent.toolCallId ?? subagent.id;
            providerKeys.set(subagent.id, key);
            providerManaged.add(key);
            subagents.set(key, {
              id: key,
              label: subagent.title ?? subagent.description ?? "Subagent",
              state: subagent.status,
            });
          } else if (payload.kind === "remove") {
            if (payload.parentAgentId !== agentId) return;
            const key = providerKeys.get(payload.subagentId) ?? payload.subagentId;
            providerKeys.delete(payload.subagentId);
            providerManaged.delete(key);
            subagents.delete(key);
          } else {
            return;
          }
          if (loaded) publish();
        },
        error: () => undefined,
      });
      void observation.ready.catch(() => undefined);
    } catch {
      // A host without subagent events still shows the timeline's own Task calls.
      observation = undefined;
    }

    load();

    return () => {
      disposed = true;
      void subscription?.release().catch(() => undefined);
      void observation?.release().catch(() => undefined);
    };
  }, [serverId, agentId, fallback]);

  return state;
}

/** One image a reply carries, as `send` takes it. */
export interface ReplyImage {
  readonly data: string;
  readonly mimeType: string;
}

/**
 * Sends a prompt into the agent the preview shows. Images pasted into the reply box ride with
 * it; `send` takes them as base64 bytes and hands them to the provider.
 */
export async function sendPrompt(
  api: PaseoApi,
  agentId: string,
  text: string,
  images: readonly ReplyImage[] = [],
): Promise<void> {
  await api.agents.ref(agentId).send(text, images.length === 0 ? undefined : { images: [...images] });
}

/** Archives the workspace the preview shows, closing it off the board. */
export async function archiveWorkspace(api: PaseoApi, workspaceId: string): Promise<void> {
  const result = await api.workspaces.ref(workspaceId).archive();
  if (result.error) throw new Error(result.error);
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

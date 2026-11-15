import { getPaseoClient, useHosts, usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import type { BoardCard } from "./board-model";

/**
 * A workspace as the board needs it. The plugin screen host provides no entity-state context,
 * so the board reads the SDK's workspace list instead of `useWorkspaces`; this is its row shape.
 */
export interface BoardWorkspaceCard extends BoardCard {
  readonly id: string;
  /** Unique across hosts: two daemons can hand out the same workspace id. */
  readonly key: string;
  /** The daemon this workspace lives on; `openWorkspace` and Park need it to pick the host. */
  readonly serverId: string;
  readonly hostLabel: string;
  readonly title: string | null;
  readonly name: string;
  readonly projectDisplayName: string;
  /** Set when an agent created this workspace from another workspace. */
  readonly parentWorkspaceId: string | null;
}

export type BoardData =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly workspaces: readonly BoardWorkspaceCard[];
      /** Every host the board is merging, online or not. */
      readonly hostCount: number;
      /** Labels of hosts whose workspaces are missing: offline, or their list failed to load. */
      readonly unavailable: readonly string[];
    };

type Api = ReturnType<typeof usePaseo>;
type Descriptor = Awaited<ReturnType<Api["workspaces"]["list"]>>["entries"][number];

interface HostSource {
  readonly serverId: string;
  readonly label: string;
  readonly online: boolean;
}

type HostState =
  | { readonly state: "pending" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly cards: readonly BoardWorkspaceCard[] };

function toCard(source: HostSource, workspace: Descriptor): BoardWorkspaceCard {
  return {
    id: workspace.id,
    key: `${source.serverId}:${workspace.id}`,
    serverId: source.serverId,
    hostLabel: source.label,
    title: workspace.title ?? null,
    name: workspace.name,
    projectDisplayName: workspace.projectDisplayName,
    parentWorkspaceId: workspace.parentWorkspaceId ?? null,
    // The daemon's `status` uses the same five values the board classifies on.
    indicator: workspace.status,
    labels: workspace.labels ?? [],
    background: workspace.background ?? false,
    archivingAt: workspace.archivingAt ?? null,
    statusEnteredAt: workspace.statusEnteredAt,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One host's live workspace list: one subscription, no polling. Returns its disposer. */
function subscribeHost(
  source: HostSource,
  api: Api,
  publish: (state: HostState) => void,
): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  const byId = new Map<string, BoardWorkspaceCard>();
  const emit = () => publish({ state: "ready", cards: [...byId.values()] });

  api.workspaces
    .list({ subscribe: {}, page: { limit: 200 } })
    .then(({ subscription }) => {
      if (disposed) {
        void subscription.release().catch(() => undefined);
        return;
      }
      release = () => subscription.release();
      stop = subscription.subscribe({
        snapshot: ({ entries }) => {
          byId.clear();
          for (const entry of entries) byId.set(entry.id, toCard(source, entry));
          emit();
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") byId.set(update.workspace.id, toCard(source, update.workspace));
          else byId.delete(update.id);
          emit();
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!disposed) publish({ state: "error", message: describeError(error) });
    });

  return () => {
    disposed = true;
    stop?.();
    void release?.().catch(() => undefined);
  };
}

// Older apps do not hand plugins the host list; the board then falls back to the current host.
const HAS_HOST_LIST = typeof useHosts === "function" && typeof getPaseoClient === "function";
const NO_HOSTS: readonly never[] = [];
const useConfiguredHosts = HAS_HOST_LIST ? useHosts : () => NO_HOSTS;

/**
 * Live list of every configured host's workspaces merged into one, plus which hosts are missing.
 * `current` is the host the surface is opened on: the fallback when the app lists no hosts.
 */
export function useBoardWorkspaces(current: { id: string; label: string }): BoardData {
  const paseo = usePaseo();
  const hosts = useConfiguredHosts();
  const [byHost, setByHost] = useState<ReadonlyMap<string, HostState>>(new Map());

  const sources = useMemo<readonly HostSource[]>(
    () =>
      HAS_HOST_LIST && hosts.length > 0
        ? hosts.map((host) => ({
            serverId: host.serverId,
            label: host.label,
            online: host.status === "online",
          }))
        : [{ serverId: current.id, label: current.label, online: true }],
    [hosts, current.id, current.label],
  );
  // Effects re-run on what changes the subscriptions, not on every host-list object.
  const signature = sources
    .map((source) => `${source.serverId}\u0000${source.label}\u0000${source.online}`)
    .join("\u0001");

  useEffect(() => {
    const live = sources.filter((source) => source.online);
    const next = new Map<string, HostState>(live.map((source) => [source.serverId, { state: "pending" }]));
    setByHost(next);
    const stops = live.map((source) => {
      const api = HAS_HOST_LIST && hosts.length > 0 ? getPaseoClient(source.serverId) : paseo;
      return subscribeHost(source, api as Api, (state) => {
        next.set(source.serverId, state);
        setByHost(new Map(next));
      });
    });
    return () => {
      for (const stop of stops) stop();
    };
    // `sources` and `hosts` are captured through `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, paseo]);

  return useMemo<BoardData>(() => {
    const live = sources.filter((source) => source.online);
    const states = live.map((source) => byHost.get(source.serverId) ?? { state: "pending" as const });
    const ready = states.some((state) => state.state === "ready");
    const pending = states.some((state) => state.state === "pending");
    // Wait for the first host to answer rather than flashing an empty board.
    if (!ready && pending) return { status: "loading" };
    const errors = states.filter((state) => state.state === "error");
    if (!ready && errors.length > 0) {
      return { status: "error", message: errors[0]?.state === "error" ? errors[0].message : "" };
    }
    const workspaces: BoardWorkspaceCard[] = [];
    const unavailable: string[] = [];
    for (const source of sources) {
      const state = source.online ? byHost.get(source.serverId) : undefined;
      if (state?.state === "ready") workspaces.push(...state.cards);
      else unavailable.push(source.label);
    }
    return { status: "ready", workspaces, hostCount: sources.length, unavailable };
  }, [sources, byHost]);
}

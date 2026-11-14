import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import type { BoardCard } from "./board-model";

/**
 * A workspace as the board needs it. The plugin screen host provides no entity-state context,
 * so the screen reads the SDK's workspace list instead of `useWorkspaces`; this is its row shape.
 */
export interface BoardWorkspaceCard extends BoardCard {
  readonly id: string;
  readonly title: string | null;
  readonly name: string;
  readonly projectDisplayName: string;
  /** Set when an agent created this workspace from another workspace. */
  readonly parentWorkspaceId: string | null;
}

export type BoardData =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly workspaces: readonly BoardWorkspaceCard[] };

type Descriptor = Awaited<
  ReturnType<ReturnType<typeof usePaseo>["workspaces"]["list"]>
>["entries"][number];

function toCard(workspace: Descriptor): BoardWorkspaceCard {
  return {
    id: workspace.id,
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

/** Live list of the selected host's workspaces: one subscription, no polling. */
export function useBoardWorkspaces(): BoardData {
  const paseo = usePaseo();
  const [data, setData] = useState<BoardData>({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    let release: (() => Promise<void>) | undefined;
    const byId = new Map<string, BoardWorkspaceCard>();
    const publish = () => setData({ status: "ready", workspaces: [...byId.values()] });

    setData({ status: "loading" });
    paseo.workspaces
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
            for (const entry of entries) byId.set(entry.id, toCard(entry));
            publish();
          },
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            if (update.kind === "upsert") byId.set(update.workspace.id, toCard(update.workspace));
            else byId.delete(update.id);
            publish();
          },
        });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!disposed) setData({ status: "error", message: describeError(error) });
      });

    return () => {
      disposed = true;
      stop?.();
      void release?.().catch(() => undefined);
    };
  }, [paseo]);

  return data;
}

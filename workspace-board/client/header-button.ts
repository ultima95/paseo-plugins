import type { PluginClientContext } from "@getpaseo/plugin/client";

/**
 * A header button for the board, on every open workspace.
 *
 * The sidebar row is the board's usual way in, but it lives in the sidebar, so closing the
 * sidebar hides the only way back. Header buttons are per workspace, so this keeps one for
 * each open workspace on the host and drops it when that workspace closes.
 */

/** What this module reads from a workspace on the host's list. */
interface WorkspaceRow {
  readonly id: string;
  readonly background?: boolean | null;
}

/** Header button ids must be lowercase letters, numbers, and hyphens, starting with a letter. */
export function boardButtonId(workspaceId: string): string {
  const safe = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `board-${safe}`;
}

/** The workspaces that carry a button: every open one, not a background workspace. */
export function buttonWorkspaces(rows: readonly WorkspaceRow[]): string[] {
  return rows.filter((row) => row.background !== true).map((row) => row.id);
}

export function registerBoardHeaderButtons(client: PluginClientContext): () => void {
  // An older app has no header buttons at all; the sidebar row still works there.
  if (typeof client.addHeaderButton !== "function") return () => undefined;

  let disposed = false;
  let stop: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  const buttons = new Map<string, { remove(): void }>();

  const sync = (workspaces: readonly WorkspaceRow[]) => {
    if (disposed) return;
    const wanted = new Set(buttonWorkspaces(workspaces));
    for (const [workspaceId, button] of buttons) {
      if (wanted.has(workspaceId)) continue;
      button.remove();
      buttons.delete(workspaceId);
    }
    for (const workspaceId of wanted) {
      if (buttons.has(workspaceId)) continue;
      try {
        buttons.set(
          workspaceId,
          client.addHeaderButton({
            id: boardButtonId(workspaceId),
            workspaceId,
            button: {
              title: "Workspace board",
              icon: "LayoutGrid",
              behavior: {
                kind: "action",
                onPress: () => client.openScreen({ screenId: "board" }),
              },
            },
          }),
        );
      } catch {
        // A host that refuses this workspace's button must not stop the others.
      }
    }
  };

  const byId = new Map<string, WorkspaceRow>();
  const republish = () => sync([...byId.values()]);

  client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ entries, subscription }) => {
      if (disposed) {
        void subscription.release().catch(() => undefined);
        return;
      }
      release = () => subscription.release();
      for (const entry of entries) byId.set(entry.id, entry);
      sync(entries);
      stop = subscription.subscribe({
        snapshot: ({ entries: next }) => {
          byId.clear();
          for (const entry of next) byId.set(entry.id, entry);
          republish();
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") byId.set(update.workspace.id, update.workspace);
          else byId.delete(update.id);
          republish();
        },
      });
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    stop?.();
    for (const button of buttons.values()) button.remove();
    buttons.clear();
    void release?.().catch(() => undefined);
  };
}

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

/** How many times a host that was not reachable at load is asked again before giving up. */
const LIST_ATTEMPTS = 3;
const LIST_RETRY_MS = 2_000;

export function registerBoardHeaderButtons(client: PluginClientContext): () => void {
  // An older app has no header buttons at all, and an older one has no paseo handle; the
  // sidebar row still works on both.
  if (typeof client.addHeaderButton !== "function") return () => undefined;
  const actions = client.paseo?.workspaces;
  if (typeof actions?.list !== "function") return () => undefined;

  let disposed = false;
  let stop: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  let retry: ReturnType<typeof setTimeout> | null = null;
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

  // The app can load a plugin before its daemon is reachable. Asking again keeps the buttons
  // from staying missing until the plugin is reloaded by hand.
  let attempt = 0;
  const start = () => {
    if (disposed) return;
    attempt += 1;
    actions
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
      .catch(() => {
        if (disposed || attempt >= LIST_ATTEMPTS) return;
        retry = setTimeout(start, LIST_RETRY_MS);
      });
  };
  start();

  return () => {
    disposed = true;
    if (retry !== null) clearTimeout(retry);
    stop?.();
    for (const button of buttons.values()) button.remove();
    buttons.clear();
    void release?.().catch(() => undefined);
  };
}

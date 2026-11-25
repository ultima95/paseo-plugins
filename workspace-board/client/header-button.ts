import type { PluginClientContext } from "@getpaseo/plugin/client";
import { classify, isChildWorkspace, isOnBoard, type BoardWorkspace } from "./board-model";

/**
 * A header pill for the board, on every open workspace.
 *
 * The sidebar row is the board's usual way in, but it lives in the sidebar, so closing the
 * sidebar hides the only way back. Header buttons are per workspace, so this keeps one for
 * each open workspace on the host, drops it when that workspace closes, and keeps its label
 * showing how many workspaces still need the user or are running.
 */

/** What this module reads from a workspace on the host's list. */
interface WorkspaceRow {
  readonly id: string;
  readonly background?: boolean | null;
  readonly status?: BoardWorkspace["indicator"] | null;
  readonly labels?: readonly string[] | null;
  readonly archivingAt?: string | null;
  readonly parentWorkspaceId?: string | null;
}

/** Header button ids must be lowercase letters, numbers, and hyphens, starting with a letter. */
export function boardButtonId(workspaceId: string): string {
  const safe = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `board-${safe}`;
}

/** The workspaces that carry a pill: every open one, not a background workspace. */
export function buttonWorkspaces(rows: readonly WorkspaceRow[]): string[] {
  return rows.filter((row) => row.background !== true).map((row) => row.id);
}

/** What the pill says: the board's two attention columns, plus the ones still working. */
export interface BoardPillCounts {
  readonly needYou: number;
  readonly running: number;
}

/**
 * The counts the pill shows, over every open workspace on the host. They follow the board's
 * own classification, so the pill and the sidebar never disagree about what needs the user.
 */
export function pillCounts(rows: readonly WorkspaceRow[]): BoardPillCounts {
  let needYou = 0;
  let running = 0;
  for (const row of rows) {
    // The board never draws a child workspace, so counting one here would promise a card
    // the reader cannot find.
    if (isChildWorkspace({ parentWorkspaceId: row.parentWorkspaceId ?? null })) continue;
    const workspace = {
      indicator: row.status ?? "done",
      labels: row.labels ?? [],
      background: row.background === true,
      archivingAt: row.archivingAt ?? null,
    };
    if (!isOnBoard(workspace)) continue;
    const column = classify(workspace);
    if (column === "needs-you" || column === "review") needYou += 1;
    else if (column === "running") running += 1;
  }
  return { needYou, running };
}

/** The pill's text, or undefined to leave it an icon when nothing is happening. */
export function pillLabel(counts: BoardPillCounts): string | undefined {
  const needs = counts.needYou === 1 ? "1 needs you" : `${counts.needYou} need you`;
  const runs = counts.running === 1 ? "1 running" : `${counts.running} running`;
  if (counts.needYou > 0 && counts.running > 0) return `${needs} · ${runs}`;
  if (counts.needYou > 0) return needs;
  if (counts.running > 0) return runs;
  return undefined;
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
  const buttons = new Map<string, ReturnType<PluginClientContext["addHeaderButton"]>>();
  // The last text handed to the host, so an unrelated workspace update does not re-render
  // every pill for a label that did not move.
  let shownLabel: string | undefined;

  const sync = (workspaces: readonly WorkspaceRow[]) => {
    if (disposed) return;
    // One label for every pill on this host: the counts span all open workspaces, the same
    // numbers the sidebar row carries.
    const label = pillLabel(pillCounts(workspaces));
    const labelChanged = label !== shownLabel;
    shownLabel = label;
    const title = label === undefined ? "Workspace board" : `Workspace board · ${label}`;
    const wanted = new Set(buttonWorkspaces(workspaces));
    for (const [workspaceId, button] of buttons) {
      if (wanted.has(workspaceId)) continue;
      button.remove();
      buttons.delete(workspaceId);
    }
    for (const workspaceId of wanted) {
      const existing = buttons.get(workspaceId);
      if (existing !== undefined) {
        if (labelChanged) existing.update({ label, title });
        continue;
      }
      try {
        buttons.set(
          workspaceId,
          client.addHeaderButton({
            id: boardButtonId(workspaceId),
            workspaceId,
            button: {
              title,
              label,
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

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { classify, isChildWorkspace, isOnBoard, type BoardWorkspace } from "./board-model";

/**
 * The board's status pills in the workspace header.
 *
 * The sidebar row is the board's usual way in, but it lives in the sidebar, so closing the
 * sidebar hides the only way back. Header buttons are per workspace, so this keeps three per
 * open workspace on the host: one pill for the workspaces that need the user, one for the ones
 * still running, and a plain board button while both counts are zero. Every one opens the board.
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

/** What the pills show: the board's two attention columns, plus the ones still working. */
export interface BoardPillCounts {
  readonly needYou: number;
  readonly running: number;
}

/** One pill a workspace header carries. */
export interface PillSpec {
  readonly kind: "need" | "run" | "board";
  readonly icon: string;
  readonly label: string | undefined;
  readonly visible: boolean;
  readonly title: string;
}

/** Header button ids must be lowercase letters, numbers, and hyphens, starting with a letter. */
export function boardButtonId(workspaceId: string, kind: PillSpec["kind"]): string {
  const safe = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `board-${kind}-${safe}`;
}

/** The workspaces that carry pills: every open one, not a background workspace. */
export function buttonWorkspaces(rows: readonly WorkspaceRow[]): string[] {
  return rows.filter((row) => row.background !== true).map((row) => row.id);
}

/**
 * The counts the pills show, over every open workspace on the host. They follow the board's
 * own classification, so the pills and the sidebar never disagree about what needs the user.
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

function countTitle(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * The pills a header carries. A count pill shows its number and hides at zero; when both
 * counts are zero the plain board button takes their place, so the board is always reachable.
 */
export function pillSpecs(counts: BoardPillCounts): readonly PillSpec[] {
  const needTitle = countTitle(counts.needYou, "workspace needs you", "workspaces need you");
  const runTitle = countTitle(counts.running, "workspace is running", "workspaces are running");
  const quiet = counts.needYou === 0 && counts.running === 0;
  return [
    {
      kind: "need",
      icon: "AlertCircle",
      label: counts.needYou === 0 ? undefined : `${counts.needYou}`,
      visible: counts.needYou > 0,
      title: `Workspace board · ${needTitle}`,
    },
    {
      kind: "run",
      icon: "Play",
      label: counts.running === 0 ? undefined : `${counts.running}`,
      visible: counts.running > 0,
      title: `Workspace board · ${runTitle}`,
    },
    {
      kind: "board",
      icon: "LayoutGrid",
      label: undefined,
      visible: quiet,
      title: "Workspace board",
    },
  ];
}

/** How many times a host that was not reachable at load is asked again before giving up. */
const LIST_ATTEMPTS = 3;
const LIST_RETRY_MS = 2_000;

interface LiveButton {
  readonly registration: ReturnType<PluginClientContext["addHeaderButton"]>;
  readonly workspaceId: string;
  spec: PillSpec;
}

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
  const buttons = new Map<string, LiveButton>();

  const sync = (workspaces: readonly WorkspaceRow[]) => {
    if (disposed) return;
    const specs = pillSpecs(pillCounts(workspaces));
    const wanted = new Set(buttonWorkspaces(workspaces));
    for (const [id, live] of buttons) {
      if (wanted.has(live.workspaceId)) continue;
      live.registration.remove();
      buttons.delete(id);
    }
    for (const workspaceId of wanted) {
      for (const spec of specs) {
        const id = boardButtonId(workspaceId, spec.kind);
        const existing = buttons.get(id);
        if (existing !== undefined) {
          // Only touch the host when this pill's own text or visibility moved.
          if (!sameSpec(existing.spec, spec)) {
            existing.registration.update({
              label: spec.label,
              visible: spec.visible,
              title: spec.title,
            });
            existing.spec = spec;
          }
          continue;
        }
        try {
          const registration = client.addHeaderButton({
            id,
            workspaceId,
            button: {
              title: spec.title,
              label: spec.label,
              icon: spec.icon,
              visible: spec.visible,
              behavior: {
                kind: "action",
                onPress: () => client.openScreen({ screenId: "board" }),
              },
            },
          });
          buttons.set(id, { registration, workspaceId, spec });
        } catch {
          // A host that refuses this workspace's pill must not stop the others.
        }
      }
    }
  };

  const byId = new Map<string, WorkspaceRow>();
  const republish = () => sync([...byId.values()]);

  // The app can load a plugin before its daemon is reachable. Asking again keeps the pills
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
    for (const live of buttons.values()) live.registration.remove();
    buttons.clear();
    void release?.().catch(() => undefined);
  };
}

function sameSpec(left: PillSpec, right: PillSpec): boolean {
  return left.label === right.label && left.visible === right.visible && left.title === right.title;
}

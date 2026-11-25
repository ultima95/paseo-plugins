import { classify, isChildWorkspace, isOnBoard, type BoardWorkspace } from "./board-model";

/**
 * The numbers behind the board's header pills, kept free of React so they stay testable.
 *
 * The pills follow the board's own classification and carry the board's own column icons, so
 * a header badge never disagrees with the column it stands for.
 */

/** What this module reads from a workspace on the host's list. */
export interface PillWorkspace {
  readonly id: string;
  readonly background?: boolean | null;
  readonly status?: BoardWorkspace["indicator"] | null;
  readonly labels?: readonly string[] | null;
  readonly archivingAt?: string | null;
  readonly parentWorkspaceId?: string | null;
}

/** The board's four working columns, split the way the sidebar splits them. */
export interface BoardPillCounts {
  readonly blocked: number;
  readonly review: number;
  readonly running: number;
  readonly finished: number;
}

/** The columns a count pill can stand for; `board` is the plain button. */
export type PillKind = "blocked" | "review" | "run" | "done" | "board";

/** One pill a workspace header carries. */
export interface PillSpec {
  readonly kind: PillKind;
  readonly count: number;
  /** The number the host draws beside the badge; undefined for the plain board button. */
  readonly label: string | undefined;
  readonly visible: boolean;
  readonly title: string;
}

/** The board's own column glyphs, so the header and the board read the same. */
export const PILL_ICON: Record<Exclude<PillKind, "board">, string> = {
  blocked: "AlertCircle",
  review: "Eye",
  run: "Play",
  done: "Pause",
};

/** Header button ids must be lowercase letters, numbers, and hyphens, starting with a letter. */
export function boardButtonId(workspaceId: string, kind: PillKind): string {
  const safe = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `board-${kind}-${safe}`;
}

/** The workspaces that carry pills: every open one, not a background workspace. */
export function buttonWorkspaces(rows: readonly PillWorkspace[]): string[] {
  return rows.filter((row) => row.background !== true).map((row) => row.id);
}

/**
 * The counts over every open workspace of every host. A workspace the board never draws, a
 * child or a background one, is left out, so a pill cannot promise a card that is missing.
 */
export function pillCounts(rows: readonly PillWorkspace[]): BoardPillCounts {
  let blocked = 0;
  let review = 0;
  let running = 0;
  let finished = 0;
  for (const row of rows) {
    if (isChildWorkspace({ parentWorkspaceId: row.parentWorkspaceId ?? null })) continue;
    const workspace = {
      indicator: row.status ?? "done",
      labels: row.labels ?? [],
      background: row.background === true,
      archivingAt: row.archivingAt ?? null,
    };
    if (!isOnBoard(workspace)) continue;
    const column = classify(workspace);
    if (column === "needs-you") blocked += 1;
    else if (column === "review") review += 1;
    else if (column === "running") running += 1;
    else if (column === "idle") finished += 1;
  }
  return { blocked, review, running, finished };
}

function countTitle(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function countLabel(count: number): string | undefined {
  return count === 0 ? undefined : `${count}`;
}

function countPill(
  kind: Exclude<PillKind, "board">,
  count: number,
  one: string,
  many: string,
): PillSpec {
  return {
    kind,
    count,
    label: countLabel(count),
    visible: count > 0,
    title: `Workspace board · ${countTitle(count, one, many)}`,
  };
}

/**
 * The pills a header carries. A count pill hides at zero; when every count is zero the plain
 * board button takes their place, so the board is always one press away.
 */
export function pillSpecs(counts: BoardPillCounts): readonly PillSpec[] {
  const quiet =
    counts.blocked === 0 && counts.review === 0 && counts.running === 0 && counts.finished === 0;
  return [
    countPill("blocked", counts.blocked, "workspace needs input", "workspaces need input"),
    countPill("review", counts.review, "workspace to review", "workspaces to review"),
    countPill("run", counts.running, "workspace is running", "workspaces are running"),
    countPill("done", counts.finished, "workspace finished", "workspaces finished"),
    {
      kind: "board",
      count: 0,
      label: undefined,
      visible: quiet,
      title: "Workspace board",
    },
  ];
}

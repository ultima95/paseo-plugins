import { classify, isChildWorkspace, isOnBoard, type BoardWorkspace } from "./board-model";

/**
 * The numbers behind the board's header pills, kept free of React so they stay testable.
 *
 * The pills follow the board's own classification, so they never disagree with the board or
 * the sidebar row about what needs the user.
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

/** What the pills show: the board's three working columns. */
export interface BoardPillCounts {
  readonly needYou: number;
  readonly running: number;
  readonly finished: number;
}

/** One pill a workspace header carries. `count` is zero for the plain board button. */
export interface PillSpec {
  readonly kind: "need" | "run" | "done" | "board";
  readonly count: number;
  /** The number the host draws beside the badge; undefined for the plain board button. */
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
export function buttonWorkspaces(rows: readonly PillWorkspace[]): string[] {
  return rows.filter((row) => row.background !== true).map((row) => row.id);
}

/**
 * The counts over every open workspace of every host. A workspace the board never draws, a
 * child or a background one, is left out, so a pill cannot promise a card that is missing.
 */
export function pillCounts(rows: readonly PillWorkspace[]): BoardPillCounts {
  let needYou = 0;
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
    if (column === "needs-you" || column === "review") needYou += 1;
    else if (column === "running") running += 1;
    else if (column === "idle") finished += 1;
  }
  return { needYou, running, finished };
}

function countTitle(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * The pills a header carries. A count pill hides at zero; when every count is zero the plain
 * board button takes their place, so the board is always one press away.
 */
export function pillSpecs(counts: BoardPillCounts): readonly PillSpec[] {
  const needTitle = countTitle(counts.needYou, "workspace needs you", "workspaces need you");
  const runTitle = countTitle(counts.running, "workspace is running", "workspaces are running");
  const doneTitle = countTitle(
    counts.finished,
    "workspace finished",
    "workspaces finished",
  );
  const quiet = counts.needYou === 0 && counts.running === 0 && counts.finished === 0;
  return [
    {
      kind: "need",
      count: counts.needYou,
      label: counts.needYou === 0 ? undefined : `${counts.needYou}`,
      visible: counts.needYou > 0,
      title: `Workspace board · ${needTitle}`,
    },
    {
      kind: "run",
      count: counts.running,
      label: counts.running === 0 ? undefined : `${counts.running}`,
      visible: counts.running > 0,
      title: `Workspace board · ${runTitle}`,
    },
    {
      kind: "done",
      count: counts.finished,
      label: counts.finished === 0 ? undefined : `${counts.finished}`,
      visible: counts.finished > 0,
      title: `Workspace board · ${doneTitle}`,
    },
    {
      kind: "board",
      count: 0,
      label: undefined,
      visible: quiet,
      title: "Workspace board",
    },
  ];
}

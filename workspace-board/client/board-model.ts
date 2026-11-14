import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";

export const PARKED_LABEL = "Parked";

export type ColumnId = "needs-you" | "running" | "review" | "idle" | "parked";

export const COLUMNS: readonly { readonly id: ColumnId; readonly title: string }[] = [
  { id: "needs-you", title: "Needs you" },
  { id: "running", title: "Running" },
  { id: "review", title: "Review" },
  { id: "idle", title: "Idle" },
  { id: "parked", title: "Parked" },
];

export type BoardWorkspace = Pick<
  PluginWorkspaceSnapshot,
  "indicator" | "labels" | "background" | "archivingAt"
>;

export function isOnBoard(ws: BoardWorkspace): boolean {
  return !ws.background && ws.archivingAt === null;
}

export function classify(ws: Pick<BoardWorkspace, "indicator" | "labels">): ColumnId {
  if (ws.indicator === "needs_input" || ws.indicator === "failed") return "needs-you";
  if (ws.indicator === "attention") return "review";
  const parked = PARKED_LABEL.toLowerCase();
  if (ws.labels.some((label) => label.toLowerCase() === parked)) return "parked";
  return ws.indicator === "running" ? "running" : "idle";
}

export function needsYou(ws: BoardWorkspace): boolean {
  if (!isOnBoard(ws)) return false;
  const column = classify(ws);
  return column === "needs-you" || column === "review";
}

/** True when an agent created this workspace from another one, so it is a child workspace. */
export function isChildWorkspace(ws: { readonly parentWorkspaceId?: string | null }): boolean {
  return (ws.parentWorkspaceId ?? null) !== null;
}

export type BoardCard = BoardWorkspace & { readonly statusEnteredAt: string | null };

/** Epoch ms of a state-entry timestamp; null and unparsable values sort after every real one. */
function enteredMs(card: BoardCard): number {
  if (card.statusEnteredAt === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(card.statusEnteredAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Every board column, always present, holding the on-board workspaces that classify into it,
 * newest state first. Array.prototype.sort is stable, so ties keep their input order.
 */
export function groupBoard<T extends BoardCard>(workspaces: readonly T[]): Record<ColumnId, T[]> {
  const grouped: Record<ColumnId, T[]> = {
    "needs-you": [],
    running: [],
    review: [],
    idle: [],
    parked: [],
  };
  const sorted = workspaces.filter(isOnBoard).sort((a, b) => enteredMs(b) - enteredMs(a));
  for (const card of sorted) grouped[classify(card)].push(card);
  return grouped;
}

/** True when the query (trimmed, any case) appears in the title, name or project of a card. */
export function matchesFilter(
  card: { readonly title: string | null; readonly name: string; readonly projectDisplayName: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [card.title ?? "", card.name, card.projectDisplayName].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

export function formatAge(enteredAt: string | null, now: number): string | null {
  if (enteredAt === null) return null;
  const entered = Date.parse(enteredAt);
  if (Number.isNaN(entered)) return null;
  const seconds = Math.max(0, Math.floor((now - entered) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

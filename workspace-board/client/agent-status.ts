import type { SubagentRow, SubagentState } from "./timeline-model";
import type { PreviewAgent } from "./use-agent-preview";

/**
 * What the preview says beside the agent's name while its turn is still in flight. A preview
 * otherwise only shows the conversation, so an unfinished turn would read as a finished one.
 */
export function busyLabel(status: PreviewAgent["status"] | null): string | null {
  if (status === "running") return "Working";
  if (status === "initializing") return "Starting";
  return null;
}

/** The word a subagent carries next to its name, lowercase so it reads as a status. */
export function subagentStatusLabel(state: SubagentState): string {
  switch (state) {
    case "running":
      return "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

/**
 * The one line that stands in for a whole subagent list: how many there are and how many still
 * work. The preview folds the list behind this line so a busy agent cannot fill the composer.
 */
export function subagentSummary(rows: readonly SubagentRow[]): string | null {
  if (rows.length === 0) return null;
  const running = rows.filter((row) => row.state === "running").length;
  const failed = rows.filter((row) => row.state === "failed").length;
  const parts = [rows.length === 1 ? "1 subagent" : `${rows.length} subagents`];
  if (running > 0) parts.push(`${running} working`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** Which color the folded line takes: the state that most deserves a look. */
export function subagentSummaryTone(rows: readonly SubagentRow[]): "failed" | "running" | "quiet" {
  if (rows.some((row) => row.state === "failed")) return "failed";
  if (rows.some((row) => row.state === "running")) return "running";
  return "quiet";
}

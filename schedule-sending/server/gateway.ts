import type { AgentGateway, AgentState } from "./scheduler";

// Structural slice of the SDK's agent handle. Kept local so the scheduler and handlers
// can be unit-tested without the SDK, and so a real `PaseoApi` is checked against it at compile time.
export interface AgentHandleLike {
  refresh(): Promise<unknown>;
  send(text: string): Promise<unknown>;
  readonly archivedAt: string | null;
  readonly activeTurn: unknown;
  readonly status: string | null;
}

export interface PaseoLike {
  readonly agents: { ref(agentId: string): AgentHandleLike };
}

// Observed in probe P3 (docs/superpowers/notes/2026-09-30-probe-results.md): "Agent not found: <id>".
const NOT_FOUND = /not found|unknown agent|no such agent/i;
const BUSY_STATUSES = new Set(["running", "initializing"]);

export function createPaseoGateway(paseo: PaseoLike): AgentGateway {
  return {
    async inspect(agentId: string): Promise<AgentState> {
      const handle = paseo.agents.ref(agentId);
      let refreshed: unknown;
      try {
        refreshed = await handle.refresh();
      } catch (error) {
        if (error instanceof Error && NOT_FOUND.test(error.message)) return "missing";
        throw error;
      }
      if (refreshed === null || refreshed === undefined) return "missing";
      if (handle.archivedAt) return "archived";
      if (handle.activeTurn || (handle.status !== null && BUSY_STATUSES.has(handle.status))) return "busy";
      return "idle";
    },

    async send(agentId: string, text: string): Promise<void> {
      await paseo.agents.ref(agentId).send(text);
    },
  };
}

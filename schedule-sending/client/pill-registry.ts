import type { PluginButtonRegistration } from "@getpaseo/plugin/client";

export interface PillAgent {
  id: string;
  workspaceId?: string | null;
}

export interface PillRegistry {
  upsert(agent: PillAgent): void;
  remove(agentId: string): void;
  replaceAll(agents: readonly PillAgent[]): void;
  clear(): void;
}

interface Entry {
  workspaceId: string;
  registration: PluginButtonRegistration;
}

// Agent updates arrive on every status, title and usage change. Re-registering a pill unmounts it,
// which would close an open popover and lose the user's draft, so a pill is only replaced when the
// workspace it belongs to changes.
export function createPillRegistry(
  addPill: (agentId: string, workspaceId: string) => PluginButtonRegistration,
): PillRegistry {
  const entries = new Map<string, Entry>();

  function remove(agentId: string): void {
    entries.get(agentId)?.registration.remove();
    entries.delete(agentId);
  }

  function upsert(agent: PillAgent): void {
    const workspaceId = agent.workspaceId;
    if (!workspaceId) return;
    const existing = entries.get(agent.id);
    if (existing?.workspaceId === workspaceId) return;
    remove(agent.id);
    entries.set(agent.id, { workspaceId, registration: addPill(agent.id, workspaceId) });
  }

  return {
    upsert,
    remove,
    replaceAll(agents) {
      const keep = new Set(agents.map((agent) => agent.id));
      for (const agentId of [...entries.keys()]) {
        if (!keep.has(agentId)) remove(agentId);
      }
      for (const agent of agents) upsert(agent);
    },
    clear() {
      for (const agentId of [...entries.keys()]) remove(agentId);
    },
  };
}

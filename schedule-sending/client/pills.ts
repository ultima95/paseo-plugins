import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createPillRegistry } from "./pill-registry";
import { SchedulePopover } from "./schedule-popover";

// The daemon caps a single agents page at 200 (protocol schema). Agents beyond it still get a pill
// when they next emit an update.
const AGENT_PAGE_LIMIT = 200;

// One composer pill per agent, following the agent directory (documented owned-subscription pattern).
export function contributePills(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  let stopped = false;

  const registry = createPillRegistry((agentId, workspaceId) =>
    client.addComposerPill({
      id: "schedule",
      workspaceId,
      agentId,
      button: {
        title: "Schedule a message",
        icon: "Clock",
        label: "Schedule",
        behavior: { kind: "popover", Content: SchedulePopover },
      },
    }),
  );

  void client.paseo.agents
    .list({ subscribe: {}, page: { limit: AGENT_PAGE_LIMIT }, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          if (stopped) return;
          registry.replaceAll(entries.map(({ agent }) => agent));
        },
        update: (message) => {
          if (stopped || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") registry.remove(update.agentId);
          else registry.upsert(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    registry.clear();
  };
}

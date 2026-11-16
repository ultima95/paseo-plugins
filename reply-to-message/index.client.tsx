import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MessageRow } from "./client/message-row";
import {
  MESSAGE_ROW_KIND,
  MESSAGE_ROW_VERSION,
  messageRowSchema,
  rowForReply,
} from "./shared/message-row";

/**
 * Every agent reply becomes a plugin row with Copy and Reply.
 *
 * Only replies are replaced; a message the user sent keeps Paseo's own row. A transformer
 * receives only a message's text, and the daemon drops image blocks before the item reaches
 * a plugin, so a plugin row could never draw an image attached to one of your messages.
 * Leaving user rows to Paseo is what keeps those images, plus the rewind menu and Paseo's
 * own Copy, on your messages.
 *
 * Two consequences of replacing replies, both deliberate:
 *
 * - The completed-turn footer Paseo hangs off a finished reply (copy turn, fork, usage) is
 *   gone, because it is resolved from the original assistant row. Copy per reply is
 *   provided here instead; fork is not reachable from a plugin.
 * - Paseo folds a finished turn behind its user message only when that row is a user or
 *   tool row. User rows stay Paseo's, so folding still works exactly as it does without
 *   this plugin.
 *
 * `rowForReply` decides which replies are replaced; see its own note.
 */
export default function contribute(client: PluginClientContext) {
  const disposers = [
    client.addTimelineTransformer({
      id: "assistant-message",
      query: { itemType: "assistant_message" },
      transform: ({ item, phase }) => {
        const data = rowForReply(item.text, phase);
        if (data === null) return undefined;
        return {
          items: [
            {
              type: "plugin" as const,
              kind: MESSAGE_ROW_KIND,
              version: MESSAGE_ROW_VERSION,
              data,
            },
          ],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: MESSAGE_ROW_KIND,
      version: MESSAGE_ROW_VERSION,
      schema: messageRowSchema,
      Component: MessageRow,
    }),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}

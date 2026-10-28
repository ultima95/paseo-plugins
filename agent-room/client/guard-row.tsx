import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { z } from "zod";

import { paddingFor } from "./seat-editor";

/**
 * The row Task 5 appends to a violator's parent when the guard archives an
 * unmarked or wrongly marked child:
 * `{ type: "plugin", id: "room-guard-<childId>", kind: "room-guard", version: 1,
 *    data: { childId, childTitle, violatorId, rule } }`.
 *
 * The schema is the data shape, so a row written by another version of the
 * plugin is shown only while it still parses.
 */
export interface GuardRowData {
  childId: string;
  childTitle: string;
  violatorId: string;
  rule: string;
}

/**
 * The data shape, stated once as a type and once as a schema so the renderer
 * cannot accept a row it could not draw. The annotation is what pins the two
 * together: a field added to one and not the other stops the typecheck.
 */
export const guardRowSchema: z.ZodType<GuardRowData> = z.object({
  childId: z.string(),
  childTitle: z.string(),
  violatorId: z.string(),
  rule: z.string(),
});

/**
 * A refused spawn, in the timeline of the agent that broke the rule.
 *
 * It is styled in the warning tone because it is not an error the reader can
 * fix and not a message between seats: it is the guard reporting that an agent
 * it just archived tried to grow a sub-tree. The child's title is often empty
 * (the create is denied before a title is set), so the id stands in for it.
 */
export function GuardRow(props: PluginTimelineItemProps<GuardRowData>) {
  const { theme, layout } = props;
  const pad = paddingFor(layout);
  const { childId, childTitle, violatorId, rule } = props.item.data;
  const titled = childTitle.trim().length > 0;
  const child = titled ? childTitle : childId;

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.statusWarning,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 2,
      }}
    >
      <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
        {`Guard · blocked ${child}`}
      </Text>
      {titled ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{`child ${childId}`}</Text>
      ) : null}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{`violator ${violatorId}`}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{rule}</Text>
    </View>
  );
}

import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";

import type { RoomStatusCard, RoomStatusData } from "../shared/room-status";
import { paddingFor, type Theme } from "./seat-editor";

/**
 * The state chip's colour. A lifecycle word and a report signal share the same
 * field, so the first word decides: `running`/`resuming` are healthy,
 * `permission pending` and `blocked` need attention, `error`/`failed` are the
 * only red, and everything else (`idle`, `STATUS: …`) stays muted.
 */
function stateColor(theme: Theme, state: string): string {
  const word = state.toLowerCase();
  if (word.startsWith("running") || word.startsWith("resuming")) return theme.colors.statusSuccess;
  if (word.startsWith("permission") || word.startsWith("blocked")) return theme.colors.statusWarning;
  if (word.startsWith("error") || word.startsWith("failed")) return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function StatusCard(props: { card: RoomStatusCard; theme: Theme; pad: number }) {
  const { card, theme, pad } = props;
  const color = stateColor(theme, card.state);

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 3,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}
          numberOfLines={1}
        >
          {card.name}
        </Text>
        <Text
          style={{
            color,
            backgroundColor: theme.colors.surface2,
            fontSize: 11,
            borderRadius: 4,
            paddingHorizontal: 6,
            paddingVertical: 2,
          }}
          numberOfLines={1}
        >
          {card.state}
        </Text>
      </View>
      {card.detail === undefined ? null : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{card.detail}</Text>
      )}
      {card.peers.length === 0 ? null : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {`peers: ${card.peers.join(", ")}`}
        </Text>
      )}
      {card.waitingOn === undefined ? null : (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
          {`waiting on ${card.waitingOn}${card.elapsed === undefined ? "" : ` · ${card.elapsed}`}`}
        </Text>
      )}
    </View>
  );
}

function TerminalRow(props: { data: RoomStatusData; theme: Theme; pad: number }) {
  const { data, theme, pad } = props;
  const terminal = data.terminal;
  if (terminal === null) return null;
  const done = terminal.kind === "done";
  const color = done ? theme.colors.statusSuccess : theme.colors.statusWarning;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 6,
        backgroundColor: theme.colors.surface1,
        borderColor: color,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
      }}
    >
      <Text style={{ fontSize: 12 }}>{done ? "✅" : "❓"}</Text>
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>
        {done ? "Done" : "Waiting on you"}
      </Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }}>{terminal.text}</Text>
    </View>
  );
}

/**
 * The room-state block as a native row: each Lead's card keeps its name, live
 * state, current detail, Peers and the wait target on one surface, so a long
 * wait or a permission-pending Peer is visible at a glance instead of buried
 * in prose. The reply text around the fenced block is rendered as Markdown, so
 * nothing the Supervisor said is lost.
 */
export function RoomStatusRow(props: PluginTimelineItemProps<RoomStatusData>) {
  const { theme, layout, item } = props;
  const pad = paddingFor(layout);
  const data = item.data;
  const hasTerminal = data.terminal !== null;

  return (
    <View style={{ gap: 8 }}>
      {data.before.length === 0 ? null : <Markdown>{data.before}</Markdown>}
      {data.cards.map((card, index) => (
        <StatusCard key={`${card.name}/${index}`} card={card} theme={theme} pad={pad} />
      ))}
      {hasTerminal ? <TerminalRow data={data} theme={theme} pad={pad} /> : null}
      {data.after.length === 0 ? null : <Markdown>{data.after}</Markdown>}
    </View>
  );
}

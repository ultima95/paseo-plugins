import { useAgent, useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import type { SeatRecord } from "../shared/room";
import { getRoomRpc } from "../shared/rpc";
import type { Surface, Theme } from "./seat-editor";
import { ActionButton, Section, describeError, paddingFor } from "./seat-editor";
import type { FeedRow } from "./view-model";
import { buildTree, feedRows, seatName } from "./view-model";

/** A room appears a beat after its Supervisor is created, so the feed polls. */
const POLL_INTERVAL_MS = 2000;

/** One cache entry per room, under this plugin's own namespace. */
function roomQueryKey(roomId: string): string[] {
  return ["agent-room", "room", roomId];
}

/** Whatever the host calls to show an agent. Absent on hosts without navigation. */
type OpenAgent = (input: { agentId: string }) => void;

/** The status dot: green while the agent works, muted otherwise. */
function statusColor(theme: Theme, status: string | null): string {
  switch (status) {
    case "running":
      return theme.colors.statusSuccess;
    case "error":
      return theme.colors.statusDanger;
    case "initializing":
      return theme.colors.statusWarning;
    default:
      // idle, closed, and an agent this client has not loaded yet.
      return theme.colors.foregroundMuted;
  }
}

interface SeatRowProps {
  surface: Surface;
  seat: SeatRecord;
  depth: number;
  openAgent?: OpenAgent;
}

/**
 * One seat in the tree: indented by its depth, named by its marker, with the
 * provider/model it actually runs and its live status. Tapping opens the agent;
 * a host without navigation leaves the row inert rather than pretending.
 */
function SeatRow(props: SeatRowProps) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  const seat = props.seat;
  const status = useAgent(seat.agentId, (agent) => agent.status);
  const openAgent = props.openAgent;
  const dot = status === "running" ? "●" : "○";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: openAgent === undefined }}
      disabled={openAgent === undefined}
      onPress={openAgent === undefined ? undefined : () => openAgent({ agentId: seat.agentId })}
      style={{
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: Math.max(4, Math.round(pad / 2)),
        paddingLeft: pad + props.depth * pad,
        gap: 2,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
        {seatName(seat.marker)}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
        {`${seat.provider}/${seat.model}`}
      </Text>
      <Text style={{ color: statusColor(theme, status), fontSize: 11 }} numberOfLines={1}>
        {`${dot} ${status === null ? "unknown" : status}`}
      </Text>
    </Pressable>
  );
}

interface FeedRowProps {
  surface: Surface;
  row: FeedRow;
  expanded: boolean;
  onToggle(): void;
}

/** One feed line. Collapsed to two lines; a tap shows the whole message. */
function FeedRowView(props: FeedRowProps) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  const row = props.row;
  const guard = row.kind === "guard";
  const meta = `${row.time}  ${row.fromLabel}→${row.toLabel}  ${row.label}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      style={{
        backgroundColor: guard ? theme.colors.surface2 : theme.colors.surface0,
        borderColor: guard ? theme.colors.statusWarning : theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 2,
      }}
    >
      <Text
        style={{
          color: guard ? theme.colors.statusWarning : theme.colors.foregroundMuted,
          fontSize: 11,
        }}
        numberOfLines={1}
      >
        {guard ? `⚠ ${meta}` : meta}
      </Text>
      <Text
        style={{ color: guard ? theme.colors.statusWarning : theme.colors.foreground, fontSize: 12 }}
        numberOfLines={props.expanded ? undefined : 2}
      >
        {row.text}
      </Text>
    </Pressable>
  );
}

/**
 * The live view of one room: its seat tree and its feed.
 *
 * The room is polled rather than pushed. `room.get` answers `{ missing: true }`
 * for a room the store has not recorded yet, which is exactly what a launch
 * looks like for the first second or two, so that state is a waiting line and
 * not an error — the poll keeps running and the view fills itself in. Nothing
 * here starts or steers an agent: it is a window on the room.
 *
 * Wide layout puts the tree in a left column and the feed on the right; a
 * compact layout stacks the tree above the feed.
 */
export function RoomScreen(props: PluginScreenProps) {
  const { theme, layout, navigation } = props;
  const surface: Surface = { theme, layout };
  const pad = paddingFor(layout);
  const roomId = props.params.roomId ?? "";
  const getRoom = useRpc(getRoomRpc);
  const openAgent = navigation?.openAgent;

  const query = useQuery({
    queryKey: roomQueryKey(roomId),
    queryFn: () => getRoom({ roomId }),
    enabled: roomId.length > 0,
    refetchInterval: POLL_INTERVAL_MS,
  });

  // "" is "nothing expanded": feed event ids are non-empty, so it never names a row.
  const [expandedId, setExpandedId] = useState("");

  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const warning = { color: theme.colors.statusWarning, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };

  const data = query.data;
  const missing = data !== undefined && "missing" in data;
  const loaded = data !== undefined && !("missing" in data) ? data : null;
  const seats = loaded === null ? [] : loaded.seats;
  const tree = buildTree(seats);
  const rows = loaded === null ? [] : feedRows(loaded.feed, seats);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: pad, gap: pad }}
    >
      {roomId.length === 0 ? (
        <Text style={warning}>
          No room selected. Start one with /room, or open the Room screen from the sidebar.
        </Text>
      ) : null}

      {roomId.length > 0 && query.isPending ? <Text style={muted}>Loading the room…</Text> : null}

      {query.isError ? (
        <View style={{ gap: pad }}>
          <Text style={danger}>{describeError(query.error)}</Text>
          <ActionButton surface={surface} label="Retry" onPress={() => void query.refetch()} />
        </View>
      ) : null}

      {missing ? (
        <Text style={muted}>Waiting for the room to appear… the Supervisor is starting.</Text>
      ) : null}

      {loaded === null ? null : (
        <View style={{ gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={2}>
            {loaded.room.task.trim().length > 0 ? loaded.room.task : "(no task)"}
          </Text>
          <Text style={muted}>
            {`${loaded.room.id.slice(0, 8)} · ${loaded.room.endedAt ? "ended" : "live · polling every 2s"}`}
          </Text>
        </View>
      )}

      {loaded === null ? null : (
        <View style={{ flexDirection: layout.compact ? "column" : "row", gap: pad }}>
          <View style={{ flex: layout.compact ? undefined : 1, gap: pad }}>
            <Section
              surface={surface}
              title="Seats"
              subtitle="Depth-first from the Supervisor. A tap opens that agent."
            >
              {tree.length === 0 ? <Text style={muted}>No seats recorded yet.</Text> : null}
              {tree.map((node) => (
                <SeatRow
                  key={node.seat.agentId}
                  surface={surface}
                  seat={node.seat}
                  depth={node.depth}
                  openAgent={openAgent}
                />
              ))}
              {openAgent === undefined ? (
                <Text style={muted}>This host has no agent navigation, so seats do not open.</Text>
              ) : null}
            </Section>
          </View>

          <View style={{ flex: layout.compact ? undefined : 2, gap: pad }}>
            <Section surface={surface} title="Feed" subtitle="Oldest first. A tap shows the whole message.">
              {rows.length === 0 ? <Text style={muted}>Nothing has happened in this room yet.</Text> : null}
              {rows.map((row) => (
                <FeedRowView
                  key={row.id}
                  surface={surface}
                  row={row}
                  expanded={expandedId === row.id}
                  onToggle={() => setExpandedId(expandedId === row.id ? "" : row.id)}
                />
              ))}
            </Section>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

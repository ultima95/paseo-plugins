import {
  useAgent,
  usePaseo,
  useRpc,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import type { FeedEvent, RoomRecord, SeatRecord } from "../shared/room";
import { getRoomRpc, launchRoomRpc, listRoomsRpc } from "../shared/rpc";
import { describeError } from "./seat-editor";
import { buildTree, feedRows } from "./view-model";

type WorkspaceAgent = {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: string;
};

function statusColor(theme: PluginWorkspacePanelProps["theme"], status: string | null): string {
  switch (status) {
    case "running":
      return theme.colors.statusSuccess;
    case "error":
      return theme.colors.statusDanger;
    case "initializing":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

function AgentStatus({
  agentId,
  theme,
  fallback,
}: {
  agentId: string;
  theme: PluginWorkspacePanelProps["theme"];
  fallback: string | null;
}) {
  const status = useAgent(agentId, (agent) => agent.status) ?? fallback;
  return <Text style={{ color: statusColor(theme, status), fontSize: 12 }}>{status ?? "unknown"}</Text>;
}

/**
 * Everything a workspace owns: its rooms, each room's seats and feed, and every
 * agent session in the workspace. A panel is the only surface in 0.13.1 that
 * can both list these and open one (`navigation.openAgent`).
 */
export function RoomManagerPanel(props: PluginWorkspacePanelProps) {
  const { theme, layout, workspaceId, navigation } = props;
  const paseo = usePaseo();
  const listRooms = useRpc(listRoomsRpc);
  const getRoom = useRpc(getRoomRpc);
  const launch = useRpc(launchRoomRpc);

  const [rooms, setRooms] = useState<RoomRecord[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [selected, setSelected] = useState(null as string | null);
  const [seats, setSeats] = useState<SeatRecord[]>([]);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [task, setTask] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState("");

  const pad = layout.compact ? 12 : 16;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [roomsResult, agentsResult] = await Promise.all([
        listRooms({}),
        paseo.agents.list({}),
      ]);
      const mine = roomsResult.rooms.filter((room) => room.workspaceId === workspaceId);
      setRooms(mine);
      setAgents(
        agentsResult.entries
          .map(({ agent }) => agent)
          .filter((agent) => agent.workspaceId === workspaceId)
          .map((agent) => ({
            id: agent.id,
            title: agent.title,
            provider: agent.provider,
            model: agent.model,
            status: agent.status,
          })),
      );
      setSelected((current) => (current && mine.some((room) => room.id === current) ? current : (mine[0]?.id ?? null)));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [listRooms, paseo, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selected === null) {
      setSeats([]);
      setFeed([]);
      return;
    }
    let cancelled = false;
    void getRoom({ roomId: selected })
      .then((result) => {
        if (cancelled) return;
        if ("missing" in result) {
          setSeats([]);
          setFeed([]);
        } else {
          setSeats(result.seats);
          setFeed(result.feed);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [getRoom, selected]);

  const tree = useMemo(() => buildTree(seats), [seats]);
  const rows = useMemo(() => feedRows(feed.slice(-30), seats), [feed, seats]);

  async function start() {
    const text = task.trim();
    if (text.length === 0 || launching) return;
    setLaunching(true);
    setLaunchError("");
    try {
      const result = await launch({ task: text, workspaceId });
      setTask("");
      await refresh();
      setSelected(result.roomId);
    } catch (caught) {
      setLaunchError(describeError(caught));
    } finally {
      setLaunching(false);
    }
  }

  const muted = { color: theme.colors.foregroundMuted };
  const open = (agentId: string) => navigation?.openAgent({ agentId });

  return (
    <ScrollView
      contentContainerStyle={{ padding: pad, gap: pad }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: pad }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600", flex: 1 }}>
          Rooms and agents
        </Text>
        <Pressable accessibilityRole="button" onPress={() => void refresh()}>
          <Text style={{ color: theme.colors.accent }}>{loading ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      </View>
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}

      <View
        style={{
          padding: pad,
          gap: pad,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Start a room</Text>
        <Text style={muted}>Uses the saved seats and runs in this workspace.</Text>
        <TextInput
          accessibilityLabel="Room task"
          multiline
          placeholder="What should the room do?"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={task}
          editable={!launching}
          onChangeText={setTask}
          style={{
            minHeight: 72,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface0,
            color: theme.colors.foreground,
            padding: 10,
            textAlignVertical: "top",
          }}
        />
        {launchError ? <Text style={{ color: theme.colors.statusDanger }}>{launchError}</Text> : null}
        <Pressable
          accessibilityRole="button"
          disabled={task.trim().length === 0 || launching}
          onPress={() => void start()}
          style={{
            alignSelf: "flex-start",
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 8,
            backgroundColor:
              task.trim().length > 0 && !launching
                ? theme.colors.accent
                : theme.colors.surface2,
          }}
        >
          <Text
            style={{
              color:
                task.trim().length > 0 && !launching
                  ? theme.colors.accentForeground
                  : theme.colors.foregroundMuted,
              fontWeight: "600",
            }}
          >
            {launching ? "Launching…" : "Launch room"}
          </Text>
        </Pressable>
      </View>

      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        Rooms in this workspace
      </Text>
      {rooms.length === 0 && !loading ? <Text style={muted}>No rooms yet.</Text> : null}
      {rooms.map((room) => (
        <Pressable
          key={room.id}
          accessibilityRole="button"
          onPress={() => setSelected(room.id)}
          style={{
            padding: pad,
            gap: 4,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: selected === room.id ? theme.colors.accent : theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <View style={{ flexDirection: "row", gap: pad }}>
            <Text style={{ color: theme.colors.foreground, flex: 1 }} numberOfLines={2}>
              {room.task || room.id.slice(0, 8)}
            </Text>
            <AgentStatus agentId={room.id} theme={theme} fallback={null} />
          </View>
          <View style={{ flexDirection: "row", gap: pad }}>
            <Text style={muted}>{room.endedAt ? "ended" : "live"}</Text>
            <Text style={muted}>{room.cwd}</Text>
          </View>
        </Pressable>
      ))}

      {selected !== null ? (
        <View
          style={{
            padding: pad,
            gap: pad,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: pad }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600", flex: 1 }}>Seats</Text>
            <Pressable accessibilityRole="button" onPress={() => open(selected)}>
              <Text style={{ color: theme.colors.accent }}>Open Supervisor</Text>
            </Pressable>
          </View>
          {tree.map(({ seat, depth }) => (
            <Pressable
              key={seat.agentId}
              accessibilityRole="button"
              onPress={() => open(seat.agentId)}
              style={{ marginLeft: depth * 14, flexDirection: "row", gap: pad, alignItems: "center" }}
            >
              <Text style={{ color: theme.colors.foreground, flex: 1 }} numberOfLines={1}>
                {seat.marker.seat === "peer" ? `Peer:${seat.marker.tier}` : seat.marker.seat}
                {"  "}
                {seat.provider}/{seat.model}
              </Text>
              <AgentStatus agentId={seat.agentId} theme={theme} fallback={null} />
            </Pressable>
          ))}
          {tree.length === 0 ? <Text style={muted}>No seats recorded yet.</Text> : null}

          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Feed</Text>
          {rows.slice(-15).map((row) => (
            <View key={row.id} style={{ gap: 2 }}>
              <Text style={muted}>
                {row.time} {row.fromLabel}→{row.toLabel} {row.label}
              </Text>
              <Text style={{ color: theme.colors.foreground }} numberOfLines={3}>
                {row.text}
              </Text>
            </View>
          ))}
          {rows.length === 0 ? <Text style={muted}>No messages yet.</Text> : null}
        </View>
      ) : null}

      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        Agents and sessions in this workspace
      </Text>
      {agents.map((agent) => (
        <Pressable
          key={agent.id}
          accessibilityRole="button"
          onPress={() => open(agent.id)}
          style={{
            padding: pad,
            gap: 4,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <View style={{ flexDirection: "row", gap: pad }}>
            <Text style={{ color: theme.colors.foreground, flex: 1 }} numberOfLines={1}>
              {agent.title ?? agent.id.slice(0, 8)}
            </Text>
            <AgentStatus agentId={agent.id} theme={theme} fallback={agent.status} />
          </View>
          <Text style={muted}>
            {agent.provider}
            {agent.model ? `/${agent.model}` : ""} · {agent.id.slice(0, 8)}
          </Text>
        </Pressable>
      ))}
      {agents.length === 0 && !loading ? <Text style={muted}>No agents in this workspace.</Text> : null}
    </ScrollView>
  );
}

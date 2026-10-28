import {
  useRpc,
  type PluginButtonContentProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { launchRoomRpc } from "../shared/rpc";
import { describeError } from "./seat-editor";

const PILL_ID = "start-room";

/**
 * The composer pill's popover. It launches into the workspace the composer
 * belongs to with the saved seats, so the pill needs no seat controls of its
 * own. A popover cannot navigate in 0.13.1, so a started room is reported here
 * and opened from the Room sidebar or its recent-rooms popover.
 */
export function RoomPopover(props: PluginButtonContentProps) {
  const { theme, layout, workspaceId, close } = props;
  const launch = useRpc(launchRoomRpc);

  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [roomId, setRoomId] = useState(null as string | null);

  const pad = layout.compact ? 12 : 16;
  const canLaunch = task.trim().length > 0 && !busy;

  async function start() {
    if (!canLaunch) return;
    setBusy(true);
    setError("");
    try {
      const result = await launch({ task: task.trim(), workspaceId });
      setRoomId(result.roomId);
      setTask("");
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (roomId !== null) {
    return (
      <View style={{ padding: pad, gap: pad }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
          Room started
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Supervisor {roomId.slice(0, 8)} is running. Open the room from the Room sidebar, or from
          its recent-rooms popover.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={close}
          style={{
            alignSelf: "flex-start",
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 8,
            backgroundColor: theme.colors.accent,
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontWeight: "600" }}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: pad, gap: pad }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
        Start a room
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Uses the saved Supervisor, Lead and peer seats, and runs in this workspace.
      </Text>
      <TextInput
        accessibilityLabel="Room task"
        multiline
        placeholder="What should the room do?"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={task}
        editable={!busy}
        onChangeText={setTask}
        style={{
          minHeight: 88,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          color: theme.colors.foreground,
          padding: 10,
          textAlignVertical: "top",
        }}
      />
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: pad }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Launch room"
          disabled={!canLaunch}
          onPress={() => void start()}
          style={{
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 8,
            backgroundColor: canLaunch ? theme.colors.accent : theme.colors.surface2,
            opacity: canLaunch ? 1 : 0.5,
          }}
        >
          <Text
            style={{
              color: canLaunch ? theme.colors.accentForeground : theme.colors.foregroundMuted,
              fontWeight: "600",
            }}
          >
            {busy ? "Launching…" : "Launch room"}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={close}>
          <Text style={{ color: theme.colors.foregroundMuted }}>Cancel</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * One composer pill per agent, following the agent directory the same way the
 * schedule pill does: the composer is per agent, and the pill only needs the
 * workspace that agent belongs to.
 */
export function contributeRoomPills(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const registrations = new Map<string, PluginButtonRegistration>();

  const add = (agent: { id: string; workspaceId?: string }): void => {
    if (registrations.has(agent.id) || !agent.workspaceId) return;
    registrations.set(
      agent.id,
      client.addComposerPill({
        id: PILL_ID,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Start a room",
          icon: "Users",
          label: "Room",
          behavior: { kind: "popover", Content: RoomPopover },
        },
      }),
    );
  };

  const remove = (agentId: string): void => {
    registrations.get(agentId)?.remove();
    registrations.delete(agentId);
  };

  void client.paseo.agents
    .list({ subscribe: {}, page: { limit: 200 }, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const live = new Set(entries.map(({ agent }) => agent.id));
          for (const id of [...registrations.keys()]) {
            if (!live.has(id)) remove(id);
          }
          for (const { agent } of entries) add(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else add(update.agent);
        },
      });
      return undefined;
    })
    .catch((caught: unknown) => {
      if (!lifetime.signal.aborted) {
        console.error(`[agent-room] room pill could not observe agents — ${describeError(caught)}`);
      }
    });

  return () => {
    lifetime.abort();
    for (const registration of registrations.values()) registration.remove();
    registrations.clear();
  };
}

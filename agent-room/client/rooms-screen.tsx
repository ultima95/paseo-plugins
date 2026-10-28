import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import type { RoomRecord } from "../shared/room";
import { launchRoomRpc, listRoomsRpc } from "../shared/rpc";
import { DEFAULT_SETTINGS, roomSettings } from "../shared/seats";
import { LaunchForm, useLaunchTarget } from "./launch-form";
import type { SeatKey, SeatPatch, RoomDraft, TierPatch } from "./settings-draft";
import { addTier, removeTier, setSeat, setTier, validateDraft } from "./settings-draft";
import type { Surface } from "./seat-editor";
import {
  ActionButton,
  Field,
  SeatEditor,
  Section,
  TextEntry,
  describeError,
  paddingFor,
  useProviderCatalog,
} from "./seat-editor";

/** Newest first. The RPC already sorts; this keeps the row order pinned here. */
function newestFirst(rooms: RoomRecord[]): RoomRecord[] {
  return rooms.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** A short, stable prefix of an agent id, so rows stay scannable. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Local `HH:MM`, or the raw timestamp when the value is not a date. */
function timeOfDay(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  try {
    return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    // A runtime without locale data still has to render the row.
    return at;
  }
}

function RoomRow(props: { surface: Surface; room: RoomRecord; onOpen(): void }) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  const room = props.room;
  const task = room.task.trim();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      style={{
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 2,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={2}>
        {task.length > 0 ? task : "(no task)"}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {`${shortId(room.id)} · ${timeOfDay(room.createdAt)}${room.endedAt ? " · ended" : ""}${
          room.cwd.length > 0 ? ` · ${room.cwd}` : ""
        }`}
      </Text>
    </Pressable>
  );
}

/**
 * The Rooms screen: seat settings, the launch form, and the room list.
 *
 * A screen cannot navigate on its own, so the only ways out are the host's
 * `navigation.openAgent` (when the host offers one) and staying put: with no
 * navigation, a launch returns to a refreshed room list and a row press does
 * nothing, because the live view is a different screen registered elsewhere.
 */
export function RoomsScreen(props: PluginScreenProps) {
  const { theme, layout, navigation } = props;
  const surface: Surface = { theme, layout };
  const pad = paddingFor(layout);

  const settings = useSettings(roomSettings);
  const catalog = useProviderCatalog();
  const launchTarget = useLaunchTarget();
  const launchRoom = useRpc(launchRoomRpc);
  const listRooms = useRpc(listRoomsRpc);

  /** Local edits. `null` shows whatever the settings store currently holds. */
  const [edited, setEdited] = useState<RoomDraft | null>(null);
  const [newTierId, setNewTierId] = useState("");
  const [tierError, setTierError] = useState("");

  const [task, setTask] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState("");

  const [rooms, setRooms] = useState<RoomRecord[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [roomsError, setRoomsError] = useState("");

  // Save goes through the revision on screen; without one there is nothing to
  // save against, so the button stays disabled while settings load or fail.
  const revision =
    settings.status === "ready" || settings.status === "invalid" ? settings.revision : null;
  const stored: RoomDraft = settings.status === "ready" ? settings.values : DEFAULT_SETTINGS;
  const draft: RoomDraft = edited ?? stored;
  const validation = validateDraft(draft);

  const refreshRooms = useCallback(async () => {
    setRoomsLoading(true);
    try {
      const result = await listRooms({});
      setRooms(newestFirst(result.rooms));
      setRoomsError("");
    } catch (caught) {
      setRoomsError(describeError(caught));
    } finally {
      setRoomsLoading(false);
    }
  }, [listRooms]);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  const openAgent = navigation?.openAgent;

  async function saveSettings() {
    if (revision === null || validation.settings === null || settings.saving) return;
    const saved = await settings.save(validation.settings, revision);
    if (!saved) return; // `settings.saveError` explains why.
    // Reload, then show what the store holds so a stale local edit cannot
    // outlive the save it was made for.
    await settings.reload();
    setEdited(null);
  }

  async function launch() {
    const request = launchTarget.request;
    if (request === null || launching || task.trim().length === 0) return;

    setLaunching(true);
    setLaunchError("");
    try {
      const result = await launchRoom({ task: task.trim(), ...request });
      setTask("");
      if (openAgent) {
        openAgent({ agentId: result.roomId });
      } else {
        await refreshRooms();
      }
    } catch (caught) {
      setLaunchError(describeError(caught));
    } finally {
      setLaunching(false);
    }
  }

  function changeSeat(key: SeatKey, patch: SeatPatch) {
    setEdited(setSeat(draft, key, patch));
  }

  function changeTier(id: string, patch: TierPatch) {
    setEdited(setTier(draft, id, patch));
  }

  function addTierRow() {
    const id = newTierId.trim();
    if (id.length === 0) return;
    const next = addTier(draft, id);
    if (next === draft) {
      setTierError(`"${id}" is already used, or is not lowercase kebab-case.`);
      return;
    }
    setEdited(next);
    setNewTierId("");
    setTierError("");
  }

  const editing = revision !== null && !settings.saving;
  const canSave = editing && validation.ok;

  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const warning = { color: theme.colors.statusWarning, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };

  const seats: ReactNode[] = [];
  for (const tier of draft.peerTiers) {
    seats.push(
      <SeatEditor
        key={`peer-${tier.id}`}
        theme={theme}
        layout={layout}
        cwd={launchTarget.cwdForFeatures}
        label={`Peer · ${tier.id}`}
        seat={tier}
        providers={catalog.providers}
        disabled={!editing}
        onChange={(patch) => changeTier(tier.id, patch)}
        useFor={tier.useFor}
        onUseForChange={(text) => changeTier(tier.id, { useFor: text })}
        onRemove={tier.id === "default" ? undefined : () => setEdited(removeTier(draft, tier.id))}
      />,
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: pad, gap: pad }}
      keyboardShouldPersistTaps="handled"
    >
      <Section
        surface={surface}
        title="Seats"
        subtitle="Every agent a room starts runs the seat its title is marked with."
      >
        {settings.status === "loading" ? <Text style={muted}>Loading saved seats…</Text> : null}
        {settings.status === "error" ? (
          <Text style={danger}>{`${settings.error} — seats cannot be edited until they load.`}</Text>
        ) : null}
        {settings.status === "invalid" ? (
          <Text style={warning}>
            The saved seats do not match the schema; the defaults are shown, and saving replaces them.
          </Text>
        ) : null}
        {catalog.loading ? <Text style={muted}>Loading providers…</Text> : null}
        {catalog.error ? <Text style={warning}>{catalog.error}</Text> : null}

        <SeatEditor
          theme={theme}
          layout={layout}
          cwd={launchTarget.cwdForFeatures}
          label="Supervisor"
          seat={draft.supervisor}
          providers={catalog.providers}
          disabled={!editing}
          onChange={(patch) => changeSeat("supervisor", patch)}
        />
        <SeatEditor
          theme={theme}
          layout={layout}
          cwd={launchTarget.cwdForFeatures}
          label="Lead"
          seat={draft.lead}
          providers={catalog.providers}
          disabled={!editing}
          onChange={(patch) => changeSeat("lead", patch)}
        />
        {seats}

        <Field surface={surface} label="New peer tier id">
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
            <View style={{ flex: 1, minWidth: 160 }}>
              <TextEntry
                surface={surface}
                value={newTierId}
                placeholder="e.g. triage"
                onChangeText={setNewTierId}
              />
            </View>
            <ActionButton
              surface={surface}
              label="Add tier"
              disabled={!editing || newTierId.trim().length === 0}
              onPress={addTierRow}
            />
          </View>
          <Text style={muted}>A new tier copies the default tier and needs a use-for before it saves.</Text>
          {tierError ? <Text style={warning}>{tierError}</Text> : null}
        </Field>

        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
          <ActionButton
            surface={surface}
            label={settings.saving ? "Saving…" : "Save seats"}
            disabled={!canSave}
            onPress={() => void saveSettings()}
          />
          {validation.ok ? null : <Text style={warning}>{`Cannot save yet — ${validation.error}`}</Text>}
          {settings.saveError ? <Text style={danger}>{settings.saveError}</Text> : null}
        </View>
      </Section>

      <Section surface={surface} title="Launch" subtitle="Start a room: a Supervisor first, then the Lead.">
        <LaunchForm
          theme={theme}
          layout={layout}
          target={launchTarget}
          task={task}
          onTaskChange={setTask}
          launching={launching}
          error={launchError}
          onLaunch={() => void launch()}
        />
      </Section>

      <Section surface={surface} title="Rooms" subtitle="Newest first. A row opens that room's Supervisor.">
        {roomsLoading ? <Text style={muted}>Loading rooms…</Text> : null}
        {roomsError ? <Text style={danger}>{roomsError}</Text> : null}
        {!roomsLoading && !roomsError && rooms.length === 0 ? <Text style={muted}>No rooms yet.</Text> : null}
        {rooms.map((room) => (
          <RoomRow
            key={room.id}
            surface={surface}
            room={room}
            onOpen={() => {
              if (openAgent) openAgent({ agentId: room.id });
            }}
          />
        ))}
        {openAgent ? null : <Text style={muted}>This host has no agent navigation, so rows do not open.</Text>}
        <View style={{ flexDirection: "row", alignItems: "center", gap: pad }}>
          <ActionButton
            surface={surface}
            label={roomsLoading ? "Refreshing…" : "Refresh"}
            disabled={roomsLoading}
            onPress={() => void refreshRooms()}
          />
        </View>
      </Section>
    </ScrollView>
  );
}

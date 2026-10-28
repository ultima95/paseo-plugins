import { useRpc } from "@getpaseo/plugin/client";
import type { PluginPopoverProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import type { RoomRecord } from "../shared/room";
import { listRoomsRpc } from "../shared/rpc";
import { describeError, paddingFor, type Surface } from "./seat-editor";
import { timeOfDay } from "./view-model";

/** Newest first. The RPC already sorts; this keeps the popover order pinned here. */
function newestFirst(rooms: RoomRecord[]): RoomRecord[] {
  return rooms.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** The one line that names a room: its task, else the id it is keyed by. */
function roomName(room: RoomRecord): string {
  const task = room.task.trim();
  return task.length > 0 ? task : room.id.slice(0, 8);
}

/** One tappable row of the popover: the whole row is the press target. */
function PopoverRow(props: { surface: Surface; onPress(): void; children: ReactNode }) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={{
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 2,
      }}
    >
      {props.children}
    </Pressable>
  );
}

/** One room in the popover: what it is, and when it was created. */
function RoomRow(props: { surface: Surface; room: RoomRecord; onOpen(): void }) {
  const { theme } = props.surface;
  const room = props.room;

  return (
    <PopoverRow surface={props.surface} onPress={props.onOpen}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={2}>
        {roomName(room)}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
        {`${timeOfDay(room.createdAt)}${room.endedAt ? " · ended" : ""}`}
      </Text>
    </PopoverRow>
  );
}

/**
 * The sidebar row's popover: the recent rooms, each opening its live view.
 *
 * A screen cannot navigate on its own in 0.13.1, but a popover gets
 * `openScreen`, which is why "room list → room" is reachable from here and not
 * from the Rooms screen. The popover closes itself after navigating, so the
 * screen it opened is not left behind a sheet.
 */
export function RoomsPopover(props: PluginPopoverProps) {
  const { theme, layout } = props;
  const surface: Surface = { theme, layout };
  const pad = paddingFor(layout);
  const listRooms = useRpc(listRoomsRpc);

  const [rooms, setRooms] = useState<RoomRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    // A popover lives for one opening, so loading once on mount is enough; the
    // cancelled guard keeps a slow answer from writing into an unmounted tree.
    let cancelled = false;
    setLoading(true);
    void listRooms({})
      .then((result) => {
        if (cancelled) return;
        setRooms(newestFirst(result.rooms));
        setError("");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(describeError(caught));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listRooms]);

  function openRoom(room: RoomRecord) {
    props.openScreen({ screenId: "room", params: { roomId: room.id } });
    props.close();
  }

  function openSeatSetup() {
    props.openScreen({ screenId: "rooms" });
    props.close();
  }

  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };

  return (
    <View style={{ backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ padding: pad, gap: pad }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Room</Text>
        {loading ? <Text style={muted}>Loading rooms…</Text> : null}
        {error.length > 0 ? <Text style={danger}>{error}</Text> : null}
        {!loading && error.length === 0 && rooms.length === 0 ? (
          <Text style={muted}>No rooms yet</Text>
        ) : null}
        {rooms.map((room) => (
          <RoomRow key={room.id} surface={surface} room={room} onOpen={() => openRoom(room)} />
        ))}
        <PopoverRow surface={surface} onPress={openSeatSetup}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Seat setup</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            All rooms, seat settings, and the launch form
          </Text>
        </PopoverRow>
      </ScrollView>
    </View>
  );
}

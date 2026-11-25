import type { ComponentType } from "react";
import type {
  PluginButtonIconProps,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { colorWithAlpha } from "./column-accent";
import {
  boardButtonId,
  buttonWorkspaces,
  pillCounts,
  pillSpecs,
  type PillSpec,
  type PillWorkspace,
} from "./header-pills";

/**
 * The board's status pills in the workspace header.
 *
 * The sidebar row is the board's usual way in, but it lives in the sidebar, so closing the
 * sidebar hides the only way back. Header buttons are per workspace, so this keeps three per
 * open workspace on the host: a tinted badge counting the workspaces that need the user, one
 * counting the ones still running, and a plain board button while both counts are zero.
 *
 * Paseo draws the button itself, so a plugin can style only the icon inside it. The count
 * pills are therefore components that draw the whole tinted badge in that slot.
 */

/**
 * The badge's colors are fixed rather than themed, because an icon component receives only a
 * size and a color. These two read on both a light and a dark header.
 */
const TONE = { need: "#e5484d", run: "#3b82f6" } as const;

const badges = new Map<string, ComponentType<PluginButtonIconProps>>();

/** A tinted badge for one count, cached so the same count keeps the same component identity. */
function badgeIcon(kind: "need" | "run", count: number): ComponentType<PluginButtonIconProps> {
  const key = `${kind}:${count}`;
  const cached = badges.get(key);
  if (cached !== undefined) return cached;
  const tone = TONE[kind];

  function Badge(_props: PluginButtonIconProps) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          height: 18,
          paddingHorizontal: 5,
          borderRadius: 9,
          backgroundColor: colorWithAlpha(tone, 0.16),
        }}
      >
        <Icon name={kind === "need" ? "AlertCircle" : "Play"} size={11} color={tone} />
        <Text style={{ color: tone, fontSize: 10.5, fontWeight: "600" }}>{count}</Text>
      </View>
    );
  }
  Badge.displayName = `BoardBadge(${key})`;
  badges.set(key, Badge);
  return Badge;
}

/** The icon a pill draws: a tinted badge for a count, the plain grid for the board button. */
function pillIcon(spec: PillSpec): ComponentType<PluginButtonIconProps> | string {
  if (spec.kind === "board") return "LayoutGrid";
  return badgeIcon(spec.kind, spec.count);
}

/** How many times a host that was not reachable at load is asked again before giving up. */
const LIST_ATTEMPTS = 3;
const LIST_RETRY_MS = 2_000;

interface LiveButton {
  readonly registration: ReturnType<PluginClientContext["addHeaderButton"]>;
  readonly workspaceId: string;
  readonly icon: ComponentType<PluginButtonIconProps> | string;
  readonly visible: boolean;
  readonly title: string;
}

export function registerBoardHeaderButtons(client: PluginClientContext): () => void {
  // An older app has no header buttons at all, and an older one has no paseo handle; the
  // sidebar row still works on both.
  if (typeof client.addHeaderButton !== "function") return () => undefined;
  const actions = client.paseo?.workspaces;
  if (typeof actions?.list !== "function") return () => undefined;

  let disposed = false;
  let stop: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const buttons = new Map<string, LiveButton>();

  const sync = (workspaces: readonly PillWorkspace[]) => {
    if (disposed) return;
    const specs = pillSpecs(pillCounts(workspaces));
    const wanted = new Set(buttonWorkspaces(workspaces));
    for (const [id, live] of buttons) {
      if (wanted.has(live.workspaceId)) continue;
      live.registration.remove();
      buttons.delete(id);
    }
    for (const workspaceId of wanted) {
      for (const spec of specs) {
        const id = boardButtonId(workspaceId, spec.kind);
        const icon = pillIcon(spec);
        const existing = buttons.get(id);
        if (existing !== undefined) {
          // Only touch the host when this pill's own badge or visibility moved.
          if (
            existing.icon !== icon ||
            existing.visible !== spec.visible ||
            existing.title !== spec.title
          ) {
            existing.registration.update({
              icon,
              visible: spec.visible,
              title: spec.title,
            });
            buttons.set(id, {
              registration: existing.registration,
              workspaceId,
              icon,
              visible: spec.visible,
              title: spec.title,
            });
          }
          continue;
        }
        try {
          const registration = client.addHeaderButton({
            id,
            workspaceId,
            button: {
              title: spec.title,
              icon,
              visible: spec.visible,
              behavior: {
                kind: "action",
                onPress: () => client.openScreen({ screenId: "board" }),
              },
            },
          });
          buttons.set(id, {
            registration,
            workspaceId,
            icon,
            visible: spec.visible,
            title: spec.title,
          });
        } catch {
          // A host that refuses this workspace's pill must not stop the others.
        }
      }
    }
  };

  const byId = new Map<string, PillWorkspace>();
  const republish = () => sync([...byId.values()]);

  // The app can load a plugin before its daemon is reachable. Asking again keeps the pills
  // from staying missing until the plugin is reloaded by hand.
  let attempt = 0;
  const start = () => {
    if (disposed) return;
    attempt += 1;
    actions
      .list({ subscribe: {} })
      .then(({ entries, subscription }) => {
        if (disposed) {
          void subscription.release().catch(() => undefined);
          return;
        }
        release = () => subscription.release();
        for (const entry of entries) byId.set(entry.id, entry);
        sync(entries);
        stop = subscription.subscribe({
          snapshot: ({ entries: next }) => {
            byId.clear();
            for (const entry of next) byId.set(entry.id, entry);
            republish();
          },
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            if (update.kind === "upsert") byId.set(update.workspace.id, update.workspace);
            else byId.delete(update.id);
            republish();
          },
        });
      })
      .catch(() => {
        if (disposed || attempt >= LIST_ATTEMPTS) return;
        retry = setTimeout(start, LIST_RETRY_MS);
      });
  };
  start();

  return () => {
    disposed = true;
    if (retry !== null) clearTimeout(retry);
    stop?.();
    for (const live of buttons.values()) live.registration.remove();
    buttons.clear();
    void release?.().catch(() => undefined);
  };
}

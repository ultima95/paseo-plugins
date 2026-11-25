import type { ComponentType } from "react";
import type {
  PluginButtonIconProps,
  PluginClientContext,
  PluginPaseoApi,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { colorWithAlpha } from "./column-accent";
import {
  boardButtonId,
  buttonWorkspaces,
  PILL_ICON,
  pillCounts,
  pillSpecs,
  type PillKind,
  type PillSpec,
  type PillWorkspace,
} from "./header-pills";

/**
 * The board's status pills in the workspace header.
 *
 * The sidebar row is the board's usual way in, but it lives in the sidebar, so closing the
 * sidebar hides the only way back. Header buttons are per workspace, so every open workspace
 * carries one pill per counting column, plus a plain board button while all counts are zero.
 *
 * The board merges every host, so the counts do too. The app's own host registry is the only
 * place that knows every connected machine; the daemon's host settings know only the remote
 * ones saved on this machine.
 *
 * Paseo draws the button itself, so a plugin styles only the icon inside it. That slot is the
 * size of an icon and clips what overflows, so the badge is a circle and the number is the
 * host's own label.
 */

/**
 * The colors are fixed rather than themed, because an icon component receives only a size and
 * a color. They match the board's light column accents and read on a dark header too.
 */
const TONE: Record<Exclude<PillKind, "board">, string> = {
  blocked: "#e5484d",
  review: "#22a05b",
  run: "#3b82f6",
  done: "#0d9488",
};

const badges = new Map<string, ComponentType<PluginButtonIconProps>>();

/** A tinted badge for one column, cached so the same pill keeps the same component identity. */
function badgeIcon(kind: Exclude<PillKind, "board">): ComponentType<PluginButtonIconProps> {
  const cached = badges.get(kind);
  if (cached !== undefined) return cached;
  const tone = TONE[kind];

  function Badge(_props: PluginButtonIconProps) {
    return (
      <View
        style={{
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: colorWithAlpha(tone, 0.16),
        }}
      >
        <Icon name={PILL_ICON[kind]} size={10} color={tone} />
      </View>
    );
  }
  Badge.displayName = `BoardBadge(${kind})`;
  badges.set(kind, Badge);
  return Badge;
}

/** The icon a pill draws: a tinted badge for a count, the plain grid for the board button. */
function pillIcon(spec: PillSpec): ComponentType<PluginButtonIconProps> | string {
  if (spec.kind === "board") return "LayoutGrid";
  return badgeIcon(spec.kind);
}

/** How many times a host that was not reachable at load is asked again before giving up. */
const LIST_ATTEMPTS = 3;
const LIST_RETRY_MS = 2_000;

interface LiveButton {
  readonly registration: ReturnType<PluginClientContext["addHeaderButton"]>;
  readonly workspaceId: string;
  readonly icon: ComponentType<PluginButtonIconProps> | string;
  readonly label: string | undefined;
  readonly visible: boolean;
  readonly title: string;
}

/** A client for another host, which the plugin must dispose when it is done with it. */
type RemoteApi = Awaited<ReturnType<PluginPaseoApi["hosts"]["client"]>>;

/** Only the one call this module makes, so this host's client and a remote one both fit. */
interface WorkspaceSource {
  readonly workspaces: Pick<RemoteApi["workspaces"], "list">;
}

/** The app's host registry: every connected machine, and a client for each. */
interface HostRegistry {
  readonly getSnapshot: () => readonly { readonly serverId?: string | null }[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly getPaseoClient: (serverId: string) => RemoteApi;
}

/** One host's workspaces, kept live. A client this module opened must be disposed by it. */
interface Feed {
  readonly rows: Map<string, PillWorkspace>;
  stop?: () => void;
  release?: () => Promise<void>;
  readonly owned?: RemoteApi;
}

/** The host registry is provided by the app but missing from the published client types. */
function hostRegistry(client: PluginClientContext): HostRegistry | null {
  const candidate = (client as unknown as { hosts?: Partial<HostRegistry> }).hosts;
  if (!candidate) return null;
  const { getSnapshot, subscribe, getPaseoClient } = candidate;
  if (
    typeof getSnapshot !== "function" ||
    typeof subscribe !== "function" ||
    typeof getPaseoClient !== "function"
  ) {
    return null;
  }
  return { getSnapshot, subscribe, getPaseoClient };
}

export function registerBoardHeaderButtons(client: PluginClientContext): () => void {
  // An older app has no header buttons at all, and an older one has no paseo handle; the
  // sidebar row still works on both.
  if (typeof client.addHeaderButton !== "function") return () => undefined;
  const paseo = client.paseo;
  if (typeof paseo?.workspaces?.list !== "function") return () => undefined;

  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const buttons = new Map<string, LiveButton>();
  const feeds = new Map<string, Feed>();

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
            existing.label !== spec.label ||
            existing.visible !== spec.visible ||
            existing.title !== spec.title
          ) {
            existing.registration.update({
              icon,
              label: spec.label,
              visible: spec.visible,
              title: spec.title,
            });
            buttons.set(id, {
              registration: existing.registration,
              workspaceId,
              icon,
              label: spec.label,
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
              label: spec.label,
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
            label: spec.label,
            visible: spec.visible,
            title: spec.title,
          });
        } catch {
          // A host that refuses this workspace's pill must not stop the others.
        }
      }
    }
  };

  const allRows = () => {
    const rows: PillWorkspace[] = [];
    for (const feed of feeds.values()) rows.push(...feed.rows.values());
    return rows;
  };
  const republish = () => sync(allRows());

  const unwatch = (key: string) => {
    const feed = feeds.get(key);
    if (feed === undefined) return;
    feeds.delete(key);
    feed.stop?.();
    void feed.release?.().catch(() => undefined);
    void feed.owned?.dispose().catch(() => undefined);
    republish();
  };

  const watch = (key: string, api: WorkspaceSource, owned?: RemoteApi) => {
    if (feeds.has(key)) return;
    const feed: Feed = { rows: new Map(), owned };
    feeds.set(key, feed);
    api.workspaces
      .list({ subscribe: {} })
      .then(({ entries, subscription }) => {
        if (disposed || feeds.get(key) !== feed) {
          void subscription.release().catch(() => undefined);
          return;
        }
        feed.release = () => subscription.release();
        for (const entry of entries) feed.rows.set(entry.id, entry);
        republish();
        feed.stop = subscription.subscribe({
          snapshot: ({ entries: next }) => {
            feed.rows.clear();
            for (const entry of next) feed.rows.set(entry.id, entry);
            republish();
          },
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            if (update.kind === "upsert") feed.rows.set(update.workspace.id, update.workspace);
            else feed.rows.delete(update.id);
            republish();
          },
        });
      })
      .catch(() => undefined);
  };

  // The app's host registry is the only source that knows every connected machine, so it is
  // the default. The daemon's own host settings are the fallback for an app without it.
  const registry = hostRegistry(client);
  let stopHosts: (() => void) | undefined;
  const watchRegistry = (hosts: HostRegistry) => {
    const syncHosts = () => {
      if (disposed) return;
      const live = new Set<string>();
      for (const host of hosts.getSnapshot()) {
        const serverId = host.serverId;
        if (typeof serverId !== "string" || serverId === "") continue;
        live.add(serverId);
        if (feeds.has(serverId)) continue;
        try {
          watch(serverId, hosts.getPaseoClient(serverId));
        } catch {
          // A host mid-reconnect is picked up by the next snapshot.
        }
      }
      for (const key of [...feeds.keys()]) {
        if (!live.has(key)) unwatch(key);
      }
    };
    syncHosts();
    stopHosts = hosts.subscribe(syncHosts);
  };

  const watchDaemonHosts = async () => {
    watch("self", paseo);
    try {
      const directory = await paseo.hosts.list();
      for (const host of directory.hosts) {
        const serverId = host.serverId;
        if (serverId === null || serverId === directory.self.serverId) continue;
        if (feeds.has(serverId)) continue;
        const api = await paseo.hosts.client(serverId);
        if (disposed) {
          void api.dispose().catch(() => undefined);
          return;
        }
        watch(serverId, api, api);
      }
    } catch {
      // A host without a host list still counts its own workspaces.
    }
  };

  let attempt = 0;
  const start = async () => {
    if (disposed) return;
    attempt += 1;
    try {
      if (registry !== null) watchRegistry(registry);
      else await watchDaemonHosts();
    } catch {
      // The app can load a plugin before its daemon is reachable; asking again keeps the
      // pills from staying missing until the plugin is reloaded by hand.
      if (disposed || attempt >= LIST_ATTEMPTS) return;
      retry = setTimeout(() => void start(), LIST_RETRY_MS);
    }
  };
  void start();

  return () => {
    disposed = true;
    if (retry !== null) clearTimeout(retry);
    stopHosts?.();
    for (const key of [...feeds.keys()]) unwatch(key);
    feeds.clear();
    for (const live of buttons.values()) live.registration.remove();
    buttons.clear();
  };
}

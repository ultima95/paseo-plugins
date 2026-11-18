import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  previewApi,
  respond,
  sendPrompt,
  useAgentTimeline,
  useWorkspaceAgents,
} from "./use-agent-preview";
import type { BoardWorkspaceCard } from "./use-board-workspaces";
import { columnAccent } from "./column-accent";
import type { ColumnId } from "./board-model";
import { displayText, type TimelineRow } from "./timeline-model";
import { isNearBottom } from "./scroll-pin";
import { QuestionForm, actionResponse, answerResponse } from "./question-form";
import type { AgentPermissionAction, AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

interface PreviewPanelProps {
  workspace: BoardWorkspaceCard;
  column: ColumnId;
  theme: PluginTheme;
  navigation?: PluginSurfaceProps["navigation"];
  /** `overlay` covers a narrow window; `side` sits beside the board at `width`. */
  variant: "side" | "overlay";
  /** The side-by-side panel's width, owned by the board so a drag can change it. */
  width: number;
  onClose(): void;
}

const MAX_PANEL_WIDTH = 460;

function rowStyle(row: TimelineRow, theme: PluginTheme) {
  switch (row.kind) {
    case "user":
      return { label: "You", icon: "User", color: theme.colors.accent };
    case "assistant":
      return { label: "Agent", icon: "Bot", color: theme.colors.foreground };
    default:
      return { label: "Error", icon: "AlertCircle", color: theme.colors.statusDanger };
  }
}

function ChatRow({ row, theme }: { row: TimelineRow; theme: PluginTheme }) {
  const tone = rowStyle(row, theme);
  const text = displayText(row);
  const styles = useMemo(
    () => ({
      row: { gap: 4, paddingVertical: 5 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      label: { fontSize: 10.5, fontWeight: "600" as const, letterSpacing: 0.2 },
      user: {
        color: theme.colors.foreground,
        fontSize: 13,
        lineHeight: 19,
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
      },
      error: {
        color: theme.colors.statusDanger,
        fontSize: 12.5,
        lineHeight: 18,
      },
    }),
    [theme],
  );

  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Icon name={tone.icon} size={11} color={tone.color} />
        <Text style={[styles.label, { color: tone.color }]}>{tone.label}</Text>
      </View>
      {row.kind === "assistant" ? (
        <Markdown>{text}</Markdown>
      ) : row.kind === "user" ? (
        <Text style={styles.user}>{text}</Text>
      ) : (
        <Text style={styles.error}>{text}</Text>
      )}
    </View>
  );
}

export function PreviewPanel({
  workspace,
  column,
  theme,
  navigation,
  variant,
  width,
  onClose,
}: PreviewPanelProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const scroll = useRef<ScrollView | null>(null);
  // Whether the reader is following the end, so a streaming reply only scrolls those who are.
  const pinned = useRef(true);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState<Record<string, boolean>>({});

  const accent = columnAccent(column, theme.colors);
  const api = useMemo(
    () => previewApi(workspace.serverId, paseo),
    [workspace.serverId, paseo],
  );
  const lookup = useWorkspaceAgents(workspace.serverId, workspace.id, paseo);
  const agents = lookup.status === "ready" ? lookup.agents : [];
  const chosen = agentId ?? agents[0]?.agentId ?? null;
  const agent = agents.find((entry) => entry.agentId === chosen) ?? null;
  const timeline = useAgentTimeline(workspace.serverId, chosen, paseo);

  useEffect(() => {
    setAgentId(null);
    setDraft("");
    setAnswered({});
    pinned.current = true;
  }, [workspace.id]);

  // A different agent starts at its newest message, not wherever the previous one was scrolled.
  useEffect(() => {
    pinned.current = true;
  }, [chosen]);

  const rows = timeline.status === "ready" ? timeline.rows : [];

  const styles = useMemo(
    () => ({
      panel: {
        width: variant === "overlay" ? ("100%" as const) : width,
        maxWidth: variant === "overlay" ? MAX_PANEL_WIDTH : undefined,
        flexGrow: 0,
        flexShrink: 0,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderLeftWidth: variant === "overlay" ? 1 : 0,
        height: "100%" as const,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: 1,
      },
      accentBar: { width: 3, height: 26, borderRadius: 2, backgroundColor: accent },
      titles: { flex: 1, gap: 2, minWidth: 0 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      sub: { color: theme.colors.foregroundMuted, fontSize: 11.5 },
      iconButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 7,
        paddingHorizontal: 9,
        paddingVertical: 6,
      },
      iconButtonText: { color: theme.colors.foreground, fontSize: 11.5, fontWeight: "600" as const },
      body: { flex: 1, minHeight: 0 },
      bodyContent: { paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
      center: { alignItems: "center" as const, paddingVertical: 40, gap: 8 },
      message: { color: theme.colors.foregroundMuted, fontSize: 12.5, textAlign: "center" as const },
      error: { color: theme.colors.statusDanger, fontSize: 12.5, textAlign: "center" as const },
      pending: { gap: 8, paddingHorizontal: 12, paddingTop: 10 },
      composer: {
        borderTopColor: theme.colors.border,
        borderTopWidth: 1,
        padding: 10,
        gap: 8,
      },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 9,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
        minHeight: 38,
        maxHeight: 120,
      },
      composerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexWrap: "wrap" as const,
      },
      agentChip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
      },
      agentChipText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      send: {
        backgroundColor: theme.colors.accent,
        borderRadius: 9,
        paddingHorizontal: 13,
        paddingVertical: 9,
      },
      sendText: { color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" as const },
      pressed: { opacity: 0.6 },
      disabled: { opacity: 0.4 },
    }),
    [theme, accent, variant, width],
  );

  async function submit() {
    const text = draft.trim();
    if (text === "" || chosen === null || sending) return;
    setSending(true);
    try {
      await sendPrompt(api, chosen, text);
      setDraft("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  async function answer(request: AgentPermissionRequest, answers: Record<string, string>) {
    if (chosen === null) return;
    setAnswered((current) => ({ ...current, [request.id]: true }));
    try {
      await respond(api, chosen, request.id, answerResponse(answers));
    } catch (error) {
      setAnswered((current) => ({ ...current, [request.id]: false }));
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function dismiss(request: AgentPermissionRequest) {
    if (chosen === null) return;
    setAnswered((current) => ({ ...current, [request.id]: true }));
    try {
      await respond(api, chosen, request.id, {
        behavior: "deny",
        message: "Dismissed from the workspace board.",
      });
    } catch (error) {
      setAnswered((current) => ({ ...current, [request.id]: false }));
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function act(request: AgentPermissionRequest, action: AgentPermissionAction) {
    if (chosen === null) return;
    setAnswered((current) => ({ ...current, [request.id]: true }));
    try {
      await respond(api, chosen, request.id, actionResponse(action));
    } catch (error) {
      setAnswered((current) => ({ ...current, [request.id]: false }));
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  function openInProject() {
    navigation?.openWorkspace({ workspaceId: workspace.id, serverId: workspace.serverId });
  }

  const pending = agent?.pending ?? [];
  const title = workspace.title ?? workspace.name;
  const meta = `${workspace.projectDisplayName} · ${workspace.hostLabel}`;
  const canSend = chosen !== null && draft.trim() !== "" && !sending;

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.accentBar} />
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {agent?.title ?? meta}
          </Text>
        </View>
        {navigation === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title} in its project`}
            onPress={openInProject}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Icon name="ExternalLink" size={12} color={theme.colors.foreground} />
            <Text style={styles.iconButtonText}>Open</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close preview"
          onPress={onClose}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      {pending.length === 0 ? null : (
        <View style={styles.pending}>
          {pending.map((request) => (
            <QuestionForm
              key={request.id}
              request={request}
              theme={theme}
              answered={answered[request.id] === true}
              onAnswer={(answers) => void answer(request, answers)}
              onDismiss={() => void dismiss(request)}
              onAction={(action) => void act(request, action)}
            />
          ))}
        </View>
      )}

      <View style={styles.body}>
        {lookup.status === "loading" || timeline.status === "loading" ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={styles.message}>Loading chat</Text>
          </View>
        ) : lookup.status === "error" ? (
          <View style={styles.center}>
            <Text style={styles.error}>Could not read agents: {lookup.message}</Text>
          </View>
        ) : lookup.status === "empty" ? (
          <View style={styles.center}>
            <Text style={styles.message}>No agent has run in this workspace yet.</Text>
          </View>
        ) : timeline.status === "error" ? (
          <View style={styles.center}>
            <Text style={styles.error}>Could not load the chat: {timeline.message}</Text>
          </View>
        ) : (
          <ScrollView
            ref={scroll}
            contentContainerStyle={styles.bodyContent}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              pinned.current = isNearBottom(
                contentOffset.y,
                contentSize.height,
                layoutMeasurement.height,
              );
            }}
            scrollEventThrottle={64}
            onContentSizeChange={() => {
              if (pinned.current) scroll.current?.scrollToEnd({ animated: false });
            }}
          >
            {rows.length === 0 ? (
              <Text style={styles.message}>This agent has no messages yet.</Text>
            ) : (
              rows.map((row) => <ChatRow key={row.key} row={row} theme={theme} />)
            )}
          </ScrollView>
        )}
      </View>

      <View style={styles.composer}>
        {agents.length > 1 ? (
          <View style={styles.composerRow}>
            {agents.map((entry) => {
              const on = entry.agentId === chosen;
              const label = entry.title ?? entry.agentId.slice(0, 8);
              return (
                <Pressable
                  key={entry.agentId}
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${label}`}
                  accessibilityState={{ selected: on }}
                  onPress={() => setAgentId(entry.agentId)}
                  style={({ pressed }) => [
                    styles.agentChip,
                    on && { borderColor: accent },
                    pressed && styles.pressed,
                  ]}
                >
                  <Icon
                    name="Bot"
                    size={11}
                    color={on ? accent : theme.colors.foregroundMuted}
                  />
                  <Text style={[styles.agentChipText, on && { color: theme.colors.foreground }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <View style={styles.composerRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={chosen === null ? "No agent to reply to" : "Reply to this agent"}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Reply to this agent"
            editable={chosen !== null}
            multiline
            style={[styles.input, { flex: 1 }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send reply"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.send,
              !canSend && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.sendText}>{sending ? "Sending…" : "Send"}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

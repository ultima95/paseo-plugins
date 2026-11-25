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
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import {
  archiveWorkspace,
  previewApi,
  respond,
  sendPrompt,
  useAgentTimeline,
  useWorkspaceAgents,
} from "./use-agent-preview";
import type { BoardWorkspaceCard } from "./use-board-workspaces";
import {
  busyLabel,
  subagentStatusLabel,
  subagentSummary,
  subagentSummaryTone,
} from "./agent-status";
import { colorWithAlpha, columnAccent } from "./column-accent";
import type { ColumnId } from "./board-model";
import { isSendKey } from "./composer-key";
import { displayText, type SubagentRow, type TimelineRow } from "./timeline-model";
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
    case "activity":
      return { label: "Work", icon: "Wrench", color: theme.colors.foregroundMuted };
    default:
      return { label: "Error", icon: "AlertCircle", color: theme.colors.statusDanger };
  }
}

/** Running subagents borrow the board's running color; finished ones its review color. */
function subagentAccent(state: SubagentRow["state"], theme: PluginTheme): string {
  if (state === "running") return columnAccent("running", theme.colors);
  if (state === "completed") return columnAccent("review", theme.colors);
  return columnAccent("needs-you", theme.colors);
}

function ChatRow({
  row,
  theme,
  head,
  streaming,
}: {
  row: TimelineRow;
  theme: PluginTheme;
  /** A new speaker starts a group; its label and avatar sit above the first message only. */
  head: boolean;
  /** The agent is still writing this row, so it keeps a caret at its end. */
  streaming: boolean;
}) {
  const tone = rowStyle(row, theme);
  const text = displayText(row);
  const styles = useMemo(
    () => ({
      row: { gap: 4, paddingVertical: 4, width: "100%" as const },
      groupGap: { paddingTop: 9 },
      userRow: { alignItems: "flex-end" as const },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      avatar: {
        width: 18,
        height: 18,
        borderRadius: 9,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: colorWithAlpha(tone.color, 0.13),
      },
      label: {
        color: tone.color,
        fontSize: 10.5,
        fontWeight: "600" as const,
        letterSpacing: 0.2,
      },
      userBubble: {
        maxWidth: "92%" as const,
        backgroundColor: theme.colors.surface2,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 7,
      },
      userText: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19 },
      error: {
        color: theme.colors.statusDanger,
        fontSize: 12.5,
        lineHeight: 18,
      },
      activityRow: { paddingVertical: 5 },
      activityLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      activityText: { color: theme.colors.foregroundMuted, fontSize: 11.5 },
    }),
    [theme, tone.color],
  );

  // The work behind a turn reads as one muted line: enough to see it happened, no list to scan.
  if (row.kind === "activity") {
    return (
      <View style={[styles.row, styles.activityRow]}>
        <View style={styles.activityLine}>
          <Icon name="Wrench" size={11} color={theme.colors.foregroundMuted} />
          <Text style={styles.activityText}>{streaming ? `${text}…` : text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.row,
        head && styles.groupGap,
        row.kind === "user" && styles.userRow,
      ]}
    >
      {head ? (
        <View style={styles.head}>
          <View style={styles.avatar}>
            <Icon name={tone.icon} size={11} color={tone.color} />
          </View>
          <Text style={styles.label}>{tone.label}</Text>
        </View>
      ) : null}
      {row.kind === "assistant" ? (
        <Markdown>{streaming ? `${text} ▍` : text}</Markdown>
      ) : row.kind === "user" ? (
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{text}</Text>
        </View>
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
  const [archiving, setArchiving] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  // The subagent list is folded behind one line: a busy agent can delegate to many at once.
  const [showSubagents, setShowSubagents] = useState(false);

  const accent = columnAccent(column, theme.colors);
  const api = useMemo(
    () => previewApi(workspace.serverId, paseo),
    [workspace.serverId, paseo],
  );
  // Older hosts have no archive API on a workspace handle; hide the button rather than fail on press.
  const canArchive = useMemo(() => {
    try {
      return typeof (api.workspaces.ref(workspace.id) as { archive?: unknown }).archive === "function";
    } catch {
      return false; // that host went offline since the board last drew
    }
  }, [api, workspace.id]);
  const lookup = useWorkspaceAgents(workspace.serverId, workspace.id, paseo);
  const agents = lookup.status === "ready" ? lookup.agents : [];
  const chosen = agentId ?? agents[0]?.agentId ?? null;
  const agent = agents.find((entry) => entry.agentId === chosen) ?? null;
  const timeline = useAgentTimeline(workspace.serverId, chosen, paseo);
  const busy = busyLabel(agent?.status ?? null);
  const busyColor = columnAccent("running", theme.colors);

  useEffect(() => {
    setAgentId(null);
    setDraft("");
    setArchiving(false);
    setConfirmingArchive(false);
    setAnswered({});
    setShowSubagents(false);
    pinned.current = true;
  }, [workspace.id]);

  // A different agent starts at its newest message, not wherever the previous one was scrolled.
  useEffect(() => {
    pinned.current = true;
    setShowSubagents(false);
  }, [chosen]);

  const rows = timeline.status === "ready" ? timeline.rows : [];
  const subagents = timeline.status === "ready" ? timeline.subagents : [];

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
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: 1,
      },
      accentBar: { width: 2, alignSelf: "stretch" as const, borderRadius: 1, backgroundColor: accent },
      titles: { flex: 1, gap: 1, minWidth: 0, paddingLeft: 6 },
      title: { color: theme.colors.foreground, fontSize: 13.5, fontWeight: "600" as const },
      subRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        minWidth: 0,
      },
      sub: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 11.5 },
      busyChip: { flexDirection: "row" as const, alignItems: "center" as const, gap: 3 },
      busySpinner: {
        width: 11,
        height: 11,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      busySpinnerIcon: { transform: [{ scale: 0.55 }] },
      busyText: { color: busyColor, fontSize: 11, fontWeight: "500" as const },
      workingRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingTop: 10,
        paddingBottom: 4,
      },
      workingText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      iconButton: {
        alignItems: "center" as const,
        justifyContent: "center" as const,
        width: 28,
        height: 28,
        borderRadius: 7,
      },
      confirm: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        backgroundColor: theme.colors.surface1,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 10,
      },
      confirmText: {
        flex: 1,
        minWidth: 140,
        color: theme.colors.foreground,
        fontSize: 12.5,
      },
      confirmCancel: { paddingHorizontal: 6, paddingVertical: 6 },
      confirmCancelText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11.5,
        fontWeight: "600" as const,
      },
      confirmArchive: {
        borderColor: theme.colors.statusDanger,
        borderWidth: 1,
        borderRadius: 7,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      confirmArchiveText: {
        color: theme.colors.statusDanger,
        fontSize: 11.5,
        fontWeight: "600" as const,
      },
      body: { flex: 1, minHeight: 0 },
      bodyContent: { paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
      center: { alignItems: "center" as const, paddingVertical: 40, gap: 8 },
      message: { color: theme.colors.foregroundMuted, fontSize: 12.5, textAlign: "center" as const },
      error: { color: theme.colors.statusDanger, fontSize: 12.5, textAlign: "center" as const },
      pending: { flexShrink: 1, minHeight: 0, maxHeight: "55%" as const },
      pendingContent: { gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
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
      summaryRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
      },
      summaryText: { flex: 1, fontSize: 11.5, fontWeight: "500" as const },
      subagentList: {
        flexShrink: 1,
        maxHeight: 132,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      subagentListContent: { padding: 8, gap: 2 },
      subagentLine: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingVertical: 3,
      },
      subagentSpinner: {
        width: 11,
        height: 11,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      subagentLabel: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 11.5,
      },
      subagentState: { fontSize: 10.5, fontWeight: "600" as const },
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
    [theme, accent, busyColor, variant, width],
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

  // Enter sends; Shift+Enter keeps the newline. An IME's Enter confirms its composition instead.
  function onKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    if (!isSendKey(event.nativeEvent)) return;
    event.preventDefault();
    void submit();
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

  async function archive() {
    if (archiving) return;
    setArchiving(true);
    try {
      await archiveWorkspace(api, workspace.id);
      onClose();
    } catch (error) {
      setArchiving(false);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  const pending = agent?.pending ?? [];
  const title = workspace.title ?? workspace.name;
  const meta = `${workspace.projectDisplayName} · ${workspace.hostLabel}`;
  const canSend = chosen !== null && draft.trim() !== "" && !sending;
  const summary = subagentSummary(subagents);
  const summaryTone = subagentSummaryTone(subagents);
  const summaryColor =
    summaryTone === "failed"
      ? theme.colors.statusDanger
      : summaryTone === "running"
        ? columnAccent("running", theme.colors)
        : theme.colors.foregroundMuted;

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.accentBar} />
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.subRow}>
            <Text style={styles.sub} numberOfLines={1}>
              {agent?.title ?? meta}
            </Text>
            {busy === null ? null : (
              <View
                accessible
                accessibilityLabel={`Agent is ${busy.toLowerCase()}`}
                style={styles.busyChip}
              >
                <View style={styles.busySpinner}>
                  <ActivityIndicator
                    size="small"
                    color={busyColor}
                    style={styles.busySpinnerIcon}
                  />
                </View>
                <Text style={styles.busyText}>{busy}</Text>
              </View>
            )}
          </View>
        </View>
        {navigation === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title} in its project`}
            onPress={openInProject}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Icon name="ExternalLink" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        )}
        {canArchive ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Archive ${title}`}
            accessibilityState={{ disabled: archiving, expanded: confirmingArchive }}
            disabled={archiving}
            onPress={() => setConfirmingArchive(true)}
            style={({ pressed }) => [
              styles.iconButton,
              archiving && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Icon name="Archive" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close preview"
          onPress={onClose}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Icon name="X" size={15} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      {confirmingArchive ? (
        <View style={styles.confirm}>
          <Icon name="AlertTriangle" size={13} color={theme.colors.statusDanger} />
          <Text style={styles.confirmText} numberOfLines={2}>
            Archive “{title}”? It leaves the board.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel archiving"
            disabled={archiving}
            onPress={() => setConfirmingArchive(false)}
            style={({ pressed }) => [
              styles.confirmCancel,
              archiving && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.confirmCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Confirm archiving ${title}`}
            accessibilityState={{ disabled: archiving }}
            disabled={archiving}
            onPress={() => void archive()}
            style={({ pressed }) => [
              styles.confirmArchive,
              archiving && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.confirmArchiveText}>
              {archiving ? "Archiving…" : "Archive"}
            </Text>
          </Pressable>
        </View>
      ) : null}

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
              rows.map((row, index) => (
                <ChatRow
                  key={row.key}
                  row={row}
                  theme={theme}
                  head={index === 0 || rows[index - 1]?.kind !== row.kind}
                  streaming={
                    busy !== null && index === rows.length - 1 && row.kind !== "user"
                  }
                />
              ))
            )}
            {/* A trailing activity line already reads as live, so this row would say it twice. */}
            {busy === null || rows[rows.length - 1]?.kind === "activity" ? null : (
              <View
                accessible
                accessibilityLabel={`Agent is ${busy.toLowerCase()}`}
                style={styles.workingRow}
              >
                <View style={styles.busySpinner}>
                  <ActivityIndicator
                    size="small"
                    color={busyColor}
                    style={styles.busySpinnerIcon}
                  />
                </View>
                <Text style={styles.workingText}>{busy}…</Text>
              </View>
            )}
          </ScrollView>
        )}
      </View>

      {pending.length === 0 ? null : (
        <ScrollView
          style={styles.pending}
          contentContainerStyle={styles.pendingContent}
          keyboardShouldPersistTaps="handled"
        >
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
        </ScrollView>
      )}

      <View style={styles.composer}>
        {subagents.length === 0 ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${showSubagents ? "Hide" : "Show"} subagents, ${summary}`}
            accessibilityState={{ expanded: showSubagents }}
            onPress={() => setShowSubagents((value) => !value)}
            style={({ pressed }) => [styles.summaryRow, pressed && styles.pressed]}
          >
            <Icon
              name={summaryTone === "running" ? "Loader" : "GitBranch"}
              size={12}
              color={summaryColor}
            />
            <Text style={[styles.summaryText, { color: summaryColor }]} numberOfLines={1}>
              {summary}
            </Text>
            <Icon
              name={showSubagents ? "ChevronDown" : "ChevronRight"}
              size={13}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        )}
        {subagents.length === 0 || !showSubagents ? null : (
          <ScrollView style={styles.subagentList} contentContainerStyle={styles.subagentListContent}>
            {subagents.map((subagent) => {
              const tone = subagentAccent(subagent.state, theme);
              const stateLabel = subagentStatusLabel(subagent.state);
              return (
                <View
                  key={subagent.id}
                  accessible
                  accessibilityLabel={`${subagent.label} ${stateLabel}`}
                  style={styles.subagentLine}
                >
                  {subagent.state === "running" ? (
                    <View style={styles.subagentSpinner}>
                      <ActivityIndicator
                        size="small"
                        color={tone}
                        style={styles.busySpinnerIcon}
                      />
                    </View>
                  ) : (
                    <Icon
                      name={subagent.state === "completed" ? "Check" : "AlertCircle"}
                      size={11}
                      color={tone}
                    />
                  )}
                  <Text style={styles.subagentLabel} numberOfLines={1}>
                    {subagent.label}
                  </Text>
                  <Text style={[styles.subagentState, { color: tone }]}>{stateLabel}</Text>
                </View>
              );
            })}
          </ScrollView>
        )}
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
            onKeyPress={onKeyPress}
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

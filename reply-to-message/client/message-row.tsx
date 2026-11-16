import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, useComposers } from "@getpaseo/plugin/client";
import { Icon, Markdown, StreamedText, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { buildQuote, formatTimestamp, ownerLabel, type MessageRowData } from "../shared/message-row";

type MessageRowProps = PluginTimelineItemProps<MessageRowData>;

/** The Pressable style shared by Copy and Reply, including the pressed state. */
function actionStyle(theme: PluginTheme, pressed: boolean) {
  return {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 2,
    opacity: pressed ? 0.55 : 1,
    color: theme.colors.foregroundMuted,
  };
}

/**
 * Reply for one reply, quoting it into this agent's composer.
 *
 * The composer subscription lives in this leaf rather than in the row, because it
 * re-renders whenever the agent's composer changes and typing fires one change per
 * keystroke. Kept here, a keystroke re-renders these small buttons and not the message
 * body or its Markdown.
 */
function ReplyButton({
  agentId,
  text,
  owner,
  theme,
}: {
  agentId: string;
  text: string;
  owner: string | null;
  theme: PluginTheme;
}) {
  const toast = useToast();
  const composers = useComposers({ agentId });
  const composer = composers[0] ?? null;

  async function reply() {
    if (!composer) {
      toast.error("This agent has no composer to reply into.");
      return;
    }
    const quote = buildQuote(text, owner);
    if (quote === null) {
      toast.error("This message has no text to quote.");
      return;
    }
    try {
      composer.insertText(quote);
      await composer.focus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Reply to this message"
      hitSlop={8}
      onPress={reply}
      style={({ pressed }) => actionStyle(theme, pressed)}
    >
      <Icon name="Reply" size={12} color={theme.colors.accent} />
      <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>Reply</Text>
    </Pressable>
  );
}

/**
 * One agent reply with Copy and Reply.
 *
 * This row replaces Paseo's for a reply, so it carries what the user still needs from it:
 * the Markdown, its timestamp, and Copy. Reply hands the message to the agent's composer as
 * a blockquote, where the user edits and sends it like any other prompt.
 *
 * Your own messages are not drawn here: Paseo's own row keeps them, which is what lets an
 * image attached to one of them render.
 */
export function MessageRow({ agentId, item, timestamp, theme, layout }: MessageRowProps) {
  const toast = useToast();
  const { text, phase } = item.data;
  // The agent that wrote this reply. Read through a selector so a change to its status
  // or activity does not re-render the row, and so the row still draws when it is gone.
  // `title` is not read: Paseo derives it from the first prompt, so it is the task text.
  const agent = useAgent(agentId, (snapshot) => ({
    provider: snapshot.provider,
    model: snapshot.model,
  }));
  const ownerName = ownerLabel(agent);
  // Paseo hides a message's action row until the pointer is on it, but a touch screen has
  // no hover to reveal it with, so there it stays out. Same rule as Paseo's own message
  // row: compact, native, or hovered.
  const [hovered, setHovered] = useState(false);
  const showActions = layout.compact || layout.platform !== "web" || hovered;

  const styles = useMemo(
    () => ({
      // No vertical padding of our own: Paseo already gaps the rows around a timeline item
      // (spacing.ts keys off the item kind, and every plugin row gets its default gap), so
      // adding padding here doubled the space between messages.
      row: { flexDirection: "column" as const, gap: 4 },
      body: {
        maxWidth: "100%" as const,
        paddingHorizontal: 2,
        // Paseo's own assistant rows carry vertical padding, and the host gap alone reads
        // tight around a paragraph once our row padding is gone.
        paddingVertical: 4,
      },
      // Paseo reserves a fixed-height trailing row under its own message rows and fades it in
      // on hover (height 24, opacity 0 to 1). Same trick here: the strip is always laid out,
      // so revealing the buttons cannot grow the row or shove the reply below it down. The
      // cost is a strip of reserved space per reply, which is the price of no layout jump.
      metaRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
        paddingHorizontal: 2,
        height: 20,
        opacity: showActions ? 1 : 0,
      },
      time: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, showActions],
  );

  async function copy() {
    try {
      await copyText(text);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  }

  // A reply still streaming has no settled text to quote or copy yet.
  const settled = phase === "complete";

  return (
    <View
      style={styles.row}
      // Pointer handlers live on the row, not on the buttons: the row is what shows the
      // actions, and the buttons inside it must not each run their own hover state.
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <View style={styles.body}>
        {settled ? <Markdown>{text}</Markdown> : <StreamedText text={text} phase={phase} />}
      </View>
      {/* Always laid out at a fixed height and faded in on hover, so the buttons appearing
          cannot move anything below. `pointerEvents` keeps an invisible button from taking a
          click the user cannot see. */}
      <View style={styles.metaRow} pointerEvents={showActions ? "auto" : "none"}>
        <Text style={styles.time}>{formatTimestamp(timestamp)}</Text>
        {settled ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy reply"
              hitSlop={8}
              onPress={copy}
              style={({ pressed }) => actionStyle(theme, pressed)}
            >
              <Icon name="Copy" size={12} color={theme.colors.foregroundMuted} />
              <Text
                style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}
              >
                Copy
              </Text>
            </Pressable>
            <ReplyButton agentId={agentId} text={text} owner={ownerName} theme={theme} />
          </>
        ) : null}
      </View>
    </View>
  );
}

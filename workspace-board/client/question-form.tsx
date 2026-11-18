import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  JsonValue,
} from "@getpaseo/protocol/agent-types";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

/** One entry of a `question` permission request's `input.questions`. */
interface QuestionSpec {
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The questions a request asks, or none when the host sent a form this preview cannot draw. */
function questionSpecs(request: AgentPermissionRequest): readonly QuestionSpec[] {
  const input = asRecord(request.input);
  const list = Array.isArray(input?.questions) ? input.questions : [];
  const specs: QuestionSpec[] = [];
  for (const [index, value] of list.entries()) {
    const question = asRecord(value);
    const text = asText(question?.question);
    if (question === null || text === undefined) continue;
    const options: { label: string; description?: string }[] = [];
    for (const entry of Array.isArray(question.options) ? question.options : []) {
      const label = typeof entry === "string" ? asText(entry) : asText(asRecord(entry)?.label);
      if (label === undefined) continue;
      const description = asText(asRecord(entry)?.description);
      options.push(description === undefined ? { label } : { label, description });
    }
    specs.push({
      header: asText(question.header) ?? `Question ${index + 1}`,
      question: text,
      options,
      multiSelect: question.multiSelect === true,
    });
  }
  return specs;
}

/** What the request asks, when it is something other than a question form. */
function requestTitle(request: AgentPermissionRequest): string {
  if (request.kind === "question") return request.title ?? "Question";
  if (request.kind === "plan") return request.title ?? "Review plan";
  if (request.kind === "mode") return request.title ?? "Change mode";
  return request.title ?? request.name;
}

/** The tool action's one-line subject, for a request that only asks to allow or deny a call. */
function requestDetail(request: AgentPermissionRequest): string | null {
  const input = asRecord(request.input);
  if (input === null) return request.description ?? null;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url"]) {
    const value = asText(input[key]);
    if (value !== undefined) return value;
  }
  return request.description ?? null;
}

interface QuestionFormProps {
  request: AgentPermissionRequest;
  theme: PluginTheme;
  answered: boolean;
  onAnswer(answers: Record<string, string>): void;
  onDismiss(): void;
  /** A request that ships its own buttons, such as a tool prompt's Allow session / Allow once. */
  onAction?(action: AgentPermissionAction): void;
}

/**
 * The answer form for one pending request. A question asks each of its entries, with its
 * options plus a free-text answer; any other request offers its own actions, so a tool prompt
 * still reads as Allow or Deny rather than a blank form.
 */
export function QuestionForm({
  request,
  theme,
  answered,
  onAnswer,
  onDismiss,
  onAction,
}: QuestionFormProps) {
  const specs = useMemo(() => questionSpecs(request), [request]);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  const styles = useMemo(
    () => ({
      card: {
        gap: 10,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      title: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      prompt: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
      options: { gap: 6 },
      option: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      },
      optionOn: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface2,
      },
      optionLabel: { flex: 1, color: theme.colors.foreground, fontSize: 12.5 },
      optionHint: { color: theme.colors.foregroundMuted, fontSize: 11 },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 12.5,
      },
      actions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexWrap: "wrap" as const,
      },
      submit: {
        backgroundColor: theme.colors.accent,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
      },
      submitText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
      secondary: {
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
      },
      secondaryText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      pressed: { opacity: 0.6 },
      note: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme],
  );

  if (answered) {
    return (
      <View style={styles.card}>
        <Text style={styles.note}>Answered.</Text>
      </View>
    );
  }

  function toggle(header: string, label: string, multi: boolean) {
    setPicked((current) => {
      const selected = current[header] ?? [];
      if (!multi) return { ...current, [header]: selected.includes(label) ? [] : [label] };
      return {
        ...current,
        [header]: selected.includes(label)
          ? selected.filter((entry) => entry !== label)
          : [...selected, label],
      };
    });
  }

  function submit() {
    const answers: Record<string, string> = {};
    for (const spec of specs) {
      const typedText = (typed[spec.header] ?? "").trim();
      const chosen = picked[spec.header] ?? [];
      const value = typedText !== "" ? typedText : chosen.join(", ");
      if (value !== "") answers[spec.header] = value;
    }
    onAnswer(answers);
  }

  const ready =
    specs.length === 0 ||
    specs.every((spec) => {
      const typedText = (typed[spec.header] ?? "").trim();
      return typedText !== "" || (picked[spec.header] ?? []).length > 0;
    });

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon
          name={request.kind === "question" ? "MessageSquare" : "Shield"}
          size={13}
          color={theme.colors.statusWarning}
        />
        <Text style={styles.title}>{requestTitle(request)}</Text>
      </View>

      {specs.length === 0 ? (
        <>
          {requestDetail(request) === null ? null : (
            <Text style={styles.detail} numberOfLines={3}>
              {requestDetail(request)}
            </Text>
          )}
          <View style={styles.actions}>
            {(request.actions ?? []).length > 0 && onAction !== undefined ? (
              (request.actions ?? []).map((action) => (
                <Pressable
                  key={action.id}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  onPress={() => onAction(action)}
                  style={({ pressed }) => [
                    action.behavior === "allow" ? styles.submit : styles.secondary,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={action.behavior === "allow" ? styles.submitText : styles.secondaryText}
                  >
                    {action.label}
                  </Text>
                </Pressable>
              ))
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Allow ${requestTitle(request)}`}
                  onPress={() => onAnswer({})}
                  style={({ pressed }) => [styles.submit, pressed && styles.pressed]}
                >
                  <Text style={styles.submitText}>Allow</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Deny ${requestTitle(request)}`}
                  onPress={onDismiss}
                  style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>Deny</Text>
                </Pressable>
              </>
            )}
          </View>
        </>
      ) : (
        <>
          {specs.map((spec) => {
            const selected = picked[spec.header] ?? [];
            return (
              <View key={spec.header} style={styles.options}>
                <View style={styles.header}>
                  <Text style={styles.title}>{spec.header}</Text>
                </View>
                <Text style={styles.prompt}>{spec.question}</Text>
                {spec.options.map((option) => {
                  const on = selected.includes(option.label);
                  return (
                    <Pressable
                      key={option.label}
                      accessibilityRole="button"
                      accessibilityLabel={option.label}
                      accessibilityState={{ selected: on }}
                      onPress={() => toggle(spec.header, option.label, spec.multiSelect)}
                      style={({ pressed }) => [
                        styles.option,
                        on && styles.optionOn,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Icon
                        name={on ? "Check" : "Square"}
                        size={13}
                        color={on ? theme.colors.accent : theme.colors.foregroundMuted}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.optionLabel}>{option.label}</Text>
                        {option.description === undefined ? null : (
                          <Text style={styles.optionHint}>{option.description}</Text>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
                <TextInput
                  value={typed[spec.header] ?? ""}
                  onChangeText={(text) => setTyped((current) => ({ ...current, [spec.header]: text }))}
                  placeholder={spec.options.length === 0 ? "Your answer" : "Or type another answer"}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  accessibilityLabel={`Answer for ${spec.header}`}
                  multiline
                  style={styles.input}
                />
              </View>
            );
          })}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send answers"
              accessibilityState={{ disabled: !ready }}
              disabled={!ready}
              onPress={submit}
              style={({ pressed }) => [
                styles.submit,
                !ready && styles.pressed,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.submitText}>Answer</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss the question"
              onPress={onDismiss}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Dismiss</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

/** The permission response that carries a question's answers to the provider. */
export function answerResponse(answers: Record<string, string>): {
  behavior: "allow";
  updatedInput: Record<string, JsonValue>;
} {
  return { behavior: "allow", updatedInput: { answers } };
}

/** The response an action button sends: allow or deny, naming the action the host offered. */
export function actionResponse(action: AgentPermissionAction): {
  behavior: "allow" | "deny";
  selectedActionId: string;
} {
  return { behavior: action.behavior, selectedActionId: action.id };
}

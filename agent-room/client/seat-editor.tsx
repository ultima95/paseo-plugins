import { usePaseo } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import type { SeatDraft, SeatPatch } from "./settings-draft";

/** The host props every piece of this screen needs: theme colours and density. */
export type Surface = Pick<PluginScreenProps, "theme" | "layout">;

/** The host theme, named so it can be used as a generic argument safely. */
export type Theme = PluginScreenProps["theme"];

/** Padding and gaps follow the host's density, never a fixed pixel size. */
export function paddingFor(layout: Surface["layout"]): number {
  return layout.compact ? 8 : 12;
}

/** Any thrown value as one line of text a person can read. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface Choice {
  id: string;
  label: string;
}

export interface ProviderOption {
  provider: string;
  label: string;
}

interface ModelChoice extends Choice {
  thinkingOptions: Choice[];
  defaultThinkingOptionId?: string;
}

type FeatureDescriptor =
  | { kind: "toggle"; id: string; label: string; value: boolean }
  | { kind: "select"; id: string; label: string; value: string; options: Choice[] };

export interface ProviderCatalog {
  providers: ProviderOption[];
  loading: boolean;
  error: string;
}

/** Provider list for every seat on the screen; loaded once by the screen. */
export function useProviderCatalog(): ProviderCatalog {
  const paseo = usePaseo();
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    paseo.providers
      .snapshot()
      .then((snapshot) => {
        if (cancelled) return;
        const options = snapshot.entries
          .filter((entry) => entry.enabled !== false)
          .map((entry) => ({ provider: entry.provider, label: entry.label ?? entry.provider }));
        setProviders(options);
        setLoading(false);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(describeError(caught));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  return { providers, loading, error };
}

/* ------------------------------------------------------------------ *
 * Small building blocks shared by the seat editor, the launch form
 * and the room list.
 * ------------------------------------------------------------------ */

export function Section(props: { surface: Surface; title: string; subtitle?: string; children: ReactNode }) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: pad,
        gap: pad,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{props.title}</Text>
      {props.subtitle ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{props.subtitle}</Text>
      ) : null}
      {props.children}
    </View>
  );
}

export function Field(props: { surface: Surface; label: string; children: ReactNode }) {
  const { theme } = props.surface;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{props.label}</Text>
      {props.children}
    </View>
  );
}

/** A wrapped row of selectable chips: the only picker this screen needs. */
export function ChoiceRow(props: {
  surface: Surface;
  options: Choice[];
  value: string;
  disabled?: boolean;
  onSelect(id: string): void;
}) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  if (props.options.length === 0) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>none available</Text>;
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {props.options.map((option) => {
        const selected = option.id === props.value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            disabled={props.disabled}
            onPress={() => props.onSelect(option.id)}
            style={{
              backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              borderWidth: 1,
              borderRadius: 999,
              paddingHorizontal: pad + 2,
              paddingVertical: Math.max(3, Math.round(pad / 3)),
              opacity: props.disabled ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: selected ? theme.colors.accentForeground : theme.colors.foreground,
                fontSize: 12,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ActionButton(props: {
  surface: Surface;
  label: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        backgroundColor: theme.colors.accent,
        borderRadius: 8,
        paddingHorizontal: pad + 4,
        paddingVertical: Math.max(6, Math.round(pad / 2)),
        opacity: props.disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" }}>{props.label}</Text>
    </Pressable>
  );
}

export function TextEntry(props: {
  surface: Surface;
  value: string;
  placeholder: string;
  multiline?: boolean;
  /**
   * Locks the field. Typed text that the caller will discard (a draft made
   * while the stored document is still loading or a save is in flight) must
   * not be typeable in the first place.
   */
  disabled?: boolean;
  onChangeText(text: string): void;
}) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  return (
    <TextInput
      value={props.value}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      multiline={props.multiline}
      autoCapitalize="none"
      autoCorrect={false}
      editable={props.disabled !== true}
      onChangeText={props.onChangeText}
      style={{
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        color: theme.colors.foreground,
        fontSize: 13,
        padding: pad,
        minHeight: props.multiline ? pad * 6 : undefined,
        textAlignVertical: props.multiline ? "top" : "center",
        opacity: props.disabled ? 0.5 : 1,
      }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * The seat editor
 * ------------------------------------------------------------------ */

export interface SeatEditorProps extends Surface {
  label: string;
  seat: SeatDraft;
  providers: ProviderOption[];
  /**
   * The directory the seat will run in. Provider features are declared per
   * provider, model and directory, so this is what `listFeatures` asks about.
   * Empty until the launch target names one.
   */
  cwd: string;
  disabled?: boolean;
  onChange(patch: SeatPatch): void;
  /** Peer tiers carry what they are for; the seats do not. */
  useFor?: string;
  onUseForChange?(text: string): void;
  onRemove?(): void;
}

/**
 * One seat: provider, model, mode, thinking effort and provider features.
 *
 * The pickers offer every value the daemon reports plus the value already
 * stored, so a seat that references a mode or model the provider no longer
 * lists still shows what it is set to.
 */
export function SeatEditor(props: SeatEditorProps) {
  const { theme, layout, seat } = props;
  const paseo = usePaseo();
  const surface: Surface = { theme, layout };
  const pad = paddingFor(layout);

  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modes, setModes] = useState<Choice[]>([]);
  const [features, setFeatures] = useState<FeatureDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const provider = seat.provider;
  const model = seat.model;

  useEffect(() => {
    // The model and mode lists belong to one provider. They are cleared before
    // the new fetch, not after it: leaving the previous provider's catalog on
    // screen keeps its chips pressable while the new lists load, which is how a
    // Claude model ends up written onto a codex seat.
    setModels([]);
    setModes([]);
    if (!provider) {
      setError("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([paseo.providers.listModels(provider), paseo.providers.listModes(provider)])
      .then((results) => {
        if (cancelled) return;
        const modelResult = results[0];
        const modeResult = results[1];
        setModels(
          (modelResult.models ?? []).map((entry) => ({
            id: entry.id,
            label: entry.label,
            thinkingOptions: (entry.thinkingOptions ?? []).map((option) => ({
              id: option.id,
              label: option.label,
            })),
            defaultThinkingOptionId: entry.defaultThinkingOptionId,
          })),
        );
        setModes((modeResult.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })));
        setError(modelResult.error ?? modeResult.error ?? "");
        setLoading(false);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(describeError(caught));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, provider]);

  const featureCwd = props.cwd.trim();

  useEffect(() => {
    // Feature ids are declared per provider and model. The previous pair's
    // features are dropped before the new lookup, so a stale toggle can never be
    // pressed against the seat's new provider or model.
    setFeatures([]);
    // `listFeatures` needs a directory; an empty one is not a provider call, so
    // nothing loads until the launch target names a workspace or a cwd.
    if (!provider || !model || featureCwd.length === 0) {
      return;
    }
    let cancelled = false;
    paseo.providers
      .listFeatures({ provider: `${provider}/${model}`, cwd: featureCwd })
      .then((result) => {
        if (cancelled) return;
        setFeatures(
          (result.features ?? []).flatMap((feature): FeatureDescriptor[] => {
            if (feature.type === "toggle") {
              const toggle: FeatureDescriptor = {
                kind: "toggle",
                id: feature.id,
                label: feature.label,
                value: feature.value,
              };
              return [toggle];
            }
            if (feature.type === "select") {
              const select: FeatureDescriptor = {
                kind: "select",
                id: feature.id,
                label: feature.label,
                value: feature.value ?? "",
                options: feature.options.map((option) => ({ id: option.id, label: option.label })),
              };
              return [select];
            }
            // Feature kinds this screen does not know how to render are dropped.
            return [];
          }),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setFeatures([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, provider, model, featureCwd]);

  const providerChoices = withCurrent(
    props.providers.map((option) => ({ id: option.provider, label: option.label })),
    seat.provider,
  );
  const modelChoices = withCurrent(
    models.map((choice) => ({ id: choice.id, label: choice.label })),
    seat.model,
  );
  const selectedModel = models.find((candidate) => candidate.id === seat.model);
  const thinkingChoices: Choice[] = selectedModel ? selectedModel.thinkingOptions : [];
  const modeChoices: Choice[] = [{ id: "", label: "provider default" }, ...withCurrent(modes, seat.modeId)];
  const thinkingPicks: Choice[] = [
    { id: "", label: "model default" },
    ...withCurrent(thinkingChoices, seat.thinkingOptionId),
  ];

  function chooseProvider(next: string) {
    if (next === seat.provider) return;
    // A provider change drops the old provider's model, mode, thinking level
    // and feature values: none of them mean anything on the new provider.
    props.onChange({ provider: next });
  }

  function chooseModel(next: string) {
    const choice = models.find((candidate) => candidate.id === next);
    const optionIds = choice ? choice.thinkingOptions.map((option) => option.id) : [];
    const keepThinking = seat.thinkingOptionId !== undefined && optionIds.includes(seat.thinkingOptionId);
    const fallbackThinking = choice ? choice.defaultThinkingOptionId ?? optionIds[0] : undefined;
    // Feature ids are declared per provider and model, so a model change drops
    // the stored values for the same reason a provider change does.
    props.onChange({
      model: next,
      thinkingOptionId: keepThinking ? seat.thinkingOptionId : fallbackThinking,
      features: undefined,
    });
  }

  function chooseMode(next: string) {
    props.onChange({ modeId: next === "" ? undefined : next });
  }

  function chooseThinking(next: string) {
    props.onChange({ thinkingOptionId: next === "" ? undefined : next });
  }

  function setFeature(id: string, value: unknown) {
    const features = { ...(seat.features ?? {}) };
    features[id] = value;
    props.onChange({ features });
  }

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: pad,
        gap: pad,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: pad }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{props.label}</Text>
        {props.onRemove ? (
          <Pressable
            accessibilityRole="button"
            disabled={props.disabled}
            onPress={props.onRemove}
            style={{
              borderColor: theme.colors.border,
              borderWidth: 1,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 3,
            }}
          >
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>Remove</Text>
          </Pressable>
        ) : null}
      </View>

      <Field surface={surface} label="Provider">
        <ChoiceRow
          surface={surface}
          options={providerChoices}
          value={seat.provider}
          disabled={props.disabled}
          onSelect={chooseProvider}
        />
      </Field>

      <Field surface={surface} label="Model">
        <ChoiceRow
          surface={surface}
          options={modelChoices}
          value={seat.model ?? ""}
          disabled={props.disabled}
          onSelect={chooseModel}
        />
      </Field>

      <Field surface={surface} label="Mode">
        <ChoiceRow
          surface={surface}
          options={modeChoices}
          value={seat.modeId ?? ""}
          disabled={props.disabled}
          onSelect={chooseMode}
        />
      </Field>

      {thinkingChoices.length > 0 ? (
        <Field surface={surface} label="Thinking">
          <ChoiceRow
            surface={surface}
            options={thinkingPicks}
            value={seat.thinkingOptionId ?? ""}
            disabled={props.disabled}
            onSelect={chooseThinking}
          />
        </Field>
      ) : null}

      {props.onUseForChange ? (
        <Field surface={surface} label="Use for">
          <TextEntry
            surface={surface}
            value={props.useFor ?? ""}
            placeholder="What this tier is for"
            disabled={props.disabled}
            onChangeText={props.onUseForChange}
          />
        </Field>
      ) : null}

      {features.map((feature) => (
        <Field key={feature.id} surface={surface} label={feature.label}>
          <ChoiceRow
            surface={surface}
            options={
              feature.kind === "toggle"
                ? [
                    { id: "on", label: "On" },
                    { id: "off", label: "Off" },
                  ]
                : feature.options
            }
            value={
              feature.kind === "toggle"
                ? featureValue(seat, feature.id) === false
                  ? "off"
                  : featureValue(seat, feature.id) === true
                    ? "on"
                    : feature.value
                      ? "on"
                      : "off"
                : storedText(seat, feature.id) ?? feature.value
            }
            disabled={props.disabled}
            onSelect={(id) => setFeature(feature.id, feature.kind === "toggle" ? id === "on" : id)}
          />
        </Field>
      ))}

      {loading ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Loading provider catalog…</Text>
      ) : null}
      {error ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

/** The stored value of a feature, or `undefined` when this seat never set it. */
function featureValue(seat: SeatDraft, id: string): unknown {
  return (seat.features ?? {})[id];
}

function storedText(seat: SeatDraft, id: string): string | undefined {
  const value = featureValue(seat, id);
  return typeof value === "string" ? value : undefined;
}

/** Keep the stored value selectable even when the provider no longer lists it. */
function withCurrent(options: Choice[], current: string | undefined): Choice[] {
  if (!current || options.some((option) => option.id === current)) return options;
  return [{ id: current, label: current }, ...options];
}

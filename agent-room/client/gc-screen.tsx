import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { gcSettingsDefinition, type GcAction, type GcSettingsDocument } from "../shared/gc";
import { gcRunRpc, gcStatusRpc } from "../shared/rpc";
import type { RuleKey, StatusTone, ThresholdDraft, ThresholdKey } from "./gc-view-model";
import {
  actionRows,
  ruleConfirm,
  ruleValue,
  settingsNotice,
  thresholdDraft,
  toGcRows,
  validateThresholds,
} from "./gc-view-model";
import type { Surface, Theme } from "./seat-editor";
import { ActionButton, Section, TextEntry, describeError, paddingFor } from "./seat-editor";

/** The tick runs every minute; the screen only has to keep up with the clock. */
const POLL_INTERVAL_MS = 2000;

/** A status payload can carry one row per record (hundreds). The list is capped. */
const LIST_LIMIT = 50;

/** Query key: this plugin's own namespace, one entry for the whole screen. */
const STATUS_QUERY_KEY = ["agent-room", "gc", "status"];

/** The three acting knobs, in the order they gate each other. */
const RULES: { key: RuleKey; label: string; hint: string }[] = [
  {
    key: "apply",
    label: "Reclaim records",
    hint: "Deletes completed room schedules and agents archived for at least 14 d. The other two rules cannot act without it.",
  },
  {
    key: "killStale",
    label: "SIGTERM stale orphans",
    hint: "Signals processes the lineage ledger proves are orphans, and only process names on the kill list.",
  },
  {
    key: "killMemory",
    label: "SIGTERM over memory",
    hint: "Signals the one proven orphan above the memory kill threshold.",
  },
];

/**
 * The three thresholds the design says are editable through settings. The
 * reference's `SLP_GC_MEM_WARN_MB`, `SLP_GC_MEM_KILL_MB` and
 * `SLP_GC_TREE_WARN_MB`, in whole megabytes.
 */
const THRESHOLDS: { key: ThresholdKey; label: string; placeholder: string; hint: string }[] = [
  {
    key: "memWarnMb",
    label: "Warn per process (MB)",
    placeholder: "3072",
    hint: "A process at or above this footprint is flagged in the tables and in the alert.",
  },
  {
    key: "memKillMb",
    label: "Memory kill (MB)",
    placeholder: "4096",
    hint: "At least 1024 MB, and never below the warn threshold. The daemon is never memory-killed.",
  },
  {
    key: "treeWarnMb",
    label: "Warn for the Paseo tree (MB)",
    placeholder: "half of RAM",
    hint: "Blank means half of physical RAM, which is the reference's default.",
  },
];


/** One `gc.run` the user started from this screen. */
interface RunEntry {
  id: string;
  mode: "report" | "act";
  at: string;
  actions: GcAction[];
}

function toneColor(theme: Theme, tone: StatusTone): string {
  switch (tone) {
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "muted":
      return theme.colors.foregroundMuted;
    default:
      return theme.colors.foreground;
  }
}

/** Local wall clock for run entries. A runtime without locale data still renders. */
function nowText(): string {
  const now = new Date();
  try {
    return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return now.toISOString();
  }
}

function StatusLine(props: { surface: Surface; label: string; value: string; tone: StatusTone }) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: pad }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, minWidth: 96, width: 132 }}>
        {props.label}
      </Text>
      <Text style={{ color: toneColor(theme, props.tone), fontSize: 12, flex: 1 }}>{props.value}</Text>
    </View>
  );
}

/**
 * The GC screen: what the last tick saw, what it would do, and the three rules
 * and three thresholds that decide whether it does it.
 *
 * The screen is a window on `gc.status` — the last tick's captured result,
 * re-read every 2 s — plus two buttons that run one tick now (`gc.run`). It
 * starts nothing on its own, and it never re-derives a verdict the tick already
 * made: the candidate and process lists, the index verdict, the ledger and the
 * alert history all carry the tick's own answers, so what is shown here is what a
 * scheduled tick would do. A field the tick has published as unknown reads "no
 * data yet", which is the fresh-install state.
 *
 * Rules and thresholds are saved to the plugin's `gc` settings document, which is
 * layered over the imported `slp-gc.conf`. A toggle only moves after its
 * confirmation is accepted; cancelling leaves the stored value exactly as it was.
 * Turning a rule on is the destructive direction, so its panel names the targets
 * precisely. A threshold is saved only when the draft passes `validateThresholds`
 * — the reference's floors and the kill-above-warn rule — and an invalid draft
 * shows its error inline instead of being clamped behind the user's back.
 */
export function GcScreen(props: PluginScreenProps) {
  const { theme, layout } = props;
  const surface: Surface = { theme, layout };
  const pad = paddingFor(layout);

  const fetchStatus = useRpc(gcStatusRpc);
  const runTick = useRpc(gcRunRpc);
  const settings = useSettings(gcSettingsDefinition);

  const query = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => fetchStatus({}),
    // 2 s while mounted. The screen unmounts when it is not open, so this stops
    // with it; `useQuery` also cancels the interval on blur and window blur.
    refetchInterval: POLL_INTERVAL_MS,
  });

  /** The rule whose confirmation is open, and the value it would save. */
  const [pending, setPending] = useState<{ rule: RuleKey; next: boolean } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [thresholds, setThresholds] = useState<ThresholdDraft | null>(null);
  const [thresholdError, setThresholdError] = useState("");
  const [busy, setBusy] = useState<"" | "report" | "act">("");
  const [runError, setRunError] = useState("");
  const [runs, setRuns] = useState<RunEntry[]>([]);

  // A save needs a revision to write against. An invalid document supplies one
  // too: saving replaces it with a document built from the values on screen.
  const revision = settings.status === "ready" || settings.status === "invalid" ? settings.revision : null;
  const overrides: GcSettingsDocument = settings.status === "ready" ? settings.values : {};

  const data = query.data ?? null;
  const rows = data === null ? null : toGcRows(data);
  // What the settings store itself has to say, before anything below can be
  // edited: an unreadable store, or a saved document that does not parse.
  const notice = settingsNotice(settings);

  // Before the first status answers, only the saved document can be known.
  const ruleOn = (key: RuleKey): boolean =>
    data === null ? overrides[key] === true : ruleValue(overrides, data, key);

  const applyOn = ruleOn("apply");

  // The threshold fields keep their own draft while they are being edited: the
  // status poll re-renders every 2 s, and re-seeding the fields from it would
  // delete what the user is typing. An untouched draft is null, so the fields
  // follow the stored document and the last tick.
  const thresholdFields: ThresholdDraft = thresholds ?? thresholdDraft(data, overrides);
  const thresholdCheck = validateThresholds(thresholdFields);

  async function saveRule(rule: RuleKey, next: boolean): Promise<void> {
    if (revision === null || settings.saving) return;
    setSaveError("");
    const saved = await settings.save({ ...overrides, [rule]: next }, revision);
    setPending(null);
    if (!saved) {
      // `settings.saveError` carries the store's own words on the next render;
      // this line is what is left if it has none.
      setSaveError("The change was not saved. Reopen the screen and try again.");
      return;
    }
    // Re-read so the toggles show what the store holds, not the draft they saved.
    await settings.reload();
  }

  async function saveThresholds(): Promise<void> {
    if (revision === null || settings.saving) return;
    // The validation is also a rendered gate (the button is disabled), but the
    // save path checks it too: a keystroke that raced the render must not write
    // a threshold the daemon would clamp behind the user's back.
    const checked = validateThresholds(thresholdFields);
    if (!checked.ok) {
      setThresholdError(checked.error);
      return;
    }
    setThresholdError("");
    const saved = await settings.save({ ...overrides, ...checked.values }, revision);
    if (!saved) {
      setThresholdError(settings.saveError ?? "The thresholds were not saved. Reopen the screen and try again.");
      return;
    }
    setThresholds(null);
    await settings.reload();
  }

  async function startRun(mode: "report" | "act"): Promise<void> {
    if (busy !== "") return;
    setBusy(mode);
    setRunError("");
    try {
      const actions = await runTick({ mode });
      setRuns((previous) => [{ id: `${String(Date.now())}-${mode}`, mode, at: nowText(), actions }, ...previous].slice(0, 10));
      // The tick just moved: show its result without waiting for the poll.
      await query.refetch();
    } catch (caught) {
      setRunError(describeError(caught));
    } finally {
      setBusy("");
    }
  }

  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const warning = { color: theme.colors.statusWarning, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: pad, gap: pad }}
    >
      <Text style={muted}>
        Refreshing the last tick every 2 s. Nothing here runs on its own: the buttons start one tick, and the rules
        decide whether that tick acts.
      </Text>

      {query.isPending ? <Text style={muted}>Loading the last tick…</Text> : null}

      {query.isError ? (
        <View style={{ gap: pad }}>
          <Text style={danger}>{describeError(query.error)}</Text>
          <ActionButton surface={surface} label="Retry" onPress={() => void query.refetch()} />
        </View>
      ) : null}

      <View style={{ flexDirection: layout.compact ? "column" : "row", alignItems: "stretch", gap: pad }}>
        <View style={{ flex: layout.compact ? undefined : 2, gap: pad }}>
          <Section
            surface={surface}
            title="Status"
            subtitle="The last tick's own verdicts, as gc.status published them."
          >
            {rows === null ? (
              <Text style={muted}>No status yet.</Text>
            ) : (
              <View style={{ gap: 4 }}>
                {rows.status.map((row) => (
                  <StatusLine
                    key={row.label}
                    surface={surface}
                    label={row.label}
                    value={row.value}
                    tone={row.tone}
                  />
                ))}
              </View>
            )}
            <Text style={muted}>
              Daemon pid and uptime, the Paseo tree's footprint, the ledger, the index verdict, the last report and
              the alerts all come from the last tick's own answer. "Paseo tree" is the app and its agents (with the
              proven orphans), not the daemon's own processes — the daemon has its own row. A row that says "no data
              yet" is a fresh install: nothing has run, so nothing is reported.
            </Text>
          </Section>

          <Section
            surface={surface}
            title="Rules"
            subtitle="Saved to the plugin's gc settings document, over the imported slp-gc.conf. A change takes effect on the next tick."
          >
            {notice === null ? null : (
              <Text style={notice.tone === "danger" ? danger : warning}>{notice.text}</Text>
            )}
            {RULES.map((rule) => {
              const on = ruleOn(rule.key);
              const confirm =
                pending?.rule === rule.key
                  ? ruleConfirm(rule.key, pending.next, data === null ? null : data.settings.memKillMb)
                  : null;
              return (
                <View
                  key={rule.key}
                  style={{
                    backgroundColor: theme.colors.surface2,
                    borderColor: on ? theme.colors.statusWarning : theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 8,
                    padding: pad,
                    gap: 4,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
                      {rule.label}
                    </Text>
                    <Pressable
                      accessibilityRole="switch"
                      accessibilityLabel={`${rule.label}: ${on ? "on" : "off"}`}
                      accessibilityState={{ checked: on }}
                      onPress={() => setPending({ rule: rule.key, next: !on })}
                      style={{
                        borderColor: on ? theme.colors.statusWarning : theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 999,
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                      }}
                    >
                      <Text
                        style={{
                          color: on ? theme.colors.statusWarning : theme.colors.foreground,
                          fontSize: 12,
                          fontWeight: "600",
                        }}
                      >
                        {on ? "on · turn off" : "off · turn on"}
                      </Text>
                    </Pressable>
                  </View>
                  <Text style={muted}>{rule.hint}</Text>

                  {confirm === null ? null : (
                    <View
                      style={{
                        backgroundColor: theme.colors.surface0,
                        borderColor: pending?.next ? theme.colors.statusWarning : theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 8,
                        padding: pad,
                        gap: 6,
                      }}
                    >
                      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                        {confirm.title}
                      </Text>
                      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{confirm.body}</Text>
                      {revision === null ? (
                        <Text style={warning}>
                          The settings have not loaded, so this cannot be saved yet.
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
                        <ActionButton
                          surface={surface}
                          label={settings.saving ? "Saving…" : confirm.confirm}
                          disabled={revision === null || settings.saving}
                          onPress={() => {
                            if (pending !== null) void saveRule(pending.rule, pending.next);
                          }}
                        />
                        <Pressable accessibilityRole="button" onPress={() => setPending(null)}>
                          <Text style={{ color: theme.colors.foregroundMuted }}>Cancel</Text>
                        </Pressable>
                      </View>
                      <Text style={muted}>
                        Cancelling changes nothing: the rule keeps the value it has now.
                      </Text>
                    </View>
                  )}
                </View>
              );
            })}

            {settings.saveError !== null || saveError.length > 0 ? (
              <Text style={danger}>{settings.saveError ?? saveError}</Text>
            ) : null}

            <View
              style={{
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 8,
                padding: pad,
                gap: 6,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Thresholds</Text>
              <Text style={muted}>
                Saved to the same gc settings document, over slp-gc.conf. Whole megabytes; a change takes effect on the
                next tick.
              </Text>
              {THRESHOLDS.map((field) => (
                <View key={field.key} style={{ gap: 2 }}>
                  <Text style={muted}>{field.label}</Text>
                  <TextEntry
                    surface={surface}
                    value={thresholdFields[field.key]}
                    placeholder={field.placeholder}
                    disabled={revision === null || settings.saving}
                    onChangeText={(text) => {
                      setThresholdError("");
                      setThresholds({ ...thresholdFields, [field.key]: text });
                    }}
                  />
                  <Text style={muted}>{field.hint}</Text>
                </View>
              ))}
              {thresholdCheck.ok ? null : <Text style={danger}>{thresholdCheck.error}</Text>}
              {thresholdError ? <Text style={danger}>{thresholdError}</Text> : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
                <ActionButton
                  surface={surface}
                  label={settings.saving ? "Saving…" : "Save thresholds"}
                  disabled={revision === null || settings.saving || !thresholdCheck.ok}
                  onPress={() => void saveThresholds()}
                />
                {thresholds === null ? null : (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setThresholdError("");
                      setThresholds(null);
                    }}
                  >
                    <Text style={{ color: theme.colors.foregroundMuted }}>Discard changes</Text>
                  </Pressable>
                )}
              </View>
              {revision === null ? (
                <Text style={warning}>The settings have not loaded, so the thresholds cannot be saved yet.</Text>
              ) : null}
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
              <ActionButton
                surface={surface}
                label={busy === "report" ? "Reporting…" : "Run report now"}
                disabled={busy !== ""}
                onPress={() => void startRun("report")}
              />
              {applyOn ? (
                <ActionButton
                  surface={surface}
                  label={busy === "act" ? "Reclaiming…" : "Reclaim now"}
                  disabled={busy !== ""}
                  onPress={() => void startRun("act")}
                />
              ) : (
                <Text style={muted}>Reclaim now appears when Reclaim records (apply) is on.</Text>
              )}
            </View>
            <Text style={muted}>
              A report writes the sample and, when one is due, the report text; it never deletes or signals. A reclaim
              runs the tick with whatever the rules above enable.
            </Text>
            {runError ? <Text style={danger}>{runError}</Text> : null}
          </Section>
        </View>

        <View style={{ flex: layout.compact ? undefined : 3, gap: pad }}>
          <Section
            surface={surface}
            title="Candidates"
            subtitle="What a reclaim would take, and why it refuses the rest. Eligible rows first."
          >
            {rows === null || rows.candidates.length === 0 ? (
              <Text style={muted}>No record candidates in the last tick.</Text>
            ) : null}
            {rows?.candidates.slice(0, LIST_LIMIT).map((candidate) => (
              <View
                key={candidate.key}
                style={{
                  backgroundColor: candidate.actionable ? theme.colors.surface2 : theme.colors.surface0,
                  borderColor: candidate.actionable ? theme.colors.statusWarning : theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: pad,
                  gap: 2,
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
                  {candidate.label}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                  {candidate.rule.length > 0 ? candidate.rule : "no rule recorded"}
                </Text>
                <Text
                  style={{
                    color: candidate.actionable ? theme.colors.statusWarning : theme.colors.foregroundMuted,
                    fontSize: 11,
                  }}
                  numberOfLines={3}
                >
                  {candidate.actionable
                    ? applyOn
                      ? "eligible: the next reclaim takes it"
                      : "eligible: reclamation is off, so nothing happens"
                    : candidate.refusal}
                </Text>
              </View>
            ))}
            {rows !== null && rows.candidates.length > LIST_LIMIT ? (
              <Text style={muted}>
                {`${String(rows.candidates.length - LIST_LIMIT)} more candidates not shown; the text report lists every one.`}
              </Text>
            ) : null}
          </Section>

          <Section
            surface={surface}
            title="Processes"
            subtitle="The tick's process rows, with the warn verdict it gave each one."
          >
            {rows === null || rows.procs.length === 0 ? (
              <Text style={muted}>No process rows in the last tick.</Text>
            ) : null}
            {rows?.procs.slice(0, LIST_LIMIT).map((proc) => (
              <View
                key={proc.key}
                style={{
                  backgroundColor: theme.colors.surface0,
                  borderColor: proc.warn ? theme.colors.statusWarning : theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: pad,
                  gap: 2,
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
                  {`${String(proc.pid)} · ${proc.klass}`}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                  {`owner ${proc.owner} · ${proc.footprint}`}
                </Text>
                {proc.warn ? <Text style={warning}>{proc.warnText}</Text> : null}
              </View>
            ))}
            {rows !== null && rows.procs.length > LIST_LIMIT ? (
              <Text style={muted}>
                {`${String(rows.procs.length - LIST_LIMIT)} more process rows not shown; the text report lists every one.`}
              </Text>
            ) : null}
          </Section>

          <Section
            surface={surface}
            title="History"
            subtitle="The newest alerts.log lines, as gc.status publishes them: newest first, at most 20."
          >
            {rows === null || rows.alerts.length === 0 ? (
              rows !== null && !rows.alertsReadable ? (
                <Text style={warning}>
                  alerts.log could not be read, so the history is unknown — not empty. The file is there and the last
                  tick could not read it; check its permissions.
                </Text>
              ) : (
                <Text style={muted}>
                  No alerts recorded yet. alerts.log is empty on a fresh install; the first alert appears when a
                  memory or orphan threshold trips.
                </Text>
              )
            ) : null}
            {rows?.alerts.map((alert) => (
              <View
                key={alert.key}
                style={{
                  backgroundColor: theme.colors.surface2,
                  borderColor: theme.colors.statusWarning,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: pad,
                  gap: 2,
                }}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                  {alert.at}
                </Text>
                <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={3}>
                  {alert.text}
                </Text>
              </View>
            ))}
            <Text style={muted}>
              The tail of the plugin's gc state alerts.log; the report texts themselves are files in the same
              directory.
            </Text>
          </Section>

          <Section
            surface={surface}
            title="Run results (this session)"
            subtitle="Each gc.run answer this screen started, newest first: what it acted on, and every row it refused."
          >
            {runs.length === 0 ? (
              <Text style={muted}>Nothing run from here yet in this session.</Text>
            ) : null}
            {runs.map((entry) => {
              const actions = actionRows(entry.actions);
              return (
                <View
                  key={entry.id}
                  style={{
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 8,
                    padding: pad,
                    gap: 2,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
                    {`${entry.mode === "act" ? "reclaim" : "report"} · ${entry.at}`}
                  </Text>
                  {actions.length === 0 ? (
                    <Text style={muted}>nothing to do</Text>
                  ) : (
                    actions.map((action) => (
                      <Text
                        key={action.key}
                        style={{ color: toneColor(theme, action.tone), fontSize: 11 }}
                        numberOfLines={3}
                      >
                        {`${action.label} — ${action.detail}`}
                      </Text>
                    ))
                  )}
                </View>
              );
            })}
            <Text style={muted}>
              Feedback for the two buttons above, kept in memory only. The history is the alert list, which comes from
              alerts.log through gc.status.
            </Text>
          </Section>
        </View>
      </View>
    </ScrollView>
  );
}

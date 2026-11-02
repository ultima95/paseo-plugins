import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import type { MemberRecord } from "../shared/member";
import type { Choice, Surface } from "./seat-editor";
import { ActionButton, ChoiceRow, Field, TextEntry, describeError, paddingFor } from "./seat-editor";

/** One workspace the daemon knows, as a possible launch target. */
export interface WorkspaceOption {
  id: string;
  label: string;
  directory: string;
}

/** Exactly one of the two is sent to `room.launch`. */
export interface LaunchRequest {
  workspaceId?: string;
  cwd?: string;
}

export interface LaunchTarget {
  workspaces: WorkspaceOption[];
  loading: boolean;
  error: string;
  /** "" when no workspace is selected, so the typed cwd is used instead. */
  workspaceId: string;
  selectWorkspace(id: string): void;
  cwd: string;
  setCwd(text: string): void;
  /** Where provider feature lookups run; "" until a target names a directory. */
  cwdForFeatures: string;
  /** The launch input, or `null` while neither target is set. */
  request: LaunchRequest | null;
}

/** The "no workspace" chip, so the cwd field stays reachable. */
const NO_WORKSPACE = "";

/**
 * The launch target: a workspace, or a typed cwd.
 *
 * There is deliberately no default. Guessing a directory would start agents in
 * a place the user never picked; a room needs exactly one target and the Launch
 * button stays disabled until one is named. A workspace wins when both are set,
 * because a workspace carries its own directory and id to the daemon.
 */
export function useLaunchTarget(): LaunchTarget {
  const paseo = usePaseo();
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspaceId, setWorkspaceId] = useState(NO_WORKSPACE);
  const [cwd, setCwd] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    paseo.workspaces
      .list()
      .then((result) => {
        if (cancelled) return;
        setWorkspaces(
          result.entries.map((entry) => ({
            id: entry.id,
            label: entry.title ?? entry.name,
            directory: entry.workspaceDirectory ?? "",
          })),
        );
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

  const selected = workspaces.find((workspace) => workspace.id === workspaceId);
  const typedCwd = cwd.trim();
  const cwdForFeatures = selected && selected.directory.length > 0 ? selected.directory : typedCwd;

  const request: LaunchRequest | null =
    workspaceId.length > 0 ? { workspaceId } : typedCwd.length > 0 ? { cwd: typedCwd } : null;

  return {
    workspaces,
    loading,
    error,
    workspaceId,
    selectWorkspace: setWorkspaceId,
    cwd,
    setCwd,
    cwdForFeatures,
    request,
  };
}

export interface LaunchFormProps extends Surface {
  target: LaunchTarget;
  /** Every member the store knows. Only the matching role is offered per seat. */
  members: MemberRecord[];
  /** "" means the host seat, which is what a room launched without one gets. */
  supervisorMemberId: string;
  leadMemberId: string;
  onSupervisorMemberChange(id: string): void;
  onLeadMemberChange(id: string): void;
  task: string;
  onTaskChange(text: string): void;
  launching: boolean;
  error: string;
  onLaunch(): void;
}

/**
 * One member picker: the host seat, then the members of that role.
 *
 * The host seat is first and is the empty-id default, because a room that names
 * no member still launches — it keeps whatever the saved role's seat is. The
 * filter is by role: offering a Lead as the Supervisor would bind a member the
 * room protocol cannot use there.
 */
function memberChoices(members: MemberRecord[], role: "supervisor" | "lead"): Choice[] {
  return [
    { id: "", label: "host seat" },
    ...members.filter((member) => member.role === role).map((member) => ({ id: member.id, label: member.name })),
  ];
}

/**
 * Target, the two member pickers, the task and the Launch button. The screen
 * owns the launch itself.
 */
export function LaunchForm(props: LaunchFormProps) {
  const { theme, layout, target } = props;
  const surface: Surface = { theme, layout };
  const pad = paddingFor(layout);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const warning = { color: theme.colors.statusWarning, fontSize: 12 };

  const workspaceChoices: Choice[] = [
    { id: NO_WORKSPACE, label: "none (use cwd)" },
    ...target.workspaces.map((workspace) => ({ id: workspace.id, label: workspace.label })),
  ];

  const selected = target.workspaceId.length > 0;
  const canLaunch = !props.launching && props.task.trim().length > 0 && target.request !== null;

  let targetHint = "Pick a workspace or type a cwd.";
  if (target.request !== null) {
    targetHint = selected ? "Runs in the selected workspace." : `Runs in ${target.cwdForFeatures}`;
  }

  return (
    <View style={{ gap: pad }}>
      <Field surface={surface} label="Workspace">
        <ChoiceRow
          surface={surface}
          options={workspaceChoices}
          value={target.workspaceId}
          disabled={props.launching}
          onSelect={target.selectWorkspace}
        />
      </Field>
      {target.loading ? <Text style={muted}>Loading workspaces…</Text> : null}
      {target.error ? <Text style={warning}>{target.error}</Text> : null}

      <Field
        surface={surface}
        label={selected ? "cwd (a selected workspace wins over this)" : "cwd"}
      >
        <TextEntry
          surface={surface}
          value={target.cwd}
          placeholder="/absolute/path/to/the/project"
          disabled={props.launching}
          onChangeText={target.setCwd}
        />
      </Field>

      <Field surface={surface} label="Supervisor member">
        <ChoiceRow
          surface={surface}
          options={memberChoices(props.members, "supervisor")}
          value={props.supervisorMemberId}
          disabled={props.launching}
          onSelect={props.onSupervisorMemberChange}
        />
      </Field>

      <Field surface={surface} label="Lead member">
        <ChoiceRow
          surface={surface}
          options={memberChoices(props.members, "lead")}
          value={props.leadMemberId}
          disabled={props.launching}
          onSelect={props.onLeadMemberChange}
        />
      </Field>

      {props.supervisorMemberId.length > 0 || props.leadMemberId.length > 0 ? (
        <Text style={muted}>
          A selected member supplies that seat and its memory; the host seat keeps the saved role's
          seat.
        </Text>
      ) : null}

      <Field surface={surface} label="Task">
        <TextEntry
          surface={surface}
          value={props.task}
          placeholder="What should the room do?"
          multiline
          disabled={props.launching}
          onChangeText={props.onTaskChange}
        />
      </Field>

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
        <ActionButton
          surface={surface}
          label={props.launching ? "Launching…" : "Launch room"}
          disabled={!canLaunch}
          onPress={props.onLaunch}
        />
        <Text style={muted}>{targetHint}</Text>
      </View>

      {props.task.trim().length === 0 ? <Text style={muted}>A task is required to launch.</Text> : null}
      {props.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{props.error}</Text> : null}
    </View>
  );
}

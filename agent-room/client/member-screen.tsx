import { useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import type {
  EpisodeFact,
  Lesson,
  MemberRecord,
  MemberRole,
  MemoryScopeType,
  PendingCandidate,
} from "../shared/member";
import type { Role } from "../shared/roles";
import { DEFAULT_SETTINGS, roleSeat } from "../shared/roles";
import {
  memberCharterRpc,
  memberGetRpc,
  memberListRpc,
  memberPendingRpc,
  memberSaveRpc,
} from "../shared/rpc";
import type { SeatDraft, SeatPatch } from "./settings-draft";
import type { Surface } from "./seat-editor";
import {
  ActionButton,
  ChoiceRow,
  Field,
  SeatEditor,
  Section,
  TextEntry,
  describeError,
  paddingFor,
  useProviderCatalog,
} from "./seat-editor";

/** The stock seat a new member of each role starts from. */
const SUPERVISOR_ROLE: Role = DEFAULT_SETTINGS.roles.find((role) => role.kind === "supervisor")!;
const LEAD_ROLE: Role = DEFAULT_SETTINGS.roles.find((role) => role.kind === "lead")!;

/**
 * The scope types a member can auto-promote, in the order they are saved. The
 * schema's default is repo and workspace: global lessons are the widest claim a
 * member can make, so they stay for review unless the user says otherwise.
 */
const SCOPE_TYPES: MemoryScopeType[] = ["global", "repo", "workspace"];

/** One member with everything the store serves for it. */
interface MemberDetail {
  member: MemberRecord;
  charter: string;
  lessons: Lesson[];
  pending: PendingCandidate[];
  episodes: Array<EpisodeFact & { roomId: string }>;
}

/** What `member.get` answers: the detail, or the stale-link marker. */
type Membership = MemberDetail | { missing: true };

/** One member's editable state. `id` is absent until the member is saved. */
interface Draft {
  id?: string;
  name: string;
  role: MemberRole;
  seat: SeatDraft;
  promotion: "human" | "auto";
  autoScopes: MemoryScopeType[];
}

function stockRole(role: MemberRole): Role {
  return role === "supervisor" ? SUPERVISOR_ROLE : LEAD_ROLE;
}

/** The stock seat, copied: the draft's features must never be the stock ones. */
function stockSeat(role: MemberRole): SeatDraft {
  return { ...roleSeat(stockRole(role)) };
}

function draftFrom(member: MemberRecord): Draft {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    seat: {
      provider: member.provider,
      model: member.model,
      ...(member.modeId !== undefined ? { modeId: member.modeId } : {}),
      ...(member.thinkingOptionId !== undefined ? { thinkingOptionId: member.thinkingOptionId } : {}),
      ...(member.features !== undefined ? { features: member.features } : {}),
    },
    promotion: member.memory.promotion,
    autoScopes: SCOPE_TYPES.filter((scope) => member.memory.autoScopes.includes(scope)),
  };
}

function emptyDraft(role: MemberRole): Draft {
  return {
    name: "",
    role,
    seat: stockSeat(role),
    // The record schema's default: a candidate waits for a human unless the
    // user widens the policy.
    promotion: "human",
    autoScopes: ["repo", "workspace"],
  };
}

/**
 * Merge one seat patch into a draft's seat.
 *
 * A key that is present sets (or clears) that field; an absent key leaves it
 * alone. A provider change drops the old provider's model, mode, thinking level
 * and feature values, because none of them mean anything on the new provider —
 * the same rule the role editor follows.
 */
function patchSeat(seat: SeatDraft, patch: SeatPatch): SeatDraft {
  if (patch.provider !== undefined && patch.provider !== seat.provider) {
    return { provider: patch.provider };
  }

  const next: SeatDraft = { provider: seat.provider };

  const model = "model" in patch ? patch.model : seat.model;
  if (model !== undefined) next.model = model;

  const modeId = "modeId" in patch ? patch.modeId : seat.modeId;
  if (modeId !== undefined) next.modeId = modeId;

  const thinkingOptionId = "thinkingOptionId" in patch ? patch.thinkingOptionId : seat.thinkingOptionId;
  if (thinkingOptionId !== undefined) next.thinkingOptionId = thinkingOptionId;

  const features = "features" in patch ? patch.features : seat.features;
  if (features !== undefined) next.features = features;

  return next;
}

/** Add or remove one scope, keeping the saved list in its canonical order. */
function withScope(
  scopes: readonly MemoryScopeType[],
  scope: MemoryScopeType,
  on: boolean,
): MemoryScopeType[] {
  const chosen = on ? [...scopes, scope] : scopes.filter((candidate) => candidate !== scope);
  return SCOPE_TYPES.filter((candidate) => chosen.includes(candidate));
}

/** One row of the member list: its name, role, seat and memory policy. */
function MemberRow(props: {
  surface: Surface;
  member: MemberRecord;
  selected: boolean;
  onPress(): void;
}) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);
  const member = props.member;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={{
        backgroundColor: props.selected ? theme.colors.surface1 : theme.colors.surface2,
        borderColor: props.selected ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 2,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
        {member.name}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
        {`${member.role} · ${member.provider}/${member.model} · ${member.memory.promotion}`}
      </Text>
    </Pressable>
  );
}

/** One recorded fact, read-only: its room, kind, signal and text. */
function FactRow(props: { surface: Surface; kind: string; meta: string; text: string }) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: pad,
        gap: 2,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
        {`${props.kind} · ${props.meta}`}
      </Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{props.text}</Text>
    </View>
  );
}

/**
 * The auto-promote scopes, as one toggleable chip per scope type.
 *
 * `ChoiceRow` picks one value out of a list; a memory policy picks any subset,
 * so the chips are drawn here in the same style rather than bent into a picker
 * that would silently replace the whole set on each press.
 */
function ScopeChips(props: {
  surface: Surface;
  value: readonly MemoryScopeType[];
  disabled?: boolean;
  onToggle(scope: MemoryScopeType): void;
}) {
  const { theme, layout } = props.surface;
  const pad = paddingFor(layout);

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {SCOPE_TYPES.map((scope) => {
        const selected = props.value.includes(scope);
        return (
          <Pressable
            key={scope}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            disabled={props.disabled}
            onPress={() => props.onToggle(scope)}
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
              {scope}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The Members screen: the durable Supervisors and Leads a room can be launched
 * on, and everything the store holds for one of them.
 *
 * The list and one member's detail are separate reads. Selecting a row seeds
 * the editor from `member.get`, and every mutation — a member save, a charter
 * write, a candidate accepted or rejected — re-reads the detail afterwards, so
 * what is on screen is what the store serves rather than what was sent. A
 * member id the store does not know reads as "member not found", which is what a
 * stale link looks like.
 *
 * Nothing here launches anything: the Rooms screen owns the launch, and it reads
 * the same `member.list` to offer these members as seats.
 */
export function MemberScreen(props: PluginScreenProps) {
  const { theme, layout } = props;
  const surface: Surface = { theme, layout };
  const pad = paddingFor(layout);

  const catalog = useProviderCatalog();
  const listMembers = useRpc(memberListRpc);
  const getMember = useRpc(memberGetRpc);
  const saveMember = useRpc(memberSaveRpc);
  const saveCharter = useRpc(memberCharterRpc);
  const settleCandidate = useRpc(memberPendingRpc);

  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");

  /** "" is "nothing selected": either no member, or a draft of a new one. */
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Membership | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [charterText, setCharterText] = useState("");

  const [busy, setBusy] = useState<"" | "save" | "charter" | "pending">("");
  const [saveError, setSaveError] = useState("");
  const [charterError, setCharterError] = useState("");
  const [pendingError, setPendingError] = useState("");
  const [notice, setNotice] = useState("");

  /** Orders overlapping reads of a member: the newest answer is the one applied. */
  const latestRead = useRef(0);

  const refreshList = useCallback(async (): Promise<void> => {
    try {
      const result = await listMembers({});
      setMembers(result.members);
      setListError("");
    } catch (caught) {
      setListError(describeError(caught));
    } finally {
      setListLoading(false);
    }
  }, [listMembers]);

  /** Seed the editor from one answer. A missing member has nothing to edit. */
  const applyDetail = useCallback((result: Membership): void => {
    setDetail(result);
    if ("missing" in result) {
      setDraft(null);
      setCharterText("");
      return;
    }
    setDraft(draftFrom(result.member));
    setCharterText(result.charter);
  }, []);

  const loadDetail = useCallback(
    async (memberId: string): Promise<void> => {
      latestRead.current += 1;
      const ticket = latestRead.current;
      // The previous member's lessons, candidates and episodes must not stand in
      // for this one's while the read is in flight.
      setDetail(null);
      setDetailLoading(true);
      setDetailError("");
      try {
        const result = await getMember({ memberId });
        // A newer read (another row, or a save that already refetched) wins.
        if (ticket !== latestRead.current) return;
        applyDetail(result);
      } catch (caught) {
        if (ticket !== latestRead.current) return;
        setDetailError(describeError(caught));
      } finally {
        if (ticket === latestRead.current) setDetailLoading(false);
      }
    },
    [getMember, applyDetail],
  );

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (selectedId.length === 0) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  function clearMessages(): void {
    setNotice("");
    setSaveError("");
    setCharterError("");
    setPendingError("");
  }

  function selectMember(member: MemberRecord): void {
    if (member.id === selectedId) return;
    setSelectedId(member.id);
    // The editor is empty until `member.get` answers, so nothing typed here can
    // be attributed to the member that was selected before.
    setDetail(null);
    setDraft(null);
    setCharterText("");
    clearMessages();
  }

  function startNewMember(role: MemberRole = "supervisor"): void {
    setSelectedId("");
    setDetail(null);
    setDetailError("");
    setDraft(emptyDraft(role));
    setCharterText("");
    clearMessages();
  }

  function chooseRole(role: MemberRole): void {
    setDraft((current) => {
      if (current === null || current.role === role) return current;
      // The seat is rebuilt from the stock role of the new kind: a Supervisor's
      // and a Lead's seats differ. The name and the memory policy belong to the
      // member, so they stay.
      return { ...current, role, seat: stockSeat(role) };
    });
  }

  function toggleScope(scope: MemoryScopeType): void {
    setDraft((current) => {
      if (current === null) return current;
      const on = !current.autoScopes.includes(scope);
      return { ...current, autoScopes: withScope(current.autoScopes, scope, on) };
    });
  }

  async function save(): Promise<void> {
    const current = draft;
    if (current === null || busy !== "") return;

    const name = current.name.trim();
    if (name.length === 0) {
      setSaveError("A member needs a name.");
      return;
    }
    const model = current.seat.model ?? "";
    if (model.length === 0) {
      setSaveError("Pick a model for the member's seat.");
      return;
    }

    setBusy("save");
    setSaveError("");
    setNotice("");
    try {
      const result = await saveMember({
        ...(current.id !== undefined ? { id: current.id } : {}),
        name,
        role: current.role,
        provider: current.seat.provider,
        model,
        ...(current.seat.modeId !== undefined ? { modeId: current.seat.modeId } : {}),
        ...(current.seat.thinkingOptionId !== undefined
          ? { thinkingOptionId: current.seat.thinkingOptionId }
          : {}),
        ...(current.seat.features !== undefined ? { features: current.seat.features } : {}),
        memory: { promotion: current.promotion, autoScopes: current.autoScopes },
      });
      setNotice(`Saved ${result.member.name}.`);
      await refreshList();
      if (result.member.id === selectedId) {
        await loadDetail(result.member.id);
      } else {
        // A created member had no id until this write; selecting it loads its
        // detail, which now includes an (empty) charter.
        setSelectedId(result.member.id);
      }
    } catch (caught) {
      setSaveError(describeError(caught));
    } finally {
      setBusy("");
    }
  }

  async function writeCharter(): Promise<void> {
    const memberId = draft?.id;
    if (memberId === undefined || busy !== "") return;

    setBusy("charter");
    setCharterError("");
    setNotice("");
    try {
      await saveCharter({ memberId, text: charterText });
      setNotice("Charter saved.");
      // The store holds the whole document now; re-read rather than trust the
      // textarea, which may have been edited while the write was in flight.
      await loadDetail(memberId);
    } catch (caught) {
      setCharterError(describeError(caught));
    } finally {
      setBusy("");
    }
  }

  async function settle(candidateId: string, action: "accept" | "reject"): Promise<void> {
    const memberId = draft?.id;
    if (memberId === undefined || busy !== "") return;

    setBusy("pending");
    setPendingError("");
    setNotice("");
    try {
      await settleCandidate({ memberId, candidateId, action });
      setNotice(action === "accept" ? "Candidate promoted to a lesson." : "Candidate rejected.");
      await loadDetail(memberId);
    } catch (caught) {
      setPendingError(describeError(caught));
    } finally {
      setBusy("");
    }
  }

  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const warning = { color: theme.colors.statusWarning, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };
  const success = { color: theme.colors.statusSuccess, fontSize: 12 };

  const missing = detail !== null && "missing" in detail;
  const loaded = detail !== null && !("missing" in detail) ? detail : null;
  const canSave =
    draft !== null &&
    draft.name.trim().length > 0 &&
    (draft.seat.model ?? "").length > 0 &&
    busy === "";
  const savedId = draft?.id;

  const cardStyle = {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: pad,
    gap: 2,
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: pad, gap: pad }}
      keyboardShouldPersistTaps="handled"
    >
      <Section
        surface={surface}
        title="Members"
        subtitle="A member is a durable Supervisor or Lead: its seat, its memory policy, and what it has learned."
      >
        {listLoading ? <Text style={muted}>Loading members…</Text> : null}
        {listError ? <Text style={danger}>{listError}</Text> : null}
        {!listLoading && !listError && members.length === 0 ? (
          <Text style={muted}>No members yet. Create one below.</Text>
        ) : null}

        {members.map((member) => (
          <MemberRow
            key={member.id}
            surface={surface}
            member={member}
            selected={member.id === selectedId}
            onPress={() => selectMember(member)}
          />
        ))}

        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
          <ActionButton
            surface={surface}
            label="New member"
            disabled={busy !== ""}
            onPress={() => startNewMember()}
          />
          <ActionButton
            surface={surface}
            label={listLoading ? "Refreshing…" : "Refresh"}
            disabled={listLoading}
            onPress={() => void refreshList()}
          />
        </View>
        <Text style={muted}>
          A new member starts on the stock Supervisor seat; the role chips rebuild the seat from the
          matching stock role.
        </Text>
      </Section>

      {draft === null ? (
        <Section surface={surface} title="Member" subtitle="Pick a member above, or create one.">
          {detailLoading ? <Text style={muted}>Loading the member…</Text> : null}
          {missing ? <Text style={warning}>member not found — it may have been removed.</Text> : null}
          {detailError ? <Text style={danger}>{detailError}</Text> : null}
          {!detailLoading && !missing && !detailError ? (
            <Text style={muted}>No member selected.</Text>
          ) : null}
          {notice ? <Text style={success}>{notice}</Text> : null}
        </Section>
      ) : (
        <Section
          surface={surface}
          title={draft.id === undefined ? "New member" : `Member · ${draft.name.trim().length > 0 ? draft.name.trim() : draft.id}`}
          subtitle="The seat and the memory policy are what a room launched on this member runs."
        >
          {detailLoading ? <Text style={muted}>Refreshing the member…</Text> : null}
          {detailError ? <Text style={danger}>{detailError}</Text> : null}
          {notice ? <Text style={success}>{notice}</Text> : null}

          <Field surface={surface} label="Name">
            <TextEntry
              surface={surface}
              value={draft.name}
              placeholder="e.g. Ada"
              disabled={busy !== ""}
              onChangeText={(text) => setDraft({ ...draft, name: text })}
            />
          </Field>

          <Field surface={surface} label="Role">
            <ChoiceRow
              surface={surface}
              options={[
                { id: "supervisor", label: "Supervisor" },
                { id: "lead", label: "Lead" },
              ]}
              value={draft.role}
              disabled={busy !== ""}
              onSelect={(id) => chooseRole(id === "lead" ? "lead" : "supervisor")}
            />
            <Text style={muted}>
              Changing the role rebuilds the seat from that stock role; the name and the memory
              policy stay.
            </Text>
          </Field>

          <Field surface={surface} label="Promotion">
            <ChoiceRow
              surface={surface}
              options={[
                { id: "human", label: "human · every candidate waits" },
                { id: "auto", label: "auto · promote the scopes below" },
              ]}
              value={draft.promotion}
              disabled={busy !== ""}
              onSelect={(id) => setDraft({ ...draft, promotion: id === "auto" ? "auto" : "human" })}
            />
            <Text style={muted}>
              A candidate from a finished room waits in Pending candidates under the human policy.
            </Text>
          </Field>

          <Field surface={surface} label="Auto-promote scopes">
            <ScopeChips
              surface={surface}
              value={draft.autoScopes}
              disabled={busy !== ""}
              onToggle={toggleScope}
            />
            <Text style={muted}>
              The scopes a candidate is promoted from without review; only the auto policy acts on
              them. A narrow scope is safer than global.
            </Text>
          </Field>

          <SeatEditor
            theme={theme}
            layout={layout}
            label="Seat"
            seat={draft.seat}
            providers={catalog.providers}
            // A member has no launch directory, so provider features are not
            // listed here; the stored values are kept and saved untouched.
            cwd=""
            disabled={busy !== ""}
            onChange={(patch) =>
              setDraft((current) => (current === null ? current : { ...current, seat: patchSeat(current.seat, patch) }))
            }
          />

          {catalog.loading ? <Text style={muted}>Loading providers…</Text> : null}
          {catalog.error ? <Text style={warning}>{catalog.error}</Text> : null}
          {saveError ? <Text style={danger}>{saveError}</Text> : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
            <ActionButton
              surface={surface}
              label={busy === "save" ? "Saving…" : "Save member"}
              disabled={!canSave}
              onPress={() => void save()}
            />
            {draft.name.trim().length === 0 ? <Text style={muted}>A name is required.</Text> : null}
            {(draft.seat.model ?? "").length === 0 ? (
              <Text style={muted}>Pick a model for the seat.</Text>
            ) : null}
          </View>
        </Section>
      )}

      {draft === null ? null : savedId === undefined ? (
        <Section surface={surface} title="Charter" subtitle="A new member has no charter until it is saved.">
          <Text style={muted}>Save the member first, then write its charter.</Text>
        </Section>
      ) : (
        <Section
          surface={surface}
          title="Charter"
          subtitle="Written whole on every save. The room delivers it to this member as part of its prompt."
        >
          <TextEntry
            surface={surface}
            value={charterText}
            placeholder="What this member is always held to"
            multiline
            disabled={busy !== ""}
            onChangeText={setCharterText}
          />
          {charterError ? <Text style={danger}>{charterError}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
            <ActionButton
              surface={surface}
              label={busy === "charter" ? "Saving…" : "Save charter"}
              disabled={busy !== ""}
              onPress={() => void writeCharter()}
            />
            <Text style={muted}>{`${String(charterText.length)} characters`}</Text>
          </View>
        </Section>
      )}

      {savedId === undefined ? null : (
        <Section
          surface={surface}
          title="Pending candidates"
          subtitle="What finished rooms proposed for this member. Accepting writes a lesson; rejecting leaves a tombstone."
        >
          {loaded === null || loaded.pending.length === 0 ? (
            <Text style={muted}>No candidates waiting.</Text>
          ) : null}

          {loaded === null
            ? null
            : loaded.pending.map((candidate) => (
                <View key={candidate.id} style={cardStyle}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                    {`${candidate.scope} · ${candidate.at.slice(0, 10)}`}
                  </Text>
                  <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{candidate.text}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: pad }}>
                    <ActionButton
                      surface={surface}
                      label="Accept"
                      disabled={busy !== ""}
                      onPress={() => void settle(candidate.id, "accept")}
                    />
                    <ActionButton
                      surface={surface}
                      label="Reject"
                      disabled={busy !== ""}
                      onPress={() => void settle(candidate.id, "reject")}
                    />
                  </View>
                </View>
              ))}

          {pendingError ? <Text style={danger}>{pendingError}</Text> : null}
        </Section>
      )}

      {loaded === null ? null : (
        <Section
          surface={surface}
          title="Lessons"
          subtitle="Promoted memory. A lesson reaches a room's prompt only in the scopes it names."
        >
          {loaded.lessons.length === 0 ? <Text style={muted}>No lessons yet.</Text> : null}
          {loaded.lessons.map((lesson, index) => (
            <FactRow
              key={`${lesson.scope}-${lesson.at}-${String(index)}`}
              surface={surface}
              kind={`[${lesson.scope}]`}
              meta={`${lesson.at} · ${lesson.promotedBy}`}
              text={lesson.text}
            />
          ))}
        </Section>
      )}

      {loaded === null ? null : (
        <Section
          surface={surface}
          title="Episodes"
          subtitle="Recorded by finished rooms and read-only here: what this member decided, refused or was blocked on."
        >
          {loaded.episodes.length === 0 ? <Text style={muted}>No episodes recorded yet.</Text> : null}
          {loaded.episodes.map((episode, index) => (
            <FactRow
              key={`${episode.roomId}-${episode.at}-${String(index)}`}
              surface={surface}
              kind={episode.kind}
              meta={`${episode.roomId}${episode.signal === undefined ? "" : ` · ${episode.signal}`}`}
              text={episode.text}
            />
          ))}
        </Section>
      )}
    </ScrollView>
  );
}

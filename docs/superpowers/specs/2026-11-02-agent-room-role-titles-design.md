# Role titles — replacing `[room:…]` markers with role names

Status: **design, not implemented.** Companion to
`2026-11-02-agent-room-phase4-members-design.md`. Supersedes the title-marker grammar described in
`OVERVIEW.md` once implemented.

## 1. Decision

Every room agent is titled with its role name and a separator, not a bracketed
marker:

| Today | New |
| --- | --- |
| `[room:supervisor] migrate billing` | `Supervisor: migrate billing` |
| `[room:lead] billing migration` | `Lead: billing migration` |
| `[room:peer:review] audit the diff` | `Reviewer: audit the diff` |
| `[room:peer:default] fix rounding` | `Implementer: fix rounding` |

The role name is the routing token. There is no `room`, no bracket, and no `peer`
tier syntax in a title.

## 2. Why not labels

Structured labels would be cleaner than any title text, and Paseo supports them on
create:

- `CreateAgentRequestOptions.labels?: Record<string, string>`
  (`@getpaseo/client/dist/index.d.ts:189`)
- `updateAgent(agentId, { name?, labels? })`
  (`@getpaseo/client/dist/daemon-client.d.ts:912-914`)
- `create_agent` MCP accepts `labels`
- `PluginAgentSnapshot.labels` exposes them to the plugin after create
  (`@getpaseo/plugin/dist/contracts.d.ts`, `PluginAgentSnapshot`)

But the plugin's pre-create hook is narrower:

```ts
// @getpaseo/plugin/dist/server/lifecycle.d.ts
"agent.create": {
  config: AgentSessionConfig;   // provider, cwd, systemPrompt, modeId, model,
                                // thinkingOptionId, featureValues, title,
                                // providerOptions, toolPolicy, mcpServers, internal
  env?: Record<string, string>;
};
```

`AgentSessionConfig` has no `labels` field, the hook payload has no top-level
labels, and the caller's labels are not merged into `env`. Since the seat must be
forced **before** the provider starts (provider, model, mode, thinking), a label
that only exists after create cannot select a seat.

That leaves two pre-create channels: `config.title` and `config.systemPrompt`. A
title is the channel the room already uses, it is visible to the user, and it is
the natural place for a role name.

If Paseo later adds labels (or any structured metadata) to `PluginBeforeRequests`,
the parser in this design can be replaced with a label read without changing the
role catalog, the guard, or the prompt assembly.

## 3. Grammar

```
<RoleName>: <text>
```

- Anchored at the start of the trimmed title.
- `RoleName` is a configured role display name, matched case-insensitively.
- The separator is a single ASCII colon followed by whitespace (or end of title).
- The rest of the title is free text: the task, workstream, or bounded outcome.
- Titles stay under Paseo's 60-character cap.

Accepted:

```
Supervisor: migrate billing
Lead: billing migration
Reviewer: audit the diff
Implementer: fix invoice rounding
```

Rejected as room agents (treated as unmarked):

```
migrate billing
Room Supervisor: migrate billing
[room:supervisor] migrate billing      // legacy, parsed separately, not emitted
Reviewer audit the diff                // no separator
```

Why a colon and not a bare word: a bare role word seizes any ordinary title that
starts with it ("Reviewer notes", "Lead generation cleanup"). A colon is rare in
task titles and reads naturally. The parser also refuses a role name that is not in
the catalog, so an unrelated agent titled `Data migration: phase 2` stays untouched
unless `Data migration` is a configured role.

Case-insensitive matching means `reviewer:` and `Reviewer:` resolve to the same
role; the role record's canonical `name` is what `seatTitle` writes.

## 4. Role catalog

`peerTiers` is replaced by a single `roles` list. A role is the old seat plus the
old tier's purpose plus a prompt brief:

```ts
export const roleKindSchema = z.enum(["supervisor", "lead", "worker"]);

export const roleSchema = z.object({
  id: peerTierIdSchema,              // lowercase kebab-case, stable
  name: z.string().min(1).max(20),   // matched in the title, written by seatTitle
  kind: roleKindSchema,
  provider: nonEmptyText,
  model: nonEmptyText,
  modeId: nonEmptyText.optional(),
  thinkingOptionId: nonEmptyText.optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  useFor: z.string().min(1),          // shown in the room's role table
  brief: z.string().optional(),       // appended after the role prompt
});

export const roomSettingsSchema = z.object({
  roles: z.array(roleSchema).min(3),
}).superRefine((settings, ctx) => {
  const kinds = settings.roles.map((role) => role.kind);
  if (kinds.filter((kind) => kind === "supervisor").length !== 1) {
    ctx.addIssue({ code: "custom", message: "exactly one supervisor role is required", path: ["roles"] });
  }
  if (!kinds.includes("lead")) {
    ctx.addIssue({ code: "custom", message: "at least one lead role is required", path: ["roles"] });
  }
  if (!kinds.includes("worker")) {
    ctx.addIssue({ code: "custom", message: "at least one worker role is required", path: ["roles"] });
  }
  const ids = settings.roles.map((role) => role.id);
  const names = settings.roles.map((role) => role.name.toLowerCase());
  for (const [label, values] of [["id", ids], ["name", names]] as const) {
    const duplicate = values.find((value, index) => values.indexOf(value) !== index);
    if (duplicate !== undefined) {
      ctx.addIssue({ code: "custom", message: `duplicate role ${label} "${duplicate}"`, path: ["roles"] });
    }
  }
});
```

Defaults derived from today's `DEFAULT_SETTINGS` — the shipped catalog is nine roles:

| id | name | kind | seat |
| --- | --- | --- | --- |
| `supervisor` | `Supervisor` | supervisor | claude / claude-opus-5-5 / bypassPermissions / xhigh |
| `lead` | `Lead` | lead | claude / claude-opus-5-5 / bypassPermissions / high |
| `implementer` | `Implementer` | worker | claude / claude-sonnet-5-5 / bypassPermissions / medium |
| `reviewer` | `Reviewer` | worker | claude / claude-sonnet-5-5 / bypassPermissions / high |
| `researcher` | `Researcher` | worker | claude / claude-sonnet-5-5 / bypassPermissions / medium |
| `mechanic` | `Mechanic` | worker | claude / claude-haiku-4-5 / bypassPermissions / medium |
| `specialist` | `Specialist` | worker | claude / claude-opus-5-5 / bypassPermissions / medium |
| `codex` | `Codex` | worker | codex / gpt-5.6-sol / full-access / medium |
| `codex-review` | `Codex Review` | worker | codex / gpt-5.6-sol / full-access / high |

The mode is the provider's own full-trust mode, not a shared default:
`bypassPermissions` is a Claude mode id, and Codex offers `auto`, `auto-review`
and `full-access`, so both Codex roles run in `full-access`. A role that cannot
name a mode it offers fails to launch, so the catalog carries one seat per
provider rather than one mode for all of them.

The old `cheap` / `default` / `expensive` / `review` tiers become role names, not
hidden config. A Lead picks a role because it fits the work, not because it was
told which model to use. The `cross-family` and `cross-family-review` tier ids
map onto `codex` and `codex-review`, so a legacy title still resolves.

## 5. Seat resolution

Unchanged in shape, new in source:

1. Parse the title for a role name.
2. Look the role up by name (case-insensitive).
3. Force that role's provider, model, mode, thinking, features onto the create
   request. Drop controls the role leaves unset; drop `providerOptions` when the
   provider changes (the existing `applySeat` rules).
4. Render: protocol + the kind's prompt + `role.brief` + room role table.

A role that is not in the catalog is not a room agent: the create is left alone.
A child of a room seat with no role is a violation, exactly as today's
unmarked-child rule.

Phase 4 members layer on top: a Supervisor or Lead member may supply its own seat
values, in which case the member wins over the role's seat, while the role still
supplies `kind` and prompt. Worker roles get no members (deferred).

## 6. Guard

The hierarchy does not change; only the token the guard reads.

| Parent kind | May create |
| --- | --- |
| `supervisor` | `lead` |
| `lead` | `worker` |
| `worker` | nothing |

`checkSpawn` takes role kinds instead of `SeatMarker.seat`. Violation messages name
the role the violator should have used, using the catalog's names:

```
a Supervisor may only create Lead agents; title the child "Lead: <workstream>"
a Lead may only create worker-role agents; title the child "Implementer: <outcome>"
a worker role creates no agents; report to your Lead instead
```

The unmarked-child rule, the archive-first ordering, the feed row, and the
`room-guard` timeline row on a worker's Lead all stay as they are.

## 7. Prompt rendering

The room role table becomes a list of configured roles:

```
| Role | Kind | Use for |
| --- | --- | --- |
| Supervisor | supervisor | ... |
| Lead | lead | ... |
| Reviewer | worker | Read-only review of a candidate |
| Implementer | worker | Implementation, debugging |
```

The static `supervisor.md` / `lead.md` / `peer.md` prompts are kept as the defaults
for their kind. A role's `brief` is appended after the kind prompt, so a `Reviewer`
gets the worker prompt plus its review-specific instructions. This is the same
mechanism the phase 4 member section uses, and the order stays:

1. caller's system prompt
2. room protocol
3. kind prompt
4. role brief (new)
5. member section (phase 4)
6. role table

`PROMPTS.protocol` remains the idempotency sentinel in `carriesRoomPrompt`.

## 8. Legacy compatibility

- **Read old, write new.** `parseRoleTitle` falls back to `parseSeatMarker` so an
  in-flight room created before the change keeps working. `seatTitle` never emits
  the bracket form again.
- Legacy marker → role mapping: `[room:supervisor]` → `supervisor`,
  `[room:lead]` → `lead`, `[room:peer:<tier>]` → role id `<tier>` when it exists,
  else the first worker role. The fallback is recorded as a feed `note`
  (`legacy tier "default" mapped to role "Implementer"`).
- The room store keeps `marker` in `SeatRecord` during the transition; new records
  write `roleId` and `roleName` instead. Both are optional for one version.
- No agent title is rewritten in place. Existing agents keep their titles until
  archived.

## 9. Files

| File | Change |
| --- | --- |
| `shared/roles.ts` (new) | `Role`, `roleSchema`, `parseRoleTitle`, `seatTitleForRole`, `resolveRoleByName` |
| `shared/seats.ts` | `roomSettingsSchema` → `roles`; keep `parseSeatMarker` as the legacy reader; `DEFAULT_SETTINGS` re-expressed as roles |
| `shared/room.ts` | `SeatRecord` gains `roleId`, `roleName`; `marker` optional |
| `server/inject.ts` | resolve by role; pass `SeatConfig` from role or member |
| `server/guard.ts` | `checkSpawn` on `role.kind`; new rule messages |
| `server/events.ts` | store role, record legacy fallback note, render guard messages with role names |
| `server/render.ts` | kind prompt + `brief` + role table |
| `server/handlers.ts` | launch titles use the Supervisor role's name |
| `server/prompts/*.md` | rule text updated: title a child `Lead:` / `Implementer:`; remove marker examples |
| `client/seat-editor.tsx` | role editor: name, kind, seat, useFor, brief |
| `client/view-model.ts` | show role names in tree, feed, status card |
| `OVERVIEW.md` | new grammar section |

No change to `feed.ts` signal parsing, the store's file format beyond optional
fields, or the status card's row shape.

## 10. Tests

- `parseRoleTitle`: exact match, case-insensitive, colon required, unknown role,
  leading/trailing whitespace, 60-char truncation, empty rest.
- `parseRoleTitle` legacy fallback: each old marker shape, unknown tier → first
  worker role + fallback note.
- `checkSpawn` by kind: all three allowed and all denied combinations, unmarked
  child under each kind.
- `inject`: role seat forced, unset controls dropped, provider switch drops
  `providerOptions`, unknown role untouched, member override wins.
- `render`: kind prompt then brief then role table; idempotency unchanged.
- `events`: violation message names the correct role; legacy fallback note once.
- Client view model: role names in tree and feed.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| An ordinary title starting with `RoleName:` is seized | Catalog membership is required; names are short, specific words; document that role names are reserved on this daemon |
| Role rename breaks in-flight rooms | Renames are not supported in v1; add a role by new name, archive the old one. Legacy titles still resolve by old name if the role record is kept |
| Title budget | Role names capped at 20 chars; `seatTitle` truncates the text, never the role |
| Two roles with the same name | Schema rejects duplicate names case-insensitively |
| Guard messages drift from the catalog | Messages are generated from the role catalog, not string constants |
| Labels become available later | Parser seam is one function; replacing title parsing with a label read touches only `inject.ts` |

## 12. Rollout

1. Add `shared/roles.ts` and role schema; keep `seats.ts` legacy reader.
2. Switch `inject.ts` and `handlers.ts` to role resolution; write new titles only.
3. Switch `guard.ts` to kinds; regenerate prompts.
4. Migrate `DEFAULT_SETTINGS` to roles; one-time settings migration for stored
   `peerTiers`.
5. Update client editor and view models.
6. Remove the legacy reader after one release.

Phase 4 members land after this, or in parallel, but the two must not both change
title parsing: this design owns the grammar, phase 4 owns memory.

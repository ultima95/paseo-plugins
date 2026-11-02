import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, roleByName, type Role, type RoomSettings } from "../shared/roles";
import { memberRecordSchema } from "../shared/member";
import { applySeat, type AgentCreateRequest } from "./inject";
import { indexMembers } from "./member-index";
import { PROMPTS } from "./prompts/generated";
import { renderMemberSection, renderSystemPrompt } from "./render";

const base = (
  title: string | null,
  extra: Partial<AgentCreateRequest["config"]> = {},
): AgentCreateRequest => ({ config: { provider: "opencode", cwd: "/repo", title, model: "x", ...extra } });

/** The defaults with one role replaced wholesale, so a test controls every seat field. */
const withRole = (id: string, role: Role): RoomSettings => ({
  roles: DEFAULT_SETTINGS.roles.map((candidate) => (candidate.id === id ? role : candidate)),
});

describe("applySeat", () => {
  it("returns null for unmarked and unknown-role titles", () => {
    for (const title of [null, "Fix it", "Boss: x", "Review notes: x", "[Lead] old room"]) {
      expect(applySeat(base(title), DEFAULT_SETTINGS)).toBeNull();
    }
  });

  it("forces the role's provider, model, mode and effort", () => {
    const r = applySeat(base("Reviewer: audit"), DEFAULT_SETTINGS)!;
    expect(r.role.id).toBe("reviewer");
    expect(r.request.config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      cwd: "/repo",
      title: "Reviewer: audit",
    });
  });

  it("resolves a role name case-insensitively and keeps the caller's title text", () => {
    const r = applySeat(base("reviewer: audit"), DEFAULT_SETTINGS)!;
    expect(r.role.id).toBe("reviewer");
    expect(r.request.config.title).toBe("reviewer: audit");
  });

  it("applies a legacy marker through the mapped role", () => {
    const r = applySeat(base("[room:peer:review] audit"), DEFAULT_SETTINGS)!;
    expect(r.role.id).toBe("reviewer");
    expect(r.request.config.title).toBe("[room:peer:review] audit");
  });

  it("reports an unknown legacy tier fallback", () => {
    const r = applySeat(base("[room:peer:zzz] x"), DEFAULT_SETTINGS)!;
    expect(r.fallbackFrom).toBe("zzz");
    expect(r.role.kind).toBe("worker");
  });

  it("drops provider-specific fields the role leaves unset", () => {
    const settings = withRole("lead", {
      id: "lead",
      name: "Lead",
      kind: "lead",
      provider: "opencode",
      model: "m",
      useFor: "Owns one project",
    });
    const r = applySeat(
      base("Lead: x", {
        modeId: "full-access",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
      settings,
    )!;
    expect(r.request.config.modeId).toBeUndefined();
    expect(r.request.config.thinkingOptionId).toBeUndefined();
    expect(r.request.config.featureValues).toBeUndefined();
  });

  it("drops providerOptions when the role changes provider", () => {
    // base() asks for opencode; the Lead role is claude, so this is a cross-provider flip.
    const r = applySeat(
      base("Lead: x", { providerOptions: { reasoningEffort: "high", sandbox: "workspace-write" } }),
      DEFAULT_SETTINGS,
    )!;
    expect(r.request.config.provider).toBe("claude");
    expect(r.request.config.providerOptions).toBeUndefined();
  });

  it("keeps providerOptions when the role stays on the same provider", () => {
    const settings = withRole("lead", {
      id: "lead",
      name: "Lead",
      kind: "lead",
      provider: "opencode",
      model: "m",
      useFor: "Owns one project",
    });
    const providerOptions = { reasoningEffort: "high" };
    const r = applySeat(base("Lead: x", { providerOptions }), settings)!;
    expect(r.request.config.provider).toBe("opencode");
    expect(r.request.config.providerOptions).toEqual(providerOptions);
  });

  it("leaves provider-agnostic mcpServers and toolPolicy alone across a provider flip", () => {
    const mcpServers = { room: { type: "stdio" as const, command: "room" } };
    const toolPolicy = { preapproved: [{ kind: "mcp" as const, server: "room", tool: "send" }] };
    const r = applySeat(base("Lead: x", { mcpServers, toolPolicy }), DEFAULT_SETTINGS)!;
    expect(r.request.config.provider).toBe("claude");
    expect(r.request.config.mcpServers).toEqual(mcpServers);
    expect(r.request.config.toolPolicy).toEqual(toolPolicy);
  });

  it("appends the role prompt to an existing systemPrompt", () => {
    const lead = roleByName("Lead", DEFAULT_SETTINGS.roles)!;
    const r = applySeat(base("Lead: x", { systemPrompt: "BASE" }), DEFAULT_SETTINGS)!;
    expect(r.request.config.systemPrompt).toBe(renderSystemPrompt(lead, DEFAULT_SETTINGS, "BASE"));
  });

  it("leaves an already-prompted launch request and its seat alone", () => {
    const supervisor = roleByName("Supervisor", DEFAULT_SETTINGS.roles)!;
    const launched = renderSystemPrompt(supervisor, DEFAULT_SETTINGS);
    const r = applySeat(
      base("Supervisor: plan", {
        provider: "codex",
        model: "gpt-5.6-sol",
        systemPrompt: launched,
      }),
      DEFAULT_SETTINGS,
    )!;

    // room.launch built this seat from the selected member; the hook must not
    // re-seat it from the role catalog.
    expect(r.role.id).toBe("supervisor");
    expect(r.request.config.provider).toBe("codex");
    expect(r.request.config.model).toBe("gpt-5.6-sol");
    expect(r.request.config.systemPrompt).toBe(launched);
    expect(r.request.config.systemPrompt?.split(PROMPTS.protocol)).toHaveLength(2);
  });

  it("is stable across repeated applications", () => {
    const once = applySeat(base("Lead: x"), DEFAULT_SETTINGS)!;
    const twice = applySeat(once.request, DEFAULT_SETTINGS)!;
    expect(twice.request.config.systemPrompt).toBe(once.request.config.systemPrompt);
  });

  it("keeps env untouched", () => {
    const req = { ...base("Lead: x"), env: { A: "1" } };
    expect(applySeat(req, DEFAULT_SETTINGS)!.request.env).toEqual({ A: "1" });
  });

  it("reports the role it applied and forces its seat", () => {
    const settings = withRole("supervisor", {
      id: "supervisor",
      name: "Supervisor",
      kind: "supervisor",
      provider: "codex",
      model: "gpt-5.6-sol",
      modeId: "full-access",
      useFor: "Talks to the user",
    });
    const r = applySeat(base("Supervisor: plan"), settings)!;
    expect(r.role.id).toBe("supervisor");
    expect(r.request.config.provider).toBe("codex");
    expect(r.request.config.model).toBe("gpt-5.6-sol");
    expect(r.request.config.modeId).toBe("full-access");
    expect(r.request.config.thinkingOptionId).toBeUndefined();
    expect(r.fallbackFrom).toBeUndefined();
  });

  it("maps role features onto featureValues", () => {
    const settings = withRole("lead", {
      id: "lead",
      name: "Lead",
      kind: "lead",
      provider: "codex",
      model: "gpt-5.6-sol",
      features: { fast_mode: true },
      useFor: "Owns one project",
    });
    const r = applySeat(base("Lead: x"), settings)!;
    expect(r.request.config.featureValues).toEqual({ fast_mode: true });
  });

  it("leaves the incoming request object alone", () => {
    const req = base("Mechanic: fmt", { modeId: "plan" });
    applySeat(req, DEFAULT_SETTINGS);
    expect(req.config.modeId).toBe("plan");
    expect(req.config.provider).toBe("opencode");
    expect(req.config.model).toBe("x");
  });
});

const member = (over: Partial<Parameters<typeof memberRecordSchema.parse>[0]> = {}) =>
  memberRecordSchema.parse({
    id: "lead-1",
    name: "Lead",
    role: "lead",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "medium",
    memory: { promotion: "human" },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...over,
  });

const promptFor = () => renderMemberSection({ name: "Lead", charter: "Use pnpm.", lessons: [] });

describe("applySeat with members", () => {
  it("lets a matching member override the role seat", () => {
    const members = indexMembers([member()]);
    const r = applySeat(
      base("Lead: x", { provider: "claude", model: "claude-opus-5-5" }),
      DEFAULT_SETTINGS,
      members,
      promptFor,
    )!;

    expect(r.member?.id).toBe("lead-1");
    expect(r.request.config).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
    });
    expect(r.request.config.systemPrompt).toContain("## Member");
    expect(r.request.config.systemPrompt).toContain("Use pnpm.");
    expect(r.memberTruncated).toBe(false);
  });

  it("falls back to the role seat when no member matches the request seat", () => {
    const members = indexMembers([member()]);
    const r = applySeat(base("Lead: x"), DEFAULT_SETTINGS, members, promptFor)!;
    // base() asks for opencode/m, which is not the member's seat.
    expect(r.member).toBeUndefined();
    expect(r.request.config.provider).toBe("claude");
    expect(r.request.config.model).toBe("claude-opus-5-5");
    expect(r.request.config.systemPrompt).not.toContain("## Member");
  });

  it("never looks up a worker member", () => {
    const members = indexMembers([member()]);
    const r = applySeat(
      base("Reviewer: audit", { provider: "claude", model: "claude-opus-5-5" }),
      DEFAULT_SETTINGS,
      members,
      promptFor,
    )!;
    expect(r.member).toBeUndefined();
    expect(r.role.kind).toBe("worker");
  });

  it("drops member controls the member leaves unset", () => {
    const bare = member({
      id: "lead-2",
      modeId: undefined,
      thinkingOptionId: undefined,
      features: undefined,
    });
    const r = applySeat(
      base("Lead: x", {
        provider: "claude",
        model: "claude-opus-5-5",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
      DEFAULT_SETTINGS,
      indexMembers([bare]),
      promptFor,
    )!;
    expect(r.request.config.modeId).toBeUndefined();
    expect(r.request.config.thinkingOptionId).toBeUndefined();
    expect(r.request.config.featureValues).toBeUndefined();
  });
});

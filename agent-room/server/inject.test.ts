import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../shared/seats";
import { applySeat, type AgentCreateRequest } from "./inject";
import { renderSystemPrompt } from "./render";

const base = (
  title: string | null,
  extra: Partial<AgentCreateRequest["config"]> = {},
): AgentCreateRequest => ({ config: { provider: "opencode", cwd: "/repo", title, model: "x", ...extra } });

describe("applySeat", () => {
  it("returns null for unmarked and old-room titles", () => {
    for (const t of [null, "Fix it", "[Lead] old room", "[Peer] old"]) {
      expect(applySeat(base(t), DEFAULT_SETTINGS)).toBeNull();
    }
  });

  it("forces the seat's provider, model, mode, effort", () => {
    const r = applySeat(base("[room:peer:cheap] fmt"), DEFAULT_SETTINGS)!;
    expect(r.request.config).toMatchObject({
      provider: "claude",
      model: "claude-haiku-4-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
      cwd: "/repo",
      title: "[room:peer:cheap] fmt",
    });
  });

  it("drops provider-specific fields the seat leaves unset", () => {
    const settings = { ...DEFAULT_SETTINGS, lead: { provider: "opencode", model: "m" } };
    const r = applySeat(
      base("[room:lead] x", {
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

  it("drops providerOptions when the override changes provider", () => {
    // base() asks for opencode; the lead seat is claude, so this is a cross-provider flip.
    const r = applySeat(
      base("[room:lead] x", { providerOptions: { reasoningEffort: "high", sandbox: "workspace-write" } }),
      DEFAULT_SETTINGS,
    )!;
    expect(r.request.config.provider).toBe("claude");
    expect(r.request.config.providerOptions).toBeUndefined();
  });

  it("keeps providerOptions when the override stays on the same provider", () => {
    const settings = { ...DEFAULT_SETTINGS, lead: { provider: "opencode", model: "m" } };
    const providerOptions = { reasoningEffort: "high" };
    const r = applySeat(base("[room:lead] x", { providerOptions }), settings)!;
    expect(r.request.config.provider).toBe("opencode");
    expect(r.request.config.providerOptions).toEqual(providerOptions);
  });

  it("leaves provider-agnostic mcpServers and toolPolicy alone across a provider flip", () => {
    const mcpServers = { room: { type: "stdio" as const, command: "room" } };
    const toolPolicy = { preapproved: [{ kind: "mcp" as const, server: "room", tool: "send" }] };
    const r = applySeat(base("[room:lead] x", { mcpServers, toolPolicy }), DEFAULT_SETTINGS)!;
    expect(r.request.config.provider).toBe("claude");
    expect(r.request.config.mcpServers).toEqual(mcpServers);
    expect(r.request.config.toolPolicy).toEqual(toolPolicy);
  });

  it("appends the role prompt to an existing systemPrompt", () => {
    const r = applySeat(base("[room:lead] x", { systemPrompt: "BASE" }), DEFAULT_SETTINGS)!;
    expect(r.request.config.systemPrompt).toBe(renderSystemPrompt({ seat: "lead" }, DEFAULT_SETTINGS, "BASE"));
  });

  it("reports an unknown tier fallback", () => {
    expect(applySeat(base("[room:peer:zzz] x"), DEFAULT_SETTINGS)!.fallbackFrom).toBe("zzz");
  });

  it("keeps env untouched", () => {
    const req = { ...base("[room:lead] x"), env: { A: "1" } };
    expect(applySeat(req, DEFAULT_SETTINGS)!.request.env).toEqual({ A: "1" });
  });

  it("reports the seat marker it applied and forces supervisor settings", () => {
    const r = applySeat(base("[room:supervisor] plan"), {
      ...DEFAULT_SETTINGS,
      supervisor: { provider: "codex", model: "gpt-5.6-sol", modeId: "full-access" },
    })!;
    expect(r.marker).toEqual({ seat: "supervisor" });
    expect(r.request.config.provider).toBe("codex");
    expect(r.request.config.model).toBe("gpt-5.6-sol");
    expect(r.request.config.modeId).toBe("full-access");
    expect(r.request.config.thinkingOptionId).toBeUndefined();
    expect(r.fallbackFrom).toBeUndefined();
  });

  it("maps seat features onto featureValues", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      lead: { provider: "codex", model: "gpt-5.6-sol", features: { fast_mode: true } },
    };
    const r = applySeat(base("[room:lead] x"), settings)!;
    expect(r.request.config.featureValues).toEqual({ fast_mode: true });
  });

  it("leaves the incoming request object alone", () => {
    const req = base("[room:peer:cheap] fmt", { modeId: "plan" });
    applySeat(req, DEFAULT_SETTINGS);
    expect(req.config.modeId).toBe("plan");
    expect(req.config.provider).toBe("opencode");
    expect(req.config.model).toBe("x");
  });
});

import { describe, expect, it } from "vitest";

import {
  GLOBAL_SCOPE,
  LESSON_TEXT_CAP,
  lessonSchema,
  memberRecordSchema,
  memoryPolicySchema,
  normalizeWorkspacePath,
  repoScope,
  scopeType,
  workspaceScope,
} from "./member";

const base = {
  id: "default-lead",
  name: "Lead",
  role: "lead" as const,
  provider: "claude",
  model: "claude-opus-5-5",
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  memory: { promotion: "human" as const },
};

describe("memoryPolicySchema", () => {
  it("defaults autoScopes to repo and workspace", () => {
    expect(memoryPolicySchema.parse({ promotion: "human" })).toEqual({
      promotion: "human",
      autoScopes: ["repo", "workspace"],
    });
  });

  it("rejects an unknown scope type", () => {
    expect(
      memoryPolicySchema.safeParse({ promotion: "auto", autoScopes: ["global", "team"] }).success,
    ).toBe(false);
  });
});

describe("memberRecordSchema", () => {
  it("accepts a supervisor and a lead", () => {
    expect(memberRecordSchema.safeParse(base).success).toBe(true);
    expect(memberRecordSchema.safeParse({ ...base, role: "supervisor" }).success).toBe(true);
  });

  it("rejects worker members and empty seats", () => {
    expect(memberRecordSchema.safeParse({ ...base, role: "worker" }).success).toBe(false);
    expect(memberRecordSchema.safeParse({ ...base, provider: "" }).success).toBe(false);
    expect(memberRecordSchema.safeParse({ ...base, name: "x".repeat(61) }).success).toBe(false);
  });
});

describe("scope helpers", () => {
  it("normalizes workspace paths exactly", () => {
    expect(normalizeWorkspacePath("/a/b/")).toBe("/a/b");
    expect(normalizeWorkspacePath("/a/b//")).toBe("/a/b");
    expect(normalizeWorkspacePath("/")).toBe("/");
    expect(normalizeWorkspacePath("C:\\a\\b\\")).toBe("C:/a/b");
  });

  it("classifies the three scope shapes", () => {
    expect(scopeType(GLOBAL_SCOPE)).toBe("global");
    expect(scopeType(repoScope("8f3c1a2b"))).toBe("repo");
    expect(scopeType(workspaceScope("/a/b"))).toBe("workspace");
  });
});

describe("lessonSchema", () => {
  it("accepts a dated scoped lesson", () => {
    expect(
      lessonSchema.safeParse({
        at: "2026-11-02T10:00:00.000Z",
        scope: repoScope("8f3c1a2b"),
        text: "use pnpm",
        sourceRoomId: "A1",
        promotedBy: "human",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown scope and an oversized lesson", () => {
    expect(
      lessonSchema.safeParse({
        at: "2026-11-02T10:00:00.000Z",
        scope: "team:core",
        text: "x",
        sourceRoomId: "A1",
        promotedBy: "auto",
      }).success,
    ).toBe(false);
    expect(
      lessonSchema.safeParse({
        at: "2026-11-02T10:00:00.000Z",
        scope: GLOBAL_SCOPE,
        text: "x".repeat(LESSON_TEXT_CAP + 1),
        sourceRoomId: "A1",
        promotedBy: "auto",
      }).success,
    ).toBe(false);
  });
});

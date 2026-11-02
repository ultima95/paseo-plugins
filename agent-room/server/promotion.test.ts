import { describe, expect, it, vi } from "vitest";

import { memberRecordSchema, type Lesson, type PendingCandidate } from "../shared/member";
import type { MemberStore } from "./member-store";
import { applyPromotion, promotionTarget } from "./promotion";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const member = memberRecordSchema.parse({
  id: "lead-1",
  name: "Lead",
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  memory: { promotion: "auto", autoScopes: ["repo", "workspace"] },
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
});

describe("promotionTarget", () => {
  it.each([
    [{ promotion: "human", autoScopes: ["repo", "workspace"] }, "repo:8f3c1a2b", "pending"],
    [{ promotion: "human", autoScopes: ["repo", "workspace"] }, "global", "pending"],
    [{ promotion: "auto", autoScopes: ["repo", "workspace"] }, "repo:8f3c1a2b", "lesson"],
    [{ promotion: "auto", autoScopes: ["repo", "workspace"] }, "workspace:/a", "lesson"],
    [{ promotion: "auto", autoScopes: ["repo", "workspace"] }, "global", "pending"],
    [{ promotion: "auto", autoScopes: ["global", "repo", "workspace"] }, "global", "lesson"],
  ])("routes %j with scope %s to %s", (policy, scope, expected) => {
    expect(promotionTarget(policy as never, scope)).toBe(expected);
  });
});

/**
 * The store methods live under `store` so the raw `lessons` / `pending` arrays
 * stay inspectable — `MemberStore.lessons` is a method, not an array.
 */
function fakeMembers() {
  const lessons: Lesson[] = [];
  const pending: PendingCandidate[] = [];
  const store = {
    hasLesson: (id: string, scope: string, text: string) =>
      lessons.some((lesson) => lesson.scope === scope && lesson.text === text),
    // Any line for the id counts, tombstone or not — same as the real store.
    hasPending: (id: string, candidateId: string) =>
      pending.some((candidate) => candidate.id === candidateId),
    appendLesson: vi.fn(async (id: string, lesson: Lesson) => {
      lessons.push(lesson);
      return true;
    }),
    appendPending: vi.fn(async (id: string, candidate: PendingCandidate) => {
      pending.push(candidate);
      return true;
    }),
  } as unknown as MemberStore;
  return { lessons, pending, store };
}

const candidate = (text: string) => ({
  id: text,
  at: "2026-11-02T10:00:00.000Z",
  scope: "repo:8f3c1a2b",
  text,
  sourceRoomId: "R1",
});

describe("applyPromotion", () => {
  it("promotes auto candidates in an allowed scope", async () => {
    const members = fakeMembers();
    const out = await applyPromotion({
      members: members.store,
      member,
      candidates: [candidate("use pnpm")],
      now: () => Date.parse("2026-11-02T11:00:00.000Z"),
      log,
    });
    expect(out).toEqual({ promoted: 1, pending: 0 });
    expect(members.lessons[0]).toMatchObject({
      text: "use pnpm",
      promotedBy: "auto",
      scope: "repo:8f3c1a2b",
      at: "2026-11-02T11:00:00.000Z",
    });
  });

  it("queues a human-policy candidate without promoting it", async () => {
    const members = fakeMembers();
    const out = await applyPromotion({
      members: members.store,
      member: { ...member, memory: { promotion: "human", autoScopes: ["repo", "workspace"] } },
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 1 });
    expect(members.lessons).toEqual([]);
    expect(members.pending).toHaveLength(1);
  });

  it("skips a candidate already promoted or already pending", async () => {
    const members = fakeMembers();
    members.lessons.push({
      at: "2026-11-02T10:00:00.000Z",
      scope: "repo:8f3c1a2b",
      text: "use pnpm",
      sourceRoomId: "R1",
      promotedBy: "human",
    });
    const out = await applyPromotion({
      members: members.store,
      member,
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 0 });
  });

  it("keeps a global candidate pending under the default autoScopes", async () => {
    const members = fakeMembers();
    const out = await applyPromotion({
      members: members.store,
      member,
      candidates: [{ ...candidate("prefer small diffs"), scope: "global" }],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 1 });
    expect(members.pending[0]).toMatchObject({ scope: "global", text: "prefer small diffs" });
  });

  it("keeps the candidate timestamp on a queued line but stamps a promoted one", async () => {
    const members = fakeMembers();
    await applyPromotion({
      members: members.store,
      member,
      candidates: [candidate("use pnpm"), { ...candidate("prefer small diffs"), scope: "global" }],
      now: () => Date.parse("2026-11-02T11:00:00.000Z"),
      log,
    });
    expect(members.pending[0]?.at).toBe("2026-11-02T10:00:00.000Z");
    expect(members.lessons[0]?.at).toBe("2026-11-02T11:00:00.000Z");
  });

  it("skips a candidate whose pending line is a reject tombstone", async () => {
    const members = fakeMembers();
    members.pending.push({ ...candidate("use pnpm"), rejected: true });
    const out = await applyPromotion({
      members: members.store,
      member,
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 0 });
    expect(members.lessons).toEqual([]);
    expect(members.pending).toHaveLength(1);
  });

  it("skips a candidate already pending under the same id", async () => {
    const members = fakeMembers();
    members.pending.push(candidate("use pnpm"));
    const out = await applyPromotion({
      members: members.store,
      member: { ...member, memory: { promotion: "human", autoScopes: ["repo"] } },
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 0 });
  });

  it("logs one info line with the counts when anything was routed", async () => {
    const members = fakeMembers();
    const localLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const out = await applyPromotion({
      members: members.store,
      member: { ...member, memory: { promotion: "human", autoScopes: [] } },
      candidates: [candidate("use pnpm"), candidate("prefer small diffs")],
      now: () => 0,
      log: localLog,
    });
    expect(out).toEqual({ promoted: 0, pending: 2 });
    expect(localLog.info).toHaveBeenCalledTimes(1);
    expect(localLog.info).toHaveBeenCalledWith("member candidates routed", {
      promoted: 0,
      pending: 2,
    });
    expect(localLog.warn).not.toHaveBeenCalled();
    expect(localLog.error).not.toHaveBeenCalled();
  });

  it("stays quiet when every candidate was deduped", async () => {
    const members = fakeMembers();
    const localLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await applyPromotion({
      members: members.store,
      member,
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log: localLog,
    });
    await applyPromotion({
      members: members.store,
      member,
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log: localLog,
    });
    expect(localLog.info).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty candidate list", async () => {
    const members = fakeMembers();
    const localLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const out = await applyPromotion({
      members: members.store,
      member,
      candidates: [],
      now: () => 0,
      log: localLog,
    });
    expect(out).toEqual({ promoted: 0, pending: 0 });
    expect(localLog.info).not.toHaveBeenCalled();
  });

  it("counts only what the store accepted", async () => {
    const members = fakeMembers();
    const rejecting = {
      hasLesson: () => false,
      hasPending: () => false,
      appendLesson: vi.fn(async () => false),
      appendPending: vi.fn(async () => false),
    } as unknown as MemberStore;
    const out = await applyPromotion({
      members: rejecting,
      member,
      candidates: [candidate("use pnpm"), { ...candidate("x"), scope: "global" }],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 0 });
    expect(members.lessons).toEqual([]);
  });
});

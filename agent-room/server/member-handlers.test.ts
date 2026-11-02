import type { RpcInput } from "@getpaseo/plugin";
import { describe, expect, it, vi } from "vitest";

import { memberRecordSchema } from "../shared/member";
import { memberSaveRpc } from "../shared/rpc";
import { createMemberHandlers } from "./member-handlers";
import type { MemberStore } from "./member-store";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * `RpcInput` is zod's *output* type, so a field the schema defaults
 * (`memory.autoScopes`) reads as required at the handler boundary even though a
 * caller may omit it on the wire. The create test omits it on purpose — that is
 * what it asserts — so the literal is cast rather than padded with a default the
 * handler is supposed to supply.
 */
type SaveInput = RpcInput<typeof memberSaveRpc>;

const record = memberRecordSchema.parse({
  id: "lead-1",
  name: "Lead",
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  memory: { promotion: "human" },
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
});

function fakeMembers() {
  const records = [record];
  return {
    list: vi.fn(() => records),
    get: vi.fn((id: string) => records.find((member) => member.id === id)),
    upsert: vi.fn(async () => undefined),
    charter: vi.fn(() => "charter"),
    writeCharter: vi.fn(async () => undefined),
    lessons: vi.fn(() => []),
    pending: vi.fn(() => []),
    acceptPending: vi.fn(async () => ({
      at: "2026-11-02T10:00:00.000Z",
      scope: "global",
      text: "x",
      sourceRoomId: "R1",
      promotedBy: "human" as const,
    })),
    rejectPending: vi.fn(async () => true),
    episodes: vi.fn(async () => []),
  } as unknown as MemberStore;
}

describe("member handlers", () => {
  it("lists members", () => {
    const handlers = createMemberHandlers({ members: fakeMembers(), now: () => 0, newId: () => "new", log });
    expect(handlers.list()).toEqual({ members: [record] });
  });

  it("returns member detail and a missing member", async () => {
    const handlers = createMemberHandlers({ members: fakeMembers(), now: () => 0, newId: () => "new", log });
    await expect(handlers.get({ memberId: "lead-1" })).resolves.toMatchObject({
      member: record,
      charter: "charter",
      lessons: [],
      pending: [],
      episodes: [],
    });
    await expect(handlers.get({ memberId: "nope" })).resolves.toEqual({ missing: true });
  });

  it("creates a member with timestamps and a generated id", async () => {
    const members = fakeMembers();
    const handlers = createMemberHandlers({
      members,
      now: () => Date.parse("2026-11-02T10:00:00.000Z"),
      newId: () => "new-id",
      log,
    });

    const out = await handlers.save({
      name: "Lead",
      role: "lead",
      provider: "claude",
      model: "claude-opus-5-5",
      memory: { promotion: "human" },
    } as SaveInput);

    expect(out.member).toMatchObject({
      id: "new-id",
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T10:00:00.000Z",
      memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
    });
    expect(members.upsert).toHaveBeenCalledWith(out.member);
  });

  it("keeps createdAt when updating an existing member", async () => {
    const handlers = createMemberHandlers({
      members: fakeMembers(),
      now: () => Date.parse("2026-11-02T11:00:00.000Z"),
      newId: () => "unused",
      log,
    });
    const out = await handlers.save({
      id: "lead-1",
      name: "Renamed",
      role: "lead",
      provider: "codex",
      model: "gpt-5.6-sol",
      memory: { promotion: "auto", autoScopes: ["repo"] },
    });
    expect(out.member.createdAt).toBe("2026-11-02T00:00:00.000Z");
    expect(out.member.updatedAt).toBe("2026-11-02T11:00:00.000Z");
  });

  it("carries the optional seat controls through a save", async () => {
    const handlers = createMemberHandlers({
      members: fakeMembers(),
      now: () => Date.parse("2026-11-02T10:00:00.000Z"),
      newId: () => "new-id",
      log,
    });
    const out = await handlers.save({
      name: "Lead",
      role: "lead",
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "plan",
      thinkingOptionId: "high",
      features: { fast: true },
      memory: { promotion: "human", autoScopes: ["global"] },
    });
    // A save is the whole record: a control the caller set must survive it.
    expect(out.member).toMatchObject({
      modeId: "plan",
      thinkingOptionId: "high",
      features: { fast: true },
      memory: { promotion: "human", autoScopes: ["global"] },
    });
  });

  it("writes the charter", async () => {
    const members = fakeMembers();
    const handlers = createMemberHandlers({ members, now: () => 0, newId: () => "new", log });
    await expect(handlers.charter({ memberId: "lead-1", text: "use pnpm" })).resolves.toEqual({ ok: true });
    expect(members.writeCharter).toHaveBeenCalledWith("lead-1", "use pnpm");
  });

  it("accepts and rejects pending candidates", async () => {
    const members = fakeMembers();
    const handlers = createMemberHandlers({ members, now: () => 0, newId: () => "new", log });
    await expect(
      handlers.pending({ memberId: "lead-1", candidateId: "c1", action: "accept" }),
    ).resolves.toMatchObject({ ok: true, lesson: expect.objectContaining({ promotedBy: "human" }) });
    await expect(
      handlers.pending({ memberId: "lead-1", candidateId: "c2", action: "reject" }),
    ).resolves.toEqual({ ok: true });
    expect(members.acceptPending).toHaveBeenCalledWith("lead-1", "c1");
    expect(members.rejectPending).toHaveBeenCalledWith("lead-1", "c2");
  });

  it("fails a charter or a pending write for an unknown member", async () => {
    const members = fakeMembers();
    const handlers = createMemberHandlers({ members, now: () => 0, newId: () => "new", log });
    // Both writes are edits to a member that must exist; a stale id is an error
    // the screen shows, not a silent no-op.
    await expect(handlers.charter({ memberId: "gone", text: "x" })).rejects.toThrow(
      /member not found/,
    );
    await expect(
      handlers.pending({ memberId: "gone", candidateId: "c1", action: "reject" }),
    ).rejects.toThrow(/member not found/);
    expect(members.writeCharter).not.toHaveBeenCalled();
    expect(members.rejectPending).not.toHaveBeenCalled();
  });

  it("fails an accept for an unknown candidate", async () => {
    const members = fakeMembers();
    (members.acceptPending as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const handlers = createMemberHandlers({ members, now: () => 0, newId: () => "new", log });
    await expect(
      handlers.pending({ memberId: "lead-1", candidateId: "gone", action: "accept" }),
    ).rejects.toThrow(/candidate not found/);
  });
});

describe("member.save's id at the RPC boundary", () => {
  /** A whole-record save that differs only in the id under test. */
  const saveInput = (id: string) => ({
    id,
    name: "Lead",
    role: "lead",
    provider: "claude",
    model: "claude-opus-5-5",
    memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
  });

  it("rejects an id longer than the record's cap", () => {
    // 80 is the record's cap; an 81st character would reach `memberRecordSchema`
    // inside the handler and throw a bare ZodError at the caller.
    expect(memberSaveRpc.input.safeParse(saveInput("a".repeat(80))).success).toBe(true);
    expect(memberSaveRpc.input.safeParse(saveInput("a".repeat(81))).success).toBe(false);
  });

  it("rejects a path-ish id the store would have to sanitise", () => {
    // `safeSegment` turns `a/b` into `a_b`, which is also the directory of a
    // member genuinely named `a_b`: two members silently sharing one memory.
    expect(memberSaveRpc.input.safeParse(saveInput("a/b")).success).toBe(false);
    for (const id of ["a_b", "a-b", "A9"]) {
      expect(memberSaveRpc.input.safeParse(saveInput(id)).success).toBe(true);
    }
  });

  it("keeps the seed ids valid, and the record schema agrees with the wire", () => {
    for (const id of ["default-supervisor", "default-lead"]) {
      expect(memberSaveRpc.input.safeParse(saveInput(id)).success).toBe(true);
      expect(memberRecordSchema.safeParse({ ...record, id }).success).toBe(true);
    }
    // One rule on both sides: what the wire accepts the store will not refuse.
    expect(memberRecordSchema.safeParse({ ...record, id: "a".repeat(81) }).success).toBe(false);
    expect(memberRecordSchema.safeParse({ ...record, id: "a/b" }).success).toBe(false);
  });
});

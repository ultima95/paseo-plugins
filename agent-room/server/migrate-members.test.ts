// agent-room/server/migrate-members.test.ts
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../shared/roles";
import { migrateMembers } from "./migrate-members";
import type { MemberStore } from "./member-store";
import type { RoomStore } from "./store";

function fakeMembers(exists = false) {
  const records: unknown[] = [];
  const store = {
    missingFile: () => !exists,
    list: () => records,
    get: (id: string) => records.find((record) => (record as { id: string }).id === id),
    upsert: vi.fn(async (record: unknown) => {
      records.push(record);
    }),
    flush: vi.fn(async () => undefined),
  } as unknown as MemberStore;
  return { store, records };
}

function fakeRooms(migrated: boolean, count = 1) {
  const store = {
    migratedFromV1: () => migrated,
    listRooms: () => Array.from({ length: count }, (_, i) => ({ id: `R${i}` })),
    flush: vi.fn(async () => undefined),
  } as unknown as RoomStore;
  return store;
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("migrateMembers", () => {
  it("seeds a supervisor and a lead from the catalog", async () => {
    const members = fakeMembers(false);
    const store = fakeRooms(true, 3);

    const out = await migrateMembers({
      store,
      members: members.store,
      readSettings: async () => DEFAULT_SETTINGS,
      now: () => Date.parse("2026-11-02T10:00:00.000Z"),
      log,
    });

    expect(out.seeded).toBe(true);
    expect(members.records).toHaveLength(2);
    expect(members.records[0]).toMatchObject({
      id: "default-supervisor",
      name: "Supervisor",
      role: "supervisor",
      provider: "claude",
      model: "claude-opus-5-5",
      memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
    });
    expect(members.records[1]).toMatchObject({ id: "default-lead", role: "lead" });
    expect(log.info).toHaveBeenCalledWith("members migrated", { members: 2, rooms: 3 });
  });

  it("is a no-op when v2 rooms are already on disk", async () => {
    const members = fakeMembers(false);
    const out = await migrateMembers({
      store: fakeRooms(false),
      members: members.store,
      readSettings: async () => DEFAULT_SETTINGS,
      now: () => 0,
      log,
    });
    expect(out.seeded).toBe(false);
    expect(members.records).toEqual([]);
  });

  it("leaves an existing members file alone", async () => {
    const members = fakeMembers(true);
    const out = await migrateMembers({
      store: fakeRooms(true),
      members: members.store,
      readSettings: async () => DEFAULT_SETTINGS,
      now: () => 0,
      log,
    });
    expect(out.seeded).toBe(false);
    expect(members.records).toEqual([]);
  });

  it("does not seed from a catalog without a lead role", async () => {
    const members = fakeMembers(false);
    const out = await migrateMembers({
      store: fakeRooms(true),
      members: members.store,
      readSettings: async () => ({
        roles: DEFAULT_SETTINGS.roles.filter((role) => role.kind !== "lead"),
      }),
      now: () => 0,
      log,
    });
    expect(out.seeded).toBe(false);
    expect(members.records).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "member migration skipped: catalog is missing a required role",
      { error: "no lead role" },
    );
  });

  it("does not seed from a catalog without a supervisor role", async () => {
    // The warning is shared by both required roles, so it must name the one that
    // is missing rather than always blaming the lead.
    const members = fakeMembers(false);
    const out = await migrateMembers({
      store: fakeRooms(true),
      members: members.store,
      readSettings: async () => ({
        roles: DEFAULT_SETTINGS.roles.filter((role) => role.kind !== "supervisor"),
      }),
      now: () => 0,
      log,
    });
    expect(out.seeded).toBe(false);
    expect(members.records).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "member migration skipped: catalog is missing a required role",
      { error: "no supervisor role" },
    );
  });
});

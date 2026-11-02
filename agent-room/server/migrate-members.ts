import { memberRecordSchema, type MemberRecord } from "../shared/member";
import type { Role, RoomSettings } from "../shared/roles";
import type { Logger } from "./logger";
import type { MemberStore } from "./member-store";
import type { RoomStore } from "./store";

export interface MigrateMembersDeps {
  store: RoomStore;
  members: MemberStore;
  readSettings: () => Promise<RoomSettings>;
  now: () => number;
  log: Logger;
}

function seed(id: string, name: string, role: Role, at: string): MemberRecord {
  return memberRecordSchema.parse({
    id,
    name,
    role: role.kind === "supervisor" ? "supervisor" : "lead",
    provider: role.provider,
    model: role.model,
    ...(role.modeId !== undefined ? { modeId: role.modeId } : {}),
    ...(role.thinkingOptionId !== undefined ? { thinkingOptionId: role.thinkingOptionId } : {}),
    ...(role.features !== undefined ? { features: role.features } : {}),
    memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * Seed two members the first time a v1 `rooms.json` is migrated. A corrupt or
 * existing `members.json` is never overwritten: `missingFile()` is true only for
 * ENOENT, so corruption degrades to an empty member store, not a re-seed.
 */
export async function migrateMembers(deps: MigrateMembersDeps): Promise<{ seeded: boolean }> {
  if (!deps.members.missingFile() || !deps.store.migratedFromV1()) {
    return { seeded: false };
  }

  const settings = await deps.readSettings();
  const supervisor = settings.roles.find((role) => role.kind === "supervisor");
  const lead = settings.roles.find((role) => role.kind === "lead");
  if (supervisor === undefined || lead === undefined) {
    deps.log.warn("member migration skipped: catalog has no lead", {
      error: supervisor === undefined ? "no supervisor role" : "no lead role",
    });
    return { seeded: false };
  }

  const at = new Date(deps.now()).toISOString();
  const records: MemberRecord[] = [
    seed("default-supervisor", supervisor.name, supervisor, at),
    seed("default-lead", lead.name, lead, at),
  ];
  for (const record of records) await deps.members.upsert(record);
  await deps.members.flush();
  await deps.store.flush();

  deps.log.info("members migrated", {
    members: records.length,
    rooms: deps.store.listRooms().length,
  });
  return { seeded: true };
}

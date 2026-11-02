import { describe, expect, it } from "vitest";

import { ROOMS_FILE_VERSION, roomsFileSchema } from "./room";

const roomV1 = {
  id: "R",
  task: "fix",
  cwd: "/repo",
  workspaceId: null,
  createdAt: "2026-11-02T00:00:00.000Z",
};

describe("roomsFileSchema", () => {
  it("accepts v1 and normalizes member ids to null", () => {
    const parsed = roomsFileSchema.parse({ version: 1, rooms: [roomV1], seats: [], feed: [] });
    expect(parsed.rooms[0]).toMatchObject({ supervisorMemberId: null, leadMemberId: null });
  });

  it("accepts v2 with member ids", () => {
    const parsed = roomsFileSchema.parse({
      version: 2,
      rooms: [{ ...roomV1, supervisorMemberId: "sup-1", leadMemberId: "lead-1" }],
      seats: [],
      feed: [],
    });
    expect(parsed.version).toBe(ROOMS_FILE_VERSION);
    expect(parsed.rooms[0]).toMatchObject({ supervisorMemberId: "sup-1", leadMemberId: "lead-1" });
  });

  it("rejects an unknown version", () => {
    expect(roomsFileSchema.safeParse({ version: 3, rooms: [], seats: [], feed: [] }).success).toBe(
      false,
    );
  });
});

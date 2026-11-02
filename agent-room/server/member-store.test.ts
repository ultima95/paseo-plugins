import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memberRecordSchema, type Lesson } from "../shared/member";
import type { Logger } from "./logger";
import { createMemberStore, lessonKey } from "./member-store";

let dir: string;
let clock: number;
let seq: number;
let log: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-room-members-"));
  clock = Date.parse("2026-11-02T10:00:00.000Z");
  seq = 0;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function make() {
  return createMemberStore({ dir, now: () => (clock += 1000), newId: () => `m${++seq}`, log });
}

const record = (id: string, role: "supervisor" | "lead" = "lead") =>
  memberRecordSchema.parse({
    id,
    name: role === "lead" ? "Lead" : "Supervisor",
    role,
    provider: "claude",
    model: "claude-opus-5-5",
    memory: { promotion: "human" },
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
  });

const lesson = (scope: string, text: string): Lesson => ({
  at: "2026-11-02T10:00:00.000Z",
  scope,
  text,
  sourceRoomId: "R1",
  promotedBy: "human",
});

describe("createMemberStore", () => {
  it("persists records, charter, lessons and pending across instances", async () => {
    const a = make();
    await a.load();
    await a.upsert(record("lead-1"));
    await a.writeCharter("lead-1", "Use pnpm.");
    await a.appendLesson("lead-1", lesson("repo:8f3c1a2b", "use pnpm"));
    await a.appendPending("lead-1", {
      id: lessonKey("repo:8f3c1a2b", "prefer small diffs"),
      at: "2026-11-02T10:00:00.000Z",
      scope: "repo:8f3c1a2b",
      text: "prefer small diffs",
      sourceRoomId: "R1",
    });
    await a.flush();

    const b = make();
    await b.load();
    expect(b.list().map((member) => member.id)).toEqual(["lead-1"]);
    expect(b.charter("lead-1")).toBe("Use pnpm.");
    expect(b.lessons("lead-1")).toHaveLength(1);
    expect(b.pending("lead-1")).toHaveLength(1);
  });

  it("creates member files 0600 and directories 0700", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.writeCharter("lead-1", "x");
    await s.appendLesson("lead-1", lesson("global", "x"));
    await s.flush();

    expect((await stat(join(dir, "members"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "members", "lead-1"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "members", "lead-1", "charter.md"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "members", "lead-1", "lessons.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("skips a corrupt lesson line and keeps the rest", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.writeCharter("lead-1", "");
    await s.appendLesson("lead-1", lesson("global", "good"));
    await s.flush();

    const file = join(dir, "members", "lead-1", "lessons.jsonl");
    await writeFile(file, `${await readFile(file, "utf8")}{not json}\n`, "utf8");

    const b = make();
    await b.load();
    expect(b.lessons("lead-1").map((entry) => entry.text)).toEqual(["good"]);
    expect(log.warn).toHaveBeenCalledWith(
      "skipping corrupt lesson line",
      expect.objectContaining({ memberId: "lead-1" }),
    );
  });

  it("keeps independent failures: a corrupt members.json does not throw", async () => {
    await writeFile(join(dir, "members.json"), "{not json", "utf8");
    const s = make();
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.list()).toEqual([]);
    expect(s.missingFile()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "members store corrupt; starting empty",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("dedupes lessons by scope plus normalized text", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.appendLesson("lead-1", lesson("repo:8f3c1a2b", "Use  pnpm"));
    await s.appendLesson("lead-1", lesson("repo:8f3c1a2b", " use pnpm "));
    await s.flush();
    expect(s.lessons("lead-1")).toHaveLength(1);
  });

  it("accepts and rejects pending candidates", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    const candidate = {
      id: lessonKey("repo:8f3c1a2b", "use pnpm"),
      at: "2026-11-02T10:00:00.000Z",
      scope: "repo:8f3c1a2b",
      text: "use pnpm",
      sourceRoomId: "R1",
    };
    await s.appendPending("lead-1", candidate);

    const accepted = await s.acceptPending("lead-1", candidate.id);
    expect(accepted).toMatchObject({ text: "use pnpm", promotedBy: "human" });
    expect(s.pending("lead-1")).toHaveLength(0);
    expect(s.lessons("lead-1")).toHaveLength(1);

    const second = { ...candidate, id: lessonKey("global", "prefer small diffs"), scope: "global", text: "prefer small diffs" };
    await s.appendPending("lead-1", second);
    await s.rejectPending("lead-1", second.id);
    expect(s.pending("lead-1")).toHaveLength(0);
    expect(s.hasPending("lead-1", second.id)).toBe(true);
  });

  it("appends and reads episodes per room", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.appendEpisode("lead-1", "R1", {
      at: "2026-11-02T10:00:00.000Z",
      kind: "decision",
      signal: "DECISION_NEEDED",
      text: "use pnpm",
    });
    await s.appendEpisode("lead-1", "R2", {
      at: "2026-11-02T11:00:00.000Z",
      kind: "outcome",
      text: "room ended",
    });
    await s.flush();

    const facts = await s.episodes("lead-1");
    expect(facts.map((fact) => fact.roomId)).toEqual(["R1", "R2"]);
  });

  it("serialises appends in order", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    for (let i = 0; i < 20; i += 1) {
      await s.appendLesson("lead-1", lesson("global", `lesson ${i}`));
    }
    await s.flush();
    expect(s.lessons("lead-1").map((entry) => entry.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `lesson ${i}`),
    );
  });
});

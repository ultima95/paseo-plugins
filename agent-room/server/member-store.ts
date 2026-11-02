import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  MEMBERS_FILE_VERSION,
  episodeFactSchema,
  lessonSchema,
  membersFileSchema,
  memberRecordSchema,
  pendingCandidateSchema,
  type EpisodeFact,
  type Lesson,
  type MemberRecord,
  type PendingCandidate,
} from "../shared/member";
import type { Logger } from "./logger";

export interface MemberStoreDeps {
  /** The plugin data dir; `members.json` and `members/` live directly under it. */
  dir: string;
  now: () => number;
  newId: () => string;
  log: Logger;
}

export interface MemberStore {
  load(): Promise<void>;
  /** True when `members.json` did not exist at load (an ENOENT, not corruption). */
  missingFile(): boolean;
  list(): MemberRecord[];
  get(id: string): MemberRecord | undefined;
  upsert(record: MemberRecord): Promise<void>;
  charter(id: string): string;
  writeCharter(id: string, text: string): Promise<void>;
  lessons(id: string): Lesson[];
  /** Matching scopes, newest first. */
  lessonsFor(id: string, scopes: readonly string[]): Lesson[];
  hasLesson(id: string, scope: string, text: string): boolean;
  /** Live candidates only: no tombstones, no candidates already promoted. */
  pending(id: string): PendingCandidate[];
  /** True for any candidate line for this id, including a reject tombstone. */
  hasPending(id: string, candidateId: string): boolean;
  appendLesson(id: string, lesson: Lesson): Promise<boolean>;
  appendPending(id: string, candidate: PendingCandidate): Promise<boolean>;
  acceptPending(id: string, candidateId: string): Promise<Lesson | null>;
  rejectPending(id: string, candidateId: string): Promise<boolean>;
  appendEpisode(id: string, roomId: string, fact: EpisodeFact): Promise<void>;
  episodes(id: string): Promise<Array<EpisodeFact & { roomId: string }>>;
  flush(): Promise<void>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collapse whitespace and lowercase, so duplicates differ only by those. */
export function normalizeLessonText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable candidate/lesson identity: scope plus normalized text. */
export function lessonKey(scope: string, text: string): string {
  return createHash("sha256")
    .update(`${scope}\n${normalizeLessonText(text)}`)
    .digest("hex")
    .slice(0, 16);
}

/** Agent ids are UUIDs, but a room id still must not escape its directory. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function createMemberStore(deps: MemberStoreDeps): MemberStore {
  const { dir, now, log } = deps;

  let records: MemberRecord[] = [];
  let missing = false;
  const charters = new Map<string, string>();
  const lessonsById = new Map<string, Lesson[]>();
  const pendingById = new Map<string, PendingCandidate[]>();

  const queues = new Map<string, Promise<void>>();
  const RECORDS_QUEUE = "\u0000records";

  const enqueue = (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await task();
      } catch (error) {
        // A failed write must not poison later writes.
        log.error("member store write failed", { key, error: reason(error) });
      }
    });
    queues.set(key, next);
    return next;
  };

  const recordsFile = (): string => join(dir, "members.json");
  const memberDir = (id: string): string => join(dir, "members", safeSegment(id));
  const charterFile = (id: string): string => join(memberDir(id), "charter.md");
  const lessonsFile = (id: string): string => join(memberDir(id), "lessons.jsonl");
  const pendingFile = (id: string): string => join(memberDir(id), "pending.jsonl");
  const episodesDir = (id: string): string => join(memberDir(id), "episodes");
  const episodeFile = (id: string, roomId: string): string =>
    join(episodesDir(id), `${safeSegment(roomId)}.jsonl`);

  const ensureDir = async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  };

  const writeAtomic = async (file: string, text: string): Promise<void> => {
    await ensureDir(dirname(file));
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  };

  const appendJsonLine = async (file: string, value: unknown): Promise<void> => {
    await ensureDir(dirname(file));
    await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  const readJsonLines = async <T>(
    file: string,
    parse: (value: unknown) => T | null,
    onBadLine: (line: string) => void,
  ): Promise<T[]> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const values: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        onBadLine(trimmed);
        continue;
      }
      const parsed = parse(value);
      if (parsed === null) onBadLine(trimmed);
      else values.push(parsed);
    }
    return values;
  };

  const parseLesson = (value: unknown): Lesson | null => {
    const parsed = lessonSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  const parsePending = (value: unknown): PendingCandidate | null => {
    const parsed = pendingCandidateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  const parseEpisode = (value: unknown): EpisodeFact | null => {
    const parsed = episodeFactSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  const loadMemberFiles = async (id: string): Promise<void> => {
    try {
      charters.set(id, await readFile(charterFile(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      charters.set(id, "");
    }
    lessonsById.set(
      id,
      await readJsonLines(lessonsFile(id), parseLesson, () =>
        log.warn("skipping corrupt lesson line", { memberId: id }),
      ),
    );
    pendingById.set(
      id,
      await readJsonLines(pendingFile(id), parsePending, () =>
        log.warn("skipping corrupt pending line", { memberId: id }),
      ),
    );
  };

  const load = async (): Promise<void> => {
    records = [];
    missing = false;
    charters.clear();
    lessonsById.clear();
    pendingById.clear();

    let raw: string;
    try {
      raw = await readFile(recordsFile(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing = true;
        return;
      }
      log.warn("members store unreadable; starting empty", { error: reason(error) });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn("members store corrupt; starting empty", { error: reason(error) });
      return;
    }

    const result = membersFileSchema.safeParse(parsed);
    if (!result.success) {
      log.warn("members store corrupt; starting empty", {
        issues: result.error.issues.length,
        error: result.error.issues[0]?.message ?? "invalid members store",
      });
      return;
    }

    records = result.data.members;
    for (const member of records) await loadMemberFiles(member.id);
  };

  const upsert = async (record: MemberRecord): Promise<void> => {
    const parsed = memberRecordSchema.safeParse(record);
    if (!parsed.success) {
      log.error("rejected invalid member", { error: reason(parsed.error) });
      return;
    }
    const index = records.findIndex((candidate) => candidate.id === parsed.data.id);
    if (index === -1) records.push(parsed.data);
    else records[index] = parsed.data;
    await enqueue(RECORDS_QUEUE, () =>
      writeAtomic(
        recordsFile(),
        `${JSON.stringify({ version: MEMBERS_FILE_VERSION, members: records }, null, 2)}\n`,
      ),
    );
  };

  const list = (): MemberRecord[] =>
    [...records].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const get = (id: string): MemberRecord | undefined =>
    records.find((candidate) => candidate.id === id);

  const charter = (id: string): string => charters.get(id) ?? "";

  const writeCharter = async (id: string, text: string): Promise<void> => {
    charters.set(id, text);
    await enqueue(id, () => writeAtomic(charterFile(id), text));
  };

  const lessons = (id: string): Lesson[] => lessonsById.get(id) ?? [];

  const hasLesson = (id: string, scope: string, text: string): boolean => {
    const key = lessonKey(scope, text);
    return lessons(id).some((lesson) => lessonKey(lesson.scope, lesson.text) === key);
  };

  const lessKeys = (id: string): Set<string> =>
    new Set(lessons(id).map((lesson) => lessonKey(lesson.scope, lesson.text)));

  const lessonsFor = (id: string, scopes: readonly string[]): Lesson[] => {
    const wanted = new Set(scopes);
    return lessons(id)
      .filter((lesson) => wanted.has(lesson.scope))
      .sort((a, b) => b.at.localeCompare(a.at));
  };

  const hasPending = (id: string, candidateId: string): boolean =>
    (pendingById.get(id) ?? []).some((candidate) => candidate.id === candidateId);

  const pending = (id: string): PendingCandidate[] => {
    const promoted = lessKeys(id);
    const seen = new Set<string>();
    const live: PendingCandidate[] = [];
    const lines = pendingById.get(id) ?? [];
    // A tombstone shares its id with the original line and suppresses it.
    const rejected = new Set(
      lines.filter((candidate) => candidate.rejected === true).map((candidate) => candidate.id),
    );
    for (const candidate of lines) {
      if (candidate.rejected === true) continue;
      if (rejected.has(candidate.id)) continue;
      if (seen.has(candidate.id)) continue;
      if (promoted.has(lessonKey(candidate.scope, candidate.text))) continue;
      seen.add(candidate.id);
      live.push(candidate);
    }
    return live;
  };

  const appendLesson = async (id: string, lesson: Lesson): Promise<boolean> => {
    const parsed = lessonSchema.safeParse(lesson);
    if (!parsed.success) {
      log.error("rejected invalid lesson", { memberId: id, error: reason(parsed.error) });
      return false;
    }
    if (hasLesson(id, parsed.data.scope, parsed.data.text)) return false;
    lessonsById.set(id, [...lessons(id), parsed.data]);
    await enqueue(id, () => appendJsonLine(lessonsFile(id), parsed.data));
    return true;
  };

  const appendPending = async (id: string, candidate: PendingCandidate): Promise<boolean> => {
    const parsed = pendingCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
      log.error("rejected invalid pending candidate", {
        memberId: id,
        error: reason(parsed.error),
      });
      return false;
    }
    if (hasPending(id, parsed.data.id)) return false;
    if (hasLesson(id, parsed.data.scope, parsed.data.text)) return false;
    pendingById.set(id, [...(pendingById.get(id) ?? []), parsed.data]);
    await enqueue(id, () => appendJsonLine(pendingFile(id), parsed.data));
    return true;
  };

  const acceptPending = async (id: string, candidateId: string): Promise<Lesson | null> => {
    const candidate = pending(id).find((entry) => entry.id === candidateId);
    if (candidate === undefined) return null;
    const lesson: Lesson = {
      at: new Date(now()).toISOString(),
      scope: candidate.scope,
      text: candidate.text,
      sourceRoomId: candidate.sourceRoomId,
      promotedBy: "human",
    };
    const added = await appendLesson(id, lesson);
    return added ? lesson : null;
  };

  const rejectPending = async (id: string, candidateId: string): Promise<boolean> => {
    const candidate = pending(id).find((entry) => entry.id === candidateId);
    if (candidate === undefined) return false;
    const tombstone: PendingCandidate = {
      ...candidate,
      at: new Date(now()).toISOString(),
      rejected: true,
    };
    pendingById.set(id, [...(pendingById.get(id) ?? []), tombstone]);
    await enqueue(id, () => appendJsonLine(pendingFile(id), tombstone));
    return true;
  };

  const appendEpisode = async (id: string, roomId: string, fact: EpisodeFact): Promise<void> => {
    const parsed = episodeFactSchema.safeParse(fact);
    if (!parsed.success) {
      log.error("rejected invalid episode fact", { memberId: id, error: reason(parsed.error) });
      return;
    }
    await enqueue(id, () => appendJsonLine(episodeFile(id, roomId), parsed.data));
  };

  const episodes = async (id: string): Promise<Array<EpisodeFact & { roomId: string }>> => {
    let names: string[];
    try {
      names = await readdir(episodesDir(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const facts: Array<EpisodeFact & { roomId: string }> = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const roomId = name.slice(0, -".jsonl".length);
      const lines = await readJsonLines(
        join(episodesDir(id), name),
        parseEpisode,
        () => log.warn("skipping corrupt episode line", { memberId: id, roomId }),
      );
      for (const fact of lines) facts.push({ ...fact, roomId });
    }
    return facts.sort((a, b) => a.at.localeCompare(b.at));
  };

  const flush = async (): Promise<void> => {
    await Promise.all([...queues.values()]);
  };

  return {
    load,
    missingFile: () => missing,
    list,
    get,
    upsert,
    charter,
    writeCharter,
    lessons,
    lessonsFor,
    hasLesson,
    pending,
    hasPending,
    appendLesson,
    appendPending,
    acceptPending,
    rejectPending,
    appendEpisode,
    episodes,
    flush,
  };
}

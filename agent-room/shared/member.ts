import { z } from "zod";

import { seatConfigSchema } from "./roles";
import { timestampSchema } from "./room";

export const MEMBERS_FILE_VERSION = 1;
export const LESSON_TEXT_CAP = 240;
export const CHARTER_PROMPT_CAP = 4096;
export const MEMBER_SECTION_CAP = 6144;
export const LESSON_PROMPT_CAP = 12;

export const memoryScopeTypeSchema = z.enum(["global", "repo", "workspace"]);
export type MemoryScopeType = z.infer<typeof memoryScopeTypeSchema>;

export const GLOBAL_SCOPE = "global" as const;

/** Normalize a workspace path for exact-match scope identity. */
export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return trimmed;
  const slashed = trimmed.replace(/\\/g, "/");
  const isRoot = slashed === "/" || /^[A-Za-z]:\/$/.test(slashed);
  if (isRoot) return slashed;
  return slashed.replace(/\/+$/, "");
}

export function repoScope(id: string): string {
  return `repo:${id}`;
}

export function workspaceScope(path: string): string {
  return `workspace:${normalizeWorkspacePath(path)}`;
}

/** The type of a scope string. Validity is enforced by `memoryScopeSchema`. */
export function scopeType(scope: string): MemoryScopeType {
  if (scope === GLOBAL_SCOPE) return "global";
  if (scope.startsWith("repo:")) return "repo";
  return "workspace";
}

export const memoryScopeSchema = z.string().refine((scope) => {
  if (scope === GLOBAL_SCOPE) return true;
  if (scope.startsWith("repo:")) return /^repo:[0-9a-f]{8}$/.test(scope);
  if (scope.startsWith("workspace:")) return scope.length > "workspace:".length;
  return false;
}, "invalid memory scope");

export const memoryPolicySchema = z.object({
  // human: candidates wait in pending.jsonl. auto: candidates whose scope type
  // is listed in autoScopes are promoted without review.
  promotion: z.enum(["human", "auto"]),
  // Narrower than promotion on purpose: global lessons default to review.
  autoScopes: z.array(memoryScopeTypeSchema).default(["repo", "workspace"]),
});
export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;

export const memberRoleSchema = z.enum(["supervisor", "lead"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

/**
 * A member id, constrained where it is written and everywhere it is read.
 *
 * The store turns an id into a directory name, and its sanitiser (`safeSegment`)
 * maps every character outside `[A-Za-z0-9_-]` to `_` — so an unconstrained id
 * would let `a/b` and `a_b` alias onto one directory and silently share a
 * charter, lessons and episodes. 80 characters is the record's own cap, and the
 * seed ids (`default-supervisor`, `default-lead`) are inside it.
 */
export const memberIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, "member id must be letters, digits, hyphen or underscore");

export const memberRecordSchema = seatConfigSchema.extend({
  id: memberIdSchema,
  name: z.string().min(1).max(60),
  role: memberRoleSchema,
  memory: memoryPolicySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type MemberRecord = z.infer<typeof memberRecordSchema>;

export const membersFileSchema = z.object({
  version: z.literal(MEMBERS_FILE_VERSION),
  members: z.array(memberRecordSchema),
});
export type MembersFile = z.infer<typeof membersFileSchema>;

export const lessonSchema = z.object({
  at: timestampSchema,
  scope: memoryScopeSchema,
  text: z.string().min(1).max(LESSON_TEXT_CAP),
  sourceRoomId: z.string().min(1),
  promotedBy: z.enum(["human", "auto"]),
});
export type Lesson = z.infer<typeof lessonSchema>;

export const pendingCandidateSchema = z.object({
  id: z.string().min(1),
  at: timestampSchema,
  scope: memoryScopeSchema,
  text: z.string().min(1).max(LESSON_TEXT_CAP),
  sourceRoomId: z.string().min(1),
  // A tombstone the UI appends after a reject, so the candidate is not proposed again.
  rejected: z.literal(true).optional(),
});
export type PendingCandidate = z.infer<typeof pendingCandidateSchema>;

export const episodeKindSchema = z.enum(["task", "decision", "rejected", "outcome", "blocked"]);
export type EpisodeKind = z.infer<typeof episodeKindSchema>;

export const episodeFactSchema = z.object({
  at: timestampSchema,
  kind: episodeKindSchema,
  signal: z.string().optional(),
  text: z.string().min(1),
});
export type EpisodeFact = z.infer<typeof episodeFactSchema>;

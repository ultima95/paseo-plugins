import { scopeType, type MemberRecord, type MemoryPolicy } from "../shared/member";
import type { PromotionCandidate } from "./episode";
import type { Logger } from "./logger";
import type { MemberStore } from "./member-store";

export type PromotionTarget = "lesson" | "pending";

/** `human` always queues. `auto` promotes only the scope types it names. */
export function promotionTarget(policy: MemoryPolicy, scope: string): PromotionTarget {
  if (policy.promotion === "human") return "pending";
  return policy.autoScopes.includes(scopeType(scope)) ? "lesson" : "pending";
}

export interface ApplyPromotionInput {
  members: MemberStore;
  member: MemberRecord;
  candidates: readonly PromotionCandidate[];
  now: () => number;
  log: Logger;
}

/**
 * Route episode candidates into a member's memory. A candidate is dropped when
 * the lesson already exists, or when a pending line already carries its id —
 * `hasPending` counts tombstones too, so a rejected candidate is not proposed
 * again.
 */
export async function applyPromotion(
  input: ApplyPromotionInput,
): Promise<{ promoted: number; pending: number }> {
  let promoted = 0;
  let pending = 0;

  for (const candidate of input.candidates) {
    if (input.members.hasLesson(input.member.id, candidate.scope, candidate.text)) continue;
    if (input.members.hasPending(input.member.id, candidate.id)) continue;

    if (promotionTarget(input.member.memory, candidate.scope) === "lesson") {
      const added = await input.members.appendLesson(input.member.id, {
        at: new Date(input.now()).toISOString(),
        scope: candidate.scope,
        text: candidate.text,
        sourceRoomId: candidate.sourceRoomId,
        promotedBy: "auto",
      });
      if (added) promoted += 1;
    } else {
      const added = await input.members.appendPending(input.member.id, {
        id: candidate.id,
        at: candidate.at,
        scope: candidate.scope,
        text: candidate.text,
        sourceRoomId: candidate.sourceRoomId,
      });
      if (added) pending += 1;
    }
  }

  if (promoted > 0 || pending > 0) {
    input.log.info("member candidates routed", { promoted, pending });
  }
  return { promoted, pending };
}

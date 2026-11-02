import type { MemberRecord } from "../shared/member";

export interface MemberIndex {
  all(): MemberRecord[];
  byId(id: string | null | undefined): MemberRecord | undefined;
  /**
   * The member whose seat the request already names. The pre-create hook has no
   * room id, so this is how a Lead member's seat is recognized (ruling R1).
   * Workers are never members, so a worker kind always finds nothing.
   */
  forSeat(
    role: MemberRecord["role"] | "worker",
    provider: string,
    model: string,
  ): MemberRecord | undefined;
}

export function indexMembers(members: readonly MemberRecord[]): MemberIndex {
  const byId = new Map(members.map((member) => [member.id, member]));
  return {
    all: () => [...members],
    byId: (id) => (id === null || id === undefined ? undefined : byId.get(id)),
    forSeat: (role, provider, model) =>
      members.find(
        (member) =>
          member.role === role && member.provider === provider && member.model === model,
      ),
  };
}

/** A lookup that finds nothing, used where members are not available (tests, workers). */
export const EMPTY_MEMBER_INDEX: MemberIndex = indexMembers([]);

import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

import { memberRecordSchema, type MemberRecord } from "../shared/member";
import {
  memberCharterRpc,
  memberGetRpc,
  memberListRpc,
  memberPendingRpc,
  memberSaveRpc,
} from "../shared/rpc";
import type { Logger } from "./logger";
import type { MemberStore } from "./member-store";

export interface MemberHandlerDeps {
  /** Loaded before any handler runs: `index.server.ts` awaits `loaded` first. */
  members: MemberStore;
  now: () => number;
  newId: () => string;
  log: Logger;
}

export interface MemberHandlers {
  list(): RpcOutput<typeof memberListRpc>;
  get(input: RpcInput<typeof memberGetRpc>): Promise<RpcOutput<typeof memberGetRpc>>;
  save(input: RpcInput<typeof memberSaveRpc>): Promise<RpcOutput<typeof memberSaveRpc>>;
  charter(input: RpcInput<typeof memberCharterRpc>): Promise<RpcOutput<typeof memberCharterRpc>>;
  pending(input: RpcInput<typeof memberPendingRpc>): Promise<RpcOutput<typeof memberPendingRpc>>;
}

/**
 * The member record RPCs. Everything here reads or writes the member store the
 * room hooks and `agent.create` already use, so the screens and the seats can
 * never disagree about who a member is: `get` is the whole of a member's state,
 * and `save` is one whole-record write whose timestamps the handler owns.
 */
export function createMemberHandlers(deps: MemberHandlerDeps): MemberHandlers {
  const { members } = deps;

  return {
    list() {
      return { members: members.list() };
    },

    async get(input) {
      const member = members.get(input.memberId);
      // An unknown id is a stale link, not an error — the client navigates away.
      if (member === undefined) return { missing: true };
      return {
        member,
        charter: members.charter(member.id),
        lessons: members.lessons(member.id),
        pending: members.pending(member.id),
        episodes: await members.episodes(member.id),
      };
    },

    async save(input) {
      const existing = input.id === undefined ? undefined : members.get(input.id);
      const at = new Date(deps.now()).toISOString();
      // Parsed rather than cast: an omitted `autoScopes` is filled in by the
      // policy's default here, so the record written is the record served.
      const record: MemberRecord = memberRecordSchema.parse({
        id: input.id ?? deps.newId(),
        name: input.name,
        role: input.role,
        provider: input.provider,
        model: input.model,
        ...(input.modeId !== undefined ? { modeId: input.modeId } : {}),
        ...(input.thinkingOptionId !== undefined ? { thinkingOptionId: input.thinkingOptionId } : {}),
        ...(input.features !== undefined ? { features: input.features } : {}),
        memory: input.memory,
        // An existing member keeps the day it was created; everything else is
        // the moment of this write.
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      });
      await members.upsert(record);
      deps.log.info("member saved", { memberId: record.id, role: record.role });
      return { member: record };
    },

    async charter(input) {
      if (members.get(input.memberId) === undefined) {
        throw new Error(`member.charter: member not found: ${input.memberId}`);
      }
      await members.writeCharter(input.memberId, input.text);
      return { ok: true };
    },

    async pending(input) {
      if (members.get(input.memberId) === undefined) {
        throw new Error(`member.pending: member not found: ${input.memberId}`);
      }
      if (input.action === "reject") {
        // A reject writes a tombstone; nothing else is returned to show.
        await members.rejectPending(input.memberId, input.candidateId);
        return { ok: true };
      }
      const lesson = await members.acceptPending(input.memberId, input.candidateId);
      // `null` covers both a vanished candidate and one whose lesson already
      // existed: either way there is nothing to report as promoted.
      if (lesson === null) {
        throw new Error(`member.pending: candidate not found: ${input.candidateId}`);
      }
      return { ok: true, lesson };
    },
  };
}

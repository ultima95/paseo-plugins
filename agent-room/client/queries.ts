/**
 * Query keys shared by every screen in this plugin.
 *
 * `member.list` is one entry under this namespace: the Members screen writes it,
 * the Rooms launch pickers and chips read it, and the room tree names its seats
 * from it. Screens that share the key see a member created or removed elsewhere
 * without a remount.
 */
export const MEMBERS_QUERY_KEY: string[] = ["agent-room", "members"];

/** How often a screen re-reads the member list: membership rarely changes. */
export const MEMBERS_REFETCH_MS = 2000;

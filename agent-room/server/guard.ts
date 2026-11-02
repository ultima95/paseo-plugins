import type { Role } from "../shared/roles";

/** What a parent role may create. The guard is the enforcement half of the protocol. */
export type SpawnVerdict = { allowed: true } | { allowed: false; rule: string };

/**
 * Decide whether `parent` may spawn `child`. A `null` parent is not a room seat,
 * so the agent is unmanaged and every child it creates is allowed — the guard
 * only ever judges traffic inside a room. A `null` child under a seat carries no
 * role, so it is denied (the user's ruling: an unmarked child of a room seat is
 * archived).
 *
 * Rule text is generated from the catalog so it names the role the violator
 * should have used; the hard-coded names are only a fallback for a catalog that
 * is missing a kind (schema-invalid, so never in practice).
 */
export function checkSpawn(
  parent: Role | null,
  child: Role | null,
  roles: readonly Role[],
): SpawnVerdict {
  if (parent === null) return { allowed: true };

  const lead = roles.find((role) => role.kind === "lead");
  const worker = roles.find((role) => role.kind === "worker");

  switch (parent.kind) {
    case "supervisor":
      if (child?.kind === "lead") return { allowed: true };
      return {
        allowed: false,
        rule: `${parent.name} may only create Lead agents; title the child "${lead?.name ?? "Lead"}: <workstream>"`,
      };
    case "lead":
      if (child?.kind === "worker") return { allowed: true };
      return {
        allowed: false,
        rule: `${parent.name} may only create worker-role agents; title the child "${worker?.name ?? "Implementer"}: <outcome>"`,
      };
    case "worker":
      return { allowed: false, rule: `${parent.name} creates no agents; report to your Lead instead` };
  }
}

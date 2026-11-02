import { roleSeat, type Role, type RoomSettings } from "../shared/roles";

import { PROMPTS } from "./prompts/generated";

/** The role rules are the last thing a seat reads, so they stay in view. */
const ROLE_TABLE_HEADING = "## Room roles";

function code(value: string): string {
  return `\`${value}\``;
}

function providerModel(role: Role): string {
  return code(`${role.provider}/${role.model}`);
}

/** Keep a settings-supplied `useFor` inside its table cell. */
function tableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

const KIND_PROMPTS = {
  supervisor: PROMPTS.supervisor,
  lead: PROMPTS.lead,
  worker: PROMPTS.peer,
} as const;

/**
 * What this role may create, and on which seat. The plugin resolves the role
 * named in the child's title and forces its provider, model, mode and thinking
 * level, so the table is the whole routing rule a seat needs.
 */
export function renderRoleTable(role: Role, settings: RoomSettings): string {
  if (role.kind === "supervisor") {
    const leads = settings.roles.filter((candidate) => candidate.kind === "lead");
    return [
      ROLE_TABLE_HEADING,
      "",
      `You create Lead agents, and nothing else. A child is titled \`${leads[0]?.name ?? "Lead"}: <workstream>\`.`,
      "",
      "| Role you create | Title | Provider / model |",
      "|---|---|---|",
      ...leads.map((lead) => `| ${lead.name} | ${code(`${lead.name}: <workstream>`)} | ${providerModel(lead)} |`),
      "",
      "Never launch a worker role directly, and never launch an agent whose title carries no role: a child of a room seat with no role is archived by the room guard.",
    ].join("\n");
  }

  if (role.kind === "lead") {
    const workers = settings.roles.filter((candidate) => candidate.kind === "worker");
    return [
      ROLE_TABLE_HEADING,
      "",
      `You create worker-role agents, and nothing else. A child is titled \`${workers[0]?.name ?? "Implementer"}: <bounded outcome>\`.`,
      "",
      "| Role | Title | Provider / model | Use for |",
      "|---|---|---|---|",
      ...workers.map(
        (worker) =>
          `| ${worker.name} | ${code(`${worker.name}: <outcome>`)} | ${providerModel(worker)} | ${tableCell(worker.useFor)} |`,
      ),
      "",
      "A role that is not in this table does not exist. Leave `settings` off the `create_agent` call: the role sets mode and thinking level itself.",
    ].join("\n");
  }

  const seat = roleSeat(role);
  return [
    ROLE_TABLE_HEADING,
    "",
    `- your role: ${code(role.name)} (${code(`${seat.provider}/${seat.model}`)})`,
    "- you create no agents",
  ].join("\n");
}

/**
 * The seat's system prompt: the shared protocol, its kind's role, the role
 * brief, then the role table. An existing system prompt is kept in front of
 * all of it rather than replaced.
 */
export function renderSystemPrompt(
  role: Role,
  settings: RoomSettings,
  existing?: string,
): string {
  const parts = [
    existing ?? "",
    PROMPTS.protocol,
    KIND_PROMPTS[role.kind],
    role.brief ?? "",
    renderRoleTable(role, settings),
  ];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

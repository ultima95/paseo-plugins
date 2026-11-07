import {
  CHARTER_PROMPT_CAP,
  LESSON_PROMPT_CAP,
  LESSON_TEXT_CAP,
  MEMBER_SECTION_CAP,
  type Lesson,
} from "../shared/member";
import { roleSeat, workerBudget, type Role, type RoomSettings } from "../shared/roles";

import { PROMPTS } from "./prompts/generated";

/** The role rules are the last thing a seat reads, so they stay in view. */
const ROLE_TABLE_HEADING = "## Room roles";

function code(value: string): string {
  return `\`${value}\``;
}

function providerModel(seat: { provider: string; model: string }): string {
  return code(`${seat.provider}/${seat.model}`);
}

export interface MemberPrompt {
  name: string;
  charter: string;
  lessons: readonly Lesson[];
}

export interface MemberRender {
  text: string;
  truncated: boolean;
}

export interface PromptContext {
  member?: MemberRender;
  /** The room's bound Lead member, shown in a Supervisor's role table. */
  leadMember?: { provider: string; model: string };
}

/**
 * Deterministic, count-and-order truncation only: the same member and room must
 * always render the same prompt. Never model-judged.
 */
export function renderMemberSection(member: MemberPrompt): MemberRender {
  let truncated = false;

  let charterText = member.charter.trim();
  if (charterText.length > CHARTER_PROMPT_CAP) {
    charterText = `${charterText.slice(0, CHARTER_PROMPT_CAP).trimEnd()}\n[charter truncated]`;
    truncated = true;
  }

  const newest = [...member.lessons].sort((a, b) => b.at.localeCompare(a.at));
  const selected = newest.slice(0, LESSON_PROMPT_CAP);
  if (selected.length < newest.length) truncated = true;

  const lessonLines = selected.map(
    (lesson) => `- [${lesson.at}] [${lesson.scope}] ${lesson.text.slice(0, LESSON_TEXT_CAP)}`,
  );

  const parts = ["## Member", `Name: ${member.name}.`];
  if (charterText.length > 0) parts.push("### Charter", charterText);
  if (lessonLines.length > 0) parts.push("### Lessons", ...lessonLines);

  let text = parts.join("\n");
  if (text.length > MEMBER_SECTION_CAP) {
    text = `${text.slice(0, MEMBER_SECTION_CAP).trimEnd()}\n[member section truncated]`;
    truncated = true;
  }
  return { text, truncated };
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
 * The worker's stop condition. Always rendered, even when the role sets none:
 * a worker created without an explicit bound still receives the default, because
 * an unbounded investigation is the failure mode this guards against.
 */
function renderWorkerBudget(role: Role): string {
  return ["## Budget", workerBudget(role)].join("\n");
}

/**
 * What this role may create, and on which seat. The plugin resolves the role
 * named in the child's title and forces its provider, model, mode and thinking
 * level, so the table is the whole routing rule a seat needs.
 */
export function renderRoleTable(
  role: Role,
  settings: RoomSettings,
  leadMember?: { provider: string; model: string },
): string {
  if (role.kind === "supervisor") {
    const leads = settings.roles.filter((candidate) => candidate.kind === "lead");
    return [
      ROLE_TABLE_HEADING,
      "",
      `You create Lead agents, and nothing else. A child is titled \`${leads[0]?.name ?? "Lead"}: <workstream>\`.`,
      ...(leadMember !== undefined
        ? [
            "",
            "The room's Lead member runs the first Lead row below. Pass its provider exactly as shown; the plugin applies its mode and thinking level.",
          ]
        : []),
      "",
      "| Role you create | Title | Provider / model |",
      "|---|---|---|",
      ...leads.map(
        (lead, index) =>
          `| ${lead.name} | ${code(`${lead.name}: <workstream>`)} | ${providerModel(
            index === 0 && leadMember !== undefined ? leadMember : lead,
          )} |`,
      ),
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
 * brief, the member section, then the role table. An existing system prompt is kept in front of
 * all of it rather than replaced.
 */
export function renderSystemPrompt(
  role: Role,
  settings: RoomSettings,
  existing?: string,
  context: PromptContext = {},
): string {
  const parts = [
    existing ?? "",
    PROMPTS.protocol,
    KIND_PROMPTS[role.kind],
    role.brief ?? "",
    ...(role.kind === "worker" ? [renderWorkerBudget(role)] : []),
    context.member?.text ?? "",
    renderRoleTable(role, settings, context.leadMember),
  ];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

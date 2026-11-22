// Staff-aide transport for "Code it" missions (lib/practice/codeItMissions.ts):
// a Python Quest tied to one Algebra 2 practice skill, offered to a named
// scholar. Lists the missions with the scholar's standing on each skill, or
// offers one through internal.questProposals.offerCodeItQuestForUser, the same
// offer core the Slack Quest-idea button uses, which decides who may offer.
//
// Teacher roles only, and every scholar is resolved inside the caller's
// scholar lens (`allowedScholarIds`), like lib/mathPlanTools.ts. The skill
// standing is the four-state `status` get_scholar_skill_tree reports
// (projectSkillTreeNode), read through the same internal query.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AideEmit } from "./aideStream";
import { ALGEBRA_2_DOMAIN } from "../seed/algebra2Graph";
import { CODE_IT_MISSIONS } from "./practice/codeItMissions";
import {
  projectSkillTreeNode,
  type SkillTreeNode,
} from "./practiceSkillTreeTools";
import { isTeacherRole, type Role } from "./roles";
import { matchScholarByName } from "./scholarReadTools";

export const CODE_IT_TOOL_NAME = "offer_code_it_quest" as const;

type SkillStatus = SkillTreeNode["status"];

/** Most ready first. */
const STATUS_ORDER: Record<SkillStatus, number> = {
  demonstrated: 0,
  inferred: 1,
  in_progress: 2,
  not_started: 3,
};

/** What the aide can say about each status, plainly. */
const STATUS_MEANING: Record<SkillStatus, string> = {
  demonstrated: "fluent through practice",
  inferred: "placed through it (fluent-level placement credit, not practiced to fluency)",
  in_progress: "started in practice, not yet fluent",
  not_started: "not started in practice yet",
};

type OfferState = "waiting" | "set_aside" | "started" | "unlocked_started" | "other";

const OFFER_MEANING: Record<OfferState, string> = {
  waiting: "offered already; waiting in the scholar's Quests list",
  set_aside: "offered already; the scholar set it aside",
  started: "offered already; the scholar started it",
  unlocked_started:
    "no teacher offered it; it unlocked on its own when the scholar became fluent on the skill, and the scholar started it",
  other: "offered already",
};

const SKILL_KEYS = CODE_IT_MISSIONS.map((m) => m.skillKey);

export const CODE_IT_TOOL_DESCRIPTION =
  "Offer a scholar a \"Code it\" mission: a Python Quest tied to one Algebra 2 practice skill, meant for a scholar who has become fluent on that skill and likes to code. " +
  "The scholar writes the program themselves in the Python bench, with the tutor as a lab partner. It never counts as practice: it is not graded and moves no mastery. " +
  "Missions are offered one at a time, one per call. " +
  "Call it WITHOUT skillKey first to list the missions with the scholar's status on each skill (most ready first) and which ones this scholar has already been offered; that call offers nothing. " +
  "Call it WITH skillKey to offer that one mission: it appears as an offered Quest in the scholar's Quests list, which they can start or set aside. Offering the same skill again returns the earlier offer and sends nothing new. " +
  "A mission can also unlock on its own, with no teacher, for a scholar who is fluent on the skill through practice and has turned coding challenges on (they start off; an offer from you reaches the scholar either way); if the scholar started one that way, the result says so, and nothing is offered. " +
  "The status is the same four-state status get_scholar_skill_tree reports; only `demonstrated` means fluent through practice. If the scholar has not reached fluency on the skill, the offer still goes through and the result says so, so tell the teacher. " +
  `Available skillKeys: ${SKILL_KEYS.join(", ")}.`;

export async function makeCodeItTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    allowedScholarIds?: Set<Id<"users">>;
  },
) {
  if (!isTeacherRole(opts.role)) return [];
  const { callerUserId, allowedScholarIds } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  async function resolveScholarStrict(scholarName: string) {
    const { scholars } = (await ctx.runQuery(
      internal.curriculumAssistant.listScholarsInternal,
      {
        includeProgramGuests: true,
        ...(allowedScholarIds
          ? { allowedScholarIds: [...allowedScholarIds] }
          : {}),
      },
    )) as { scholars: Array<{ id: string; name: string }> };
    const visible = allowedScholarIds
      ? scholars.filter((scholar) =>
          allowedScholarIds.has(scholar.id as Id<"users">),
        )
      : scholars;
    return matchScholarByName(scholarName, visible);
  }

  /** The scholar's status and label on each mission skill. */
  async function missionSkills(scholarId: Id<"users">) {
    const tree = (await ctx.runQuery(
      internal.practiceSkills.treeForScholarInternal,
      { scholarId, domain: ALGEBRA_2_DOMAIN },
    )) as { nodes: Record<string, unknown>[] };
    const wanted = new Set(SKILL_KEYS);
    const bySkill = new Map<string, SkillTreeNode>();
    for (const raw of tree.nodes) {
      if (!wanted.has(raw.skillKey as string)) continue;
      const node = projectSkillTreeNode(raw);
      bySkill.set(node.skillKey, node);
    }
    return bySkill;
  }

  function done(result: string): string {
    emit({ toolComplete: { name: CODE_IT_TOOL_NAME, result } });
    return result;
  }

  const offerTool = betaTool({
    name: CODE_IT_TOOL_NAME,
    description: CODE_IT_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar's exact, unambiguous name.",
        },
        skillKey: {
          type: "string" as const,
          enum: SKILL_KEYS,
          description:
            "The mission's skill. Omit to list the missions without offering anything.",
        },
      },
      required: ["scholarName"] as const,
    },
    run: async (input: { scholarName: string; skillKey?: string }) => {
      const match = await resolveScholarStrict(input.scholarName);
      if (match.kind === "ambiguous") {
        return done(
          `Ambiguous scholar "${input.scholarName}" matches ${match.candidates.map((c) => c.name).join(", ")}. Use the exact name; nothing was offered.`,
        );
      }
      if (match.kind === "none") {
        return done(`No scholar matched "${input.scholarName}". Nothing was offered.`);
      }
      const scholarId = match.scholar.id as Id<"users">;
      const scholarName = match.scholar.name;
      const skills = await missionSkills(scholarId);
      const statusOf = (skillKey: string): SkillStatus =>
        skills.get(skillKey)?.status ?? "not_started";

      if (input.skillKey === undefined) {
        const offers = (await ctx.runQuery(
          internal.questProposals.codeItOffersForScholarInternal,
          { scholarId },
        )) as Array<{ skillKey: string; state: OfferState }>;
        const offerBySkill = new Map(offers.map((o) => [o.skillKey, o.state]));
        const missions = CODE_IT_MISSIONS.map((m, index) => ({ m, index }))
          .sort(
            (a, b) =>
              STATUS_ORDER[statusOf(a.m.skillKey)] -
                STATUS_ORDER[statusOf(b.m.skillKey)] || a.index - b.index,
          )
          .map(({ m }) => {
            const status = statusOf(m.skillKey);
            const offered = offerBySkill.get(m.skillKey);
            return {
              skillKey: m.skillKey,
              skill: skills.get(m.skillKey)?.label ?? m.skillKey,
              title: m.title,
              mission: m.mission,
              status,
              statusMeaning: STATUS_MEANING[status],
              alreadyOffered: offered !== undefined && offered !== "unlocked_started",
              startedOnTheirOwn: offered === "unlocked_started",
              ...(offered ? { offer: OFFER_MEANING[offered] } : {}),
            };
          });
        emit({
          toolComplete: {
            name: CODE_IT_TOOL_NAME,
            result: `Listed ${missions.length} Code it missions for ${scholarName}`,
          },
        });
        return JSON.stringify({
          scholar: scholarName,
          offeredNothing: true,
          missions,
        });
      }

      const status = statusOf(input.skillKey);
      const outcome = (await ctx.runMutation(
        internal.questProposals.offerCodeItQuestForUser,
        { offererId: callerUserId, scholarId, skillKey: input.skillKey },
      )) as {
        created: boolean;
        title: string;
        mission: string;
        startedByScholar: boolean;
      };
      const readiness =
        status === "demonstrated" || status === "inferred"
          ? null
          : `Note for the teacher: ${scholarName} is ${STATUS_MEANING[status]} on this skill, so the mission may be ahead of them.`;
      const sees = outcome.created
        ? `Offered "${outcome.title}" to ${scholarName}. It is now an offered Quest in their Quests list that they can start or set aside; starting it opens the Python bench with the tutor as lab partner. It is not practice and moves no mastery.`
        : outcome.startedByScholar
          ? `${scholarName} already started "${outcome.title}" on their own: it unlocked when they became fluent on the skill, with no teacher offer. Nothing was offered.`
          : `${scholarName} was already offered "${outcome.title}", so nothing new was sent.`;
      emit({
        toolComplete: {
          name: CODE_IT_TOOL_NAME,
          result: outcome.created
            ? `Offered ${outcome.title} to ${scholarName}`
            : `${scholarName} already had ${outcome.title}`,
        },
      });
      return JSON.stringify({
        scholar: scholarName,
        created: outcome.created,
        ...(outcome.startedByScholar ? { startedOnTheirOwn: true } : {}),
        title: outcome.title,
        mission: outcome.mission,
        skillStatus: status,
        result: sees,
        ...(readiness ? { readiness } : {}),
      });
    },
  });

  return [offerTool];
}

// Practice skill-tree aide tool — the chat/voice transport over the read side
// of the homegrown skills graph (convex/practiceSkills.ts). This is what lets
// the Slack bot / MCP aide answer "which algebra-1 skills are unlocked vs
// locked and by what prerequisite" for a named scholar.
//
// Composed into assembleCurriculumTools (lib/aideTools.ts) behind the same
// teacher/admin gate as the assignment + master-schedule tools (it shows a
// named scholar's learning record). Gated inline here (returns [] otherwise)
// so callers spread the result unconditionally. Shared verbatim by the
// in-app aide, Slack, + MCP.
//
// Read-only: this module exposes ONLY get_scholar_skill_tree. The former
// per-scholar focus-curation read/write tools were removed with the retired
// hard-serving control-plane cutover; this tool never reads or writes that
// state.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isTeacherRole, type Role } from "./roles";
import { PRACTICE_DOMAINS } from "./practice/domains";
import type { AideEmit } from "./aideStream";
import { resolveScholarByName } from "./scholarReadTools";

const DOMAIN_SLUGS = PRACTICE_DOMAINS.map((d) => d.domain);

export async function makePracticeSkillTreeTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    allowedScholarIds?: Set<Id<"users">>;
  },
) {
  // Same audience as the scholar-record read/write tools: a named scholar's
  // learning record. Teacher/admin only.
  if (!isTeacherRole(opts.role)) return [];
  const { allowedScholarIds } = opts;

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const domainEnumDesc = `One of: ${DOMAIN_SLUGS.join(", ")}`;

  // Whitelist of node fields the tree tool exposes, projected into a FOUR-STATE
  // `status` (`not_started` | `in_progress` | `inferred` | `demonstrated`) so the
  // model can never again read a never-touched node — or a below-fluent partial
  // credit — as mastered. Deliberately EXCLUDES:
  //   • `missStreak` — a teacher/parent-only deficit signal a scholar could read
  //     as a "you're bad at this" label (rabbithole-practice-engine.md); the tool
  //     doesn't need it and the model must not be handed it to repeat.
  //   • `proficiency` — a pure rep-band that reads "fluent" even when isFluent is
  //     false. It is folded INTO `status` here (see below) and not surfaced raw.
  //   • raw `repetition`/`halfLifeDays`/`lastPracticedAt`/`becameFluentAt`/latency
  //     — rep-band internals not needed for this conversation and enabling the
  //     same false-fluent inference.
  //
  // Why `status` and not the raw `demonstrated` flag: `treeForScholarInternal`
  // sets `demonstrated: isDemonstratedSource(source)`, which is TRUE for a node
  // with NO mastery row (never practiced — `?? "practice"` default) AND for a
  // row with only 1 rep of real practice (below the fluent band). The web map
  // relies on `proficiency` to keep such nodes from rendering green; this tool
  // strips `proficiency`, so the raw flag alone told the model a never-practiced
  // (or barely-started) node was mastered (the prod defect, 2026-09-02).
  //
  // The honest gate for the GREEN/mastered claim is the FLUENT rep BAND
  // (`proficiencyFromReps` → "fluent" | "overlearned", i.e. repetition ≥
  // FLUENT_REPS — the exact bar `isFluent` uses), combined with the source rule:
  //   • demonstrated = fluent band AND a demonstrated source (practice-earned) —
  //     the ONLY status describable as mastered.
  //   • inferred     = fluent band AND a non-demonstrated source (placement /
  //     accelerated / re-probe): access-proven, unlocks downstream, NOT mastery.
  //   • in_progress  = any credit BELOW the fluent band, whatever the source
  //     (1 rep of practice, a scaffolded partial credit), OR zero credit with an
  //     attempt on record — the scholar has worked on it but is not yet fluent.
  //   • not_started  = no credit and no attempt on record.
  type TreeNode = {
    skillKey: string;
    label: string;
    domain: string;
    strand: string | null;
    grade: string | null;
    standardCodes: string[];
    frontier: boolean;
    status: "not_started" | "in_progress" | "inferred" | "demonstrated";
    demonstrated: boolean;
    retention: string;
  };
  const projectNode = (n: Record<string, unknown>): TreeNode => {
    // The FLUENT band is the gate for any mastered/placed claim: "fluent" or
    // "overlearned" ⇔ repetition ≥ FLUENT_REPS (the isFluent bar). "practicing"
    // is real-but-below-fluent credit; "not_started" is zero reps.
    const proficiency = n.proficiency as string | undefined;
    const isFluentBand = proficiency === "fluent" || proficiency === "overlearned";
    const rawDemonstrated = n.demonstrated === true;
    // Attempt-on-record signal at the zero-credit band: `treeForScholarInternal`
    // returns `lastPracticedAt` but NOT `lastAttemptAt`. `lastAttemptAt` is the
    // honest attempt stamp, but the ONLY caller-visible timestamp here is
    // `lastPracticedAt`. A first WRONG attempt stamps `lastPracticedAt` at reps 0
    // (applyAttempt on a miss), so at the zero-credit band its presence marks an
    // attempt. (Above zero credit `lastPracticedAt` can be placement-inflated,
    // but those rows are already in the fluent band and never reach this test.)
    const hasAttempt = n.lastPracticedAt != null;
    let status: TreeNode["status"];
    if (isFluentBand) {
      status = rawDemonstrated ? "demonstrated" : "inferred";
    } else if (proficiency === "practicing" || hasAttempt) {
      status = "in_progress";
    } else {
      status = "not_started";
    }
    return {
      skillKey: n.skillKey as string,
      label: n.label as string,
      domain: n.domain as string,
      strand: (n.strand as string | null) ?? null,
      grade: (n.grade as string | null) ?? null,
      standardCodes: (n.standardCodes as string[]) ?? [],
      frontier: n.frontier === true,
      status,
      // Only a practice-earned, fluent-band node is `demonstrated`; the other
      // three statuses are all false, so nothing short of real mastery reads
      // as mastered.
      demonstrated: status === "demonstrated",
      retention: n.retention as string,
    };
  };

  const getTreeTool = betaTool({
    name: "get_scholar_skill_tree",
    description:
      "Read a scholar's skill TREE for a practice domain: every knowledge node with `frontier` (ready to practice now — all prerequisites met), a four-state `status`, `retention` (freshness label), `strand`, `grade`, and `standardCodes`, PLUS the prerequisite `edges` (fromKey → toKey, including cross-domain edges) that show WHICH skills are locked and by which specific prerequisite. " +
      "The `status` field is the ONLY honest signal for how well the scholar knows a node, and has exactly four values: " +
      "`demonstrated` = genuinely earned to fluency through real practice — this is the ONLY value you may describe as mastered/learned/proven. " +
      "`inferred` = access-proven, fluent-level placement/accelerated/re-probe credit: the scholar PLACED THROUGH it (e.g. in a Math Check-In), which is REAL, access-proven credit that unlocks downstream skills — but it is NOT proven mastery, so describe it as 'placed through' or 'tested out of', never 'mastered'. " +
      "`in_progress` = the scholar has worked on this skill (some practice or a recorded attempt) but has NOT reached fluency yet — describe it as 'in progress' or 'started, not yet fluent', never as mastered and never as 'placed through'. " +
      "`not_started` = never seen, no attempt, no evidence either way — say the engine has NOT probed this skill yet; it is NOT 'due', NOT a gap, and NOT a failure. " +
      "`demonstrated` (boolean) is TRUE only when `status` is `demonstrated`; `inferred`, `in_progress`, and `not_started` are all demonstrated:false. " +
      "`retention` is FRESHNESS only: `retention: \"due\"` on an `inferred` node means the placement credit is AGING and is due for a re-probe — it does NOT mean the scholar failed anything or lost the skill. Never read `due` as a deficit. " +
      "Pass a single `domain` (default whole-number arithmetic) to answer 'which algebra-1 skills are unlocked vs locked and by what prerequisite'; pass `allDomains: true` for the whole unified map (larger payload; `domain` is ignored when allDomains is true). " +
      "The tree contains EVERY domain for every scholar regardless of their Math plan: a node being present says nothing about whether the scholar can practice it or sees it, so call get_scholar_math_plan for that. " +
      "Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar's name (case-insensitive partial match).",
        },
        domain: {
          type: "string" as const,
          enum: DOMAIN_SLUGS,
          description: `${domainEnumDesc}. Omit to default to whole-number arithmetic. Ignored when allDomains is true.`,
        },
        allDomains: {
          type: "boolean" as const,
          description: "Merge every seeded domain into one tree (default false). When true, `domain` is ignored. Larger payload; prefer a single domain when you know which one.",
        },
      },
      required: ["scholarName"] as const,
    },
    run: async (input: { scholarName: string; domain?: string; allDomains?: boolean }) => {
      const scholar = await resolveScholarByName(ctx, input.scholarName, allowedScholarIds);
      if (!scholar) {
        emit({ toolComplete: { name: "get_scholar_skill_tree", result: `No scholar matched "${input.scholarName}"` } });
        return `No scholar found matching "${input.scholarName}".`;
      }
      // allDomains WINS: when set, `domain` is not forwarded, so the merged tree
      // is returned regardless of any domain the model also passed (matches the
      // description).
      const tree = (await ctx.runQuery(internal.practiceSkills.treeForScholarInternal, {
        scholarId: scholar.id as Id<"users">,
        ...(input.allDomains
          ? { allDomains: true }
          : input.domain
            ? { domain: input.domain }
            : {}),
      })) as {
        nodes: Record<string, unknown>[];
        edges: { fromKey: string; toKey: string }[];
        domains: string[];
        domainLabels: Record<string, string>;
        domain: string | null;
      };
      emit({
        toolComplete: {
          name: "get_scholar_skill_tree",
          result: `${scholar.name}: ${tree.nodes.length} nodes, ${tree.edges.length} edges (${tree.domains.join(", ")})`,
        },
      });
      return JSON.stringify({
        scholar: scholar.name,
        domain: tree.domain,
        domains: tree.domains,
        domainLabels: tree.domainLabels,
        nodes: tree.nodes.map(projectNode),
        edges: tree.edges,
      });
    },
  });

  return [getTreeTool];
}

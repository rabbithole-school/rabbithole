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

  // Whitelist of node fields the tree tool exposes. Deliberately EXCLUDES:
  //   • `missStreak` — a teacher/parent-only deficit signal a scholar could read
  //     as a "you're bad at this" label (rabbithole-practice-engine.md); the tool
  //     doesn't need it and the model must not be handed it to repeat.
  //   • `proficiency` — a pure rep-band that reads "fluent" even when isFluent is
  //     false. The honest signal is `demonstrated` (+ `retention` for freshness).
  //   • raw `repetition`/`halfLifeDays`/`lastPracticedAt`/`becameFluentAt`/latency
  //     — rep-band internals not needed for this conversation and enabling the
  //     same false-fluent inference.
  type TreeNode = {
    skillKey: string;
    label: string;
    domain: string;
    strand: string | null;
    grade: string | null;
    standardCodes: string[];
    frontier: boolean;
    demonstrated: boolean;
    retention: string;
  };
  const projectNode = (n: Record<string, unknown>): TreeNode => ({
    skillKey: n.skillKey as string,
    label: n.label as string,
    domain: n.domain as string,
    strand: (n.strand as string | null) ?? null,
    grade: (n.grade as string | null) ?? null,
    standardCodes: (n.standardCodes as string[]) ?? [],
    frontier: n.frontier === true,
    demonstrated: n.demonstrated === true,
    retention: n.retention as string,
  });

  const getTreeTool = betaTool({
    name: "get_scholar_skill_tree",
    description:
      "Read a scholar's skill TREE for a practice domain: every knowledge node with `frontier` (ready to practice now — all prerequisites met), `demonstrated` (TRUE = genuinely earned by real practice; FALSE = inferred placement/accelerated credit — NOT proven mastery), `retention` (freshness label), `strand`, `grade`, and `standardCodes`, PLUS the prerequisite `edges` (fromKey → toKey, including cross-domain edges) that show WHICH skills are locked and by which specific prerequisite. Pass a single `domain` (default whole-number arithmetic) to answer 'which algebra-1 skills are unlocked vs locked and by what prerequisite'; pass `allDomains: true` for the whole unified map (larger payload; `domain` is ignored when allDomains is true). ALWAYS honor `demonstrated`: a node that is not `demonstrated` is NOT proven mastery. Read-only.",
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

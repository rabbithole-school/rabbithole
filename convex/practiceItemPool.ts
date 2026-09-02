/**
 * Practice ITEM POOL — the teacher-facing view + edit surface over what the
 * practice engine serves for each knowledge node (the "how do practice units
 * get made, and can I change them?" seam).
 *
 * A node's items come from up to three sources, and this module makes all
 * three inspectable in one place:
 *   1. the deterministic TEMPLATE (convex/lib/practice/templates.ts) — code,
 *      infinite variants, correct by construction. Read-only here; we render
 *      deterministic PREVIEWS so a teacher can see exactly what a scholar gets.
 *   2. stored `practiceItems` rows — the verified-LLM word problems
 *      (convex/practiceGen.ts) and hand-authored items. Editable here.
 *   3. manipulatives — `practiceItems` rows carrying a `ManipulativeSpec`.
 *      Editable here (spec JSON), guarded by `assertGradableManipulative`.
 *
 * Gating: `curriculumQuery`/`curriculumMutation` (teacher + admin +
 * curriculum_designer). This is DESIGN-side catalog content — no scholar data —
 * so the canonical answers ARE returned to staff. They must never flow into a
 * scholar-facing read (the scholar session path in practiceSkills.ts stays the
 * only serving seam, and it strips answers).
 *
 * Every public function has an `internal*` twin so the staff-aide bot tools
 * (convex/lib/practicePoolTools.ts) run the SAME core helpers — one behavior,
 * two transports (UI + chat), per the coreAide* pattern.
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { curriculumMutation, curriculumQuery } from "./lib/customFunctions";
import { getActiveOverlay, requireCurriculumAccessAction } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";
import { generateItem, hasTemplate } from "./lib/practice/templates";
import {
  formatAnswer,
  formatAnswerForDisplay,
  formatUnit,
  parseAnswer,
  parseUnitKey,
  textNamesUnit,
  UNIT_KEYS,
  type AnswerType,
} from "./lib/practice/answers";
import { PRE_WARMED_CONCEPTUAL } from "./lib/practice/coverage";
import { practiceDomainLabel } from "./lib/practice/domains";
import { REGISTERED_PRACTICE_DOMAINS } from "./knowledgeNodes";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../lib/manipulative/practiceContract";
import {
  assertGradableManipulative,
  assertRenderableManipulative,
} from "../lib/manipulative/authoring";
import type { ManipulativeSpec } from "../lib/manipulative/types";
import {
  ALL_MANIPULATIVE_KINDS,
  type ManipulativeKind,
} from "../lib/manipulative/types";
import { groupManipulativeKindUsage } from "./lib/practice/manipulativeKindUsage";

// ── shapes ────────────────────────────────────────────────────────────────

/** Fixed seeds so the template previews are stable across renders/reloads —
 *  a teacher refreshing sees the SAME sample items, not a slot machine. */
const PREVIEW_SEEDS = [101, 202, 303, 404, 505];

/** Word-problem answer types a human may author/edit. Deliberately narrower
 *  than the template engine's `AnswerType`: `multipleChoice` needs a `choices`
 *  array `practiceItems` has no column for, and the scholar number pad only
 *  supports these three. */
const AUTHORABLE_ANSWER_TYPES = new Set<AnswerType>(["integer", "decimal", "fraction"]);

type ItemView = {
  id: Id<"practiceItems">;
  stem: string;
  answerType: string;
  /** The canonical answer — STAFF-FACING ONLY (empty for manipulatives). */
  answer: string;
  /** Display-form measurement unit the answer must carry ("cm³"), or null for
   *  the (default) value-only grading. See `validateAnswerUnit` for the
   *  stem-names-the-unit gate this field is subject to on write. */
  answerUnit: string | null;
  verifierKind: string;
  manipulativeSpec: string | null;
  source: string;
  model: string | null;
  verifiedAt: number;
  /** Stretch-tier curation fields (null = core rotation / untagged). */
  tier: string | null;
  technique: string | null;
  bloomLevel: number | null;
};

function itemView(r: Doc<"practiceItems">): ItemView {
  return {
    id: r._id,
    stem: r.stem,
    answerType: r.answerType,
    answer: r.answerCanonical,
    answerUnit: r.answerUnit ?? null,
    verifierKind: r.verifierKind ?? "arithmetic",
    manipulativeSpec: r.manipulativeSpec ?? null,
    source: r.source,
    model: r.model ?? null,
    verifiedAt: r.verifiedAt,
    tier: r.tier ?? null,
    technique: r.technique ?? null,
    bloomLevel: r.bloomLevel ?? null,
  };
}

// ── validation (shared by create + update, UI + bot) ─────────────────────

/**
 * Validate an authored/edited WORD item; throws a human-readable reason.
 *
 * Returns the fields to store: the canonical answer, plus the canonical DISPLAY
 * form of the measurement unit the answer must carry (undefined = graded
 * value-only, which is every item that doesn't ask for one).
 */
function validateWordItem(
  stem: string,
  answerType: string,
  answer: string,
  answerUnit: string | undefined,
): { answerCanonical: string; answerUnit: string | undefined } {
  if (!stem.trim()) throw new Error("The problem stem can't be empty.");
  if (!AUTHORABLE_ANSWER_TYPES.has(answerType as AnswerType)) {
    throw new Error(
      `Answer type must be one of: ${[...AUTHORABLE_ANSWER_TYPES].join(", ")}.`,
    );
  }
  const parsed = parseAnswer(answer, answerType as AnswerType);
  if (parsed === null) {
    throw new Error(
      `"${answer}" isn't a valid ${answerType} answer (e.g. integer "42", decimal "6.5", fraction "3/4").`,
    );
  }
  // Store the normalized form so grading compares canonically (e.g. "6/8" → "3/4").
  return { answerCanonical: formatAnswer(parsed), answerUnit: validateAnswerUnit(stem, answerUnit) };
}

/**
 * Validate an authored answer unit against the shared grading registry. "" (and
 * absent) means the item is graded value-only.
 *
 * Both failures REFUSE rather than silently dropping the unit — unlike the LLM
 * path, an author is present to fix them, and a unit that quietly vanished would
 * read as saved. The stem check enforces the same invariant everywhere: a
 * required unit is fair only because the question asked for it.
 */
function validateAnswerUnit(stem: string, answerUnit: string | undefined): string | undefined {
  if (answerUnit === undefined || answerUnit.trim() === "") return undefined;
  const key = parseUnitKey(answerUnit);
  if (!key) {
    throw new Error(
      `"${answerUnit}" isn't a unit the grader knows. Use one of: ${UNIT_KEYS.map(formatUnit).join(", ")}.`,
    );
  }
  if (!textNamesUnit(stem, key)) {
    throw new Error(
      `The stem never asks for ${formatUnit(key)}, so requiring it would mark a correct answer wrong. Say the unit in the problem (e.g. "…in cubic centimeters") or leave the unit blank.`,
    );
  }
  return formatUnit(key);
}

/** Parse + gradability-check a manipulative spec JSON; throws on any problem. */
function validateManipulativeSpec(specJson: string): ManipulativeSpec {
  let spec: ManipulativeSpec;
  try {
    spec = JSON.parse(specJson) as ManipulativeSpec;
  } catch {
    throw new Error("manipulativeSpec must be valid JSON.");
  }
  // Same guard the seed fixtures use: an ungradable spec would be unsolvable
  // for a scholar (isSolved always false), so it must never be persisted.
  assertGradableManipulative(spec);
  // Raw-JSON authoring can produce a spec whose GOAL is fine but whose
  // structural fields are missing (no discs/rows/…) — gradable on paper,
  // crashes the scholar renderer on mount. Smoke-test through the same pure
  // builders the renderers use; also enforces a non-empty prompt.
  assertRenderableManipulative(spec);
  return spec;
}

// ── core helpers (shared by public + internal twins) ──────────────────────

async function nodeByKey(ctx: QueryCtx, nodeKey: string) {
  return await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
    .first();
}

/** Explicit result shape for poolForNode — referenced by generateForNode's
 *  same-module runQuery (see the circular-inference note there). */
export type PoolForNodeResult = {
  node: {
    nodeKey: string;
    label: string;
    domain: string;
    domainLabel: string;
    strand: string | null;
    grade: string | null;
    standardCodes: { framework: string; code: string }[];
  };
  hasTemplate: boolean;
  /** Whether targeted core practice can serve this node. Stretch-tier items are
   * deliberately excluded, matching the core coverage in `poolSummaryCore`. */
  practiceServeable: boolean;
  prewarmConceptual: boolean;
  templatePreviews: {
    stem: string;
    answer: string;
    answerType: string;
    choices: string[] | null;
  }[];
  items: ItemView[];
} | null;

export async function poolForNodeCore(
  ctx: QueryCtx,
  nodeKey: string,
): Promise<PoolForNodeResult> {
  const node = await nodeByKey(ctx, nodeKey);
  if (!node) return null;

  const rows = await ctx.db
    .query("practiceItems")
    .withIndex("by_skill", (q) => q.eq("skillKey", nodeKey))
    .collect();

  const templated = hasTemplate(nodeKey);
  const templatePreviews = templated
    ? PREVIEW_SEEDS.flatMap((seed) => {
        const it = generateItem(nodeKey, seed);
        return it
          ? [{
              stem: it.stem,
              answer: formatAnswerForDisplay(it.answer, it.choices),
              answerType: it.answerType as string,
              choices: it.choices ?? null,
            }]
          : [];
      })
    : [];

  return {
    node: {
      nodeKey: node.nodeKey,
      label: node.label,
      domain: node.domain,
      domainLabel: practiceDomainLabel(node.domain),
      strand: node.strand ?? null,
      grade: node.grade ?? null,
      standardCodes: node.standardCodes ?? [],
    },
    hasTemplate: templated,
    practiceServeable: templated || rows.some((row) => row.tier === undefined),
    prewarmConceptual: PRE_WARMED_CONCEPTUAL.has(nodeKey),
    templatePreviews,
    items: rows
      .map(itemView)
      .sort((a, b) => b.verifiedAt - a.verifiedAt),
  };
}

export async function poolSummaryCore(ctx: QueryCtx, domain: string) {
  const [nodes, items] = await Promise.all([
    ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect(),
    ctx.db
      .query("practiceItems")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect(),
  ]);

  const wordCount = new Map<string, number>();
  const manipCount = new Map<string, number>();
  const stretchCount = new Map<string, number>();
  for (const it of items) {
    if (
      it.tier === "stretch" &&
      (it.answerType !== "dialogue" || (it.rubricCriteria?.length ?? 0) > 0)
    ) {
      stretchCount.set(it.skillKey, (stretchCount.get(it.skillKey) ?? 0) + 1);
    }
    // Core is exactly tier-absent — `lib/practice/serve.ts` fails closed on
    // tier (both the stored-variant swap and the manipulative guarantee filter
    // `tier === undefined`), so a tier-present row is coverage the core
    // rotation can never serve. Counting one here would tell staff a node is
    // `serveable` when its drill has nothing to hand a scholar. Stretch rows
    // are already tallied above; unknown tiers count in NEITHER, matching the
    // "unknown tiers stay DARK" rule they're dark under at serve time.
    if (it.tier !== undefined) continue;
    const m = it.verifierKind === MANIPULATIVE_VERIFIER_KIND ? manipCount : wordCount;
    m.set(it.skillKey, (m.get(it.skillKey) ?? 0) + 1);
  }

  const nodeCoverage = nodes
    .map((n) => {
      const templated = hasTemplate(n.nodeKey);
      const stored = wordCount.get(n.nodeKey) ?? 0;
      const manips = manipCount.get(n.nodeKey) ?? 0;
      const stretches = stretchCount.get(n.nodeKey) ?? 0;
      return {
        nodeKey: n.nodeKey,
        label: n.label,
        strand: n.strand ?? null,
        grade: n.grade ?? null,
        hasTemplate: templated,
        prewarmConceptual: PRE_WARMED_CONCEPTUAL.has(n.nodeKey),
        itemCount: stored,
        hasManipulative: manips > 0,
        manipulativeCount: manips,
        hasStretch: stretches > 0,
        stretchCount: stretches,
        // A node no source covers can surface on the frontier but never be
        // practiced — the pool hole a teacher (or the bot) should fill first.
        serveable: templated || stored + manips > 0,
      };
    })
    .sort(
      (a, b) =>
        (a.strand ?? "").localeCompare(b.strand ?? "") ||
        (a.grade ?? "").localeCompare(b.grade ?? "") ||
        a.label.localeCompare(b.label),
    );

  type StrandRollup = {
    strand: string | null;
    totalNodes: number;
    templateNodeCount: number;
    storedItemNodeCount: number;
    storedItemCount: number;
    manipulativeNodeCount: number;
    manipulativeCount: number;
    stretchNodeCount: number;
    stretchCount: number;
  };
  const strandRollups = new Map<string | null, StrandRollup>();
  for (const node of nodeCoverage) {
    const rollup = strandRollups.get(node.strand) ?? {
      strand: node.strand,
      totalNodes: 0,
      templateNodeCount: 0,
      storedItemNodeCount: 0,
      storedItemCount: 0,
      manipulativeNodeCount: 0,
      manipulativeCount: 0,
      stretchNodeCount: 0,
      stretchCount: 0,
    };
    rollup.totalNodes++;
    if (node.hasTemplate) rollup.templateNodeCount++;
    if (node.itemCount > 0) rollup.storedItemNodeCount++;
    rollup.storedItemCount += node.itemCount;
    if (node.hasManipulative) rollup.manipulativeNodeCount++;
    rollup.manipulativeCount += node.manipulativeCount;
    if (node.hasStretch) rollup.stretchNodeCount++;
    rollup.stretchCount += node.stretchCount;
    strandRollups.set(node.strand, rollup);
  }

  return {
    domain,
    domainLabel: practiceDomainLabel(domain),
    nodes: nodeCoverage,
    strandRollups: [...strandRollups.values()].sort((a, b) =>
      (a.strand ?? "").localeCompare(b.strand ?? ""),
    ),
  };
}

export type DomainItemView = ItemView & {
  skillKey: string;
  skillLabel: string;
  strand: string | null;
  grade: string | null;
};

/** Stored question and manipulative inventory for one domain. Template coverage
 * stays in `poolSummaryCore`; templates are infinite generators, not stored
 * rows, so the UI represents each templated skill once rather than fabricating
 * a finite item count. */
export async function itemsForDomainCore(
  ctx: QueryCtx,
  domain: string,
): Promise<DomainItemView[]> {
  const [nodes, items] = await Promise.all([
    ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect(),
    ctx.db
      .query("practiceItems")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect(),
  ]);
  const nodesByKey = new Map(nodes.map((node) => [node.nodeKey, node]));

  return items
    .map((item) => {
      const node = nodesByKey.get(item.skillKey);
      return {
        ...itemView(item),
        skillKey: item.skillKey,
        skillLabel: node?.label ?? item.skillKey,
        strand: node?.strand ?? null,
        grade: node?.grade ?? null,
      };
    })
    .sort(
      (a, b) =>
        a.skillLabel.localeCompare(b.skillLabel) ||
        b.verifiedAt - a.verifiedAt,
    );
}

export type ManipulativeCoverageRow = {
  skillKey: string;
  label: string;
  strand: string | null;
  hasTemplate: boolean;
  storedWordCount: number;
  manipulativeCount: number;
};

/**
 * Per-skill manipulative coverage — "which skills have no interactive item
 * yet?" Same word/manipulative tally as `poolSummaryCore`, reshaped to the
 * coverage table's row shape. `domain` omitted ⇒ every REGISTERED domain (the
 * cross-domain readout), so a teacher isn't stuck picking a domain first.
 */
export async function manipulativeCoverageCore(
  ctx: QueryCtx,
  domain?: string,
): Promise<ManipulativeCoverageRow[]> {
  const domains = domain ? [domain] : REGISTERED_PRACTICE_DOMAINS;
  const rows: ManipulativeCoverageRow[] = [];
  for (const d of domains) {
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", d))
      .collect();
    const items = await ctx.db
      .query("practiceItems")
      .withIndex("by_domain", (q) => q.eq("domain", d))
      .collect();

    const wordCount = new Map<string, number>();
    const manipCount = new Map<string, number>();
    for (const it of items) {
      // Core is exactly tier-absent, same rule (and same reason) as
      // `poolSummaryCore`'s tally — see the comment there.
      if (it.tier !== undefined) continue;
      const m = it.verifierKind === MANIPULATIVE_VERIFIER_KIND ? manipCount : wordCount;
      m.set(it.skillKey, (m.get(it.skillKey) ?? 0) + 1);
    }

    for (const n of nodes) {
      rows.push({
        skillKey: n.nodeKey,
        label: n.label,
        strand: n.strand ?? null,
        hasTemplate: hasTemplate(n.nodeKey),
        storedWordCount: wordCount.get(n.nodeKey) ?? 0,
        manipulativeCount: manipCount.get(n.nodeKey) ?? 0,
      });
    }
  }
  // Stable default order — the UI's sortable table re-sorts client-side
  // (default manipulativeCount ascending), but a deterministic base order
  // keeps ties predictable across reloads.
  return rows.sort(
    (a, b) => a.manipulativeCount - b.manipulativeCount || a.label.localeCompare(b.label),
  );
}

export type ManipulativeKindUsageSkill = {
  skillKey: string;
  label: string;
  count: number;
};

export type ManipulativeKindUsageEntry = {
  kind: ManipulativeKind;
  itemCount: number;
  skillCount: number;
  /** The "Where it's used" list — busiest skill first, label-resolved. */
  skills: ManipulativeKindUsageSkill[];
};

export type ManipulativeKindUsageView = {
  /** Every kind, zero-filled — so the four mechanics with no items still appear
   *  (as `itemCount: 0`), which is the whole reason this readout exists. */
  byKind: ManipulativeKindUsageEntry[];
  /** Stored manipulative rows whose spec was malformed/legacy and couldn't be
   *  attributed to a current kind — surfaced, never dropped, so the scoreboard
   *  can't quietly understate reality. */
  unparseableCount: number;
};

/**
 * Kind USAGE cross-reference — "which mechanics have items, and which have
 * none?" The pool counts `manipulativeCount` per node but never parses a spec,
 * so kind → skill does not exist at any layer until here (the gap the
 * Manipulative Library needs closed to show its "In use / Never used" rows and
 * each kind's "Where it's used" list).
 *
 * Scope: the WHOLE registered practice catalog (every domain — same reach as
 * `manipulativeCoverageCore`), because a mechanic spans domains and the Library
 * browses across all of them. `practiceItems`/`knowledgeNodes` carry no
 * `institutionId` (the practice graph is a shared, code-seeded commons, not
 * tenant data), so there is no per-institution axis to filter and none is
 * invented — matching every sibling query in this file. Gating stays
 * `curriculumQuery` (staff): design-side catalog content, no scholar data.
 *
 * ALL tiers count: the question is "does authored content of this kind exist at
 * all", not "is it serveable right now", so a stretch-tier manipulative still
 * proves the kind is in use (unlike the serve-shaped `manipulativeCoverageCore`,
 * which is deliberately tier-absent-only).
 */
export async function manipulativeKindUsageCore(
  ctx: QueryCtx,
): Promise<ManipulativeKindUsageView> {
  const rows: { skillKey: string; manipulativeSpec: string | null | undefined }[] = [];
  const labelByKey = new Map<string, string>();
  for (const domain of REGISTERED_PRACTICE_DOMAINS) {
    const [nodes, items] = await Promise.all([
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect(),
      ctx.db
        .query("practiceItems")
        .withIndex("by_domain_verifierKind", (q) =>
          q.eq("domain", domain).eq("verifierKind", MANIPULATIVE_VERIFIER_KIND),
        )
        .collect(),
    ]);
    for (const n of nodes) labelByKey.set(n.nodeKey, n.label);
    for (const it of items) {
      rows.push({ skillKey: it.skillKey, manipulativeSpec: it.manipulativeSpec });
    }
  }

  const { byKind, unparseableCount } = groupManipulativeKindUsage(rows);
  return {
    byKind: ALL_MANIPULATIVE_KINDS.map((kind) => {
      const usage = byKind[kind];
      return {
        kind,
        itemCount: usage.itemCount,
        skillCount: usage.skillKeys.length,
        skills: usage.perSkill.map((s) => ({
          skillKey: s.skillKey,
          label: labelByKey.get(s.skillKey) ?? s.skillKey,
          count: s.count,
        })),
      };
    }),
    unparseableCount,
  };
}

type CreateItemArgs = {
  nodeKey: string;
  stem?: string;
  answerType?: string;
  answer?: string;
  /** Display-form measurement unit the answer must carry ("cm³"); "" / absent =
   *  graded value-only. Validated against the shared registry AND the stem. */
  answerUnit?: string;
  manipulativeSpec?: string;
  // Stretch-tier curation (schema comment on practiceItems.tier): "stretch"
  // stars an item into the opt-in "Go deeper" pool; absent/""/"core" = core
  // rotation.
  tier?: string;
  technique?: string;
  bloomLevel?: number;
};

/** Normalize the tier-curation args to a patch fragment. ""/"core" clears the
 *  field (back to the core rotation); bloomLevel is validated against the 0–5
 *  Bloom scale masteryObservations uses.
 *
 *  Starring an item into the stretch pool REQUIRES naming its insight
 *  technique (`existingTechnique` covers an update that keeps the doc's tag).
 *  This is the quality gate against "advanced = bigger numbers": a stretch
 *  item must be harder because it takes an IDEA (working_backward, casework,
 *  invariant, …), never because it has more digits or more steps — if the
 *  author can't name the idea, it isn't a stretch item. (The LLM generator
 *  never writes `tier` at all, so generated items can't reach this pool.) */
function tierPatch(
  args: { tier?: string; technique?: string; bloomLevel?: number },
  existingTechnique?: string,
) {
  const patch: { tier?: string; technique?: string; bloomLevel?: number } = {};
  if (args.tier !== undefined) {
    patch.tier = args.tier === "" || args.tier === "core" ? undefined : args.tier;
  }
  if (args.technique !== undefined) {
    patch.technique = args.technique === "" ? undefined : args.technique;
  }
  if (args.bloomLevel !== undefined) {
    if (args.bloomLevel < 0 || args.bloomLevel > 5) {
      throw new Error("bloomLevel must be on the 0–5 Bloom scale.");
    }
    patch.bloomLevel = args.bloomLevel;
  }
  if (patch.tier === "stretch") {
    const technique =
      args.technique !== undefined ? patch.technique : (patch.technique ?? existingTechnique);
    if (!technique) {
      throw new Error(
        "A stretch item must name its insight technique (e.g. working_backward, casework, invariant) — harder-by-bigger-numbers doesn't qualify.",
      );
    }
  }
  return patch;
}

export async function createItemCore(ctx: MutationCtx, args: CreateItemArgs) {
  const node = await nodeByKey(ctx, args.nodeKey);
  if (!node) throw new Error(`Unknown knowledge node "${args.nodeKey}".`);

  if (args.manipulativeSpec !== undefined) {
    const spec = validateManipulativeSpec(args.manipulativeSpec);
    const id = await ctx.db.insert("practiceItems", {
      skillKey: args.nodeKey,
      domain: node.domain,
      stem: (args.stem ?? spec.prompt).trim() || spec.prompt,
      answerType: MANIPULATIVE_ANSWER_TYPE,
      answerCanonical: "",
      verifierKind: MANIPULATIVE_VERIFIER_KIND,
      manipulativeSpec: JSON.stringify(spec),
      source: "authored",
      verifiedAt: Date.now(),
      ...tierPatch(args),
    });
    return { id, kind: "manipulative" as const };
  }

  if (!args.stem || !args.answerType || args.answer === undefined) {
    throw new Error("A word item needs stem, answerType, and answer.");
  }
  const validated = validateWordItem(args.stem, args.answerType, args.answer, args.answerUnit);
  const id = await ctx.db.insert("practiceItems", {
    skillKey: args.nodeKey,
    domain: node.domain,
    stem: args.stem.trim(),
    answerType: args.answerType,
    answerCanonical: validated.answerCanonical,
    ...(validated.answerUnit ? { answerUnit: validated.answerUnit } : {}),
    verifierKind: "arithmetic",
    source: "authored",
    verifiedAt: Date.now(),
    ...tierPatch(args),
  });
  return { id, kind: "word" as const };
}

type UpdateItemArgs = {
  id: Id<"practiceItems">;
  stem?: string;
  answerType?: string;
  answer?: string;
  /** Same semantics as CreateItemArgs; "" CLEARS the unit (back to value-only
   *  grading), mirroring how ""/"core" clears the stretch tier below. */
  answerUnit?: string;
  manipulativeSpec?: string;
  // Stretch-tier curation — same semantics as CreateItemArgs (""/"core" clears).
  tier?: string;
  technique?: string;
  bloomLevel?: number;
};

export async function updateItemCore(ctx: MutationCtx, args: UpdateItemArgs) {
  const doc = await ctx.db.get(args.id);
  if (!doc) throw new Error("Item not found.");

  const tp = tierPatch(args, doc.technique);
  const tierTouched =
    args.tier !== undefined || args.technique !== undefined || args.bloomLevel !== undefined;

  const isManip = doc.verifierKind === MANIPULATIVE_VERIFIER_KIND;
  if (isManip) {
    if (args.answer !== undefined || args.answerType !== undefined) {
      throw new Error("A manipulative has no answer string — edit its spec instead.");
    }
    const patch: Partial<Doc<"practiceItems">> = {};
    if (args.manipulativeSpec !== undefined) {
      const spec = validateManipulativeSpec(args.manipulativeSpec);
      patch.manipulativeSpec = JSON.stringify(spec);
      patch.stem = (args.stem ?? spec.prompt).trim() || spec.prompt;
    } else if (args.stem !== undefined) {
      if (!args.stem.trim()) throw new Error("The prompt can't be empty.");
      patch.stem = args.stem.trim();
    }
    if (Object.keys(patch).length === 0 && !tierTouched) throw new Error("Nothing to update.");
    // A human edited it → the human is now the verifier of record.
    await ctx.db.patch(args.id, { ...patch, ...tp, source: "authored", verifiedAt: Date.now() });
    return { id: args.id, skillKey: doc.skillKey };
  }

  if (args.manipulativeSpec !== undefined) {
    throw new Error("This is a word item — it has no manipulative spec.");
  }
  const stem = args.stem ?? doc.stem;
  const answerType = args.answerType ?? doc.answerType;
  const answer = args.answer ?? doc.answerCanonical;
  // Untouched → re-validate the doc's own unit against the (possibly edited)
  // stem, so rewriting the stem can't strand a unit it no longer asks for.
  const answerUnit = args.answerUnit ?? doc.answerUnit;
  const validated = validateWordItem(stem, answerType, answer, answerUnit);
  await ctx.db.patch(args.id, {
    stem: stem.trim(),
    answerType,
    answerCanonical: validated.answerCanonical,
    answerUnit: validated.answerUnit,
    ...tp,
    source: "authored",
    verifiedAt: Date.now(),
  });
  return { id: args.id, skillKey: doc.skillKey };
}

export async function deleteItemCore(ctx: MutationCtx, id: Id<"practiceItems">) {
  const doc = await ctx.db.get(id);
  if (!doc) throw new Error("Item not found.");
  await ctx.db.delete(id);
  return { skillKey: doc.skillKey, stem: doc.stem };
}

// ── public surface (teacher UI) ───────────────────────────────────────────

/** Everything the item-pool panel shows for one node: template previews +
 *  stored items (answers included — staff-only read). */
export const poolForNode = curriculumQuery({
  args: { nodeKey: v.string() },
  handler: async (ctx, args) => poolForNodeCore(ctx, args.nodeKey),
});

/** Per-node pool status for a whole domain — the catalog/triage list. */
export const poolSummary = curriculumQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => poolSummaryCore(ctx, args.domain),
});

/** Every stored item in one domain, with its skill metadata. Answers are
 * included, so this remains curriculum-gated like the per-node pool. */
export const itemsForDomain = curriculumQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => itemsForDomainCore(ctx, args.domain),
});

/** Per-skill manipulative coverage table — every domain when `domain` is
 *  omitted. Design-side catalog content, same gate as the rest of the pool. */
export const manipulativeCoverage = curriculumQuery({
  args: { domain: v.optional(v.string()) },
  handler: async (ctx, args) => manipulativeCoverageCore(ctx, args.domain),
});

/** Kind usage cross-reference — per mechanic, how many stored items and which
 *  skills use it (and how many rows are unattributable). Powers the Library's
 *  "In use / Never used" rail rows AND each kind's "Where it's used" list — one
 *  derived signal, two consumers. Catalog-wide (every registered domain), same
 *  staff gate as the rest of the pool. */
export const manipulativeKindUsage = curriculumQuery({
  args: {},
  handler: async (ctx) => manipulativeKindUsageCore(ctx),
});

export const createItem = curriculumMutation({
  args: {
    nodeKey: v.string(),
    stem: v.optional(v.string()),
    answerType: v.optional(v.string()),
    answer: v.optional(v.string()),
    // Display-form unit the answer must carry ("cm³"); "" / absent = value-only.
    answerUnit: v.optional(v.string()),
    manipulativeSpec: v.optional(v.string()),
    tier: v.optional(v.string()),
    technique: v.optional(v.string()),
    bloomLevel: v.optional(v.number()),
  },
  handler: async (ctx, args) => createItemCore(ctx, args),
});

export const updateItem = curriculumMutation({
  args: {
    id: v.id("practiceItems"),
    stem: v.optional(v.string()),
    answerType: v.optional(v.string()),
    answer: v.optional(v.string()),
    // Display-form unit the answer must carry ("cm³"); "" clears it.
    answerUnit: v.optional(v.string()),
    manipulativeSpec: v.optional(v.string()),
    tier: v.optional(v.string()),
    technique: v.optional(v.string()),
    bloomLevel: v.optional(v.number()),
  },
  handler: async (ctx, args) => updateItemCore(ctx, args),
});

export const deleteItem = curriculumMutation({
  args: { id: v.id("practiceItems") },
  handler: async (ctx, args) => deleteItemCore(ctx, args.id),
});

/**
 * Teacher-triggered run of the verified-LLM generation pipeline for one node
 * (the same Haiku → verifier gate → store path as the seed-time pre-warm).
 * `replace: true` clears the node's stored word items first — it does NOT
 * touch manipulatives (storeGeneratedItems replaces by skillKey, so we guard
 * here by refusing replace when manipulatives exist... see note below).
 */
export const generateForNode = action({
  args: {
    nodeKey: v.string(),
    count: v.optional(v.number()),
    replace: v.optional(v.boolean()),
  },
  // Explicit annotations throughout: this action calls back into its OWN
  // module's internal query (a Convex circular-inference trap — without them
  // the whole module's type collapses to `any` and cascades through the api
  // graph).
  handler: async (
    ctx,
    args,
  ): Promise<{
    requested: number;
    generated: number;
    verified: number;
    rejected: number;
    stored: number;
  }> => {
    await requireCurriculumAccessAction(ctx);
    // Impersonation ("viewing as") is READ-ONLY app-wide; the mutation
    // wrappers enforce it but an action gate doesn't — check explicitly so a
    // platform-admin browsing as a teacher can't trigger stored-item writes.
    const impersonating: boolean = await ctx.runQuery(
      internal.practiceItemPool.isImpersonatingInternal,
      {},
    );
    if (impersonating) {
      throw new Error(
        "Read-only while viewing as another user — exit impersonation to act as yourself.",
      );
    }
    if (args.replace) {
      // storeGeneratedItems's replace deletes EVERY practiceItems row for the
      // skill — including manipulatives. Replace them deliberately (delete in
      // the pool UI), not as a side effect of regenerating word problems.
      const pool: PoolForNodeResult = await ctx.runQuery(
        internal.practiceItemPool.poolForNodeInternal,
        { nodeKey: args.nodeKey },
      );
      if (pool?.items.some((it) => it.verifierKind === MANIPULATIVE_VERIFIER_KIND)) {
        throw new Error(
          "This node has manipulative items; regenerate-with-replace would delete them. Delete word items individually or remove the manipulatives first.",
        );
      }
    }
    const count = Math.max(1, Math.min(20, Math.floor(args.count ?? 8)));
    return await ctx.runAction(internal.practiceGen.generateVerifiedItems, {
      skillKey: args.nodeKey,
      count,
      replace: args.replace ?? false,
    });
  },
});

// ── internal twins (the staff-aide bot tools) ─────────────────────────────
// Role gating happens at tool-assembly time (assembleCurriculumTools →
// canDesignCurriculum), same as create_problem_set — these are not reachable
// from any client.

/** Action-side impersonation probe for generateForNode (actions have no db,
 *  so the overlay check runs here). Annotated to avoid the same-module
 *  circular-inference trap documented on generateForNode. */
export const isImpersonatingInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => (await getActiveOverlay(ctx)) !== null,
});

export const poolForNodeInternal = internalQuery({
  args: { nodeKey: v.string() },
  handler: async (ctx, args) => poolForNodeCore(ctx, args.nodeKey),
});

export const poolSummaryInternal = internalQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => poolSummaryCore(ctx, args.domain),
});

export const itemsForDomainInternal = internalQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => itemsForDomainCore(ctx, args.domain),
});

export const manipulativeCoverageInternal = internalQuery({
  args: { domain: v.optional(v.string()) },
  handler: async (ctx, args) => manipulativeCoverageCore(ctx, args.domain),
});

export const manipulativeKindUsageInternal = internalQuery({
  args: {},
  handler: async (ctx) => manipulativeKindUsageCore(ctx),
});

export const createItemInternal = internalMutation({
  args: {
    nodeKey: v.string(),
    stem: v.optional(v.string()),
    answerType: v.optional(v.string()),
    answer: v.optional(v.string()),
    // Display-form unit the answer must carry ("cm³"); "" / absent = value-only.
    answerUnit: v.optional(v.string()),
    manipulativeSpec: v.optional(v.string()),
    tier: v.optional(v.string()),
    technique: v.optional(v.string()),
    bloomLevel: v.optional(v.number()),
  },
  handler: async (ctx, args) => createItemCore(ctx, args),
});

export const updateItemInternal = internalMutation({
  args: {
    id: v.id("practiceItems"),
    stem: v.optional(v.string()),
    answerType: v.optional(v.string()),
    answer: v.optional(v.string()),
    // Display-form unit the answer must carry ("cm³"); "" clears it.
    answerUnit: v.optional(v.string()),
    manipulativeSpec: v.optional(v.string()),
    tier: v.optional(v.string()),
    technique: v.optional(v.string()),
    bloomLevel: v.optional(v.number()),
  },
  handler: async (ctx, args) => updateItemCore(ctx, args),
});

export const deleteItemInternal = internalMutation({
  args: { id: v.id("practiceItems") },
  handler: async (ctx, args) => deleteItemCore(ctx, args.id),
});

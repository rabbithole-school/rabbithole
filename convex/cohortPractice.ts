/**
 * Teacher-facing cohort-level practice queries.
 *
 * Complements practiceSkills.ts (owned by another lane — do not edit it) with
 * cohort mastery/placement reads the scholar-facing practice queries do not
 * expose.
 *
 * Auth model mirrors practiceSkills.ts exactly:
 *   - `teacherQuery` outer gate (teacher / admin role required)
 *   - `requireActiveScholarAccess` per-scholar institution-scoping
 *
 * Read-only — no mutations live here.
 */

import { v } from "convex/values";
import { ELECTIVE_PRACTICE_DOMAINS } from "./knowledgeNodes";
import { teacherQuery } from "./lib/customFunctions";
import { filterToAccessibleScholars, requireActiveScholarAccess } from "./lib/access";
import {
  computeFrontier,
  isDemonstratedSource,
  desiredRetentionTargets,
  proficiencyFromReps,
  retentionLabel,
  type SkillState,
} from "./lib/practice/scheduler";
import type { FactFluencyState } from "./lib/practice/factFluency";
import { loadFastMathProgress } from "./lib/practice/fastMathRead";
import type { FactOp } from "../shared/factKey";
import { buildNodeReadings, normalizeLabel } from "./lib/nodeDepthHelpers";
import { openPracticeFlags } from "./lib/practiceFlags";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "./seed/wholeNumberArithmeticGraph";
import { PRACTICE_DOMAINS } from "./lib/practice/domains";
import { frontierGradeValue, mathLevel } from "./lib/practice/frontierGrade";
import {
  automaticityProxy,
  masteryOf,
  type MasteryState,
  type TreeNode,
} from "../shared/treeMapLayout";
import { practiceDomainLabel } from "../shared/practiceDomainLabels";
import {
  automaticPlacementGrade,
  domainHasAffectSafeEntry,
} from "./lib/practice/placement";
import {
  summarizeDomainMap,
  type DomainMapInput,
  type DomainMapStatus,
} from "./lib/practice/domainMapStatus";
import {
  summarizeDomainRetention,
  type DomainRetentionInput,
} from "./lib/practice/domainRetention";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const MAX_MASTERY_SCHOLARS = 64;
const ZERO: SkillState = { repetition: 0, halfLifeDays: 0 };

// Ordinal ranking of the mastery bands, lowest → highest, so the cohort tree can
// take a MEDIAN band per node without inventing a new vocabulary. `placed`
// (access-proven but provisional) sits between `frontier` and the demonstrated
// green claim `fluent`, matching the dial palette's read. `struggling` (recent
// repeated misses) ranks just above `locked`: it's an ACCESSED-but-failing node,
// so it must pull a cohort median DOWN (below `frontier`, which is merely the
// unstarted horizon). Teacher-facing surface, so the red band is allowed here.
const BAND_ORDER: MasteryState[] = [
  "locked",
  "struggling",
  "frontier",
  "placed",
  "fluent",
  "overlearned",
];

function masteryState(
  row:
    | {
        repetition: number;
        halfLifeDays: number;
        lastPracticedAt?: number;
      }
    | undefined,
): SkillState {
  return row
    ? {
        repetition: row.repetition,
        halfLifeDays: row.halfLifeDays,
        lastPracticedAt: row.lastPracticedAt,
      }
    : ZERO;
}

/** One fact's teacher-facing heatmap cell. Carries the classified automaticity
 *  rung + the raw tallies (for a hover read), never a latency number or a clock
 *  the scholar could ever see — `state` is the only rendered signal, and it's
 *  self-relative (doctrine §5). */
export type FactHeatmapCell = {
  factKey: string;
  op: FactOp;
  /** Operands in canonical order (add/mul folded LO≤HI; sub as-written). */
  a: number;
  b: number;
  label: string;
  state: FactFluencyState;
  seenCount: number;
  correctCount: number;
};

/**
 * The per-fact automaticity heatmap for ONE scholar — the teacher-facing read
 * behind the +/−/× fact grids (the FastMath-analog picture). Returns the entire
 * canonical 418-fact space — including unseen facts — so the cells exactly
 * match the denominator used by the Fast Math percentage. Each cell carries
 * only the classified {@link FactFluencyState} rung (unseen → effortful →
 * practicing → fluent → automatic), painted with the sketch's ramp.
 *
 * `baselineKnown` tells the client whether we yet have a self-relative speed
 * read for this scholar: until they have enough timed skills the classifier
 * caps every fact at "practicing" (we never claim "fast" before we know their
 * normal speed), so the grid legend can say "still calibrating" rather than
 * imply the scholar is merely slow.
 *
 * Auth mirrors `strandProgressForScholar`: teacherQuery (admin / teacher role)
 * + `requireActiveScholarAccess` for institution-scoping. Read-only.
 */
export const factHeatmapForScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    domain: v.string(),
    // Optional single-operation filter ("add" | "sub" | "mul"); omitted ⇒ the
    // entire canonical space across all three operations.
    op: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ cells: FactHeatmapCell[]; baselineKnown: boolean }> => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    // The `op` arg is the canonical word form ("add" | "sub" | "mul");
    // anything else means no operation filter.
    const opFilter: FactOp | null =
      args.op === "add" || args.op === "sub" || args.op === "mul" ? args.op : null;

    // `domain` remains in the public contract because this query is mounted from
    // a domain report. The Fast Math ledger itself is canonical across domains,
    // matching the percentage read rather than hiding facts by their most recent
    // source row's domain stamp.
    void args.domain;
    const progress = await loadFastMathProgress(ctx, args.scholarId);
    const cells: FactHeatmapCell[] =
      opFilter === null
        ? progress.facts
        : progress.facts.filter((fact) => fact.op === opFilter);

    return { cells, baselineKnown: progress.baselineKnown };
  },
});

/**
 * One bounded subscription for the Math Skills mastery lens.
 *
 * The caller supplies the visible roster (all scholars, My scholars, or one
 * named group). The server narrows it through the active institution boundary,
 * then returns the same dot/arc readings the scholar Tree derives: no group
 * average and no second mastery vocabulary.
 */
export const masteryForScholars = teacherQuery({
  args: {
    scholarIds: v.array(v.id("users")),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const requestedScholarIds = [...new Set(args.scholarIds)];
    if (requestedScholarIds.length > MAX_MASTERY_SCHOLARS) {
      throw new Error(`Select ${MAX_MASTERY_SCHOLARS} scholars or fewer.`);
    }

    const scholarIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requestedScholarIds,
    );
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const [nodes, edgeRows] = await Promise.all([
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect(),
      ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect(),
    ]);
    const orderedNodes = [...nodes].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    const nodeKeys = orderedNodes.map((node) => node.nodeKey);
    const ownNodeKeys = new Set(nodeKeys);
    const edges = edgeRows
      .filter((edge) => edge.kind === "buildsOn")
      .map((edge) => ({ fromKey: edge.fromKey, toKey: edge.toKey }));
    const foreignPrerequisiteKeys = [
      ...new Set(
        edges
          .map((edge) => edge.fromKey)
          .filter((nodeKey) => !ownNodeKeys.has(nodeKey)),
      ),
    ];
    const retentionTargets = desiredRetentionTargets(nodeKeys, edges);
    const now = Date.now();
    const nodeKeyByNormalizedLabel = new Map<string, string>();
    for (const node of orderedNodes) {
      nodeKeyByNormalizedLabel.set(
        node.normalizedLabel ?? normalizeLabel(node.label),
        node.nodeKey,
      );
      nodeKeyByNormalizedLabel.set(normalizeLabel(node.nodeKey), node.nodeKey);
    }

    const scholars = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || scholar.role !== "scholar") continue;

      const [masteryRows, observations, practiceFlags] = await Promise.all([
        ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_domain", (q) =>
            q.eq("scholarId", scholarId).eq("domain", domain),
          )
          .collect(),
        ctx.db
          .query("masteryObservations")
          .withIndex("by_scholar_domain", (q) =>
            q.eq("scholarId", scholarId).eq("domain", domain),
          )
          .collect(),
        openPracticeFlags(ctx, scholarId, { domain }, now),
      ]);
      const masteryByKey = new Map(
        masteryRows.map((row) => [row.skillKey, row]),
      );

      // The placement "still mapping" state, adopted from the retired
      // strandProgressForScholar so the matrix can render an unmapped scholar
      // honestly (spec §3.4) instead of a bare "—". A domain with any mastery
      // row is "mapped"; with none, a parked probe log reads "in_progress",
      // otherwise "mapping". The placement lookup only runs for unmapped
      // scholars, so it costs nothing on the common path.
      let mappingState: "mapped" | "mapping" | "in_progress" = "mapped";
      if (masteryRows.length === 0) {
        const placement = await ctx.db
          .query("practicePlacements")
          .withIndex("by_scholar_domain", (q) =>
            q.eq("scholarId", scholarId).eq("domain", domain),
          )
          .first();
        mappingState =
          (placement?.probeLog?.length ?? 0) > 0 ? "in_progress" : "mapping";
      }

      const foreignStateByKey = new Map<string, SkillState>();
      for (const nodeKey of foreignPrerequisiteKeys) {
        const rows = await ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", scholarId).eq("skillKey", nodeKey),
          )
          .collect();
        let row = rows[0];
        if (rows.length > 1) {
          const node = await ctx.db
            .query("knowledgeNodes")
            .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
            .first();
          row = node
            ? (rows.find((candidate) => candidate.domain === node.domain) ?? rows[0])
            : rows[0];
        }
        if (row) foreignStateByKey.set(nodeKey, masteryState(row));
      }
      const stateOf = (nodeKey: string) => {
        const ownRow = masteryByKey.get(nodeKey);
        return ownRow
          ? masteryState(ownRow)
          : (foreignStateByKey.get(nodeKey) ?? ZERO);
      };
      const frontier = new Set(computeFrontier(nodeKeys, edges, stateOf));

      const observationsByNode = new Map<
        string,
        {
          masteryLevel: number;
          evidenceType: string;
          misconceptionStatus?: "open" | "addressed";
        }[]
      >();
      for (const observation of observations) {
        if (observation.isSuperseded) continue;
        const nodeKey =
          observation.nodeKey && ownNodeKeys.has(observation.nodeKey)
            ? observation.nodeKey
            : nodeKeyByNormalizedLabel.get(
                normalizeLabel(observation.conceptLabel),
              );
        if (!nodeKey) continue;
        const bucket = observationsByNode.get(nodeKey) ?? [];
        bucket.push(observation);
        observationsByNode.set(nodeKey, bucket);
      }
      const depthReadings = buildNodeReadings(
        [...observationsByNode].map(([nodeKey, nodeObservations]) => ({
          nodeKey,
          observations: nodeObservations,
        })),
        true,
      );
      const depthByNode = new Map(
        depthReadings.map((reading) => [reading.nodeKey, reading]),
      );
      const practiceFlaggedKeys = new Set(
        practiceFlags.map((flag) => flag.nodeKey),
      );

      const readings = orderedNodes.map((node) => {
        const row = masteryByKey.get(node.nodeKey);
        const state = masteryState(row);
        const retention = retentionLabel(
          state,
          now,
          retentionTargets.get(node.nodeKey),
        );
        const treeNode: TreeNode = {
          skillKey: node.nodeKey,
          label: node.label,
          domain: node.domain,
          strand: node.strand ?? null,
          grade: node.grade ?? null,
          repetition: state.repetition,
          becameFluentAt: row?.becameFluentAt ?? null,
          lastPracticedAt: state.lastPracticedAt ?? null,
          proficiency: proficiencyFromReps(state.repetition),
          retention,
          frontier: frontier.has(node.nodeKey),
          demonstrated: isDemonstratedSource(row?.source),
          missStreak: row?.missStreak ?? 0,
        };
        const depth = depthByNode.get(node.nodeKey);
        const practiceFlag = practiceFlaggedKeys.has(node.nodeKey);
        return {
          nodeKey: node.nodeKey,
          mastery: masteryOf(treeNode),
          automaticity: automaticityProxy(treeNode),
          depth: depth?.depth ?? 0,
          frontier: treeNode.frontier,
          flagged: depth?.hasOpenMisconception === true || practiceFlag,
        };
      });

      const domainGrades = new Map(orderedNodes.map((node) => [node.nodeKey, node.grade]));
      scholars.push({
        scholarId,
        name: scholar.name ?? scholar.username ?? "Scholar",
        image: scholar.image ?? null,
        mappingState,
        readings,
        // The scholar's grade level in this domain: the SAME level the Math
        // Skills portrait shows (`mathLevel`, over the same rows and the same
        // domain catalog, placement credit included), so a teacher sees one
        // grade per scholar. Never re-derived from `readings` on the client.
        // `highestGradeValue` is the legacy figure the portrait shows beside
        // it (`frontierGradeValue`: highest grade shown in daily practice).
        gradeValue: mathLevel(masteryRows, domainGrades)?.value ?? null,
        highestGradeValue: frontierGradeValue(masteryRows, domainGrades),
        // Tier 2's freshness read (spec §10.2) — one domain-wide aggregate
        // over the SAME mastery rows already loaded for `readings`, not a
        // second fetch. Never surfaced on the cell itself.
        retention: summarizeDomainRetention(masteryRows, now),
      });
    }

    return { domain, scholars };
  },
});

/**
 * The aggregate COHORT tree for one domain — the Tree lens of the Math Skills
 * studio's Mastery view.
 *
 * The node SET (skills + prerequisite edges + grade/strand) is scholar-agnostic
 * (`knowledgeNodes`/`knowledgeNodeEdges` by domain), so every scholar shares one
 * grid; only per-skill mastery differs. This query loads that grid once, derives
 * each visible scholar's per-node band with the SAME `masteryOf` the scholar
 * Tree and the mastery matrix use (no second mastery vocabulary), then collapses
 * the cohort to one reading per node:
 *   - `band`        — the cohort MEDIAN band (drives the node colour).
 *   - `bands`       — the full histogram (drives a spread ring: how split the
 *                     cohort is on this skill).
 *   - `frontierCount` — scholars whose working edge is here (drives the cohort
 *                     frontier band); a node is on the cohort frontier if ≥1.
 *
 * Returned in the exact `{ nodes, edges }` shape `buildTreeVMs` consumes, so the
 * client reuses the proven DAG-column + strand-lane layout untouched. Access
 * locks are DELIBERATELY not overlaid here — they are the rail's / list's
 * canonical signal, and the tree stays a single mastery-progress rendering.
 *
 * Auth mirrors `masteryForScholars`: teacherQuery + institution-scoped filter.
 */
export const cohortTree = teacherQuery({
  args: {
    scholarIds: v.array(v.id("users")),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const requestedScholarIds = [...new Set(args.scholarIds)];
    if (requestedScholarIds.length > MAX_MASTERY_SCHOLARS) {
      throw new Error(`Select ${MAX_MASTERY_SCHOLARS} scholars or fewer.`);
    }
    const scholarIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requestedScholarIds,
    );
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;

    const [nodeRows, edgeRows] = await Promise.all([
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect(),
      ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect(),
    ]);
    const orderedNodes = [...nodeRows].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    const nodeKeys = orderedNodes.map((node) => node.nodeKey);
    const ownNodeKeys = new Set(nodeKeys);
    const edges = edgeRows
      .filter((edge) => edge.kind === "buildsOn")
      .map((edge) => ({ fromKey: edge.fromKey, toKey: edge.toKey }));
    const foreignPrerequisiteKeys = [
      ...new Set(
        edges
          .map((edge) => edge.fromKey)
          .filter((nodeKey) => !ownNodeKeys.has(nodeKey)),
      ),
    ];

    // Per-node accumulators across the cohort.
    const bandCounts = new Map<string, Record<MasteryState, number>>();
    const repSum = new Map<string, number[]>();
    const frontierCount = new Map<string, number>();
    for (const nodeKey of nodeKeys) {
      bandCounts.set(nodeKey, {
        locked: 0,
        struggling: 0,
        frontier: 0,
        placed: 0,
        fluent: 0,
        overlearned: 0,
      });
      repSum.set(nodeKey, []);
      frontierCount.set(nodeKey, 0);
    }

    let scholarCount = 0;
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || scholar.role !== "scholar") continue;
      scholarCount += 1;

      const masteryRows = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholarId).eq("domain", domain),
        )
        .collect();
      const masteryByKey = new Map(
        masteryRows.map((row) => [row.skillKey, row]),
      );
      const foreignStateByKey = new Map<string, SkillState>();
      for (const nodeKey of foreignPrerequisiteKeys) {
        const rows = await ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", scholarId).eq("skillKey", nodeKey),
          )
          .collect();
        const row = rows[0];
        if (row) foreignStateByKey.set(nodeKey, masteryState(row));
      }
      const stateOf = (nodeKey: string) => {
        const ownRow = masteryByKey.get(nodeKey);
        return ownRow
          ? masteryState(ownRow)
          : (foreignStateByKey.get(nodeKey) ?? ZERO);
      };
      const frontier = new Set(computeFrontier(nodeKeys, edges, stateOf));

      for (const node of orderedNodes) {
        const row = masteryByKey.get(node.nodeKey);
        const state = masteryState(row);
        const treeNode: TreeNode = {
          skillKey: node.nodeKey,
          label: node.label,
          domain: node.domain,
          strand: node.strand ?? null,
          grade: node.grade ?? null,
          repetition: state.repetition,
          proficiency: proficiencyFromReps(state.repetition),
          retention: "none",
          frontier: frontier.has(node.nodeKey),
          demonstrated: isDemonstratedSource(row?.source),
          missStreak: row?.missStreak ?? 0,
        };
        const band = masteryOf(treeNode);
        bandCounts.get(node.nodeKey)![band] += 1;
        repSum.get(node.nodeKey)!.push(state.repetition);
        if (treeNode.frontier)
          frontierCount.set(
            node.nodeKey,
            (frontierCount.get(node.nodeKey) ?? 0) + 1,
          );
      }
    }

    const medianBandOf = (counts: Record<MasteryState, number>): MasteryState => {
      const total = BAND_ORDER.reduce((sum, b) => sum + counts[b], 0);
      if (total === 0) return "locked";
      const midpoint = Math.floor((total - 1) / 2); // lower median
      let seen = 0;
      for (const band of BAND_ORDER) {
        seen += counts[band];
        if (seen > midpoint) return band;
      }
      return "locked";
    };
    const medianRepOf = (reps: number[]): number => {
      if (reps.length === 0) return 0;
      const sorted = [...reps].sort((a, b) => a - b);
      return sorted[Math.floor((sorted.length - 1) / 2)]!;
    };

    // Aggregate node array, in `buildTreeVMs`'s TreeNode shape (+ cohort facets).
    // `frontier` = the cohort working edge (≥1 scholar on their frontier here) so
    // the reused frontier-line/label math draws the class's leading edge.
    const nodes = orderedNodes.map((node) => {
      const counts = bandCounts.get(node.nodeKey)!;
      const band = medianBandOf(counts);
      const medianRep = medianRepOf(repSum.get(node.nodeKey)!);
      const fCount = frontierCount.get(node.nodeKey) ?? 0;
      return {
        skillKey: node.nodeKey,
        label: node.label,
        domain: node.domain,
        strand: node.strand ?? null,
        grade: node.grade ?? null,
        repetition: medianRep,
        proficiency: proficiencyFromReps(medianRep),
        retention: "none" as const,
        frontier: fCount > 0,
        demonstrated: band !== "placed",
        // ── cohort facets (ignored by buildTreeVMs, read by the renderer) ──
        band,
        bands: counts,
        frontierCount: fCount,
      };
    });

    return {
      domain,
      domainLabel: practiceDomainLabel(domain),
      scholarCount,
      nodes,
      edges,
    };
  },
});

/**
 * The scholar roster behind the studio's collapsible DOMAIN RAIL.
 *
 * Cheap sibling of `masteryForScholars` (no mastery / observations / errors).
 * Per-domain focus curation has been retired: every domain is implicitly
 * active for every scholar (no primary, no locked domain), so this no longer
 * reads or returns any focus state — just the roster the rail renders.
 *
 * Auth mirrors `masteryForScholars`: teacherQuery + institution-scoped filter.
 */
export const domainRollup = teacherQuery({
  args: {
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const requestedScholarIds = [...new Set(args.scholarIds)];
    if (requestedScholarIds.length > MAX_MASTERY_SCHOLARS) {
      throw new Error(`Select ${MAX_MASTERY_SCHOLARS} scholars or fewer.`);
    }
    const scholarIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requestedScholarIds,
    );

    const scholars = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || scholar.role !== "scholar") continue;
      scholars.push({
        scholarId,
        name: scholar.name ?? scholar.username ?? "Scholar",
        image: scholar.image ?? null,
      });
    }

    return { scholars };
  },
});

/**
 * Per-domain grade levels for the Mastery matrix's "All domains" view: each
 * seeded domain's level per scholar, plus that domain's retention summary, and
 * the scholar's `overallLevel`. The client shows each domain's `gradeValue` in
 * its cell and `overallLevel` as the column's one sortable number: `mathLevel`
 * over the whole catalog, the same overall level the scholar profile shows
 * (mathPortrait.ts), never a mean of the domain cells.
 *
 * `gradeValue` is `mathLevel` (lib/practice/frontierGrade.ts) over that
 * domain's rows and catalog, the same function over the same rows the Math
 * Skills portrait, the parent Math Skills tab and the parent aide read
 * (mathPortrait.ts), so the matrix and the portrait show one grade per scholar
 * per domain (#2462). The per-area levels are built the same way as the
 * overall one, so the rows explain the "Across all math" row. Placement
 * check-in credit counts toward them. `highestGradeValue` is the legacy
 * figure (`frontierGradeValue`): the highest grade shown in daily practice,
 * which placement credit never raises.
 *
 * Auth mirrors masteryForScholars / domainRollup: teacherQuery +
 * institution-scoped filter.
 */
export const crossDomainMasteryForScholars = teacherQuery({
  args: {
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const requestedScholarIds = [...new Set(args.scholarIds)];
    if (requestedScholarIds.length > MAX_MASTERY_SCHOLARS) {
      throw new Error(`Select ${MAX_MASTERY_SCHOLARS} scholars or fewer.`);
    }
    const scholarIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requestedScholarIds,
    );

    // Each seeded domain's catalog grades (nodeKey → grade), the lookup
    // `mathLevel` reads, loaded once per domain via `by_domain`
    // exactly as `gatherMathPortrait` does. A domain with no graded node has
    // no rung on the K–8 axis and is left out of the matrix.
    const gradeByKeyByDomain = new Map<
      string,
      Map<string, string | null | undefined>
    >();
    // Graded nodeKey → domain, for bucketing the retention summary.
    const domainByGradedNodeKey = new Map<string, string>();
    // The whole catalog's grades across every registered domain: the
    // denominator of the overall `mathLevel`, built the same way as
    // `gatherMathPortrait`'s `catalogGrades` so the matrix and the profile show
    // one overall level. Domains with no graded node add nothing to it.
    const catalogGrades = new Map<string, string | null | undefined>();
    for (const { domain } of PRACTICE_DOMAINS) {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect();
      for (const node of nodes) catalogGrades.set(node.nodeKey, node.grade);
      if (!nodes.some((node) => node.grade)) continue;
      gradeByKeyByDomain.set(
        domain,
        new Map(nodes.map((node) => [node.nodeKey, node.grade])),
      );
      for (const node of nodes) {
        if (node.grade) domainByGradedNodeKey.set(node.nodeKey, domain);
      }
    }

    const now = Date.now();
    const scholars = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || scholar.role !== "scholar") continue;

      const masteryRows = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect();
      // Rows by their OWN domain stamp, the grouping the portrait uses, so
      // `mathLevel` sees exactly the rows the portrait does.
      const gradeRowsByDomain = new Map<string, typeof masteryRows>();
      // Rows on a graded node, by that node's domain, for retention.
      const retentionRowsByDomain = new Map<string, DomainRetentionInput[]>();
      for (const row of masteryRows) {
        const own = gradeRowsByDomain.get(row.domain) ?? [];
        own.push(row);
        gradeRowsByDomain.set(row.domain, own);
        const gradedDomain = domainByGradedNodeKey.get(row.skillKey);
        if (!gradedDomain) continue;
        const retentionRows = retentionRowsByDomain.get(gradedDomain) ?? [];
        retentionRows.push(row);
        retentionRowsByDomain.set(gradedDomain, retentionRows);
      }

      const domains = [];
      for (const { domain } of PRACTICE_DOMAINS) {
        const gradeByKey = gradeByKeyByDomain.get(domain);
        if (!gradeByKey) continue;
        const domainRows = gradeRowsByDomain.get(domain) ?? [];
        domains.push({
          domain,
          gradeValue: mathLevel(domainRows, gradeByKey)?.value ?? null,
          highestGradeValue: frontierGradeValue(domainRows, gradeByKey),
          // Tier 1's freshness read (spec §9/§10.2) — the all-domains matrix's
          // per-domain cell hover, never the cell itself.
          retention: summarizeDomainRetention(
            retentionRowsByDomain.get(domain) ?? [],
            now,
          ),
        });
      }

      scholars.push({
        scholarId,
        domains,
        // The canonical overall math level (lib/practice/frontierGrade.ts),
        // the number the profile's Math skills tab shows.
        overallLevel: mathLevel(masteryRows, catalogGrades)?.value ?? null,
      });
    }

    return { scholars };
  },
});

// ── Map-status matrix (§6/§8, math-skills-matrix-visual-language plan) ──────

/** One seeded domain's structural inputs for the WHOLE cohort — loaded ONCE
 *  (not per scholar) and reused for every scholar's classification below. */
type CohortMapDomain = {
  domain: string;
  nodes: Doc<"knowledgeNodes">[];
  /** Cross-domain `buildsOn` prerequisite domains, mirroring
   *  practiceSkills.loadMixedPlacementDomains (that helper is unexported and
   *  file-private, and this lane may not edit practiceSkills.ts — so this
   *  reads the same two tables directly rather than inventing a second
   *  prereq derivation). */
  prereqDomains: string[];
};

/**
 * Load every registered domain that has seeded nodes on this deployment, each
 * with its nodes (for the grade-eligibility ring) and its cross-domain
 * `buildsOn` prerequisite domains. ONE pass over `knowledgeNodes`/
 * `knowledgeNodeEdges` per domain for the entire requested cohort — never
 * repeated per scholar, since the graph itself doesn't vary by scholar.
 *
 * Parity note: this is the SAME derivation practiceSkills.ts's
 * `loadMixedPlacementDomains` performs for the scholar-facing Math Check-In
 * (a foreign `buildsOn` FROM-side node marks a cross-domain prerequisite into
 * an EARLIER domain). Keep the two in lock-step if either changes.
 */
async function loadCohortMapDomains(ctx: QueryCtx): Promise<CohortMapDomain[]> {
  const loaded: { domain: string; nodes: Doc<"knowledgeNodes">[] }[] = [];
  for (const info of PRACTICE_DOMAINS) {
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", info.domain))
      .collect();
    if (nodes.length === 0) continue; // not seeded on this deployment
    loaded.push({ domain: info.domain, nodes });
  }

  // Global nodeKey → domain map (nodeKeys are globally unique — graphValidation).
  const domainOfKey = new Map<string, string>();
  for (const d of loaded) for (const n of d.nodes) domainOfKey.set(n.nodeKey, d.domain);

  const withPrereqs: CohortMapDomain[] = [];
  for (const d of loaded) {
    const edgeRows = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_domain", (q) => q.eq("domain", d.domain))
      .collect();
    const prereqDomains = new Set<string>();
    for (const e of edgeRows) {
      if (e.kind !== "buildsOn") continue;
      const fromDomain = domainOfKey.get(e.fromKey);
      if (fromDomain && fromDomain !== d.domain) prereqDomains.add(fromDomain);
    }
    withPrereqs.push({ domain: d.domain, nodes: d.nodes, prereqDomains: [...prereqDomains] });
  }
  return withPrereqs;
}

/**
 * The teacher-facing cohort read behind the Skills matrix's empty-cell states
 * (§6/§8 of `review/math-skills-matrix-visual-language.html`): for each
 * requested scholar, classify every seeded domain's map status —
 * converged / in_flight / shadow_placed / queued / available / ineligible —
 * plus the N-of-M counts, using the SAME pure classification
 * (`summarizeDomainMap`, lib/practice/domainMapStatus.ts) the scholar-facing
 * Math Check-In serves from.
 *
 * A `queued` domain additionally names its unconverged prereq domain(s)
 * (`blockedBy`), so the matrix can render WHY a cell is greyed rather than
 * just THAT it is.
 *
 * Costs mirror `crossDomainMasteryForScholars`: the domain graph (nodes +
 * edges) is loaded once for the whole cohort, and each scholar's mastery is
 * loaded with one `by_scholar` index scan (domain is a stored field on
 * `practiceMastery`, so no nodeKey→domain join is needed here — unlike that
 * query, which needs the join for GRADE classification, this only needs
 * per-domain existence). Placement rows load with one `by_scholar_domain`
 * index scan per scholar (equality on `scholarId` only, so it covers every
 * domain for that scholar in one query, not one query per domain).
 *
 * Auth mirrors `crossDomainMasteryForScholars` / `domainRollup` exactly:
 * `teacherQuery` (admin / teacher role) + `filterToAccessibleScholars` for
 * institution-scoping, same `MAX_MASTERY_SCHOLARS` cap. Read-only.
 */
export const mapStatusForScholars = teacherQuery({
  args: {
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const requestedScholarIds = [...new Set(args.scholarIds)];
    if (requestedScholarIds.length > MAX_MASTERY_SCHOLARS) {
      throw new Error(`Select ${MAX_MASTERY_SCHOLARS} scholars or fewer.`);
    }
    const scholarIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requestedScholarIds,
    );

    const domains = await loadCohortMapDomains(ctx);

    const scholars = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || scholar.role !== "scholar") continue;

      const eligibilityGrade = automaticPlacementGrade(scholar.gradeLevel);

      // One `by_scholar` scan for mastery — domain is a stored field, so
      // existence-per-domain is a plain group, no node join required (matching
      // how crossDomainMasteryForScholars loads mastery for this cohort).
      const masteryRows = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect();
      const masteryDomains = new Set(masteryRows.map((r) => r.domain));

      // One `by_scholar_domain` scan (scholarId-only prefix) covers every
      // domain's placement row for this scholar in a single index read.
      const placementRows = await ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
        .collect();
      const placementByDomain = new Map(placementRows.map((r) => [r.domain, r]));

      const inputs: DomainMapInput[] = domains.map((d) => {
        const placement = placementByDomain.get(d.domain);
        return {
          domain: d.domain,
          prereqDomains: d.prereqDomains,
          // Mirror the canonical scholar-path fold (practiceSkills
          // summarizeScholarMap): an ELECTIVE domain is never grade-eligible,
          // or the teacher matrix would show every scholar owing it as
          // "needs mapping" (Sol review 2026-08-19, finding 1).
          gradeEligible:
            !ELECTIVE_PRACTICE_DOMAINS.has(d.domain) &&
            domainHasAffectSafeEntry(d.nodes, eligibilityGrade),
          placementStatus: placement?.status ?? null,
          answeredProbes: placement?.probeLog?.length ?? 0,
          hasMastery: masteryDomains.has(d.domain),
        };
      });

      const summary = summarizeDomainMap(inputs, {
        gradeOnFile: scholar.gradeLevel !== undefined,
      });

      scholars.push({
        scholarId,
        mappedCount: summary.mappedCount,
        eligibleCount: summary.eligibleCount,
        perDomain: summary.perDomain.map((entry) => ({
          domain: entry.domain,
          status: entry.status as DomainMapStatus,
          blockedBy: entry.blockedBy,
        })),
      });
    }

    return { scholars };
  },
});

// ── Fast math readiness + calculator license (teacher read) ─────────────────

/**
 * Each requested scholar's FAST MATH reading: what fraction of the canonical
 * Quick-facts space is automatic for them, and whether an adult has already
 * granted them the Calculator License.
 *
 * This is a roll-up of the SAME per-fact verdicts `factHeatmapForScholar`
 * paints (`classifyFactState`, self-relative to the scholar's own baseline) —
 * no second automaticity vocabulary, no second threshold. What it adds is the
 * canonical DENOMINATOR (`convex/lib/practice/fastMath.ts`): the whole
 * generator space, so unseen facts count against the percent and 100% means
 * every fact, not every fact they happened to touch.
 *
 * Three consumers, one derivation: the teacher matrix's Fast math row, its
 * dedicated operation/fact-family view (`MathSkillsMasteryView`, N scholars),
 * and the per-scholar diagnostic beside the license action in the scholar ×
 * domain report (`CalculatorLicenseCard`, one scholar).
 *
 * Costs mirror `mapStatusForScholars`: per scholar, one `factFluency`
 * `by_scholar` scan, one `practiceMastery` `by_scholar` scan (the latency
 * baseline), and one `calculatorLicenses` `by_scholar` point read. Same
 * `MAX_MASTERY_SCHOLARS` cap.
 *
 * Auth mirrors `crossDomainMasteryForScholars`: `teacherQuery` +
 * `filterToAccessibleScholars` for the institution boundary. Read-only.
 */
export const fastMathForScholars = teacherQuery({
  args: {
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const requestedScholarIds = [...new Set(args.scholarIds)];
    if (requestedScholarIds.length > MAX_MASTERY_SCHOLARS) {
      throw new Error(`Select ${MAX_MASTERY_SCHOLARS} scholars or fewer.`);
    }
    const scholarIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requestedScholarIds,
    );

    const scholars = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || scholar.role !== "scholar") continue;

      const progress = await loadFastMathProgress(ctx, scholarId);
      const licenseRow = await ctx.db
        .query("calculatorLicenses")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .first();
      const issuer = licenseRow ? await ctx.db.get(licenseRow.issuedBy) : null;

      scholars.push({
        scholarId,
        automaticCount: progress.automaticCount,
        denominator: progress.denominator,
        percent: progress.percent,
        ready: progress.ready,
        baselineKnown: progress.baselineKnown,
        byOperation: progress.byOperation,
        byFamily: progress.byFamily,
        license: licenseRow
          ? {
              issuedAt: licenseRow.issuedAt,
              issuedByName: issuer?.name ?? null,
              expiresOn: licenseRow.expiresOn ?? null,
            }
          : null,
      });
    }

    return { scholars };
  },
});

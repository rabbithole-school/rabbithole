/**
 * The Math Skills PORTRAIT — a compact, per-scholar roll-up of the practice
 * engine's own output: for each math domain the scholar has touched, the
 * demonstrated-fluent grade level ("how far you've come") and its real
 * month-over-month trajectory ("and you're still moving"). A portrait, never a
 * report card — growth-framed, no learner↔learner comparison, and never a
 * fabricated trend (the series is reconstructed from the forward-only
 * `becameFluentAt` stamp; see lib/practice/frontierGrade.ts).
 *
 * ONE gatherer, two mounts: the teacher subtab reads it through `forScholar`
 * (teacher/admin + institution-scoped), and the parent portal reads the SAME
 * shape through `parents.childMathPortrait` (guardian-gated). The grade-per-
 * domain signal is defined in exactly one place (frontierGrade.ts) and rendered
 * one way (`MathSkillsPortrait`) on both.
 */

import { v } from "convex/values";
import { DatabaseReader } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { PRACTICE_DOMAIN_LABELS } from "../shared/practiceDomainLabels";
import {
  frontierGradeValue,
  fluentCount,
  gradeLabelFromValueOrNull,
  monthBoundaries,
  type MasteryRowForGrade,
} from "./lib/practice/frontierGrade";

/** How many monthly trajectory points to reconstruct (inclusive of "now"). */
const TRAJECTORY_MONTHS = 6;

/** Minimum rise (in grade-equivalent units, a tenth of a grade) to call it
 *  growth — so a change that survives one-decimal rounding is what's shown, and
 *  a flat/near-flat window falls back to "Building history". */
const GROWTH_MIN = 0.1;

export interface DomainTrajectoryPoint {
  atMs: number;
  value: number | null;
}

export interface DomainPortrait {
  domain: string; // registered slug
  label: string; // human label
  gradeValue: number | null;
  gradeLabel: string | null; // "Grade 5.2" — null until a demonstrated-fluent skill
  fluentSkills: number;
  series: DomainTrajectoryPoint[]; // oldest → newest, last === now
  /** Real growth over the covered window: earliest known → latest, only when it
   *  actually rose. null when flat or not enough history ("Building history"). */
  growth: { fromValue: number; fromLabel: string; toValue: number; toLabel: string } | null;
}

export interface MathPortrait {
  domains: DomainPortrait[];
  monthsCovered: number;
  asOfMs: number;
}

/**
 * Assemble the Math Skills portrait for a scholar. Pure over a DatabaseReader so
 * the teacherQuery and the guardian-gated parent read share it. Includes only
 * domains the scholar has touched (≥1 mastery row), in curriculum order — never
 * a wall of "not started" domains that would read as a deficit list.
 */
export async function gatherMathPortrait(
  db: DatabaseReader,
  scholarId: Id<"users">,
): Promise<MathPortrait> {
  const now = Date.now();
  const boundaries = monthBoundaries(now, TRAJECTORY_MONTHS);

  const rows = await db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();

  const rowsByDomain = new Map<string, MasteryRowForGrade[]>();
  for (const row of rows) {
    const bucket = rowsByDomain.get(row.domain);
    const lite: MasteryRowForGrade = {
      skillKey: row.skillKey,
      repetition: row.repetition,
      source: row.source,
      becameFluentAt: row.becameFluentAt,
    };
    if (bucket) bucket.push(lite);
    else rowsByDomain.set(row.domain, [lite]);
  }

  const domains: DomainPortrait[] = [];
  // Curriculum order = insertion order of the registered-label map.
  for (const slug of Object.keys(PRACTICE_DOMAIN_LABELS)) {
    const domainRows = rowsByDomain.get(slug);
    if (!domainRows || domainRows.length === 0) continue;

    const nodes = await db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", slug))
      .collect();
    const gradeByKey = new Map<string, string | null | undefined>(
      nodes.map((n) => [n.nodeKey, n.grade]),
    );

    const series: DomainTrajectoryPoint[] = boundaries.map((atMs) => ({
      atMs,
      value: frontierGradeValue(domainRows, gradeByKey, atMs),
    }));
    const nowValue = frontierGradeValue(domainRows, gradeByKey);

    // Growth = earliest KNOWN point → latest, reported only when it truly rose
    // by at least a tenth of a grade. A flat series (all history collapsed to the
    // baseline because those skills predate the `becameFluentAt` stamp) yields
    // null → the surface says "Building history", never an invented slope.
    let growth: DomainPortrait["growth"] = null;
    const firstKnown = series.find((p) => p.value !== null);
    if (
      firstKnown &&
      firstKnown.value !== null &&
      nowValue !== null &&
      nowValue - firstKnown.value >= GROWTH_MIN
    ) {
      growth = {
        fromValue: firstKnown.value,
        fromLabel: gradeLabelFromValueOrNull(firstKnown.value)!,
        toValue: nowValue,
        toLabel: gradeLabelFromValueOrNull(nowValue)!,
      };
    }

    domains.push({
      domain: slug,
      label: PRACTICE_DOMAIN_LABELS[slug],
      gradeValue: nowValue,
      gradeLabel: gradeLabelFromValueOrNull(nowValue),
      fluentSkills: fluentCount(domainRows),
      series,
      growth,
    });
  }

  return { domains, monthsCovered: TRAJECTORY_MONTHS, asOfMs: now };
}

/**
 * Teacher/admin read of a scholar's Math Skills portrait — institution-scoped
 * exactly like the rest of the practice cohort reads (cohortPractice.ts).
 */
export const forScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return await gatherMathPortrait(ctx.db, args.scholarId);
  },
});

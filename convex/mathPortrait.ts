/**
 * The Math Skills PORTRAIT — a compact, per-scholar roll-up of the practice
 * engine's own output: for each math domain the scholar has touched, the
 * grade level (`mathLevel`: how much of each grade's skills in that area the
 * scholar has covered, placement credit included), the legacy "highest" grade
 * reached in daily practice beside it, and the level's real month-over-month
 * trajectory ("and you're still moving"). A portrait, never a
 * report card — growth-framed, no learner↔learner comparison, and never a
 * fabricated trend (the series is reconstructed from the forward-only
 * `becameFluentAt` stamp; see lib/practice/frontierGrade.ts).
 *
 * ONE gatherer, three readers: the teacher subtab reads it through `forScholar`
 * (teacher/admin + institution-scoped), the parent portal reads the SAME
 * shape, plus each area's new learning this term and three most recent skills,
 * through `parents.childMathPortrait` (guardian-gated), and the parent
 * aide's `get_scholar_practice` reads it through `getScholarMathPortrait` so it
 * tells a parent what the portal shows (TRA-619). The grade-per-domain signals
 * are defined in exactly one place (frontierGrade.ts); `MathSkillsPortrait`
 * renders the teacher screen and `ParentMathPortrait` the parent's, from the
 * same fields.
 */

import { v } from "convex/values";
import { DatabaseReader, internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { PRACTICE_DOMAIN_LABELS } from "../shared/practiceDomainLabels";
import {
  frontierGradeValue,
  fluentCount,
  fluentSkillLabelsNewestFirst,
  gradeLabelFromValueOrNull,
  isLearnedSkill,
  monthBoundaries,
  learnedPace,
  MISSES_TO_LEARN_BELOW_START,
  mathLevel,
  paceWindowStart,
  skillsFluentInWindow,
  type MasteryRowForGrade,
  type LearnedPace,
  type MathLevel,
} from "./lib/practice/frontierGrade";
import { gradeRank } from "../shared/gradeRange";
import { dayKeyForTimezone } from "../shared/institutionDay";
import { timeZoneForInstitution } from "./lib/institutionTime";

/** How many monthly trajectory points to reconstruct (inclusive of "now"). */
const TRAJECTORY_MONTHS = 6;

/** Minimum rise (in grade-equivalent units, a tenth of a grade) to call it
 *  growth — so a change that survives one-decimal rounding is what's shown, and
 *  a flat/near-flat window falls back to "Building history". */
const GROWTH_MIN = 0.1;

/** How many recently demonstrated skills the parent Math page names per area. */
export const RECENT_SKILLS_SHOWN = 3;

export interface DomainTrajectoryPoint {
  atMs: number;
  value: number | null;
}

export interface DomainPortrait {
  domain: string; // registered slug
  label: string; // human label
  /** The area's level (`mathLevel` over this area's rows and catalog): how much
   *  of each grade's skills in the area the scholar is credited with, placement
   *  check-in credit included. Null until any skill is credited. */
  gradeValue: number | null;
  gradeLabel: string | null; // "Grade 5.2"
  /** LEGACY "highest": the highest grade with a skill shown in daily practice
   *  (`frontierGradeValue`). Null until a demonstrated-fluent skill. */
  highestGradeValue: number | null;
  highestGradeLabel: string | null;
  /** Skills shown fluent in daily practice: the daily-work part of the level. */
  fluentSkills: number;
  /** Skills credited by the placement check-in and not yet shown in daily
   *  practice: the placement part of the level. */
  placementSkills: number;
  /** The labels of the skills `fluentSkills` counts (same rows, same gate), so
   *  the parent aide can say what is behind the portal's "N skills fluent"
   *  when a parent asks (TRA-322). A counted skill with no usable catalog
   *  label is left out, so this can be shorter than `fluentSkills`, never
   *  longer. Only present when the caller asks for it
   *  (`withFluentSkillLabels`): the parent aide's internal read. The client
   *  queries never send it, so neither portal screen's payload changes. */
  fluentSkillLabels?: string[];
  /** The newest {@link RECENT_SKILLS_SHOWN} of those labels, newest fluent
   *  first: the parent Math page's "Recently demonstrated" list. Computed here
   *  so the page never receives the full list. Only present when the caller
   *  asks (`withRecentSkills`): the parent portal read. */
  recentFluentSkillLabels?: string[];
  /** Months of curriculum the scholar LEARNED in this area this term: the
   *  area's `learnedPace(...).learnedMonths` over the current reporting period,
   *  from the same learned set as `overall.pace` (skills already known and
   *  first shown this term add nothing). Weighed against the area's own
   *  catalog, so areas need not sum to the overall figure. Present only with
   *  `withOverall` AND a current reporting period: the parent page's "New this
   *  term" column. */
  termLearnedMonths?: number;
  series: DomainTrajectoryPoint[]; // the level, oldest → newest, last === now
  /** Real growth over the covered window: earliest known → latest, only when it
   *  actually rose. null when flat or not enough history ("Building history"). */
  growth: { fromValue: number; fromLabel: string; toValue: number; toLabel: string } | null;
}

export interface MathPortrait {
  domains: DomainPortrait[];
  monthsCovered: number;
  asOfMs: number;
  /** One level across every domain, with the enrolled grade to read it
   *  against. Only present when the caller asks (`withOverall`): the teacher
   *  read and the parent portal read (`parents.childMathPortrait`, for the
   *  page's two stat tiles). The parent aide never sends it. */
  overall?: {
    level: MathLevel | null;
    enrolledGradeRank: number | null;
    /** New learning this term against the standard pace, or null when the
     *  scholar's school has no current reporting period. */
    pace: (LearnedPace & {
      periodLabel: string;
      /** The reporting period's own start. */
      periodStartsAt: number;
      /** Where the pace window (and every area's `termLearnedMonths`) starts:
       *  `paceWindowStart`, so later than `periodStartsAt` for a scholar who
       *  joined after the term began. */
      windowStartsAt: number;
      /** `windowStartsAt` as YYYY-MM-DD in the school's time zone, so every
       *  surface that prints the date (parent page, teacher card, staff
       *  tools) prints the same day. */
      windowStartsDay: string;
    }) | null;
  };
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
  // `rows`: the scholar's practice rows when the caller has already read them
  // (the parent-report gatherer), so they aren't read twice.
  opts: {
    withFluentSkillLabels?: boolean;
    withOverall?: boolean;
    withRecentSkills?: boolean;
    rows?: Doc<"practiceMastery">[];
  } = {},
): Promise<MathPortrait> {
  const now = Date.now();
  const boundaries = monthBoundaries(now, TRAJECTORY_MONTHS);

  const rows =
    opts.rows ??
    (await db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect());

  const rowsByDomain = new Map<string, MasteryRowForGrade[]>();
  for (const row of rows) {
    const bucket = rowsByDomain.get(row.domain);
    const lite: MasteryRowForGrade = {
      skillKey: row.skillKey,
      repetition: row.repetition,
      source: row.source,
      becameFluentAt: row.becameFluentAt,
      frontierAdvancedAt: row.frontierAdvancedAt,
    };
    if (bucket) bucket.push(lite);
    else rowsByDomain.set(row.domain, [lite]);
  }

  // The scholar and their current term, read once for the overall level, the
  // pace and each area's new learning.
  const scholar = opts.withOverall ? await db.get(scholarId) : null;
  const period = opts.withOverall ? await currentReportingPeriod(db, scholar?.institutionId, now) : null;

  const domains: DomainPortrait[] = [];
  // The whole catalog, for the overall level: its denominator is every
  // registered domain, touched or not. Without it, only touched domains are read.
  const catalog = opts.withOverall ? await loadMathCatalog(db) : null;
  // The term's window and the skills learned in it, classified ONCE and shared
  // by the overall pace and every area's new learning.
  const term =
    period && catalog
      ? await (async () => {
          // A scholar who joined after the term began is measured from the
          // day their account was created: counting school months they were
          // not here for would understate their pace.
          const startMs = paceWindowStart(period.startsAt, scholar?._creationTime);
          const endMs = Math.min(now, period.endsAt);
          const learned = await learnedSkillKeys(db, scholarId, rows, catalog.grades, startMs, endMs);
          return { period, startMs, endMs, learned };
        })()
      : null;
  // Curriculum order = insertion order of the registered-label map.
  for (const slug of Object.keys(PRACTICE_DOMAIN_LABELS)) {
    const domainRows = rowsByDomain.get(slug);
    if (!domainRows || domainRows.length === 0) continue;

    const nodes =
      catalog?.nodesByDomain.get(slug) ??
      (await db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", slug))
        .collect());
    const gradeByKey = new Map<string, string | null | undefined>(
      nodes.map((n) => [n.nodeKey, n.grade]),
    );
    const labelByKey = new Map<string, string | undefined>(nodes.map((n) => [n.nodeKey, n.label]));

    const series: DomainTrajectoryPoint[] = boundaries.map((atMs) => ({
      atMs,
      value: mathLevel(domainRows, gradeByKey, { asOf: atMs })?.value ?? null,
    }));
    const level = mathLevel(domainRows, gradeByKey);
    const nowValue = level?.value ?? null;
    const highestValue = frontierGradeValue(domainRows, gradeByKey);

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
      highestGradeValue: highestValue,
      highestGradeLabel: gradeLabelFromValueOrNull(highestValue),
      fluentSkills: fluentCount(domainRows),
      placementSkills: level?.placementSkills ?? 0,
      // The same gate `fluentCount` applies (fluentSkillLabelsNewestFirst,
      // context-free isFluent, no asOf). A counted skill whose catalog node is missing or unlabelled is
      // left out rather than shown as its internal key, so the list is never
      // longer than the tile's number and is shorter only in that case.
      ...(opts.withFluentSkillLabels
        ? { fluentSkillLabels: fluentSkillLabelsNewestFirst(domainRows, labelByKey) }
        : {}),
      ...(opts.withRecentSkills
        ? { recentFluentSkillLabels: fluentSkillLabelsNewestFirst(domainRows, labelByKey, RECENT_SKILLS_SHOWN) }
        : {}),
      ...(term
        ? {
            termLearnedMonths: learnedPace(domainRows, gradeByKey, term.learned, term.startMs, term.endMs)
              .learnedMonths,
          }
        : {}),
      series,
      growth,
    });
  }

  if (!catalog) return { domains, monthsCovered: TRAJECTORY_MONTHS, asOfMs: now };
  const catalogGrades = catalog.grades;
  return {
    domains,
    monthsCovered: TRAJECTORY_MONTHS,
    asOfMs: now,
    overall: {
      level: mathLevel(rows, catalogGrades),
      enrolledGradeRank: gradeRank(scholar?.gradeLevel),
      pace: term
        ? {
            ...learnedPace(rows, catalogGrades, term.learned, term.startMs, term.endMs),
            periodLabel: term.period.label,
            periodStartsAt: term.period.startsAt,
            windowStartsAt: term.startMs,
            windowStartsDay: dayKeyForTimezone(
              term.startMs,
              await timeZoneForInstitution({ db }, scholar?.institutionId),
            ),
          }
        : null,
    },
  };
}

/**
 * Every registered math domain's catalog nodes, in curriculum order, and the
 * whole catalog's nodeKey → grade map: the overall level's denominator, touched
 * domains or not. One indexed read per domain.
 */
export async function loadMathCatalog(db: DatabaseReader) {
  const nodesByDomain = new Map<string, Doc<"knowledgeNodes">[]>();
  const grades = new Map<string, string | null | undefined>();
  for (const slug of Object.keys(PRACTICE_DOMAIN_LABELS)) {
    const nodes = await db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", slug))
      .collect();
    nodesByDomain.set(slug, nodes);
    for (const node of nodes) grades.set(node.nodeKey, node.grade);
  }
  return { nodesByDomain, grades };
}

/**
 * The skills that turned fluent in (startMs, endMs] that the scholar LEARNED
 * there, by `isLearnedSkill`: misses before fluent, weighed against the first
 * grade not yet solid in their overall level. One indexed read per
 * such skill, stopping at the second miss, so the read set is the attempts on
 * those skills only.
 */
export async function learnedSkillKeys(
  db: DatabaseReader,
  scholarId: Id<"users">,
  rows: Doc<"practiceMastery">[],
  catalogGrades: ReadonlyMap<string, string | null | undefined>,
  startMs: number,
  endMs: number,
): Promise<Set<string>> {
  const level = mathLevel(rows, catalogGrades);
  const firstOpenRank = level ? (level.solidThroughRank ?? -1) + 1 : null;
  const learned = new Set<string>();
  for (const row of skillsFluentInWindow(rows, catalogGrades, startMs, endMs)) {
    const misses = await db
      .query("practiceAttempts")
      .withIndex("by_scholar_node_createdAt", (q) =>
        q.eq("scholarId", scholarId).eq("nodeKey", row.skillKey).lte("createdAt", row.becameFluentAt!),
      )
      // Bound: the filter runs after the index, so this reads the skill's
      // attempts in time order up to its second miss or its fluency moment.
      // A miss never lowers reps and the third bare correct makes a skill
      // fluent, so few corrects precede that moment; the exception is
      // scaffolded corrects, which raise reps without making it fluent. Each
      // row read is a problem the scholar answered, and only skills that went
      // fluent in the window are read. No index carries `correct`; adding one
      // is a schema change, out of scope here.
      .filter((q) => q.eq(q.field("correct"), false))
      .take(MISSES_TO_LEARN_BELOW_START);
    const skillRank = gradeRank(catalogGrades.get(row.skillKey))!;
    if (isLearnedSkill({ misses: misses.length, skillRank, firstOpenRank })) learned.add(row.skillKey);
  }
  return learned;
}

/**
 * The scholar's current term: the reporting period their school has open that
 * has already started (the latest start wins), or null.
 */
async function currentReportingPeriod(
  db: DatabaseReader,
  institutionId: Id<"institutions"> | undefined,
  now: number,
) {
  return (
    (await db.query("reportingPeriods").collect())
      .filter(
        (p) =>
          (p.status === "writing" || p.status === "open") &&
          p.startsAt <= now &&
          (p.institutionId === undefined || p.institutionId === institutionId),
      )
      .sort((a, b) => b.startsAt - a.startsAt)[0] ?? null
  );
}

/**
 * Teacher/admin read of a scholar's Math Skills portrait — institution-scoped
 * exactly like the rest of the practice cohort reads (cohortPractice.ts).
 */
export const forScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return await gatherMathPortrait(ctx.db, args.scholarId, { withOverall: true });
  },
});

/**
 * The parent aide's read of the same portrait. `get_scholar_practice`
 * (lib/scholarReadTools.ts) calls it for a PARENT, so the aide describes a
 * child the way the portal's Math Skills tab does (TRA-619). No authorization
 * here: it is internal, and the tool's `resolveScholar` has already confined
 * the id to the parent's own children, the boundary every parent-aide read
 * relies on. `withFluentSkillLabels` adds the skill list behind the portal's
 * "N skills fluent" (TRA-322); only the guardian-scoped parent aide sets it
 * (lib/parentAideTurn.ts → makeScholarReadTools).
 */
export const getScholarMathPortrait = internalQuery({
  args: {
    scholarId: v.id("users"),
    withFluentSkillLabels: v.optional(v.boolean()),
    /** The overall level and learned pace: the staff aide's read
     *  (`get_scholar_practice` for teacher/admin). The parent aide never sets it. */
    withOverall: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await gatherMathPortrait(ctx.db, args.scholarId, {
      withFluentSkillLabels: args.withFluentSkillLabels === true,
      withOverall: args.withOverall === true,
    });
  },
});

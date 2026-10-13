import { v } from "convex/values";
import { DatabaseReader } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import {
  READ_LEVEL_LABELS,
  WRITE_MODE_LABELS,
  readLevelOf,
  talkLevelLabel,
  writeModeOf,
  type ReadLevel,
  type WriteMode,
} from "./lib/readingLevels";
import { PRACTICE_DOMAIN_LABELS } from "../shared/practiceDomainLabels";
import {
  frontierGradeValue,
  fluentCount,
  gradeLabelFromValueOrNull,
  type MasteryRowForGrade,
} from "./lib/practice/frontierGrade";

/**
 * The Rabbithole Working Level (review/assessment-and-goals-plan.html §10).
 *
 * A per-DOMAIN vector, not one invented blended number — asynchronous
 * development is the population's defining trait, so blending it away deletes
 * the signal. Two honest readouts today:
 *   • talk, read, write  — the governed teacher-set levels (talk may be
 *                          observer-suggested).
 *   • inquiry complexity — the rolling median of analyses.complexityLevel.
 *
 * A third — a **math working level** (a grade-band + posture derived from the
 * procedural-practice frontier) — is DEFERRED until the practice engine
 * (`practiceMastery` + `knowledgeNodes`, PR #400) lands on master. Re-add a
 * MATH_DOMAINS block here that reads the practice frontier once those tables
 * exist; the vector shape (a `byDomain` component) already accommodates it.
 *
 * Guardrail: this is a TEACHER/PARENT-literacy instrument. Grade-band labels
 * never reach a scholar surface; the number is annotated or suppressed, never
 * hand-edited (fix the source instead). Snapshotted into
 * courseNarratives.workingLevel at composer time so the report says what was
 * true then.
 */

export interface WorkingLevelComponent {
  domain: string;
  level: string;
  source: string;
}
export interface WorkingLevel {
  headline?: string;
  byDomain: WorkingLevelComponent[];
}

/**
 * The level components (TRA-514): the TALK level, named for what it is (never
 * "Reading"), plus READ and WRITE only when they differ from the default
 * (reader, on their own) — a default row encodes nothing a reader of the
 * report needs (T2). Pure, so the labels are testable without a database.
 */
export function levelComponents(
  scholar:
    | {
        readingLevel?: string | null;
        readLevel?: ReadLevel | null;
        writeMode?: WriteMode | null;
      }
    | null
    | undefined,
): WorkingLevelComponent[] {
  // "K", "Grade 3", "College"; a legacy "pre-reader" reads as K (TRA-503).
  const talkLabel = talkLevelLabel(scholar?.readingLevel);
  const read = readLevelOf(scholar);
  const write = writeModeOf(scholar);
  return [
    ...(talkLabel
      ? [
          {
            domain: "Talk",
            level: talkLabel,
            source: "talk level: ideas and vocabulary (teacher-set / observer-suggested)",
          },
        ]
      : []),
    ...(read !== "reader"
      ? [{ domain: "Read", level: READ_LEVEL_LABELS[read], source: "read level (teacher-set)" }]
      : []),
    ...(write !== "own"
      ? [{ domain: "Write", level: WRITE_MODE_LABELS[write], source: "write mode (teacher-set)" }]
      : []),
  ];
}

/** Median of a numeric array (0 for empty). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Assemble the Working Level for a scholar from the record. `window` optionally
 * bounds the inquiry-complexity sample to a reporting period. Pure over a
 * DatabaseReader so both the teacherQuery and the finalize snapshot share it.
 */
export async function gatherWorkingLevel(
  db: DatabaseReader,
  scholarId: Id<"users">,
  window?: { startsAt: number; endsAt: number },
): Promise<WorkingLevel> {
  const byDomain: WorkingLevelComponent[] = [];

  // ── Talk, read and write (governed: teacher-set; talk may be observer-
  //    suggested). The stored talk field is `readingLevel`, but it is the
  //    grade band of ideas and vocabulary, not a reading measure, so it is
  //    never labelled "Reading" (TRA-514). Read and write show beside it, so a
  //    talk-7 listener doesn't read as a grade-7 reader. ──
  const scholar = await db.get(scholarId);
  byDomain.push(...levelComponents(scholar));

  // ── Math working level — a per-DOMAIN grade band off the procedural-practice
  //    frontier (the deferral in PR #400's note is now unblocked: practiceMastery
  //    + knowledgeNodes are on master). One canonical definition, shared with the
  //    Math Skills portrait: the DEMONSTRATED-fluent frontier grade per domain
  //    (lib/practice/frontierGrade.ts), never the generous access gate. `window`
  //    scopes it to the reporting period's end so a snapshot says what was true
  //    then. Only touched domains with a demonstrated-fluent skill contribute. ──
  const asOf = window?.endsAt;
  const mathRows = await db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const mathRowsByDomain = new Map<string, MasteryRowForGrade[]>();
  for (const row of mathRows) {
    const lite: MasteryRowForGrade = {
      skillKey: row.skillKey,
      repetition: row.repetition,
      source: row.source,
      becameFluentAt: row.becameFluentAt,
    };
    const bucket = mathRowsByDomain.get(row.domain);
    if (bucket) bucket.push(lite);
    else mathRowsByDomain.set(row.domain, [lite]);
  }
  for (const slug of Object.keys(PRACTICE_DOMAIN_LABELS)) {
    const domainRows = mathRowsByDomain.get(slug);
    if (!domainRows || domainRows.length === 0) continue;
    const nodes = await db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", slug))
      .collect();
    const gradeByKey = new Map<string, string | null | undefined>(
      nodes.map((n) => [n.nodeKey, n.grade]),
    );
    const value = frontierGradeValue(domainRows, gradeByKey, asOf);
    const level = gradeLabelFromValueOrNull(value);
    if (level === null) continue;
    const n = fluentCount(domainRows, asOf);
    byDomain.push({
      domain: PRACTICE_DOMAIN_LABELS[slug],
      level,
      source: `practice frontier (${n} fluent ${n === 1 ? "skill" : "skills"})`,
    });
  }

  // ── Inquiry complexity (median of analyses.complexityLevel, → ~1–7) ──
  const sessions = await db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  const inWindow = window
    ? sessions.filter(
        (s) =>
          s._creationTime >= window.startsAt && s._creationTime <= window.endsAt,
      )
    : sessions;
  const complexities: number[] = [];
  for (const s of inWindow) {
    const rows = await db
      .query("analyses")
      .withIndex("by_session", (q) => q.eq("sessionId", s._id))
      .collect();
    for (const a of rows) {
      if (typeof a.complexityLevel === "number") complexities.push(a.complexityLevel);
    }
  }
  if (complexities.length >= 2) {
    // complexityLevel is 0–1; present on a 1–7 scale (the doc's "5.6" shape).
    const scaled = 1 + median(complexities) * 6;
    byDomain.push({
      domain: "Open inquiry",
      level: scaled.toFixed(1),
      source: `inquiry complexity (${complexities.length} sessions)`,
    });
  }

  const headline =
    byDomain.length > 0
      ? byDomain.map((c) => `${c.domain}: ${c.level}`).join(" · ")
      : undefined;
  return { headline, byDomain };
}

/** Composer-time Working Level for a scholar, optionally scoped to a period. */
export const forScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    periodId: v.optional(v.id("reportingPeriods")),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    let window: { startsAt: number; endsAt: number } | undefined;
    if (args.periodId) {
      const period = await ctx.db.get(args.periodId);
      if (period) window = { startsAt: period.startsAt, endsAt: period.endsAt };
    }
    return await gatherWorkingLevel(ctx.db, args.scholarId, window);
  },
});

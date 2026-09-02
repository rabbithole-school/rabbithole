// DEV-ONLY sample data for reviewing the scholar-first Reports IA.
//
// Populates the current reporting period with a few course narratives (varied
// subjects + statuses) and a couple of Whole Child reports, across a handful of
// scholars, so the roster shows a realistic mix (some scholars with several
// narratives + a Whole Child report, some empty). Idempotent — skips a
// (scholar, subject) narrative or a scholar's Whole Child report that already
// exists. NOT for prod.
//
//   npx convex run seed/sampleReports:seedSampleReports '{}'
//   npx convex run seed/sampleReports:seedSampleReports '{"dryRun":true}'

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const COURSE_SECTIONS = [
  { key: "context", title: "Context — what we studied" },
  { key: "progress", title: "Progress & accomplishments" },
  { key: "dim_core", title: "Core" },
  { key: "dim_connections", title: "Connections" },
  { key: "dim_practice", title: "Practice" },
  { key: "dim_identity", title: "Identity" },
  { key: "goals", title: "Goals for Continued Growth" },
];
const WC_SECTIONS = [
  { key: "execFunction", title: "Executive Function & Learning Habits" },
  { key: "socialEmotional", title: "Social-Emotional Growth" },
  { key: "collaboration", title: "Collaboration, Character & Community" },
  { key: "passions", title: "Passion Projects, Quests & Extended Learning" },
  { key: "goals", title: "Goals for Continued Growth" },
];

type CourseStatus = "draft" | "final" | "shared";
type WcStatus = "draft" | "teamReview" | "final" | "shared";

// Which subjects + statuses each of the first N roster scholars gets. Index 0
// is rich (several narratives + Whole Child); later ones taper to empty.
const PLAN: Array<{
  courses: Array<{ subject: string; status: CourseStatus; blurb?: string }>;
  wholeChild?: WcStatus;
  goals?: Array<{ title: string; description?: string; kind: "academic" | "personal" | "habit" | "hobby" }>;
}> = [
  {
    courses: [
      { subject: "Mathematics", status: "draft", blurb: "Moved from additive to multiplicative reasoning about area." },
      { subject: "Science", status: "final", blurb: "Designed and revised a controlled aquaponics investigation." },
    ],
    wholeChild: "draft",
    goals: [
      { title: "Ask my own research question each unit", description: "Start from something I'm genuinely curious about, not just the prompt.", kind: "academic" },
      { title: "Finish the solar-oven build", description: "See a long project through to a working prototype.", kind: "hobby" },
    ],
  },
  {
    courses: [{ subject: "Humanities", status: "shared", blurb: "Argued a thesis from primary sources on Hawaiian statehood." }],
    wholeChild: "teamReview",
    goals: [{ title: "Speak up in seminar", description: "Share a take before someone else says it first.", kind: "personal" }],
  },
  {
    courses: [{ subject: "Mathematics", status: "draft" }],
  },
  { courses: [] }, // an empty scholar — shows the add/start affordances
];

/** DEV-ONLY: wipe the reporting tables for a clean review slate. */
export const resetReportsForDev = internalMutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    for (const table of [
      "courseNarratives",
      "wholeChildNarratives",
      "reportingPeriods",
      "scholarGoals",
    ] as const) {
      const rows = await ctx.db.query(table).collect();
      for (const r of rows) {
        await ctx.db.delete(r._id);
        deleted++;
      }
    }
    const categoryObservations = await ctx.db.query("observations").collect();
    for (const row of categoryObservations) {
      if (row.category === undefined) continue;
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted };
  },
});

export const seedSampleReports = internalMutation({
  args: { dryRun: v.optional(v.boolean()), teacherUsername: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const teacherUsername = args.teacherUsername ?? "test-teacher-001";

    const periods = await ctx.db.query("reportingPeriods").collect();
    const period =
      periods.find((p) => p.status === "writing") ??
      periods.find((p) => p.status === "open") ??
      periods[0];
    if (!period) throw new Error("No reporting period — seed one first (seed/reportingPeriods).");

    const allUsers = await ctx.db.query("users").collect();
    const teacher =
      allUsers.find((u) => u.role === "teacher" && u.username === teacherUsername) ??
      allUsers.find((u) => u.role === "teacher");
    if (!teacher) throw new Error("No teacher user found.");

    // Pick the largest scholar cohort (= the primary-institution roster the
    // teacher sees). Robust without replicating listScholars' membership lens.
    const allScholars = allUsers.filter((u) => u.role === "scholar");
    const byInst = new Map<string, number>();
    for (const s of allScholars) {
      const k = String(s.institutionId ?? "none");
      byInst.set(k, (byInst.get(k) ?? 0) + 1);
    }
    const topInst = [...byInst.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const scholars = allScholars
      .filter((s) => String(s.institutionId ?? "none") === topInst)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

    const created: string[] = [];
    const skipped: string[] = [];

    for (let i = 0; i < PLAN.length && i < scholars.length; i++) {
      const scholar = scholars[i];
      const plan = PLAN[i];

      for (const c of plan.courses) {
        const existing = await ctx.db
          .query("courseNarratives")
          .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholar._id).eq("periodId", period._id))
          .collect();
        if (existing.some((n) => n.subject.toLowerCase() === c.subject.toLowerCase())) {
          skipped.push(`${scholar.name} · ${c.subject}`);
          continue;
        }
        created.push(`${scholar.name} · ${c.subject} (${c.status})`);
        if (!dryRun) {
          await ctx.db.insert("courseNarratives", {
            scholarId: scholar._id,
            teacherId: teacher._id,
            periodId: period._id,
            subject: c.subject,
            unitIds: [],
            sections: COURSE_SECTIONS.map((s) => ({
              ...s,
              body: c.blurb && (s.key === "progress" || s.key === "context") ? c.blurb : "",
            })),
            goalIds: [],
            status: c.status,
            ...(c.status === "shared" ? { sharedAt: Date.now() } : {}),
          });
        }
      }

      if (plan.wholeChild) {
        const existingWc = await ctx.db
          .query("wholeChildNarratives")
          .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholar._id).eq("periodId", period._id))
          .collect();
        if (existingWc[0]) {
          skipped.push(`${scholar.name} · Whole Child`);
        } else {
          created.push(`${scholar.name} · Whole Child (${plan.wholeChild})`);
          if (!dryRun) {
            await ctx.db.insert("wholeChildNarratives", {
              scholarId: scholar._id,
              periodId: period._id,
              advisorId: teacher._id,
              sections: WC_SECTIONS.map((s) => ({ ...s, body: "" })),
              goalIds: [] as Id<"scholarGoals">[],
              status: plan.wholeChild,
              ...(plan.wholeChild === "teamReview" || plan.wholeChild === "final" || plan.wholeChild === "shared"
                ? { teamAgreedAt: Date.now() }
                : {}),
            });
          }
        }
      }

      for (const g of plan.goals ?? []) {
        const existingGoals = await ctx.db
          .query("scholarGoals")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
          .collect();
        if (existingGoals.some((eg) => eg.title.toLowerCase() === g.title.toLowerCase())) {
          skipped.push(`${scholar.name} · goal "${g.title}"`);
          continue;
        }
        created.push(`${scholar.name} · goal "${g.title}"`);
        if (!dryRun) {
          await ctx.db.insert("scholarGoals", {
            scholarId: scholar._id,
            title: g.title,
            description: g.description,
            kind: g.kind,
            origin: "teacher",
            createdBy: teacher._id,
            status: "active",
            feedsTutor: true,
          });
        }
      }
    }

    return { dryRun, period: period.label, teacher: teacher.username ?? teacher.name, scholarsInScope: scholars.length, created, skipped };
  },
});

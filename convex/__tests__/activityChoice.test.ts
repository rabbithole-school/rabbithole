// Activity choice — the "a lesson can be a menu of alternatives" feature.
// Covers the three pieces of the backend contract:
//   1. computeChoicePlan (pure): pickCount math, satisfaction, D2 drop.
//   2. Choice-aware progress/gating through the real read helpers over a
//      live assignment (totals count pickCount, not every option).
//   3. Per-scholar `scholarIds` targeting (divide & conquer) — ordering,
//      the assignWork/setScholars plumbing, and the prune-on-shrink rule.
//   4. The scholar plate surfaces choice option rows with the grouping
//      fields, and stops surfacing them once the pick is satisfied.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import {
  computeChoicePlan,
  unitOnlineProgressForScholar,
  orderedOnlineActivitiesForUnit,
  isUnitCompleteForScholar,
} from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

// ── Pure plan helper ──────────────────────────────────────────────────
// Build a synthetic ordered list (only the fields the plan reads) so we
// can exercise the math without a database.
function orderedFixture(
  lesson: { _id: string; selectionMode?: "sequence" | "choice"; choicePickCount?: number },
  activityIds: string[],
) {
  return activityIds.map((id, i) => ({
    activity: { _id: id } as unknown as Doc<"activities">,
    lesson: {
      _id: lesson._id,
      selectionMode: lesson.selectionMode,
      choicePickCount: lesson.choicePickCount,
    } as unknown as Doc<"lessons">,
    position: i,
  }));
}

describe("computeChoicePlan", () => {
  test("choice lesson: pickCount 1 of 3 — total is 1, whole menu available", () => {
    const ordered = orderedFixture(
      { _id: "L", selectionMode: "choice", choicePickCount: 1 },
      ["a1", "a2", "a3"],
    );
    const plan = computeChoicePlan(ordered, new Set());
    expect(plan.requiredTotal).toBe(1);
    expect(plan.completedRequired).toBe(0);
    expect(plan.availableActivityIds).toEqual(new Set(["a1", "a2", "a3"]));
    expect(String(plan.nextItem?.activity._id)).toBe("a1");
    expect(plan.choiceByLesson.get("L")).toEqual({
      pickCount: 1,
      optionCount: 3,
      completedCount: 0,
      satisfied: false,
    });
  });

  test("choice lesson satisfied — remaining options drop (D2)", () => {
    const ordered = orderedFixture(
      { _id: "L", selectionMode: "choice", choicePickCount: 1 },
      ["a1", "a2", "a3"],
    );
    const plan = computeChoicePlan(ordered, new Set(["a2"]));
    expect(plan.requiredTotal).toBe(1);
    expect(plan.completedRequired).toBe(1);
    // Satisfied → nothing left to nag about, and nothing "next".
    expect(plan.availableActivityIds.size).toBe(0);
    expect(plan.nextItem).toBeNull();
    expect(plan.choiceByLesson.get("L")?.satisfied).toBe(true);
  });

  test("choice pickCount 2 — partial pick still offers the rest", () => {
    const ordered = orderedFixture(
      { _id: "L", selectionMode: "choice", choicePickCount: 2 },
      ["a1", "a2", "a3"],
    );
    const plan = computeChoicePlan(ordered, new Set(["a1"]));
    expect(plan.requiredTotal).toBe(2);
    expect(plan.completedRequired).toBe(1);
    expect(plan.availableActivityIds).toEqual(new Set(["a2", "a3"]));
    expect(String(plan.nextItem?.activity._id)).toBe("a2");
    expect(plan.choiceByLesson.get("L")?.satisfied).toBe(false);
  });

  test("pickCount is clamped to the number of live options", () => {
    const ordered = orderedFixture(
      { _id: "L", selectionMode: "choice", choicePickCount: 9 },
      ["a1", "a2", "a3"],
    );
    const plan = computeChoicePlan(ordered, new Set());
    expect(plan.requiredTotal).toBe(3); // clamped to 3, not 9
    expect(plan.choiceByLesson.get("L")?.pickCount).toBe(3);
  });

  test("sequence lesson is unchanged — every option counts", () => {
    const ordered = orderedFixture({ _id: "L" }, ["a1", "a2"]);
    const plan = computeChoicePlan(ordered, new Set(["a1"]));
    expect(plan.requiredTotal).toBe(2);
    expect(plan.completedRequired).toBe(1);
    expect(plan.availableActivityIds).toEqual(new Set(["a2"]));
    expect(String(plan.nextItem?.activity._id)).toBe("a2");
    expect(plan.choiceByLesson.size).toBe(0);
  });
});

// ── Seed: a unit with a single CHOICE lesson (3 online options) ────────
async function seedChoiceUnit(
  t: ReturnType<typeof convexTest>,
  opts: { pickCount?: number } = {},
) {
  const institutionId = await seedTestInstitution(t);
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    name: "T",
    username: "t",
  });
  const s1 = await seedScholarInInstitution(t, {
    institutionId,
    name: "S1",
    username: "s1",
  });
  const s2 = await seedScholarInInstitution(t, {
    institutionId,
    name: "S2",
    username: "s2",
  });
  return await t.run(async (ctx) => {
    const unit = await ctx.db.insert("units", {
      teacherId: teacher,
      title: "Volcano Menu",
      isActive: true,
    });
    const lesson = await ctx.db.insert("lessons", {
      unitId: unit,
      title: "Pick a path",
      order: 0,
      selectionMode: "choice",
      choicePickCount: opts.pickCount ?? 1,
    });
    const a1 = await ctx.db.insert("activities", {
      lessonId: lesson,
      title: "Volcano",
      order: 0,
      kind: "online",
    });
    const a2 = await ctx.db.insert("activities", {
      lessonId: lesson,
      title: "Earthquake",
      order: 1,
      kind: "online",
    });
    const a3 = await ctx.db.insert("activities", {
      lessonId: lesson,
      title: "Tsunami",
      order: 2,
      kind: "online",
    });
    return { teacher, s1, s2, unit, lesson, a1, a2, a3 };
  });
}

describe("choice-aware progress through a live assignment", () => {
  test("total counts pickCount, and completing one satisfies the unit", async () => {
    const t = convexTest(schema, modules);
    const { teacher, s1, unit, lesson, a1, a2, a3 } = await seedChoiceUnit(t);
    const assignment = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [s1],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: a1, mode: "classFocus", setAt: Date.now() - 1000 },
          { activityId: a2, mode: "classFocus", setAt: Date.now() - 1000 },
          { activityId: a3, mode: "classFocus", setAt: Date.now() - 1000 },
        ],
      }),
    );

    await t.run(async (ctx) => {
      const before = await unitOnlineProgressForScholar(ctx, s1, unit, assignment);
      expect(before.totalOnline).toBe(1); // pickCount, not 3
      expect(before.completedOnline).toBe(0);
      expect(before.availableActivityIds.size).toBe(3);
      expect(before.choiceByLesson.get(String(lesson))?.optionCount).toBe(3);
      expect(await isUnitCompleteForScholar(ctx, s1, unit, assignment)).toBe(false);
    });

    // Scholar completes ONE option (assignment-scoped completion).
    await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: s1,
        activityId: a2,
        lessonId: lesson,
        unitId: unit,
        assignmentId: assignment,
        completedAt: Date.now(),
      });
    });

    await t.run(async (ctx) => {
      const after = await unitOnlineProgressForScholar(ctx, s1, unit, assignment);
      expect(after.completedOnline).toBe(1);
      expect(after.totalOnline).toBe(1);
      // D2 — remaining options no longer surfaced as work.
      expect(after.availableActivityIds.size).toBe(0);
      expect(after.choiceByLesson.get(String(lesson))?.satisfied).toBe(true);
      expect(await isUnitCompleteForScholar(ctx, s1, unit, assignment)).toBe(true);
    });
  });
});

describe("per-scholar targeting (divide & conquer)", () => {
  test("scholarIds narrows which options each scholar sees live", async () => {
    const t = convexTest(schema, modules);
    const { teacher, s1, s2, unit, a1, a2, a3 } = await seedChoiceUnit(t);
    const assignment = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [s1, s2],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: a1, mode: "classFocus", setAt: Date.now() - 1000, scholarIds: [s1] },
          { activityId: a2, mode: "classFocus", setAt: Date.now() - 1000, scholarIds: [s2] },
          { activityId: a3, mode: "classFocus", setAt: Date.now() - 1000 }, // cohort-wide
        ],
      }),
    );

    await t.run(async (ctx) => {
      const forS1 = await orderedOnlineActivitiesForUnit(ctx, unit, assignment, s1);
      const forS2 = await orderedOnlineActivitiesForUnit(ctx, unit, assignment, s2);
      expect(forS1.map((o) => String(o.activity._id)).sort()).toEqual(
        [String(a1), String(a3)].sort(),
      );
      expect(forS2.map((o) => String(o.activity._id)).sort()).toEqual(
        [String(a2), String(a3)].sort(),
      );
    });
  });

  test("assignWork writes a strict subset and collapses a whole-roster target", async () => {
    const t = convexTest(schema, modules);
    const { teacher, s1, s2, unit, a1, a2 } = await seedChoiceUnit(t);
    const asTeacher = await asUser(t, teacher);

    // Target a strict subset → stored.
    const assignmentId = await asTeacher.mutation(api.assignments.assignWork, {
      unitId: unit,
      scholarIds: [s1, s2],
      startsAt: Date.now() - 1000,
      target: { kind: "activity", activityId: a1, mode: "classFocus", scholarIds: [s1] },
    });
    // Target the whole roster → collapses to undefined (cohort-wide).
    await asTeacher.mutation(api.assignments.assignWork, {
      unitId: unit,
      scholarIds: [s1, s2],
      startsAt: Date.now() - 1000,
      target: { kind: "activity", activityId: a2, mode: "classFocus", scholarIds: [s1, s2] },
    });

    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    const e1 = a?.activitySchedule?.find((e) => String(e.activityId) === String(a1));
    const e2 = a?.activitySchedule?.find((e) => String(e.activityId) === String(a2));
    expect(e1?.scholarIds?.map(String)).toEqual([String(s1)]);
    expect(e2?.scholarIds).toBeUndefined();
  });

  test("setScholars prunes targeting to the new roster and drops empty targets", async () => {
    const t = convexTest(schema, modules);
    const { teacher, s1, s2, unit, a1, a2 } = await seedChoiceUnit(t);
    const assignmentId = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [s1, s2],
        startedAt: Date.now(),
        activitySchedule: [
          // targets only s2 → becomes empty when s2 leaves → entry dropped
          { activityId: a1, mode: "classFocus", setAt: Date.now() - 1000, scholarIds: [s2] },
          // targets both → narrows to [s1]
          { activityId: a2, mode: "classFocus", setAt: Date.now() - 1000, scholarIds: [s1, s2] },
        ],
      }),
    );
    const asTeacher = await asUser(t, teacher);
    await asTeacher.mutation(api.assignments.setScholars, {
      assignmentId,
      scholarIds: [s1],
    });

    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a?.scholarIds.map(String)).toEqual([String(s1)]);
    // a1 entry dropped (its only target left the roster).
    expect(a?.activitySchedule?.some((e) => String(e.activityId) === String(a1))).toBe(false);
    // a2 entry narrowed to [s1], never silently re-broadcast.
    const e2 = a?.activitySchedule?.find((e) => String(e.activityId) === String(a2));
    expect(e2?.scholarIds?.map(String)).toEqual([String(s1)]);
  });
});

describe("scholar plate surfaces choice options", () => {
  test("emits grouped option rows, then drops them once satisfied", async () => {
    const t = convexTest(schema, modules);
    const { teacher, s1, unit, lesson, a1, a2, a3 } = await seedChoiceUnit(t);
    const assignment = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [s1],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: a1, mode: "classFocus", setAt: Date.now() - 1000 },
          { activityId: a2, mode: "classFocus", setAt: Date.now() - 1000 },
          { activityId: a3, mode: "classFocus", setAt: Date.now() - 1000 },
        ],
      }),
    );

    const asScholar = await asUser(t, s1);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const optionRows = plate.rows.filter(
      (r) => String(r.choiceLessonId ?? "") === String(lesson),
    );
    expect(optionRows).toHaveLength(3);
    for (const r of optionRows) {
      expect(r.choicePickCount).toBe(1);
      expect(r.choiceOptionCount).toBe(3);
      expect(r.notStarted).toBe(true);
      // Choice-aware unit total = pickCount, not the option count.
      expect(r.unitActivityCount).toBe(1);
    }

    // Complete one option → the menu is satisfied; the others stop showing.
    await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: s1,
        activityId: a1,
        lessonId: lesson,
        unitId: unit,
        assignmentId: assignment,
        completedAt: Date.now(),
      });
    });
    const plate2 = await asScholar.query(api.scholarPlate.activeForMe, {});
    const stillOffered = plate2.rows.filter(
      (r) =>
        r.notStarted &&
        (String(r.activityId) === String(a2) || String(r.activityId) === String(a3)),
    );
    expect(stillOffered).toHaveLength(0);
  });
});

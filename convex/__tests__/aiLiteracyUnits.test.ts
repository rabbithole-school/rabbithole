import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { insertAiLiteracyUnits } from "../seedAiLiteracyUnits";
import { granuleTexts } from "../lib/granules";

// Why this file: the AI-literacy strand inserter (convex/seedAiLiteracyUnits.ts)
// is run through the LIVE schema validators here — convexTest validates every
// inserted row against schema.ts, so any field drift (a renamed/removed column,
// a tightened union) fails this test BEFORE it can reach a deployment. On top of
// that drift net we assert the structural + referential invariants the two
// grade-banded units must always hold.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const EXPECTED_SLUGS = ["is-the-robot-my-friend", "how-chatbots-try-to-hook-you"];

async function seedTeacher(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "System Teacher",
      email: "system@rabbithole.app",
      role: "teacher",
    }),
  );
}

async function seeded() {
  const t = convexTest(schema, modules);
  const teacherId = await seedTeacher(t);
  const inserted = await t.run(async (ctx) =>
    insertAiLiteracyUnits(ctx, teacherId),
  );
  return { t, teacherId, inserted };
}

describe("AI-literacy strand seed — schema drift + invariants", () => {
  test("inserts both units cleanly through the live schema validators", async () => {
    const { t, inserted } = await seeded();
    expect(inserted).toBe(2);

    const units = await t.run(async (ctx) =>
      ctx.db.query("units").collect(),
    );
    expect(units.length).toBe(2);
    for (const slug of EXPECTED_SLUGS) {
      const unit = units.find((u) => u.slug === slug);
      expect(unit, `unit ${slug} present`).toBeTruthy();
      expect(unit!.subject).toBe("AI Literacy");
      expect(unit!.isActive).toBe(true);
      // EQs / EUs are stored as keyed granules and must be non-empty.
      expect(granuleTexts(unit!.essentialQuestions).length).toBeGreaterThan(0);
      expect(
        granuleTexts(unit!.enduringUnderstandings).length,
      ).toBeGreaterThan(0);
      // Each unit awards a completion badge.
      expect(unit!.badgeOnCompletion?.title, `${slug} badge`).toBeTruthy();
    }
  });

  test("every lesson has ordered activities; every online activity has a prompt", async () => {
    const { t } = await seeded();
    const units = await t.run(async (ctx) => ctx.db.query("units").collect());

    for (const unit of units) {
      const lessons = await t.run(async (ctx) =>
        ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
          .collect(),
      );
      expect(lessons.length, `${unit.slug} has lessons`).toBeGreaterThan(0);

      // Lesson orders are the contiguous 0..n-1 sequence.
      const lessonOrders = lessons.map((l) => l.order).sort((a, b) => a - b);
      expect(lessonOrders).toEqual(lessons.map((_, i) => i));

      for (const lesson of lessons) {
        const activities = await t.run(async (ctx) =>
          ctx.db
            .query("activities")
            .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
            .collect(),
        );
        expect(
          activities.length,
          `lesson "${lesson.title}" has activities`,
        ).toBeGreaterThan(0);

        const activityOrders = activities
          .map((a) => a.order)
          .sort((a, b) => a - b);
        expect(activityOrders).toEqual(activities.map((_, i) => i));

        for (const activity of activities) {
          if (activity.kind === "online") {
            expect(
              activity.systemPrompt && activity.systemPrompt.length > 0,
              `online activity "${activity.title}" has a systemPrompt`,
            ).toBe(true);
          } else {
            // Offline activities are teacher-led; they carry no tutor prompt.
            expect(
              activity.systemPrompt,
              `offline activity "${activity.title}" has no tutor prompt`,
            ).toBeUndefined();
          }
          // Every activity has teacher-facing description text.
          expect(
            activity.description && activity.description.length > 0,
            `activity "${activity.title}" has a description`,
          ).toBe(true);
        }
      }
    }
  });

  test("the Spot-the-Hook process exists and is referenced by online activities", async () => {
    const { t } = await seeded();
    const process = await t.run(async (ctx) =>
      ctx.db
        .query("processes")
        .withIndex("by_slug", (q) => q.eq("slug", "spot-the-hook"))
        .first(),
    );
    expect(process, "spot-the-hook process created").toBeTruthy();
    expect(process!.steps.map((s) => s.key)).toEqual(["spot", "name", "choose"]);

    const activities = await t.run(async (ctx) =>
      ctx.db.query("activities").collect(),
    );
    const linked = activities.filter((a) => a.processId === process!._id);
    expect(linked.length, "at least one activity uses the process").toBeGreaterThan(0);
  });

  test("deliverables, advance rubrics, and baseline/exit recipes are present and valid", async () => {
    const { t } = await seeded();
    const activities = await t.run(async (ctx) =>
      ctx.db.query("activities").collect(),
    );

    // At least one manual-rubric deliverable with non-empty criteria.
    const deliverables = activities.filter((a) => a.deliverable);
    expect(deliverables.length).toBeGreaterThan(0);
    for (const a of deliverables) {
      const d = a.deliverable!;
      expect(d.prompt.length, `${a.title} deliverable prompt`).toBeGreaterThan(0);
      if (d.mode === "manual") {
        expect(
          d.criteria.length,
          `${a.title} manual deliverable has criteria`,
        ).toBeGreaterThan(0);
      }
    }

    // At least one chat "advance" rubric (discussion, no artifact).
    const advanceRubrics = activities.filter((a) => a.advanceRubric);
    expect(advanceRubrics.length).toBeGreaterThan(0);
    for (const a of advanceRubrics) {
      expect(
        a.advanceRubric!.criteria.length,
        `${a.title} advance rubric has criteria`,
      ).toBeGreaterThan(0);
    }

    // The grades 3-5 unit brackets its content with a baseline opener and an
    // exit-ticket close.
    const recipes = activities
      .map((a) => a.recipe)
      .filter((r): r is NonNullable<typeof r> => Boolean(r));
    expect(recipes).toContain("baseline");
    expect(recipes).toContain("exitTicket");
  });

  test("is idempotent — a second run inserts nothing", async () => {
    const { t, teacherId } = await seeded();
    const second = await t.run(async (ctx) =>
      insertAiLiteracyUnits(ctx, teacherId),
    );
    expect(second).toBe(0);

    const units = await t.run(async (ctx) => ctx.db.query("units").collect());
    expect(units.length).toBe(2);
    // The process wasn't duplicated either.
    const processes = await t.run(async (ctx) =>
      ctx.db
        .query("processes")
        .withIndex("by_slug", (q) => q.eq("slug", "spot-the-hook"))
        .collect(),
    );
    expect(processes.length).toBe(1);
  });
});

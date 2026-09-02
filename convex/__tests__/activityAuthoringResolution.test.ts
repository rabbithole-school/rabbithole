import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { pickActivityByTitle } from "../lib/aideTools";

/**
 * Regression tests for the activity-authoring resolution path added in
 * PR #1446 (Copilot review of #1380):
 *
 * 1. getLessonForActivityAuthoring filters archived activities out of the
 *    list the Curriculum Bot's kind-specific tools can select from
 *    (https://github.com/rabbithole-school/rabbithole/pull/1446#discussion_r3707335818).
 * 2. pickActivityByTitle trims and rejects empty/whitespace queries so an
 *    empty activityTitle can't `includes("")`-match the first activity
 *    (https://github.com/rabbithole-school/rabbithole/pull/1446#discussion_r3707335868).
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedLessonWithActivities(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "Test teacher",
      username: `teacher${Math.random()}`,
      role: "teacher",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const liveId = await ctx.db.insert("activities", {
      lessonId,
      title: "Live Activity",
      kind: "online",
      order: 0,
    });
    const archivedId = await ctx.db.insert("activities", {
      lessonId,
      title: "Archived Activity",
      kind: "online",
      order: 1,
      archivedAt: Date.now(),
    });
    return { lessonId, liveId, archivedId };
  });
}

describe("getLessonForActivityAuthoring", () => {
  test("excludes archived activities from the resolvable list", async () => {
    const t = convexTest(schema, modules);
    const { lessonId, liveId, archivedId } = await seedLessonWithActivities(t);

    const resolved = await t.run(async (ctx) =>
      ctx.runQuery(
        internal.curriculumAssistant.getLessonForActivityAuthoring,
        { lessonId },
      ),
    );

    const ids = resolved?.activities.map((a) => a._id) ?? [];
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(archivedId);
  });
});

describe("pickActivityByTitle", () => {
  const activities = [
    { _id: "a1", title: "Fractions Warmup" },
    { _id: "a2", title: "Fractions Practice" },
  ];

  test("returns undefined for an empty query", () => {
    expect(pickActivityByTitle(activities, "")).toBeUndefined();
  });

  test("returns undefined for a whitespace-only query", () => {
    expect(pickActivityByTitle(activities, "   ")).toBeUndefined();
  });

  test("matches an exact (case-insensitive) title", () => {
    expect(pickActivityByTitle(activities, "fractions warmup")?._id).toBe("a1");
  });

  test("matches a prefix over a later substring", () => {
    expect(pickActivityByTitle(activities, "Fractions P")?._id).toBe("a2");
  });
});

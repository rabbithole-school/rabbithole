import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "teacher",
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `t${role}_${Math.random().toString(36).slice(2, 6)}`,
      role,
    }),
  );
}

async function seedLesson(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
): Promise<Id<"lessons">> {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    });
    return await ctx.db.insert("lessons", {
      unitId,
      title: "L",
      order: 0,
    });
  });
}

const okDeliv = {
  kind: "text" as const,
  prompt: "Write",
  mode: "manual" as const,
  criteria: [{ id: "overall", label: "Overall", description: "ok" }],
};

describe("activities.upsertInternal — lesson parent", () => {
  test("teacher aide rejects a missing lesson before creating an activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);
    await t.run((ctx) => ctx.db.delete(lessonId));

    await expect(
      t.mutation(internal.teacherAide.createScholarActivity, {
        lessonId,
        title: "Orphaned activity",
        kind: "offline",
      }),
    ).rejects.toThrow("Lesson not found");
  });

  test("inserts a new lesson activity and assigns next order", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);

    const r1 = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "First",
      deliverable: okDeliv,
    });
    const r2 = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Second",
      deliverable: okDeliv,
    });

    expect(r1.existed).toBe(false);
    expect(r2.existed).toBe(false);
    const a1 = await t.run((ctx) => ctx.db.get(r1.activityId));
    const a2 = await t.run((ctx) => ctx.db.get(r2.activityId));
    expect(a1?.order).toBe(0);
    expect(a2?.order).toBe(1);
    expect(a1?.lessonId).toEqual(lessonId);
  });

  test("byTitle match returns existing row + patches missing deliverable", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);

    // First call: offline activity (no deliverable required)
    const r1 = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Same Title" },
      title: "Same Title",
      kind: "offline",
    });

    // Second call: same title, now with a deliverable — should patch
    // the existing row, not create a new one.
    const r2 = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Same Title" },
      title: "Same Title",
      kind: "offline", // kind doesn't change on the patch
      deliverable: okDeliv,
    });
    expect(r1.activityId).toEqual(r2.activityId);
    // existed=true whenever the row was already there before this
    // call (whether or not we patched it). The previous semantics
    // inverted the flag on the patch branch — fixed in May 2026.
    expect(r2.existed).toBe(true);
    expect(r2.kind).toBe("offline");
    expect(r2.deliverableAttached).toBe(true);
    const a = await t.run((ctx) => ctx.db.get(r2.activityId));
    expect(a?.deliverable?.criteria[0].id).toBe("overall");
  });

  test("REFUSES online without deliverable", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);
    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        title: "x",
        kind: "online",
      }),
    ).rejects.toThrow(/REFUSED/);
  });

  test("allows online with an advanceRubric and NO deliverable (no document)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);

    const r = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Map discovery",
      kind: "online",
      advanceRubric: {
        criteria: [
          { id: "located", label: "Located the places", description: "all three" },
          { id: "explained", label: "Explained the why" },
        ],
      },
    });
    expect(r.existed).toBe(false);
    expect(r.deliverableAttached).toBe(false);
    expect(r.advanceRubricAttached).toBe(true);
    const a = await t.run((ctx) => ctx.db.get(r.activityId));
    expect(a?.deliverable).toBeUndefined();
    expect(a?.advanceRubric?.criteria).toHaveLength(2);
    expect(a?.advanceRubric?.criteria[0].label).toBe("Located the places");
  });

  test("REFUSES online with BOTH a deliverable and an advanceRubric", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);
    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        title: "both",
        kind: "online",
        deliverable: okDeliv,
        advanceRubric: { criteria: [{ id: "x", label: "X" }] },
      }),
    ).rejects.toThrow(/not both/i);
  });

  test("patches an advanceRubric onto an existing bare activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);

    const r1 = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Discovery" },
      title: "Discovery",
      kind: "offline",
    });
    const r2 = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Discovery" },
      title: "Discovery",
      kind: "offline",
      advanceRubric: { criteria: [{ id: "noticed", label: "Noticed the split" }] },
    });
    expect(r1.activityId).toEqual(r2.activityId);
    expect(r2.advanceRubricAttached).toBe(true);
    const a = await t.run((ctx) => ctx.db.get(r2.activityId));
    expect(a?.advanceRubric?.criteria[0].id).toBe("noticed");
  });

  test("REFUSES to add an advanceRubric to a row that already has a deliverable (idempotent retry)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);

    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Quest" },
      title: "Quest",
      kind: "online",
      deliverable: okDeliv,
    });
    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        match: { byTitle: "Quest" },
        title: "Quest",
        kind: "online",
        advanceRubric: { criteria: [{ id: "x", label: "X" }] },
      }),
    ).rejects.toThrow(/already has a document quality map/i);
  });

  test("REFUSES to add a deliverable to a row that already has an advanceRubric (idempotent retry)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await seedLesson(t, teacherId);

    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Quest" },
      title: "Quest",
      kind: "online",
      advanceRubric: { criteria: [{ id: "x", label: "X" }] },
    });
    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        match: { byTitle: "Quest" },
        title: "Quest",
        kind: "online",
        deliverable: okDeliv,
      }),
    ).rejects.toThrow(/already has a conversation advance gate/i);
  });
});

// Quest parent tests removed — Quests entity dropped in the kill-quests
// refactor. See review/kill-quests-elevate-IS.md.

// Scholar parent tests removed — one-off scholar-scoped activities were
// unified under scholar-authored IS Units (units.authorScholarId).
// See review/homework-on-assignment.md.

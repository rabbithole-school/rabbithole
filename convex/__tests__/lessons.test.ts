import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedTeacher(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: "Test Teacher",
      username: "testteacher",
      role: "teacher",
    });
  });
}

async function withTeacher(
  t: TestConvex<typeof schema>,
  teacherId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: teacherId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${teacherId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnit(
  t: TestConvex<typeof schema>,
  teacherId: Id<"users">,
  title = "Test Unit",
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("units", {
      teacherId,
      title,
      isActive: true,
    });
  });
}

async function seedScholar(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: "Test Scholar",
      username: "testscholar",
      role: "scholar",
    });
  });
}

/** Same as withTeacher, but generic over any userId (e.g. a scholar). */
async function withUser(t: TestConvex<typeof schema>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

type Strand = "core" | "connections" | "practice" | "identity";

async function seedLesson(
  t: TestConvex<typeof schema>,
  unitId: Id<"units">,
  title: string,
  order: number,
  strand: Strand = "core",
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("lessons", {
      unitId,
      title,
      order,
      strand,
    });
  });
}

async function readLessons(
  t: TestConvex<typeof schema>,
  unitId: Id<"units">,
) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect(),
  );
}

describe("lessons.reorder", () => {
  test("within-strand downward reorder writes the new order", async () => {
    // The off-by-one bug we fixed on the client (filter-then-splice) would
    // have produced [B, A, C, D] when dragging A down past C; the server
    // here just verifies that a correct payload [B, C, A, D] is persisted
    // exactly as the client now sends it.
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const unitId = await seedUnit(t, teacherId);

    const a = await seedLesson(t, unitId, "A", 0);
    const b = await seedLesson(t, unitId, "B", 1);
    const c = await seedLesson(t, unitId, "C", 2);
    const d = await seedLesson(t, unitId, "D", 3);

    const asTeacher = await withTeacher(t, teacherId);
    await asTeacher.mutation(api.lessons.reorder, {
      lessonIds: [b, c, a, d],
    });

    const rows = await readLessons(t, unitId);
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    expect(byId.get(String(b))?.order).toBe(0);
    expect(byId.get(String(c))?.order).toBe(1);
    expect(byId.get(String(a))?.order).toBe(2);
    expect(byId.get(String(d))?.order).toBe(3);
  });

  test("cross-strand drag applies strandUpdates atomically with reorder", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const unitId = await seedUnit(t, teacherId);

    const a = await seedLesson(t, unitId, "A", 0, "core");
    const b = await seedLesson(t, unitId, "B", 1, "core");
    const c = await seedLesson(t, unitId, "C", 0, "connections");

    const asTeacher = await withTeacher(t, teacherId);
    // Move B from core → connections, ahead of C.
    await asTeacher.mutation(api.lessons.reorder, {
      lessonIds: [a, b, c],
      strandUpdates: [{ id: b, strand: "connections" }],
    });

    const rows = await readLessons(t, unitId);
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    expect(byId.get(String(b))?.strand).toBe("connections");
    expect(byId.get(String(a))?.strand).toBe("core");
    expect(byId.get(String(c))?.strand).toBe("connections");
    expect(byId.get(String(a))?.order).toBe(0);
    expect(byId.get(String(b))?.order).toBe(1);
    expect(byId.get(String(c))?.order).toBe(2);
  });

  test("rejects partial lesson list (leaves stale order otherwise)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const unitId = await seedUnit(t, teacherId);

    const a = await seedLesson(t, unitId, "A", 0);
    const b = await seedLesson(t, unitId, "B", 1);
    await seedLesson(t, unitId, "C", 2);

    const asTeacher = await withTeacher(t, teacherId);
    await expect(
      asTeacher.mutation(api.lessons.reorder, {
        lessonIds: [b, a], // missing C
      }),
    ).rejects.toThrow(/expected 3 lessonIds/);
  });

  test("rejects lessonIds spanning multiple units", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const unitA = await seedUnit(t, teacherId);
    const unitB = await seedUnit(t, teacherId);

    const a1 = await seedLesson(t, unitA, "A1", 0);
    const b1 = await seedLesson(t, unitB, "B1", 0);

    const asTeacher = await withTeacher(t, teacherId);
    await expect(
      asTeacher.mutation(api.lessons.reorder, {
        lessonIds: [a1, b1],
      }),
    ).rejects.toThrow(/same unit/);
  });

  test("rejects strandUpdates referencing a foreign lesson id", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const unitA = await seedUnit(t, teacherId);
    const unitB = await seedUnit(t, teacherId);

    const a1 = await seedLesson(t, unitA, "A1", 0);
    const a2 = await seedLesson(t, unitA, "A2", 1);
    const foreign = await seedLesson(t, unitB, "Foreign", 0);

    const asTeacher = await withTeacher(t, teacherId);
    await expect(
      asTeacher.mutation(api.lessons.reorder, {
        lessonIds: [a1, a2], // complete cover for unitA
        strandUpdates: [{ id: foreign, strand: "connections" }],
      }),
    ).rejects.toThrow(/strandUpdates/);
  });
});

describe("lessons.moveToUnit", () => {
  test("happy path: reparents the lesson and appends it to an empty target unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const sourceUnit = await seedUnit(t, teacherId, "Source Unit");
    const targetUnit = await seedUnit(t, teacherId, "Target Unit");

    const lessonId = await seedLesson(t, sourceUnit, "Fractions", 0);
    const activityId = await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Activity 1",
        order: 0,
        kind: "online",
      }),
    );

    const asTeacher = await withTeacher(t, teacherId);
    const result = await asTeacher.mutation(api.lessons.moveToUnit, {
      id: lessonId,
      targetUnitId: targetUnit,
    });
    expect(result.moved).toBe(true);
    expect(result.fromUnitId).toBe(sourceUnit);
    expect(result.toUnitId).toBe(targetUnit);

    const lesson = await t.run((ctx) => ctx.db.get(lessonId));
    expect(lesson?.unitId).toBe(targetUnit);
    expect(lesson?.order).toBe(0); // first (only) lesson in the target unit

    // Activities follow for free — they only reference lessonId.
    const activitiesUnderLesson = await t.run((ctx) =>
      ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
        .collect(),
    );
    expect(activitiesUnderLesson.map((a) => a._id)).toEqual([activityId]);

    // The source unit no longer lists the lesson.
    const sourceLessons = await readLessons(t, sourceUnit);
    expect(sourceLessons).toHaveLength(0);
  });

  test("moving into a unit that already has lessons appends to the end", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const sourceUnit = await seedUnit(t, teacherId, "Source Unit");
    const targetUnit = await seedUnit(t, teacherId, "Target Unit");

    await seedLesson(t, targetUnit, "Existing A", 0);
    await seedLesson(t, targetUnit, "Existing B", 1);
    const lessonId = await seedLesson(t, sourceUnit, "Moved In", 0);

    const asTeacher = await withTeacher(t, teacherId);
    await asTeacher.mutation(api.lessons.moveToUnit, {
      id: lessonId,
      targetUnitId: targetUnit,
    });

    const lesson = await t.run((ctx) => ctx.db.get(lessonId));
    expect(lesson?.unitId).toBe(targetUnit);
    expect(lesson?.order).toBe(2); // appended after the two existing lessons

    const targetLessons = await readLessons(t, targetUnit);
    expect(targetLessons).toHaveLength(3);
  });

  test("same-unit move is a safe no-op", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const unitId = await seedUnit(t, teacherId);
    const lessonId = await seedLesson(t, unitId, "Stays Put", 0);
    const other = await seedLesson(t, unitId, "Sibling", 1);

    const asTeacher = await withTeacher(t, teacherId);
    const result = await asTeacher.mutation(api.lessons.moveToUnit, {
      id: lessonId,
      targetUnitId: unitId,
    });
    expect(result.moved).toBe(false);

    const lesson = await t.run((ctx) => ctx.db.get(lessonId));
    expect(lesson?.unitId).toBe(unitId);
    expect(lesson?.order).toBe(0); // untouched

    const sibling = await t.run((ctx) => ctx.db.get(other));
    expect(sibling?.order).toBe(1); // untouched
  });

  test("rejects a caller lacking edit access on the target unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const scholarId = await seedScholar(t);
    const sourceUnit = await seedUnit(t, teacherId, "Source Unit");
    const targetUnit = await seedUnit(t, teacherId, "Target Unit");
    const lessonId = await seedLesson(t, sourceUnit, "Fractions", 0);

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.lessons.moveToUnit, {
        id: lessonId,
        targetUnitId: targetUnit,
      }),
    ).rejects.toThrow(/Forbidden/);

    // Nothing moved.
    const lesson = await t.run((ctx) => ctx.db.get(lessonId));
    expect(lesson?.unitId).toBe(sourceUnit);
  });

  test("rejects a caller lacking edit access on the source unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const scholarId = await seedScholar(t);
    // The scholar authored the TARGET unit (an IS unit) but not the source.
    const sourceUnit = await seedUnit(t, teacherId, "Source Unit");
    const targetUnit = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId,
        title: "Scholar's IS Unit",
        isActive: true,
        authorScholarId: scholarId,
      }),
    );
    const lessonId = await seedLesson(t, sourceUnit, "Fractions", 0);

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.lessons.moveToUnit, {
        id: lessonId,
        targetUnitId: targetUnit,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Phase 3c — the scholar plate's IS lane is now the canonical QUEST lane:
// ONE card per (scholar, unit), gated by `questsForScholar`. These tests pin the
// three behaviors the repoint introduces: one-card-per-quest collapse, catalog
// free-starts surviving, and retracted quests dropping out.

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

async function seedTeacherAndScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const teacher = await ctx.db.insert("users", {
      name: "T",
      username: "t",
      role: "teacher",
    });
    const scholar = await ctx.db.insert("users", {
      name: "S",
      username: "s",
      role: "scholar",
    });
    return { teacher, scholar };
  });
}

/** A unit with `count` online activities under one lesson. `authorScholarId`
 *  present → scholar-authored quest; absent → teacher-authored catalog unit. */
async function seedUnit(
  t: ReturnType<typeof convexTest>,
  args: {
    teacher: Id<"users">;
    authorScholarId?: Id<"users">;
    isActive?: boolean;
    title?: string;
    lessonTitle?: string;
    authorRole?: "author" | "inspired";
    activityCount?: number;
  },
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: args.teacher,
      authorScholarId: args.authorScholarId,
      authorRole: args.authorRole,
      title: args.title ?? "Quest",
      isActive: args.isActive ?? true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: args.lessonTitle ?? "L1",
      order: 0,
    });
    const activityIds: Id<"activities">[] = [];
    for (let i = 0; i < (args.activityCount ?? 1); i++) {
      activityIds.push(
        await ctx.db.insert("activities", {
          lessonId,
          title: `Activity ${i}`,
          kind: "online",
          order: i,
        }),
      );
    }
    return { unitId, lessonId, activityIds };
  });
}

describe("scholar plate — quest lane (Phase 3c)", () => {
  test("two live sessions in ONE unit collapse to one IS card opening the newer session", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar } = await seedTeacherAndScholar(t);
    // A scholar-authored quest with two activities, both still incomplete.
    const { unitId, lessonId, activityIds } = await seedUnit(t, {
      teacher,
      authorScholarId: scholar,
      activityCount: 2,
    });
    const [a0, a1] = activityIds;
    const { newer } = await t.run(async (ctx) => {
      const older = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        lessonId,
        activityId: a0,
        title: "Older",
        isArchived: false,
        lastMessageAt: Date.now() - 60_000,
      });
      const newer = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        lessonId,
        activityId: a1,
        title: "Newer",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
      return { older, newer };
    });

    const asScholar = await asUser(t, scholar);
    const { rows, isTotalCount } = await asScholar.query(
      api.scholarPlate.activeForMe,
      {},
    );
    const unitRows = rows.filter((r) => String(r.unitId) === String(unitId));

    // ONE card for the quest, not one per session…
    expect(unitRows).toHaveLength(1);
    // …opening the most-recently-touched live session.
    expect(String(unitRows[0]?.sessionId)).toBe(String(newer));
    expect(unitRows[0]?.origin).toBe("is");
    // isTotalCount counts CARDS (quests), not sessions.
    expect(isTotalCount).toBe(1);
  });

  test("a baked Custom Quest uses its polished lesson title on Home", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar } = await seedTeacherAndScholar(t);
    const { unitId, lessonId, activityIds } = await seedUnit(t, {
      teacher,
      authorScholarId: scholar,
      authorRole: "author",
      title: "why are ferns so old",
      lessonTitle: "Cracking the Fern's Survival Code",
    });
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        lessonId,
        activityId: activityIds[0],
        title: "why are ferns so old",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((candidate) => String(candidate.unitId) === String(unitId));

    expect(row?.unitTitle).toBe("Cracking the Fern's Survival Code");
  });

  test("a catalog free-start (teacher unit, no assignment) appears in the IS lane", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar } = await seedTeacherAndScholar(t);
    // Teacher-authored catalog unit — the scholar does NOT author it.
    const { unitId, lessonId, activityIds } = await seedUnit(t, { teacher });
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        lessonId,
        activityId: activityIds[0],
        title: "Free-started catalog quest",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => String(r.unitId) === String(unitId));

    expect(row).toBeTruthy();
    expect(row?.origin).toBe("is");
    expect(String(row?.sessionId)).toBe(String(sessionId));
    expect(row?.unitTitle).toBe("Quest");
  });

  test("a retracted quest (deactivated unit) drops out of the lane", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar } = await seedTeacherAndScholar(t);
    // An INACTIVE scholar-authored quest with a lingering live session.
    const { unitId, lessonId, activityIds } = await seedUnit(t, {
      teacher,
      authorScholarId: scholar,
      isActive: false,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        lessonId,
        activityId: activityIds[0],
        title: "Retracted work",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );

    const asScholar = await asUser(t, scholar);
    const { rows, isTotalCount } = await asScholar.query(
      api.scholarPlate.activeForMe,
      {},
    );
    expect(rows.filter((r) => String(r.unitId) === String(unitId))).toHaveLength(
      0,
    );
    expect(isTotalCount).toBe(0);
  });

  test("unit-less legacy IS sessions still render one card each", async () => {
    const t = convexTest(schema, modules);
    const { scholar } = await seedTeacherAndScholar(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("sessions", {
          userId: scholar,
          title: `Anchorless ${i}`,
          isArchived: false,
          lastMessageAt: Date.now() - i * 1000,
        });
      }
    });

    const asScholar = await asUser(t, scholar);
    const { rows, isTotalCount } = await asScholar.query(
      api.scholarPlate.activeForMe,
      {},
    );
    const isRows = rows.filter((r) => r.origin === "is");
    expect(isRows).toHaveLength(3);
    for (const r of isRows) expect(r.isSeed).toBe(true);
    expect(isTotalCount).toBe(3);
  });
});

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Fixtures (copied verbatim per rabbithole-testing.md convention) ──────
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId =
    role === "teacher"
      ? await seedStaffWithMembership(t, {
          institutionId,
          name: overrides.name ?? `Test ${role}`,
          username: overrides.username ?? `test-${role}-${Math.floor(role.length)}`,
        })
      : await seedScholarInInstitution(t, {
          institutionId,
          name: overrides.name ?? `Test ${role}`,
          username: overrides.username ?? `test-${role}-${Math.floor(role.length)}`,
        });
  await t.run((ctx) =>
    ctx.db.patch(userId, {
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );
  return userId;
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** Seed a unit → lesson → one OFFLINE activity, return the ids. */
async function seedOfflineActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    } as Doc<"units">);
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Fractions Worksheet",
      kind: "offline",
      order: 0,
    } as Doc<"activities">);
    return { unitId, lessonId, activityId };
  });
}

async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  unitId: Id<"units">,
  scholarIds: Id<"users">[],
  title = "Cohort A",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      title,
      startedAt: Date.now(),
    }),
  );
}

/** Insert a ready, scholar-confirmed portfolio item (no activity yet). */
async function seedReadyItem(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  assignmentId: Id<"assignments"> | undefined,
  overrides: Partial<Doc<"portfolioItems">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("portfolioItems", {
      scholarId,
      title: "scan_0042.pdf",
      source: "google_drive",
      matchStatus: "confirmed",
      assignmentId,
      assignmentStatus: assignmentId ? "confirmed" : "none",
      processingStatus: "ready",
      aiCaption: "A fractions worksheet with shaded circles.",
      extractedText: "1/2 + 1/4 = 3/4",
      ...overrides,
    } as Doc<"portfolioItems">),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("portfolio materialization → offline project + deliverable", () => {
  test("setActivity materializes one offline project, deliverable, completion", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    // Before: scholar + assignment resolved, but no activity → no materialization.
    let deliverables = await t.run((ctx) =>
      ctx.db.query("deliverables").collect(),
    );
    expect(deliverables).toHaveLength(0);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });

    deliverables = await t.run((ctx) => ctx.db.query("deliverables").collect());
    expect(deliverables).toHaveLength(1);
    const d = deliverables[0];
    expect(d.portfolioItemId).toBe(itemId);
    expect(d.activityId).toBe(activityId);
    expect(d.assignmentId).toBe(assignmentId);
    expect(d.scholarId).toBe(scholarId);

    const session = await t.run((ctx) => ctx.db.get(d.sessionId));
    expect(session?.isOffline).toBe(true);
    expect(session?.userId).toBe(scholarId);
    expect(session?.activityId).toBe(activityId);
    expect(session?.assignmentId).toBe(assignmentId);

    const completions = await t.run((ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].activityId).toBe(activityId);
    expect(completions[0].assignmentId).toBe(assignmentId);
    expect(completions[0].sessionId).toBe(d.sessionId);
  });

  test("two scans for same (scholar, activity, assignment) share one offline project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const item1 = await seedReadyItem(t, scholarId, assignmentId);
    const item2 = await seedReadyItem(t, scholarId, assignmentId, {
      title: "scan_0043.pdf",
    });

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, {
      itemId: item1,
      activityId,
    });

    await asTeacher.mutation(api.portfolio.setActivity, {
      itemId: item2,
      activityId,
    });

    const deliverables = await t.run((ctx) =>
      ctx.db.query("deliverables").collect(),
    );
    expect(deliverables).toHaveLength(2);
    const sessions = await t.run((ctx) =>
      ctx.db
        .query("sessions")
        .filter((q) => q.eq(q.field("isOffline"), true))
        .collect(),
    );
    // Both deliverables attach to the SAME offline project.
    expect(sessions).toHaveLength(1);
    expect(new Set(deliverables.map((d) => d.sessionId)).size).toBe(1);
  });

  test("one item fans out to scholars and removes stale execution rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarA = await seedUser(t, "scholar", { username: "s1" });
    const scholarB = await seedUser(t, "scholar", { username: "s2" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarA, scholarB]);
    const itemId = await seedReadyItem(t, scholarA, assignmentId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.portfolio.setAttributions, {
      itemId, scholarIds: [scholarA, scholarB],
    });
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });
    const deliverables = await t.run((ctx) => ctx.db.query("deliverables").collect());
    expect(deliverables).toHaveLength(2);
    expect(new Set(deliverables.map((d) => d.portfolioItemId))).toEqual(new Set([itemId]));
    expect(new Set(deliverables.map((d) => d.scholarId))).toEqual(new Set([scholarA, scholarB]));

    await asTeacher.mutation(api.portfolio.setAttributions, { itemId, scholarIds: [scholarA] });
    const remaining = await t.run((ctx) => ctx.db.query("deliverables").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scholarId).toBe(scholarA);
    expect(
      await t.run((ctx) =>
        ctx.db.query("activityCompletions")
          .withIndex("by_scholar_activity", (q) => q.eq("scholarId", scholarB).eq("activityId", activityId))
          .collect(),
      ),
    ).toHaveLength(0);
  });

  test("changing the activity repoints the deliverable and GCs the old offline project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, lessonId, activityId } = await seedOfflineActivity(t, teacherId);
    const activity2 = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Second Worksheet",
        kind: "offline",
        order: 1,
      } as Doc<"activities">),
    );
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });
    await asTeacher.mutation(api.portfolio.setActivity, {
      itemId,
      activityId: activity2,
    });

    const deliverables = await t.run((ctx) =>
      ctx.db.query("deliverables").collect(),
    );
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0].activityId).toBe(activity2);

    // The old offline project (for activity 1) was GC'd; only one remains.
    const sessions = await t.run((ctx) =>
      ctx.db
        .query("sessions")
        .filter((q) => q.eq(q.field("isOffline"), true))
        .collect(),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].activityId).toBe(activity2);

    // Old completion GC'd too; one remains, for activity 2.
    const completions = await t.run((ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].activityId).toBe(activity2);
  });

  test("clearing the activity removes the deliverable + offline project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });
    await asTeacher.mutation(api.portfolio.setActivity, {
      itemId,
      activityId: undefined,
    });

    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("sessions")
          .filter((q) => q.eq(q.field("isOffline"), true))
          .collect(),
      ),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("activityCompletions").collect()),
    ).toHaveLength(0);
  });

  test("clearing work excluded from a targeted homework entry removes its empty session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const targetedScholarId = await seedUser(t, "scholar", { username: "s2" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [
      scholarId,
      targetedScholarId,
    ]);
    await t.run((ctx) =>
      ctx.db.patch(assignmentId, {
        activitySchedule: [
          {
            activityId,
            mode: "homework",
            setAt: Date.now() - 60_000,
            scholarIds: [targetedScholarId],
          },
        ],
      }),
    );
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });
    await asTeacher.mutation(api.portfolio.setActivity, {
      itemId,
      activityId: undefined,
    });

    expect(
      await t.run((ctx) =>
        ctx.db
          .query("sessions")
          .filter((q) => q.eq(q.field("isOffline"), true))
          .collect(),
      ),
    ).toHaveLength(0);
  });

  test("deleting the item cascades the deliverable + offline project away", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });
    await asTeacher.mutation(api.portfolio.deleteItem, { itemId });

    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("sessions")
          .filter((q) => q.eq(q.field("isOffline"), true))
          .collect(),
      ),
    ).toHaveLength(0);
  });

  test("the offline project is excluded from the scholar's own project list", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });

    // The scholar's own chat-project list must not surface the offline
    // container (it has no conversation to resume).
    const asScholar = await withUser(t, scholarId);
    const list = await asScholar.query(api.sessions.list, {});
    expect(list).toHaveLength(0);
  });

  test("setActivity rejects an activity from a different unit than the assignment", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    // A second unit with its own activity.
    const other = await seedOfflineActivity(t, teacherId);
    void activityId;
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.mutation(api.portfolio.setActivity, {
        itemId,
        activityId: other.activityId,
      }),
    ).rejects.toThrow(/not part of this assignment/i);
  });

  test("re-tagging the assignment clears the activity (no cross-cohort materialization)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignA = await seedAssignment(t, teacherId, unitId, [scholarId], "A");
    const assignB = await seedAssignment(t, teacherId, unitId, [scholarId], "B");
    const itemId = await seedReadyItem(t, scholarId, assignA);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });
    // Materialized under assignment A.
    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(1);
    await asTeacher.mutation(api.portfolio.setFamilyVisibility, {
      itemId,
      familyVisibility: "staff_only",
    });

    // Re-tag to assignment B → activity cleared → deliverable torn down.
    await asTeacher.mutation(api.portfolio.setAssignment, {
      itemId,
      assignmentId: assignB,
    });
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.activityId).toBeUndefined();
    expect(item?.familyVisibility).toBe("staff_only");
    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(0);
  });

  test("retrospective scan filing does not require or widen the assignment roster", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const otherScholarId = await seedUser(t, "scholar", { username: "s2" });
    const { unitId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemWithScholar = await seedReadyItem(t, otherScholarId, undefined);
    const itemWithAssignment = await seedReadyItem(
      t,
      scholarId,
      assignmentId,
    );
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.portfolio.setAssignment, {
      itemId: itemWithScholar,
      assignmentId,
    });
    await asTeacher.mutation(api.portfolio.assignScholar, {
      itemId: itemWithAssignment,
      scholarId: otherScholarId,
    });
    await asTeacher.mutation(api.portfolio.setActivity, {
      itemId: itemWithScholar,
      activityId,
    });

    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(assignment?.scholarIds).toEqual([scholarId]);
    expect((await t.run((ctx) => ctx.db.get(itemWithScholar)))?.assignmentId).toBe(
      assignmentId,
    );
    expect((await t.run((ctx) => ctx.db.get(itemWithAssignment)))?.scholarId).toBe(
      otherScholarId,
    );
    const retrospectiveDeliverable = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_portfolioItem", (q) =>
          q.eq("portfolioItemId", itemWithScholar),
        )
        .unique(),
    );
    expect(retrospectiveDeliverable?.scholarId).toBe(otherScholarId);
    expect(retrospectiveDeliverable?.assignmentId).toBe(assignmentId);
  });

  test("bulk assignment updates every selected scan", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarA = await seedUser(t, "scholar", { username: "s1" });
    const scholarB = await seedUser(t, "scholar", { username: "s2" });
    const { unitId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(
      t,
      teacherId,
      unitId,
      [scholarA, scholarB],
    );
    const itemA = await seedReadyItem(t, scholarA, undefined);
    const itemB = await seedReadyItem(t, scholarB, undefined);
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.portfolio.setAssignments, {
        itemIds: [itemA, itemB],
        assignmentId,
      }),
    ).resolves.toEqual({ updated: 2 });

    for (const itemId of [itemA, itemB]) {
      const item = await t.run((ctx) => ctx.db.get(itemId));
      expect(item?.assignmentId).toBe(assignmentId);
      expect(item?.assignmentStatus).toBe("confirmed");
      expect(item?.familyVisibility).toBe("attributed_families");
    }
  });

  test("bulk assignment accepts retrospective work without widening the roster", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarA = await seedUser(t, "scholar", { username: "s1" });
    const scholarB = await seedUser(t, "scholar", { username: "s2" });
    const { unitId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarA]);
    const itemA = await seedReadyItem(t, scholarA, undefined);
    const itemB = await seedReadyItem(t, scholarB, undefined);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.portfolio.setAssignments, {
      itemIds: [itemA, itemB],
      assignmentId,
    });

    for (const itemId of [itemA, itemB]) {
      const item = await t.run((ctx) => ctx.db.get(itemId));
      expect(item?.assignmentId).toBe(assignmentId);
      expect(item?.assignmentStatus).toBe("confirmed");
    }
    expect(
      (await t.run((ctx) => ctx.db.get(assignmentId)))?.scholarIds,
    ).toEqual([scholarA]);
  });
});

describe("share-back collation includes materialized scans", () => {
  test("collateSources surfaces the offline deliverable with portfolio content", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const scholarId = await seedUser(t, "scholar", {
      username: "s1",
      name: "Kai",
    });
    const { unitId, lessonId, activityId } = await seedOfflineActivity(t, teacherId);
    const assignmentId = await seedAssignment(t, teacherId, unitId, [scholarId]);
    const itemId = await seedReadyItem(t, scholarId, assignmentId);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });

    // A Share Back that sources the offline activity.
    const shareBackId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Gallery Walk",
        kind: "shareBack",
        order: 2,
        shareBackRecipe: "galleryWalk",
        sourceActivityIds: [activityId],
      } as Doc<"activities">),
    );

    const collated = await t.run((ctx) =>
      ctx.runQuery(internal.shareBack.collateSources, {
        shareBackActivityId: shareBackId,
        assignmentId,
      }),
    );
    expect(collated).not.toBeNull();
    expect(collated!.deliverables).toHaveLength(1);
    const d = collated!.deliverables[0];
    expect(d.contentKind).toBe("portfolio");
    expect(d.scholarName).toBe("Kai");
    expect(d.content).toContain("fractions worksheet");
  });
});

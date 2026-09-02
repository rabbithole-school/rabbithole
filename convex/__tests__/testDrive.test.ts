import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActivityKind } from "../../lib/activityKinds";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
) {
  return await t.run(async (ctx) => {
    const institutionId =
      role === "scholar"
        ? await ctx.db.insert("institutions", {
            name: "Test School",
            slug: "test-school",
            kind: "school",
          })
        : undefined;
    const userId = await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : `Test ${role}`,
      username: role === "scholar" ? "testscholar" : `test${role}`,
      role,
      institutionId,
    });
    if (institutionId) {
      await ctx.db.insert("memberships", {
        userId,
        role: "scholar",
        institutionId,
      });
    }
    return userId;
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  kind: ActivityKind = "online",
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind,
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

describe("Test Drive — projects.create", () => {
  test("a teacher can create a test-drive project owned by themselves", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const result = await asTeacher.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });

    const session = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(session).toBeTruthy();
    expect(session!.isTestDrive).toBe(true);
    expect(session!.userId).toBe(teacherId);
    // Title stays clean (no `[Test Drive]` prefix) — the banner conveys mode.
    expect(session!.title.startsWith("[Test Drive]")).toBe(false);
    expect(session!.title).toBe("Test Activity");
    await expect(asTeacher.query(api.sessions.list, {})).resolves.toEqual([]);
  });

  test.each([
    ["vibecode", "vibecode"],
    ["simulator", "workbench"],
  ] as const)(
    "a %s test drive preserves session mode %s across reset",
    async (kind, expectedMode) => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const { activityId } = await seedUnitWithActivity(t, teacherId, kind);
      const asTeacher = await withUser(t, teacherId);

      const first = await asTeacher.mutation(api.sessions.create, {
        activityId,
        isTestDrive: true,
      });
      const firstSession = await t.run((ctx) => ctx.db.get(first.id));
      expect(firstSession?.sessionMode).toBe(expectedMode);

      const reset = await asTeacher.mutation(api.sessions.resetTestDrive, {
        sessionId: first.id,
      });
      const resetSession = await t.run((ctx) => ctx.db.get(reset.id));
      expect(resetSession?.sessionMode).toBe(expectedMode);
    },
  );

  test("ancestor unitId/lessonId are derived from activityId when only the leaf is given", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);

    const result = await asTeacher.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });

    const session = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(session!.unitId).toBe(unitId);
    expect(session!.lessonId).toBe(lessonId);
    expect(session!.activityId).toBe(activityId);
  });

  test("a scholar cannot promote a project to test-drive (flag is stripped)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true, // honest attempt
    });

    const session = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(session!.isTestDrive).toBeUndefined();
    expect(session!.userId).toBe(scholarId);
  });

  test("an admin can also create test-drive projects", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin");
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asAdmin = await withUser(t, adminId);

    const result = await asAdmin.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });
    const session = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(session!.isTestDrive).toBe(true);
    expect(session!.userId).toBe(adminId);
  });
});

describe("Test Drive — listings hide test-drive projects", () => {
  test("projects.list (per-user) omits test-drive rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { schoolId, communityId } = await t.run(async (ctx) => {
      const schoolId = await ctx.db.insert("institutions", {
        name: "Test School",
        slug: "test-school",
        kind: "school",
      });
      const communityId = await ctx.db.insert("institutions", {
        name: "Adult Learning",
        slug: "adult-learning",
        kind: "community",
      });
      await ctx.db.insert("memberships", {
        userId: teacherId,
        role: "teacher",
        institutionId: schoolId,
      });
      await ctx.db.insert("memberships", {
        userId: teacherId,
        role: "scholar",
        institutionId: communityId,
      });
      return { schoolId, communityId };
    });
    const { activityId: schoolActivityId } = await seedUnitWithActivity(
      t,
      teacherId,
      "online",
      schoolId,
    );
    const { activityId: communityActivityId } = await seedUnitWithActivity(
      t,
      teacherId,
      "online",
      communityId,
    );
    const asTeacher = await withUser(t, teacherId);

    // A multi-role adult's own learning stays separate from their rehearsal.
    const personal = await asTeacher.mutation(api.sessions.create, {
      activityId: communityActivityId,
    });
    const rehearsal = await asTeacher.mutation(api.sessions.create, {
      activityId: schoolActivityId,
      isTestDrive: true,
    });

    const list = await asTeacher.query(api.sessions.list, {});
    expect(list.length).toBe(1);
    expect(list[0].isTestDrive).not.toBe(true);
    const stamps = await t.run(async (ctx) => ({
      personal: await ctx.db.get(personal.id),
      rehearsal: await ctx.db.get(rehearsal.id),
    }));
    expect(stamps.personal?.institutionId).toBe(communityId);
    expect(stamps.rehearsal?.institutionId).toBe(schoolId);
  });

  test("projects.listActiveByUnit (teacher dashboard) omits test-drive rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    // A real scholar project + a teacher test-drive on the same unit
    await asScholar.mutation(api.sessions.create, { activityId });
    await asTeacher.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });

    const data = await asTeacher.query(api.sessions.listActiveByUnit, {});
    const allScholars = data.unitGroups.flatMap((g) => g.scholars);
    expect(allScholars.length).toBe(1);
    expect(String(allScholars[0].scholarId)).toBe(String(scholarId));
  });
});

describe("Test Drive — observer skips analysis on test-drive projects", () => {
  test("getSessionContext exposes isTestDrive: true on a test-drive project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const result = await asTeacher.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });

    // Seed enough chat history that the observer wouldn't bail on the
    // "fewer than 3 messages" check.
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("messages", {
          sessionId: result.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
          flagged: false,
        });
      }
    });

    const ctxResult = await t.run(async (ctx) => {
      // Internal queries can be invoked directly via t.query when the function
      // uses internalQuery.
      return await ctx.runQuery(internal.sessionHelpers.getSessionContext, {
        sessionId: result.id,
      });
    });
    expect(ctxResult).toBeTruthy();
    expect(ctxResult!.isTestDrive).toBe(true);
  });

  test("getSessionContext exposes isTestDrive: false on a regular project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.sessions.create, {
      activityId,
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("messages", {
          sessionId: result.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
          flagged: false,
        });
      }
    });

    const ctxResult = await t.run(async (ctx) => {
      return await ctx.runQuery(internal.sessionHelpers.getSessionContext, {
        sessionId: result.id,
      });
    });
    expect(ctxResult).toBeTruthy();
    expect(ctxResult!.isTestDrive).toBe(false);
  });

  test("observer.analyzeSession returns null for test-drive projects without writing observer output", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const result = await asTeacher.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });

    // Seed 4 messages so the observer's "fewer than 3" pre-check doesn't
    // mask the test-drive gate we're verifying.
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("messages", {
          sessionId: result.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
          flagged: false,
        });
      }
    });

    // analyzeSession is an internalAction; convex-test runs it via the
    // testing runtime. The test-drive gate fires before any Anthropic SDK
    // call, so this should return null without making a network request.
    const observerResult = await t.action(
      internal.observer.analyzeSession,
      { sessionId: result.id },
    );
    expect(observerResult).toBeNull();

    // Verify the gate actually prevented writes (vs. failing earlier and
    // never reaching the would-be writers either).
    const masteryRows = await t.run(async (ctx) =>
      ctx.db
        .query("masteryObservations")
        .withIndex("by_session", (q) => q.eq("sessionId", result.id))
        .collect(),
    );
    const seedRows = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", teacherId))
        .collect(),
    );
    const signalRows = await t.run(async (ctx) =>
      ctx.db
        .query("sessionSignals")
        .withIndex("by_session", (q) => q.eq("sessionId", result.id))
        .collect(),
    );
    const analysisRows = await t.run(async (ctx) =>
      ctx.db
        .query("analyses")
        .withIndex("by_session", (q) => q.eq("sessionId", result.id))
        .collect(),
    );
    // The parasocial-reliance producer (observer step 6.6) rides the same
    // test-drive early-return, so a dry-run must raise no alert either.
    const alertRows = await t.run(async (ctx) =>
      ctx.db.query("alerts").collect(),
    );
    expect(masteryRows.length).toBe(0);
    expect(seedRows.length).toBe(0);
    expect(signalRows.length).toBe(0);
    expect(analysisRows.length).toBe(0);
    expect(alertRows.length).toBe(0);
  });
});

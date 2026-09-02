import { convexTest, type TestConvex } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

type Rig = TestConvex<typeof schema>;

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type CloneArgs = {
  sourceUserId: Id<"users">;
  targetUsername: string;
  targetName: string;
  gradeLevel?: string;
  attemptCap?: number;
  mirrorGroups?: boolean;
  dryRun?: boolean;
};

type CloneResult = {
  targetUserId: Id<"users"> | null;
  counts: Record<string, number>;
  mirroredGroups: string[];
  existedTarget: boolean;
};

type InspectResult = {
  source: {
    userId: Id<"users">;
    username: string | null;
    name: string | null;
    gradeLevel: string | null;
    institutionId: Id<"institutions"> | null;
  };
  copiedUserFields: {
    readingLevel: string | null;
    preferredFont: string | null;
    ttsEnabled: boolean | null;
    sttEnabled: boolean | null;
  };
  counts: Record<string, number>;
} | null;

type AdminCloneScholarApi = {
  adminCloneScholar: {
    findScholar: FunctionReference<
      "query",
      "internal",
      { search: string },
      Array<{
        userId: Id<"users">;
        username: string | null;
        name: string | null;
        gradeLevel: string | null;
        institutionId: Id<"institutions"> | null;
      }>
    >;
    inspectSource: FunctionReference<
      "query",
      "internal",
      { sourceUserId: Id<"users"> },
      InspectResult
    >;
    cloneScholar: FunctionReference<
      "mutation",
      "internal",
      CloneArgs,
      CloneResult
    >;
    purgeCloneScholar: FunctionReference<
      "mutation",
      "internal",
      { userId: Id<"users">; confirmUsername: string },
      { counts: Record<string, number> }
    >;
  };
};

const adminCloneScholar = (
  internal as typeof internal & AdminCloneScholarApi
).adminCloneScholar;

async function seedUser(
  t: Rig,
  role: "scholar" | "teacher" | "parent" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username:
        overrides.username ??
        `test-${role}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      gradeLevel: overrides.gradeLevel,
      readingLevel: overrides.readingLevel,
      preferredFont: overrides.preferredFont,
      ttsEnabled: overrides.ttsEnabled,
      sttEnabled: overrides.sttEnabled,
      institutionId: overrides.institutionId,
    }),
  );
}

async function seedRepresentativeSource(t: Rig) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
      timeZone: "Pacific/Honolulu",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Lehua Torres",
      username: "lehua",
      role: "teacher",
    });
    const sourceUserId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: "hoku",
      role: "scholar",
      gradeLevel: "4",
      readingLevel: "R",
      preferredFont: "andika",
      ttsEnabled: false,
      sttEnabled: true,
      institutionId,
    });
    const sourceSessionId = await ctx.db.insert("sessions", {
      userId: sourceUserId,
      title: "Fraction patterns",
      isArchived: false,
    });
    const sourceMessageId = await ctx.db.insert("messages", {
      sessionId: sourceSessionId,
      role: "user",
      content: "I noticed the denominators form a pattern.",
      flagged: false,
    });

    await ctx.db.insert("practiceMastery", {
      scholarId: sourceUserId,
      skillKey: "fractions:add-like-denominators",
      domain: "fraction-arithmetic",
      repetition: 3,
      halfLifeDays: 8,
      frontier: false,
      source: "practice",
      updatedAt: 1_000,
    });
    await ctx.db.insert("practiceMastery", {
      scholarId: sourceUserId,
      skillKey: "fractions:add-unlike-denominators",
      domain: "fraction-arithmetic",
      repetition: 1,
      halfLifeDays: 3,
      frontier: true,
      source: "practice",
      updatedAt: 2_000,
    });
    for (const createdAt of [1_000, 2_000, 3_000]) {
      await ctx.db.insert("practiceAttempts", {
        scholarId: sourceUserId,
        nodeKey: "fractions:add-like-denominators",
        correct: true,
        createdAt,
      });
    }

    const firstObservationId = await ctx.db.insert("masteryObservations", {
      scholarId: sourceUserId,
      conceptLabel: "Equivalent fractions",
      domain: "fraction-arithmetic",
      observedAt: 1_000,
      sessionId: sourceSessionId,
      transcriptExcerpt: "Two fourths is one half.",
      excerptMessageIds: [sourceMessageId],
      masteryLevel: 2,
      confidenceScore: 0.8,
      evidenceSummary: "Built an equivalent fraction.",
      evidenceType: "direct_demonstration",
      attemptContext: "project",
      studentInitiated: true,
      isSuperseded: true,
    });
    const secondObservationId = await ctx.db.insert("masteryObservations", {
      scholarId: sourceUserId,
      conceptLabel: "Equivalent fractions",
      domain: "fraction-arithmetic",
      observedAt: 2_000,
      sessionId: sourceSessionId,
      transcriptExcerpt: "Multiplying top and bottom keeps the value.",
      excerptMessageIds: [sourceMessageId],
      masteryLevel: 3,
      confidenceScore: 0.95,
      evidenceSummary: "Generalized the equivalence rule.",
      evidenceType: "direct_demonstration",
      attemptContext: "project",
      studentInitiated: true,
      supersedesId: firstObservationId,
      isSuperseded: false,
    });
    await ctx.db.insert("teacherMasteryOverrides", {
      scholarId: sourceUserId,
      observationId: secondObservationId,
      teacherId,
      masteryLevel: 2,
      notes: "Recheck with a visual model.",
    });
    await ctx.db.insert("seeds", {
      scholarId: sourceUserId,
      origin: "teacher",
      status: "pending",
      topic: "Fractions in musical rhythm",
      suggestionType: "cross_domain",
      rationale: "Connect equivalence to note lengths.",
      sessionId: sourceSessionId,
      teacherId,
    });
    const goalId = await ctx.db.insert("scholarGoals", {
      scholarId: sourceUserId,
      title: "Explain fraction equivalence",
      kind: "academic",
      origin: "scholar",
      createdBy: sourceUserId,
      status: "active",
      feedsTutor: true,
    });
    await ctx.db.insert("goalCheckins", {
      goalId,
      scholarId: sourceUserId,
      authorType: "scholar",
      authorId: sourceUserId,
      note: "I can explain it with folded paper.",
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      name: "Honu",
      scholarIds: [sourceUserId],
    });

    return {
      sourceUserId,
      teacherId,
      sourceSessionId,
      firstObservationId,
      secondObservationId,
      groupId,
    };
  });
}

async function learningRowCounts(
  t: Rig,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => ({
    practiceMastery: (
      await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    practicePlacements: (
      await ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    practiceAttempts: (
      await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) =>
          q.eq("scholarId", scholarId),
        )
        .collect()
    ).length,
    practiceErrorEvents: (
      await ctx.db
        .query("practiceErrorEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    practiceChoiceEvents: (
      await ctx.db
        .query("practiceChoiceEvents")
        .withIndex("by_scholar_createdAt", (q) =>
          q.eq("scholarId", scholarId),
        )
        .collect()
    ).length,
    practiceTuneups: (
      await ctx.db
        .query("practiceTuneups")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    practicePredictions: (
      await ctx.db
        .query("practicePredictions")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    nodeReveals: (
      await ctx.db
        .query("nodeReveals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    mapReveals: (
      await ctx.db
        .query("mapReveals")
        .withIndex("by_scholar_map", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    momentEvents: (
      await ctx.db
        .query("momentEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    instructionEvents: (
      await ctx.db
        .query("instructionEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    closureLines: (
      await ctx.db
        .query("closureLines")
        .withIndex("by_scholar_kind_hash", (q) =>
          q.eq("scholarId", scholarId),
        )
        .collect()
    ).length,
    scholarDossiers: (
      await ctx.db
        .query("scholarDossiers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    weeklyGoals: (
      await ctx.db
        .query("weeklyGoals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    scholarUnitBadges: (
      await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    scholarActivityAngles: (
      await ctx.db
        .query("scholarActivityAngles")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    masteryObservations: (
      await ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    teacherMasteryOverrides: (
      await ctx.db
        .query("teacherMasteryOverrides")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    scholarGoals: (
      await ctx.db
        .query("scholarGoals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    goalCheckins: (
      await ctx.db
        .query("goalCheckins")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
    seeds: (
      await ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
        .collect()
    ).length,
  }));
}

describe("adminCloneScholar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("clones the learning record, remaps IDs, mirrors groups, and purges it", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedRepresentativeSource(t);
    const found = await t.query(adminCloneScholar.findScholar, {
      search: "HOKU",
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      userId: fixture.sourceUserId,
      username: "hoku",
      name: "Hoku Makani",
      gradeLevel: "4",
    });
    const sourceInspection = await t.query(adminCloneScholar.inspectSource, {
      sourceUserId: fixture.sourceUserId,
    });
    expect(sourceInspection?.copiedUserFields).toEqual({
      readingLevel: "R",
      preferredFont: "andika",
      ttsEnabled: false,
      sttEnabled: true,
    });

    const result = await t.mutation(adminCloneScholar.cloneScholar, {
      sourceUserId: fixture.sourceUserId,
      targetUsername: "demo-third-grader",
      targetName: "Piko Demo",
    });
    expect(result.targetUserId).not.toBeNull();
    const targetUserId = result.targetUserId!;
    const targetInspection = await t.query(adminCloneScholar.inspectSource, {
      sourceUserId: targetUserId,
    });
    expect(targetInspection?.counts).toEqual(sourceInspection?.counts);
    expect(result.counts).toEqual(sourceInspection?.counts);
    expect(result.mirroredGroups).toEqual(["Honu"]);
    expect(result.existedTarget).toBe(false);

    const cloned = await t.run(async (ctx) => {
      const observations = await ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", targetUserId))
        .collect();
      const overrides = await ctx.db
        .query("teacherMasteryOverrides")
        .withIndex("by_scholar", (q) => q.eq("scholarId", targetUserId))
        .collect();
      const seeds = await ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) =>
          q.eq("scholarId", targetUserId),
        )
        .collect();
      const goals = await ctx.db
        .query("scholarGoals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", targetUserId))
        .collect();
      const checkins = await ctx.db
        .query("goalCheckins")
        .withIndex("by_scholar", (q) => q.eq("scholarId", targetUserId))
        .collect();
      return {
        user: await ctx.db.get(targetUserId),
        observations,
        overrides,
        seeds,
        goals,
        checkins,
        group: await ctx.db.get(fixture.groupId),
      };
    });

    const first = cloned.observations.find(
      (observation) => observation.isSuperseded,
    )!;
    const second = cloned.observations.find(
      (observation) => !observation.isSuperseded,
    )!;
    expect(second.supersedesId).toBe(first._id);
    expect(second.supersedesId).not.toBe(fixture.firstObservationId);
    expect(first.sessionId).toBeUndefined();
    expect(first.excerptMessageIds).toBeUndefined();
    expect(cloned.overrides[0].observationId).toBe(second._id);
    expect(cloned.seeds[0].sessionId).toBeUndefined();
    expect(cloned.checkins[0].goalId).toBe(cloned.goals[0]._id);
    expect(cloned.group?.scholarIds).toContain(targetUserId);
    expect(cloned.group?.institutionId).toBe(cloned.user?.institutionId);
    expect(cloned.user).toMatchObject({
      username: "demo-third-grader",
      name: "Piko Demo",
      role: "scholar",
      gradeLevel: "3",
      readingLevel: "R",
      preferredFont: "andika",
      ttsEnabled: false,
      sttEnabled: true,
    });
    expect(cloned.user?.institutionId).toBeDefined();

    const generated = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: targetUserId,
        title: "Demo-day work",
        isArchived: false,
      });
      const analysisId = await ctx.db.insert("analyses", {
        sessionId,
        summary: "Demo analysis",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId: fixture.teacherId,
        title: "Demo Unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Demo Lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Demo Activity",
        kind: "online",
        order: 0,
      });
      const completionId = await ctx.db.insert("activityCompletions", {
        scholarId: targetUserId,
        activityId,
        lessonId,
        unitId,
        completedAt: Date.now(),
        sessionId,
      });
      const notificationPrefsId = await ctx.db.insert("notificationPrefs", {
        userId: targetUserId,
        emailEnabled: false,
      });
      const googleAccountId = await ctx.db.insert("googleAccounts", {
        userId: targetUserId,
        googleSub: "demo-google-sub",
        email: "demo@example.com",
        accessToken: "demo-access-token",
        expiresAt: Date.now() + 60_000,
        scopes: ["https://www.googleapis.com/auth/drive.file"],
        connectedAt: Date.now(),
      });
      const webauthnChallengeId = await ctx.db.insert("webauthnChallenges", {
        challenge: "demo-challenge",
        type: "registration",
        userId: targetUserId,
        expiresAt: Date.now() + 60_000,
      });
      const documentId = await ctx.db.insert("scholarDocuments", {
        scholarId: targetUserId,
        kind: "observation",
        title: "Demo document",
        uploadedBy: fixture.teacherId,
        processingStatus: "ready",
      });
      const documentAccessLogId = await ctx.db.insert("documentAccessLog", {
        documentId,
        scholarId: targetUserId,
        userId: targetUserId,
        action: "view_summary",
      });
      const chatId = await ctx.db.insert("chats", {
        teacherId: fixture.teacherId,
        title: "Demo-scoped teacher chat",
        scholarId: targetUserId,
        pinned: false,
        lastMessageAt: Date.now(),
      });
      const curriculumMessageId = await ctx.db.insert("curriculumMessages", {
        teacherId: fixture.teacherId,
        scholarId: targetUserId,
        chatId,
        role: "user",
        content: "Teacher-owned history about the demo scholar.",
      });
      const parentId = await ctx.db.insert("users", {
        name: "Demo Parent",
        username: "demo-parent-history",
        role: "parent",
      });
      const parentThreadId = await ctx.db.insert("parentThreads", {
        parentUserId: parentId,
        teacherId: fixture.teacherId,
        scholarId: targetUserId,
        lastMessageAt: Date.now(),
      });
      return {
        sessionId,
        analysisId,
        completionId,
        purgedRows: {
          notificationPrefs: notificationPrefsId,
          googleAccounts: googleAccountId,
          webauthnChallenges: webauthnChallengeId,
        },
        exemptRows: {
          documentAccessLog: documentAccessLogId,
          chats: chatId,
          curriculumMessages: curriculumMessageId,
          parentThreads: parentThreadId,
        },
      };
    });

    const purgeResult = await t.mutation(
      adminCloneScholar.purgeCloneScholar,
      {
        userId: targetUserId,
        confirmUsername: "demo-third-grader",
      },
    );
    expect(purgeResult.counts.sessions).toBe(1);
    expect(purgeResult.counts.analyses).toBe(1);
    expect(purgeResult.counts.activityCompletions).toBe(1);

    const afterPurge = await learningRowCounts(t, targetUserId);
    expect(Object.values(afterPurge).every((count) => count === 0)).toBe(true);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(targetUserId)).toBeNull();
      expect(await ctx.db.get(generated.sessionId)).toBeNull();
      expect(await ctx.db.get(generated.analysisId)).toBeNull();
      expect(await ctx.db.get(generated.completionId)).toBeNull();
      expect(Object.keys(generated.purgedRows).sort()).toEqual([
        "googleAccounts",
        "notificationPrefs",
        "webauthnChallenges",
      ]);
      for (const rowId of Object.values(generated.purgedRows)) {
        expect(await ctx.db.get(rowId)).toBeNull();
      }
      expect(Object.keys(generated.exemptRows).sort()).toEqual([
        "chats",
        "curriculumMessages",
        "documentAccessLog",
        "parentThreads",
      ]);
      for (const rowId of Object.values(generated.exemptRows)) {
        expect(await ctx.db.get(rowId)).not.toBeNull();
      }
      const group = await ctx.db.get(fixture.groupId);
      expect(group?.scholarIds).not.toContain(targetUserId);
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", targetUserId))
        .collect();
      expect(memberships).toHaveLength(0);
    });
  });

  test("skips a cross-institution group without failing the clone", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedRepresentativeSource(t);
    const otherInstitutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Kona School",
        slug: "kona",
        kind: "school",
      }),
    );
    const targetUserId = await seedUser(t, "scholar", {
      username: "kona-demo",
      name: "Kona Demo",
      institutionId: otherInstitutionId,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t.mutation(adminCloneScholar.cloneScholar, {
      sourceUserId: fixture.sourceUserId,
      targetUsername: "kona-demo",
      targetName: "Ignored Replacement Name",
    });

    expect(result.targetUserId).toBe(targetUserId);
    expect(result.mirroredGroups).toEqual([]);
    const group = await t.run((ctx) => ctx.db.get(fixture.groupId));
    expect(group?.scholarIds).not.toContain(targetUserId);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Skipping group "Honu".*different institution/,
      ),
    );
  });

  test("dry run reports counts and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedRepresentativeSource(t);
    const before = await t.run(async (ctx) => ({
      users: (await ctx.db.query("users").collect()).length,
      group: await ctx.db.get(fixture.groupId),
    }));

    const result = await t.mutation(adminCloneScholar.cloneScholar, {
      sourceUserId: fixture.sourceUserId,
      targetUsername: "dry-run-demo",
      targetName: "Dry Run Demo",
      dryRun: true,
    });

    expect(result.targetUserId).toBeNull();
    expect(result.existedTarget).toBe(false);
    expect(result.counts.practiceMastery).toBe(2);
    expect(result.mirroredGroups).toEqual(["Honu"]);
    await t.run(async (ctx) => {
      expect((await ctx.db.query("users").collect()).length).toBe(before.users);
      expect(
        await ctx.db
          .query("users")
          .withIndex("by_username", (q) => q.eq("username", "dry-run-demo"))
          .first(),
      ).toBeNull();
      expect(await ctx.db.get(fixture.groupId)).toEqual(before.group);
    });
  });

  test("attemptCap clones only the most recent attempts", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedRepresentativeSource(t);
    const result = await t.mutation(adminCloneScholar.cloneScholar, {
      sourceUserId: fixture.sourceUserId,
      targetUsername: "capped-demo",
      targetName: "Capped Demo",
      attemptCap: 2,
      mirrorGroups: false,
    });
    const targetUserId = result.targetUserId!;

    expect(result.counts.practiceAttempts).toBe(2);
    expect(result.existedTarget).toBe(false);
    const attempts = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) =>
          q.eq("scholarId", targetUserId),
        )
        .order("desc")
        .collect(),
    );
    expect(attempts.map((attempt) => attempt.createdAt)).toEqual([3_000, 2_000]);
    const group = await t.run((ctx) => ctx.db.get(fixture.groupId));
    expect(group?.scholarIds).not.toContain(targetUserId);
  });

  test("clones into an existing empty scholar and reports the reused target", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedRepresentativeSource(t);
    const targetUserId = await seedUser(t, "scholar", {
      username: "precreated-demo",
      name: "Precreated Demo",
      gradeLevel: "5",
      readingLevel: "A",
      preferredFont: "opendyslexic",
      ttsEnabled: true,
      sttEnabled: false,
    });
    const defaultAppId = await t.run((ctx) =>
      ctx.db.insert("externalApps", {
        name: "Default Test App",
        webUrl: "https://example.com",
        defaultForNewScholars: true,
      }),
    );

    const result = await t.mutation(adminCloneScholar.cloneScholar, {
      sourceUserId: fixture.sourceUserId,
      targetUsername: "precreated-demo",
      targetName: "Ignored Replacement Name",
      gradeLevel: "3",
    });

    expect(result.targetUserId).toBe(targetUserId);
    expect(result.existedTarget).toBe(true);
    expect(await learningRowCounts(t, targetUserId)).toEqual(
      await learningRowCounts(t, fixture.sourceUserId),
    );
    const target = await t.run((ctx) => ctx.db.get(targetUserId));
    expect(target).toMatchObject({
      name: "Precreated Demo",
      gradeLevel: "3",
      readingLevel: "R",
      preferredFont: "andika",
      ttsEnabled: false,
      sttEnabled: true,
    });
    expect(target?.institutionId).toBeDefined();
    const defaults = await t.run(async (ctx) => ({
      memberships: await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", targetUserId))
        .collect(),
      scholarApps: await ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) =>
          q.eq("scholarId", targetUserId).eq("appId", defaultAppId),
        )
        .collect(),
    }));
    expect(defaults.memberships).toHaveLength(1);
    expect(defaults.scholarApps).toHaveLength(1);
  });

  test("refuses to clone into an existing scholar with learning data", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedRepresentativeSource(t);
    const targetUserId = await seedUser(t, "scholar", {
      username: "occupied-demo",
      name: "Occupied Demo",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: targetUserId,
        skillKey: "fractions:add-like-denominators",
        domain: "fraction-arithmetic",
        repetition: 1,
        halfLifeDays: 1,
        frontier: true,
        source: "practice",
        updatedAt: Date.now(),
      });
    });

    await expect(
      t.mutation(adminCloneScholar.cloneScholar, {
        sourceUserId: fixture.sourceUserId,
        targetUsername: "occupied-demo",
        targetName: "Occupied Demo",
      }),
    ).rejects.toThrow(/practiceMastery \(1\)/);
  });

  test("purge refuses a scholar with a guardianship", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedRepresentativeSource(t);
    const result = await t.mutation(adminCloneScholar.cloneScholar, {
      sourceUserId: fixture.sourceUserId,
      targetUsername: "guarded-demo",
      targetName: "Guarded Demo",
    });
    const targetUserId = result.targetUserId!;
    const parentId = await seedUser(t, "parent", {
      username: "demo-parent",
      name: "Demo Parent",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: targetUserId,
        createdBy: fixture.teacherId,
      });
    });

    await expect(
      t.mutation(adminCloneScholar.purgeCloneScholar, {
        userId: targetUserId,
        confirmUsername: "guarded-demo",
      }),
    ).rejects.toThrow(/guardianship/);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(targetUserId)).not.toBeNull();
    });
  });
});

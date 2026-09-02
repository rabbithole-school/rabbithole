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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const name = overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`);
  const username = overrides.username ?? (role === "scholar" ? "testscholar" : `test${role}`);
  if (role === "platform_admin") {
    return t.run((ctx) => ctx.db.insert("users", { name, username, role }));
  }
  const institutionId = await seedTestInstitution(t);
  const userId = role === "scholar"
    ? await seedScholarInInstitution(t, { institutionId, name, username })
    : await seedStaffWithMembership(t, { institutionId, name, username });
  await t.run((ctx) => ctx.db.patch(userId, {
    readingLevel: overrides.readingLevel,
    image: overrides.image,
  }));
  return userId;
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
) {
  return await t.run(async (ctx) => {
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
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function createTestDrive(
  asTeacher: Awaited<ReturnType<typeof withUser>>,
  activityId: Id<"activities">,
) {
  const result = await asTeacher.mutation(api.sessions.create, {
    activityId,
    isTestDrive: true,
  });
  return result.id;
}

describe("Test Drive — View as picker", () => {
  test("setTestDriveViewAs(self) clears any previous view-as fields", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await createTestDrive(asTeacher, activityId);

    // Set a synthetic profile, then clear via mode "self".
    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId,
      mode: "synthetic",
      syntheticName: "Maile",
      syntheticReadingLevel: "1st",
      syntheticDossier: "Loves sharks",
    });
    let session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session!.testDriveSyntheticName).toBe("Maile");

    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId,
      mode: "self",
    });
    session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session!.testDriveSyntheticName).toBeUndefined();
    expect(session!.testDriveSyntheticReadingLevel).toBeUndefined();
    expect(session!.testDriveSyntheticDossier).toBeUndefined();
    expect(session!.testDriveAsScholarId).toBeUndefined();
  });

  test("setTestDriveViewAs(real) sets the scholar id and clears synthetic fields", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", {
      name: "Kai",
      readingLevel: "3.5",
    });
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await createTestDrive(asTeacher, activityId);

    // Pre-set synthetic, then switch to real.
    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId,
      mode: "synthetic",
      syntheticName: "Maile",
    });
    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId,
      mode: "real",
      realScholarId: scholarId,
    });

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session!.testDriveAsScholarId).toBe(scholarId);
    expect(session!.testDriveSyntheticName).toBeUndefined();
  });

  test("setTestDriveViewAs(real) rejects a non-scholar target", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const otherTeacherId = await seedUser(t, "teacher", {
      username: "otherteacher",
    });
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await createTestDrive(asTeacher, activityId);

    await expect(
      asTeacher.mutation(api.sessions.setTestDriveViewAs, {
        sessionId,
        mode: "real",
        realScholarId: otherTeacherId,
      }),
    ).rejects.toThrow();
  });

  test("setTestDriveViewAs(synthetic) requires at least one field", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await createTestDrive(asTeacher, activityId);

    await expect(
      asTeacher.mutation(api.sessions.setTestDriveViewAs, {
        sessionId,
        mode: "synthetic",
      }),
    ).rejects.toThrow();
  });

  test("setTestDriveViewAs is rejected on a non-test-drive project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.sessions.create, {
      activityId,
    });

    await expect(
      asTeacher.mutation(api.sessions.setTestDriveViewAs, {
        sessionId: result.id,
        mode: "self",
      }),
    ).rejects.toThrow();
  });

  test("setTestDriveViewAs is rejected when caller doesn't own the test drive", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher");
    const teacherB = await seedUser(t, "teacher", { username: "teacherb" });
    const { activityId } = await seedUnitWithActivity(t, teacherA);
    const asA = await withUser(t, teacherA);
    const asB = await withUser(t, teacherB);

    const sessionId = await createTestDrive(asA, activityId);

    await expect(
      asB.mutation(api.sessions.setTestDriveViewAs, {
        sessionId,
        mode: "self",
      }),
    ).rejects.toThrow();
  });
});

describe("Test Drive — View as flows through getSessionContext", () => {
  async function getCtx(
    t: ReturnType<typeof convexTest>,
    sessionId: Id<"sessions">,
  ) {
    return await t.run(async (ctx) => {
      return await ctx.runQuery(internal.sessionHelpers.getSessionContext, {
        sessionId,
      });
    });
  }

  test("real scholar view-as: dossier + reading level + name come from the target scholar", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", {
      name: "Kai",
      readingLevel: "3.5",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarDossiers", {
        scholarId,
        content: "Loves marine biology, struggles with writing.",
      });
    });
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await createTestDrive(asTeacher, activityId);

    // Baseline: no view-as → teacher sees their own (empty) dossier.
    let ctxData = await getCtx(t, sessionId);
    expect(ctxData!.dossierContent).toBeNull();

    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId,
      mode: "real",
      realScholarId: scholarId,
    });

    ctxData = await getCtx(t, sessionId);
    expect(ctxData!.dossierContent).toBe(
      "Loves marine biology, struggles with writing.",
    );
    expect(ctxData!.readingLevel).toBe("3.5");
    expect(ctxData!.scholarName).toBe("Kai");
    // scholarId stays the project owner — observer/dossier writes are gated
    // on isTestDrive anyway, so we don't pretend to be the scholar at the
    // identity level.
    expect(ctxData!.scholarId).toBe(teacherId);
    expect(ctxData!.isTestDrive).toBe(true);
  });

  test("synthetic view-as: dossier + reading level + name come from project fields", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await createTestDrive(asTeacher, activityId);

    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId,
      mode: "synthetic",
      syntheticName: "Maile",
      syntheticReadingLevel: "1st grade",
      syntheticDossier: "Early reader, hates writing.",
    });

    const ctxData = await getCtx(t, sessionId);
    expect(ctxData!.scholarName).toBe("Maile");
    expect(ctxData!.readingLevel).toBe("1st grade");
    expect(ctxData!.dossierContent).toBe("Early reader, hates writing.");
    // No mastery / signals / seeds in synthetic mode.
    expect(ctxData!.masteryContext).toBeNull();
    expect(ctxData!.signalContext).toBeNull();
    expect(ctxData!.seeds).toEqual([]);
    expect(ctxData!.teacherDirectives).toEqual([]);
  });

  test("synthetic view-as: mastery written for the teacher is NOT pulled in", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const sessionId = await createTestDrive(asTeacher, activityId);
    // Slip a mastery row keyed to the teacher's id — synthetic should
    // ignore all scholar-keyed lookups regardless of who's at that key.
    await t.run(async (ctx) => {
      await ctx.db.insert("masteryObservations", {
        scholarId: teacherId,
        conceptLabel: "Phantom concept",
        domain: "math",
        observedAt: Date.now(),
        sessionId,
        transcriptExcerpt: "n/a",
        masteryLevel: 3,
        confidenceScore: 1,
        evidenceSummary: "n/a",
        evidenceType: "explanation",
        attemptContext: "n/a",
        studentInitiated: false,
        isSuperseded: false,
      });
    });

    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId,
      mode: "synthetic",
      syntheticDossier: "Early reader",
    });

    const ctxData = await getCtx(t, sessionId);
    expect(ctxData!.masteryContext).toBeNull();
  });
});

describe("Test Drive — Reset", () => {
  test("resetTestDrive archives the old project and creates a new one with the same activity + view-as", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Kai" });
    const { activityId, unitId, lessonId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const oldId = await createTestDrive(asTeacher, activityId);

    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId: oldId,
      mode: "real",
      realScholarId: scholarId,
    });

    const { id: newId } = await asTeacher.mutation(
      api.sessions.resetTestDrive,
      { sessionId: oldId },
    );
    expect(newId).not.toBe(oldId);

    const oldP = await t.run(async (ctx) => ctx.db.get(oldId));
    const newP = await t.run(async (ctx) => ctx.db.get(newId));
    expect(oldP!.isArchived).toBe(true);
    expect(newP!.isArchived).toBe(false);
    expect(newP!.isTestDrive).toBe(true);
    expect(newP!.userId).toBe(teacherId);
    expect(newP!.activityId).toBe(activityId);
    expect(newP!.lessonId).toBe(lessonId);
    expect(newP!.unitId).toBe(unitId);
    expect(newP!.testDriveAsScholarId).toBe(scholarId);
  });

  test("resetTestDrive preserves a synthetic profile across the reset", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const oldId = await createTestDrive(asTeacher, activityId);

    await asTeacher.mutation(api.sessions.setTestDriveViewAs, {
      sessionId: oldId,
      mode: "synthetic",
      syntheticName: "Maile",
      syntheticReadingLevel: "1st",
      syntheticDossier: "Early reader",
    });

    const { id: newId } = await asTeacher.mutation(
      api.sessions.resetTestDrive,
      { sessionId: oldId },
    );
    const newP = await t.run(async (ctx) => ctx.db.get(newId));
    expect(newP!.testDriveSyntheticName).toBe("Maile");
    expect(newP!.testDriveSyntheticReadingLevel).toBe("1st");
    expect(newP!.testDriveSyntheticDossier).toBe("Early reader");
    expect(newP!.testDriveAsScholarId).toBeUndefined();
  });

  test("resetTestDrive is rejected on a non-test-drive project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const { id } = await asScholar.mutation(api.sessions.create, {
      activityId,
    });

    await expect(
      asTeacher.mutation(api.sessions.resetTestDrive, { sessionId: id }),
    ).rejects.toThrow();
  });

  test("resetTestDrive is rejected when caller doesn't own the test drive", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher");
    const teacherB = await seedUser(t, "teacher", { username: "teacherb" });
    const { activityId } = await seedUnitWithActivity(t, teacherA);
    const asA = await withUser(t, teacherA);
    const asB = await withUser(t, teacherB);
    const id = await createTestDrive(asA, activityId);

    await expect(
      asB.mutation(api.sessions.resetTestDrive, { sessionId: id }),
    ).rejects.toThrow();
  });
});

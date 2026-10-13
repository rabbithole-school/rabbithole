import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type WorldSchool } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// TRA-494: the prod service account agents use for reads is a `teacher`, so
// every teacher write used to accept it. `users.readOnly` makes it read-only
// in code: queries still work, every authenticated write refuses it.

const READ_ONLY = /This account is read-only/;

async function seedSchoolWithLevel(t: ReturnType<typeof convexTest>) {
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school: WorldSchool = world.schools[0];
  const scholarId = school.scholars[0].id;
  await t.run((ctx) =>
    ctx.db.patch(scholarId, { readingLevel: "3" }),
  );
  return { world, school, scholarId };
}

async function markReadOnly(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  readOnly: boolean,
) {
  await t.run((ctx) =>
    ctx.runMutation(internal.users.setReadOnly, { userId, readOnly }),
  );
}

describe("read-only identity (users.readOnly)", () => {
  test("a read-only teacher can run a teacherQuery but a teacherMutation refuses it", async () => {
    const t = convexTest(schema, modules);
    const { world, school, scholarId } = await seedSchoolWithLevel(t);
    await markReadOnly(t, school.teacher.id, true);
    const asTeacher = await world.as.staffOf(school);

    // Reads keep working.
    const history = await asTeacher.query(api.scholars.getReadingLevelHistory, {
      scholarId,
    });
    expect(history).toEqual([]);

    // The exact write from the 2026-08-22 incident now refuses, loudly.
    await expect(
      asTeacher.mutation(api.scholars.updateReadingLevel, { scholarId, readingLevel: "4" }),
    ).rejects.toThrow(READ_ONLY);

    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar?.readingLevel).toBe("3");
    const rows = await t.run((ctx) => ctx.db.query("readingLevelHistory").collect());
    expect(rows).toHaveLength(0);
  });

  test("a normal teacher is unaffected", async () => {
    const t = convexTest(schema, modules);
    const { world, school, scholarId } = await seedSchoolWithLevel(t);
    const asTeacher = await world.as.staffOf(school);

    await asTeacher.mutation(api.scholars.updateReadingLevel, { scholarId, readingLevel: "4" });

    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar?.readingLevel).toBe("4");
  });

  test("clearing the flag restores writes", async () => {
    const t = convexTest(schema, modules);
    const { world, school, scholarId } = await seedSchoolWithLevel(t);
    await markReadOnly(t, school.teacher.id, true);
    await markReadOnly(t, school.teacher.id, false);
    const asTeacher = await world.as.staffOf(school);

    await asTeacher.mutation(api.scholars.updateReadingLevel, { scholarId, readingLevel: "4" });

    const teacher = await t.run((ctx) => ctx.db.get(school.teacher.id));
    expect(teacher?.readOnly).toBeUndefined();
    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar?.readingLevel).toBe("4");
  });

  test("raw authenticated mutations refuse it too", async () => {
    const t = convexTest(schema, modules);
    const { world, school } = await seedSchoolWithLevel(t);
    await markReadOnly(t, school.teacher.id, true);
    const asTeacher = await world.as.staffOf(school);

    await expect(asTeacher.mutation(api.files.generateUploadUrl, {})).rejects.toThrow(
      READ_ONLY,
    );
    // Bug reports have their own wrapper (open during view-as, not here).
    await expect(
      asTeacher.mutation(api.bugReports.submit, {
        surface: "web",
        url: "https://example.com/teacher",
        description: "fixture report",
      }),
    ).rejects.toThrow(READ_ONLY);
    const reports = await t.run((ctx) => ctx.db.query("bugReports").collect());
    expect(reports).toHaveLength(0);
  });

  test("a writing action refuses it before doing any work", async () => {
    const t = convexTest(schema, modules);
    const { world, school, scholarId } = await seedSchoolWithLevel(t);
    await markReadOnly(t, school.teacher.id, true);
    const asTeacher = await world.as.staffOf(school);

    // Raw action with its own role check.
    await expect(
      asTeacher.action(api.readingLevelAnalysis.analyzeReadingLevelAI, { scholarId }),
    ).rejects.toThrow(READ_ONLY);
    // The account cannot rotate its own credentials either.
    await expect(
      asTeacher.action(api.accountPassword.setMyPassword, {
        newPassword: "fixture-password-123",
      }),
    ).rejects.toThrow(READ_ONLY);
    await expect(asTeacher.action(api.passkeys.startEnrollment, {})).rejects.toThrow(
      READ_ONLY,
    );
    // Action gated by a central action auth helper (requireStaffAction).
    await expect(
      asTeacher.action(api.googleAccountsActions.disconnect, {}),
    ).rejects.toThrow(READ_ONLY);
  });
});

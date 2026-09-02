import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Assignment rosters are FACTUAL cohort membership: the aide reads never
 * filter them by enrollment standing. Instead, Extended Education
 * (program-guest) members are ANNOTATED with `extendedEducation: true`
 * (lib/scholarParticipationTooling.extendedEducationTag), while enrolled
 * entries stay byte-identical to before (no key at all). These tests pin
 * both halves for every aide roster read: aideListAssignments,
 * aideGetAssignment, aideAssignmentProgress, and granuleEvidence.aideCoverage.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/** Read the tag through an `in` narrow — roster entries are a union type
 *  (tagged guest arm | untagged enrolled arm), so direct access won't compile. */
function eeTag(entry: object): unknown {
  return "extendedEducation" in entry ? entry.extendedEducation : undefined;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  username: string,
  name?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: name ?? `Test ${username}`, username, role }),
  );
}

async function setEnrollmentStanding(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  enrollmentStanding: "enrolled" | "program_guest",
) {
  await t.run((ctx) => ctx.db.patch(userId, { enrollmentStanding }));
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
      // Granules so aideCoverage has a grid to report.
      essentialQuestions: [{ key: "eq:r1", text: "What makes a robot move?" }],
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
      systemPrompt: "...",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  unitId: Id<"units">,
  scholarIds: Id<"users">[],
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      startedAt: Date.now(),
      activitySchedule: [],
    }),
  );
}

/** One teacher, one mixed cohort: an enrolled scholar + a program guest. */
async function seedMixedCohort(t: ReturnType<typeof convexTest>) {
  const teacher = await seedUser(t, "teacher", "testteacher");
  const enrolled = await seedUser(t, "scholar", "kai", "Kai Kahale");
  const guest = await seedUser(t, "scholar", "hoku", "Hoku Makani");
  await setEnrollmentStanding(t, guest, "program_guest");
  const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
  const assignmentId = await seedAssignment(t, teacher, unitId, [
    enrolled,
    guest,
  ]);
  return { teacher, enrolled, guest, unitId, activityId, assignmentId };
}

describe("aide rosters annotate Extended Education members (never filter)", () => {
  test("aideListAssignments: guest tagged, enrolled entry unchanged, roster complete", async () => {
    const t = convexTest(schema, modules);
    const { teacher, enrolled, guest } = await seedMixedCohort(t);

    const rows = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideListAssignments, {
        callerUserId: teacher,
      }),
    );
    expect(rows).toHaveLength(1);
    const roster = rows[0].roster;
    // Factual membership — the guest is NOT filtered out.
    expect(roster).toHaveLength(2);
    const guestEntry = roster.find((r) => r.id === guest)!;
    const enrolledEntry = roster.find((r) => r.id === enrolled)!;
    expect(eeTag(guestEntry)).toBe(true);
    // Enrolled entries stay byte-identical: no extendedEducation key at all.
    expect("extendedEducation" in enrolledEntry).toBe(false);
    expect(enrolledEntry).toEqual({ id: enrolled, name: "Kai Kahale" });
  });

  test("aideGetAssignment: roster carries the tag on guests only", async () => {
    const t = convexTest(schema, modules);
    const { teacher, enrolled, guest, assignmentId } = await seedMixedCohort(t);

    const got = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideGetAssignment, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    expect(got).not.toBeNull();
    expect(got!.roster).toHaveLength(2);
    const guestEntry = got!.roster.find((r) => r.id === guest)!;
    const enrolledEntry = got!.roster.find((r) => r.id === enrolled)!;
    expect(eeTag(guestEntry)).toBe(true);
    expect("extendedEducation" in enrolledEntry).toBe(false);
  });

  test("aideAssignmentProgress: roster entries tagged, guest still counted", async () => {
    const t = convexTest(schema, modules);
    const { teacher, enrolled, guest, assignmentId } = await seedMixedCohort(t);

    const data = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideAssignmentProgress, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    expect(data).not.toBeNull();
    expect(data!.rosterSize).toBe(2);
    expect(data!.roster).toHaveLength(2);
    const guestEntry = data!.roster.find((r) => r.scholarId === guest)!;
    const enrolledEntry = data!.roster.find((r) => r.scholarId === enrolled)!;
    expect(eeTag(guestEntry)).toBe(true);
    expect("extendedEducation" in enrolledEntry).toBe(false);
    // The guest counts in the not-started roll-up like any cohort member.
    expect(data!.notStartedScholarNames).toContain("Hoku Makani");
  });

  test("granuleEvidence.aideCoverage: scholars[] tagged, guest row complete", async () => {
    const t = convexTest(schema, modules);
    const { teacher, guest, assignmentId } = await seedMixedCohort(t);

    const data = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleEvidence.aideCoverage, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    expect(data).not.toBeNull();
    expect(data!.scholars).toHaveLength(2);
    const guestRow = data!.scholars.find((s) => s.name === "Hoku Makani")!;
    const enrolledRow = data!.scholars.find((s) => s.name === "Kai Kahale")!;
    expect(eeTag(guestRow)).toBe(true);
    // The guest still gets a full status row — annotated, not degraded.
    expect(guestRow.statuses).toHaveLength(1);
    expect("extendedEducation" in enrolledRow).toBe(false);
    void guest;
  });

  test("all-enrolled roster output has no extendedEducation key anywhere", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "testteacher");
    // One explicit "enrolled", one legacy row with the field absent — both
    // are enrolled and both must stay untagged.
    const explicit = await seedUser(t, "scholar", "lani", "Lani Kahale");
    await setEnrollmentStanding(t, explicit, "enrolled");
    const legacy = await seedUser(t, "scholar", "oliver", "Oliver Stone");
    const { unitId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [
      explicit,
      legacy,
    ]);

    const rows = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideListAssignments, {
        callerUserId: teacher,
      }),
    );
    for (const entry of rows[0].roster) {
      expect("extendedEducation" in entry).toBe(false);
    }

    const progress = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideAssignmentProgress, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    for (const entry of progress!.roster) {
      expect("extendedEducation" in entry).toBe(false);
    }

    const coverage = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleEvidence.aideCoverage, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    for (const row of coverage!.scholars) {
      expect("extendedEducation" in row).toBe(false);
    }
  });
});

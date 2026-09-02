import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (import.meta as ImportMeta & {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.ts");
const mathPlans = (api as any).mathPlans;

async function identity(t: ReturnType<typeof convexTest>, userId: any) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

describe("Math plans", () => {
  test("myPlan permits self and same-institution staff, but rejects inaccessible scholars", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const otherInstitutionId = await seedTestInstitution(t, {
      slug: "other-fixture-school",
    });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "math-plan-scholar",
    });
    const sameSchoolTeacherId = await seedStaffWithMembership(t, {
      institutionId,
      username: "same-school-teacher",
    });
    const noAccessTeacherId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "No access teacher",
        username: "no-access-teacher",
        role: "teacher",
      }),
    );
    const otherSchoolTeacherId = await seedStaffWithMembership(t, {
      institutionId: otherInstitutionId,
      username: "other-school-teacher",
    });

    const asScholar = await identity(t, scholarId);
    expect(await asScholar.query(mathPlans.myPlan, {})).toEqual(
      await asScholar.query(mathPlans.myPlan, { scholarId }),
    );

    const asSameSchoolTeacher = await identity(t, sameSchoolTeacherId);
    expect(await asSameSchoolTeacher.query(mathPlans.myPlan, { scholarId })).toMatchObject({
      scopeSource: "open_default",
    });

    const asNoAccessTeacher = await identity(t, noAccessTeacherId);
    await expect(asNoAccessTeacher.query(mathPlans.myPlan, { scholarId })).rejects.toThrow(
      "Forbidden: scholar is not in your current context",
    );

    const asOtherSchoolTeacher = await identity(t, otherSchoolTeacherId);
    await expect(asOtherSchoolTeacher.query(mathPlans.myPlan, { scholarId })).rejects.toThrow(
      "Forbidden: scholar is not in your current context",
    );
  });

  test("an explicit open plan overrides a legacy standing scope and suppresses a group checkpoint", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, { institutionId, name: "Teacher", username: "teacher" });
    const scholarId = await seedScholarInInstitution(t, { institutionId, name: "Scholar", username: "scholar" });
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", { nodeKey: "fraction_compare", label: "Compare", domain: "fraction_arithmetic", strand: "comparison", grade: "4" });
      await ctx.db.insert("assignments", {
        teacherId, scholarIds: [scholarId], practiceMode: "standing",
        practiceConfig: { domain: "fraction_arithmetic" }, startedAt: 1, activitySchedule: [],
      });
      const groupId = await ctx.db.insert("scholarGroups", { teacherId, name: "Math", scholarIds: [scholarId] });
      await ctx.db.insert("mathGroupCheckpoint", { groupId, domain: "fraction_arithmetic", strand: "comparison", grade: "4", updatedBy: teacherId, updatedAt: 1 });
    });
    const asTeacher = await identity(t, teacherId);
    expect(await asTeacher.query(mathPlans.forScholars, { scholarIds: [scholarId] })).toMatchObject([
      { scopeSource: "legacy_standing" },
    ]);
    await asTeacher.mutation(mathPlans.saveForScholar, {
      scholarId, practiceScope: { kind: "open" }, checkpoint: null,
    });
    expect(await asTeacher.query(mathPlans.forScholars, { scholarIds: [scholarId] })).toMatchObject([
      {
        practiceScope: { kind: "open" },
        scopeSource: "math_plan",
        checkpoint: null,
      },
    ]);
  });
});

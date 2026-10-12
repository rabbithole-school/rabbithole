import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { INTERIM_FLAG_KEYS, INTERIM_ITEM_KEYS } from "../lib/interimCheckinTemplate";

/**
 * Interim check-ins: one per scholar × reporting period (open is idempotent),
 * writes are limited to the template's own keys, and a teacher at another
 * school can neither read nor write a scholar's check-in.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 24 * 3_600_000;

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedWorld(t: ReturnType<typeof convexTest>) {
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
  const scholarId = await seedScholarInInstitution(t, { institutionId, name: "S", username: "s" });
  const otherInstitutionId = await seedTestInstitution(t, { name: "Other School", slug: "other-school" });
  const foreignTeacherId = await seedStaffWithMembership(t, {
    institutionId: otherInstitutionId,
    name: "F",
    username: "f",
  });
  const { periodId, nextPeriodId } = await t.run(async (ctx) => {
    const now = Date.now();
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall", startsAt: now - 10 * DAY, endsAt: now + 10 * DAY, status: "writing",
    });
    const nextPeriodId = await ctx.db.insert("reportingPeriods", {
      label: "Spring", startsAt: now + 20 * DAY, endsAt: now + 60 * DAY, status: "upcoming",
    });
    return { periodId, nextPeriodId };
  });
  const opsStaffId = await seedStaffWithMembership(t, {
    institutionId,
    name: "O",
    username: "o",
    role: "staff",
  });
  const foreignPeriodId = await t.run(async (ctx) => {
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: opsStaffId,
      institutionId,
      capability: "school:operations",
      grantedBy: teacherId,
      grantedAt: Date.now(),
    });
    const now = Date.now();
    return await ctx.db.insert("reportingPeriods", {
      label: "Other school's term",
      startsAt: now - 10 * DAY,
      endsAt: now + 10 * DAY,
      status: "writing",
      institutionId: otherInstitutionId,
    });
  });
  return { teacherId, scholarId, foreignTeacherId, opsStaffId, periodId, nextPeriodId, foreignPeriodId };
}

describe("interimCheckins", () => {
  test("open is once per scholar per term", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);

    const first = await asStaff.mutation(api.interimCheckins.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });
    const again = await asStaff.mutation(api.interimCheckins.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });
    expect(again).toBe(first);

    const nextTerm = await asStaff.mutation(api.interimCheckins.open, {
      scholarId: w.scholarId, periodId: w.nextPeriodId,
    });
    expect(nextTerm).not.toBe(first);

    const rows = await t.run((ctx) => ctx.db.query("interimCheckins").collect());
    expect(rows).toHaveLength(2);
  });

  test("ratings, flags and comments round-trip; unknown keys are refused", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    const checkinId = await asStaff.mutation(api.interimCheckins.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });
    const [itemA, itemB] = INTERIM_ITEM_KEYS;
    const flag = INTERIM_FLAG_KEYS[0];

    await asStaff.mutation(api.interimCheckins.setRating, { checkinId, itemKey: itemA, rating: "usually" });
    await asStaff.mutation(api.interimCheckins.setRating, { checkinId, itemKey: itemB, rating: "developing" });
    await asStaff.mutation(api.interimCheckins.setRating, { checkinId, itemKey: itemB });
    await asStaff.mutation(api.interimCheckins.setFlag, { checkinId, flagKey: flag, on: true });
    await asStaff.mutation(api.interimCheckins.setFlag, { checkinId, flagKey: flag, on: true });
    await asStaff.mutation(api.interimCheckins.saveComment, {
      checkinId, field: "strengths", body: "Loves a hard puzzle.",
    });

    const row = await asStaff.query(api.interimCheckins.getForScholarPeriod, {
      scholarId: w.scholarId, periodId: w.periodId,
    });
    expect(row?.ratings).toEqual({ [itemA]: "usually" });
    expect(row?.flags).toEqual([flag]);
    expect(row?.comments.strengths).toBe("Loves a hard puzzle.");
    expect(row?.teacherName).toBe("T");

    await expect(
      asStaff.mutation(api.interimCheckins.setRating, { checkinId, itemKey: "math.madeUp", rating: "usually" }),
    ).rejects.toThrow(/Unknown check-in item/);
    await expect(
      asStaff.mutation(api.interimCheckins.setFlag, { checkinId, flagKey: itemA, on: true }),
    ).rejects.toThrow(/Unknown check-in flag/);
  });

  test("setDone stamps completedAt and reopening clears it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    const checkinId = await asStaff.mutation(api.interimCheckins.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });

    await asStaff.mutation(api.interimCheckins.setDone, { checkinId, done: true });
    let row = await t.run((ctx) => ctx.db.get(checkinId));
    expect(row?.status).toBe("final");
    expect(row?.completedAt).toBeTypeOf("number");

    await asStaff.mutation(api.interimCheckins.setDone, { checkinId, done: false });
    row = await t.run((ctx) => ctx.db.get(checkinId));
    expect(row?.status).toBe("draft");
    expect(row?.completedAt).toBeUndefined();
  });

  test("a teacher at another school can't read, list or write the check-in", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    const asForeign = await withUser(t, w.foreignTeacherId);
    const checkinId = await asStaff.mutation(api.interimCheckins.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });

    await expect(
      asForeign.query(api.interimCheckins.getForScholarPeriod, {
        scholarId: w.scholarId, periodId: w.periodId,
      }),
    ).rejects.toThrow();
    await expect(
      asForeign.mutation(api.interimCheckins.open, { scholarId: w.scholarId, periodId: w.periodId }),
    ).rejects.toThrow();
    await expect(
      asForeign.mutation(api.interimCheckins.setRating, {
        checkinId, itemKey: INTERIM_ITEM_KEYS[0], rating: "usually",
      }),
    ).rejects.toThrow();

    expect(await asStaff.query(api.interimCheckins.listForPeriod, { periodId: w.periodId })).toHaveLength(1);
    expect(await asForeign.query(api.interimCheckins.listForPeriod, { periodId: w.periodId })).toHaveLength(0);
  });

  test("operations-only staff are refused: it is a teacher assessment", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asOps = await withUser(t, w.opsStaffId);
    await expect(
      asOps.mutation(api.interimCheckins.open, { scholarId: w.scholarId, periodId: w.periodId }),
    ).rejects.toThrow();
    await expect(
      asOps.query(api.interimCheckins.getForScholarPeriod, {
        scholarId: w.scholarId, periodId: w.periodId,
      }),
    ).rejects.toThrow();
  });

  test("a check-in can't be opened in another school's reporting period", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    await expect(
      asStaff.mutation(api.interimCheckins.open, { scholarId: w.scholarId, periodId: w.foreignPeriodId }),
    ).rejects.toThrow(/different school/);
  });

  test("a period with a check-in can't be deleted", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    await asStaff.mutation(api.interimCheckins.open, { scholarId: w.scholarId, periodId: w.periodId });
    await expect(
      asStaff.mutation(api.reportingPeriods.remove, { periodId: w.periodId }),
    ).rejects.toThrow(/interim check-ins/);
  });
});

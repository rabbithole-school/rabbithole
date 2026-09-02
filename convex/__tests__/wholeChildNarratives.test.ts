import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";

/**
 * The whole-child report's two lifecycle axes — completion (draft ↔ final via
 * setDone) and sharing (shared + sharedAt) — kept correctly decoupled. Guards
 * two regressions the composer rework could reintroduce:
 *   1. `markTeamAgreed` is a consensus STAMP only; it must never move `status`
 *      (so it can't downgrade an already-shared report out of the parent portal).
 *   2. `share` must stamp `sharedAt` (the portal renders/sorts by it) and only
 *      fire once the report is done.
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
  return await t.run(async (ctx) => {
    const now = Date.now();
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Now", startsAt: now - 10 * DAY, endsAt: now + 10 * DAY, status: "writing",
    });
    return { teacherId, scholarId, periodId };
  });
}

describe("wholeChildNarratives — done/shared lifecycle", () => {
  test("share() stamps sharedAt and marks status shared (once done)", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    const narrativeId = await asStaff.mutation(api.wholeChildNarratives.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });

    await asStaff.mutation(api.wholeChildNarratives.setDone, { narrativeId, done: true });
    const before = Date.now();
    await asStaff.mutation(api.wholeChildNarratives.share, { narrativeId });

    const n = await t.run(async (ctx) => ctx.db.get(narrativeId));
    expect(n!.status).toBe("shared");
    expect(typeof n!.sharedAt).toBe("number");
    expect(n!.sharedAt!).toBeGreaterThanOrEqual(before);
  });

  test("share() refuses a report that isn't done yet", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    const narrativeId = await asStaff.mutation(api.wholeChildNarratives.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });
    await expect(
      asStaff.mutation(api.wholeChildNarratives.share, { narrativeId }),
    ).rejects.toThrow(/done/i);
  });

  test("markTeamAgreed() never downgrades a shared report (only stamps teamAgreedAt)", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    const narrativeId = await asStaff.mutation(api.wholeChildNarratives.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });
    await asStaff.mutation(api.wholeChildNarratives.setDone, { narrativeId, done: true });
    await asStaff.mutation(api.wholeChildNarratives.share, { narrativeId });

    await asStaff.mutation(api.wholeChildNarratives.markTeamAgreed, { narrativeId });

    const n = await t.run(async (ctx) => ctx.db.get(narrativeId));
    // Still shared (not knocked back to "teamReview"), and the consensus stamp landed.
    expect(n!.status).toBe("shared");
    expect(typeof n!.teamAgreedAt).toBe("number");
  });

  test("setDone(false) reopens a done report to draft, but is a no-op once shared", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asStaff = await withUser(t, w.teacherId);
    const narrativeId = await asStaff.mutation(api.wholeChildNarratives.open, {
      scholarId: w.scholarId, periodId: w.periodId,
    });
    await asStaff.mutation(api.wholeChildNarratives.setDone, { narrativeId, done: true });
    await asStaff.mutation(api.wholeChildNarratives.setDone, { narrativeId, done: false });
    let n = await t.run(async (ctx) => ctx.db.get(narrativeId));
    expect(n!.status).toBe("draft");

    // Share, then a stray setDone(false) must NOT un-share.
    await asStaff.mutation(api.wholeChildNarratives.setDone, { narrativeId, done: true });
    await asStaff.mutation(api.wholeChildNarratives.share, { narrativeId });
    await asStaff.mutation(api.wholeChildNarratives.setDone, { narrativeId, done: false });
    n = await t.run(async (ctx) => ctx.db.get(narrativeId));
    expect(n!.status).toBe("shared");
  });
});

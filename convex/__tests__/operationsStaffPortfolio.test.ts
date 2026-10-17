import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { emptyHealthRecordFields } from "../lib/healthRecord";
import {
  seedOperationsStaff,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: operations staff (base `staff` + `school:operations`) work
// the scanner inbox — see an incoming scan, file or refile it to a scholar or
// activity — but may not BROWSE a scholar's portfolio or scored offline work
// (Andy's ruling: "a bridge too far"). These tests pin both halves, plus the
// teacher and guardian paths that must keep working exactly as before.

async function withUser(t: TestConvex<typeof schema>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedFixture(t: TestConvex<typeof schema>) {
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    username: "fixture-teacher",
  });
  const opsId = await seedOperationsStaff(t, {
    institutionId,
    username: "fixture-ops",
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Fixture Kid",
    username: "fixture-kid",
  });
  return await t.run(async (ctx) => {
    const parentId = await ctx.db.insert("users", {
      name: "Fixture Parent",
      email: "fixture-parent@example.test",
      role: "parent",
    });
    await ctx.db.insert("guardianships", {
      parentUserId: parentId,
      scholarUserId: scholarId,
      createdBy: teacherId,
    });
    const now = Date.now();
    await ctx.db.insert("scholarHealthRecords", {
      scholarId,
      guardianId: parentId,
      ...emptyHealthRecordFields({
        childName: "Fixture Kid",
        guardianName: "Fixture Parent",
      }),
      signerName: "Fixture Parent",
      signerAgreement: true,
      signerUserId: parentId,
      signedAt: now,
      submittedAt: now,
      standardProgramAcknowledgedAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const storageId = await ctx.storage.store(
      new Blob(["scan"], { type: "application/pdf" }),
    );
    const thumbStorageId = await ctx.storage.store(
      new Blob(["thumb"], { type: "image/jpeg" }),
    );
    // A scan already filed to the scholar (part of their portfolio).
    const filedId = await ctx.db.insert("portfolioItems", {
      institutionId,
      scholarId,
      title: "Fractions worksheet",
      source: "google_drive",
      fileStorageId: storageId,
      fileMimeType: "application/pdf",
      matchStatus: "confirmed",
      assignmentStatus: "none",
      processingStatus: "ready",
      familyVisibility: "attributed_families",
      extractedText: "3/4 + 1/4 = 1",
      thumbStorageId,
      thumbStatus: "ready",
      aiCaption: "A fractions worksheet with all answers shown.",
    });
    await ctx.db.insert("portfolioAttributions", {
      portfolioItemId: filedId,
      scholarId,
      attributedAt: now,
    });
    // A fresh, unmatched scan sitting in the inbox.
    const inboxId = await ctx.db.insert("portfolioItems", {
      institutionId,
      title: "Untitled scan",
      source: "google_drive",
      fileStorageId: storageId,
      fileMimeType: "application/pdf",
      matchStatus: "unmatched",
      processingStatus: "ready",
      familyVisibility: "staff_only",
    });
    return { institutionId, teacherId, opsId, scholarId, parentId, filedId, inboxId };
  });
}

async function seedOfflineSession(
  t: TestConvex<typeof schema>,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    } as Doc<"units">);
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Worksheet",
      kind: "offline",
      order: 0,
    } as Doc<"activities">);
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      activityId,
      unitId,
      lessonId,
      assignmentId,
      title: "Worksheet",
      isArchived: false,
      isOffline: true,
    } as Doc<"sessions">);
    await ctx.db.insert("deliverables", {
      activityId,
      scholarId,
      sessionId,
      assignmentId,
      submittedAt: Date.now(),
      rubricFeedback: "Lovely reasoning on the second problem.",
    });
    return sessionId;
  });
}

describe("operations staff — scanner filing stays open", () => {
  test("sees the inbox scan, opens its file, and files it", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const asOps = await withUser(t, f.opsId);

    const feed = await asOps.query(api.portfolio.scannerFeed, {});
    expect(feed.toReview.map((item) => item._id)).toContain(f.inboxId);
    expect(
      await asOps.query(api.portfolio.getFileUrl, { itemId: f.inboxId }),
    ).toEqual(expect.any(String));

    await asOps.mutation(api.portfolio.assignScholar, {
      itemId: f.inboxId,
      scholarId: f.scholarId,
    });
    await asOps.mutation(api.portfolio.setAssignment, { itemId: f.inboxId });
    const filed = await t.run((ctx) => ctx.db.get(f.inboxId));
    expect(filed).toMatchObject({
      scholarId: f.scholarId,
      matchStatus: "confirmed",
      assignmentStatus: "none",
    });

    // Once filed it is the scholar's work: the file no longer opens for
    // operations staff (null, not a throw, so the reactive row survives).
    expect(
      await asOps.query(api.portfolio.getFileUrl, { itemId: f.inboxId }),
    ).toBeNull();
  });

  test("a still-processing scan's file opens", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    await t.run((ctx) =>
      ctx.db.patch(f.inboxId, { processingStatus: "extracting" }),
    );
    const asOps = await withUser(t, f.opsId);
    expect(
      await asOps.query(api.portfolio.getFileUrl, { itemId: f.inboxId }),
    ).toEqual(expect.any(String));
  });

  test("lists Filed rows without any image, and can refile one", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const otherScholarId = await seedScholarInInstitution(t, {
      institutionId: f.institutionId,
      name: "Fixture Sibling",
      username: "fixture-sibling",
    });
    const asOps = await withUser(t, f.opsId);

    const feed = await asOps.query(api.portfolio.scannerFeed, {});
    const row = feed.processed.find((item) => item._id === f.filedId);
    expect(row).toMatchObject({
      title: "Fractions worksheet",
      scholarNames: ["Fixture Kid"],
      thumbUrl: null,
      videoThumbUrl: null,
    });
    expect(row?.aiCaption).toBeUndefined();
    expect(row?.thumbStatus).toBeUndefined();

    // Misfiled: move it to the right scholar without ever seeing it.
    await asOps.mutation(api.portfolio.assignScholar, {
      itemId: f.filedId,
      scholarId: otherScholarId,
    });
    await asOps.mutation(api.portfolio.setAssignment, { itemId: f.filedId });
    const refiled = await t.run((ctx) => ctx.db.get(f.filedId));
    expect(refiled).toMatchObject({
      scholarId: otherScholarId,
      matchStatus: "confirmed",
      assignmentStatus: "none",
    });
  });
});

describe("operations staff — portfolio browsing is closed", () => {
  test("cannot list a scholar's portfolio or read a filed item's text", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const asOps = await withUser(t, f.opsId);

    await expect(
      asOps.query(api.portfolio.listForScholar, { scholarId: f.scholarId }),
    ).rejects.toThrow(/teaching access/i);
    await expect(
      asOps.query(api.portfolio.get, { itemId: f.filedId }),
    ).rejects.toThrow(/teaching access/i);
  });

  test("cannot open a filed item's file", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const asOps = await withUser(t, f.opsId);
    expect(
      await asOps.query(api.portfolio.getFileUrl, { itemId: f.filedId }),
    ).toBeNull();
  });

  test("cannot open the offline-work view (scores and teacher feedback)", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const sessionId = await seedOfflineSession(t, f.teacherId, f.scholarId);
    const asOps = await withUser(t, f.opsId);

    await expect(
      asOps.query(api.portfolio.offlineSessionView, { sessionId }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("operations staff — a filed scan cannot be laundered back into the inbox", () => {
  test("cannot clear a filed scan's scholars", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const asOps = await withUser(t, f.opsId);
    await expect(
      asOps.mutation(api.portfolio.setAttributions, {
        itemId: f.filedId,
        scholarIds: [],
      }),
    ).rejects.toThrow(/only teaching staff can clear/i);
    expect(await t.run((ctx) => ctx.db.get(f.filedId))).toMatchObject({
      matchStatus: "confirmed",
    });
  });

  test("a teacher-unfiled scan stays closed to ops staff (sticky filed stamp)", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const asOps = await withUser(t, f.opsId);
    const asTeacher = await withUser(t, f.teacherId);

    // The legacy fixture row has no stamp yet; unfiling records it first.
    await asTeacher.mutation(api.portfolio.setAttributions, {
      itemId: f.filedId,
      scholarIds: [],
    });
    const unfiled = await t.run((ctx) => ctx.db.get(f.filedId));
    expect(unfiled).toMatchObject({ matchStatus: "unmatched" });
    expect(unfiled?.firstFiledAt).toEqual(expect.any(Number));

    expect(
      await asOps.query(api.portfolio.getFileUrl, { itemId: f.filedId }),
    ).toBeNull();
    await expect(
      asOps.query(api.portfolio.get, { itemId: f.filedId }),
    ).rejects.toThrow(/teaching access/i);
    const feed = await asOps.query(api.portfolio.scannerFeed, {});
    const row = feed.toReview.find((item) => item._id === f.filedId);
    expect(row).toMatchObject({ thumbUrl: null, videoThumbUrl: null });
    expect(row?.aiCaption).toBeUndefined();

    // Ops staff may still file it again, without seeing it.
    await asOps.mutation(api.portfolio.assignScholar, {
      itemId: f.filedId,
      scholarId: f.scholarId,
    });
    // And the teacher still sees everything.
    expect(
      await asTeacher.query(api.portfolio.getFileUrl, { itemId: f.filedId }),
    ).toEqual(expect.any(String));
  });

  test("an AI-filed scan re-matched to nobody stays closed to ops staff", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(f.inboxId, {
        scholarId: f.scholarId,
        matchStatus: "matched",
        assignmentStatus: "none",
      });
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: f.inboxId,
        scholarId: f.scholarId,
        attributedAt: Date.now(),
      });
    });
    await t.mutation(internal.portfolio.aiSetMatch, {
      itemId: f.inboxId,
      matchStatus: "unmatched",
    });
    const asOps = await withUser(t, f.opsId);
    expect(
      await asOps.query(api.portfolio.getFileUrl, { itemId: f.inboxId }),
    ).toBeNull();
  });
});

describe("operations staff — family-message portfolio attachments", () => {
  test("the server refuses a portfolio attachment from ops staff", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const asOps = await withUser(t, f.opsId);
    await expect(
      asOps.mutation(api.parentMessages.registerPortfolioAttachment, {
        portfolioItemId: f.filedId,
        scholarId: f.scholarId,
      }),
    ).rejects.toThrow(/teaching access/i);
    const asTeacher = await withUser(t, f.teacherId);
    await expect(
      asTeacher.mutation(api.parentMessages.registerPortfolioAttachment, {
        portfolioItemId: f.filedId,
        scholarId: f.scholarId,
      }),
    ).resolves.toHaveProperty("attachmentId");
  });
});

describe("operations staff — other learning-record reads are closed", () => {
  test("cannot read a scholar's math plan or a cohort's submissions", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const sessionId = await seedOfflineSession(t, f.teacherId, f.scholarId);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    const asOps = await withUser(t, f.opsId);
    const asTeacher = await withUser(t, f.teacherId);

    await expect(
      asOps.query(api.mathPlans.myPlan, { scholarId: f.scholarId }),
    ).rejects.toThrow(/teaching access/i);
    await expect(
      asTeacher.query(api.mathPlans.myPlan, { scholarId: f.scholarId }),
    ).resolves.toHaveProperty("practiceScope");

    expect(
      await asOps.query(api.activities.collateDeliverablesForActivity, {
        activityId: session!.activityId!,
      }),
    ).toEqual([]);
  });
});

describe("teachers and guardians keep their access", () => {
  test("a teacher still browses the portfolio and offline work", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const sessionId = await seedOfflineSession(t, f.teacherId, f.scholarId);
    const asTeacher = await withUser(t, f.teacherId);

    const items = await asTeacher.query(api.portfolio.listForScholar, {
      scholarId: f.scholarId,
    });
    expect(items.map((item) => item._id)).toContain(f.filedId);
    expect(
      await asTeacher.query(api.portfolio.get, { itemId: f.filedId }),
    ).toMatchObject({ extractedText: "3/4 + 1/4 = 1" });
    expect(
      await asTeacher.query(api.portfolio.getFileUrl, { itemId: f.filedId }),
    ).toEqual(expect.any(String));
    const feed = await asTeacher.query(api.portfolio.scannerFeed, {});
    expect(
      feed.processed.find((item) => item._id === f.filedId),
    ).toMatchObject({
      thumbUrl: expect.any(String),
      thumbStatus: "ready",
      aiCaption: "A fractions worksheet with all answers shown.",
    });
    expect(
      await asTeacher.query(api.portfolio.offlineSessionView, { sessionId }),
    ).toMatchObject({
      viewerCanGrade: true,
      items: [
        expect.objectContaining({
          teacherFeedback: "Lovely reasoning on the second problem.",
        }),
      ],
    });
  });

  test("a guardian still sees their own child's family-visible work", async () => {
    const t = convexTest(schema, modules);
    const f = await seedFixture(t);
    const asParent = await withUser(t, f.parentId);

    const list = await asParent.query(api.portfolio.listForGuardian, {
      scholarId: f.scholarId,
    });
    expect(list).toHaveLength(1);
    expect(
      await asParent.query(api.portfolio.getFileUrlForGuardian, {
        itemId: f.filedId,
      }),
    ).toEqual(expect.any(String));
  });
});

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

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  username = `u-${role}`,
) {
  const institutionId = await seedTestInstitution(t);
  return role === "teacher"
    ? seedStaffWithMembership(t, { institutionId, name: `Test ${role}`, username })
    : seedScholarInInstitution(t, { institutionId, name: `Test ${role}`, username });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3600_000,
    }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function grantCaptureReview(
  t: ReturnType<typeof convexTest>,
  {
    userId,
    institutionId,
    groupId,
  }: {
    userId: Id<"users">;
    institutionId: Id<"institutions">;
    groupId: Id<"scholarGroups">;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      scholarGroupId: groupId,
      capability: "captures:review",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
}

/** Seed a unit → lesson → offline activity → assignment → offline session → deliverable. */
async function seedOfflineSession(
  t: ReturnType<typeof convexTest>,
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
    const deliverableId = await ctx.db.insert("deliverables", {
      activityId,
      scholarId,
      sessionId,
      assignmentId,
      submittedAt: Date.now(),
    });
    return { sessionId, activityId, deliverableId, unitId, lessonId, assignmentId };
  });
}

describe("offlineSessionView — scholar-facing read shape (Phase 2)", () => {
  test("does not mint capture-media URLs through an offline deliverable", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const { sessionId, deliverableId } = await seedOfflineSession(
      t,
      teacherId,
      scholarId,
    );
    const { groupId } = await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId,
        name: "Robotics",
        participation: "includes_program_guests",
        scholarIds: [scholarId],
      });
      const stationId = await ctx.db.insert("captureStations", {
        institutionId,
        scholarGroupId: groupId,
        label: "Robotics capture",
        enrollmentTokenHash: "fixture",
        enabled: true,
        createdBy: teacherId,
        createdAt: Date.now(),
      });
      const captureSessionId = await ctx.db.insert("captureStationSessions", {
        captureStationId: stationId,
        deviceId: "fixture-device",
        sessionTokenHash: "fixture-token",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const storageId = await ctx.storage.store(
        new Blob(["capture"], { type: "image/jpeg" }),
      );
      const itemId = await ctx.db.insert("portfolioItems", {
        institutionId,
        scholarId,
        title: "Captured build",
        source: "capture_station",
        fileStorageId: storageId,
        fileMimeType: "image/jpeg",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
        familyVisibility: "staff_only",
      });
      await ctx.db.insert("captureStationCaptures", {
        captureStationId: stationId,
        sessionId: captureSessionId,
        portfolioItemId: itemId,
        storageId,
        scholarIds: [scholarId],
        mimeType: "image/jpeg",
        sizeBytes: 7,
        createdAt: Date.now(),
      });
      await ctx.db.patch(deliverableId, { portfolioItemId: itemId });
      return { groupId };
    });

    await expect(
      (await withUser(t, scholarId)).query(api.portfolio.offlineSessionView, {
        sessionId,
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      (await withUser(t, teacherId)).query(api.portfolio.offlineSessionView, {
        sessionId,
      }),
    ).resolves.toMatchObject({ items: [] });
    await grantCaptureReview(t, { userId: teacherId, institutionId, groupId });
    await expect(
      (await withUser(t, teacherId)).query(api.portfolio.offlineSessionView, {
        sessionId,
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ fileUrl: expect.any(String) })],
    });
  });

  test("owning scholar sees viewerCanGrade=false and the checked-state fields", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { sessionId } = await seedOfflineSession(t, teacherId, scholarId);

    const asScholar = await withUser(t, scholarId);
    const view = await asScholar.query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    expect(view).not.toBeNull();
    expect(view!.viewerCanGrade).toBe(false);
    expect(view!.isHomework).toBe(false);
    expect(view!.items).toHaveLength(1);
    // The scholar-visible read exposes checked-state fields (null until checked).
    expect(view!.items[0]).toHaveProperty("checkedAt", null);
    expect(view!.items[0]).toHaveProperty("teacherFeedback", null);
  });

  test("teacher viewer sees viewerCanGrade=true", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { sessionId } = await seedOfflineSession(t, teacherId, scholarId);

    const asTeacher = await withUser(t, teacherId);
    const view = await asTeacher.query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    expect(view).not.toBeNull();
    expect(view!.viewerCanGrade).toBe(true);
  });

  test("returns authored instructions and full offline homework context", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { sessionId, activityId, assignmentId } = await seedOfflineSession(
      t,
      teacherId,
      scholarId,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(activityId, {
        scholarDescription: "Read pages 4–5.\n\nShow each step.",
      });
      await ctx.db.insert("activityResources", {
        activityId,
        title: "Build guide",
        source: { kind: "link", url: "https://example.com/build-guide" },
        order: 0,
        uploadedBy: teacherId,
      });
      await ctx.db.patch(assignmentId, {
        activitySchedule: [
          {
            activityId,
            mode: "homework",
            setAt: Date.now() - 60_000,
            dueAt: Date.UTC(2026, 7, 9, 20, 34),
          },
        ],
      });
    });

    const asScholar = await withUser(t, scholarId);
    const view = await asScholar.query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    expect(view).toMatchObject({
      description: "Read pages 4–5.\n\nShow each step.",
      unitTitle: "U",
      unitEmoji: null,
      lessonTitle: "L",
      teacherName: "Test teacher",
      dueAt: Date.UTC(2026, 7, 9, 20, 34),
      isHomework: true,
      timeZone: "Pacific/Honolulu",
      resources: [
        {
          title: "Build guide",
          kind: "link",
          url: "https://example.com/build-guide",
        },
      ],
    });
  });

  test("ignores homework metadata targeted to another rostered scholar", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const otherScholarId = await seedUser(t, "scholar", "s2");
    const { sessionId, activityId, assignmentId } = await seedOfflineSession(
      t,
      teacherId,
      scholarId,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        scholarIds: [scholarId, otherScholarId],
        activitySchedule: [
          {
            activityId,
            mode: "homework",
            setAt: Date.now() - 60_000,
            dueAt: Date.UTC(2026, 7, 9, 20, 34),
            scholarIds: [otherScholarId],
          },
        ],
      });
    });

    const asScholar = await withUser(t, scholarId);
    const view = await asScholar.query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    expect(view?.isHomework).toBe(false);
    expect(view?.dueAt).toBeNull();
  });

  test("after a teacher check, the scholar sees the checked stamp + feedback", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { sessionId, deliverableId } = await seedOfflineSession(
      t,
      teacherId,
      scholarId,
    );

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deliverables.teacherSetCheck, {
      deliverableId,
      overall: "half",
      feedback: "Nice start — recheck the folds.",
    });

    const asScholar = await withUser(t, scholarId);
    const view = await asScholar.query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    const item = view!.items[0];
    expect(view!.viewerCanGrade).toBe(false);
    expect(item.checkedAt).not.toBeNull();
    expect(item.overall).toBe("half");
    expect(item.teacherFeedback).toContain("recheck the folds");
  });
});

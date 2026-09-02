import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedItem(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  title: string,
  label?: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("portfolioItems", {
      institutionId,
      title,
      source: "upload",
      label,
      documentHeading: `${title} heading`,
      matchStatus: "unmatched",
      assignmentStatus: "none",
      processingStatus: "ready",
    }),
  );
}

// A program-capture group (guest-inclusive, so it's a real program group) plus
// its capture station. The station is what a capture row is scoped to.
async function seedProgramGroupWithStation(
  t: ReturnType<typeof convexTest>,
  args: { institutionId: Id<"institutions">; teacherId: Id<"users"> },
) {
  return await t.run(async (ctx) => {
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId: args.teacherId,
      institutionId: args.institutionId,
      name: "Robotics",
      scholarIds: [],
      type: "robotics",
      participation: "includes_program_guests",
    });
    const stationId = await ctx.db.insert("captureStations", {
      institutionId: args.institutionId,
      scholarGroupId: groupId,
      label: "Robotics capture",
      enrollmentTokenHash: `station-hash-${groupId}`,
      enabled: true,
      createdBy: args.teacherId,
      createdAt: Date.now(),
    });
    return { groupId, stationId };
  });
}

// A capture-station portfolio row: source `capture_station` + the join row that
// binds it to a station (which `filterScannerScope` reads to scope captures).
async function seedCaptureItem(
  t: ReturnType<typeof convexTest>,
  args: {
    institutionId: Id<"institutions">;
    stationId: Id<"captureStations">;
    title: string;
    label?: string;
  },
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("captureStationSessions", {
      captureStationId: args.stationId,
      deviceId: "capture-ipad",
      sessionTokenHash: `session-hash-${args.stationId}-${args.title}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const storageId = await ctx.storage.store(
      new Blob(["capture"], { type: "image/jpeg" }),
    );
    const itemId = await ctx.db.insert("portfolioItems", {
      institutionId: args.institutionId,
      title: args.title,
      source: "capture_station",
      label: args.label,
      matchStatus: "unmatched",
      assignmentStatus: "none",
      processingStatus: "ready",
    });
    await ctx.db.insert("captureStationCaptures", {
      captureStationId: args.stationId,
      sessionId,
      portfolioItemId: itemId,
      storageId,
      scholarIds: [],
      mimeType: "image/jpeg",
      sizeBytes: 4,
      createdAt: Date.now(),
    });
    return itemId;
  });
}

async function grantCaptureReview(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    institutionId: Id<"institutions">;
    groupId: Id<"scholarGroups">;
    grantedBy: Id<"users">;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: args.userId,
      institutionId: args.institutionId,
      scholarGroupId: args.groupId,
      capability: "captures:review",
      grantedBy: args.grantedBy,
      grantedAt: Date.now(),
    }),
  );
}

// A base-`staff` member with NO school-operations access — the captures:review-
// only program coach. A `teacher`/`school_admin` membership (or a plain
// `staff` grant with `school:operations` — the retired registrar role's
// successor) would grant school operations access, which is not the person
// these harms concern.
async function seedStaffCoach(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  username: string,
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Program coach",
      username,
      role: "staff",
    });
    await ctx.db.insert("memberships", { userId, institutionId, role: "staff" });
    return userId;
  });
}

async function seedPlatformAdmin(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Platform admin",
      username,
      role: "platform_admin",
    }),
  );
}

describe("portfolio labels", () => {
  test("bulk sets, trims, caps, clears, and never changes documentHeading", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Label teacher",
      username: "label-teacher",
    });
    const itemIds = await Promise.all([
      seedItem(t, institutionId, "First"),
      seedItem(t, institutionId, "Second"),
      seedItem(t, institutionId, "Third"),
    ]);
    const asTeacher = await withUser(t, teacherId);
    const longLabel = "L".repeat(90);

    await expect(
      asTeacher.mutation(api.portfolio.setLabels, {
        itemIds,
        label: `  ${longLabel}  `,
      }),
    ).resolves.toEqual({ updated: 3 });

    const labeled = await t.run((ctx) =>
      Promise.all(itemIds.map((itemId) => ctx.db.get(itemId))),
    );
    expect(labeled.map((item) => item?.label)).toEqual([
      "L".repeat(80),
      "L".repeat(80),
      "L".repeat(80),
    ]);
    expect(labeled.map((item) => item?.documentHeading)).toEqual([
      "First heading",
      "Second heading",
      "Third heading",
    ]);
    await expect(
      asTeacher.query(api.portfolio.get, { itemId: itemIds[0] }),
    ).resolves.toMatchObject({ label: "L".repeat(80) });

    await expect(
      asTeacher.mutation(api.portfolio.setLabels, {
        itemIds,
        label: "   ",
      }),
    ).resolves.toEqual({ updated: 3 });
    const cleared = await t.run((ctx) =>
      Promise.all(itemIds.map((itemId) => ctx.db.get(itemId))),
    );
    expect(cleared.map((item) => item?.label)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(cleared.map((item) => item?.documentHeading)).toEqual([
      "First heading",
      "Second heading",
      "Third heading",
    ]);
  });

  test("cannot label an item outside the caller's institution", async () => {
    const t = convexTest(schema, modules);
    const homeInstitutionId = await seedTestInstitution(t, {
      name: "Home School",
      slug: "home-school",
    });
    const otherInstitutionId = await seedTestInstitution(t, {
      name: "Other School",
      slug: "other-school-labels",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId: homeInstitutionId,
      name: "Home teacher",
      username: "home-label-teacher",
    });
    const homeItemId = await seedItem(t, homeInstitutionId, "Home work");
    const otherItemId = await seedItem(t, otherInstitutionId, "Other work");
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.portfolio.setLabels, {
        itemIds: [homeItemId, otherItemId],
        label: "Learning Print",
      }),
    ).rejects.toThrow(/outside your school/i);
    expect(
      await t.run((ctx) => ctx.db.get(homeItemId)),
    ).not.toHaveProperty("label");
  });

  test("lists distinct recent labels newest-first for only the caller's institution", async () => {
    const t = convexTest(schema, modules);
    const homeInstitutionId = await seedTestInstitution(t, {
      name: "Home School",
      slug: "recent-label-home",
    });
    const otherInstitutionId = await seedTestInstitution(t, {
      name: "Other School",
      slug: "recent-label-other",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId: homeInstitutionId,
      name: "Recent label teacher",
      username: "recent-label-teacher",
    });

    await seedItem(t, homeInstitutionId, "Old", "Learning Print");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedItem(t, homeInstitutionId, "Middle", "Reflection Sheet");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedItem(t, homeInstitutionId, "New", "Learning Print");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedItem(t, otherInstitutionId, "Other", "Other School Label");

    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.query(api.portfolio.listRecentLabels, {}),
    ).resolves.toEqual(["Learning Print", "Reflection Sheet"]);
    await expect(
      asTeacher.query(api.portfolio.listRecentLabels, { limit: 1 }),
    ).resolves.toEqual(["Learning Print"]);
  });
});

// Recent labels must be drawn from EXACTLY the scanner-queue population the
// caller can already see (#2448 scoping), never a second independently-scoped
// scan. Each test pins one of the three harms that a second scan reintroduced.
describe("recent labels are scanner-queue scoped", () => {
  test("(a) an admin scoped to institution B does not receive institution A's labels", async () => {
    const t = convexTest(schema, modules);
    const institutionAId = await seedTestInstitution(t, {
      name: "School A",
      slug: "harm-a-primary",
      isPrimary: true,
    });
    const institutionBId = await seedTestInstitution(t, {
      name: "School B",
      slug: "harm-a-other",
    });
    const adminId = await seedPlatformAdmin(t, "harm-a-admin");

    await seedItem(t, institutionAId, "A work", "A Label");
    await seedItem(t, institutionBId, "B work", "B Label");

    const asAdmin = await withUser(t, adminId);
    // Viewing School B through the institution scope switcher.
    const labels = await asAdmin.query(api.portfolio.listRecentLabels, {
      scope: "harm-a-other",
    });
    expect(labels).toContain("B Label");
    expect(labels).not.toContain("A Label");
  });

  test("(b) a staffer without captures:review does not receive capture-station labels", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "harm-b" });
    // A plain teacher: school-operations access by role, but no captures:review.
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Ops teacher",
      username: "harm-b-teacher",
    });
    const { stationId } = await seedProgramGroupWithStation(t, {
      institutionId,
      teacherId,
    });

    await seedItem(t, institutionId, "Ordinary", "Ordinary Label");
    await seedCaptureItem(t, {
      institutionId,
      stationId,
      title: "Capture",
      label: "Capture Label",
    });

    const asTeacher = await withUser(t, teacherId);
    const labels = await asTeacher.query(api.portfolio.listRecentLabels, {});
    expect(labels).toContain("Ordinary Label");
    expect(labels).not.toContain("Capture Label");
  });

  test("(c) a captures:review-only coach receives labels from their reviewable group", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "harm-c" });
    // The creator of the group/station — creator is not an authorization input.
    const ownerId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Owner",
      username: "harm-c-owner",
    });
    const { groupId, stationId } = await seedProgramGroupWithStation(t, {
      institutionId,
      teacherId: ownerId,
    });
    const coachId = await seedStaffCoach(t, institutionId, "harm-c-coach");
    await grantCaptureReview(t, {
      userId: coachId,
      institutionId,
      groupId,
      grantedBy: ownerId,
    });

    // The coach has NO school-operations lens, so this ordinary label is out of
    // scope for them...
    await seedItem(t, institutionId, "Ordinary", "Ordinary Label");
    // ...but their reviewable group's capture label IS in scope.
    await seedCaptureItem(t, {
      institutionId,
      stationId,
      title: "Capture",
      label: "Capture Label",
    });

    const asCoach = await withUser(t, coachId);
    const labels = await asCoach.query(api.portfolio.listRecentLabels, {});
    expect(labels).toEqual(["Capture Label"]);
  });
});

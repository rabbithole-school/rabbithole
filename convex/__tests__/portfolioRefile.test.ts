import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { emptyHealthRecordFields } from "../lib/healthRecord";
import type { UploadableDocumentKind } from "../lib/documentKinds";
import { HEALTH_DOCUMENT_MAX_BYTES } from "../../shared/healthDocuments";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;
const refile = api.portfolioRefile.fileAsRecord;

async function fixture(
  t: TestCtx,
  kind: UploadableDocumentKind = "report_card",
) {
  return t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Refiling School",
      slug: `refiling-${Date.now()}-${Math.random()}`,
      kind: "school",
      isPrimary: true,
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Teacher",
      username: `teacher-${Date.now()}-${Math.random()}`,
      role: "teacher",
      institutionId,
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Scholar",
      username: `scholar-${Date.now()}-${Math.random()}`,
      role: "scholar",
      institutionId,
    });
    const guardianId = await ctx.db.insert("users", {
      name: "Guardian",
      username: `guardian-${Date.now()}-${Math.random()}`,
      role: "parent",
      institutionId,
    });
    await ctx.db.insert("memberships", { userId: teacherId, role: "teacher", institutionId });
    if (kind === "medication_authorization") {
      const now = Date.now();
      await ctx.db.insert("scholarHealthRecords", {
        scholarId,
        guardianId,
        ...emptyHealthRecordFields({
          childName: "Scholar",
          guardianName: "Guardian",
        }),
        signerName: "Guardian",
        signerAgreement: true,
        signerUserId: guardianId,
        signedAt: now,
        submittedAt: now,
        standardProgramAcknowledgedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    const fileBytes = "%PDF-1.7\n";
    const fileStorageId = await ctx.storage.store(
      new Blob([fileBytes], { type: "application/pdf" }),
    );
    const itemId = await ctx.db.insert("portfolioItems", {
      scholarId,
      institutionId,
      title: "scan.pdf",
      source: "google_drive",
      driveFileId: "drive-refile-1",
      fileStorageId,
      fileMimeType: "application/pdf",
      fileSizeBytes: fileBytes.length,
      processingStatus: "ready",
      matchStatus: "confirmed",
      assignmentStatus: "none",
    });
    return { institutionId, teacherId, scholarId, itemId, fileStorageId, kind };
  });
}

async function asUser(t: TestCtx, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

describe("portfolio scanner record refiling", () => {
  const routingCases = [
    ["report_card", "scholarDocuments"],
    ["identity_document", "scholarDocuments"],
    ["medication_authorization", "healthRecordFiles"],
  ] as const satisfies readonly [
    UploadableDocumentKind,
    "scholarDocuments" | "healthRecordFiles",
  ][];

  test.each(routingCases)("routes %s to %s and copies the scan", async (kind, store) => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, kind);
    const teacher = await asUser(t, f.teacherId);
    await teacher.action(refile, {
      itemId: f.itemId,
      kind,
      institutionScope: f.institutionId,
    });
    const destination = await t.run(async (ctx) => {
      if (store === "scholarDocuments") {
        const rows = await ctx.db.query("scholarDocuments").collect();
        const row = rows[0];
        return {
          count: rows.length,
          scholarId: row?.scholarId,
          kind: row?.kind,
          storageId: row?.fileStorageId,
          processingStatus: row?.processingStatus,
          feedsTutor: row?.feedsTutor,
        };
      }
      const rows = await ctx.db.query("healthRecordFiles").collect();
      const row = rows[0];
      return {
        count: rows.length,
        scholarId: row?.scholarId,
        kind: row?.kind,
        storageId: row?.storageId,
        processingStatus: undefined,
        feedsTutor: undefined,
      };
    });
    expect(destination).toMatchObject({
      count: 1,
      scholarId: f.scholarId,
      kind,
    });
    if (kind === "identity_document") {
      expect(destination).toMatchObject({
        processingStatus: "ready",
        feedsTutor: false,
      });
    }
    const destinationStorageId = destination.storageId;
    expect(destinationStorageId).toBeDefined();
    expect(destinationStorageId).not.toBe(f.fileStorageId);
    expect(
      await t.run(async (ctx) =>
        (await ctx.storage.get(destinationStorageId!)) !== null,
      ),
    ).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(f.itemId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.get(f.fileStorageId))).toBeNull();
  });

  test("rejects zero or multiple attributed scholars without changing the source", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const second = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Second", username: "second", role: "scholar", institutionId: f.institutionId }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(f.itemId, { scholarId: undefined });
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: f.itemId,
        scholarId: f.scholarId,
        attributedAt: Date.now(),
      });
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: f.itemId,
        scholarId: second,
        attributedAt: Date.now(),
      });
    });
    const teacher = await asUser(t, f.teacherId);
    await expect(teacher.action(refile, { itemId: f.itemId, kind: f.kind })).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.get(f.itemId))).not.toBeNull();
  });

  test("rejects oversized health-record scans before copying storage", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, "medication_authorization");
    const oversizedStorageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([new Uint8Array(HEALTH_DOCUMENT_MAX_BYTES + 1)], {
          type: "application/pdf",
        }),
      ),
    );
    await t.run(async (ctx) => {
      await ctx.storage.delete(f.fileStorageId);
      await ctx.db.patch(f.itemId, {
        fileStorageId: oversizedStorageId,
        fileSizeBytes: HEALTH_DOCUMENT_MAX_BYTES + 1,
      });
    });
    const teacher = await asUser(t, f.teacherId);

    await expect(
      teacher.action(refile, { itemId: f.itemId, kind: f.kind }),
    ).rejects.toThrow(/10 MB or smaller/);
    expect(await t.run((ctx) => ctx.db.get(f.itemId))).not.toBeNull();
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(oversizedStorageId)) !== null),
    ).toBe(true);
    expect(
      await t.run((ctx) => ctx.db.query("healthRecordFiles").collect()),
    ).toHaveLength(0);
  });

  test("refuses cross-tenant access and a health destination with no signed record", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const outsider = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Outsider", username: "outsider", role: "teacher" }),
    );
    const user = await asUser(t, outsider);
    await expect(user.action(refile, { itemId: f.itemId, kind: f.kind })).rejects.toThrow();
    const teacher = await asUser(t, f.teacherId);
    await expect(teacher.action(refile, { itemId: f.itemId, kind: "medication_authorization" })).rejects.toThrow();
  });

  test("does not let operations-only staff file health records", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, "medication_authorization");
    const staffId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Operations staff",
        username: "operations-staff",
        role: "staff",
      });
      await ctx.db.insert("memberships", {
        userId,
        role: "staff",
        institutionId: f.institutionId,
      });
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: userId,
        institutionId: f.institutionId,
        capability: "school:operations",
        grantedBy: f.teacherId,
        grantedAt: Date.now(),
      });
      return userId;
    });
    const staff = await asUser(t, staffId);

    await expect(
      staff.action(refile, {
        itemId: f.itemId,
        kind: "medication_authorization",
      }),
    ).rejects.toThrow(/Forbidden/i);
    expect(await t.run((ctx) => ctx.db.get(f.itemId))).not.toBeNull();
  });

  test("tears down materialized deliverables and writes one Drive dismissal", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    await t.run(async (ctx) => {
      const activityId = await ctx.db.insert("activities", {
        title: "Scanned work",
        kind: "offline",
        order: 0,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: f.scholarId,
        title: "Scanned work",
        isArchived: false,
      });
      await ctx.db.insert("deliverables", {
        portfolioItemId: f.itemId,
        activityId,
        scholarId: f.scholarId,
        sessionId,
        submittedAt: Date.now(),
      });
    });
    const teacher = await asUser(t, f.teacherId);
    await teacher.action(refile, { itemId: f.itemId, kind: f.kind });
    expect(await t.run((ctx) => ctx.db.query("deliverables").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("driveFileDismissals").collect())).toHaveLength(1);
  });
});

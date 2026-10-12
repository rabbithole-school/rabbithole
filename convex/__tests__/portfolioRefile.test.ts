import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { emptyHealthRecordFields } from "../lib/healthRecord";
import type { UploadableDocumentKind } from "../lib/documentKinds";
import { HEALTH_DOCUMENT_MAX_BYTES } from "../../shared/healthDocuments";
import {
  makeScholar,
  makeSession,
  makeUnit,
  makeLesson,
  makeActivity,
  makeWorld,
} from "./factories/world";

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
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 1,
    parentsPerSchool: 1,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  const scholar = school.scholars[0];
  const guardian = school.parents[0];

  if (kind === "medication_authorization") {
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("scholarHealthRecords", {
        scholarId: scholar.id,
        guardianId: guardian.id,
        ...emptyHealthRecordFields({
          childName: scholar.name,
          guardianName: guardian.name,
        }),
        signerName: guardian.name,
        signerAgreement: true,
        signerUserId: guardian.id,
        signedAt: now,
        submittedAt: now,
        standardProgramAcknowledgedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  const fileBytes = "%PDF-1.7\n";
  const fileStorageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([fileBytes], { type: "application/pdf" })),
  );
  const itemId = await t.run((ctx) =>
    ctx.db.insert("portfolioItems", {
      scholarId: scholar.id,
      institutionId: school.id,
      title: "scan.pdf",
      source: "google_drive",
      driveFileId: "drive-refile-1",
      fileStorageId,
      fileMimeType: "application/pdf",
      fileSizeBytes: fileBytes.length,
      processingStatus: "ready",
      matchStatus: "confirmed",
      assignmentStatus: "none",
    }),
  );

  return {
    world,
    school,
    institutionId: school.id,
    teacherId: school.teacher.id,
    scholarId: scholar.id,
    itemId,
    fileStorageId,
    kind,
  };
}

describe("portfolio scanner record refiling", () => {
  const routingCases = [
    ["report_card", "scholarDocuments"],
    ["identity_document", "scholarDocuments"],
    ["incident_report", "scholarDocuments"],
    ["transfer_record", "scholarDocuments"],
    ["medication_authorization", "healthRecordFiles"],
  ] as const satisfies readonly [
    UploadableDocumentKind,
    "scholarDocuments" | "healthRecordFiles",
  ][];

  test.each(routingCases)("routes %s to %s and copies the scan", async (kind, store) => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, kind);
    const teacher = await f.world.as.staffOf(f.school);
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
    // Kinds the registry keeps out of the extract/redact pipeline land
    // `ready` with nothing scheduled; the rest enter it as `pending`.
    if (kind === "identity_document" || kind === "incident_report") {
      expect(destination).toMatchObject({
        processingStatus: "ready",
        feedsTutor: false,
      });
    } else if (store === "scholarDocuments") {
      expect(destination).toMatchObject({
        processingStatus: "pending",
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
    const second = await makeScholar(t, f.institutionId, {
      name: "Second",
      username: "second",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(f.itemId, { scholarId: undefined });
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: f.itemId,
        scholarId: f.scholarId,
        attributedAt: Date.now(),
      });
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: f.itemId,
        scholarId: second.id,
        attributedAt: Date.now(),
      });
    });
    const teacher = await f.world.as.staffOf(f.school);
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
    const teacher = await f.world.as.staffOf(f.school);

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
    const outsider = await f.world.as.staffOf(f.world.schools[1]);
    await expect(outsider.action(refile, { itemId: f.itemId, kind: f.kind })).rejects.toThrow();
    const teacher = await f.world.as.staffOf(f.school);
    await expect(teacher.action(refile, { itemId: f.itemId, kind: "medication_authorization" })).rejects.toThrow();
  });

  test("does not let operations-only staff file health records", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, "medication_authorization");
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: f.school.ops.id,
        institutionId: f.institutionId,
        capability: "school:operations",
        grantedBy: f.teacherId,
        grantedAt: Date.now(),
      }),
    );
    const staff = await f.world.as.staffOf(f.school, "staff");

    await expect(
      staff.action(refile, {
        itemId: f.itemId,
        kind: "medication_authorization",
      }),
    ).rejects.toThrow(/Forbidden/i);
    expect(await t.run((ctx) => ctx.db.get(f.itemId))).not.toBeNull();
  });

  test("operations-only staff can file administrative records but not a teacher-only kind", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t, "incident_report");
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: f.school.ops.id,
        institutionId: f.institutionId,
        capability: "school:operations",
        grantedBy: f.teacherId,
        grantedAt: Date.now(),
      }),
    );
    const staff = await f.world.as.staffOf(f.school, "staff");

    // The teacher-only kind is refused on the registry, before any copy.
    await expect(
      staff.action(refile, { itemId: f.itemId, kind: "assessment" }),
    ).rejects.toThrow(/may not upload/i);
    expect(await t.run((ctx) => ctx.db.get(f.itemId))).not.toBeNull();

    await staff.action(refile, { itemId: f.itemId, kind: "incident_report" });
    const rows = await t.run((ctx) => ctx.db.query("scholarDocuments").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scholarId: f.scholarId,
      kind: "incident_report",
      uploadedBy: f.school.ops.id,
      processingStatus: "ready",
      feedsTutor: false,
    });
    expect(await t.run((ctx) => ctx.db.get(f.itemId))).toBeNull();
  });

  test("tears down materialized deliverables and writes one Drive dismissal", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const unitId = await makeUnit(t, f.school.teacher, f.school, {
      title: "Scanned work",
    });
    const lessonId = await makeLesson(t, unitId, { title: "Scanned work" });
    const activityId = await makeActivity(t, lessonId, {
      title: "Scanned work",
      kind: "offline",
    });
    const sessionId = await makeSession(t, f.school.scholars[0], {
      title: "Scanned work",
      isArchived: false,
    });
    await t.run((ctx) =>
      ctx.db.insert("deliverables", {
        portfolioItemId: f.itemId,
        activityId,
        scholarId: f.scholarId,
        sessionId,
        submittedAt: Date.now(),
      }),
    );
    const teacher = await f.world.as.staffOf(f.school);
    await teacher.action(refile, { itemId: f.itemId, kind: f.kind });
    expect(await t.run((ctx) => ctx.db.query("deliverables").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("driveFileDismissals").collect())).toHaveLength(1);
  });
});

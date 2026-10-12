import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import schema from "../schema";
import {
  deleteInstitutionScopedBatch,
  purgeUserInner,
} from "../lib/cascade";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("institution cascade — shared portfolio", () => {
  test("deletes a family attachment blob after its portfolio item and thread are purged", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 1,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const { institutionId, scholarId, storageId, stationId, stationSessionId } =
      await t.run(async (ctx) => {
        const teacherId = school.teacher.id;
        const scholarId = school.scholars[0].id;
        const parentId = school.parents[0].id;
        const groupId = await ctx.db.insert("scholarGroups", {
          teacherId,
          institutionId: school.id,
          name: "Robotics",
          scholarIds: [scholarId],
          type: "robotics",
        });
        const stationId = await ctx.db.insert("captureStations", {
          institutionId: school.id,
          scholarGroupId: groupId,
          label: "Robotics capture",
          enrollmentTokenHash: "station-hash",
          enabled: true,
          createdBy: teacherId,
          createdAt: Date.now(),
        });
        const stationSessionId = await ctx.db.insert("captureStationSessions", {
          captureStationId: stationId,
          deviceId: "shared-ipad",
          sessionTokenHash: "session-hash",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
        const storageId = await ctx.storage.store(
          new Blob(["portfolio"], { type: "application/pdf" }),
        );
        const portfolioItemId = await ctx.db.insert("portfolioItems", {
          scholarId,
          institutionId: school.id,
          title: "Shared portfolio.pdf",
          source: "manual",
          fileStorageId: storageId,
          fileMimeType: "application/pdf",
          matchStatus: "confirmed",
          assignmentStatus: "none",
          processingStatus: "ready",
          familyVisibility: "attributed_families",
        });
        await ctx.db.insert("portfolioAttributions", {
          portfolioItemId,
          scholarId,
          attributedAt: Date.now(),
        });
        const threadId = await ctx.db.insert("parentThreads", {
          parentUserId: parentId,
          teacherId,
          scholarId,
          lastMessageAt: Date.now(),
        });
        await ctx.db.insert("parentThreadParticipants", {
          threadId,
          parentUserId: parentId,
        });
        const messageId = await ctx.db.insert("parentMessages", {
          threadId,
          authorType: "teacher",
          authorUserId: teacherId,
          body: "Portfolio update",
        });
        await ctx.db.insert("parentMessageAttachments", {
          messageId,
          threadId,
          storageId,
          uploaderId: teacherId,
          fileName: "Shared portfolio.pdf",
          mimeType: "application/pdf",
          sizeBytes: 9,
          source: "portfolio",
          portfolioItemId,
        });
        return {
          institutionId: school.id,
          scholarId,
          storageId,
          stationId,
          stationSessionId,
        };
      });

    const complete = await t.run((ctx) =>
      purgeUserInner(ctx, {}, scholarId, institutionId),
    );
    expect(complete).toBe(true);
    await t.run(async (ctx) => {
      const counts = {};
      while (
        (await deleteInstitutionScopedBatch(
          ctx,
          counts,
          institutionId,
          100,
        )) > 0
      ) {
        // Drain every institution-owned row.
      }
    });
    const [attachments, storage, station, stationSession] = await t.run(async (ctx) => [
      await ctx.db.query("parentMessageAttachments").collect(),
      await ctx.db.system.get("_storage", storageId),
      await ctx.db.get(stationId),
      await ctx.db.get(stationSessionId),
    ]);
    expect(attachments).toEqual([]);
    expect(storage).toBeNull();
    expect(station).toBeNull();
    expect(stationSession).toBeNull();
  });

  test("preserves a legacy portfolio owner during a partial attribution backfill", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const { institutionId, departingScholarId, legacyOwnerId, itemId, storageId } =
      await t.run(async (ctx) => {
        const departingScholarId = school.scholars[0].id;
        const legacyOwnerId = school.scholars[1].id;
        const storageId = await ctx.storage.store(
          new Blob(["shared portfolio"], { type: "application/pdf" }),
        );
        const itemId = await ctx.db.insert("portfolioItems", {
          scholarId: legacyOwnerId,
          institutionId: school.id,
          title: "Partially backfilled work",
          source: "manual",
          fileStorageId: storageId,
          fileMimeType: "application/pdf",
          matchStatus: "confirmed",
          assignmentStatus: "none",
          processingStatus: "ready",
          familyVisibility: "attributed_families",
        });
        await ctx.db.insert("portfolioAttributions", {
          portfolioItemId: itemId,
          scholarId: departingScholarId,
          attributedAt: Date.now(),
        });
        return {
          institutionId: school.id,
          departingScholarId,
          legacyOwnerId,
          itemId,
          storageId,
        };
      });

    expect(
      await t.run((ctx) =>
        purgeUserInner(ctx, {}, departingScholarId, institutionId),
      ),
    ).toBe(true);
    const [item, storage, attributions] = await t.run(async (ctx) => [
      await ctx.db.get(itemId),
      await ctx.db.system.get("_storage", storageId),
      await ctx.db
        .query("portfolioAttributions")
        .withIndex("by_item", (q) => q.eq("portfolioItemId", itemId))
        .collect(),
    ]);
    expect(item?.scholarId).toBe(legacyOwnerId);
    expect(storage).not.toBeNull();
    expect(attributions).toEqual([]);
  });

  test("drains multiple stations and portfolio items in one institution batch", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 0,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const institutionId = await t.run(async (ctx) => {
      const teacherId = school.teacher.id;
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId: school.id,
        name: "Batch group",
        scholarIds: [],
      });
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.insert("captureStations", {
          institutionId: school.id,
          scholarGroupId: groupId,
          label: `Station ${index}`,
          enrollmentTokenHash: `station-${index}`,
          enabled: true,
          createdBy: teacherId,
          createdAt: Date.now(),
        });
        await ctx.db.insert("portfolioItems", {
          institutionId: school.id,
          title: `Portfolio item ${index}`,
          source: "manual",
          matchStatus: "unmatched",
          assignmentStatus: "none",
          processingStatus: "ready",
        });
      }
      return school.id;
    });

    await t.run((ctx) =>
      deleteInstitutionScopedBatch(ctx, {}, institutionId, 100),
    );

    const [stations, items] = await t.run(async (ctx) => [
      await ctx.db
        .query("captureStations")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", institutionId),
        )
        .collect(),
      await ctx.db
        .query("portfolioItems")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", institutionId),
        )
        .collect(),
    ]);
    expect(stations).toEqual([]);
    expect(items).toEqual([]);
  });

  test("purging a user deletes their own uploads but never a blob they only named", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const world = await makeWorld(t, {
        schools: 1,
        scholarsPerSchool: 1,
        parentsPerSchool: 1,
        includePlatformAdmin: false,
      });
      const school = world.schools[0];
      const parentId = school.parents[0].id;
      const store = (body: string) =>
        t.run((ctx) =>
          ctx.storage.store(new Blob([body], { type: "application/pdf" })),
        );
      // Before upload reservations, any storage id could be staged as an
      // upload. Both of these are unindexed elsewhere, so only the age of the
      // blob relative to the row tells them apart.
      const portfolioStorageId = await store("portfolio scan");
      const itemId = await t.run((ctx) =>
        ctx.db.insert("portfolioItems", {
          scholarId: school.scholars[0].id,
          institutionId: school.id,
          title: "Field notes",
          source: "manual",
          fileStorageId: portfolioStorageId,
          matchStatus: "confirmed",
          assignmentStatus: "none",
          processingStatus: "ready",
        }),
      );
      const namedStorageId = await store("someone else's file");
      vi.advanceTimersByTime(26 * 60 * 60 * 1000);
      const ownStorageId = await store("the parent's own upload");
      await t.run(async (ctx) => {
        for (const storageId of [
          portfolioStorageId,
          namedStorageId,
          ownStorageId,
        ]) {
          await ctx.db.insert("parentMessageAttachments", {
            storageId,
            uploaderId: parentId,
            fileName: "notes.pdf",
            mimeType: "application/pdf",
            sizeBytes: 14,
            source: "upload",
          });
        }
      });

      await t.run((ctx) => purgeUserInner(ctx, {}, parentId, school.id));
      const [attachments, portfolio, named, own, item] = await t.run(
        async (ctx) => [
          await ctx.db.query("parentMessageAttachments").collect(),
          await ctx.db.system.get("_storage", portfolioStorageId),
          await ctx.db.system.get("_storage", namedStorageId),
          await ctx.db.system.get("_storage", ownStorageId),
          await ctx.db.get(itemId),
        ],
      );
      expect(attachments).toEqual([]);
      expect(portfolio).not.toBeNull();
      expect(named).not.toBeNull();
      expect(own).toBeNull();
      expect(item?.fileStorageId).toBe(portfolioStorageId);
    } finally {
      vi.useRealTimers();
    }
  });

  test("purging a user never deletes a capture's video poster their row names", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 1,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const parentId = school.parents[0].id;
    const posterStorageId = await t.run(async (ctx) => {
      const teacherId = school.teacher.id;
      const scholarId = school.scholars[0].id;
      const scholarGroupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId: school.id,
        name: "Robotics",
        scholarIds: [scholarId],
        type: "robotics",
      });
      const captureStationId = await ctx.db.insert("captureStations", {
        institutionId: school.id,
        scholarGroupId,
        label: "Robotics capture",
        enrollmentTokenHash: "station-hash",
        enabled: true,
        createdBy: teacherId,
        createdAt: Date.now(),
      });
      const sessionId = await ctx.db.insert("captureStationSessions", {
        captureStationId,
        deviceId: "shared-ipad",
        sessionTokenHash: "session-hash",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const videoStorageId = await ctx.storage.store(
        new Blob(["video"], { type: "video/mp4" }),
      );
      const posterStorageId = await ctx.storage.store(
        new Blob(["poster"], { type: "image/jpeg" }),
      );
      const portfolioItemId = await ctx.db.insert("portfolioItems", {
        scholarId,
        institutionId: school.id,
        title: "Robot run",
        source: "capture_station",
        fileStorageId: videoStorageId,
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
      });
      await ctx.db.insert("captureStationCaptures", {
        captureStationId,
        sessionId,
        portfolioItemId,
        storageId: videoStorageId,
        scholarIds: [scholarId],
        mimeType: "video/mp4",
        sizeBytes: 5,
        createdAt: Date.now(),
        videoThumbStorageId: posterStorageId,
      });
      // A pre-reservation row naming the poster, recent enough to pass the
      // legacy age proof — only the cross-table backstop can refuse it.
      await ctx.db.insert("parentMessageAttachments", {
        storageId: posterStorageId,
        uploaderId: parentId,
        fileName: "poster.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 6,
        source: "upload",
      });
      return posterStorageId;
    });

    await t.run((ctx) => purgeUserInner(ctx, {}, parentId, school.id));
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", posterStorageId)),
    ).not.toBeNull();
  });
});

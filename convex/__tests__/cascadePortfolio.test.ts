import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import {
  deleteInstitutionScopedBatch,
  purgeUserInner,
} from "../lib/cascade";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("institution cascade — shared portfolio", () => {
  test("deletes a family attachment blob after its portfolio item and thread are purged", async () => {
    const t = convexTest(schema, modules);
    const {
      institutionId,
      scholarId,
      storageId,
      stationId,
      stationSessionId,
    } = await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Closing School",
        slug: "closing-school",
        kind: "school",
      });
      const teacherId = await ctx.db.insert("users", {
        name: "Teacher",
        username: "closing-teacher",
        role: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        name: "Scholar",
        username: "closing-scholar",
        role: "scholar",
        institutionId,
      });
      const parentId = await ctx.db.insert("users", {
        name: "Parent",
        username: "closing-parent",
        role: "parent",
      });
      await ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: scholarId,
        createdBy: teacherId,
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId,
        name: "Robotics",
        scholarIds: [scholarId],
        type: "robotics",
      });
      const stationId = await ctx.db.insert("captureStations", {
        institutionId,
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
        institutionId,
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
        institutionId,
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
    const { institutionId, departingScholarId, legacyOwnerId, itemId, storageId } =
      await t.run(async (ctx) => {
        const institutionId = await ctx.db.insert("institutions", {
          name: "Backfill School",
          slug: "backfill-school",
          kind: "school",
        });
        const departingScholarId = await ctx.db.insert("users", {
          name: "Departing scholar",
          username: "departing-scholar",
          role: "scholar",
          institutionId,
        });
        const legacyOwnerId = await ctx.db.insert("users", {
          name: "Legacy owner",
          username: "legacy-owner",
          role: "scholar",
          institutionId,
        });
        const storageId = await ctx.storage.store(
          new Blob(["shared portfolio"], { type: "application/pdf" }),
        );
        const itemId = await ctx.db.insert("portfolioItems", {
          scholarId: legacyOwnerId,
          institutionId,
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
          institutionId,
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
    const institutionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("institutions", {
        name: "Batch School",
        slug: "batch-school",
        kind: "school",
      });
      const teacherId = await ctx.db.insert("users", {
        name: "Batch teacher",
        username: "batch-teacher",
        role: "teacher",
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId: id,
        name: "Batch group",
        scholarIds: [],
      });
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.insert("captureStations", {
          institutionId: id,
          scholarGroupId: groupId,
          label: `Station ${index}`,
          enrollmentTokenHash: `station-${index}`,
          enabled: true,
          createdBy: teacherId,
          createdAt: Date.now(),
        });
        await ctx.db.insert("portfolioItems", {
          institutionId: id,
          title: `Portfolio item ${index}`,
          source: "manual",
          matchStatus: "unmatched",
          assignmentStatus: "none",
          processingStatus: "ready",
        });
      }
      return id;
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
});

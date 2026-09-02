import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("portfolio thumbnails", () => {
  test("insertSegment stamps thumbStatus=pending so the UI shows a loader", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" })),
    );
    const itemId = await t.run(async (ctx) =>
      ctx.runMutation(internal.portfolio.insertSegment, {
        source: "google_drive",
        title: "scan.pdf",
        fileStorageId: storageId,
        fileMimeType: "application/pdf",
        matchStatus: "unmatched",
        assignmentStatus: "unresolved",
      }),
    );
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item?.thumbStatus).toBe("pending");
    expect(item?.thumbStorageId).toBeUndefined();
  });

  test("aiSetThumb writes status and storage id", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([9])], { type: "application/pdf" })),
    );
    const thumbId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([7])], { type: "image/jpeg" })),
    );
    const itemId = await t.run(async (ctx) =>
      ctx.runMutation(internal.portfolio.insertSegment, {
        source: "upload",
        title: "x",
        fileStorageId: storageId,
        fileMimeType: "application/pdf",
        matchStatus: "unmatched",
        assignmentStatus: "unresolved",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.portfolio.aiSetThumb, {
        itemId,
        thumbStorageId: thumbId,
        status: "ready",
      }),
    );
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item?.thumbStatus).toBe("ready");
    expect(item?.thumbStorageId).toBe(thumbId);
  });

  test("itemsMissingThumb returns filed items lacking a thumb, skips pending/done", async () => {
    const t = convexTest(schema, modules);
    const mkStorage = () =>
      t.run(async (ctx) =>
        ctx.storage.store(new Blob([new Uint8Array([1])], { type: "application/pdf" })),
      );

    // A: has file, no thumb, status pending → skip (already queued)
    const aFile = await mkStorage();
    const a = await t.run(async (ctx) =>
      ctx.db.insert("portfolioItems", {
        title: "a",
        source: "upload",
        fileStorageId: aFile,
        matchStatus: "unmatched",
        processingStatus: "ready",
        thumbStatus: "pending",
      }),
    );
    // B: has file, no thumb, no thumbStatus → INCLUDE
    const bFile = await mkStorage();
    const b = await t.run(async (ctx) =>
      ctx.db.insert("portfolioItems", {
        title: "b",
        source: "upload",
        fileStorageId: bFile,
        matchStatus: "unmatched",
        processingStatus: "ready",
      }),
    );
    // C: already has a thumb → skip
    const cFile = await mkStorage();
    const cThumb = await mkStorage();
    await t.run(async (ctx) =>
      ctx.db.insert("portfolioItems", {
        title: "c",
        source: "upload",
        fileStorageId: cFile,
        thumbStorageId: cThumb,
        matchStatus: "unmatched",
        processingStatus: "ready",
        thumbStatus: "ready",
      }),
    );

    const ids = await t.run(async (ctx) =>
      ctx.runQuery(internal.portfolio.itemsMissingThumb, { limit: 100 }),
    );
    expect(ids).toContain(b);
    expect(ids).not.toContain(a);
  });

  test("itemsMissingThumb re-drives an item stuck 'pending' past the stale window", async () => {
    // A generate action that HUNG (e.g. a mismatched PDFium wasm) is killed at
    // the action time limit before its catch can mark the item "error", so it
    // sits "pending" forever. Backfill must be able to re-drive it — but only
    // once it's clearly stuck, not while a fresh generate is still in flight.
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const file = await t.run(async (ctx) =>
        ctx.storage.store(
          new Blob([new Uint8Array([1])], { type: "application/pdf" }),
        ),
      );
      const stuck = await t.run(async (ctx) =>
        ctx.db.insert("portfolioItems", {
          title: "stuck",
          source: "google_drive",
          fileStorageId: file,
          matchStatus: "unmatched",
          processingStatus: "ready",
          thumbStatus: "pending",
        }),
      );

      // Fresh pending → skipped (don't race an in-flight generate).
      const fresh = await t.run(async (ctx) =>
        ctx.runQuery(internal.portfolio.itemsMissingThumb, { limit: 100 }),
      );
      expect(fresh).not.toContain(stuck);

      // 6 minutes later, still pending → clearly stuck, so re-drive it.
      vi.advanceTimersByTime(6 * 60 * 1000);
      const later = await t.run(async (ctx) =>
        ctx.runQuery(internal.portfolio.itemsMissingThumb, { limit: 100 }),
      );
      expect(later).toContain(stuck);
    } finally {
      vi.useRealTimers();
    }
  });

  test("deleteItem removes the thumbnail blob too", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "teach1" });
    const institutionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("institutions", {
        name: "Test school",
        slug: "test-school",
        kind: "school",
        isPrimary: true,
      });
      await ctx.db.insert("memberships", {
        userId: teacher,
        institutionId: id,
        role: "teacher",
      });
      return id;
    });
    const asTeacher = await withUser(t, teacher);

    const fileId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1])], { type: "application/pdf" })),
    );
    const thumbId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([2])], { type: "image/jpeg" })),
    );
    const itemId = await t.run(async (ctx) =>
      ctx.db.insert("portfolioItems", {
        title: "d",
        source: "upload",
        institutionId,
        fileStorageId: fileId,
        thumbStorageId: thumbId,
        matchStatus: "confirmed",
        processingStatus: "ready",
        thumbStatus: "ready",
      }),
    );

    await asTeacher.mutation(api.portfolio.deleteItem, { itemId });

    // Both blobs gone, row gone.
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item).toBeNull();
    const thumbUrl = await t.run(async (ctx) => ctx.storage.getUrl(thumbId));
    expect(thumbUrl).toBeNull();
  });
});

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

// Magic Annotations × offline-project composition: a materialized scan's
// deliverable must surface the MAGIC version (magicUrl) ALONGSIDE the original
// (fileUrl), so the showcase UI can choose. The original is never lost; the
// magic is never forced. (Assessment using the original is asserted by the
// explicit comment in deliverableAssess.ts + that it reads fileStorageId.)

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedTeacher(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Teacher", username: "teacher1", role: "teacher" }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** Build an offline project with one materialized scan deliverable. */
async function seedOfflineScan(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  withMagic: boolean,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", { teacherId, title: "U", isActive: true });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId, title: "A", kind: "offline", systemPrompt: "x", order: 0,
    });
    const fileId = await ctx.storage.store(new Blob(["original-scan"], { type: "application/pdf" }));
    const magicId = withMagic
      ? await ctx.storage.store(new Blob(["magic-redraw"], { type: "application/pdf" }))
      : undefined;
    const sessionId = await ctx.db.insert("sessions", {
      userId: teacherId, title: "Offline", isArchived: false, isOffline: true,
    });
    const itemId = await ctx.db.insert("portfolioItems", {
      title: "scan", source: "upload",
      fileStorageId: fileId,
      ...(magicId ? { magicStorageId: magicId, magicInstruction: "Draw a cat" } : {}),
      fileMimeType: "application/pdf",
      matchStatus: "confirmed", assignmentStatus: "none", processingStatus: "ready",
    });
    await ctx.db.insert("deliverables", {
      activityId, scholarId: teacherId, sessionId, portfolioItemId: itemId, submittedAt: 0,
    });
    return { sessionId };
  });
}

describe("offlineSessionView × Magic Annotations", () => {
  test("surfaces magicUrl alongside fileUrl for a materialized magic scan", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { sessionId } = await seedOfflineScan(t, teacherId, true);

    const res = await (await withUser(t, teacherId)).query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    expect(res).not.toBeNull();
    expect(res!.items).toHaveLength(1);
    const item = res!.items[0];
    expect(item.fileUrl).toBeTruthy(); // original preserved
    expect(item.magicUrl).toBeTruthy(); // magic surfaced
    expect(item.magicUrl).not.toBe(item.fileUrl); // genuinely two different blobs
  });

  test("magicUrl is null when the scan had no marker (original still shown)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { sessionId } = await seedOfflineScan(t, teacherId, false);

    const res = await (await withUser(t, teacherId)).query(api.portfolio.offlineSessionView, {
      sessionId,
    });
    const item = res!.items[0];
    expect(item.fileUrl).toBeTruthy();
    expect(item.magicUrl).toBeNull();
  });
});

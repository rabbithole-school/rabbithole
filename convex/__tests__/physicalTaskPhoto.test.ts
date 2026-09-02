import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
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

// Why this file: the "📸 Show what I found" photo-return upgrade
// (physicalTasks.attachPhoto). It pins the owner access gate, the completed-
// state flip + evidence stamp on the task row, and — the whole trick — that the
// return lands as EXACTLY ONE `role:"user"` chat message carrying the same
// storage id in `imageId` (the existing vision path), so the tutor reasons from
// the artifact next turn with zero streaming changes.

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  username: string,
  institutionId?: Id<"institutions">,
) {
  const fixtureInstitutionId = institutionId ?? (await seedTestInstitution(t));
  return role === "teacher"
    ? seedStaffWithMembership(t, {
        institutionId: fixtureInstitutionId,
        name: `Test ${username}`,
        username,
      })
    : seedScholarInInstitution(t, {
        institutionId: fixtureInstitutionId,
        name: `Test ${username}`,
        username,
      });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const s: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", s);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedSession(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", { userId, title: "Exploring", isArchived: false }),
  );
}

async function fakeStorageId(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob(["fake-image-bytes"], { type: "image/jpeg" })),
  );
}

describe("physicalTasks.attachPhoto — photo return", () => {
  test("a stranger cannot attach a photo to another scholar's task", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const mallory = await seedUser(t, "scholar", "mallory");
    const sessionId = await seedSession(t, kai);
    const taskId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Singing bowl",
      prompt: "Strike it different ways.",
    });
    const photoId = await fakeStorageId(t);

    const asMallory = await withUser(t, mallory);
    await expect(
      asMallory.mutation(api.physicalTasks.attachPhoto, {
        id: taskId,
        photoStorageId: photoId,
      }),
    ).rejects.toThrow(/forbidden/i);

    // Nothing was written on the rejected call.
    const row = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(row?.status).toBe("suggested");
    expect(row?.photoStorageId).toBeUndefined();
  });

  test("owner return: completes the task, stamps the photo, inserts exactly one user image message", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const sessionId = await seedSession(t, kai);
    const taskId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Pattern blocks",
      prompt: "Build something with a repeating pattern.",
    });
    const photoId = await fakeStorageId(t);

    const asKai = await withUser(t, kai);
    await asKai.mutation(api.physicalTasks.attachPhoto, {
      id: taskId,
      photoStorageId: photoId,
    });

    // Completed-state flip + evidence stamp on the task row.
    const row = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).toBeTypeOf("number");
    expect(row?.photoStorageId).toBe(photoId);

    // Exactly one message inserted, and it's the scholar's return turn carrying
    // the photo on the existing vision path (role:"user" + imageId).
    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].imageId).toBe(photoId);
    expect(messages[0].content.length).toBeGreaterThan(0);
    // No assistant placeholder / stream was created (zero streaming changes).
    expect(messages[0].streamId).toBeUndefined();

    // The card query surfaces the completed state + the photo id for its thumbnail.
    const card = await asKai.query(api.physicalTasks.getForCard, { id: taskId });
    expect(card?.status).toBe("completed");
    expect(card?.photoStorageId).toBe(photoId);
  });

  test("a completed photo return surfaces in the scholar portrait feed with the photo id", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const sessionId = await seedSession(t, kai);
    const taskId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Balance scale",
      prompt: "Find two things that balance.",
    });
    const photoId = await fakeStorageId(t);

    const asKai = await withUser(t, kai);
    await asKai.mutation(api.physicalTasks.attachPhoto, {
      id: taskId,
      photoStorageId: photoId,
    });

    const feed = await asKai.query(api.physicalTasks.listForScholar, {
      scholarId: kai,
    });
    expect(feed.map((x) => x.equipmentName)).toEqual(["Balance scale"]);
    expect(feed[0].photoStorageId).toBe(photoId);
  });

  test("a teacher can attach on behalf of the scholar (same gate as markDone)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const teacher = await seedUser(t, "teacher", "lehua");
    const sessionId = await seedSession(t, kai);
    const taskId = await t.mutation(internal.physicalTasks.create, {
      sessionId,
      scholarId: kai,
      equipmentName: "Magnifier",
      prompt: "Look closely at a leaf.",
    });
    const photoId = await fakeStorageId(t);

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.physicalTasks.attachPhoto, {
      id: taskId,
      photoStorageId: photoId,
    });
    const row = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(row?.status).toBe("completed");
    expect(row?.photoStorageId).toBe(photoId);
  });
});

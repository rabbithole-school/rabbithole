import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Scholar ${username}`,
      username,
      role: "scholar",
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("practice image ownership", () => {
  test("accepts the exact scholar/item image and rejects another scholar", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "owned_image");
    const otherId = await seedScholar(t, "other_image");
    const imageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["ink"], { type: "image/png" })),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.practiceWorkImages.recordOwnedImage, {
        scholarId,
        itemId: "item#1",
        storageId: imageId,
        source: "hint",
      }),
    );

    await expect(
      t.run(async (ctx) =>
        ctx.runQuery(internal.practiceWorkImages.ownedImage, {
          callerId: scholarId,
          scholarId,
          itemId: "item#1",
          storageId: imageId,
        }),
      ),
    ).resolves.toMatchObject({ owned: true, source: "hint" });
    await expect(
      t.run(async (ctx) =>
        ctx.runQuery(internal.practiceWorkImages.ownedImage, {
          callerId: otherId,
          scholarId,
          itemId: "item#1",
          storageId: imageId,
        }),
      ),
    ).rejects.toThrow("Forbidden");
  });

  test("attachAttemptWork rejects an arbitrary storage id and accepts an owned miss image", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "attempt_image");
    const scholar = await withUser(t, scholarId);
    const arbitraryId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["arbitrary"], { type: "image/png" })),
    );
    const ownedId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["owned"], { type: "image/png" })),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: "long_division",
        itemId: "long_division#1",
        correct: false,
        createdAt: Date.now(),
      });
      await ctx.runMutation(internal.practiceWorkImages.recordOwnedImage, {
        scholarId,
        itemId: "long_division#1",
        storageId: ownedId,
        source: "miss",
      });
    });

    await expect(
      scholar.mutation(api.practiceSkills.attachAttemptWork, {
        scholarId,
        itemId: "long_division#1",
        imageId: arbitraryId,
      }),
    ).rejects.toThrow("ownership");
    await expect(
      scholar.mutation(api.practiceSkills.attachAttemptWork, {
        scholarId,
        itemId: "long_division#1",
        imageId: ownedId,
      }),
    ).resolves.toEqual({ attached: true });
  });

});

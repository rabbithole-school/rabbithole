import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { verifyPadHintOutput } from "../lib/practice/padHints";
import { makeItemId } from "../lib/practice/session";

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

  test("pad hints check unit-bearing answers against the bare result", async () => {
    const t = convexTest(schema, modules);
    const context = await t.query(internal.practiceSkills.padHintContext, {
      itemId: makeItemId("volume_rectangular_prism", 12345),
    });
    const answerCanonical = context.answerCanonical;
    if (!answerCanonical) throw new Error("expected a scalar answer");
    if (context.answerType !== "integer") throw new Error("expected an integer answer");

    expect(answerCanonical).toMatch(/^\d+(?:\.\d+)?$/);
    expect(
      verifyPadHintOutput(
        { nudge: `Your work shows the volume is ${answerCanonical}.` },
        {
          stem: context.stem,
          answerCanonical,
          answerType: context.answerType,
          allowSteps: false,
        },
      )?.nudge,
    ).toBe("Your work shows the volume is the result you wrote.");
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

  test("storing a verified pad hint writes the assisted reveal marker", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "pad_marker");
    const imageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["pad"], { type: "image/png" })),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.practicePadHints.storeVerified, {
        scholarId,
        itemId: "count_to_10#7",
        imageId,
        nudge: "You made one row; inspect where your count changes.",
        model: "test-model",
      }),
    );
    const markers = await t.run(async (ctx) =>
      ctx.db.query("practiceHintReveals").collect(),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      scholarId,
      itemId: "count_to_10#7",
      maxStepServed: -1,
    });
  });

  test("serveHintStep emits verified generated steps through the existing anti-leak contract", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t, "generated_steps");
    const scholar = await withUser(t, scholarId);
    const imageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["pad"], { type: "image/png" })),
    );
    const itemId = "count_to_10#77";
    await t.run(async (ctx) =>
      ctx.runMutation(internal.practicePadHints.storeVerified, {
        scholarId,
        itemId,
        imageId,
        nudge: "You marked the next spot; inspect the number before it.",
        workedSteps: [
          {
            text: "Count the first group: 3 + 2 = 5.",
            blankText: "Count the first group: ?",
            expected: "5",
            answerType: "integer",
          },
          {
            text: "Use that count to finish the item.",
            blankText: "Finish the item: ?",
            expected: "6",
            answerType: "integer",
          },
        ],
        model: "test-model",
      }),
    );

    const served = await scholar.mutation(api.practiceSkills.serveHintStep, {
      scholarId,
      itemId,
      stepIndex: 0,
    });
    expect(served.rung).toMatchObject({
      kind: "completion",
      expected: "5",
      stepIndex: 0,
    });
    expect(JSON.stringify(served)).not.toContain("Finish the item");
    expect(JSON.stringify(served)).not.toContain('"6"');
  });
});

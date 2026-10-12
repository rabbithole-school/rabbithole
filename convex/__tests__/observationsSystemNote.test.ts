import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("observations.addSystemNote", () => {
  test("adds a neutral system note to the named scholar", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, authorId } = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        name: "Oliver Mendez",
        username: "oliver_mendez",
        role: "scholar",
      });
      const authorId = await ctx.db.insert("users", {
        name: "Rabbithole",
        username: "rabbithole-guide",
        role: "teacher",
        isSystem: true,
      });
      return { scholarId, authorId };
    });

    await t.mutation(internal.observations.addSystemNote, {
      username: "oliver_mendez",
      note: "  Production write smoke test.  ",
      type: "note",
      source: "merge-marshal",
      authorUsername: "rabbithole-guide",
    });

    const rows = await t.run((ctx) => ctx.db.query("observations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teacherId: authorId,
      scholarId,
      note: "Production write smoke test.",
      type: "note",
    });
    expect(rows[0].sessionId).toBeUndefined();
    expect(rows[0].weight).toBeUndefined();
    expect(rows[0].category).toBeUndefined();
  });

  test("throws when the scholar username is unknown", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Rabbithole",
        username: "rabbithole-guide",
        role: "teacher",
        isSystem: true,
      }),
    );

    await expect(
      t.mutation(internal.observations.addSystemNote, {
        username: "missing_scholar",
        note: "Production write smoke test.",
        type: "note",
        authorUsername: "rabbithole-guide",
      }),
    ).rejects.toThrow("Scholar user not found: missing_scholar");
  });

  test("requires an author username for the schema-backed teacherId", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Oliver Mendez",
        username: "oliver_mendez",
        role: "scholar",
      }),
    );

    await expect(
      t.mutation(internal.observations.addSystemNote, {
        username: "oliver_mendez",
        note: "Production write smoke test.",
        type: "note",
      }),
    ).rejects.toThrow(
      "authorUsername is required because observations require an author user",
    );
  });
});

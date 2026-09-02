import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { SeedStatus } from "../lib/seeds";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function constellationSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  status: SeedStatus,
  topic: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "ai-constellation",
      status,
      topic,
      suggestionType: "leap",
      rationale: "because",
      sourceLens: "interpretive",
    }),
  );
}

describe("constellation re-chart preserves visited stars (D1)", () => {
  test("deletes only unvisited pending stars; keeps active / introduced / session-linked", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "S", username: "s", role: "scholar" }),
    );

    await constellationSeed(t, scholarId, "pending", "Unvisited");
    await constellationSeed(t, scholarId, "active", "Pinned");
    const pendingVisited = await constellationSeed(
      t,
      scholarId,
      "pending",
      "PendingButVisited",
    );

    // A session the scholar flew to stamps the star's seedId — even though the
    // star is still "pending", it must survive the re-chart (DEC 3: "visited"
    // is derived from this session link, never an "introduced" status).
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "PendingButVisited",
        isArchived: false,
        seedId: pendingVisited,
      });
    });

    await t.mutation(internal.interpretiveHelpers.recordConstellation, {
      scholarId,
      stars: [
        {
          topic: "Fresh Star",
          domain: "Physics",
          rationale: "new",
          suggestionType: "leap",
          reach: 2,
        },
      ],
    });

    const topics = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("seeds")
        .withIndex("by_scholar_origin", (q) =>
          q.eq("scholarId", scholarId).eq("origin", "ai-constellation"),
        )
        .collect();
      return rows.map((s) => s.topic).sort();
    });

    // The unvisited pending star is replaced; every engaged star survives.
    expect(topics).not.toContain("Unvisited");
    expect(topics).toContain("Pinned");
    expect(topics).toContain("PendingButVisited");
    expect(topics).toContain("Fresh Star");
  });
});

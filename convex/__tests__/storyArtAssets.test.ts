import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { STORY_ART_ASSETS } from "../seed/storyArtAssets";

const FIRST_ART_KEY = Object.keys(STORY_ART_ASSETS)[0]!;
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("storyArtAssets.attach", () => {
  test("uploads once, stamps the content hash, and skips the identical ready asset", async () => {
    const t = convexTest(schema, modules);
    const nodeId = await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: FIRST_ART_KEY,
        label: "Story art placeholder",
        domain: "world",
        source: "world",
      }),
    );

    // Only FIRST_ART_KEY's node exists in this hermetic DB; every other baked
    // asset reports missing — that's the attach action telling the operator
    // which nodes haven't been seeded yet, not an error.
    const otherKeys = Object.keys(STORY_ART_ASSETS).filter(
      (k) => k !== FIRST_ART_KEY,
    );
    await expect(t.action(internal.storyArtAssets.attach, {})).resolves.toEqual({
      attached: 1,
      skipped: 0,
      missing: expect.arrayContaining(otherKeys),
    });
    const first = await t.run(async (ctx) => ctx.db.get(nodeId));
    expect(first).toMatchObject({ artStatus: "ready" });
    expect(first?.artContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.artStorageId).toBeDefined();

    await expect(t.action(internal.storyArtAssets.attach, {})).resolves.toEqual({
      attached: 0,
      skipped: 1,
      missing: expect.arrayContaining(otherKeys),
    });
    const second = await t.run(async (ctx) => ctx.db.get(nodeId));
    expect(second?.artStorageId).toBe(first?.artStorageId);
  });
});
